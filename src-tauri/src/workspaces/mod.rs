//! Workspace runtime: the single source of truth the frontend boots from.
//!
//! The migration is driven by [`migration::run`], which is safe to call as
//! often as needed: it resumes whatever was already done and only advances when
//! the gate is open. Every command below advances the migration first and then
//! answers with a fresh [`Snapshot`], so the UI never has to guess the state.
//!
//! Google Drive sync is deliberately paused while a migration journal exists
//! (see [`drive_sync_paused`]). The Drive engine still addresses the legacy
//! root folder, so letting it run against a workspace would share one manifest
//! between workspaces. F4 binds Drive to a workspace and re-enables it.

pub mod ids;
pub mod management;
pub mod migration;
pub mod origins;
pub mod paths;
pub mod registry;
pub mod sync_context;
pub mod types;

use std::path::{Path, PathBuf};
use std::fs::{self, File, OpenOptions};

use serde::Serialize;

use migration::{Block, Ctx, Decision, Faults, ItemView, Journal, Phase, RetireConflict, StrayView};
use types::{WorkspaceInfo, WorkspaceStatus, WritePolicy};

const NOT_READY: &str = "El espacio de trabajo todavía no está listo";

/// Paths the app needs for every workspace operation. Cloned cheaply into
/// blocking tasks; never holds a lock.
#[derive(Clone, Debug)]
pub struct Runtime {
    documents: PathBuf,
    config: PathBuf,
}

/// Held for the entire Tauri process lifetime. It also covers separate Linux
/// sessions where the D-Bus single-instance plugin cannot see the other app.
pub struct ProcessLock {
    _file: File,
}

#[derive(Default)]
pub struct RuntimeState {
    process: std::sync::Mutex<Option<(PathBuf, PathBuf, ProcessLock)>>,
}

impl RuntimeState {
    pub fn resolve(&self, app: &tauri::AppHandle) -> Result<Runtime, String> {
        let runtime = Runtime::from_app(app)?;
        let mut process = self.process.lock()
            .map_err(|_| "No se pudo revisar el bloqueo de Lyra".to_string())?;
        match process.as_ref() {
            Some((documents, config, _)) if documents == &runtime.documents && config == &runtime.config => {},
            Some(_) => return Err("Las rutas del sistema cambiaron; reinicia Lyra antes de migrar".to_string()),
            None => {
                let lock = runtime.acquire_process_lock()?;
                *process = Some((runtime.documents.clone(), runtime.config.clone(), lock));
            }
        }
        Ok(runtime)
    }
}

impl ProcessLock {
    pub fn acquire(config: &Path) -> Result<Self, String> {
        fs::create_dir_all(config)
            .map_err(|e| format!("No se pudo preparar la configuración: {e}"))?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(config.join(".lyra_process.lock"))
            .map_err(|e| format!("No se pudo abrir el bloqueo de Lyra: {e}"))?;
        file.try_lock().map_err(|e| {
            format!("Otra instancia de Lyra ya utiliza estos datos, o no se pudo bloquear la migración: {e}")
        })?;
        Ok(Self { _file: file })
    }
}

impl Runtime {
    pub fn new(documents: PathBuf, config: PathBuf) -> Self {
        Self { documents, config }
    }

    /// Resolves the two required directories once, before migration starts.
    pub fn from_app(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        Self::from_resolved(
            app.path().document_dir().map_err(|e| e.to_string()),
            app.path().app_config_dir().map_err(|e| e.to_string()),
        )
    }

    fn from_resolved(documents: Result<PathBuf, String>, config: Result<PathBuf, String>) -> Result<Self, String> {
        let documents = documents.map_err(|e| format!("No se pudo resolver Documentos: {e}"))?;
        let config = config.map_err(|e| format!("No se pudo resolver la configuración: {e}"))?;
        Ok(Self::new(documents, config))
    }

    pub fn ctx(&self) -> Ctx {
        Ctx::new(self.documents.clone(), self.config.clone())
    }

    pub fn acquire_process_lock(&self) -> Result<ProcessLock, String> {
        ProcessLock::acquire(&self.config)
    }
}

