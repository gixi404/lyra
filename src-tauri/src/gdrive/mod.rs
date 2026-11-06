pub mod auth;
pub mod archive;
pub mod client;
pub mod credential_store;
pub mod provenance;
pub mod sync;
pub mod types;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use types::{SyncResult, SyncStatus, UserProfile};
use provenance::{PendingAuthorizationView, LocalNoteManagementView};

static IS_SYNCING: AtomicBool = AtomicBool::new(false);
static SYNC_QUEUED: AtomicBool = AtomicBool::new(false);
static SYNC_QUEUED_CONTEXT: std::sync::Mutex<Option<(SyncReason, Option<String>)>> = std::sync::Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum SyncReason { Background = 0, InitialConnection = 1, Authorization = 2 }

fn prefer_queued_context(
    current: Option<(SyncReason, Option<String>)>,
    reason: SyncReason,
    request_id: Option<String>,
) -> Option<(SyncReason, Option<String>)> {
    if reason == SyncReason::Background { return current; }
    if current.as_ref().is_none_or(|(existing, _)| reason as u8 >= *existing as u8) {
        Some((reason, request_id))
    } else {
        current
    }
}

#[derive(Clone, serde::Serialize)]
struct SyncStartPayload<'a> { sync_id: &'a str, reason: SyncReason, request_id: Option<&'a str> }

struct SyncRunningGuard<'a>(&'a AtomicBool);

#[derive(Clone, serde::Serialize)]
struct SyncErrorPayload<'a> { sync_id: &'a str, message: &'a str }

impl Drop for SyncRunningGuard<'_> {
    fn drop(&mut self) {
        *SYNC_QUEUED_CONTEXT.lock().unwrap() = None;
        self.0.store(false, Ordering::SeqCst);
    }
}

fn begin_sync(flag: &AtomicBool) -> Option<SyncRunningGuard<'_>> {
    if flag.swap(true, Ordering::SeqCst) { None } else { Some(SyncRunningGuard(flag)) }
}

async fn update_manifest_last_error(
    path: &std::path::Path,
    last_error: Option<String>,
) -> Result<(), String> {
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let mut manifest = sync::load_manifest_from_path(path);
    manifest.last_error = last_error;
    sync::save_manifest_to_path(path, &manifest)
}

pub const BACKEND_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BACKEND_BUILD_TIMESTAMP: &str = env!("LYRA_BUILD_TIMESTAMP");

#[tauri::command]
pub fn get_backend_build_info() -> serde_json::Value {
    serde_json::json!({
        "version": BACKEND_VERSION,
        "build_timestamp": BACKEND_BUILD_TIMESTAMP,
    })
}

#[tauri::command]
pub async fn gdrive_login(app: tauri::AppHandle, client_request_id: Option<String>) -> Result<UserProfile, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let profile = auth::start_oauth_flow(&app).await?;

    // La sesión se abre con la identidad verificada (sub) recién guardada.
    // Iniciar sesión NO autoriza ninguna nota existente.
    let account = auth::verify_current_account(&app)?;
    {
        // Serializado con sincronización, borrado y consentimiento: la sesión
        // nueva nunca se pisa con un guardado concurrente del libro.
        let _guard = sync::MANIFEST_LOCK.lock().await;
        provenance::start_account_session(&lyra_dir, &account.account_key, account.epoch)?;
    }

    // Trigger initial sync in background
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = run_sync_with_reason(app_clone, SyncReason::InitialConnection, client_request_id).await;
    });
    Ok(profile)
}

#[tauri::command]
pub async fn gdrive_logout(app: tauri::AppHandle) -> Result<bool, String> {
    // Invalidate credentials and the account epoch while serialized with manifest work.
    let (state, readable) = {
        let _guard = sync::MANIFEST_LOCK.lock().await;
        let (state, readable) = auth::take_auth_state_for_logout(&app)?;
        if let Some(ref state) = state {
        let account_key = auth::get_account_key(&state.user);
        if let Ok(doc_dir) = app.path().document_dir() {
            let lyra_dir = doc_dir.join("lyra");
            if sync::ensure_safe_base_dir(&lyra_dir).is_ok() {
                let _ = provenance::end_account_session(&lyra_dir, &account_key);
            }
        }
        }
        (state, readable)
    };
    let remote_revoked = auth::revoke_logout_state(state).await;
    Ok(readable && remote_revoked)
}

