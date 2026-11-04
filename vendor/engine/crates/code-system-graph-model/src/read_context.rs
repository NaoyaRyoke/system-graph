// Modified from Code System Graph v1.2.1; local hardening, formatting and standalone packaging. See VENDOR.md.
//! Explicit graph-read predicates. Filtering is not an authorization mechanism.
use crate::{Edge, EdgeKind, Node, NodeId, PropertyValue, contains_unsafe_metadata_characters};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Treatment of nodes without a declared string context value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnknownContext {
    /// Do not cross undeclared context boundaries.
    #[default]
    Exclude,
    /// Explicitly admit undeclared context, never override a known mismatch.
    Include,
    /// Select only undeclared context.
    Only,
}

/// Exact, case-sensitive scalar context selector.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ContextSelector {
    /// Allowlisted values; an empty list means any declared value.
    #[serde(default)]
    pub include: Vec<String>,
    /// Denied values; denial wins over inclusion.
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Explicit handling of missing/null values.
    #[serde(default)]
    pub unknown: UnknownContext,
}
impl ContextSelector {
    /// Tests a declared value without deriving context from names or repository proximity.
    #[must_use]
    pub fn matches(&self, value: Option<&str>) -> bool {
        match value {
            None => self.unknown != UnknownContext::Exclude,
            Some(_) if self.unknown == UnknownContext::Only => false,
            Some(value) => {
                !self.exclude.iter().any(|v| v == value)
                    && (self.include.is_empty() || self.include.iter().any(|v| v == value))
            }
        }
    }
}

/// Actual data-access classification, distinct from scope/authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    /// Reads only.
    Read,
    /// Writes only.
    Write,
    /// Reads and writes.
    ReadWrite,
    /// No sufficiently explicit access fact.
    Unknown,
}
/// Classifies a relationship. An explicit unknown overrides a native kind inference.
#[must_use]
pub fn edge_access(edge: &Edge) -> AccessMode {
    if let Some(assertion) = edge.properties.get("access_mode") {
        return match &assertion.value {
            PropertyValue::String(v) if ["read", "read-only"].contains(&v.as_str()) => {
                AccessMode::Read
            }
            PropertyValue::String(v) if ["write", "write-only"].contains(&v.as_str()) => {
                AccessMode::Write
            }
            PropertyValue::String(v) if ["read-write", "read_write"].contains(&v.as_str()) => {
                AccessMode::ReadWrite
            }
            _ => AccessMode::Unknown,
        };
    }
    if edge
        .properties
        .get("allow_write")
        .is_some_and(|a| a.value == PropertyValue::Boolean(false))
        && edge.kind == EdgeKind::WritesTable
    {
        return AccessMode::Unknown;
    }
    match edge.kind {
        EdgeKind::ReadsTable => AccessMode::Read,
        EdgeKind::WritesTable => AccessMode::Write,
        _ => AccessMode::Unknown,
    }
}

/// One grouped dependency, with explicit metadata taking precedence over extraction.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DataDependency {
    /// Consumer/source entity.
    pub source: NodeId,
    /// Resource/target entity.
    pub target: NodeId,
    /// Grouped classification, not a boolean guess.
    pub access_mode: AccessMode,
    /// True only when a mode was explicitly declared/manual.
    pub explicit_override: bool,
    /// Supporting relationships, including contrary lower-priority observations.
    pub edges: Vec<crate::EdgeId>,
    /// Supporting edge preview was capped at 64; never claim complete evidence in that case.
    pub edges_truncated: bool,
}
/// Groups existing data facts. Unknown is not treated as a proven read-only dependency.
#[must_use]
pub fn data_dependencies(edges: &[Edge], include_migrations: bool) -> Vec<DataDependency> {
    let mut groups = BTreeMap::<(NodeId, NodeId), Vec<&Edge>>::new();
    for edge in edges {
        if !include_migrations
            && edge
                .properties
                .get("data_phase")
                .is_some_and(|p| p.value == PropertyValue::String("migration".into()))
        {
            continue;
        }
        if matches!(
            edge.kind,
            EdgeKind::ReadsTable
                | EdgeKind::WritesTable
                | EdgeKind::Consumes
                | EdgeKind::CallsRemote
        ) {
            groups
                .entry((edge.source.clone(), edge.target.clone()))
                .or_default()
                .push(edge);
        }
    }
    groups
        .into_iter()
        .map(|((source, target), group)| {
            let explicit = group
                .iter()
                .copied()
                .filter(|e| {
                    e.properties.get("access_mode").is_some_and(|p| {
                        matches!(
                            p.provenance,
                            crate::Provenance::Manual | crate::Provenance::Declared
                        )
                    })
                })
                .collect::<Vec<_>>();
            let selected = if explicit.is_empty() {
                &group
            } else {
                &explicit
            };
            let mut read = false;
            let mut write = false;
            let mut unknown = false;
            for edge in selected {
                match edge_access(edge) {
                    AccessMode::Read => read = true,
                    AccessMode::Write => write = true,
                    AccessMode::ReadWrite => {
                        read = true;
                        write = true;
                    }
                    AccessMode::Unknown => unknown = true,
                }
            }
            let access_mode = if unknown {
                AccessMode::Unknown
            } else if read && write {
                AccessMode::ReadWrite
            } else if write {
                AccessMode::Write
            } else if read {
                AccessMode::Read
            } else {
                AccessMode::Unknown
            };
            DataDependency {
                source,
                target,
                access_mode,
                explicit_override: !explicit.is_empty(),
                edges: group.iter().take(64).map(|e| e.id.clone()).collect(),
                edges_truncated: group.len() > 64,
            }
        })
        .collect()
}

