// Modified from Code System Graph v1.2.1; local hardening, formatting and standalone packaging. See VENDOR.md.
//! Optional, source-pinned handoff anchors. Existence is extracted; relationships remain manual.
use crate::SourceSymbolIdentity;
use code_system_graph_model::{
    Evidence, EvidenceId, Node, Properties, Provenance, RepoId, stable_id, valid_properties,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Explicit source anchor used when automatic cross-layer correlation is incomplete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceAnchor {
    /// Registered repository alias.
    pub repository: String,
    /// Supported parser language, never inferred from a component name.
    pub language: String,
    /// Safe repository-relative source file.
    pub path: String,
    /// Exact declaration name.
    pub symbol: String,
    /// One-based declaration line.
    pub line: u32,
    /// Full BLAKE3 source-byte hash.
    pub content_hash: String,
    /// Optional explicit environment/layer metadata, not derived from syntax.
    #[serde(default)]
    pub properties: Properties,
}

/// Validates an anchor against the pinned syntax tree, rejecting absent/ambiguous declarations.
///
/// # Errors
/// Returns a fixed diagnostic without source text when the declaration or hash is not valid.
pub fn validate_source_anchor(
    anchor: &SourceAnchor,
    repo: RepoId,
    source: &str,
) -> Result<(Node, Evidence), &'static str> {
    if anchor.line == 0
        || anchor.path.len() > 4096
        || anchor.symbol.len() > 512
        || !valid_properties(&anchor.properties)
        || source.len() > 1_048_576
        || blake3::hash(source.as_bytes()).to_hex().as_str() != anchor.content_hash
    {
        return Err("invalid_source_anchor");
    }
    let grammar = match anchor.language.as_str() {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        _ => return Err("unsupported_anchor_language"),
    };
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&grammar)
        .map_err(|_| "anchor_parser_unavailable")?;
    let tree = parser.parse(source, None).ok_or("anchor_parse_failed")?;
    if tree.root_node().has_error() {
        return Err("anchor_syntax_incomplete");
    }
    let mut stack = vec![tree.root_node()];
    let mut matches = 0usize;
    let mut declarations = 0usize;
    while let Some(node) = stack.pop() {
        if [
            "function_item",
            "function_declaration",
            "method_definition",
            "function_definition",
        ]
        .contains(&node.kind())
            && let Some(name) = node.child_by_field_name("name")
            && name.utf8_text(source.as_bytes()).ok() == Some(anchor.symbol.as_str())
        {
            declarations += 1;
            if u32::try_from(node.start_position().row + 1).ok() == Some(anchor.line) {
                matches += 1;
            }
        }
        let mut cursor = node.walk();
        stack.extend(node.named_children(&mut cursor));
    }
    if matches != 1 {
        return Err("anchor_symbol_missing_or_ambiguous");
    }
    let language = if anchor.language == "tsx" {
        "typescript"
    } else {
        &anchor.language
    };
    let identity = SourceSymbolIdentity::new(repo.clone(), language, &anchor.path, &anchor.symbol);
    let identity = if declarations == 1 {
        identity
    } else {
        identity.at_declaration(anchor.line)
    };
    let mut node = identity.node(&anchor.symbol);
    node.properties.clone_from(&anchor.properties);
    let id = stable_id(
        "anchor-evidence",
        &format!("{}:{}", identity.stable_key(), anchor.content_hash),
    );
    let evidence = Evidence {
        id: EvidenceId::new(id),
        repo_id: Some(repo),
        file_path: Some(anchor.path.clone()),
        start_line: Some(anchor.line),
        end_line: Some(anchor.line),
        extractor: "source-anchor.syntax/v1".into(),
        extractor_version: "1.0.0".into(),
        provenance: Provenance::Extracted,
        confidence: 1.0,
        observed_at_commit: None,
        content_hash: Some(anchor.content_hash.clone()),
        note: Some(
            "Pinned declaration exists; manual dependency is not an inferred call graph".into(),
        ),
    };
    Ok((node, evidence))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_pin_rejects_missing_symbol_wrong_hash_and_wrong_line() {
        let source = "pub fn select() {}\n";
        let mut anchor = SourceAnchor {
            repository: "generic".into(),
            language: "rust".into(),
            path: "src/lib.rs".into(),
            symbol: "select".into(),
            line: 1,
            content_hash: blake3::hash(source.as_bytes()).to_hex().to_string(),
            properties: Properties::new(),
        };
        assert!(validate_source_anchor(&anchor, RepoId::new("generic"), source).is_ok());
        anchor.symbol = "missing".into();
        assert!(validate_source_anchor(&anchor, RepoId::new("generic"), source).is_err());
        anchor.symbol = "select".into();
        anchor.line = 2;
        assert!(validate_source_anchor(&anchor, RepoId::new("generic"), source).is_err());
        anchor.line = 1;
        anchor.content_hash = "invalid".into();
        assert!(validate_source_anchor(&anchor, RepoId::new("generic"), source).is_err());
    }
}
