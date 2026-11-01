//! Content synchronization for a verified Drive workspace. The legacy
//! account-wide engine is never called from this module.

use super::{load, resolve_folder, save_locked, flush_tombstone, DownloadIntent, UploadIntent, UploadPhase, WorkspaceFile, WorkspaceIdentity, EFFECT_LOCK, MANIFEST_LOCK};
use crate::gdrive::client::DriveClient;
use crate::gdrive::provenance;
use crate::gdrive::sync;
use crate::gdrive::types::{DriveFileMetadata, SyncResult};
use crate::workspaces::migration::Ctx;
use crate::workspaces::sync_context::{self, SyncPermit, SyncRequest};
use md5::{Digest, Md5};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn digest(bytes: &[u8]) -> String { format!("{:x}", Md5::digest(bytes)) }

#[derive(Clone)]
struct LocalSnapshot {
    note_id: String,
    bytes: Vec<u8>,
    digest: String,
}

/// The caller supplies an account check that reads the verified, workspace
/// scoped credential and captured auth epoch. Tests replace only that check;
/// the workspace and F3 owner checks always run against Rust state.
pub struct ContentSession<'a, A: Fn() -> Result<(), String>> {
    ctx: &'a Ctx,
    request: SyncRequest,
    identity: WorkspaceIdentity,
    notes_dir: PathBuf,
    account_valid: A,
    client: &'a DriveClient,
    permit: &'a SyncPermit<'a>,
}

impl<'a, A: Fn() -> Result<(), String>> ContentSession<'a, A> {
    pub fn new(
        ctx: &'a Ctx, request: SyncRequest, account_valid: A,
        client: &'a DriveClient, permit: &'a SyncPermit<'a>,
    ) -> Result<Self, String> {
        account_valid()?;
        let (identity, notes_dir) = super::resolve_identity(ctx, &request)?;
        permit.still_valid(&request)?;
        Ok(Self { ctx, request, identity, notes_dir, account_valid, client, permit })
    }

    fn current(&self) -> Result<SyncRequest, String> {
        (self.account_valid)()?;
        let current = sync_context::current(&self.ctx.documents, &self.ctx.config)?;
        if current != self.request { return Err("SyncStale: workspace epoch changed".into()); }
        let (identity, dir) = super::resolve_identity(self.ctx, &current)?;
        if identity != self.identity || dir != self.notes_dir {
            return Err("SyncStale: Drive workspace binding changed".into());
        }
        Ok(current)
    }

