//! Workspace registry: the authoritative list of workspaces.
//!
//! The registry lives in the app config directory (not in Documents) and is
//! rebuilt from the per-workspace markers whenever it is missing or damaged.
//! Rebuilding never invents account bindings: a rebuilt Drive workspace is
//! marked `linkage_lost` and becomes read-only until the user reconnects.

use std::path::{Path, PathBuf};

use super::ids;
use super::paths;
use super::types::{
    Workspace, WorkspaceInfo, WorkspaceMarker, WorkspaceRegistry, WorkspaceStatus,
    WritePolicy, SCHEMA_VERSION,
};
#[cfg(test)]
use super::types::WorkspaceKind;

pub const REGISTRY_FILE: &str = "workspaces.json";

#[derive(Debug)]
pub enum Loaded {
    /// Read from the registry file (primary or backup).
    Registry(WorkspaceRegistry),
    /// Reconstructed from workspace markers.
    Rebuilt(WorkspaceRegistry),
    /// No registry and no markers: first run.
    Absent,
}

impl Loaded {
    pub fn registry(&self) -> Option<&WorkspaceRegistry> {
        match self {
            Loaded::Registry(registry) | Loaded::Rebuilt(registry) => Some(registry),
            Loaded::Absent => None,
        }
    }

    pub fn into_registry(self) -> Option<WorkspaceRegistry> {
        match self {
            Loaded::Registry(registry) | Loaded::Rebuilt(registry) => Some(registry),
            Loaded::Absent => None,
        }
    }

    pub fn is_rebuilt(&self) -> bool {
        matches!(self, Loaded::Rebuilt(_))
    }
}

pub fn registry_path(config_dir: &Path) -> PathBuf {
    config_dir.join(REGISTRY_FILE)
}

fn backup_path(config_dir: &Path) -> PathBuf {
    config_dir.join(format!("{REGISTRY_FILE}.bak"))
}

fn parse(bytes: &[u8]) -> Result<WorkspaceRegistry, String> {
    let registry: WorkspaceRegistry = serde_json::from_slice(bytes)
        .map_err(|e| format!("Workspace registry is unreadable: {e}"))?;
    if !registry.is_valid() {
        return Err("Workspace registry is inconsistent".to_string());
    }
    Ok(registry)
}

fn read_registry(path: &Path) -> Option<WorkspaceRegistry> {
    std::fs::read(path).ok().and_then(|bytes| parse(&bytes).ok())
}

/// Loads the registry, falling back to the backup and then to a rebuild from
/// the workspace markers. Never deletes or rewrites anything on failure.
pub fn load(documents: &Path, config_dir: &Path) -> Result<Loaded, String> {
    if let Some(registry) = read_registry(&registry_path(config_dir)) {
        return Ok(Loaded::Registry(registry));
    }
    if let Some(registry) = read_registry(&backup_path(config_dir)) {
        return Ok(Loaded::Registry(registry));
    }

    let markers = scan_markers(documents)?;
    if !markers.is_empty() {
        return Ok(Loaded::Rebuilt(rebuild(markers)));
    }
    Ok(Loaded::Absent)
}

/// Reads every marker under `workspaces/`. Directories without a readable
/// marker are ignored here; a workspace that is *in* the registry but whose
/// marker is damaged is reported as `Unreadable` by [`info`].
pub fn scan_markers(documents: &Path) -> Result<Vec<WorkspaceMarker>, String> {
    let root = paths::workspaces_root(documents);
    for component in [paths::lyra_root(documents), root.clone()] {
        match std::fs::symlink_metadata(&component) {
            Ok(metadata) if metadata.file_type().is_symlink() =>
                return Err("Workspace registry cannot be rebuilt through a symbolic link".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("Cannot inspect workspace registry root: {error}")),
        }
    }
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot list workspaces: {error}")),
    };
    let mut markers = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Cannot inspect workspace entry: {e}"))?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(directory_name) = entry.file_name().into_string() else { continue };
        if ids::validate_id(&directory_name).is_err() {
            continue;
        }
        let Ok(Some(marker)) = paths::read_marker(&entry.path()) else { continue };
        // A marker that names another workspace is inconsistent: never adopt it.
        if marker.workspace_id != directory_name || marker.schema_version != SCHEMA_VERSION {
            continue;
        }
        markers.push(marker);
    }
    markers.sort_by_key(|marker| ids::parse_seq(&marker.workspace_id).unwrap_or(u32::MAX));
    Ok(markers)
}

