//! F2 workspace management. All mutations use the migration journal lock and
//! the process lock acquired by `RuntimeState` before these functions run.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::migration::{self, Ctx};
use super::paths;
use super::registry;
use super::types::{AccountBinding, Workspace, WorkspaceKind, WorkspaceMarker, WorkspaceRegistry, WorkspaceStatus, WORKSPACE_LIMIT, SCHEMA_VERSION};

const DELETE_JOURNAL: &str = ".lyra_workspace_delete.json";
const DRIVE_BINDING_FILE: &str = ".lyra_drive_binding.json";

#[derive(Clone, Serialize, Deserialize)]
pub struct DriveBindingMarker {
    pub workspace_id: String,
    pub sub: String,
    /// Random, stable identity for a future remote folder. A remote folder is
    /// never selected by its human-readable name.
    pub folder_nonce: String,
}

fn binding_marker_path(ctx: &Ctx, id: &str) -> Result<PathBuf, String> {
    Ok(paths::workspace_dir(&ctx.documents, id)?.join(DRIVE_BINDING_FILE))
}

pub fn drive_binding_marker(ctx: &Ctx, id: &str) -> Result<Option<DriveBindingMarker>, String> {
    let path = binding_marker_path(ctx, id)?;
    for component in [paths::lyra_root(&ctx.documents), paths::workspaces_root(&ctx.documents),
        paths::workspace_dir(&ctx.documents, id)?, path.clone()] {
        ensure_not_symlink(&component)?;
    }
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read Drive workspace binding: {error}")),
    };
    let marker: DriveBindingMarker = serde_json::from_slice(&raw)
        .map_err(|_| "Drive workspace binding needs repair".to_string())?;
    if marker.workspace_id != id || marker.sub.trim().is_empty() || marker.folder_nonce.len() != 32 ||
        !marker.folder_nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Drive workspace binding is inconsistent".into());
    }
    Ok(Some(marker))
}

#[derive(Serialize, Deserialize)]
struct DeleteJournal {
    workspace_id: String,
    backup_name: String,
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    migration::JOURNAL_LOCK.lock().map_err(|_| "Workspace management lock is unavailable".into())
}

fn registry_for_change(ctx: &Ctx) -> Result<WorkspaceRegistry, String> {
    if migration::load(ctx)?.is_some_and(|journal| !journal.done()) {
        return Err("Complete the workspace migration before managing workspaces".into());
    }
    registry::load(&ctx.documents, &ctx.config)?.into_registry()
        .ok_or_else(|| "No workspace registry is available".into())
}

fn validated_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 60 ||
        trimmed.chars().any(|ch| ch.is_control() || ch == '/' || ch == '\\') {
        return Err("Workspace name must contain 1–60 characters without slashes or control characters".into());
    }
    Ok(trimmed.to_string())
}

fn ensure_name_available(registry: &WorkspaceRegistry, name: &str, except: Option<&str>) -> Result<(), String> {
    if registry.workspaces.iter().any(|workspace|
        Some(workspace.id.as_str()) != except && workspace.name.to_lowercase() == name.to_lowercase()) {
        return Err("A workspace with this name already exists".into());
    }
    Ok(())
}

fn ensure_not_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(format!("Refusing a symbolic link at '{}'", path.display())),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot inspect '{}': {error}", path.display())),
    }
}

fn safe_roots(ctx: &Ctx) -> Result<(), String> {
    ensure_not_symlink(&paths::lyra_root(&ctx.documents))?;
    ensure_not_symlink(&paths::workspaces_root(&ctx.documents))?;
    ensure_not_symlink(&paths::rescatados_root(&ctx.documents))
}

#[cfg(test)]
pub fn create(ctx: &Ctx, name: &str) -> Result<String, String> {
    create_with_kind(ctx, name, WorkspaceKind::Local)
}