/// Everything the boot screen needs, in one payload.
///
/// `required` blocks the app until the migration is resolved; `done` means a
/// usable workspace exists. They are complements, both computed server side so
/// the frontend never derives a gate decision of its own.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub required: bool,
    pub done: bool,
    pub phase: Option<Phase>,
    /// Active workspace, when there is one. `None` while the first workspace
    /// is still being created.
    pub workspace: Option<WorkspaceInfo>,
    /// Every registered workspace, including ones needing repair.
    pub workspaces: Vec<WorkspaceInfo>,
    /// Registry generation used by every synchronization request and event.
    pub epoch: u64,
    /// Workspace that received the pre-F1 notes and browser draft keys.
    pub legacy_workspace_id: Option<String>,
    /// Per-note migration status. Empty once the migration is over: status
    /// polling must not hash files for the rest of the session.
    pub items: Vec<ItemView>,
    pub blocks: Vec<Block>,
    /// Notes still sitting in the legacy root (deferred or newly appeared).
    /// Reported even after the migration ends; the warning never disappears
    /// on its own.
    pub strays: Vec<StrayView>,
    /// Retire conflicts. Non-destructive: the original is still in place.
    pub retire_conflicts: Vec<RetireConflict>,
    /// Names whose old draft key could now refer to a different destination.
    pub draft_conflict_names: Vec<String>,
    /// `lyra/rescatados/...`, relative to Documents, where originals were kept.
    pub restore_dir: Option<String>,
    /// Drive sync is paused (fail-closed) while a migration journal exists.
    pub drive_paused: bool,
    /// Recoverable problem that did not abort the migration (for example a
    /// journal rebuilt from the origins ledger).
    pub error: Option<String>,
}

/// Advances the migration and returns the resulting snapshot.
pub fn snapshot(documents: &Path, config: &Path, faults: &Faults) -> Result<Snapshot, String> {
    let ctx = Ctx::new(documents.to_path_buf(), config.to_path_buf());
    let journal = migration::run(&ctx, faults)?;
    build(&ctx, journal)
}

/// Advances an already modified journal (after a user decision).
fn advance_after(ctx: &Ctx) -> Result<Snapshot, String> {
    let journal = migration::run(ctx, &Faults::none())?;
    build(ctx, journal)
}

fn retire_info(journal: &Journal) -> (Vec<RetireConflict>, Option<String>) {
    match journal.retire.as_ref() {
        Some(report) => (
            report.conflicts.clone(),
            Some(report.directory.clone()).filter(|directory| !directory.is_empty()),
        ),
        None => (Vec::new(), None),
    }
}

fn build(ctx: &Ctx, journal: Option<Journal>) -> Result<Snapshot, String> {
    let legacy_workspace_id = journal.as_ref().map(|journal| journal.workspace_id.clone());
    let loaded = registry::load(&ctx.documents, &ctx.config)?;
    let workspaces = loaded.registry().map(|registry| {
        registry.workspaces.iter().map(|workspace| registry::info(&ctx.documents, workspace))
            .collect::<Result<Vec<_>, _>>()
    }).transpose()?.unwrap_or_default();
    let workspace = match loaded.registry().and_then(|registry| registry.active()) {
        Some(workspace) => Some(registry::info(&ctx.documents, workspace)?),
        None => None,
    };
    // Without a journal the install may still hold notes dropped in the legacy
    // root; a synthetic retired journal makes them visible (and importable).
    let journal = match journal {
        Some(journal) => Some(journal),
        None => migration::journal_for_imports(ctx)?,
    };

    let mut snapshot = Snapshot {
        required: true,
        done: false,
        phase: None,
        workspace,
        workspaces,
        epoch: loaded.registry().map(|registry| registry.epoch).unwrap_or(0),
        legacy_workspace_id,
        items: Vec::new(),
        blocks: Vec::new(),
        strays: Vec::new(),
        retire_conflicts: Vec::new(),
        draft_conflict_names: Vec::new(),
        restore_dir: None,
        drive_paused: drive_sync_paused(&ctx.documents, &ctx.config),
        error: None,
    };

    if let Some(journal) = journal {
        if snapshot.workspace.as_ref().is_some_and(|workspace| workspace.id == journal.workspace_id) {
            snapshot.draft_conflict_names = journal.items.iter()
                .filter(|item| matches!(item.decision, Decision::KeepBoth | Decision::AdoptDestination))
                .map(|item| item.name.clone())
                .collect();
        }
        snapshot.phase = Some(journal.phase);
        snapshot.error = journal.error.clone();
        let (retire_conflicts, restore_dir) = retire_info(&journal);
        snapshot.retire_conflicts = retire_conflicts;
        snapshot.restore_dir = restore_dir;
        snapshot.strays = migration::strays(ctx, &journal)?;
        if !journal.done() {
            snapshot.items = migration::statuses(ctx, &journal)?;
            snapshot.blocks = migration::gate(ctx, &journal)?.blocks;
        }
        snapshot.done = journal.done() && snapshot.workspace.as_ref()
            .is_some_and(|workspace| workspace.status == WorkspaceStatus::Ready);
    } else {
        // Nothing migrated and nothing to migrate: only usable if a workspace
        // was reconstructed from its marker.
        snapshot.done = snapshot.workspace.as_ref()
            .is_some_and(|workspace| workspace.status == WorkspaceStatus::Ready);
    }
    snapshot.required = !snapshot.done;
    Ok(snapshot)
}

