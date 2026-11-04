//! Private transport host. Graph selection/ranking remain in the frozen Rust engine.
use code_system_graph_core::{
    FederatedGraph, ImpactContext, ImpactDirection, ImpactOptions, ImpactRequest, ImpactTarget,
    SearchFilters, SearchRequest, analyze_impact, search,
};
use code_system_graph_model::{
    ContextSelector, Edge, GraphReadContext, Node, NodeId, RepoId, UnknownContext,
};
use code_system_graph_store_sqlite::{SqliteStore, schema_identity};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::Path;

const API: &str = "1.0";
const MAX_FRAME: usize = 65_536;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    api_version: String,
    id: String,
    operation: String,
    #[serde(default)]
    params: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[derive(Clone)]
struct Scope {
    environments: Vec<String>,
    repositories: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    query: String,
    limit: usize,
    scope: Scope,
}
fn error(id: &str, code: &str) -> Value {
    json!({"api_version":API,"id":id,"ok":false,"error":{"code":code,"retryable":false}})
}
fn execute(database: &Path, workspace: &str, r: Request) -> Value {
    if r.api_version != API {
        return error(&r.id, "incompatible_api");
    }
    let result = match r.operation.as_str() {
        "health" => Ok(json!({"status":"alive","readiness":"query_checks_database"})),
        "capabilities" => Ok(
            json!({"api_version":API,"engine_contract":"1.2.2-hardening.1","graph_schema":schema_identity(),"operations":["health","capabilities","query","impact","trace","explain","inventory"],"query_semantics":"native-ranked-lexical.v1","environment_pre_filter":true,"explicit_false":true,"management":false,"query_limit":50,"depth_limit":12,"max_request_bytes":MAX_FRAME,"features":{"provenance":true,"native_impact":true,"native_trace":true,"terraform_extraction":code_system_graph_core::TERRAFORM_ENABLED},"unsupported":["scan","rescan","register","delete","migration","configuration"]}),
        ),
        "query" => query(database, workspace, r.params),
        "impact" | "trace" | "explain" | "inventory" => {
            read_operation(database, workspace, &r.operation, r.params)
        }
        _ => Err("unsupported_capability"),
    };
    match result {
        Ok(result) => json!({"api_version":API,"id":r.id,"ok":true,"result":result}),
        Err(code) => error(&r.id, code),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadParams {
    scope: Scope,
    target: Option<String>,
    source: Option<String>,
    destination: Option<String>,
    kind: Option<String>,
    direction: Option<ImpactDirection>,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default = "default_depth")]
    max_depth: usize,
    #[serde(default)]
    offset: usize,
}
fn default_limit() -> usize {
    20
}
fn default_depth() -> usize {
    8
}
fn scoped_graph(
    database: &Path,
    workspace: &str,
    scope: &Scope,
) -> Result<(Vec<Node>, Vec<Edge>), &'static str> {
    if scope.environments.is_empty()
        || scope.environments.len() > 16
        || scope.repositories.is_empty()
        || scope.repositories.len() > 16
    {
        return Err("invalid_request");
    }
    let context = GraphReadContext {
        environment: Some(ContextSelector {
            include: scope.environments.clone(),
            exclude: vec![],
            unknown: UnknownContext::Exclude,
        }),
        ..Default::default()
    };
    if !context.is_valid() {
        return Err("invalid_request");
    }
    if !database.is_file() {
        return Err("graph_unavailable");
    }
    let store = SqliteStore::open_read_only(database).map_err(|_| "graph_unavailable")?;
    let summary = store
        .current_snapshot_summary(workspace)
        .map_err(|_| "graph_unavailable")?;
    if summary.node_count > 12_000 || summary.edge_count > 60_000 {
        return Err("resource_limit");
    }
    let (nodes, edges) = store
        .load_current_graph(workspace)
        .map_err(|_| "graph_unavailable")?;
    if nodes.len() > 12_000 || edges.len() > 60_000 {
        return Err("resource_limit");
    }
    let (eligible, links) = context.select(&nodes, &edges);
    let nodes = nodes
        .into_iter()
        .filter(|n| {
            eligible.contains(&n.id)
                && n.repo_id
                    .as_ref()
                    .is_some_and(|r| scope.repositories.contains(&r.0))
        })
        .collect::<Vec<_>>();
    let ids = nodes
        .iter()
        .map(|n| n.id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let edges = edges
        .into_iter()
        .filter(|e| links.contains(&e.id) && ids.contains(&e.source) && ids.contains(&e.target))
        .collect();
    Ok((nodes, edges))
}
fn read_operation(
    database: &Path,
    workspace: &str,
    operation: &str,
    params: Value,
) -> Result<Value, &'static str> {
    let q: ReadParams = serde_json::from_value(params).map_err(|_| "invalid_request")?;
    if !(1..=50).contains(&q.limit) || !(1..=12).contains(&q.max_depth) || q.offset > 10000 {
        return Err("invalid_request");
    }
    let (nodes, edges) = scoped_graph(database, workspace, &q.scope)?;
    let selected = |id: &str| nodes.iter().any(|n| n.id.as_str() == id);
    match operation {
        "inventory" => {
            let total = nodes.len();
            let page = nodes
                .iter()
                .skip(q.offset)
                .take(q.limit)
                .collect::<Vec<_>>();
            let truncated = q.offset + page.len() < total;
            Ok(
                json!({"nodes":page,"edges":edges.iter().take(100).collect::<Vec<_>>(),"total_nodes":total,"total_edges":edges.len(),"truncated":truncated||edges.len()>100,"reason":if truncated||edges.len()>100{Some("result_limit")}else{None},"next_offset":if truncated{Some(q.offset+page.len())}else{None}}),
            )
        }
        "trace" => {
            let source = q.source.ok_or("invalid_request")?;
            let destination = q.destination.ok_or("invalid_request")?;
            if !selected(&source) || !selected(&destination) {
                return Err("not_found");
            }
            let graph = FederatedGraph::new(nodes, edges).map_err(|_| "graph_unavailable")?;
            serde_json::to_value(
                graph
                    .trace(&NodeId::new(source), &NodeId::new(destination), q.max_depth)
                    .map_err(|_| "not_found")?,
            )
            .map_err(|_| "engine_failure")
        }
        "impact" => {
            let target = q.target.ok_or("invalid_request")?;
            if !selected(&target) {
                return Err("not_found");
            }
            let request = ImpactRequest {
                target: ImpactTarget::NodeId {
                    node_id: NodeId::new(target),
                },
                direction: q.direction.unwrap_or(ImpactDirection::Upstream),
                options: ImpactOptions {
                    max_depth: q.max_depth,
                    node_limit: 500,
                    edge_limit: 1000,
                    limit: q.limit,
                    offset: q.offset,
                    ..Default::default()
                },
            };
            let context = ImpactContext {
                nodes,
                edges,
                communities: None,
                freshness: vec![],
                compatibility: vec![],
                local_enrichment: vec![],
                public_contracts: vec![],
                criticality: vec![],
                centrality: BTreeMap::new(),
                service_memberships: BTreeMap::new(),
                environments: vec![],
                recommended_commands: vec![],
                graph_complete: false,
                coverage_gaps: vec![
                    "fixture/API does not enrich freshness or complete runtime evidence".into(),
                ],
            };
            serde_json::to_value(analyze_impact(&request, &context).map_err(|_| "invalid_request")?)
                .map_err(|_| "engine_failure")
        }
        "explain" => {
            let target = q.target.ok_or("invalid_request")?;
            let kind = q.kind.ok_or("invalid_request")?;
            let (properties, evidence) = if kind == "node" || kind == "result" {
                let n = nodes
                    .iter()
                    .find(|n| n.id.as_str() == target)
                    .ok_or("not_found")?;
                (
                    serde_json::to_value(&n.properties).map_err(|_| "engine_failure")?,
                    vec![],
                )
            } else if kind == "edge" {
                let e = edges
                    .iter()
                    .find(|e| e.id.as_str() == target)
                    .ok_or("not_found")?;
                let store =
                    SqliteStore::open_read_only(database).map_err(|_| "graph_unavailable")?;
                let evidence = store
                    .load_current_evidence(workspace)
                    .map_err(|_| "graph_unavailable")?
                    .into_iter()
                    .filter(|v| {
                        e.evidence.contains(&v.id)
                            && v.repo_id
                                .as_ref()
                                .is_some_and(|r| q.scope.repositories.contains(&r.0))
                    })
                    .collect::<Vec<_>>();
                (
                    serde_json::to_value(&e.properties).map_err(|_| "engine_failure")?,
                    evidence,
                )
            } else {
                return Err("invalid_request");
            };
            let count = properties.as_object().map_or(0, |p| p.len());
            let properties = properties
                .as_object()
                .map(|p| {
                    p.iter()
                        .take(16)
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect::<serde_json::Map<String, Value>>()
                })
                .unwrap_or_default();
            Ok(
                json!({"target":target,"kind":kind,"properties":properties,"evidence":evidence.iter().take(16).collect::<Vec<_>>(),"truncated":count>16||evidence.len()>16,"reason":if count>16||evidence.len()>16{Some("provenance_limit")}else{None}}),
            )
        }
        _ => Err("unsupported_capability"),
    }
}
fn query(database: &Path, workspace: &str, params: Value) -> Result<Value, &'static str> {
    let q: Query = serde_json::from_value(params).map_err(|_| "invalid_request")?;
    if q.query.trim().is_empty()
        || q.query.len() > 256
        || !(1..=50).contains(&q.limit)
        || q.scope.environments.is_empty()
        || q.scope.environments.len() > 16
        || q.scope.repositories.is_empty()
        || q.scope.repositories.len() > 16
    {
        return Err("invalid_request");
    }
    let (nodes, _) = scoped_graph(database, workspace, &q.scope)?;
    let request = SearchRequest {
        query: q.query,
        filters: SearchFilters {
            repo_ids: q.scope.repositories.into_iter().map(RepoId::new).collect(),
            ..Default::default()
        },
        fts_scores: BTreeMap::new(),
        centrality_scores: BTreeMap::new(),
        service_memberships: BTreeMap::new(),
        community_memberships: BTreeMap::new(),
        evidence: BTreeMap::new(),
        freshness: BTreeMap::new(),
        offset: 0,
        limit: q.limit,
    };
    let report = search(&nodes, &request).map_err(|_| "invalid_request")?;
    serde_json::to_value(report).map_err(|_| "engine_failure")
}
fn main() -> io::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        eprintln!("engine host requires server-selected database and workspace");
        std::process::exit(2);
    }
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    loop {
        // Bound memory before a delimiter is found; never buffer an unbounded JSON line.
        let mut bytes = Vec::new();
        let mut overflow = false;
        loop {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                break;
            }
            let end = chunk.iter().position(|b| *b == b'\n');
            let take = end.map_or(chunk.len(), |p| p + 1);
            if bytes.len() + take > MAX_FRAME {
                overflow = true;
            } else if !overflow {
                bytes.extend_from_slice(&chunk[..take]);
            }
            input.consume(take);
            if end.is_some() {
                break;
            }
        }
        if bytes.is_empty() && !overflow {
            break;
        }
        if overflow {
            writeln!(output, "{}", error("invalid", "request_too_large"))?;
            output.flush()?;
            break;
        }
        let reply = match serde_json::from_slice::<Request>(&bytes) {
            Ok(r) if !r.id.is_empty() && r.id.len() <= 64 => {
                execute(Path::new(&args[0]), &args[1], r)
            }
            _ => error("invalid", "invalid_request"),
        };
        writeln!(output, "{reply}")?;
        output.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(operation: &str) -> Request {
        Request {
            api_version: API.into(),
            id: "test".into(),
            operation: operation.into(),
            params: json!({}),
        }
    }
    #[test]
    fn health_and_capabilities_do_not_claim_database_ready() {
        let path = Path::new("missing-fixture.db");
        assert_eq!(
            execute(path, "fixture", request("health"))["result"]["status"],
            "alive"
        );
        assert_eq!(
            execute(path, "fixture", request("capabilities"))["result"]["management"],
            false
        );
    }
    #[test]
    fn incompatible_version_and_unimplemented_operation_are_typed() {
        let path = Path::new("missing-fixture.db");
        let mut r = request("health");
        r.api_version = "2.0".into();
        assert_eq!(
            execute(path, "fixture", r)["error"]["code"],
            "incompatible_api"
        );
        assert_eq!(
            execute(path, "fixture", request("scan"))["error"]["code"],
            "unsupported_capability"
        );
    }
    #[test]
    fn missing_graph_and_empty_scope_fail_closed() {
        let p = Path::new("missing-fixture.db");
        assert_eq!(
            query(
                p,
                "fixture",
                json!({"query":"reader","limit":10,"scope":{"environments":[],"repositories":[]}})
            ),
            Err("invalid_request")
        );
        assert_eq!(
            query(
                p,
                "fixture",
                json!({"query":"reader","limit":10,"scope":{"environments":["production"],"repositories":["repo:fixture"]}})
            ),
            Err("graph_unavailable")
        );
    }
    #[test]
    fn public_host_explicitly_reports_hcl_disabled_and_refuses_scan() {
        let path = Path::new("missing-fixture.db");
        let caps = execute(path, "fixture", request("capabilities"));
        assert_eq!(caps["result"]["features"]["terraform_extraction"], false);
        assert_eq!(
            execute(path, "fixture", request("scan"))["error"]["code"],
            "unsupported_capability"
        );
    }
    #[test]
    fn unknown_input_fields_are_rejected() {
        assert!(serde_json::from_value::<Request>(json!({"api_version":"1.0","id":"x","operation":"query","params":{},"token":"fixture"})).is_err());
        assert!(serde_json::from_value::<Query>(json!({"query":"reader","limit":1,"scope":{"environments":["production"],"repositories":["r"]},"path":"../outside"})).is_err());
    }
}