pub fn create_with_kind(ctx: &Ctx, name: &str, kind: WorkspaceKind) -> Result<String, String> {
    let _guard = lock()?;
    recover_inner(ctx)?;
    safe_roots(ctx)?;
    let mut registry = registry_for_change(ctx)?;
    if registry.workspaces.len() >= WORKSPACE_LIMIT {
        return Err(format!("A maximum of {WORKSPACE_LIMIT} workspaces is allowed"));
    }
    let name = validated_name(name)?;
    ensure_name_available(&registry, &name, None)?;
    let id = registry::next_workspace_id(&ctx.documents, Some(&registry));
    let directory = paths::workspace_dir(&ctx.documents, &id)?;
    fs::create_dir(&directory).map_err(|e| format!("Cannot create workspace directory: {e}"))?;
    let created_at = chrono::Utc::now().timestamp_millis();
    let marker = WorkspaceMarker {
        schema_version: SCHEMA_VERSION,
        workspace_id: id.clone(),
        name: name.clone(),
        kind,
        created_at,
        origin: "created".into(),
    };
    paths::write_marker(&directory, &marker)?;
    registry.workspaces.push(Workspace {
        id: id.clone(), name, kind, created_at,
        account: None, linkage_lost: false,
    });
    registry.next_seq = registry.next_seq.max(super::ids::parse_seq(&id).unwrap_or(0).saturating_add(1));
    registry.epoch = registry.epoch.saturating_add(1);
    registry::save(&ctx.config, &registry)?;
    Ok(id)
}

/// Bind only the active Drive workspace to a verified Google subject. The
/// registry is checked under the same lock as workspace management.
pub fn bind_drive_account(ctx: &Ctx, id: &str, sub: &str, email: &str) -> Result<(), String> {
    let _guard = lock()?;
    let mut registry = registry_for_change(ctx)?;
    if registry.active_workspace_id != id { return Err("Workspace changed during Google sign-in".into()); }
    if sub.trim().is_empty() || sub != sub.trim() { return Err("Google did not provide a valid account identity".into()); }
    if registry.workspaces.iter().any(|workspace| workspace.id != id &&
        workspace.account.as_ref().is_some_and(|account| account.sub == sub)) {
        return Err("This Google account is already linked to another workspace".into());
    }
    for other in registry.workspaces.iter().filter(|workspace| workspace.id != id && workspace.kind.is_drive()) {
        if drive_binding_marker(ctx, &other.id)?.is_some_and(|marker| marker.sub == sub) {
            return Err("This Google account is already linked to another workspace".into());
        }
    }
    let workspace = registry.workspaces.iter_mut().find(|workspace| workspace.id == id)
        .ok_or("Workspace not found")?;
    if workspace.kind != WorkspaceKind::GoogleDrive ||
        registry::status_of(&ctx.documents, workspace)? != WorkspaceStatus::Ready {
        return Err("A ready Google Drive workspace is required".into());
    }
    if workspace.account.as_ref().is_some_and(|account| account.sub != sub) {
        return Err("This workspace is already linked to a different Google account".into());
    }
    let existing = drive_binding_marker(ctx, id)?;
    if workspace.linkage_lost && existing.is_none() {
        return Err("The original Drive binding is missing; this workspace needs manual repair".into());
    }
    if existing.as_ref().is_some_and(|marker| marker.sub != sub) {
        return Err("This workspace belongs to a different Google account".into());
    }
    if existing.is_none() {
        let marker = DriveBindingMarker {
            workspace_id: id.to_string(), sub: sub.to_string(),
            folder_nonce: format!("{:032x}", rand::random::<u128>()),
        };
        let raw = serde_json::to_vec(&marker).map_err(|error| error.to_string())?;
        paths::write_atomic(&binding_marker_path(ctx, id)?, &raw)?;
    }
    workspace.account = Some(AccountBinding { sub: sub.to_string(), email: email.to_string() });
    workspace.linkage_lost = false;
    registry.epoch = registry.epoch.saturating_add(1);
    registry::save(&ctx.config, &registry)
}