pub fn rebuild(markers: Vec<WorkspaceMarker>) -> WorkspaceRegistry {
    let workspaces: Vec<Workspace> = markers
        .into_iter()
        .map(|marker| Workspace {
            id: marker.workspace_id,
            name: marker.name,
            // Account bindings are deliberately absent: they are only ever
            // written after a verified login.
            linkage_lost: marker.kind.is_drive(),
            kind: marker.kind,
            created_at: marker.created_at,
            account: None,
        })
        .collect();
    let next_seq = ids::next_seq(workspaces.iter().map(|workspace| workspace.id.as_str()));
    let active_workspace_id = workspaces
        .iter()
        .find(|workspace| workspace.write_policy() == WritePolicy::Editable)
        .or_else(|| workspaces.first())
        .map(|workspace| workspace.id.clone())
        .unwrap_or_default();
    WorkspaceRegistry {
        schema_version: SCHEMA_VERSION,
        active_workspace_id,
        workspaces,
        next_seq,
        migrated_at: None,
        migration_id: None,
        epoch: 1,
    }
}

/// Writes the registry atomically, keeping the previous valid copy as `.bak`.
pub fn save(config_dir: &Path, registry: &WorkspaceRegistry) -> Result<(), String> {
    if !registry.is_valid() {
        return Err("Refusing to persist an inconsistent workspace registry".to_string());
    }
    std::fs::create_dir_all(config_dir)
        .map_err(|e| format!("Cannot create the config directory: {e}"))?;
    let primary = registry_path(config_dir);
    if read_registry(&primary).is_some() {
        let _ = std::fs::copy(&primary, backup_path(config_dir));
    }
    let bytes = serde_json::to_vec_pretty(registry).map_err(|e| e.to_string())?;
    paths::write_atomic(&primary, &bytes)
}

/// Runtime status of a workspace, derived from the directory and its marker.
pub fn status_of(documents: &Path, workspace: &Workspace) -> Result<WorkspaceStatus, String> {
    let directory = paths::workspace_dir(documents, &workspace.id)?;
    for component in [paths::lyra_root(documents), paths::workspaces_root(documents), directory.clone()] {
        match std::fs::symlink_metadata(&component) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(WorkspaceStatus::Unreadable),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(WorkspaceStatus::Missing),
            Err(error) => return Err(format!("Cannot inspect workspace directory: {error}")),
        }
    }
    if !directory.is_dir() {
        return Ok(WorkspaceStatus::Missing);
    }
    match paths::read_marker(&directory) {
        Ok(Some(marker))
            if marker.workspace_id == workspace.id && marker.kind == workspace.kind =>
        {
            Ok(WorkspaceStatus::Ready)
        }
        _ => Ok(WorkspaceStatus::Unreadable),
    }
}

pub fn info(documents: &Path, workspace: &Workspace) -> Result<WorkspaceInfo, String> {
    let status = status_of(documents, workspace)?;
    let write_policy = if status == WorkspaceStatus::Ready {
        workspace.write_policy()
    } else {
        WritePolicy::ReadOnly
    };
    Ok(WorkspaceInfo {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        kind: workspace.kind,
        status,
        write_policy,
        linkage_lost: workspace.linkage_lost,
        directory: workspace.relative_dir(),
    })
}

/// Directory of the active workspace when it is fully usable.
pub fn active_ready_dir(documents: &Path, config_dir: &Path) -> Result<Option<PathBuf>, String> {
    let loaded = load(documents, config_dir)?;
    let Some(registry) = loaded.registry() else { return Ok(None) };
    let Some(workspace) = registry.active() else { return Ok(None) };
    if status_of(documents, workspace)? != WorkspaceStatus::Ready {
        return Ok(None);
    }
    Ok(Some(paths::workspace_dir(documents, &workspace.id)?))
}

