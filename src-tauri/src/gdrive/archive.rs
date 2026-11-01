//! Causal, append-only archive state synchronization (AUD-010).
//! Note contents and the account-scoped upload permissions are never changed here.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::client::DriveClient;
use super::provenance::{self, AccountLinkState, NoteRecord, ProvenanceLedger};
use super::sync;
use super::workspace_sync::{self, WorkspaceIdentity};
use crate::workspaces::sync_context::{SyncPermit, SyncRequest};

const FILE_NAME: &str = ".lyra_archive_state.json";
const SCHEMA_VERSION: u32 = 1;
const REMOTE_FOLDER: &str = ".lyra_archive";
pub static ARCHIVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveOperation {
    pub schema_version: u32,
    pub operation_id: String,
    pub account_key: String,
    pub remote_note_id: String,
    pub device_id: String,
    pub archived: bool,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PendingChange {
    archived: bool,
    #[serde(default)]
    parents: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AccountArchiveState {
    #[serde(default)]
    operations: BTreeMap<String, ArchiveOperation>,
    #[serde(default)]
    published: BTreeSet<String>,
    #[serde(default)]
    pending: BTreeMap<String, PendingChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArchiveLedger {
    schema_version: u32,
    device_id: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    migrated_legacy: bool,
    #[serde(default)]
    local_only: BTreeMap<String, bool>,
    #[serde(default)]
    accounts: BTreeMap<String, AccountArchiveState>,
    #[serde(default)]
    last_account: Option<String>,
}

impl Default for ArchiveLedger {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            device_id: format!("device_{:032x}", rand::random::<u128>()),
            revision: 0,
            migrated_legacy: false,
            local_only: BTreeMap::new(),
            accounts: BTreeMap::new(),
            last_account: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProjection {
    pub archived_names: Vec<String>,
    pub conflict_names: Vec<String>,
    pub revision: u64,
}

fn path(lyra_dir: &Path) -> PathBuf {
    lyra_dir.join(FILE_NAME)
}

fn parse(bytes: &[u8]) -> Result<ArchiveLedger, String> {
    let ledger: ArchiveLedger = serde_json::from_slice(bytes)
        .map_err(|e| format!("Invalid archive ledger: {e}"))?;
    if ledger.schema_version != SCHEMA_VERSION || ledger.device_id.is_empty() {
        return Err("Unsupported archive ledger version or missing device ID".to_string());
    }
    Ok(ledger)
}

fn load(lyra_dir: &Path) -> Result<ArchiveLedger, String> {
    let primary = path(lyra_dir);
    if !primary.exists() {
        return Ok(ArchiveLedger::default());
    }
    if let Ok(bytes) = fs::read(&primary) {
        if let Ok(ledger) = parse(&bytes) {
            return Ok(ledger);
        }
    }
    let backup = primary.with_extension("json.bak");
    if let Ok(bytes) = fs::read(&backup) {
        return parse(&bytes);
    }
    Err("Archive ledger is corrupt and has no valid backup".to_string())
}

fn save(lyra_dir: &Path, ledger: &mut ArchiveLedger) -> Result<(), String> {
    fs::create_dir_all(lyra_dir).map_err(|e| format!("Cannot create archive directory: {e}"))?;
    ledger.revision = ledger.revision.saturating_add(1);
    let primary = path(lyra_dir);
    let backup = primary.with_extension("json.bak");
    let bytes = serde_json::to_vec_pretty(ledger).map_err(|e| e.to_string())?;
    let temporary = lyra_dir.join(format!(".lyra_archive_state.tmp.{:032x}", rand::random::<u128>()));
    {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|e| format!("Cannot create archive temporary file: {e}"))?;
        file.write_all(&bytes).map_err(|e| format!("Cannot write archive ledger: {e}"))?;
        file.sync_all().map_err(|e| format!("Cannot sync archive ledger: {e}"))?;
    }
    if fs::read(&primary).ok().is_some_and(|raw| parse(&raw).is_ok()) {
        let _ = fs::copy(&primary, &backup);
    }
    fs::rename(&temporary, &primary).map_err(|e| format!("Cannot replace archive ledger: {e}"))?;
    Ok(())
}

fn new_operation(device_id: &str, account_key: &str, remote_id: &str, archived: bool, parents: Vec<String>) -> ArchiveOperation {
    ArchiveOperation {
        schema_version: SCHEMA_VERSION,
        operation_id: format!("{:032x}", rand::random::<u128>()),
        account_key: account_key.to_string(),
        remote_note_id: remote_id.to_string(),
        device_id: device_id.to_string(),
        archived,
        parents,
    }
}

fn binding_id<'a>(record: &'a NoteRecord, account_key: &str) -> Option<&'a str> {
    if record.retired { return None }
    record.bindings.get(account_key)
        .filter(|binding| binding.state == AccountLinkState::Authorized)
        .and_then(|binding| binding.drive_id.as_deref())
}

fn valid_remote_ids(provenance: &ProvenanceLedger, account_key: &str) -> BTreeSet<String> {
    provenance.notes.values().filter_map(|record| binding_id(record, account_key).map(str::to_string)).collect()
}

/// The maximal operations are those not named as a parent by another operation
/// on the same remote note. Only simultaneous, contradictory maxima invoke the
/// archive-wins rule; a causal successor always supersedes its ancestors.
fn heads<'a>(state: &'a AccountArchiveState, remote_id: &str) -> Vec<&'a ArchiveOperation> {
    let operations: Vec<&ArchiveOperation> = state.operations.values()
        .filter(|op| op.remote_note_id == remote_id).collect();
    let parents: BTreeSet<&str> = operations.iter().flat_map(|op| op.parents.iter().map(String::as_str)).collect();
    operations.into_iter().filter(|op| !parents.contains(op.operation_id.as_str())).collect()
}