pub fn rename(ctx: &Ctx, id: &str, name: &str) -> Result<(), String> {
    let _guard = lock()?;
    recover_inner(ctx)?;
    safe_roots(ctx)?;
    let mut registry = registry_for_change(ctx)?;
    let name = validated_name(name)?;
    ensure_name_available(&registry, &name, Some(id))?;
    let workspace = registry.workspaces.iter_mut().find(|workspace| workspace.id == id)
        .ok_or_else(|| "Workspace not found".to_string())?;
    if registry::status_of(&ctx.documents, workspace)? != WorkspaceStatus::Ready {
        return Err("Workspace directory needs repair before renaming".into());
    }
    let directory = paths::workspace_dir(&ctx.documents, id)?;
    ensure_not_symlink(&directory)?;
    let mut marker = paths::read_marker(&directory)?.ok_or("Workspace marker is missing")?;
    let previous_marker = marker.clone();
    marker.name = name.clone();
    paths::write_marker(&directory, &marker)?;
    workspace.name = name;
    registry.epoch = registry.epoch.saturating_add(1);
    if let Err(error) = registry::save(&ctx.config, &registry) {
        paths::write_marker(&directory, &previous_marker)
            .map_err(|rollback| format!("Registry save failed ({error}); marker rollback failed ({rollback})"))?;
        return Err(error);
    }
    Ok(())
}

pub fn select(ctx: &Ctx, id: &str) -> Result<(), String> {
    let _guard = lock()?;
    recover_inner(ctx)?;
    safe_roots(ctx)?;
    let mut registry = registry_for_change(ctx)?;
    let workspace = registry.workspaces.iter().find(|workspace| workspace.id == id)
        .ok_or_else(|| "Workspace not found".to_string())?;
    if registry::status_of(&ctx.documents, workspace)? != WorkspaceStatus::Ready {
        return Err("Workspace directory needs repair before selection".into());
    }
    ensure_not_symlink(&paths::workspace_dir(&ctx.documents, id)?)?;
    if registry.active_workspace_id == id { return Ok(()); }
    registry.active_workspace_id = id.to_string();
    registry.epoch = registry.epoch.saturating_add(1);
    registry::save(&ctx.config, &registry)
}

fn journal_path(ctx: &Ctx) -> PathBuf { ctx.config.join(DELETE_JOURNAL) }

fn backup_target(ctx: &Ctx, journal: &DeleteJournal) -> Result<PathBuf, String> {
    super::ids::validate_id(&journal.workspace_id)?;
    if !journal.backup_name.starts_with(&format!("espacio-{}-", journal.workspace_id)) ||
        journal.backup_name.contains('/') || journal.backup_name.contains('\\') {
        return Err("Workspace deletion journal has an invalid backup name".into());
    }
    Ok(paths::rescatados_root(&ctx.documents).join(&journal.backup_name).join(&journal.workspace_id))
}

/// Complete an interrupted deletion without removing the preserved directory.
pub fn recover(ctx: &Ctx) -> Result<(), String> {
    let _guard = lock()?;
    recover_inner(ctx)
}

