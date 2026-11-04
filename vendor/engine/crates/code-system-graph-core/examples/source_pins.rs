// Modified from Code System Graph v1.2.1; local hardening, formatting and standalone packaging. See VENDOR.md.
//! Offline source-pin preparation example. Emits only indexes and fixed diagnostics.
use code_system_graph_core::{SourceAnchor, validate_source_anchor};
use code_system_graph_model::RepoId;
use std::{fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = PathBuf::from(std::env::args().nth(1).ok_or("manifest required")?);
    let stamp = std::env::args().any(|arg| arg == "--stamp");
    let root = path.parent().ok_or("parent required")?;
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    let repos = value["repos"].clone();
    let anchors = value["sourceAnchors"]
        .as_array_mut()
        .ok_or("anchors required")?;
    let mut failures = 0;
    for (index, value) in anchors.iter_mut().enumerate() {
        let mut anchor: SourceAnchor = serde_json::from_value(value.clone())?;
        let repo = repos[&anchor.repository]["path"]
            .as_str()
            .ok_or("repo path")?;
        let directory = code_system_graph_core::CapabilityDir::open(&root.join(repo))?;
        let source =
            directory.read_utf8_file_bounded(std::path::Path::new(&anchor.path), 1_048_576)?;
        if stamp {
            anchor.content_hash = blake3::hash(source.as_bytes()).to_hex().to_string();
            *value = serde_json::to_value(&anchor)?;
        }
        match validate_source_anchor(&anchor, RepoId::new("offline-source-pin"), &source) {
            Ok(_) => println!("{index}: source pin valid"),
            Err(reason) => {
                failures += 1;
                println!("{index}: {reason}");
            }
        }
    }
    if failures > 0 {
        return Err("source pin validation failed".into());
    }
    if stamp {
        fs::write(&path, serde_json::to_string_pretty(&value)? + "\n")?;
    }
    Ok(())
}