fn resolved(state: &AccountArchiveState, remote_id: &str) -> Option<(bool, bool)> {
    let heads = heads(state, remote_id);
    if heads.is_empty() { return None }
    let archived = heads.iter().any(|op| op.archived);
    let conflict = heads.len() > 1 && heads.iter().any(|op| op.archived != heads[0].archived);
    Some((archived, conflict))
}

fn validate_graph(state: &AccountArchiveState) -> Result<(), String> {
    fn visit(id: &str, state: &AccountArchiveState, visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>) -> Result<(), String> {
        if visited.contains(id) { return Ok(()); }
        if !visiting.insert(id.to_string()) { return Err("Archive operation graph is cyclic".to_string()); }
        if let Some(op) = state.operations.get(id) {
            for parent in &op.parents { visit(parent, state, visiting, visited)?; }
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        Ok(())
    }
    for op in state.operations.values() {
        for parent_id in &op.parents {
            let parent = state.operations.get(parent_id)
                .ok_or_else(|| "Archive operation has a missing causal parent".to_string())?;
            if parent.account_key != op.account_key || parent.remote_note_id != op.remote_note_id {
                return Err("Archive operation references another note or account".to_string());
            }
        }
    }
    let mut visited = BTreeSet::new();
    for op in state.operations.values() {
        visit(&op.operation_id, state, &mut BTreeSet::new(), &mut visited)?;
    }
    Ok(())
}

fn note_record(lyra_dir: &Path, name: &str) -> Result<NoteRecord, String> {
    let local_path = sync::resolve_safe_path(lyra_dir, name)?;
    if !local_path.is_file() { return Err("Note does not exist".to_string()) }
    provenance::invalidate_changed_note(lyra_dir, name)?;
    provenance::record_local_write(lyra_dir, name, None, false)?;
    let provenance = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir))?
        .ok_or_else(|| "Missing provenance ledger".to_string())?;
    let note_id = provenance.by_name.get(name).ok_or_else(|| "Missing note identity".to_string())?;
    provenance.notes.get(note_id).cloned().ok_or_else(|| "Missing note record".to_string())
}

pub fn set_archived(lyra_dir: &Path, name: &str, archived: bool, account_key: Option<&str>) -> Result<(), String> {
    let note = note_record(lyra_dir, name)?;
    let mut ledger = load(lyra_dir)?;
    let known_accounts: Vec<&str> = note.bindings.keys()
        .filter_map(|key| binding_id(&note, key).map(|_| key.as_str())).collect();
    // Without an explicit account, only an unambiguous Drive binding may
    // receive an account-scoped operation. Unbound notes stay local-only.
    let target_account = account_key.or_else(|| match known_accounts.as_slice() {
        [only] => Some(*only),
        _ => None,
    });
    if let Some(key) = target_account {
        ledger.last_account = Some(key.to_string());
        let remote_id = binding_id(&note, key).map(str::to_string);
        let device_id = ledger.device_id.clone();
        let state = ledger.accounts.entry(key.to_string()).or_default();
        if let Some(remote_id) = remote_id {
            let parents = heads(state, &remote_id).iter().map(|op| op.operation_id.clone()).collect();
            let op = new_operation(&device_id, key, &remote_id, archived, parents);
            state.operations.insert(op.operation_id.clone(), op);
            state.pending.remove(&note.note_id);
        } else {
            state.pending.insert(note.note_id.clone(), PendingChange { archived, parents: Vec::new() });
            ledger.local_only.insert(note.note_id.clone(), archived);
        }
    } else {
        ledger.local_only.insert(note.note_id, archived);
    }
    save(lyra_dir, &mut ledger)
}

/// F4 archive actions use the workspace manifest's note identity, not a
/// per-note upload grant. An unpaired note remains locally archived and its
/// action is queued until the note obtains a remote ID in this workspace.
pub fn set_archived_workspace(
    lyra_dir: &Path, name: &str, archived: bool,
    identity: &WorkspaceIdentity, account_key: &str,
) -> Result<(), String> {
    if account_key != super::auth::sanitize_account_key(&identity.account_sub) {
        return Err("Archive account does not match the bound workspace".into());
    }
    let note = note_record(lyra_dir, name)?;
    let manifest = workspace_sync::load(lyra_dir, identity)?;
    let remote_id = manifest.files.get(name)
        .filter(|file| file.note_id == note.note_id).map(|file|
            manifest.archive_anchors.get(&file.drive_id).unwrap_or(&file.drive_id).clone());
    let mut ledger = load(lyra_dir)?;
    ledger.last_account = Some(account_key.to_string());
    let device_id = ledger.device_id.clone();
    let state = ledger.accounts.entry(account_key.to_string()).or_default();
    if let Some(remote_id) = remote_id {
        let parents = heads(state, &remote_id).iter().map(|op| op.operation_id.clone()).collect();
        let op = new_operation(&device_id, account_key, &remote_id, archived, parents);
        state.operations.insert(op.operation_id.clone(), op);
        state.pending.remove(&note.note_id);
    } else {
        state.pending.insert(note.note_id.clone(), PendingChange { archived, parents: Vec::new() });
        ledger.local_only.insert(note.note_id, archived);
    }
    save(lyra_dir, &mut ledger)
}

