//! F4 workspace-scoped manifest and checked commit boundary. The legacy
//! account manifest is intentionally never imported into this format.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::workspaces::sync_context::{self, SyncPermit, SyncRequest};
use crate::workspaces::{ids, management, paths, registry};
use crate::workspaces::migration::Ctx;
use crate::workspaces::types::WorkspaceKind;

use super::sync::{self, MANIFEST_LOCK};
use super::client::{DriveClient, RemoteFileStatus};
use super::types::DriveFileMetadata;
use super::provenance;

const FILE_NAME: &str = ".lyra_workspace_drive_manifest.json";
const SCHEMA_VERSION: u32 = 1;
pub(crate) fn safe_remote_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 &&
        id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}
/// Serializes F4 remote effects with local tombstone and rename mutations.
/// HTTP never holds MANIFEST_LOCK; workspace transitions use F3's critical lock.
pub static EFFECT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceIdentity {
    pub workspace_id: String,
    pub account_sub: String,
    pub folder_nonce: String,
}

impl WorkspaceIdentity {
    pub fn validate(&self) -> Result<(), String> {
        ids::validate_id(&self.workspace_id)?;
        if self.account_sub.trim().is_empty() || self.account_sub != self.account_sub.trim() {
            return Err("Drive workspace has no verified Google subject".into());
        }
        if self.folder_nonce.len() != 32 ||
            !self.folder_nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Drive workspace has no valid remote folder identity".into());
        }
        Ok(())
    }
}

