//! Operator-only synthetic graph generator. Never exposed through MCP.
use code_system_graph_model::{Edge, Node, WorkspaceRecord};
use code_system_graph_store_sqlite::{SnapshotBatch, SqliteStore, schema_identity};
use serde_json::{Value, json};
use std::{error::Error, fs, path::Path};
fn property(value: Value) -> Value {
    json!({"value":value,"source_file":"synthetic/catalog.json","source_pointer":"/metadata","extractor":"synthetic.fixture/v1","provenance":"declared"})
}
fn run() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err(
            "usage: sample_graph OUTPUT_DIR TENANT NODES EDGES (0 nodes = compatibility fixture)"
                .into(),
        );
    }
    let directory = Path::new(&args[0]);
    fs::create_dir_all(directory)?;
    let tenant = &args[1];
    if !["alpha", "beta", "sample", "scale"].contains(&tenant.as_str()) {
        return Err("invalid fixture tenant".into());
    }
    let count: usize = args[2].parse()?;
    let edge_count: usize = args[3].parse()?;
    if count > 100_000 || edge_count > 500_000 {
        return Err("fixture bound".into());
    }
    let compatibility = count == 0;
    let names = if compatibility {
        vec!["reader", "api"]
    } else {
        vec![
            "sample-web",
            "sample-api",
            "sample-db",
            "sample-auth",
            "sample-worker",
            "sample-events",
        ]
    };
    let environments = if compatibility {
        vec!["production", "development"]
    } else {
        vec!["production", "staging", "dev"]
    };
    let n = if compatibility {
        4
    } else if count == 18 {
        18
    } else {
        count
    };
    if n < 2 {
        return Err("fixture needs two nodes".into());
    }
    let aliases = if compatibility {
        vec!["frontend", "api"]
    } else {
        names.clone()
    };
    let repositories = aliases.iter().map(|alias|json!({"id":format!("repo:{tenant}:{alias}"),"checkout_id":format!("checkout:{tenant}:{alias}"),"alias":alias,"canonical_path":{"encoding":"utf8","bytes":[],"display":format!("synthetic/{alias}")},"git_common_dir":null,"normalized_remote":null,"head_commit":null,"is_linked_worktree":false,"working_tree_dirty":false})).collect::<Vec<_>>();
    let workspace: WorkspaceRecord = serde_json::from_value(
        json!({"id":format!("workspace:{tenant}"),"name":"sample","manifest_hash":"synthetic-v1","config_path":null,"repositories":repositories}),
    )?;
    let mut nodes = Vec::<Node>::with_capacity(n);
    for i in 0..n {
        let index = i % names.len();
        let env = if n <= 18 {
            environments[(i / names.len()) % environments.len()]
        } else {
            "production"
        };
        let writer = index == 4;
        nodes.push(serde_json::from_value(json!({"id":format!("node:{tenant}:{i}"),"kind":if !compatibility && index==2 {"database_table"} else if !compatibility&&index==5 {"event_channel"} else {"service"},"repo_id":format!("repo:{tenant}:{}",aliases[index]),"stable_key":format!("synthetic:{tenant}:{env}:{}:{i}",names[index]),"label":names[index],"properties":{"environment":property(json!(env)),"allow_write":property(json!(writer)),"access_mode":property(json!(if writer {"write"} else {"read"})),"public_internet":property(json!(false)),"funnel":property(json!(false)),"runtime":property(json!("container")),"deployment":property(json!("synthetic"))}}))?);
    }
    let mut edges = Vec::<Edge>::new();
    let total = if compatibility { 2 } else { edge_count };
    for i in 0..total {
        let demo_links = [
            (0, 1, "consumes"),
            (1, 2, "reads_table"),
            (0, 3, "calls_remote"),
            (4, 2, "writes_table"),
            (4, 5, "publishes"),
            (1, 5, "subscribes"),
        ];
        let source = if compatibility {
            i * 2
        } else if n == 18 {
            (i / 6) * 6 + demo_links[i % 6].0
        } else {
            i % n
        };
        let target = if compatibility {
            source + 1
        } else if n == 18 {
            (i / 6) * 6 + demo_links[i % 6].1
        } else {
            (source + 1 + i / n) % n
        };
        if source == target {
            continue;
        }
        // Six-component demo stays inside each environment; scale includes cycles.
        if n == 18 && source / 6 != target / 6 {
            continue;
        }
        let kind = if compatibility {
            "consumes"
        } else if n == 18 {
            demo_links[i % 6].2
        } else {
            match source % 6 {
                1 => "reads_table",
                4 => "writes_table",
                3 => "calls_remote",
                _ => "consumes",
            }
        };
        let env = nodes[source].properties["environment"].value.clone();
        edges.push(serde_json::from_value(json!({"id":format!("edge:{tenant}:{i}"),"source":nodes[source].id,"target":nodes[target].id,"kind":kind,"confidence":1.0,"status":"confirmed","evidence":[],"properties":{"environment":property(serde_json::to_value(env)?),"access_mode":property(json!(if source%6==4&&!compatibility {"write"} else {"read"})),"allow_write":property(json!(source%6==4&&!compatibility)),"protocol":property(json!(if kind.contains("table") {"SQL"} else {"HTTP"})),"direct":property(json!(true))}}))?);
    }
    let db = directory.join(format!("{tenant}.db"));
    if db.exists() {
        return Err("refusing to overwrite generated database".into());
    }
    let mut store = SqliteStore::open(&db)?;
    store.publish_snapshot(SnapshotBatch {
        workspace: &workspace,
        snapshot_id: "snapshot:synthetic-v1",
        nodes: &nodes,
        edges: &edges,
        evidence: &[],
        fingerprints: &[],
        extractor_batches: &[],
        extractor_runs: &[],
        manual_links: &[],
        community_snapshot: None,
    })?;
    if !store.integrity_check()? {
        return Err("integrity failure".into());
    }
    // Backup API produces a closed, standalone DB for read-only container mounts.
    let backup = directory.join(format!("{tenant}-readonly.db"));
    store.backup_to(&backup)?;
    let registry = json!({"tenant":if tenant=="alpha" {"tenant-a"} else if tenant=="beta" {"tenant-b"} else {"tenant-sample"},"workspace":"main","engineWorkspace":"sample","database":backup,"repositories":aliases.iter().map(|a|((*a).to_owned(),format!("repo:{tenant}:{a}"))).collect::<std::collections::BTreeMap<_,_>>(),"repoRoots":[],"allowedEnvironments":environments,"status":"active"});
    fs::write(
        directory.join(format!("{tenant}-registry.json")),
        serde_json::to_vec_pretty(&registry)?,
    )?;
    fs::write(
        directory.join(format!("{tenant}-ids.json")),
        serde_json::to_vec_pretty(
            &json!({"reader":nodes[0].id,"api":nodes[1].id,"database":nodes[2.min(n-1)].id}),
        )?,
    )?;
    fs::write(
        directory.join(format!("{tenant}-export.json")),
        serde_json::to_vec_pretty(
            &json!({"nodes":nodes,"edges":edges.iter().map(|e|json!({"edge":e})).collect::<Vec<_>>()}),
        )?,
    )?;
    fs::write(
        directory.join("engine-release.json"),
        serde_json::to_vec_pretty(&json!({"graph_schema":schema_identity()}))?,
    )?;
    println!(
        "{}",
        json!({"synthetic":true,"nodes":nodes.len(),"edges":edges.len(),"integrity":"ok"})
    );
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("FAIL: synthetic generation rejected");
        std::process::exit(1);
    }
}