pub fn initialize_legacy(lyra_dir: &Path, archived_names: &[String]) -> Result<(), String> {
    let mut ledger = load(lyra_dir)?;
    if ledger.migrated_legacy { return Ok(()) }
    // Import only notes present now. A legacy name is never attached to a
    // later file reusing that name. Remote history is checked before publish.
    for name in archived_names {
        let Ok(note) = note_record(lyra_dir, name) else { continue };
        ledger.local_only.insert(note.note_id, true);
    }
    ledger.migrated_legacy = true;
    save(lyra_dir, &mut ledger)
}

pub fn projection(lyra_dir: &Path, account_key: Option<&str>) -> Result<ArchiveProjection, String> {
    let ledger = load(lyra_dir)?;
    let provenance = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir))?.unwrap_or_default();
    let key = account_key.or(ledger.last_account.as_deref());
    let mut output = ArchiveProjection { revision: ledger.revision, ..Default::default() };
    for (name, note_id) in &provenance.by_name {
        let Some(record) = provenance.notes.get(note_id) else { continue };
        if record.retired || !lyra_dir.join(name).is_file() { continue }
        let mut value = ledger.local_only.get(note_id).copied().unwrap_or(false);
        let mut conflict = false;
        if let Some(key) = key {
            if record.bindings.values().any(|b| b.state == AccountLinkState::Authorized)
                && binding_id(record, key).is_none() {
                value = false;
            }
            if let Some(state) = ledger.accounts.get(key) {
                if let Some(pending) = state.pending.get(note_id) {
                    value = pending.archived;
                } else if let Some(remote_id) = binding_id(record, key) {
                    if let Some((archived, is_conflict)) = resolved(state, remote_id) {
                        value = archived;
                        conflict = is_conflict;
                    }
                } else if record.bindings.values().any(|b| b.state == AccountLinkState::Authorized) {
                    value = false;
                }
            }
        }
        if value { output.archived_names.push(name.clone()); }
        if conflict { output.conflict_names.push(name.clone()); }
    }
    Ok(output)
}

/// Disconnected Drive workspaces display only their local archive choices.
/// Historical account state in this directory never selects an account by
/// `last_account` while the verified binding is unavailable.
pub fn projection_local_only(lyra_dir: &Path) -> Result<ArchiveProjection, String> {
    let ledger = load(lyra_dir)?;
    let provenance = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir))?.unwrap_or_default();
    let mut output = ArchiveProjection { revision: ledger.revision, ..Default::default() };
    for (name, note_id) in &provenance.by_name {
        let Some(record) = provenance.notes.get(note_id) else { continue };
        if !record.retired && lyra_dir.join(name).is_file() &&
            ledger.local_only.get(note_id).copied().unwrap_or(false) {
            output.archived_names.push(name.clone());
        }
    }
    Ok(output)
}

/// Projection for a verified workspace binding. Other accounts' historical
/// operations in a copied ledger are never consulted for this workspace.
pub fn projection_workspace(
    lyra_dir: &Path, identity: &WorkspaceIdentity, account_key: &str,
) -> Result<ArchiveProjection, String> {
    if account_key != super::auth::sanitize_account_key(&identity.account_sub) {
        return Err("Archive account does not match the bound workspace".into());
    }
    let ledger = load(lyra_dir)?;
    let provenance = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir))?.unwrap_or_default();
    let manifest = workspace_sync::load(lyra_dir, identity)?;
    let state = ledger.accounts.get(account_key);
    let mut output = ArchiveProjection { revision: ledger.revision, ..Default::default() };
    for (name, note_id) in &provenance.by_name {
        let Some(record) = provenance.notes.get(note_id) else { continue };
        if record.retired || !lyra_dir.join(name).is_file() { continue }
        let mut value = ledger.local_only.get(note_id).copied().unwrap_or(false);
        let mut conflict = false;
        if let Some(state) = state {
            if let Some(pending) = state.pending.get(note_id) {
                value = pending.archived;
            } else if let Some(remote_id) = manifest.files.get(name)
                .filter(|file| file.note_id == *note_id).map(|file|
                    manifest.archive_anchors.get(&file.drive_id).unwrap_or(&file.drive_id).as_str()) {
                if let Some((archived, is_conflict)) = resolved(state, remote_id) {
                    value = archived;
                    conflict = is_conflict;
                }
            }
        }
        if value { output.archived_names.push(name.clone()); }
        if conflict { output.conflict_names.push(name.clone()); }
    }
    Ok(output)
}

fn parse_remote_operation(bytes: &[u8], file_name: &str, account_key: &str) -> Result<ArchiveOperation, String> {
    if bytes.len() > 16_384 { return Err("Archive operation exceeds size limit".to_string()) }
    let op: ArchiveOperation = serde_json::from_slice(bytes).map_err(|e| format!("Invalid remote archive operation: {e}"))?;
    if op.schema_version != SCHEMA_VERSION || op.account_key != account_key
        || op.operation_id.len() != 32 || !op.operation_id.bytes().all(|c| c.is_ascii_hexdigit())
        || file_name != format!("op-{}.json", op.operation_id)
        || op.remote_note_id.is_empty() || op.device_id.is_empty()
        || op.parents.len() > 128 || op.parents.iter().any(|p| p == &op.operation_id) {
        return Err("Remote archive operation has invalid identity or schema".to_string());
    }
    Ok(op)
}

/// Merge all remote operations before publishing pending local operations.
/// Separate immutable files avoid replacing another device's changes.
#[cfg(test)]
pub async fn sync_remote(
    lyra_dir: &Path,
    account_key: &str,
    folder_id: &str,
    client: &DriveClient,
) -> Result<(), String> {
    sync_remote_with_token(lyra_dir, account_key, folder_id, client, "").await
}