    fn local_snapshot_locked(&self, name: &str) -> Result<Option<LocalSnapshot>, String> {
        let path = sync::resolve_safe_path(&self.notes_dir, name)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Cannot inspect local note: {error}")),
        };
        if !metadata.is_file() { return Err("Local note is not a regular file".into()); }
        provenance::invalidate_changed_note(&self.notes_dir, name)?;
        provenance::record_local_write(&self.notes_dir, name, None, false)?;
        let ledger = provenance::load_ledger(&provenance::get_ledger_path(&self.notes_dir))?
            .ok_or("Missing local note identity ledger")?;
        let note_id = ledger.by_name.get(name).ok_or("Missing local note ID")?.clone();
        let (bytes, current_digest, _, _) = sync::read_file_snapshot(&path, 0)
            .map_err(|error| format!("Cannot read local note: {error}"))?;
        Ok(Some(LocalSnapshot { note_id, bytes, digest: current_digest }))
    }

    async fn snapshot(&self, name: &str) -> Result<Option<LocalSnapshot>, String> {
        self.permit.effect(|| self.current(), || async {
            let _guard = MANIFEST_LOCK.lock().await;
            sync::get_file_lock_coordinator().with_file_lock(name, || self.local_snapshot_locked(name))
        }).await
    }

    fn verify_remote(&self, remote: &DriveFileMetadata) -> Result<(), String> {
        if !super::safe_remote_id(&remote.id) || remote.trashed == Some(true) ||
            !sync::is_safe_filename(&remote.name) ||
            !(remote.name.ends_with(".txt") || remote.name.ends_with(".md")) ||
            !matches!(remote.mime_type.as_deref(),
                Some("text/plain" | "text/markdown" | "application/octet-stream")) {
            return Err("Remote note has an unsafe identity, name or type".into());
        }
        if let Some(nonce) = remote.app_properties.get("lyra_workspace_nonce") {
            if nonce != &self.identity.folder_nonce {
                return Err("Foreign workspace note was moved into this folder".into());
            }
        }
        Ok(())
    }

    fn index_remote(&self, files: Vec<DriveFileMetadata>) -> Result<BTreeMap<String, DriveFileMetadata>, String> {
        let mut index = BTreeMap::new();
        for file in files {
            self.verify_remote(&file)?;
            if index.insert(file.id.clone(), file).is_some() {
                return Err("Remote folder returned a duplicate file ID".into());
            }
        }
        Ok(index)
    }

    async fn reconcile_interrupted_local_renames(&self) -> Result<(), String> {
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            let ledger = provenance::load_ledger(&provenance::get_ledger_path(&self.notes_dir))?
                .unwrap_or_default();
            let mut changed = false;
            for (old_name, file) in manifest.files.clone() {
                if self.notes_dir.join(&old_name).exists() { continue; }
                let Some((new_name, _)) = ledger.by_name.iter().find(|(name, id)|
                    **id == file.note_id && **name != old_name) else { continue };
                if manifest.files.contains_key(new_name) ||
                    manifest.pending_deletions.contains_key(new_name) ||
                    !sync::resolve_safe_path(&self.notes_dir, new_name)?.is_file() {
                    return Err("Interrupted local rename is ambiguous".into());
                }
                let previous = manifest.pending_renames.remove(&old_name)
                    .unwrap_or_else(|| old_name.clone());
                let aliased = manifest.remote_names.contains_key(&old_name);
                manifest.files.remove(&old_name);
                manifest.files.insert(new_name.clone(), file);
                if let Some(remote_name) = manifest.remote_names.remove(&old_name) {
                    manifest.remote_names.insert(new_name.clone(), remote_name);
                }
                manifest.conflicts.remove(&old_name);
                if !aliased && new_name != &previous {
                    manifest.pending_renames.insert(new_name.clone(), previous);
                }
                changed = true;
            }
            if changed {
                let revision = manifest.revision;
                save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
            }
            Ok(())
        }).await
    }

    async fn commit_file(
        &self, name: &str, expected: Option<&WorkspaceFile>, next_file: WorkspaceFile,
    ) -> Result<(), String> {
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.get(name) != expected { return Err("Drive mapping changed during HTTP".into()); }
            if manifest.pending_deletions.values().any(|item| item.drive_id == next_file.drive_id) {
                return Err("Drive mapping conflicts with a deletion tombstone".into());
            }
            let revision = manifest.revision;
            manifest.files.insert(name.to_string(), next_file);
            save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
            Ok(())
        }).await
    }

    async fn prepare_upload(&self, name: &str, snapshot: &LocalSnapshot,
        previous: Option<&WorkspaceFile>) -> Result<UploadIntent, String> {
        let planned_id = if load(&self.notes_dir, &self.identity)?.pending_uploads.contains_key(name) {
            None
        } else {
            Some(self.permit.effect(|| self.current(), || self.client.generate_file_id("")).await?)
        };
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.get(name) != previous || manifest.pending_deletions.contains_key(name) ||
                manifest.pending_downloads.values().any(|item| item.name == name) {
                return Err("Note already has a Drive mapping or tombstone".into());
            }
            let latest = sync::get_file_lock_coordinator().with_file_lock(name,
                || self.local_snapshot_locked(name))?.ok_or("Local note vanished before upload intent")?;
            if latest.note_id != snapshot.note_id || latest.digest != snapshot.digest {
                return Err("Local note changed before upload intent".into());
            }
            if let Some(existing) = manifest.pending_uploads.get(name) {
                if existing.note_id != snapshot.note_id || existing.digest != snapshot.digest ||
                    existing.previous_id.as_deref() != previous.map(|file| file.drive_id.as_str()) {
                    return Err("Pending upload identity or content changed; manual resolution is required".into());
                }
                return Ok(existing.clone());
            }
            let intent = UploadIntent { note_id: snapshot.note_id.clone(),
                digest: snapshot.digest.clone(), phase: UploadPhase::Prepared,
                remote_id: planned_id, previous_id: previous.map(|file| file.drive_id.clone()) };
            let revision = manifest.revision;
            manifest.pending_uploads.insert(name.to_string(), intent.clone());
            save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
            Ok(intent)
        }).await
    }

    async fn dispatch_upload(&self, name: &str, expected: &UploadIntent) -> Result<(), String> {
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.pending_uploads.get(name) != Some(expected) ||
                expected.phase != UploadPhase::Prepared {
                return Err("Upload intent changed before HTTP".into());
            }
            let revision = manifest.revision;
            manifest.pending_uploads.get_mut(name).ok_or("Missing upload intent")?.phase = UploadPhase::Dispatched;
            save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
            Ok(())
        }).await
    }

    async fn commit_upload(&self, name: &str, snapshot: &LocalSnapshot,
        remote: &DriveFileMetadata, previous: Option<&WorkspaceFile>) -> Result<(), String> {
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            let intent = manifest.pending_uploads.get(name).ok_or("Missing upload intent")?;
            if intent.note_id != snapshot.note_id || intent.digest != snapshot.digest ||
                intent.remote_id.as_deref().is_some_and(|id| id != remote.id) ||
                manifest.files.get(name) != previous ||
                intent.previous_id.as_deref() != previous.map(|file| file.drive_id.as_str()) {
                return Err("Upload intent or mapping changed during HTTP".into());
            }
            let revision = manifest.revision;
            manifest.pending_uploads.remove(name);
            if let Some(old) = previous {
                manifest.historical_versions.insert(old.drive_id.clone(), old.digest.clone());
                manifest.remote_names.remove(name);
                let anchor = manifest.archive_anchors.remove(&old.drive_id)
                    .unwrap_or_else(|| old.drive_id.clone());
                manifest.archive_anchors.insert(remote.id.clone(), anchor);
            }
            manifest.files.insert(name.to_string(), WorkspaceFile {
                drive_id: remote.id.clone(), digest: snapshot.digest.clone(),
                note_id: snapshot.note_id.clone(),
            });
            save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
            Ok(())
        }).await
    }

    async fn upload_new(&self, name: &str, snapshot: LocalSnapshot,
        index: &BTreeMap<String, DriveFileMetadata>, previous: Option<&WorkspaceFile>) -> Result<bool, String> {
        let _lease = EFFECT_LOCK.lock().await;
        let existing_manifest = load(&self.notes_dir, &self.identity)?;
        if index.values().any(|remote| remote.name == name &&
            previous.is_none_or(|file| remote.id != file.drive_id &&
                remote.app_properties.get("lyra_note_id") != Some(&snapshot.note_id))) {
            return Err("Remote name collision requires explicit resolution before upload".into());
        }
        if previous.is_none() && !existing_manifest.pending_uploads.contains_key(name) && index.values().any(|remote|
            remote.app_properties.get("lyra_note_id") == Some(&snapshot.note_id)) {
            return Err("Remote note identity has no durable upload intent".into());
        }
        let before_http = self.snapshot(name).await?.ok_or("Local note vanished before upload")?;
        if before_http.note_id != snapshot.note_id || before_http.digest != snapshot.digest {
            return Err("Local note changed before upload".into());
        }
        let intent = self.prepare_upload(name, &snapshot, previous).await?;
        let candidates: Vec<_> = index.values().filter(|remote|
            intent.remote_id.as_deref().map_or_else(
                || remote.app_properties.get("lyra_note_id") == Some(&snapshot.note_id),
                |id| remote.id == id)).collect();
        if candidates.len() > 1 { return Err("Duplicate remote note identity".into()); }
        let remote = if let Some(remote) = candidates.first() {
            if remote.app_properties.get("lyra_workspace_nonce") != Some(&self.identity.folder_nonce) ||
                remote.app_properties.get("lyra_note_id") != Some(&snapshot.note_id) ||
                remote.name != name || remote.md5_checksum.as_deref() != Some(&snapshot.digest) ||
                previous.is_some_and(|file| remote.app_properties.get("lyra_previous_id") != Some(&file.drive_id)) {
                return Err("Interrupted upload has diverged; manual resolution is required".into());
            }
            (*remote).clone()
        } else {
            if index.values().any(|remote| remote.name == name &&
                previous.is_none_or(|file| remote.id != file.drive_id &&
                    remote.app_properties.get("lyra_note_id") != Some(&snapshot.note_id))) {
                return Err("Remote name collision requires preservation before upload".into());
            }
            if intent.remote_id.is_none() {
                return Err("Upload outcome is uncertain; keep the intent and do not create a duplicate".into());
            }
            let manifest = load(&self.notes_dir, &self.identity)?;
            let folder = manifest.folder_id.as_deref().ok_or("Missing bound Drive folder")?;
            let now = chrono::Utc::now().to_rfc3339();
            if intent.phase == UploadPhase::Prepared { self.dispatch_upload(name, &intent).await?; }
            let remote_id = intent.remote_id.as_deref().ok_or("Missing planned Drive ID")?;
            let created = self.permit.effect(|| self.current(), || self.client.upload_workspace_file_with_id(
                "", folder, name, &snapshot.bytes, &now,
                &self.identity.folder_nonce, &snapshot.note_id, remote_id,
                previous.map(|file| file.drive_id.as_str()))).await?;
            let uploaded = match created {
                Some(file) => file,
                None => match self.permit.effect(|| self.current(), || self.client.check_file_status("", remote_id)).await? {
                    crate::gdrive::client::RemoteFileStatus::Active(file) => file,
                    _ => return Err("Existing Drive ID cannot be verified after upload conflict".into()),
                },
            };
            if uploaded.name != name || !super::safe_remote_id(&uploaded.id) ||
                uploaded.id != remote_id || uploaded.parents.len() != 1 || uploaded.parents[0] != folder ||
                uploaded.app_properties.get("lyra_workspace_nonce") != Some(&self.identity.folder_nonce) ||
                uploaded.app_properties.get("lyra_note_id") != Some(&snapshot.note_id) ||
                previous.is_some_and(|file| uploaded.app_properties.get("lyra_previous_id") != Some(&file.drive_id)) ||
                uploaded.md5_checksum.as_deref() != Some(snapshot.digest.as_str()) {
                return Err("Drive did not confirm the uploaded note identity".into());
            }
            uploaded
        };
        let folder_id = load(&self.notes_dir, &self.identity)?.folder_id.ok_or("Missing bound Drive folder")?;
        if remote.parents.len() != 1 || remote.parents[0] != folder_id {
            return Err("Uploaded note is outside its bound Drive folder".into());
        }
        let current = self.snapshot(name).await?.ok_or("Local note vanished after upload")?;
        if current.note_id != snapshot.note_id {
            return Err("Local note identity changed after upload; retry required".into());
        }
        self.commit_upload(name, &snapshot, &remote, previous).await?;
        Ok(true)
    }

    async fn download_mapped(&self, name: &str, item: &WorkspaceFile,
        snapshot: Option<LocalSnapshot>, remote: &DriveFileMetadata) -> Result<Option<String>, String> {
        self.verify_remote(remote)?;
        if remote.id != item.drive_id &&
            (remote.app_properties.get("lyra_previous_id") != Some(&item.drive_id) ||
             remote.app_properties.get("lyra_note_id") != Some(&item.note_id) ||
             remote.app_properties.get("lyra_workspace_nonce") != Some(&self.identity.folder_nonce)) {
            return Err("Remote version is not a verified successor".into());
        }
        let snapshot = snapshot.ok_or("Mapped local note is missing; manual recovery is required")?;
        let _lease = EFFECT_LOCK.lock().await;
        let bytes = self.permit.effect(|| self.current(), || self.client.download_file("", &remote.id)).await?;
        let remote_digest = digest(&bytes);
        if remote.md5_checksum.as_deref().is_some_and(|expected| expected != remote_digest) {
            return Err("Remote note changed during download".into());
        }
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.get(name) != Some(item) { return Err("Drive mapping changed during download".into()); }
            let path = sync::resolve_safe_path(&self.notes_dir, name)?;
            sync::get_file_lock_coordinator().with_file_lock(name, || {
                let latest = self.local_snapshot_locked(name)?;
                if latest.as_ref().map(|local| (&local.note_id, &local.digest)) !=
                    Some((&snapshot.note_id, &snapshot.digest)) {
                    return Err("Local note changed during download".into());
                }
                if snapshot.note_id != item.note_id { return Err("Local note identity changed".into()); }
                if snapshot.digest != item.digest && snapshot.digest != remote_digest {
                    return Err("Concurrent local and remote edits require manual resolution".into());
                }
                sync::write_file_atomic(&path, &bytes).map_err(|error| format!("Cannot persist downloaded note: {error}"))?;
                provenance::record_local_write(&self.notes_dir, name, None, false)?;
                let ledger = provenance::load_ledger(&provenance::get_ledger_path(&self.notes_dir))?
                    .ok_or("Missing note ledger after download")?;
                let new_note_id = ledger.by_name.get(name).ok_or("Missing downloaded note ID")?.clone();
                let revision = manifest.revision;
                if remote.id != item.drive_id {
                    let anchor = manifest.archive_anchors.remove(&item.drive_id)
                        .unwrap_or_else(|| item.drive_id.clone());
                    manifest.archive_anchors.insert(remote.id.clone(), anchor);
                    manifest.historical_versions.insert(item.drive_id.clone(), item.digest.clone());
                }
                manifest.files.insert(name.to_string(), WorkspaceFile {
                    drive_id: remote.id.clone(), digest: remote_digest.clone(), note_id: new_note_id,
                });
                save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
                Ok(None)
            })
        }).await
    }

    async fn download_new(&self, remote: &DriveFileMetadata) -> Result<String, String> {
        self.verify_remote(remote)?;
        let _lease = EFFECT_LOCK.lock().await;
        let bytes = self.permit.effect(|| self.current(), || self.client.download_file("", &remote.id)).await?;
        let remote_digest = digest(&bytes);
        if remote.md5_checksum.as_deref().is_some_and(|expected| expected != remote_digest) {
            return Err("Remote note changed during download".into());
        }
        let intent = self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.values().any(|file| file.drive_id == remote.id) {
                return Err("Remote note was mapped during download".into());
            }
            if let Some(existing) = manifest.pending_downloads.get(&remote.id) {
                if existing.digest != remote_digest {
                    return Err("Pending download differs from remote content; manual resolution is required".into());
                }
                return Ok(existing.clone());
            }
            let name = if self.notes_dir.join(&remote.name).exists() ||
                manifest.files.contains_key(&remote.name) ||
                manifest.pending_uploads.contains_key(&remote.name) ||
                manifest.pending_downloads.values().any(|item| item.name == remote.name) {
                unique_conflict_name(&self.notes_dir, &remote.name, "Drive")?
            } else { remote.name.clone() };
            if manifest.pending_downloads.values().any(|item| item.name == name) {
                return Err("Download target is already reserved".into());
            }
            let intent = DownloadIntent { name, note_id: provenance::new_note_id(),
                digest: remote_digest.clone() };
            let revision = manifest.revision;
            manifest.pending_downloads.insert(remote.id.clone(), intent.clone());
            save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
            Ok(intent)
        }).await?;
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.pending_downloads.get(&remote.id) != Some(&intent) ||
                manifest.files.values().any(|file| file.drive_id == remote.id) {
                return Err("Download intent changed before local creation".into());
            }
            sync::get_file_lock_coordinator().with_file_lock(&intent.name, || {
                let path = sync::resolve_safe_path(&self.notes_dir, &intent.name)?;
                if path.exists() {
                    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                    let ledger = provenance::load_ledger(&provenance::get_ledger_path(&self.notes_dir))?
                        .ok_or("Missing note ledger for interrupted download")?;
                    if !metadata.is_file() || fs::read(&path).map_err(|error| error.to_string())? != bytes ||
                        ledger.by_name.get(&intent.name) != Some(&intent.note_id) {
                        return Err("Downloaded note target is ambiguous; manual resolution is required".into());
                    }
                } else {
                    provenance::create_local_note_with_id(&self.notes_dir, &intent.name, &bytes, &intent.note_id)?;
                }
                let ledger = provenance::load_ledger(&provenance::get_ledger_path(&self.notes_dir))?
                    .ok_or("Missing note ledger after download")?;
                if ledger.by_name.get(&intent.name) != Some(&intent.note_id) {
                    return Err("Downloaded note identity was not confirmed".into());
                }
                let revision = manifest.revision;
                manifest.pending_downloads.remove(&remote.id);
                manifest.files.insert(intent.name.clone(), WorkspaceFile {
                    drive_id: remote.id.clone(), digest: remote_digest, note_id: intent.note_id.clone(),
                });
                if intent.name != remote.name {
                    manifest.remote_names.insert(intent.name.clone(), remote.name.clone());
                    manifest.conflicts.insert(intent.name.clone(), remote.name.clone());
                }
                if !manifest.archive_anchors.values().any(|anchor| anchor == &remote.id) {
                    manifest.historical_versions.remove(&remote.id);
                }
                save_locked(&self.notes_dir, &self.identity, revision, manifest, &guard)?;
                Ok(intent.name.clone())
            })
        }).await
    }

    async fn flush_rename(&self, name: &str, previous: &str,
        remote: &DriveFileMetadata, index: &BTreeMap<String, DriveFileMetadata>)
        -> Result<DriveFileMetadata, String> {
        let _lease = EFFECT_LOCK.lock().await;
        let manifest = load(&self.notes_dir, &self.identity)?;
        let file = manifest.files.get(name).ok_or("Rename mapping disappeared")?;
        if manifest.pending_renames.get(name).map(String::as_str) != Some(previous) ||
            file.drive_id != remote.id {
            return Err("Rename intent changed".into());
        }
        let local = self.snapshot(name).await?.ok_or("Renamed local note is missing")?;
        if local.note_id != file.note_id { return Err("Renamed note identity changed".into()); }
        let updated = if remote.name == name {
            remote.clone()
        } else {
            if remote.name != previous || index.values().any(|item| item.id != remote.id && item.name == name) {
                return Err("Remote rename collision or unexpected remote name".into());
            }
            // A Drive client can move this ID after the folder listing. The
            // metadata PATCH would then rename an item outside this workspace.
            return Err("SyncPaused: remote rename has no verified folder precondition".into());
        };
        self.permit.effect(|| self.current(), || async {
            let guard = MANIFEST_LOCK.lock().await;
            let mut latest = load(&self.notes_dir, &self.identity)?;
            if latest.files.get(name) != Some(file) ||
                latest.pending_renames.get(name).map(String::as_str) != Some(previous) {
                return Err("Rename intent changed during HTTP".into());
            }
            let revision = latest.revision;
            latest.pending_renames.remove(name);
            save_locked(&self.notes_dir, &self.identity, revision, latest, &guard)?;
            Ok(())
        }).await?;
        Ok(updated)
    }

    async fn flush_pending_renames(&self,
        index: &mut BTreeMap<String, DriveFileMetadata>) -> Result<(), String> {
        let manifest = load(&self.notes_dir, &self.identity)?;
        for (name, previous) in &manifest.pending_renames {
            let file = manifest.files.get(name).ok_or("Rename has no mapping")?;
            let remote = index.get(&file.drive_id).ok_or("Renamed remote note is missing")?.clone();
            let updated = self.flush_rename(name, previous, &remote, index).await?;
            index.insert(updated.id.clone(), updated);
        }
        Ok(())
    }

    pub async fn run(&self) -> Result<SyncResult, String> {
        let _ = self.current()?;
        self.reconcile_interrupted_local_renames().await?;
        let manifest = load(&self.notes_dir, &self.identity)?;
        let manifest = resolve_folder(&self.notes_dir, &self.identity, manifest, self.client, "",
            self.permit, || self.current()).await?;
        let pending: Vec<String> = manifest.pending_deletions.keys().cloned().collect();
        let mut result = SyncResult::default();
        for name in pending {
            if flush_tombstone(&self.notes_dir, &self.identity, &name, self.client, "",
                self.permit, || self.current()).await? {
                result.deleted_remote.push(name);
            }
        }
        let manifest = load(&self.notes_dir, &self.identity)?;
        let mut remote = self.index_remote(super::fetch_remote_index(&manifest, self.client, "",
            self.permit, || self.current()).await?)?;
        self.flush_pending_renames(&mut remote).await?;
        let manifest = load(&self.notes_dir, &self.identity)?;
        for (name, item) in &manifest.files {
            let Some(remote_item) = remote.get(&item.drive_id) else {
                return Err("Mapped remote note is unavailable; local content is preserved".into());
            };
            if remote_item.name != *manifest.remote_names.get(name).unwrap_or(name) {
                return Err("Remote note rename requires reconciliation".into());
            }
            let local = self.snapshot(name).await?;
            if local.as_ref().is_some_and(|local| local.note_id != item.note_id) {
                return Err("Mapped local note identity changed; content is preserved".into());
            }
            let remote_digest = remote_item.md5_checksum.as_deref().ok_or("Drive omitted the note checksum")?;
            if local.as_ref().is_some_and(|local| local.digest == remote_digest) {
                if item.digest != remote_digest {
                    self.commit_file(name, Some(item), WorkspaceFile {
                        drive_id: item.drive_id.clone(), digest: remote_digest.into(), note_id: item.note_id.clone(),
                    }).await?;
                }
            } else if local.is_some() && local.as_ref().is_some_and(|snapshot| snapshot.digest != item.digest) {
                self.upload_new(name, local.unwrap(), &remote, Some(item)).await?;
                result.uploaded.push(name.clone());
            } else {
                if let Some(conflict) = self.download_mapped(name, item, local, remote_item).await? {
                    result.conflicts.push(conflict);
                }
                result.downloaded.push(name.clone());
            }
        }
        // A successful POST may have lost its response or been cancelled before
        // the manifest commit. Adopt it only through the exact workspace nonce,
        // local note ID, name and digest; equal content alone is insufficient.
        for name in local_note_names(&self.notes_dir)? {
            self.snapshot(&name).await?;
        }
        let ledger = provenance::load_ledger(&provenance::get_ledger_path(&self.notes_dir))?
            .unwrap_or_default();
        for remote_item in remote.values() {
            let Some(note_id) = remote_item.app_properties.get("lyra_note_id") else { continue };
            let manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.values().any(|file| file.drive_id == remote_item.id) { continue; }
            if manifest.historical_versions.contains_key(&remote_item.id) { continue; }
            let Some((name, _)) = ledger.by_name.iter().find(|(_, id)| *id == note_id) else { continue };
            if name != &remote_item.name { continue; }
            let Some(local) = self.snapshot(name).await? else { continue };
            if local.note_id == *note_id && remote_item.md5_checksum.as_deref() == Some(local.digest.as_str()) {
                if !manifest.pending_uploads.contains_key(name) {
                    if manifest.files.values().any(|file| file.note_id == *note_id) {
                        continue;
                    }
                    return Err("Remote note identity has no durable upload intent".into());
                }
                self.upload_new(name, local, &remote, None).await?;
            }
        }
        for remote_item in remote.values() {
            let manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.values().any(|file| file.drive_id == remote_item.id) ||
                manifest.pending_deletions.values().any(|item| item.drive_id == remote_item.id) {
                continue;
            }
            if let Some(expected) = manifest.historical_versions.get(&remote_item.id) {
                if remote_item.md5_checksum.as_deref() == Some(expected) { continue; }
            }
            if let (Some(previous_id), Some(note_id)) = (
                remote_item.app_properties.get("lyra_previous_id"),
                remote_item.app_properties.get("lyra_note_id")) {
                let successors = remote.values().filter(|candidate|
                    candidate.app_properties.get("lyra_previous_id") == Some(previous_id) &&
                    candidate.app_properties.get("lyra_note_id") == Some(note_id)).count();
                if successors == 1 {
                    if let Some((name, item)) = manifest.files.iter().find(|(_, item)|
                        item.drive_id == *previous_id && item.note_id == *note_id) {
                        let remote_name = manifest.remote_names.get(name).unwrap_or(name);
                        if remote_name == &remote_item.name &&
                            remote_item.parents.as_slice() == [manifest.folder_id.as_deref().ok_or("Missing bound folder")?] &&
                            remote_item.app_properties.get("lyra_workspace_nonce") == Some(&self.identity.folder_nonce) {
                            let local = self.snapshot(name).await?;
                            if local.as_ref().is_some_and(|snapshot|
                                snapshot.note_id == item.note_id && snapshot.digest == item.digest) {
                                self.download_mapped(name, item, local, remote_item).await?;
                                result.downloaded.push(name.clone());
                                continue;
                            }
                        }
                    }
                }
            }
            let name = self.download_new(remote_item).await?;
            if name != remote_item.name { result.conflicts.push(name.clone()); }
            result.downloaded.push(name);
        }
        self.flush_pending_renames(&mut remote).await?;
        let names = local_note_names(&self.notes_dir)?;
        for name in names {
            let manifest = load(&self.notes_dir, &self.identity)?;
            if manifest.files.contains_key(&name) { continue; }
            let Some(snapshot) = self.snapshot(&name).await? else { continue; };
            if self.upload_new(&name, snapshot, &remote, None).await? { result.uploaded.push(name); }
        }
        let current_manifest = load(&self.notes_dir, &self.identity)?;
        for name in current_manifest.conflicts.keys() {
            if !result.conflicts.contains(name) { result.conflicts.push(name.clone()); }
        }
        self.permit.effect(|| self.current(), || async { Ok(()) }).await?;
        Ok(result)
    }
}

fn local_note_names(notes_dir: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(notes_dir).map_err(|error| format!("Cannot list workspace notes: {error}"))? {
        let entry = entry.map_err(|error| format!("Cannot inspect workspace note: {error}"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if sync::is_safe_filename(&name) && (name.ends_with(".txt") || name.ends_with(".md")) {
            if entry.file_type().map_err(|error| error.to_string())?.is_symlink() {
                return Err("Workspace contains a symbolic-link note".into());
            }
            if entry.file_type().map_err(|error| error.to_string())?.is_file() { names.push(name); }
        }
    }
    names.sort();
    Ok(names)
}

fn unique_conflict_name(notes_dir: &Path, original: &str, source: &str) -> Result<String, String> {
    let (stem, extension) = original.rsplit_once('.').ok_or("Note has no extension")?;
    for number in 1..=9999 {
        let candidate = format!("{stem} ({source} conflict {number}).{extension}");
        if sync::is_safe_filename(&candidate) && !notes_dir.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err("Cannot find a safe conflict note name".into())
}

#[cfg(test)]
mod tests;