/// Resolve the binding entirely from Rust's validated workspace registry and
/// marker. Neither the frontend nor a legacy manifest can supply identity.
pub fn resolve_identity(ctx: &Ctx, request: &SyncRequest) -> Result<(WorkspaceIdentity, PathBuf), String> {
    let resolved = sync_context::resolve(&ctx.documents, &ctx.config, request)?;
    if resolved.kind != WorkspaceKind::GoogleDrive {
        return Err("SyncDisabled: this workspace is local".into());
    }
    let loaded = registry::load(&ctx.documents, &ctx.config)?;
    let workspace = loaded.registry().and_then(|book| book.active())
        .ok_or("Drive workspace is unavailable")?;
    if workspace.linkage_lost { return Err("Drive workspace must be reconnected explicitly".into()); }
    let account = workspace.account.as_ref().ok_or("Drive workspace has no verified account")?;
    let marker = management::drive_binding_marker(ctx, &workspace.id)?
        .ok_or("Drive workspace binding marker is missing")?;
    if marker.sub != account.sub { return Err("Drive workspace binding does not match its account".into()); }
    let identity = WorkspaceIdentity {
        workspace_id: workspace.id.clone(), account_sub: account.sub.clone(),
        folder_nonce: marker.folder_nonce,
    };
    identity.validate()?;
    Ok((identity, resolved.notes_dir))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceFile {
    pub drive_id: String,
    pub digest: String,
    pub note_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceTombstone {
    pub drive_id: String,
    pub note_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadPhase { Prepared, Dispatched }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadIntent {
    pub note_id: String,
    pub digest: String,
    pub phase: UploadPhase,
    #[serde(default)]
    pub remote_id: Option<String>,
    #[serde(default)]
    pub previous_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadIntent {
    pub name: String,
    pub note_id: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceManifest {
    pub schema_version: u32,
    pub workspace_id: String,
    pub account_sub: String,
    pub folder_nonce: String,
    pub folder_id: Option<String>,
    #[serde(default)]
    pub folder_create_id: Option<String>,
    #[serde(default)]
    pub folder_create_dispatched: bool,
    pub revision: u64,
    pub files: BTreeMap<String, WorkspaceFile>,
    /// Immutable remote versions superseded locally. A changed digest means
    /// another client edited that version and it must surface as a conflict.
    #[serde(default)]
    pub historical_versions: BTreeMap<String, String>,
    /// Current version ID to the stable ID used by causal archive operations.
    #[serde(default)]
    pub archive_anchors: BTreeMap<String, String>,
    /// Local names may differ from immutable Drive names after a collision.
    #[serde(default)]
    pub remote_names: BTreeMap<String, String>,
    /// A conflict remains visible until the user explicitly acknowledges it.
    #[serde(default)]
    pub conflicts: BTreeMap<String, String>,
    pub pending_deletions: BTreeMap<String, WorkspaceTombstone>,
    #[serde(default)]
    pub pending_renames: BTreeMap<String, String>,
    #[serde(default)]
    pub pending_uploads: BTreeMap<String, UploadIntent>,
    #[serde(default)]
    pub pending_downloads: BTreeMap<String, DownloadIntent>,
}

impl WorkspaceManifest {
    pub fn new(identity: &WorkspaceIdentity) -> Result<Self, String> {
        identity.validate()?;
        Ok(Self {
            schema_version: SCHEMA_VERSION,
            workspace_id: identity.workspace_id.clone(),
            account_sub: identity.account_sub.clone(),
            folder_nonce: identity.folder_nonce.clone(),
            folder_id: None,
            folder_create_id: None,
            folder_create_dispatched: false,
            revision: 0,
            files: BTreeMap::new(),
            historical_versions: BTreeMap::new(),
            archive_anchors: BTreeMap::new(),
            remote_names: BTreeMap::new(),
            conflicts: BTreeMap::new(),
            pending_deletions: BTreeMap::new(),
            pending_renames: BTreeMap::new(),
            pending_uploads: BTreeMap::new(),
            pending_downloads: BTreeMap::new(),
        })
    }

    fn validate(&self, identity: &WorkspaceIdentity) -> Result<(), String> {
        identity.validate()?;
        if self.schema_version != SCHEMA_VERSION || self.workspace_id != identity.workspace_id ||
            self.account_sub != identity.account_sub || self.folder_nonce != identity.folder_nonce {
            return Err("Drive manifest identity does not match the active workspace".into());
        }
        if self.folder_id.as_deref().is_some_and(|id| !safe_remote_id(id)) ||
            self.folder_create_id.as_deref().is_some_and(|id| !safe_remote_id(id)) ||
            (self.folder_id.is_some() && (self.folder_create_dispatched || self.folder_create_id.is_some())) ||
            self.files.keys().any(|name| !sync::is_safe_filename(name)) ||
            self.historical_versions.iter().any(|(id, digest)| !safe_remote_id(id) || digest.is_empty()) ||
            self.archive_anchors.iter().any(|(id, anchor)| !safe_remote_id(id) ||
                !safe_remote_id(anchor) || !self.files.values().any(|file| file.drive_id == *id) ||
                !self.historical_versions.contains_key(anchor)) ||
            self.remote_names.iter().any(|(local, remote)| !self.files.contains_key(local) ||
                !sync::is_safe_filename(remote)) ||
            self.conflicts.iter().any(|(local, original)| !self.files.contains_key(local) ||
                !sync::is_safe_filename(original)) ||
            self.pending_deletions.keys().any(|name| !sync::is_safe_filename(name)) ||
            self.pending_renames.iter().any(|(name, previous)|
                !sync::is_safe_filename(name) || !sync::is_safe_filename(previous) ||
                name == previous || !self.files.contains_key(name)) ||
            self.files.values().any(|file| !safe_remote_id(&file.drive_id) || file.digest.trim().is_empty() || file.note_id.trim().is_empty()) ||
            self.pending_deletions.values().any(|deletion| !safe_remote_id(&deletion.drive_id) || deletion.note_id.trim().is_empty()) {
            return Err("Drive manifest contains an invalid remote identity".into());
        }
        if self.pending_uploads.iter().any(|(name, intent)|
            !sync::is_safe_filename(name) || intent.note_id.is_empty() || intent.digest.is_empty() ||
            intent.remote_id.as_deref().is_some_and(|id| !safe_remote_id(id)) ||
            intent.previous_id.as_deref().is_some_and(|id| !safe_remote_id(id)) ||
            self.pending_deletions.contains_key(name) ||
            (self.files.contains_key(name) != intent.previous_id.is_some()) ||
            intent.previous_id.as_deref().is_some_and(|id|
                self.files.get(name).is_none_or(|file| file.drive_id != id))) ||
            self.pending_downloads.iter().any(|(remote_id, intent)|
                !safe_remote_id(remote_id) || !sync::is_safe_filename(&intent.name) ||
                intent.note_id.is_empty() || intent.digest.is_empty() ||
                self.files.contains_key(&intent.name) ||
                self.files.values().any(|file| file.drive_id == *remote_id)) {
            return Err("Drive manifest contains an inconsistent create intent".into());
        }
        let mut download_names = std::collections::HashSet::new();
        if self.pending_downloads.values().any(|intent| !download_names.insert(intent.name.as_str())) {
            return Err("Drive manifest contains duplicate download targets".into());
        }
        if self.pending_uploads.iter().any(|(name, intent)|
            self.files.iter().any(|(mapped_name, file)| file.note_id == intent.note_id &&
                (mapped_name != name || intent.previous_id.as_deref() != Some(file.drive_id.as_str())))) ||
            self.pending_downloads.values().any(|intent|
                self.files.values().any(|file| file.note_id == intent.note_id) ||
                self.pending_uploads.values().any(|upload| upload.note_id == intent.note_id)) {
            return Err("Drive manifest duplicates a pending note identity".into());
        }
        let mut remote_ids = std::collections::HashSet::new();
        let mut note_ids = std::collections::HashSet::new();
        if self.files.values().any(|file| !remote_ids.insert(file.drive_id.as_str()) || !note_ids.insert(file.note_id.as_str())) {
            return Err("Drive manifest maps a note or remote file more than once".into());
        }
        if self.pending_deletions.values().any(|deletion| remote_ids.contains(deletion.drive_id.as_str())) {
            return Err("Drive manifest would delete an active remote note".into());
        }
        let mut deletion_ids = std::collections::HashSet::new();
        if self.pending_deletions.values().any(|deletion| !deletion_ids.insert(deletion.drive_id.as_str())) {
            return Err("Drive manifest duplicates a remote deletion target".into());
        }
        Ok(())
    }

    pub fn confirm_folder(&mut self, folder_id: &str) -> Result<(), String> {
        if !safe_remote_id(folder_id) { return Err("Remote folder has an invalid ID".into()); }
        match self.folder_id.as_deref() {
            Some(existing) if existing != folder_id =>
                Err("Remote folder identity changed; manual repair is required".into()),
            _ => { self.folder_id = Some(folder_id.to_string()); Ok(()) }
        }
    }
}

fn manifest_path(notes_dir: &Path) -> PathBuf { notes_dir.join(FILE_NAME) }

fn save_locked(
    notes_dir: &Path,
    identity: &WorkspaceIdentity,
    expected_revision: u64,
    mut next: WorkspaceManifest,
    _guard: &tokio::sync::MutexGuard<'_, ()>,
) -> Result<WorkspaceManifest, String> {
    next.validate(identity)?;
    let actual = load(notes_dir, identity)?;
    if actual.revision != expected_revision {
        return Err("Drive manifest changed during synchronization; retry required".into());
    }
    if actual.folder_id.is_some() && actual.folder_id != next.folder_id {
        return Err("Drive folder identity changed during synchronization".into());
    }
    next.revision = expected_revision.checked_add(1).ok_or("Drive manifest revision overflow")?;
    let path = manifest_path(notes_dir);
    let bytes = serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?;
    if path.exists() {
        let backup = path.with_extension("json.bak");
        let prior = serde_json::to_vec_pretty(&actual).map_err(|error| error.to_string())?;
        paths::write_atomic(&backup, &prior)?;
    }
    paths::write_atomic(&path, &bytes)?;
    Ok(next)
}

fn read_existing(path: &Path, identity: &WorkspaceIdentity) -> Result<Option<WorkspaceManifest>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => return Err("Drive manifest is not a regular file".into()),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect Drive manifest: {error}")),
    }
    let bytes = fs::read(path).map_err(|error| format!("Cannot read Drive manifest: {error}"))?;
    let manifest: WorkspaceManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "Drive manifest is corrupt; synchronization is blocked".to_string())?;
    manifest.validate(identity)?;
    Ok(Some(manifest))
}

/// A damaged primary blocks mutations even if a valid backup exists. The
/// backup may predate a tombstone or upload; silently using it would resurrect
/// an obsolete state. Both files are retained for explicit recovery.
pub fn load(notes_dir: &Path, identity: &WorkspaceIdentity) -> Result<WorkspaceManifest, String> {
    sync::ensure_safe_base_dir(notes_dir)?;
    let primary = manifest_path(notes_dir);
    match read_existing(&primary, identity) {
        Ok(Some(manifest)) => Ok(manifest),
        Ok(None) => {
            let backup = primary.with_extension("json.bak");
            match read_existing(&backup, identity)? {
                Some(_) => Err("Drive manifest primary is missing while a backup exists; manual repair is required".into()),
                None => WorkspaceManifest::new(identity),
            }
        }
        Err(primary_error) => {
            let backup = primary.with_extension("json.bak");
            if read_existing(&backup, identity)?.is_some() {
                Err(format!("{primary_error}; a valid backup exists but requires explicit recovery"))
            } else {
                Err(primary_error)
            }
        }
    }
}

/// Compare-and-swap under the F3 critical section and manifest lock. A stale
/// HTTP result cannot replace a newer tombstone or folder identity.
pub async fn commit<F>(
    notes_dir: &Path,
    identity: &WorkspaceIdentity,
    expected_revision: u64,
    next: WorkspaceManifest,
    permit: &SyncPermit<'_>,
    current: F,
) -> Result<WorkspaceManifest, String>
where F: Fn() -> Result<SyncRequest, String> {
    next.validate(identity)?;
    permit.effect(current, || async {
        let _manifest = MANIFEST_LOCK.lock().await;
        save_locked(notes_dir, identity, expected_revision, next, &_manifest)
    }).await
}

/// Records an intentional deletion in the F4 manifest before removing the
/// local note. The caller holds MANIFEST_LOCK, which also serializes workspace
/// transitions. A remote tombstone is created only for the exact note and
/// remote ID already recorded in this workspace's manifest.
pub fn delete_local_note(
    ctx: &Ctx,
    request: &SyncRequest,
    file_name: &str,
    manifest_guard: &tokio::sync::MutexGuard<'_, ()>,
) -> Result<(), String> {
    let (identity, notes_dir) = resolve_identity(ctx, request)?;
    let path = sync::resolve_safe_path(&notes_dir, file_name)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| format!("Cannot inspect note for deletion: {error}"))?;
    if !metadata.is_file() { return Err("Only regular notes can be deleted".into()); }
    provenance::invalidate_changed_note(&notes_dir, file_name)?;
    let note_id = provenance::load_ledger(&provenance::get_ledger_path(&notes_dir))?
        .and_then(|ledger| ledger.by_name.get(file_name).cloned());
    let mut manifest = load(&notes_dir, &identity)?;
    if manifest.pending_uploads.contains_key(file_name) ||
        manifest.pending_downloads.values().any(|intent| intent.name == file_name) {
        return Err("Note has a pending Drive creation; resolve it before deletion".into());
    }
    let baseline = manifest.revision;
    if let Some(file) = manifest.files.remove(file_name) {
        manifest.archive_anchors.remove(&file.drive_id);
        if note_id.as_deref() == Some(file.note_id.as_str()) {
            manifest.pending_deletions.insert(file_name.to_string(), WorkspaceTombstone {
                drive_id: file.drive_id, note_id: file.note_id,
            });
        }
        manifest.remote_names.remove(file_name);
        manifest.conflicts.remove(file_name);
        save_locked(&notes_dir, &identity, baseline, manifest, manifest_guard)?;
    }
    provenance::retire_note(&notes_dir, file_name)?;
    fs::remove_file(&path).map_err(|error| format!("Cannot delete local note: {error}"))
}

/// Complete a local rename after the file and provenance ledger have moved.
/// A crash before this write is recovered by the content runner using the
/// stable note ID; a remote rename is recorded as a separate pending effect.
pub fn record_local_rename(
    notes_dir: &Path,
    identity: &WorkspaceIdentity,
    old_name: &str,
    new_name: &str,
    manifest_guard: &tokio::sync::MutexGuard<'_, ()>,
) -> Result<(), String> {
    let mut manifest = load(notes_dir, identity)?;
    if manifest.pending_uploads.contains_key(old_name) ||
        manifest.pending_downloads.values().any(|intent| intent.name == old_name || intent.name == new_name) {
        return Err("Note has a pending Drive creation; resolve it before rename".into());
    }
    let Some(file) = manifest.files.get(old_name).cloned() else { return Ok(()); };
    if manifest.files.contains_key(new_name) || manifest.pending_deletions.contains_key(new_name) {
        return Err("Renamed note conflicts with a Drive mapping".into());
    }
    let ledger = provenance::load_ledger(&provenance::get_ledger_path(notes_dir))?
        .ok_or("Missing note identity after rename")?;
    if ledger.by_name.get(new_name) != Some(&file.note_id) ||
        ledger.by_name.contains_key(old_name) || notes_dir.join(old_name).exists() ||
        !sync::resolve_safe_path(notes_dir, new_name)?.is_file() {
        return Err("Renamed note identity was not confirmed".into());
    }
    let revision = manifest.revision;
    let remote_name = manifest.pending_renames.remove(old_name).unwrap_or_else(|| old_name.to_string());
    let aliased = manifest.remote_names.contains_key(old_name);
    manifest.files.remove(old_name);
    manifest.files.insert(new_name.to_string(), file);
    if let Some(remote_name) = manifest.remote_names.remove(old_name) {
        manifest.remote_names.insert(new_name.to_string(), remote_name);
    }
    // Renaming a conflict copy is an explicit choice to keep it as a
    // separately named local note. Its remote object remains untouched.
    manifest.conflicts.remove(old_name);
    if !aliased && new_name != remote_name {
        manifest.pending_renames.insert(new_name.to_string(), remote_name);
    }
    save_locked(notes_dir, identity, revision, manifest, manifest_guard)?;
    Ok(())
}

/// Preflight for an irreversible remote trash operation. The caller must also
/// hold a deletion lease across this check and HTTP so a later local mutation
/// cannot invalidate the tombstone between validation and transmission.
#[allow(dead_code)] // Remote deletion stays paused until the lease is attached.
pub fn tombstone_ready(
    notes_dir: &Path,
    identity: &WorkspaceIdentity,
    file_name: &str,
    tombstone: &WorkspaceTombstone,
    remote_id_in_bound_folder: &str,
    _manifest_guard: &tokio::sync::MutexGuard<'_, ()>,
) -> Result<bool, String> {
    let note_path = sync::resolve_safe_path(notes_dir, file_name)?;
    if note_path.exists() || tombstone.drive_id != remote_id_in_bound_folder { return Ok(false); }
    let manifest = load(notes_dir, identity)?;
    if manifest.folder_id.is_none() || manifest.pending_deletions.get(file_name) != Some(tombstone) {
        return Ok(false);
    }
    let ledger = provenance::load_ledger(&provenance::get_ledger_path(notes_dir))?
        .ok_or("Missing note identity ledger for remote deletion")?;
    let Some(note) = ledger.notes.get(&tombstone.note_id) else { return Ok(false); };
    Ok(note.retired && note.name == file_name &&
        ledger.by_name.get(file_name) != Some(&tombstone.note_id))
}

/// Each HTTP operation has its own F3 checkpoint. If a create succeeds but
/// the process stops before the manifest commit, the next attempt searches by
/// the same nonce and recovers the folder without name-based adoption.
#[allow(dead_code)] // Attached by the F4 remote runner after all effects are audited.
pub async fn resolve_folder<F>(
    notes_dir: &Path,
    identity: &WorkspaceIdentity,
    manifest: WorkspaceManifest,
    client: &DriveClient,
    token: &str,
    permit: &SyncPermit<'_>,
    current: F,
) -> Result<WorkspaceManifest, String>
where F: Fn() -> Result<SyncRequest, String> {
    manifest.validate(identity)?;
    let found = permit.effect(|| current(), || client.find_workspace_folder(token, &identity.folder_nonce)).await?;
    let id = match found {
        Some(id) => {
            if manifest.folder_create_id.as_deref().is_some_and(|planned| planned != id) {
                return Err("Remote folder conflicts with the planned Drive ID".into());
            }
            id
        }
        None if manifest.folder_id.is_some() =>
            return Err("Previously bound remote folder is unavailable; manual repair is required".into()),
        None if manifest.folder_create_dispatched && manifest.folder_create_id.is_none() =>
            return Err("Legacy folder creation outcome is uncertain; do not create a duplicate".into()),
        None => {
            let prepared = if manifest.folder_create_id.is_some() {
                manifest.clone()
            } else {
                let planned_id = permit.effect(|| current(), || client.generate_file_id(token)).await?;
                let mut next = manifest.clone();
                next.folder_create_id = Some(planned_id);
                commit(notes_dir, identity, manifest.revision, next, permit, || current()).await?
            };
            let dispatched = if prepared.folder_create_dispatched {
                prepared
            } else {
                let mut next = prepared.clone();
                next.folder_create_dispatched = true;
                commit(notes_dir, identity, prepared.revision, next, permit, || current()).await?
            };
            let planned_id = dispatched.folder_create_id.as_deref().ok_or("Missing planned folder ID")?;
            let created = permit.effect(|| current(), || client.create_workspace_folder_with_id(
                token, &identity.workspace_id, &identity.folder_nonce, planned_id)).await?;
            if created.is_none() {
                match permit.effect(|| current(), || client.check_file_status(token, planned_id)).await? {
                    RemoteFileStatus::Active(file) if file.id == planned_id &&
                        file.mime_type.as_deref() == Some("application/vnd.google-apps.folder") &&
                        file.app_properties.get("lyra_workspace_nonce") == Some(&identity.folder_nonce) => {},
                    _ => return Err("Existing folder ID cannot be verified for this workspace".into()),
                }
            }
            let mut confirmed = dispatched.clone();
            confirmed.confirm_folder(planned_id)?;
            confirmed.folder_create_id = None;
            confirmed.folder_create_dispatched = false;
            return commit(notes_dir, identity, dispatched.revision, confirmed, permit, current).await;
        }
    };
    let mut next = manifest.clone();
    next.confirm_folder(&id)?;
    next.folder_create_id = None;
    next.folder_create_dispatched = false;
    if next == manifest { return Ok(manifest); }
    commit(notes_dir, identity, manifest.revision, next, permit, current).await
}

/// Remote listing is read-only, but the response must still be discarded if
/// its workspace owner was cancelled before the HTTP request completed.
#[allow(dead_code)] // Attached by the F4 remote runner after all effects are audited.
pub async fn fetch_remote_index<F>(
    manifest: &WorkspaceManifest,
    client: &DriveClient,
    token: &str,
    permit: &SyncPermit<'_>,
    current: F,
) -> Result<Vec<DriveFileMetadata>, String>
where F: Fn() -> Result<SyncRequest, String> {
    let folder_id = manifest.folder_id.as_deref().ok_or("Workspace has no confirmed remote folder")?;
    permit.effect(current, || client.list_files_in_folder(token, folder_id)).await
}

/// Resolve a persisted deletion only for the exact retired note and remote ID
/// in the workspace's confirmed folder. EFFECT_LOCK remains held across the
/// preflight and HTTP call, while MANIFEST_LOCK is used only for short local
/// reads and commits. A failed commit leaves the tombstone for a safe retry.
#[allow(dead_code)] // The production sync gate remains closed during F4.
pub async fn flush_tombstone<F>(
    notes_dir: &Path,
    identity: &WorkspaceIdentity,
    file_name: &str,
    client: &DriveClient,
    token: &str,
    permit: &SyncPermit<'_>,
    current: F,
) -> Result<bool, String>
where F: Fn() -> Result<SyncRequest, String> {
    let _lease = EFFECT_LOCK.lock().await;
    let (manifest, tombstone, folder_id) = {
        let _guard = MANIFEST_LOCK.lock().await;
        let manifest = load(notes_dir, identity)?;
        let Some(tombstone) = manifest.pending_deletions.get(file_name).cloned() else { return Ok(false); };
        let folder_id = manifest.folder_id.clone().ok_or("Workspace has no confirmed remote folder")?;
        if !tombstone_ready(notes_dir, identity, file_name, &tombstone, &tombstone.drive_id, &_guard)? {
            return Err("Remote deletion tombstone is no longer valid".into());
        }
        (manifest, tombstone, folder_id)
    };
    let remote = permit.effect(|| current(), || client.list_files_in_folder(token, &folder_id)).await?;
    if remote.iter().filter(|file| file.id == tombstone.drive_id).count() > 1 {
        return Err("Remote deletion identity appears more than once".into());
    }
    if remote.iter().any(|file| file.id == tombstone.drive_id) {
        {
            let _guard = MANIFEST_LOCK.lock().await;
            if !tombstone_ready(notes_dir, identity, file_name, &tombstone, &tombstone.drive_id, &_guard)? {
                return Err("Remote deletion tombstone changed before HTTP".into());
            }
        }
        // Folder membership can change after listing and before PATCH. Do
        // not trash a file that another client may have moved elsewhere.
        return Err("SyncPaused: remote trash has no verified folder precondition".into());
    } else {
        match permit.effect(|| current(), || client.check_file_status(token, &tombstone.drive_id)).await? {
            RemoteFileStatus::Trashed | RemoteFileStatus::NotFound => {},
            RemoteFileStatus::Forbidden => return Err("Cannot verify remote deletion target".into()),
            RemoteFileStatus::Active(_) => return Err("Remote deletion target is outside the bound folder".into()),
        }
    }
    let mut next = manifest.clone();
    next.pending_deletions.remove(file_name);
    commit(notes_dir, identity, manifest.revision, next, permit, current).await?;
    Ok(true)
}

#[cfg(test)]
mod tests;

pub mod content;