/// Additive common read scope; absent/default preserves legacy behavior.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GraphReadContext {
    /// Environment boundary.
    #[serde(default)]
    pub environment: Option<ContextSelector>,
    /// Exact future/runtime context dimensions, e.g. `runtime_host`, cluster, tenant.
    #[serde(default)]
    pub dimensions: BTreeMap<String, ContextSelector>,
    /// Only these relationship access modes are traversable; empty means no access filter.
    #[serde(default)]
    pub access_modes: Vec<AccessMode>,
    /// Restrict data operation phase, e.g. runtime or migration.
    #[serde(default)]
    pub data_phase: Option<ContextSelector>,
}
impl GraphReadContext {
    /// Whether any predicate is requested.
    #[must_use]
    pub fn is_active(&self) -> bool {
        self.environment.is_some()
            || !self.dimensions.is_empty()
            || !self.access_modes.is_empty()
            || self.data_phase.is_some()
    }
    /// Checks bounded scope syntax without silently ignoring invalid values.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        let safe = |s: &str| {
            !s.trim().is_empty() && s.len() <= 128 && !contains_unsafe_metadata_characters(s)
        };
        self.access_modes.len() <= 4
            && self.dimensions.len() <= 8
            && self.dimensions.keys().all(|s| safe(s))
            && self
                .environment
                .iter()
                .chain(self.dimensions.values())
                .chain(self.data_phase.iter())
                .all(|p| {
                    p.include.len() <= 16
                        && p.exclude.len() <= 16
                        && p.include.iter().chain(&p.exclude).all(|s| safe(s))
                })
    }
    /// Selects nodes and edges before any graph traversal or aggregation.
    #[must_use]
    pub fn select(
        &self,
        nodes: &[Node],
        edges: &[Edge],
    ) -> (BTreeSet<NodeId>, BTreeSet<crate::EdgeId>) {
        if !self.is_valid() {
            return (BTreeSet::new(), BTreeSet::new());
        }
        let selectors = self
            .environment
            .iter()
            .map(|p| ("environment", p))
            .chain(self.dimensions.iter().map(|(k, v)| (k.as_str(), v)))
            .collect::<Vec<_>>();
        let value = |properties: &crate::Properties, key: &str| {
            properties.get(key).and_then(|p| match &p.value {
                PropertyValue::String(v) => Some(v.clone()),
                _ => None,
            })
        };
        let eligible = nodes
            .iter()
            .filter(|n| {
                selectors
                    .iter()
                    .all(|(key, p)| p.matches(value(&n.properties, key).as_deref()))
            })
            .map(|n| n.id.clone())
            .collect::<BTreeSet<_>>();
        let links = edges.iter().filter(|e| {
            eligible.contains(&e.source) && eligible.contains(&e.target)
                // An undeclared edge can connect eligible endpoints; a conflicting declared edge cannot.
                && selectors.iter().all(|(key,p)| match value(&e.properties,key) { Some(v) => p.matches(Some(&v)), None => true })
                && (self.access_modes.is_empty() || self.access_modes.contains(&edge_access(e)))
                && self.data_phase.as_ref().is_none_or(|p| p.matches(value(&e.properties,"data_phase").as_deref()))
        }).map(|e| e.id.clone()).collect();
        (eligible, links)
    }
}

/// MCP wire extension that leaves existing public input structs unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScopedRequest<T> {
    /// Existing request fields, unchanged.
    #[serde(flatten)]
    pub request: T,
    /// Optional native graph read scope.
    #[serde(default)]
    pub context: GraphReadContext,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_known_mismatch_remain_distinct() {
        let selector = ContextSelector {
            include: vec!["production".into()],
            exclude: vec!["poc".into()],
            unknown: UnknownContext::Include,
        };
        assert!(selector.matches(None));
        assert!(selector.matches(Some("production")));
        assert!(!selector.matches(Some("development")));
        assert!(!selector.matches(Some("poc")));
        assert!(
            !GraphReadContext {
                environment: Some(ContextSelector {
                    include: vec!["\n".into()],
                    ..Default::default()
                }),
                ..Default::default()
            }
            .is_valid()
        );
    }
}