#[tauri::command]
pub async fn gdrive_cancel_login() -> Result<(), String> {
    auth::cancel_oauth_flow()
}

#[tauri::command]
pub async fn gdrive_get_status(app: tauri::AppHandle) -> Result<SyncStatus, String> {
    let auth_state = auth::load_auth_state(&app)?;
    let is_connected = auth_state.is_some();
    let user_email = auth_state.as_ref().map(|s| s.user.email.clone());
    let user_name = auth_state.as_ref().and_then(|s| s.user.name.clone());
    let user_photo = auth_state.as_ref().and_then(|s| s.user.picture.clone());
    let auto_sync_enabled = auth_state
        .as_ref()
        .map(|s| s.auto_sync_enabled)
        .unwrap_or(true);

    let manifest = sync::load_manifest(&app);
    let last_sync_timestamp = if manifest.last_sync_timestamp > 0 {
        Some(manifest.last_sync_timestamp)
    } else {
        None
    };

    Ok(SyncStatus {
        is_connected,
        is_syncing: IS_SYNCING.load(Ordering::SeqCst),
        user_email,
        user_name,
        user_photo,
        last_sync_timestamp,
        last_error: manifest.last_error,
        auto_sync_enabled,
        backend_version: Some(BACKEND_VERSION.to_string()),
        backend_build_timestamp: Some(BACKEND_BUILD_TIMESTAMP.to_string()),
    })
}

#[tauri::command]
pub async fn gdrive_sync_now(app: tauri::AppHandle, reason: Option<String>, request_id: Option<String>) -> Result<SyncResult, String> {
    let reason = if reason.as_deref() == Some("authorization") {
        SyncReason::Authorization
    } else {
        SyncReason::Background
    };
    run_sync_with_reason(app, reason, request_id).await
}

async fn run_sync_with_reason(app: tauri::AppHandle, mut reason: SyncReason, mut request_id: Option<String>) -> Result<SyncResult, String> {
    let Some(_sync_guard) = begin_sync(&IS_SYNCING) else {
        #[cfg(debug_assertions)]
        eprintln!("[GDrive Sync] Sincronización en curso. Marcando SYNC_QUEUED=true para trailing sync.");
        let mut queued = SYNC_QUEUED_CONTEXT.lock().unwrap();
        *queued = prefer_queued_context(queued.take(), reason, request_id);
        drop(queued);
        SYNC_QUEUED.store(true, Ordering::SeqCst);
        return Ok(SyncResult {
            sync_id: "queued".to_string(),
            ..Default::default()
        });
    };

    let mut final_result;

    loop {
        SYNC_QUEUED.store(false, Ordering::SeqCst);

        let rand_num: u16 = rand::random();
        let sync_id = format!("sync-{}-{:04x}", chrono::Utc::now().format("%H%M%S"), rand_num);
        let now_str = chrono::Utc::now().to_rfc3339();

        #[cfg(debug_assertions)]
        eprintln!("[GDrive Sync #{sync_id}] ({now_str}) Solicitud gdrive_sync_now recibida en backend.");
        let _ = app.emit("gdrive:sync_started", SyncStartPayload {
            sync_id: &sync_id, reason, request_id: request_id.as_deref(),
        });

        // Ruta de manifiesto capturada antes de sincronizar: si la cuenta cambia
        // mientras la sincronización está en curso, el resultado se registra en el
        // manifiesto de la cuenta con la que realmente se sincronizó y nunca en el
        // de la cuenta nueva.
        let sync_manifest_path = match resolve_sync_manifest_path(&app) {
            Ok(path) => path,
            Err(error) => {
                let _ = app.emit("gdrive:sync_error", SyncErrorPayload { sync_id: &sync_id, message: &error });
                return Err(error);
            }
        };

        let result = sync::run_sync_with_id(&app, &sync_id).await;

        match result {
            Ok(mut res) => {
                res.sync_id = sync_id.clone();
                let last_error = (!res.errors.is_empty())
                    .then(|| sync::sanitize_error_message(&res.errors.join("; ")));
                if let Err(error) = update_manifest_last_error(&sync_manifest_path, last_error).await {
                    let _ = app.emit("gdrive:sync_error", SyncErrorPayload { sync_id: &sync_id, message: &error });
                    return Err(error);
                }

                #[cfg(debug_assertions)]
                eprintln!(
                    "[GDrive Sync #{sync_id}] Completado exitosamente. Subidos: {}, Descargados: {}, Conflictos: {}, Errores: {}",
                    res.uploaded.len(),
                    res.downloaded.len(),
                    res.conflicts.len(),
                    res.errors.len()
                );

                let _ = app.emit("gdrive:sync_finished", &res);
                final_result = res;
            }
            Err(e) => {
                let sanitized = sync::sanitize_error_message(&e);
                #[cfg(debug_assertions)]
                eprintln!("[GDrive Sync #{sync_id}] ERROR en run_sync: {sanitized}");
                if let Err(save_error) = update_manifest_last_error(&sync_manifest_path, Some(sanitized.clone())).await {
                    #[cfg(debug_assertions)]
                    eprintln!("[GDrive Sync #{sync_id}] Could not persist sync error: {save_error}");
                }

                let _ = app.emit("gdrive:sync_error", SyncErrorPayload { sync_id: &sync_id, message: &sanitized });
                return Err(sanitized);
            }
        }

        if !SYNC_QUEUED.load(Ordering::SeqCst) {
            break;
        }
        let queued = SYNC_QUEUED_CONTEXT.lock().unwrap().take();
        (reason, request_id) = queued.unwrap_or((SyncReason::Background, None));
        #[cfg(debug_assertions)]
        eprintln!("[GDrive Sync] Solicitudes rezagadas detectadas (SYNC_QUEUED=true). Iniciando trailing sync...");
    }

    Ok(final_result)
}