/// F4 archive synchronization. The workspace manifest supplies the only
/// note-to-remote mapping. Every HTTP call and ledger write is checked against
/// the originating F3 owner, and the parent folder must match that manifest.
#[allow(dead_code)] // Called by the F4 remote runner after content effects are connected.
pub async fn sync_remote_workspace<F>(
    lyra_dir: &Path,
    identity: &WorkspaceIdentity,
    account_key: &str,
    client: &DriveClient,
    token: &str,
    permit: &SyncPermit<'_>,
    current: F,
) -> Result<(), String>
where F: Fn() -> Result<SyncRequest, String> {
    if account_key != super::auth::sanitize_account_key(&identity.account_sub) {
        return Err("Archive account does not match the bound workspace".into());
    }
    let _effect_lease = workspace_sync::EFFECT_LOCK.lock().await;
    let manifest = workspace_sync::load(lyra_dir, identity)?;
    let folder_id = manifest.folder_id.as_deref().ok_or("Workspace has no confirmed remote folder")?;
    let mut note_to_remote = BTreeMap::new();
    let mut valid_ids = BTreeSet::new();
    for file in manifest.files.values() {
        let archive_id = manifest.archive_anchors.get(&file.drive_id).unwrap_or(&file.drive_id);
        note_to_remote.insert(file.note_id.clone(), archive_id.clone());
        valid_ids.insert(archive_id.clone());
    }
    if valid_ids.is_empty() { return Ok(()); }

    let folders = permit.effect(|| current(), || client.list_child_folders(token, folder_id, REMOTE_FOLDER)).await?;
    if folders.len() > 1 { return Err("Multiple archive folders exist in this workspace".into()); }
    let mut remote_ops = BTreeMap::new();
    for folder in &folders {
        let files = permit.effect(|| current(), || client.list_files_in_folder(token, folder)).await?;
        for file in files {
            if !file.name.starts_with("op-") || !file.name.ends_with(".json") { continue }
            let bytes = permit.effect(|| current(), || client.download_file(token, &file.id)).await?;
            let op = parse_remote_operation(&bytes, &file.name, account_key)?;
            if !valid_ids.contains(&op.remote_note_id) { continue }
            if let Some(existing) = remote_ops.insert(op.operation_id.clone(), op.clone()) {
                if existing != op { return Err("Conflicting archive operations share an ID".into()); }
            }
        }
    }

    let unpublished = permit.effect(|| current(), || async {
        let _guard = ARCHIVE_LOCK.lock().await;
        let mut ledger = load(lyra_dir)?;
        ledger.last_account = Some(account_key.to_string());
        let device_id = ledger.device_id.clone();
        let legacy_local = ledger.local_only.clone();
        let state = ledger.accounts.entry(account_key.to_string()).or_default();
        for (id, op) in &remote_ops {
            if state.operations.get(id).is_some_and(|existing| existing != op) {
                return Err("Remote archive operation changed after publication".into());
            }
            state.operations.insert(id.clone(), op.clone());
            state.published.insert(id.clone());
        }
        for (note_id, archived) in &legacy_local {
            if !archived { continue }
            if let Some(remote_id) = note_to_remote.get(note_id) {
                if !state.operations.values().any(|op| op.remote_note_id == *remote_id) {
                    let op = new_operation(&device_id, account_key, remote_id, true, Vec::new());
                    state.operations.insert(op.operation_id.clone(), op);
                }
            }
        }
        for (note_id, pending) in std::mem::take(&mut state.pending) {
            if let Some(remote_id) = note_to_remote.get(&note_id) {
                let op = new_operation(&device_id, account_key, remote_id, pending.archived, pending.parents);
                state.operations.insert(op.operation_id.clone(), op);
            } else {
                state.pending.insert(note_id, pending);
            }
        }
        validate_graph(state)?;
        save(lyra_dir, &mut ledger)?;
        let mut unpublished: Vec<ArchiveOperation> = ledger.accounts.get(account_key).into_iter()
            .flat_map(|state| state.operations.values().filter(|op| !state.published.contains(&op.operation_id)))
            .filter(|op| valid_ids.contains(&op.remote_note_id)).cloned().collect();
        if let Some(state) = ledger.accounts.get(account_key) {
            fn depth(id: &str, state: &AccountArchiveState, cache: &mut BTreeMap<String, usize>) -> usize {
                if let Some(value) = cache.get(id) { return *value; }
                let value = state.operations.get(id).map(|op| 1 + op.parents.iter()
                    .map(|parent| depth(parent, state, cache)).max().unwrap_or(0)).unwrap_or(0);
                cache.insert(id.to_string(), value);
                value
            }
            let mut cache = BTreeMap::new();
            unpublished.sort_by_key(|op| depth(&op.operation_id, state, &mut cache));
        }
        Ok(unpublished)
    }).await?;

    if unpublished.is_empty() { return Ok(()); }
    // Folder and operation-file POSTs are not yet backed by a durable create
    // intent or a pre-generated Drive ID. Keep the immutable local operations
    // for a later, idempotent publication protocol.
    Err("SyncPaused: archive publication needs idempotent create intents".into())
}

