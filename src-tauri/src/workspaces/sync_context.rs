//! Workspace-scoped synchronization coordination. The remote engine stays
//! disabled until F4, but every future effect must pass through a permit.

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::{
    ids, paths, registry,
    types::{WorkspaceKind, WorkspaceStatus},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub workspace_id: String,
    pub epoch: u64,
}

/// Flattened context for every future progress/result/error event. The
/// frontend rejects events missing either field.
#[derive(Clone, Serialize)]
#[allow(dead_code)] // F4 emits this envelope when the remote engine is attached.
pub struct SyncEvent<T: Serialize> {
    pub workspace_id: String,
    pub epoch: u64,
    #[serde(flatten)]
    pub payload: T,
}

impl<T: Serialize> SyncEvent<T> {
    #[allow(dead_code)] // F4 constructs progress, result and error events.
    pub fn new(request: &SyncRequest, payload: T) -> Self {
        Self {
            workspace_id: request.workspace_id.clone(),
            epoch: request.epoch,
            payload,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedSyncRequest {
    pub request: SyncRequest,
    pub kind: WorkspaceKind,
    pub notes_dir: PathBuf,
}

/// Resolves only the ID supplied by the caller, never the legacy root or a
/// later active workspace. The epoch changes on every registry mutation.
pub fn resolve(
    documents: &std::path::Path,
    config: &std::path::Path,
    request: &SyncRequest,
) -> Result<ResolvedSyncRequest, String> {
    ids::validate_id(&request.workspace_id)?;
    let loaded = registry::load(documents, config)?;
    let book = loaded
        .registry()
        .ok_or("SyncStale: workspace registry is unavailable")?;
    if book.active_workspace_id != request.workspace_id || book.epoch != request.epoch {
        return Err("SyncStale: workspace context changed".into());
    }
    let workspace = book
        .active()
        .ok_or("SyncStale: active workspace is unavailable")?;
    if registry::status_of(documents, workspace)? != WorkspaceStatus::Ready {
        return Err("SyncStale: workspace needs repair".into());
    }
    Ok(ResolvedSyncRequest {
        request: request.clone(),
        kind: workspace.kind,
        notes_dir: paths::workspace_dir(documents, &request.workspace_id)?,
    })
}

pub fn current(
    documents: &std::path::Path,
    config: &std::path::Path,
) -> Result<SyncRequest, String> {
    let loaded = registry::load(documents, config)?;
    let book = loaded
        .registry()
        .ok_or("SyncStale: workspace registry is unavailable")?;
    Ok(SyncRequest {
        workspace_id: book.active_workspace_id.clone(),
        epoch: book.epoch,
    })
}

/// F3 never starts remote work. Changing the pause flag elsewhere cannot
/// silently make this command execute the legacy engine.
pub fn sync_gate(kind: WorkspaceKind) -> Result<(), String> {
    match kind {
        WorkspaceKind::Local => Err("SyncDisabled: este espacio es local".into()),
        WorkspaceKind::GoogleDrive => {
            Err("SyncPaused: Google Drive permanece en pausa hasta F4".into())
        }
    }
}

#[derive(Clone)]
struct Owner {
    serial: u64,
    request: SyncRequest,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct QueueState {
    serial: u64,
    owner: Option<Owner>,
    pending: Option<SyncRequest>,
}

pub struct SyncCoordinator {
    state: Mutex<QueueState>,
    critical: tokio::sync::Mutex<()>,
}

impl Default for SyncCoordinator {
    fn default() -> Self {
        Self {
            state: Mutex::new(QueueState::default()),
            critical: tokio::sync::Mutex::new(()),
        }
    }
}

pub enum Admission<'a> {
    Active(SyncPermit<'a>),
    Queued,
}

pub struct SyncPermit<'a> {
    coordinator: &'a SyncCoordinator,
    owner: Owner,
    finished: bool,
}

impl SyncCoordinator {
    pub fn submit(
        &self,
        request: SyncRequest,
        current: &SyncRequest,
    ) -> Result<Admission<'_>, String> {
        if &request != current {
            return Err("SyncStale: workspace context changed".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Sync coordinator is unavailable")?;
        if state.owner.is_some() {
            state.pending = Some(request);
            return Ok(Admission::Queued);
        }
        state.serial = state.serial.wrapping_add(1);
        let owner = Owner {
            serial: state.serial,
            request,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        state.owner = Some(owner.clone());
        Ok(Admission::Active(SyncPermit {
            coordinator: self,
            owner,
            finished: false,
        }))
    }

    /// Marks the owner stale before waiting for a download, upload, deletion or
    /// local commit that already entered its critical section to finish.
    pub async fn begin_transition(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Sync coordinator is unavailable")?;
            if let Some(owner) = &state.owner {
                owner.cancelled.store(true, Ordering::SeqCst);
            }
            state.pending = None;
        }
        Ok(self.critical.lock().await)
    }

    pub fn is_owner(&self, request: &SyncRequest) -> bool {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.owner.clone())
            .is_some_and(|owner| {
                owner.request == *request && !owner.cancelled.load(Ordering::SeqCst)
            })
    }
}

impl<'a> SyncPermit<'a> {
    pub fn still_valid(&self, current: &SyncRequest) -> Result<(), String> {
        if self.owner.cancelled.load(Ordering::SeqCst) || &self.owner.request != current {
            return Err("SyncStale: workspace context changed".into());
        }
        let state = self
            .coordinator
            .state
            .lock()
            .map_err(|_| "Sync coordinator is unavailable")?;
        if state
            .owner
            .as_ref()
            .is_none_or(|owner| owner.serial != self.owner.serial)
        {
            return Err("SyncStale: sync owner changed".into());
        }
        Ok(())
    }

    /// The context is rechecked after entering the same critical section used
    /// by workspace changes. Never hold MANIFEST_LOCK across remote HTTP.
    #[allow(dead_code)] // F4 attaches the remote engine to this checked effect API.
    pub async fn effect<T, F, Fut>(
        &self,
        current: impl Fn() -> Result<SyncRequest, String>,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let _critical = self.coordinator.critical.lock().await;
        self.still_valid(&current()?)?;
        let result = operation().await?;
        self.still_valid(&current()?)?;
        Ok(result)
    }

    #[allow(dead_code)] // F4 promotes queued requests after a remote run finishes.
    pub fn finish(mut self, current: &SyncRequest) -> Option<SyncPermit<'a>> {
        let mut state = self.coordinator.state.lock().ok()?;
        self.finished = true;
        if state
            .owner
            .as_ref()
            .is_none_or(|owner| owner.serial != self.owner.serial)
        {
            return None;
        }
        state.owner = None;
        let pending = state.pending.take().filter(|pending| pending == current)?;
        state.serial = state.serial.wrapping_add(1);
        let owner = Owner {
            serial: state.serial,
            request: pending,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        state.owner = Some(owner.clone());
        Some(SyncPermit {
            coordinator: self.coordinator,
            owner,
            finished: false,
        })
    }
}

impl Drop for SyncPermit<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if let Ok(mut state) = self.coordinator.state.lock() {
            if state
                .owner
                .as_ref()
                .is_some_and(|owner| owner.serial == self.owner.serial)
            {
                state.owner = None;
                state.pending = None;
            }
        }
    }
}

pub static COORDINATOR: std::sync::LazyLock<SyncCoordinator> =
    std::sync::LazyLock::new(SyncCoordinator::default);

#[cfg(test)]
mod tests;