#[cfg(test)]
mod hardening_context_tests {
    use super::*;
    use crate::{EdgeId, EpistemicStatus, NodeKind, Properties, PropertyAssertion, Provenance};
    fn property(value: PropertyValue) -> PropertyAssertion {
        PropertyAssertion {
            value,
            source_file: "catalog.json".into(),
            source_pointer: "/environment".into(),
            extractor: "fixture/v1".into(),
            provenance: Provenance::Declared,
        }
    }
    fn node(id: &str, environment: Option<&str>) -> Node {
        let mut node = Node::new(
            NodeId::new(id),
            NodeKind::Service,
            None,
            id.into(),
            "same".into(),
        );
        if let Some(env) = environment {
            node.properties.insert(
                "environment".into(),
                property(PropertyValue::String(env.into())),
            );
        }
        node
    }
    fn edge(id: &str, from: &str, to: &str, kind: EdgeKind) -> Edge {
        Edge::new(
            EdgeId::new(id),
            NodeId::new(from),
            NodeId::new(to),
            kind,
            1.0,
            EpistemicStatus::Confirmed,
            vec![],
        )
    }
    #[test]
    fn context_selection_closes_staging_poc_unknown_bridge_before_traversal() {
        let nodes = vec![
            node("a", Some("production")),
            node("b", Some("production")),
            node("s", Some("staging")),
            node("p", Some("poc")),
            node("d", Some("development")),
            node("u", None),
        ];
        let edges = vec![
            edge("as", "a", "s", EdgeKind::Consumes),
            edge("sb", "s", "b", EdgeKind::Consumes),
            edge("au", "a", "u", EdgeKind::Consumes),
            edge("ub", "u", "b", EdgeKind::Consumes),
        ];
        let scope = GraphReadContext {
            environment: Some(ContextSelector {
                include: vec!["production".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let (eligible, links) = scope.select(&nodes, &edges);
        assert_eq!(eligible.len(), 2);
        assert!(links.is_empty());
        let mut admit_unknown = scope.clone();
        admit_unknown
            .environment
            .as_mut()
            .expect("selector")
            .unknown = UnknownContext::Include;
        let (_, links) = admit_unknown.select(&nodes, &edges);
        assert_eq!(links.len(), 2);
        assert!(!links.contains(&EdgeId::new("as")));
        let mut multi = scope;
        multi
            .environment
            .as_mut()
            .expect("selector")
            .include
            .push("staging".into());
        assert_eq!(multi.select(&nodes, &edges).1.len(), 2);
        for env in ["staging", "development"] {
            let scope = GraphReadContext {
                environment: Some(ContextSelector {
                    include: vec![env.into()],
                    ..Default::default()
                }),
                ..Default::default()
            };
            assert_eq!(scope.select(&nodes, &edges).0.len(), 1);
        }
        let unknown = GraphReadContext {
            environment: Some(ContextSelector {
                unknown: UnknownContext::Only,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            unknown.select(&nodes, &edges).0,
            BTreeSet::from([NodeId::new("u")])
        );
        let no_poc = GraphReadContext {
            environment: Some(ContextSelector {
                exclude: vec!["poc".into()],
                unknown: UnknownContext::Include,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(no_poc.select(&nodes, &edges).0.len(), 5);
        assert_eq!(
            GraphReadContext::default().select(&nodes, &edges).0.len(),
            nodes.len()
        );
    }
    #[test]
    fn reader_writer_unknown_and_manual_override_are_distinct() {
        let mut edges = vec![
            edge("r", "client", "table", EdgeKind::ReadsTable),
            edge("w", "client", "table", EdgeKind::WritesTable),
        ];
        assert_eq!(
            data_dependencies(&edges, false)[0].access_mode,
            AccessMode::ReadWrite
        );
        let mut declared = edge("declaration", "client", "table", EdgeKind::Consumes);
        declared.properties.insert(
            "access_mode".into(),
            property(PropertyValue::String("read-only".into())),
        );
        declared.properties.insert(
            "allow_write".into(),
            property(PropertyValue::Boolean(false)),
        );
        edges.push(declared);
        let facts = data_dependencies(&edges, false);
        assert_eq!(facts[0].access_mode, AccessMode::Read);
        assert!(facts[0].explicit_override);
        edges[2]
            .properties
            .get_mut("access_mode")
            .expect("mode")
            .value = PropertyValue::Unknown(());
        assert_eq!(
            data_dependencies(&edges, false)[0].access_mode,
            AccessMode::Unknown
        );
        let mut unknown = edge("unknown", "other", "table", EdgeKind::Consumes);
        unknown.properties.insert(
            "allow_write".into(),
            property(PropertyValue::Boolean(false)),
        );
        assert_eq!(edge_access(&unknown), AccessMode::Unknown);
        let mut migration = edge("migration", "migration", "table", EdgeKind::WritesTable);
        migration.properties.insert(
            "data_phase".into(),
            property(PropertyValue::String("migration".into())),
        );
        assert!(data_dependencies(&[migration.clone()], false).is_empty());
        assert_eq!(
            data_dependencies(&[migration], true)[0].access_mode,
            AccessMode::Write
        );
        let _: Properties = Properties::new();
    }
}