/// Adds a workspace to an existing registry, or creates the registry.
/// Used by the migration commit and by future workspace creation.
pub fn upsert(
    registry: Option<WorkspaceRegistry>,
    workspace: Workspace,
    migration_id: Option<String>,
    at: i64,
) -> WorkspaceRegistry {
    let mut registry = registry.unwrap_or_else(|| {
        WorkspaceRegistry::new(workspace.clone(), migration_id.clone(), Some(at))
    });
    registry.schema_version = SCHEMA_VERSION;
    if let Some(existing) = registry
        .workspaces
        .iter_mut()
        .find(|existing| existing.id == workspace.id)
    {
        *existing = workspace.clone();
    } else {
        registry.workspaces.push(workspace.clone());
        registry.workspaces.sort_by_key(|item| ids::parse_seq(&item.id).unwrap_or(u32::MAX));
    }
    registry.active_workspace_id = workspace.id.clone();
    registry.next_seq = registry
        .next_seq
        .max(ids::parse_seq(&workspace.id).map(|seq| seq.saturating_add(1)).unwrap_or(1));
    if migration_id.is_some() {
        registry.migration_id = migration_id;
        registry.migrated_at = Some(at);
    }
    registry.epoch = registry.epoch.saturating_add(1);
    registry
}

/// Picks the id for a brand new workspace without ever reusing one, even if
/// `workspaces/` has orphan directories left by an interrupted attempt.
pub fn next_workspace_id(documents: &Path, registry: Option<&WorkspaceRegistry>) -> String {
    let mut sequences: Vec<String> = registry
        .map(|registry| {
            registry
                .workspaces
                .iter()
                .map(|workspace| workspace.id.clone())
                .collect()
        })
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(paths::workspaces_root(documents)) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                sequences.push(name);
            }
        }
    }
    // Deleted workspaces remain in rescatados; their ids must never be reused
    // even when the registry has to be rebuilt from surviving markers.
    if let Ok(entries) = std::fs::read_dir(paths::rescatados_root(documents)) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string() {
                if let Some(id) = name.strip_prefix("espacio-").and_then(|rest| rest.split('-').next()) {
                    if ids::validate_id(id).is_ok() { sequences.push(id.to_string()); }
                }
            }
        }
    }
    ids::format_id(ids::next_seq(sequences.iter().map(|id| id.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestHome {
        documents: PathBuf,
        config: PathBuf,
    }
    impl TestHome {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("lyra-ws-registry-{:032x}", rand::random::<u128>()));
            let documents = base.join("Documents");
            let config = base.join("config");
            fs::create_dir_all(documents.join("lyra/workspaces")).unwrap();
            fs::create_dir_all(&config).unwrap();
            Self { documents, config }
        }
        fn add_marker(&self, id: &str, kind: WorkspaceKind, name: &str) {
            let dir = paths::workspaces_root(&self.documents).join(id);
            fs::create_dir_all(&dir).unwrap();
            paths::write_marker(&dir, &WorkspaceMarker {
                schema_version: SCHEMA_VERSION,
                workspace_id: id.to_string(),
                name: name.to_string(),
                kind,
                created_at: 10,
                origin: "test".to_string(),
            })
            .unwrap();
        }
        fn local(&self, id: &str) -> Workspace {
            Workspace {
                id: id.to_string(),
                name: "Mi espacio".to_string(),
                kind: WorkspaceKind::Local,
                created_at: 10,
                account: None,
                linkage_lost: false,
            }
        }
    }
    impl Drop for TestHome {
        fn drop(&mut self) {
            if let Some(base) = self.documents.parent() {
                let _ = fs::remove_dir_all(base);
            }
        }
    }

    #[test]
    fn saves_and_reloads_the_registry() {
        let home = TestHome::new();
        home.add_marker("ws_001", WorkspaceKind::Local, "Mi espacio");
        let registry = WorkspaceRegistry::new(home.local("ws_001"), Some("m1".into()), Some(5));
        save(&home.config, &registry).unwrap();

        let loaded = load(&home.documents, &home.config).unwrap();
        assert!(!loaded.is_rebuilt());
        let loaded = loaded.into_registry().unwrap();
        assert_eq!(loaded.active_workspace_id, "ws_001");
        assert_eq!(loaded.next_seq, 2);
        assert_eq!(loaded.migration_id.as_deref(), Some("m1"));
    }

    #[test]
    fn corrupt_primary_falls_back_to_the_backup() {
        let home = TestHome::new();
        home.add_marker("ws_001", WorkspaceKind::Local, "Mi espacio");
        let registry = WorkspaceRegistry::new(home.local("ws_001"), None, None);
        save(&home.config, &registry).unwrap();
        save(&home.config, &registry).unwrap();
        fs::write(registry_path(&home.config), b"{roto").unwrap();

        let loaded = load(&home.documents, &home.config).unwrap();
        assert!(!loaded.is_rebuilt());
        assert_eq!(loaded.into_registry().unwrap().active_workspace_id, "ws_001");
    }

    #[test]
    fn missing_registry_is_rebuilt_from_markers_without_reusing_ids() {
        let home = TestHome::new();
        home.add_marker("ws_002", WorkspaceKind::Local, "Estudio");
        home.add_marker("ws_007", WorkspaceKind::Local, "Diario");
        let loaded = load(&home.documents, &home.config).unwrap();
        assert!(loaded.is_rebuilt());
        let registry = loaded.into_registry().unwrap();
        assert_eq!(
            registry.workspaces.iter().map(|workspace| workspace.id.as_str()).collect::<Vec<_>>(),
            vec!["ws_002", "ws_007"]
        );
        assert_eq!(registry.active_workspace_id, "ws_002");
        assert_eq!(registry.next_seq, 8);
        assert_eq!(next_workspace_id(&home.documents, Some(&registry)), "ws_008");
    }

    #[test]
    fn rebuilt_drive_workspace_loses_its_linkage_and_is_read_only() {
        let home = TestHome::new();
        home.add_marker("ws_001", WorkspaceKind::Local, "Local");
        home.add_marker("ws_002", WorkspaceKind::GoogleDrive, "Nube");
        let registry = load(&home.documents, &home.config).unwrap().into_registry().unwrap();
        let drive = registry.workspaces.iter().find(|workspace| workspace.id == "ws_002").unwrap();
        assert!(drive.linkage_lost);
        assert_eq!(drive.write_policy(), WritePolicy::ReadOnly);
        assert!(drive.account.is_none());
        assert_eq!(registry.active_workspace_id, "ws_001");
    }

    #[test]
    fn status_reports_missing_and_inconsistent_workspaces() {
        let home = TestHome::new();
        home.add_marker("ws_001", WorkspaceKind::Local, "Mi espacio");
        home.add_marker("ws_002", WorkspaceKind::Local, "Otra");
        let missing = home.local("ws_003");
        assert_eq!(status_of(&home.documents, &missing).unwrap(), WorkspaceStatus::Missing);
        assert_eq!(info(&home.documents, &missing).unwrap().write_policy, WritePolicy::ReadOnly);

        // Marker replaced by another workspace's marker: the workspace is
        // blocked instead of being silently accepted.
        let dir = paths::workspaces_root(&home.documents).join("ws_002");
        paths::write_marker(&dir, &WorkspaceMarker {
            schema_version: SCHEMA_VERSION,
            workspace_id: "ws_001".to_string(),
            name: "Mi espacio".to_string(),
            kind: WorkspaceKind::Local,
            created_at: 10,
            origin: "test".to_string(),
        })
        .unwrap();
        let inconsistent = home.local("ws_002");
        assert_eq!(status_of(&home.documents, &inconsistent).unwrap(), WorkspaceStatus::Unreadable);
        assert_eq!(info(&home.documents, &inconsistent).unwrap().write_policy, WritePolicy::ReadOnly);
    }

    #[test]
    fn absent_when_there_is_nothing_on_disk() {
        let home = TestHome::new();
        assert!(matches!(load(&home.documents, &home.config).unwrap(), Loaded::Absent));
        assert!(matches!(load(&home.documents, &home.config).unwrap(), Loaded::Absent));
    }

    #[test]
    fn rejects_a_registry_with_unsafe_ids() {
        let home = TestHome::new();
        let mut registry = WorkspaceRegistry::new(home.local("ws_001"), None, None);
        registry.workspaces[0].id = "../fuera".to_string();
        assert!(save(&home.config, &registry).is_err());
        assert!(!registry_path(&home.config).exists());
    }

    #[test]
    fn upsert_keeps_existing_workspaces_and_bumps_the_epoch() {
        let home = TestHome::new();
        let first = WorkspaceRegistry::new(home.local("ws_001"), None, None);
        let second = home.local("ws_002");
        let merged = upsert(Some(first), second, None, 0);
        assert_eq!(merged.workspaces.len(), 2);
        assert_eq!(merged.active_workspace_id, "ws_002");
        assert_eq!(merged.next_seq, 3);
        assert_eq!(merged.epoch, 2);
    }
}