#[cfg(test)]
async fn sync_remote_with_token(
    lyra_dir: &Path,
    account_key: &str,
    folder_id: &str,
    client: &DriveClient,
    token: &str,
) -> Result<(), String> {
    let provenance = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir))?.unwrap_or_default();
    let valid_ids = valid_remote_ids(&provenance, account_key);
    if valid_ids.is_empty() { return Ok(()) }

    let mut folders = client.list_child_folders(token, folder_id, REMOTE_FOLDER).await?;
    folders.sort();
    let mut remote_ops = BTreeMap::new();
    for folder in &folders {
        for file in client.list_files_in_folder(token, folder).await? {
            if !file.name.starts_with("op-") || !file.name.ends_with(".json") { continue }
            let bytes = client.download_file(token, &file.id).await?;
            let op = parse_remote_operation(&bytes, &file.name, account_key)?;
            if !valid_ids.contains(&op.remote_note_id) { continue }
            if let Some(existing) = remote_ops.insert(op.operation_id.clone(), op.clone()) {
                if existing != op { return Err("Conflicting archive operations share an ID".to_string()) }
            }
        }
    }

    let _guard = ARCHIVE_LOCK.lock().await;
    let mut ledger = load(lyra_dir)?;
    ledger.last_account = Some(account_key.to_string());
    let device_id = ledger.device_id.clone();
    let legacy_local = ledger.local_only.clone();
    let state = ledger.accounts.entry(account_key.to_string()).or_default();
    for (id, op) in &remote_ops {
        if let Some(existing) = state.operations.get(id) {
            if existing != op { return Err("Remote archive operation changed after publication".to_string()) }
        }
        state.operations.insert(id.clone(), op.clone());
        state.published.insert(id.clone());
    }
    for (note_id, archived) in &legacy_local {
        if !archived { continue; }
        let remote_id = provenance.notes.get(note_id).and_then(|note| {
            let authorized_count = note.bindings.keys().filter(|key| binding_id(note, key).is_some()).count();
            (authorized_count == 1).then(|| binding_id(note, account_key)).flatten()
        });
        if let Some(remote_id) = remote_id {
            if !state.operations.values().any(|op| op.remote_note_id == remote_id) {
                let op = new_operation(&device_id, account_key, remote_id, true, Vec::new());
                state.operations.insert(op.operation_id.clone(), op);
            }
        }
    }
    for (note_id, pending) in std::mem::take(&mut state.pending) {
        let remote_id = provenance.notes.get(&note_id).and_then(|note| binding_id(note, account_key));
        if let Some(remote_id) = remote_id {
            let op = new_operation(&device_id, account_key, remote_id, pending.archived, pending.parents);
            state.operations.insert(op.operation_id.clone(), op);
        } else {
            state.pending.insert(note_id, pending);
        }
    }
    validate_graph(state)?;
    save(lyra_dir, &mut ledger)?;

    let mut unpublished: Vec<ArchiveOperation> = ledger.accounts.get(account_key).into_iter()
        .flat_map(|s| s.operations.values().filter(|op| !s.published.contains(&op.operation_id)))
        .filter(|op| valid_ids.contains(&op.remote_note_id)).cloned().collect();
    if let Some(state) = ledger.accounts.get(account_key) {
        fn depth(id: &str, state: &AccountArchiveState, cache: &mut BTreeMap<String, usize>) -> usize {
            if let Some(value) = cache.get(id) { return *value; }
            let value = state.operations.get(id).map(|op| 1 + op.parents.iter()
                .map(|parent| depth(parent, state, cache)).max().unwrap_or(0)).unwrap_or(0);
            cache.insert(id.to_string(), value);
            value
        }
        let mut cache = BTreeMap::new();
        unpublished.sort_by_key(|op| depth(&op.operation_id, state, &mut cache));
    }
    drop(_guard);
    if unpublished.is_empty() { return Ok(()) }
    if folders.is_empty() {
        folders.push(client.create_child_folder(token, folder_id, REMOTE_FOLDER).await?);
    }
    let target_folder = &folders[0];
    for op in unpublished {
        let file_name = format!("op-{}.json", op.operation_id);
        let content = serde_json::to_vec(&op).map_err(|e| e.to_string())?;
        client.upload_file(token, target_folder, &file_name, &content, &chrono::Utc::now().to_rfc3339()).await?;
        let _guard = ARCHIVE_LOCK.lock().await;
        let mut latest = load(lyra_dir)?;
        latest.accounts.entry(account_key.to_string()).or_default().published.insert(op.operation_id);
        save(lyra_dir, &mut latest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::provenance::{AccountBinding, AuthorizationSource, NoteOrigin};
    use super::super::workspace_sync::{WorkspaceFile, WorkspaceManifest};
    use crate::workspaces::sync_context::{Admission, SyncCoordinator};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("lyra-archive-test-{:032x}", rand::random::<u128>()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn add_note(dir: &Path, name: &str, account: Option<(&str, &str)>) -> String {
        fs::write(dir.join(name), b"test note").unwrap();
        provenance::record_local_write(dir, name, None, true).unwrap();
        let path = provenance::get_ledger_path(dir);
        let mut source = provenance::load_ledger(&path).unwrap().unwrap();
        let id = source.by_name[name].clone();
        if let Some((key, remote_id)) = account {
            source.notes.get_mut(&id).unwrap().bindings.insert(key.into(), AccountBinding {
                account_key: key.into(), state: AccountLinkState::Authorized,
                origin: NoteOrigin::Downloaded, source: AuthorizationSource::AutomaticDownload,
                authorized_at: None, drive_id: Some(remote_id.into()), md5: None,
            });
            provenance::save_ledger(&path, &source).unwrap();
        }
        id
    }

    fn operation(id: &str, archived: bool, parents: &[&str]) -> ArchiveOperation {
        ArchiveOperation { schema_version: 1, operation_id: id.into(), account_key: "a".into(),
            remote_note_id: "remote".into(), device_id: "d".into(), archived,
            parents: parents.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn workspace_archive_uses_manifest_identity_without_note_authorization() {
        let dir = TestDir::new();
        let note_id = add_note(&dir.0, "Note.md", None);
        let identity = WorkspaceIdentity {
            workspace_id: "ws_002".into(), account_sub: "verified-sub".into(),
            folder_nonce: "0123456789abcdef0123456789abcdef".into(),
        };
        let mut manifest = WorkspaceManifest::new(&identity).unwrap();
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "remote-note".into(), digest: "digest".into(), note_id: note_id.clone(),
        });
        fs::write(dir.0.join(".lyra_workspace_drive_manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(set_archived_workspace(&dir.0, "Note.md", true, &identity, "wrong-account").is_err());
        set_archived_workspace(&dir.0, "Note.md", true, &identity, "verified-sub").unwrap();
        assert_eq!(projection_workspace(&dir.0, &identity, "verified-sub").unwrap().archived_names, ["Note.md"]);
        set_archived_workspace(&dir.0, "Note.md", false, &identity, "verified-sub").unwrap();
        assert!(projection_workspace(&dir.0, &identity, "verified-sub").unwrap().archived_names.is_empty());
        let ledger = load(&dir.0).unwrap();
        assert_eq!(ledger.accounts["verified-sub"].operations.len(), 2);
        assert_eq!(resolved(&ledger.accounts["verified-sub"], "remote-note"), Some((false, false)));
        let provenance = provenance::load_ledger(&provenance::get_ledger_path(&dir.0)).unwrap().unwrap();
        assert!(provenance.notes[&note_id].bindings.is_empty());
    }

    #[test]
    fn immutable_content_version_preserves_causal_archive_anchor() {
        let dir = TestDir::new();
        let note_id = add_note(&dir.0, "Note.md", None);
        let identity = WorkspaceIdentity {
            workspace_id: "ws_002".into(), account_sub: "verified-sub".into(),
            folder_nonce: "0123456789abcdef0123456789abcdef".into(),
        };
        let mut manifest = WorkspaceManifest::new(&identity).unwrap();
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "new-version".into(), digest: "digest".into(), note_id,
        });
        manifest.archive_anchors.insert("new-version".into(), "original-version".into());
        manifest.historical_versions.insert("original-version".into(), "old-digest".into());
        fs::write(dir.0.join(".lyra_workspace_drive_manifest.json"),
            serde_json::to_vec(&manifest).unwrap()).unwrap();
        set_archived_workspace(&dir.0, "Note.md", true, &identity, "verified-sub").unwrap();
        let ledger = load(&dir.0).unwrap();
        assert_eq!(ledger.accounts["verified-sub"].operations.values().next().unwrap().remote_note_id,
            "original-version");
        assert_eq!(projection_workspace(&dir.0, &identity, "verified-sub").unwrap().archived_names,
            ["Note.md"]);
    }

    #[test]
    fn disconnected_workspace_projection_never_uses_previous_account_state() {
        let dir = TestDir::new();
        let note_id = add_note(&dir.0, "Note.md", None);
        let mut ledger = ArchiveLedger::default();
        ledger.last_account = Some("old-account".into());
        ledger.accounts.entry("old-account".into()).or_default().pending.insert(
            note_id.clone(), PendingChange { archived: true, parents: Vec::new() });
        save(&dir.0, &mut ledger).unwrap();
        assert!(projection_local_only(&dir.0).unwrap().archived_names.is_empty());
        ledger.local_only.insert(note_id, true);
        save(&dir.0, &mut ledger).unwrap();
        assert_eq!(projection_local_only(&dir.0).unwrap().archived_names, ["Note.md"]);
    }

    #[tokio::test]
    async fn workspace_archive_keeps_unpublished_operation_without_create_intent() {
        let dir = TestDir::new();
        let note_id = add_note(&dir.0, "Note.md", None);
        let identity = WorkspaceIdentity {
            workspace_id: "ws_002".into(), account_sub: "verified-sub".into(),
            folder_nonce: "0123456789abcdef0123456789abcdef".into(),
        };
        let mut manifest = WorkspaceManifest::new(&identity).unwrap();
        manifest.folder_id = Some("workspace-folder".into());
        manifest.files.insert("Note.md".into(), WorkspaceFile {
            drive_id: "remote-note".into(), digest: "digest".into(), note_id,
        });
        fs::write(dir.0.join(".lyra_workspace_drive_manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        set_archived_workspace(&dir.0, "Note.md", true, &identity, "verified-sub").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        let handle = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Get);
            request.respond(tiny_http::Response::from_string(r#"{"files":[]}"#)).unwrap();
        });
        let client = DriveClient::new_with_base_url(base).unwrap();
        let coordinator = SyncCoordinator::default();
        let request = SyncRequest { workspace_id: "ws_002".into(), epoch: 7 };
        let permit = match coordinator.submit(request.clone(), &request).unwrap() {
            Admission::Active(permit) => permit,
            Admission::Queued => panic!("expected owner"),
        };
        assert!(sync_remote_workspace(&dir.0, &identity, "verified-sub", &client, "fake", &permit,
            || Ok(request.clone())).await.unwrap_err().contains("SyncPaused"));
        handle.join().unwrap();
        let state = load(&dir.0).unwrap().accounts.remove("verified-sub").unwrap();
        assert_eq!(state.operations.len(), 1);
        assert!(state.published.is_empty());
        assert_eq!(resolved(&state, "remote-note"), Some((true, false)));
    }

    #[test]
    fn causal_unarchive_beats_prior_archive() {
        let mut state = AccountArchiveState::default();
        state.operations.insert("a".into(), operation("a", true, &[]));
        state.operations.insert("b".into(), operation("b", false, &["a"]));
        assert_eq!(resolved(&state, "remote"), Some((false, false)));
    }

    #[test]
    fn only_concurrent_contradictions_use_archive_wins() {
        let mut state = AccountArchiveState::default();
        state.operations.insert("a".into(), operation("a", true, &[]));
        state.operations.insert("b".into(), operation("b", false, &[]));
        assert_eq!(resolved(&state, "remote"), Some((true, true)));
        state.operations.insert("c".into(), operation("c", false, &["a", "b"]));
        assert_eq!(resolved(&state, "remote"), Some((false, false)));
    }

    #[test]
    fn order_of_arrival_does_not_change_result() {
        let operations = [operation("b", false, &[]), operation("a", true, &[])];
        let mut first = AccountArchiveState::default();
        let mut second = AccountArchiveState::default();
        for op in &operations { first.operations.insert(op.operation_id.clone(), op.clone()); }
        for op in operations.iter().rev() { second.operations.insert(op.operation_id.clone(), op.clone()); }
        assert_eq!(resolved(&first, "remote"), resolved(&second, "remote"));
    }

    #[test]
    fn offline_actions_survive_restart_and_causal_unarchive() {
        let dir = TestDir::new();
        add_note(&dir.0, "Note.md", Some(("account_a", "drive_note")));
        set_archived(&dir.0, "Note.md", true, None).unwrap();
        assert_eq!(projection(&dir.0, Some("account_a")).unwrap().archived_names, ["Note.md"]);
        set_archived(&dir.0, "Note.md", false, None).unwrap();
        let reopened = load(&dir.0).unwrap();
        let state = &reopened.accounts["account_a"];
        assert_eq!(state.operations.len(), 2);
        assert_eq!(resolved(state, "drive_note"), Some((false, false)));
        assert!(projection(&dir.0, Some("account_a")).unwrap().archived_names.is_empty());
    }

    #[test]
    fn unbound_note_with_empty_manifest_archives_locally_without_account() {
        let dir = TestDir::new();
        let note_id = add_note(&dir.0, "Offline.md", None);
        assert!(load(&dir.0).unwrap().accounts.is_empty());
        assert!(projection(&dir.0, None).unwrap().archived_names.is_empty());

        set_archived(&dir.0, "Offline.md", true, None).unwrap();
        let reopened = load(&dir.0).unwrap();
        assert_eq!(reopened.local_only.get(&note_id), Some(&true));
        assert!(reopened.accounts.is_empty());
        assert!(reopened.last_account.is_none());
        assert_eq!(projection(&dir.0, None).unwrap().archived_names, ["Offline.md"]);

        set_archived(&dir.0, "Offline.md", false, None).unwrap();
        assert!(projection(&dir.0, None).unwrap().archived_names.is_empty());
    }

    #[test]
    fn internal_welcome_without_drive_binding_archives_locally() {
        let dir = TestDir::new();
        let name = "¡Bienvenid@ a Lyra!.txt";
        add_note(&dir.0, name, None);
        provenance::mark_internal_welcome(&dir.0, name, b"test note").unwrap();
        assert!(provenance::is_verified_internal_welcome(&dir.0, name).unwrap());

        set_archived(&dir.0, name, true, None).unwrap();
        assert_eq!(projection(&dir.0, None).unwrap().archived_names, [name]);
        assert!(load(&dir.0).unwrap().accounts.is_empty());
        assert!(provenance::is_verified_internal_welcome(&dir.0, name).unwrap());
    }

    #[test]
    fn newly_connected_account_keeps_unbound_note_pending_without_remote_operation() {
        let dir = TestDir::new();
        let note_id = add_note(&dir.0, "Unbound.md", None);
        set_archived(&dir.0, "Unbound.md", true, Some("account_a")).unwrap();
        let reopened = load(&dir.0).unwrap();
        assert_eq!(reopened.accounts["account_a"].pending[&note_id].archived, true);
        assert!(reopened.accounts["account_a"].operations.is_empty());
        assert!(reopened.accounts.get("account_b").is_none());
        assert_eq!(projection(&dir.0, Some("account_a")).unwrap().archived_names, ["Unbound.md"]);
    }

    #[test]
    fn migration_is_idempotent_and_does_not_attach_to_recreated_name() {
        let dir = TestDir::new();
        let old_id = add_note(&dir.0, "Note.md", None);
        initialize_legacy(&dir.0, &["Note.md".into(), "Missing.md".into()]).unwrap();
        initialize_legacy(&dir.0, &["Note.md".into()]).unwrap();
        assert_eq!(load(&dir.0).unwrap().local_only.len(), 1);
        assert_eq!(projection(&dir.0, None).unwrap().archived_names, ["Note.md"]);
        add_note(&dir.0, "Note.md", None);
        assert_ne!(provenance::load_ledger(&provenance::get_ledger_path(&dir.0)).unwrap().unwrap().by_name["Note.md"], old_id);
        assert!(projection(&dir.0, None).unwrap().archived_names.is_empty());
    }

    #[test]
    fn account_state_is_isolated_by_verified_binding() {
        let dir = TestDir::new();
        add_note(&dir.0, "Note.md", Some(("account_a", "drive_a")));
        set_archived(&dir.0, "Note.md", true, Some("account_a")).unwrap();
        assert_eq!(projection(&dir.0, Some("account_a")).unwrap().archived_names, ["Note.md"]);
        assert!(projection(&dir.0, Some("account_b")).unwrap().archived_names.is_empty());
        assert!(!load(&dir.0).unwrap().accounts.contains_key("account_b"));
    }

    #[test]
    fn rejects_invalid_remote_graph_without_silent_resolution() {
        let mut state = AccountArchiveState::default();
        state.operations.insert("a".into(), operation("a", true, &["missing"]));
        assert!(validate_graph(&state).is_err());
        state.operations.insert("missing".into(), operation("missing", false, &["a"]));
        assert!(validate_graph(&state).is_err());
    }

    #[test]
    fn remote_metadata_rejects_wrong_account_and_unknown_schema() {
        let id = "a".repeat(32);
        let mut op = operation(&id, true, &[]);
        let name = format!("op-{id}.json");
        op.account_key = "other".into();
        assert!(parse_remote_operation(&serde_json::to_vec(&op).unwrap(), &name, "account").is_err());
        op.account_key = "account".into();
        op.schema_version = 99;
        assert!(parse_remote_operation(&serde_json::to_vec(&op).unwrap(), &name, "account").is_err());
        assert!(parse_remote_operation(b"{broken", &name, "account").is_err());
    }

    #[tokio::test]
    async fn two_devices_exchange_immutable_operations_over_mock_drive() {
        use std::sync::{Arc, Mutex};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        let remote = Arc::new(Mutex::new(BTreeMap::<String, ArchiveOperation>::new()));
        let folder_exists = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", server.server_addr());
        let (remote_thread, folder_thread, stop_thread) = (remote.clone(), folder_exists.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            while !stop_thread.load(Ordering::SeqCst) {
                let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(100)) else { continue };
                let url = request.url().to_string();
                let method = request.method().as_str();
                let response = if method == "GET" && url.starts_with("/drive/v3/files?") {
                    let query = url.split('?').nth(1).unwrap_or("");
                    let q = url::form_urlencoded::parse(query.as_bytes())
                        .find(|(key, _)| key == "q").map(|(_, value)| value.into_owned()).unwrap_or_default();
                    if q.contains("name = '.lyra_archive'") {
                        if folder_thread.load(Ordering::SeqCst) { r#"{"files":[{"id":"archive_folder","name":".lyra_archive"}]}"#.to_string() }
                        else { r#"{"files":[]}"#.to_string() }
                    } else {
                        let files: Vec<_> = remote_thread.lock().unwrap().keys()
                            .map(|id| serde_json::json!({"id":id,"name":format!("op-{id}.json")})).collect();
                        serde_json::json!({"files":files}).to_string()
                    }
                } else if method == "POST" && url.starts_with("/drive/v3/files?") {
                    folder_thread.store(true, Ordering::SeqCst);
                    r#"{"id":"archive_folder","name":".lyra_archive"}"#.to_string()
                } else if method == "POST" && url.starts_with("/upload/drive/v3/files?") {
                    let mut bytes = Vec::new();
                    std::io::Read::read_to_end(request.as_reader(), &mut bytes).unwrap();
                    let body = String::from_utf8(bytes).unwrap();
                    let payload = body.split("\r\n\r\n").nth(2).unwrap().split("\r\n--").next().unwrap();
                    let op: ArchiveOperation = serde_json::from_str(payload).unwrap();
                    remote_thread.lock().unwrap().insert(op.operation_id.clone(), op.clone());
                    serde_json::json!({"id":op.operation_id,"name":format!("op-{}.json",op.operation_id)}).to_string()
                } else if method == "GET" && url.starts_with("/drive/v3/files/") {
                    let id = url.split('/').nth(4).unwrap().split('?').next().unwrap();
                    serde_json::to_string(&remote_thread.lock().unwrap()[id]).unwrap()
                } else { panic!("Unexpected mock Drive request: {method} {url}") };
                request.respond(tiny_http::Response::from_string(response)).unwrap();
            }
        });

        let a = TestDir::new();
        let b = TestDir::new();
        add_note(&a.0, "Note.md", Some(("account", "drive_note")));
        add_note(&b.0, "Note.md", Some(("account", "drive_note")));
        let client = DriveClient::new_with_base_url(base_url).unwrap();
        macro_rules! sync {
            ($dir:expr) => { sync_remote_with_token($dir, "account", "lyra_folder", &client, "test_token").await.unwrap() };
        }

        set_archived(&a.0, "Note.md", true, Some("account")).unwrap();
        sync!(&a.0);
        sync!(&b.0);
        assert_eq!(projection(&b.0, Some("account")).unwrap().archived_names, ["Note.md"]);

        set_archived(&b.0, "Note.md", false, Some("account")).unwrap();
        sync!(&b.0);
        sync!(&a.0);
        assert!(projection(&a.0, Some("account")).unwrap().archived_names.is_empty());

        set_archived(&a.0, "Note.md", true, Some("account")).unwrap();
        set_archived(&b.0, "Note.md", false, Some("account")).unwrap();
        sync!(&a.0);
        sync!(&b.0);
        sync!(&a.0);
        let conflict = projection(&a.0, Some("account")).unwrap();
        assert_eq!(conflict.archived_names, ["Note.md"]);
        assert_eq!(conflict.conflict_names, ["Note.md"]);

        set_archived(&a.0, "Note.md", false, Some("account")).unwrap();
        sync!(&a.0);
        sync!(&b.0);
        assert!(projection(&b.0, Some("account")).unwrap().archived_names.is_empty());
        assert!(projection(&b.0, Some("account")).unwrap().conflict_names.is_empty());
        assert_eq!(remote.lock().unwrap().len(), 5);
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap();
    }
}