/// Workspace directory that note commands may write to.
///
/// Fails closed: no registry, no marker, or a read-only workspace all produce
/// an error instead of silently falling back to the legacy root.
pub fn editable_notes_dir(documents: &Path, config: &Path) -> Result<PathBuf, String> {
    require_retired_journal(documents, config)?;
    let loaded = registry::load(documents, config)?;
    let registry = loaded.registry().ok_or_else(|| NOT_READY.to_string())?;
    let workspace = registry.active().ok_or_else(|| NOT_READY.to_string())?;
    if workspace.write_policy() != WritePolicy::Editable {
        return Err(
            "Este espacio de trabajo es de solo lectura hasta que se reconecte la cuenta"
                .to_string(),
        );
    }
    if registry::status_of(documents, workspace)? != WorkspaceStatus::Ready {
        return Err(NOT_READY.to_string());
    }
    paths::workspace_dir(documents, &workspace.id)
}

/// Directory of the committed, ready workspace. Never selects the legacy root.
pub fn notes_dir(documents: &Path, config: &Path) -> Result<PathBuf, String> {
    require_retired_journal(documents, config)?;
    if let Some(directory) = registry::active_ready_dir(documents, config)? {
        return Ok(directory);
    }
    Err(NOT_READY.to_string())
}

fn require_retired_journal(documents: &Path, config: &Path) -> Result<(), String> {
    let ctx = Ctx::new(documents.to_path_buf(), config.to_path_buf());
    if migration::load(&ctx)?.is_some_and(|journal| !journal.done()) {
        return Err(NOT_READY.to_string());
    }
    Ok(())
}

/// F1's Drive engine still targets the legacy root. F4 must bind it to a
/// workspace before this gate can ever be opened.
pub fn drive_sync_paused(_documents: &Path, _config: &Path) -> bool {
    true
}

pub fn notes_dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let runtime = Runtime::from_app(app)?;
    notes_dir(&runtime.documents, &runtime.config)
}

pub fn editable_notes_dir_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let runtime = Runtime::from_app(app)?;
    editable_notes_dir(&runtime.documents, &runtime.config)
}

/// Call under MANIFEST_LOCK before resolving a note path for a mutating IPC.
pub fn ensure_active_workspace_for(app: &tauri::AppHandle, expected_id: &str) -> Result<(), String> {
    let runtime = Runtime::from_app(app)?;
    ensure_active_workspace(&runtime.documents, &runtime.config, expected_id)
}

pub fn ensure_active_workspace(documents: &Path, config: &Path, expected_id: &str) -> Result<(), String> {
    ids::validate_id(expected_id)?;
    require_retired_journal(documents, config)?;
    let loaded = registry::load(documents, config)?;
    let registry = loaded.registry().ok_or_else(|| NOT_READY.to_string())?;
    if registry.active_workspace_id != expected_id {
        return Err("The note operation belongs to another workspace".into());
    }
    let workspace = registry.active().ok_or_else(|| NOT_READY.to_string())?;
    if registry::status_of(documents, workspace)? != WorkspaceStatus::Ready {
        return Err(NOT_READY.into());
    }
    Ok(())
}

pub fn drive_sync_paused_for(app: &tauri::AppHandle) -> bool {
    let Ok(runtime) = Runtime::from_app(app) else {
        return true;
    };
    drive_sync_paused(&runtime.documents, &runtime.config)
}