fn recover_inner(ctx: &Ctx) -> Result<(), String> {
    let path = journal_path(ctx);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot read workspace deletion journal: {error}")),
    };
    let journal: DeleteJournal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Workspace deletion journal needs repair: {e}"))?;
    safe_roots(ctx)?;
    let source = paths::workspace_dir(&ctx.documents, &journal.workspace_id)?;
    let backup = backup_target(ctx, &journal)?;
    ensure_not_symlink(&source)?;
    ensure_not_symlink(backup.parent().ok_or("Workspace backup has no parent")?)?;
    ensure_not_symlink(&backup)?;
    if source.exists() {
        if backup.exists() { return Err("Both workspace and deletion backup exist; manual repair is required".into()); }
        fs::remove_file(path).map_err(|e| format!("Cannot clear cancelled deletion: {e}"))?;
        return Ok(());
    }
    if !backup.is_dir() { return Err("Workspace deletion backup is missing; manual repair is required".into()); }
    let marker = paths::read_marker(&backup)?.ok_or("Workspace deletion backup has no marker")?;
    if marker.workspace_id != journal.workspace_id || marker.schema_version != SCHEMA_VERSION {
        return Err("Workspace deletion backup marker does not match the journal".into());
    }
    let mut registry = registry::load(&ctx.documents, &ctx.config)?.into_registry()
        .ok_or("Workspace registry is unavailable during deletion recovery")?;
    if registry.workspaces.iter().any(|workspace| workspace.id == journal.workspace_id) {
        if registry.active_workspace_id == journal.workspace_id {
            return Err("Cannot finish deletion of the active workspace".into());
        }
        registry.workspaces.retain(|workspace| workspace.id != journal.workspace_id);
        registry.epoch = registry.epoch.saturating_add(1);
        registry::save(&ctx.config, &registry)?;
    }
    // Keep the recovery copy in step with the post-deletion registry as well.
    registry::save(&ctx.config, &registry)?;
    fs::remove_file(path).map_err(|e| format!("Cannot clear completed deletion journal: {e}"))
}

