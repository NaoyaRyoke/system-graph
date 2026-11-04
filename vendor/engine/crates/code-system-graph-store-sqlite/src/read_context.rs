// Modified from Code System Graph v1.2.1; local hardening, formatting and standalone packaging. See VENDOR.md.
//! Consistent, private, disposable pre-analysis graph projection, never response filtering.
use super::{SqliteStore, StoreError};
use code_system_graph_model::{GraphReadContext, stable_id};
use rusqlite::params;
use std::path::Path;

/// Owns a disposable consistent snapshot. Drop removes only this view.
#[derive(Debug)]
pub struct ScopedReadView {
    directory: tempfile::TempDir,
    /// Source snapshot from which the view was copied.
    pub source_snapshot: String,
    /// Independent scope-specific snapshot identity.
    pub snapshot: String,
    /// Remaining graph entities.
    pub nodes: usize,
    /// Remaining graph relationships.
    pub edges: usize,
}
impl ScopedReadView {
    /// Database location retained until the view is dropped.
    #[must_use]
    pub fn path(&self) -> std::path::PathBuf {
        self.directory.path().join("graph.db")
    }
    /// Installs freshly recomputed aggregates for this view only.
    ///
    /// # Errors
    /// Rejects an aggregate belonging to a different snapshot or workspace.
    pub fn install_communities(
        &self,
        workspace: &str,
        snapshot: &code_system_graph_model::CommunitySnapshot,
    ) -> Result<(), StoreError> {
        if snapshot.snapshot_id != self.snapshot {
            return Err(StoreError::InvalidSchema);
        }
        let mut store = SqliteStore::open(self.path())?;
        let tx = store.connection.transaction()?;
        super::insert_community_snapshot(&tx, workspace, snapshot, &mut |_| {})?;
        tx.commit()?;
        Ok(())
    }
}
impl SqliteStore {
    /// Creates a scoped snapshot before analysis. The source remains read-only and unchanged.
    ///
    /// # Errors
    /// Rejects invalid context, missing workspace, or any backup/pruning/integrity failure.
    pub fn scoped_read_view(
        &self,
        workspace: &str,
        context: &GraphReadContext,
        cache_root: &Path,
    ) -> Result<ScopedReadView, StoreError> {
        if !context.is_valid() {
            return Err(StoreError::InvalidSchema);
        }
        std::fs::create_dir_all(cache_root).map_err(|_| StoreError::InvalidSchema)?;
        let directory = tempfile::Builder::new()
            .prefix("view-")
            .tempdir_in(cache_root)
            .map_err(|_| StoreError::InvalidSchema)?;
        let path = directory.path().join("graph.db");
        self.backup_to(&path)?;
        let mut view = Self::open(&path)?;
        let source_snapshot = view.current_snapshot_id(workspace)?;
        let (nodes, edges) = view.load_current_graph(workspace)?;
        let (allowed_nodes, allowed_edges) = context.select(&nodes, &edges);
        let snapshot = stable_id(
            "context-snapshot",
            &format!("{}:{}", source_snapshot, serde_json::to_string(context)?),
        );
        let tx = view.connection.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE allowed_nodes(id TEXT PRIMARY KEY); CREATE TEMP TABLE allowed_edges(id TEXT PRIMARY KEY);")?;
        for id in &allowed_nodes {
            tx.execute("INSERT INTO allowed_nodes(id) VALUES(?1)", [id.as_str()])?;
        }
        for id in &allowed_edges {
            tx.execute("INSERT INTO allowed_edges(id) VALUES(?1)", [id.as_str()])?;
        }
        tx.execute("DELETE FROM nodes WHERE workspace_name=?1 AND id NOT IN (SELECT id FROM allowed_nodes)",[workspace])?;
        tx.execute("DELETE FROM edges WHERE workspace_name=?1 AND id NOT IN (SELECT id FROM allowed_edges)",[workspace])?;
        // Cached aggregates refer to the unfiltered graph; never reuse them in this view.
        for table in [
            "query_cache",
            "community_snapshots",
            "http_link_gaps",
            "http_link_coverage",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE workspace_name=?1"),
                [workspace],
            )?;
        }
        tx.execute(
            "UPDATE repo_snapshots SET id=?1 WHERE workspace_name=?2",
            params![snapshot, workspace],
        )?;
        tx.commit()?;
        let check: String = view
            .connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let violations: i64 = view.connection.query_row(
            "SELECT count(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        if check != "ok" || violations != 0 {
            return Err(StoreError::InvalidSchema);
        }
        drop(view);
        Ok(ScopedReadView {
            directory,
            source_snapshot,
            snapshot,
            nodes: allowed_nodes.len(),
            edges: allowed_edges.len(),
        })
    }
}