fn full_snapshot(runtime: Runtime) -> Result<Snapshot, String> {
    management::recover(&runtime.ctx())?;
    snapshot(&runtime.documents, &runtime.config, &Faults::none())
}

fn snapshot_after<F>(runtime: &Runtime, work: F) -> Result<Snapshot, String>
where
    F: FnOnce(&Ctx) -> Result<(), String>,
{
    let ctx = runtime.ctx();
    work(&ctx)?;
    advance_after(&ctx)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Current state of the installation. Also the only place where the migration
/// makes progress on its own.
#[tauri::command]
pub async fn workspace_get_state(app: tauri::AppHandle, state: tauri::State<'_, RuntimeState>) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || full_snapshot(runtime))
        .await
        .map_err(|e| format!("No se pudo revisar la migración: {e}"))?
}

/// Explicit retry, e.g. after a transient filesystem error.
#[tauri::command]
pub async fn migration_retry(app: tauri::AppHandle, state: tauri::State<'_, RuntimeState>) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || full_snapshot(runtime))
        .await
        .map_err(|e| format!("No se pudo reintentar la migración: {e}"))?
}

#[tauri::command]
pub async fn migration_resolve_item(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    name: String,
    action: migration::Action,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_after(&runtime, |ctx| {
            migration::resolve_item(ctx, &name, action, &Faults::none()).map(|_| ())
        })
    })
    .await
    .map_err(|e| format!("No se pudo aplicar la decisión: {e}"))?
}

#[tauri::command]
pub async fn migration_import_stray(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    name: String,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_after(&runtime, |ctx| {
            let mut journal = migration::journal_for_imports(ctx)?
                .ok_or_else(|| "Todavía no hay un espacio de trabajo".to_string())?;
            migration::import_stray(ctx, &mut journal, &name)
        })
    })
    .await
    .map_err(|e| format!("No se pudo importar la nota: {e}"))?
}

#[tauri::command]
pub async fn migration_defer_stray(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    name: String,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_after(&runtime, |ctx| {
            let mut journal = migration::journal_for_imports(ctx)?
                .ok_or_else(|| "Todavía no hay un espacio de trabajo".to_string())?;
            migration::defer_stray(ctx, &mut journal, &name)
        })
    })
    .await
    .map_err(|e| format!("No se pudo aplazar la nota: {e}"))?
}

#[tauri::command]
pub async fn migration_resolve_retire(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    name: String,
    action: migration::RetireAction,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        snapshot_after(&runtime, |ctx| {
            let mut journal = migration::journal_for_imports(ctx)?
                .ok_or_else(|| "Todavía no hay una migración".to_string())?;
            migration::resolve_retire(ctx, &mut journal, &name, action)
        })
    })
    .await
    .map_err(|e| format!("No se pudo resolver el conflicto: {e}"))?
}

#[tauri::command]
pub async fn workspace_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    name: String,
    kind: Option<types::WorkspaceKind>,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    let _transition = sync_context::COORDINATOR.begin_transition().await?;
    let _manifest = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        management::create_with_kind(&runtime.ctx(), &name, kind.unwrap_or(types::WorkspaceKind::Local))?;
        full_snapshot(runtime)
    }).await.map_err(|e| format!("Could not create workspace: {e}"))?
}

#[tauri::command]
pub async fn workspace_rename(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    id: String,
    name: String,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    let _transition = sync_context::COORDINATOR.begin_transition().await?;
    let _manifest = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        management::rename(&runtime.ctx(), &id, &name)?;
        full_snapshot(runtime)
    }).await.map_err(|e| format!("Could not rename workspace: {e}"))?
}

#[tauri::command]
pub async fn workspace_select(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    id: String,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    let _transition = sync_context::COORDINATOR.begin_transition().await?;
    let _guard = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    management::select(&runtime.ctx(), &id)?;
    full_snapshot(runtime)
}

#[tauri::command]
pub async fn workspace_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
    id: String,
) -> Result<Snapshot, String> {
    let runtime = state.resolve(&app)?;
    let _transition = sync_context::COORDINATOR.begin_transition().await?;
    let _manifest = crate::gdrive::sync::MANIFEST_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        management::delete(&runtime.ctx(), &id)?;
        full_snapshot(runtime)
    }).await.map_err(|e| format!("Could not delete workspace: {e}"))?
}

#[cfg(test)]
mod tests;