#[tauri::command]
pub async fn gdrive_delete_file(app: tauri::AppHandle, file_name: String) -> Result<(), String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("No se pudo resolver Documentos: {e}"))?;
    let lyra_dir = doc_dir.join("lyra");
    let local_file_path = sync::resolve_safe_path(&lyra_dir, &file_name)
        .map_err(|e| format!("Nombre de archivo inválido o peligroso: {e}"))?;

    let remote_deletion = {
        // 1. Cargar manifiesto con bloqueo
        let _guard = sync::MANIFEST_LOCK.lock().await;
        let account = auth::verify_current_account(&app).ok();
        let manifest_path = account.as_ref()
            .map(|a| sync::get_manifest_path_for_account(&lyra_dir, &a.account_key))
            .unwrap_or_else(|| sync::get_legacy_manifest_path(&lyra_dir));
        let mut manifest = if let Some(a) = &account {
            sync::load_manifest_for_account_dir(&lyra_dir, &a.account_key, Some(&a.email))
        } else {
            sync::load_manifest_from_path(&manifest_path)
        };

        // 2. Extraer drive_id si estaba registrado y conservar copia para posible rollback
        let drive_id = manifest.files.get(&file_name).map(|item| item.drive_id.clone());
        let previous_manifest_item = manifest.files.get(&file_name).cloned();

        let deletion_identity = match (&account, &drive_id) {
            (Some(account), Some(id)) => provenance::authorized_deletion(
                &lyra_dir, &file_name, &account.account_key, id,
            )?,
            _ => None,
        };

        // Retire before deletion so any later reuse of the name cannot inherit
        // permissions, even if the process stops between file and ledger writes.
        provenance::retire_note(&lyra_dir, &file_name)?;

        // Only a bound note may create a remote tombstone. A local deletion is
        // still allowed when no account is connected or the binding is absent.
        let now = chrono::Utc::now().timestamp_millis();
        let mut pending_for_remote = None;
        if let (Some(account), Some(note_id), Some(id)) = (&account, &deletion_identity, &drive_id) {
            let pending = types::PendingDeletion {
                drive_id: Some(id.clone()), deleted_at: now,
                account_key: Some(account.account_key.clone()), note_id: Some(note_id.clone()),
            };
            manifest.pending_deletions.insert(file_name.clone(), pending.clone());
            pending_for_remote = Some(pending);
            manifest.files.remove(&file_name);
        }

        // 4. Guardar manifiesto de forma atómica antes del borrado físico
        sync::save_manifest_to_path(&manifest_path, &manifest)?;

        // 5. Eliminar el archivo local del disco
        if local_file_path.exists() {
            if let Err(e) = std::fs::remove_file(&local_file_path) {
                // ROLLBACK: si falla la eliminación física local, revertir el manifiesto inmediatamente
                #[cfg(debug_assertions)]
                eprintln!("[gdrive_delete_file] Error eliminando '{}': {e}. Revertiendo tombstone en manifiesto...", local_file_path.display());
                manifest.pending_deletions.remove(&file_name);
                if let Some(prev) = previous_manifest_item {
                    manifest.files.insert(file_name.clone(), prev);
                }
                if let Err(save_err) = sync::save_manifest_to_path(&manifest_path, &manifest) {
                    #[cfg(debug_assertions)]
                    eprintln!("[gdrive_delete_file] Error al persistir el rollback del manifiesto: {save_err}");
                    return Err(format!("No se pudo eliminar el archivo local ({e}) y falló el guardado del rollback: {save_err}"));
                }
                return Err(format!("No se pudo eliminar el archivo local: {e}"));
            }
        }

        account.zip(pending_for_remote).map(|(account, pending)| (account, pending, manifest_path))
    };

    // 6. Si hay drive_id y credenciales activas, intentar enviar a papelera inmediatamente
    // La nota eliminada deja de estar asociada a esta cuenta.
    if let Some((account, pending, manifest_path)) = remote_deletion {
        if let Ok(client) = client::DriveClient::new_with_app_for_account(&app, &account.account_key, account.epoch) {
            let did = pending.drive_id.clone().ok_or("Missing remote deletion ID")?;
            if let Err(e) = execute_remote_deletion(
                &lyra_dir, &manifest_path, &file_name, &pending, &account.account_key,
                || client.trash_file("", &did),
            ).await {
                #[cfg(debug_assertions)]
                eprintln!("[gdrive_delete_file] La eliminación remota de '{file_name}' queda pendiente: {e}");
            }
        }
    }

    Ok(())
}