/// A workspace must be selected away first. Its entire directory is moved to
/// `rescatados` and never physically deleted by this operation.
pub fn delete(ctx: &Ctx, id: &str) -> Result<(), String> {
    let _guard = lock()?;
    recover_inner(ctx)?;
    safe_roots(ctx)?;
    let registry = registry_for_change(ctx)?;
    if registry.workspaces.len() <= 1 { return Err("The last workspace cannot be deleted".into()); }
    if registry.active_workspace_id == id { return Err("Select another workspace before deleting this one".into()); }
    let workspace = registry.workspaces.iter().find(|workspace| workspace.id == id)
        .ok_or_else(|| "Workspace not found".to_string())?;
    if registry::status_of(&ctx.documents, workspace)? != WorkspaceStatus::Ready {
        return Err("Workspace directory needs repair before deletion".into());
    }
    let source = paths::workspace_dir(&ctx.documents, id)?;
    ensure_not_symlink(&source)?;
    fs::create_dir_all(paths::rescatados_root(&ctx.documents))
        .map_err(|e| format!("Cannot prepare workspace backup: {e}"))?;
    let backup_name = format!("espacio-{id}-{:032x}", rand::random::<u128>());
    let container = paths::rescatados_root(&ctx.documents).join(&backup_name);
    fs::create_dir(&container).map_err(|e| format!("Cannot reserve workspace backup: {e}"))?;
    let journal = DeleteJournal { workspace_id: id.to_string(), backup_name };
    paths::write_atomic(&journal_path(ctx), &serde_json::to_vec(&journal).map_err(|e| e.to_string())?)?;
    let backup = backup_target(ctx, &journal)?;
    fs::rename(&source, &backup).map_err(|e| format!("Cannot preserve workspace before deletion: {e}"))?;
    recover_inner(ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gdrive::archive;
    use crate::workspaces::{snapshot, migration::Faults};

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("lyra-f2-management-{:032x}", rand::random::<u128>()));
            fs::create_dir_all(root.join("Documents/lyra")).unwrap();
            fs::create_dir_all(root.join("config")).unwrap();
            Self(root)
        }
        fn ctx(&self) -> Ctx { Ctx::new(self.0.join("Documents"), self.0.join("config")) }
        fn first(&self) {
            let ctx = self.ctx();
            snapshot(&ctx.documents, &ctx.config, &Faults::none()).unwrap();
        }
    }
    impl Drop for Home {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn creates_renames_and_selects_without_mixing_note_directories() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        let second = create(&ctx, " Work ").unwrap();
        assert_eq!(second, "ws_002");
        assert!(create(&ctx, "work").is_err());
        rename(&ctx, &second, "Private").unwrap();
        let first_dir = paths::workspace_dir(&ctx.documents, "ws_001").unwrap();
        let second_dir = paths::workspace_dir(&ctx.documents, &second).unwrap();
        fs::write(first_dir.join("Same.md"), b"first").unwrap();
        fs::write(second_dir.join("Same.md"), b"second").unwrap();
        archive::set_archived(&first_dir, "Same.md", true, None).unwrap();
        assert_eq!(archive::projection(&first_dir, None).unwrap().archived_names, vec!["Same.md"]);
        assert!(archive::projection(&second_dir, None).unwrap().archived_names.is_empty());
        select(&ctx, &second).unwrap();
        assert_eq!(registry::active_ready_dir(&ctx.documents, &ctx.config).unwrap(), Some(second_dir.clone()));
        assert_eq!(fs::read(second_dir.join("Same.md")).unwrap(), b"second");
        select(&ctx, "ws_001").unwrap();
        assert_eq!(registry::active_ready_dir(&ctx.documents, &ctx.config).unwrap(), Some(first_dir));
        assert_eq!(fs::read(second_dir.join("Same.md")).unwrap(), b"second");
    }

    #[test]
    fn limit_is_enforced_in_rust_and_ids_are_not_reused() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        for number in 2..=5 { assert_eq!(create(&ctx, &format!("Space {number}")).unwrap(), format!("ws_00{number}")); }
        assert!(create(&ctx, "Sixth").unwrap_err().contains("maximum"));
        delete(&ctx, "ws_003").unwrap();
        assert_eq!(create(&ctx, "New fifth").unwrap(), "ws_006");
    }

    #[test]
    fn drive_account_is_unique_and_reconnect_requires_original_subject() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        let first = create_with_kind(&ctx, "First Drive", WorkspaceKind::GoogleDrive).unwrap();
        select(&ctx, &first).unwrap();
        bind_drive_account(&ctx, &first, "subject-a", "one@example.test").unwrap();
        let marker = drive_binding_marker(&ctx, &first).unwrap().unwrap();
        assert_eq!(marker.sub, "subject-a");
        assert_eq!(marker.folder_nonce.len(), 32);

        let second = create_with_kind(&ctx, "Second Drive", WorkspaceKind::GoogleDrive).unwrap();
        select(&ctx, &second).unwrap();
        assert!(bind_drive_account(&ctx, &second, "subject-a", "one@example.test")
            .unwrap_err().contains("already linked"));
        bind_drive_account(&ctx, &second, "subject-b", "two@example.test").unwrap();
        let second_marker = drive_binding_marker(&ctx, &second).unwrap().unwrap();
        assert_ne!(second_marker.folder_nonce, marker.folder_nonce);

        fs::write(registry::registry_path(&ctx.config), b"{broken").unwrap();
        fs::write(ctx.config.join("workspaces.json.bak"), b"{broken").unwrap();
        let rebuilt = registry::load(&ctx.documents, &ctx.config).unwrap().into_registry().unwrap();
        assert!(rebuilt.workspaces.iter().find(|workspace| workspace.id == second).unwrap().linkage_lost);
        select(&ctx, &second).unwrap();
        assert!(bind_drive_account(&ctx, &second, "subject-a", "one@example.test").is_err());
        bind_drive_account(&ctx, &second, "subject-b", "two@example.test").unwrap();
        assert_eq!(drive_binding_marker(&ctx, &second).unwrap().unwrap().folder_nonce,
            second_marker.folder_nonce);
    }

    #[test]
    fn local_workspace_cannot_bind_and_lost_binding_without_marker_stays_locked() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        assert!(bind_drive_account(&ctx, "ws_001", "subject-a", "one@example.test").is_err());
        let drive = create_with_kind(&ctx, "Drive", WorkspaceKind::GoogleDrive).unwrap();
        select(&ctx, &drive).unwrap();
        fs::write(registry::registry_path(&ctx.config), b"{broken").unwrap();
        fs::write(ctx.config.join("workspaces.json.bak"), b"{broken").unwrap();
        select(&ctx, &drive).unwrap();
        assert!(bind_drive_account(&ctx, &drive, "subject-a", "one@example.test")
            .unwrap_err().contains("original Drive binding is missing"));
    }

    #[cfg(unix)]
    #[test]
    fn drive_binding_refuses_a_symbolic_link() {
        use std::os::unix::fs::symlink;
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        let drive = create_with_kind(&ctx, "Drive", WorkspaceKind::GoogleDrive).unwrap();
        select(&ctx, &drive).unwrap();
        let outside = home.0.join("outside.json");
        fs::write(&outside, b"{}" ).unwrap();
        symlink(&outside, binding_marker_path(&ctx, &drive).unwrap()).unwrap();
        assert!(bind_drive_account(&ctx, &drive, "subject-a", "one@example.test")
            .unwrap_err().contains("symbolic link"));
        assert_eq!(fs::read(&outside).unwrap(), b"{}");
    }

    #[test]
    fn deleted_highest_id_is_not_reused_after_registry_rebuild() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        let second = create(&ctx, "Other").unwrap();
        delete(&ctx, &second).unwrap();
        fs::write(registry::registry_path(&ctx.config), b"{broken").unwrap();
        fs::write(ctx.config.join("workspaces.json.bak"), b"{broken").unwrap();
        assert_eq!(create(&ctx, "After rebuild").unwrap(), "ws_003");
    }

    #[test]
    fn deletion_preserves_all_files_and_cannot_remove_active_or_last_workspace() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        assert!(delete(&ctx, "ws_001").is_err());
        let second = create(&ctx, "Other").unwrap();
        assert!(delete(&ctx, "ws_001").is_err());
        let directory = paths::workspace_dir(&ctx.documents, &second).unwrap();
        fs::write(directory.join("private.md"), b"keep me").unwrap();
        delete(&ctx, &second).unwrap();
        let backup_root = paths::rescatados_root(&ctx.documents);
        let container = fs::read_dir(backup_root).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(container.join(&second).join("private.md")).unwrap(), b"keep me");
        assert!(!directory.exists());
        assert!(snapshot(&ctx.documents, &ctx.config, &Faults::none()).unwrap().workspaces.iter().all(|item| item.id != second));
        assert!(!journal_path(&ctx).exists());
    }

    #[test]
    fn interrupted_deletion_finishes_from_its_preserved_backup() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        let second = create(&ctx, "Other").unwrap();
        let source = paths::workspace_dir(&ctx.documents, &second).unwrap();
        fs::write(source.join("note.txt"), b"durable").unwrap();
        fs::create_dir_all(paths::rescatados_root(&ctx.documents)).unwrap();
        let journal = DeleteJournal { workspace_id: second.clone(), backup_name: format!("espacio-{second}-fixture") };
        let backup = backup_target(&ctx, &journal).unwrap();
        fs::create_dir(backup.parent().unwrap()).unwrap();
        paths::write_atomic(&journal_path(&ctx), &serde_json::to_vec(&journal).unwrap()).unwrap();
        fs::rename(&source, &backup).unwrap();
        recover(&ctx).unwrap();
        assert_eq!(fs::read(backup.join("note.txt")).unwrap(), b"durable");
        assert!(!journal_path(&ctx).exists());
        assert_eq!(registry::load(&ctx.documents, &ctx.config).unwrap().registry().unwrap().workspaces.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_management_refuses_symlinked_roots() {
        let home = Home::new();
        home.first();
        let ctx = home.ctx();
        let workspaces = paths::workspaces_root(&ctx.documents);
        let outside = home.0.join("outside");
        fs::rename(&workspaces, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &workspaces).unwrap();
        assert!(create(&ctx, "Unsafe").is_err());
        assert!(!outside.join("ws_002").exists());
        let registered = registry::load(&ctx.documents, &ctx.config).unwrap().into_registry().unwrap();
        assert_eq!(registry::status_of(&ctx.documents, registered.active().unwrap()).unwrap(), WorkspaceStatus::Unreadable);
    }
}