async fn execute_remote_deletion<F, Fut>(
    lyra_dir: &std::path::Path,
    manifest_path: &std::path::Path,
    file_name: &str,
    pending: &types::PendingDeletion,
    account_key: &str,
    trash: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let remote_id = pending.drive_id.as_deref().ok_or("Missing remote deletion ID")?;
    let ready = {
        let _guard = sync::MANIFEST_LOCK.lock().await;
        let current = sync::load_manifest_from_path(manifest_path);
        current.pending_deletions.get(file_name) == Some(pending)
            && sync::tombstone_allowed(lyra_dir, account_key, pending, remote_id)
    };
    if !ready { return Ok(false); }

    // The bound Drive client checks the account and auth epoch. The manifest
    // lock is free throughout HTTP, including retries and token refresh.
    trash().await?;

    let _guard = sync::MANIFEST_LOCK.lock().await;
    let mut current = sync::load_manifest_from_path(manifest_path);
    if current.pending_deletions.get(file_name) != Some(pending) { return Ok(false); }
    current.pending_deletions.remove(file_name);
    if current.files.get(file_name).is_some_and(|item| item.drive_id == remote_id) {
        current.files.remove(file_name);
    }
    sync::save_manifest_to_path(manifest_path, &current)?;
    Ok(true)
}

#[tauri::command]
pub async fn gdrive_set_auto_sync(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    auth::set_auto_sync_enabled(&app, enabled)
}

fn resolve_lyra_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("No se pudo resolver Documentos: {e}"))?;
    let lyra_dir = doc_dir.join("lyra");
    if !lyra_dir.exists() {
        std::fs::create_dir_all(&lyra_dir)
            .map_err(|e| format!("Cannot create notes directory: {e}"))?;
    }
    sync::ensure_safe_base_dir(&lyra_dir)?;
    Ok(lyra_dir)
}

/// Resuelve la ruta del manifiesto que corresponde a la cuenta verificada en este
/// instante. Se usa para capturar la ruta antes de iniciar una sincronización.
fn resolve_sync_manifest_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let lyra_dir = resolve_lyra_dir(app)?;
    if let Ok(account) = auth::verify_current_account(app) {
        return Ok(sync::get_manifest_path_for_account(
            &lyra_dir,
            &account.account_key,
        ));
    }
    Ok(sync::get_legacy_manifest_path(&lyra_dir))
}

/// Devuelve la solicitud de consentimiento pendiente para la cuenta activa.
#[tauri::command]
pub async fn gdrive_get_pending_authorizations(
    app: tauri::AppHandle,
) -> Result<Option<PendingAuthorizationView>, String> {
    let account = match auth::verify_current_account(&app) {
        Ok(account) => account,
        Err(_) => return Ok(None),
    };
    let lyra_dir = resolve_lyra_dir(&app)?;
    provenance::load_pending_view(&lyra_dir, &account.account_key)
}

/// Autoriza explícitamente las notas de una solicitud concreta.
///
/// El backend revalida la solicitud; si el conjunto de notas cambió desde que se
/// mostró, no se autoriza nada.
#[tauri::command]
pub async fn gdrive_authorize_pending(
    app: tauri::AppHandle,
    request_id: String,
    selected_ids: Vec<String>,
) -> Result<usize, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let account = auth::verify_current_account(&app)?;
    provenance::authorize_selected_pending(&lyra_dir, &account.account_key, &request_id, &selected_ids, account.epoch)
}

#[tauri::command]
pub async fn gdrive_manage_local_notes(app: tauri::AppHandle, reopen_declined: bool) -> Result<LocalNoteManagementView, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let account = auth::verify_current_account(&app)?;
    let manifest = sync::load_manifest_for_account_dir(&lyra_dir, &account.account_key, Some(&account.email));
    provenance::inspect_local_notes(&lyra_dir, &account.account_key, Some(account.email), account.epoch, &manifest, reopen_declined)
}

#[tauri::command]
pub async fn gdrive_is_internal_welcome(app: tauri::AppHandle, file_name: String) -> Result<bool, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    sync::resolve_safe_path(&lyra_dir, &file_name)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    provenance::is_verified_internal_welcome(&lyra_dir, &file_name)
}

/// Rechaza una solicitud concreta. No autoriza nada y no bloquea el uso local.
#[tauri::command]
pub async fn gdrive_decline_pending(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<(), String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let account = auth::verify_current_account(&app)?;
    provenance::decline_pending(&lyra_dir, &account.account_key, &request_id)
}

/// Conserva la identidad y autorizaciones de una nota al renombrarla localmente.
#[tauri::command]
pub async fn gdrive_note_renamed(
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> Result<bool, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let old_path = sync::resolve_safe_path(&lyra_dir, &old_name)?;
    let new_path = sync::ensure_safe_parent_hierarchy(&lyra_dir, &new_name)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    if new_path.exists() {
        return Err("Destination note already exists".to_string());
    }
    sync::get_file_lock_coordinator().with_file_lock(&old_name, || {
        provenance::invalidate_changed_note(&lyra_dir, &old_name)?;
        // Creating a hard link fails if the destination was created by an
        // external process after the existence check. Both paths are in the
        // same directory and no destination bytes are overwritten.
        std::fs::hard_link(&old_path, &new_path)
            .map_err(|e| format!("Cannot rename note: {e}"))?;
        if let Err(e) = std::fs::remove_file(&old_path) {
            let _ = std::fs::remove_file(&new_path);
            return Err(format!("Cannot complete note rename: {e}"));
        }
        provenance::rename_note(&lyra_dir, &old_name, &new_name)
    })
}

#[tauri::command]
pub async fn archive_initialize(app: tauri::AppHandle, archived_names: Vec<String>) -> Result<archive::ArchiveProjection, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let _archive_guard = archive::ARCHIVE_LOCK.lock().await;
    archive::initialize_legacy(&lyra_dir, &archived_names)?;
    let account = auth::verify_current_account(&app).ok();
    archive::projection(&lyra_dir, account.as_ref().map(|a| a.account_key.as_str()))
}

#[tauri::command]
pub async fn archive_set(app: tauri::AppHandle, file_name: String, archived: bool) -> Result<archive::ArchiveProjection, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let _archive_guard = archive::ARCHIVE_LOCK.lock().await;
    let account = auth::verify_current_account(&app).ok();
    archive::set_archived(&lyra_dir, &file_name, archived, account.as_ref().map(|a| a.account_key.as_str()))?;
    if IS_SYNCING.load(Ordering::SeqCst) { SYNC_QUEUED.store(true, Ordering::SeqCst); }
    archive::projection(&lyra_dir, account.as_ref().map(|a| a.account_key.as_str()))
}

#[tauri::command]
pub async fn archive_get_projection(app: tauri::AppHandle) -> Result<archive::ArchiveProjection, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let _archive_guard = archive::ARCHIVE_LOCK.lock().await;
    let account = auth::verify_current_account(&app).ok();
    archive::projection(&lyra_dir, account.as_ref().map(|a| a.account_key.as_str()))
}

#[cfg(test)]
mod phase5_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn sync_start_carries_explicit_reason_and_request_correlation() {
        let visible = serde_json::to_value(SyncStartPayload {
            sync_id: "sync-1", reason: SyncReason::Authorization,
            request_id: Some("authorization-current"),
        }).unwrap();
        assert_eq!(visible["reason"], "authorization");
        assert_eq!(visible["request_id"], "authorization-current");
        let background = serde_json::to_value(SyncStartPayload {
            sync_id: "sync-2", reason: SyncReason::Background, request_id: None,
        }).unwrap();
        assert_eq!(background["reason"], "background");
        assert!(background["request_id"].is_null());
    }

    #[test]
    fn queued_authorization_preserves_its_request_when_background_sync_overlaps() {
        let queued = prefer_queued_context(None, SyncReason::Authorization, Some("auth-1".into()));
        let queued = prefer_queued_context(queued, SyncReason::Background, None);
        assert_eq!(queued, Some((SyncReason::Authorization, Some("auth-1".into()))));
        let queued = prefer_queued_context(queued, SyncReason::InitialConnection, Some("login-1".into()));
        assert_eq!(queued, Some((SyncReason::Authorization, Some("auth-1".into()))));
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("lyra-aud006-{:032x}", rand::random::<u128>()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn sync_flag_is_released_after_early_return() {
        let flag = AtomicBool::new(false);
        let running = begin_sync(&flag).unwrap();
        assert!(begin_sync(&flag).is_none());
        assert!(flag.load(Ordering::SeqCst));
        drop(running);
        assert!(!flag.load(Ordering::SeqCst));
        assert!(begin_sync(&flag).is_some());
    }

    #[tokio::test]
    async fn sync_error_update_preserves_tombstone_written_during_wait() {
        let dir = TestDir::new();
        let path = sync::get_manifest_path_for_account(&dir.0, "account");
        sync::save_manifest_to_path(&path, &types::SyncManifest::default()).unwrap();
        let guard = sync::MANIFEST_LOCK.lock().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let path_for_task = path.clone();
        let task = tokio::spawn(async move {
            started_tx.send(()).unwrap();
            update_manifest_last_error(&path_for_task, Some("network failed".into())).await
        });
        started_rx.await.unwrap();
        let mut manifest = sync::load_manifest_from_path(&path);
        manifest.pending_deletions.insert("Note.md".into(), types::PendingDeletion {
            drive_id: Some("remote".into()), deleted_at: 1,
            account_key: Some("account".into()), note_id: Some("note".into()),
        });
        sync::save_manifest_to_path(&path, &manifest).unwrap();
        drop(guard);
        task.await.unwrap().unwrap();
        let saved = sync::load_manifest_from_path(&path);
        assert!(saved.pending_deletions.contains_key("Note.md"));
        assert_eq!(saved.last_error.as_deref(), Some("network failed"));
    }

    fn tombstone_fixture(dir: &Path) -> (PathBuf, types::PendingDeletion) {
        use provenance::{AccountBinding, AccountLinkState, AuthorizationSource, NoteOrigin};
        std::fs::write(dir.join("Note.md"), "contents").unwrap();
        provenance::record_local_write(dir, "Note.md", None, true).unwrap();
        let ledger_path = provenance::get_ledger_path(dir);
        let mut ledger = provenance::load_ledger(&ledger_path).unwrap().unwrap();
        let note_id = ledger.by_name["Note.md"].clone();
        ledger.notes.get_mut(&note_id).unwrap().bindings.insert("account".into(), AccountBinding {
            account_key: "account".into(), state: AccountLinkState::Authorized,
            origin: NoteOrigin::Downloaded, source: AuthorizationSource::AutomaticDownload,
            authorized_at: None, drive_id: Some("remote_old".into()), md5: None,
        });
        provenance::save_ledger(&ledger_path, &ledger).unwrap();
        provenance::retire_note(dir, "Note.md").unwrap();
        std::fs::remove_file(dir.join("Note.md")).unwrap();
        let pending = types::PendingDeletion {
            drive_id: Some("remote_old".into()), deleted_at: 1,
            account_key: Some("account".into()), note_id: Some(note_id),
        };
        let mut manifest = types::SyncManifest {
            account_id: Some("account".into()),
            ..Default::default()
        };
        manifest.pending_deletions.insert("Note.md".into(), pending.clone());
        let path = sync::get_manifest_path_for_account(dir, "account");
        sync::save_manifest_to_path(&path, &manifest).unwrap();
        (path, pending)
    }

    #[tokio::test]
    async fn slow_remote_delete_releases_manifest_lock_and_rechecks_changed_tombstone() {
        let dir = TestDir::new();
        let (path, pending) = tombstone_fixture(&dir.0);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let directory = dir.0.clone();
        let path_for_task = path.clone();
        let pending_for_task = pending.clone();
        let task = tokio::spawn(async move {
            execute_remote_deletion(&directory, &path_for_task, "Note.md", &pending_for_task, "account", || async move {
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(())
            }).await
        });
        started_rx.await.unwrap();
        let _guard = tokio::time::timeout(std::time::Duration::from_secs(1), sync::MANIFEST_LOCK.lock())
            .await.expect("HTTP must not hold the manifest lock");
        let mut changed = sync::load_manifest_from_path(&path);
        let mut replacement = pending.clone();
        replacement.deleted_at = 2;
        changed.pending_deletions.insert("Note.md".into(), replacement.clone());
        sync::save_manifest_to_path(&path, &changed).unwrap();
        drop(_guard);
        release_tx.send(()).unwrap();
        assert!(!task.await.unwrap().unwrap());
        assert_eq!(sync::load_manifest_from_path(&path).pending_deletions["Note.md"], replacement);
    }

    #[tokio::test]
    async fn remote_delete_error_keeps_tombstone_for_retry() {
        let dir = TestDir::new();
        let (path, pending) = tombstone_fixture(&dir.0);
        let result = execute_remote_deletion(&dir.0, &path, "Note.md", &pending, "account", || async {
            Err("HTTP timeout".to_string())
        }).await;
        assert!(result.is_err());
        assert_eq!(sync::load_manifest_from_path(&path).pending_deletions["Note.md"], pending);
        assert!(execute_remote_deletion(&dir.0, &path, "Note.md", &pending, "account", || async { Ok(()) }).await.unwrap());
        assert!(!sync::load_manifest_from_path(&path).pending_deletions.contains_key("Note.md"));
    }

    #[tokio::test]
    async fn invalidated_or_foreign_tombstone_never_sends_http() {
        let dir = TestDir::new();
        let (path, pending) = tombstone_fixture(&dir.0);
        let attempted = std::sync::atomic::AtomicBool::new(false);
        let wrong_account = execute_remote_deletion(&dir.0, &path, "Note.md", &pending, "foreign", || async {
            attempted.store(true, Ordering::SeqCst);
            Ok(())
        }).await.unwrap();
        assert!(!wrong_account);
        assert!(!attempted.load(Ordering::SeqCst));

        let mut changed = sync::load_manifest_from_path(&path);
        changed.pending_deletions.remove("Note.md");
        sync::save_manifest_to_path(&path, &changed).unwrap();
        let invalidated = execute_remote_deletion(&dir.0, &path, "Note.md", &pending, "account", || async {
            attempted.store(true, Ordering::SeqCst);
            Ok(())
        }).await.unwrap();
        assert!(!invalidated);
        assert!(!attempted.load(Ordering::SeqCst));
    }
}
