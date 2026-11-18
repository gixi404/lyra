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

// Control centralizado de sincronización remota con Google Drive.
// Debe permanecer desactivado en esta versión: no se elimina la implementación,
// solo se impide cualquier operación remota (auth, red, sync, eventos) desde
// frontend y backend, incluso con credenciales o estados previos persistidos.
pub const REMOTE_SYNC_ENABLED: bool = false;

const LOCAL_DELETE_JOURNAL: &str = ".lyra_local_delete.json";
#[cfg(test)]
thread_local! { static LOCAL_DELETE_FAULT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
thread_local! { static LOCAL_DELETE_INTERFERENCE: std::cell::RefCell<Option<fn(&std::path::Path)>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
thread_local! { static LOCAL_DELETE_STAGED_INTERFERENCE: std::cell::RefCell<Option<fn(&std::path::Path)>> = const { std::cell::RefCell::new(None) }; }

fn local_delete_staged_interference_point(_path: &std::path::Path) {
    #[cfg(test)]
    LOCAL_DELETE_STAGED_INTERFERENCE.with(|hook| {
        if let Some(run) = hook.borrow_mut().take() { run(_path); }
    });
}

fn local_delete_interference_point(_path: &std::path::Path) {
    #[cfg(test)]
    LOCAL_DELETE_INTERFERENCE.with(|hook| {
        if let Some(run) = hook.borrow_mut().take() { run(_path); }
    });
}

fn local_delete_fault_point(phase: &str) -> Result<(), String> {
    #[cfg(test)]
    if LOCAL_DELETE_FAULT.with(|fault| *fault.borrow() == Some(phase)) {
        return Err(format!("Injected local delete failure at {phase}"));
    }
    let _ = phase;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LocalDeleteJournal {
    version: u32,
    name: String,
    physical_id: String,
    provenance_id: Option<String>,
    local_id: Option<String>,
    anchor: String,
    staged: String,
    #[serde(default)]
    content_sha256: Option<String>,
}

fn local_delete_journal_path(base: &std::path::Path) -> std::path::PathBuf { base.join(LOCAL_DELETE_JOURNAL) }

fn read_local_delete_journal(base: &std::path::Path) -> Result<Option<LocalDeleteJournal>, String> {
    match std::fs::read(local_delete_journal_path(base)) {
        Ok(bytes) => {
            let journal: LocalDeleteJournal = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid local delete journal: {e}"))?;
            if journal.version != 1 || journal.physical_id.is_empty()
                || !journal.anchor.starts_with(".lyra_local_delete_anchor_") || journal.anchor.contains('/') || journal.anchor.contains('\\')
                || !journal.staged.starts_with(".lyra_local_delete_staged_") || journal.staged.contains('/') || journal.staged.contains('\\') {
                return Err("Invalid local delete journal".into());
            }
            sync::resolve_safe_path(base, &journal.name)?;
            Ok(Some(journal))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read local delete journal: {e}")),
    }
}

fn clear_local_delete_journal(base: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(local_delete_journal_path(base)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot clear local delete journal: {e}")),
    }
}

fn link_unique_delete_recovery(source: &std::path::Path, original: &std::path::Path, label: &str) -> Result<std::path::PathBuf, String> {
    let stem = original.file_stem().ok_or("Invalid recovery note name")?.to_string_lossy();
    let extension = original.extension().map(|ext| format!(".{}", ext.to_string_lossy())).unwrap_or_default();
    let parent = original.parent().ok_or("Invalid recovery note parent")?;
    for index in 1..=1000 {
        let candidate = parent.join(format!("{stem} ({label} {index}){extension}"));
        match std::fs::hard_link(source, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot preserve ambiguous deletion as a visible note: {error}")),
        }
    }
    Err("Cannot find an available recovery note name".into())
}

fn quarantine_ambiguous_local_delete(base: &std::path::Path, reason: &str) -> Result<(), String> {
    let destination = base.join(format!(".lyra_local_delete_manual_{:032x}.json", rand::random::<u128>()));
    std::fs::rename(local_delete_journal_path(base), &destination)
        .map_err(|error| format!("{reason}; cannot isolate recovery journal: {error}"))?;
    Err(format!("{reason}; original data and staging files were preserved for manual recovery in {}", base.display()))
}

pub(crate) fn recover_local_delete_at(base: &std::path::Path) -> Result<(), String> {
    let journal = match read_local_delete_journal(base) {
        Ok(journal) => journal,
        Err(reason) if local_delete_journal_path(base).exists() => {
            return quarantine_ambiguous_local_delete(base, &reason);
        }
        Err(reason) => return Err(reason),
    };
    let Some(journal) = journal else { return Ok(()); };
    let path = sync::resolve_safe_path(base, &journal.name)?;
    let anchor = base.join(&journal.anchor);
    let staged = base.join(&journal.staged);
    if !anchor.is_file() {
        // The identity witness is gone. No metadata or current file is safe to touch.
        if staged.exists() {
            return quarantine_ambiguous_local_delete(base, "Local delete identity witness disappeared while staged data remains");
        }
        return clear_local_delete_journal(base);
    }
    if let Ok(meta) = std::fs::symlink_metadata(&staged) {
        if !meta.file_type().is_file() {
            return quarantine_ambiguous_local_delete(base, "Local delete staging path changed type");
        }
        if !crate::local_identity::same_physical(&staged, &anchor)? {
            let rescue = (|| -> Result<(), String> {
                link_unique_delete_recovery(&anchor, &path, "original recovered")?;
                if path.exists() {
                    link_unique_delete_recovery(&staged, &path, "staged recovered")?;
                } else {
                    std::fs::hard_link(&staged, &path)
                        .map_err(|error| format!("Cannot restore changed staging file: {error}"))?;
                }
                if let Some(id) = &journal.provenance_id {
                    provenance::retire_deleted_note_if_id(base, &journal.name, id)?;
                }
                if let Some(id) = &journal.local_id {
                    crate::local_identity::retire_deleted_note_if_id(base, &journal.name, id)?;
                }
                Ok(())
            })();
            if let Err(reason) = rescue {
                return quarantine_ambiguous_local_delete(base, &reason);
            }
            std::fs::remove_file(&staged).map_err(|e| format!("Cannot clear recovered staging file: {e}"))?;
            std::fs::remove_file(&anchor).map_err(|e| format!("Cannot clear recovered identity witness: {e}"))?;
            clear_local_delete_journal(base)?;
            return Err("An interrupted deletion encountered a different staging file; both versions were preserved as visible notes".into());
        }
        // An interrupted rename has not completed deletion. Restore without
        // overwriting another file, regardless of which identity was staged.
        if !path.exists() {
            std::fs::hard_link(&staged, &path).map_err(|e| format!("Cannot restore interrupted local deletion: {e}"))?;
        } else if !crate::local_identity::same_physical(&path, &staged)? {
            return Err("Local deletion needs manual recovery: both paths contain files".into());
        }
        std::fs::remove_file(&staged).map_err(|e| format!("Cannot clear restored local staging file: {e}"))?;
        std::fs::remove_file(&anchor).map_err(|e| format!("Cannot clear local delete anchor: {e}"))?;
        return clear_local_delete_journal(base);
    }
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_file() => {
            if crate::local_identity::same_physical(&path, &anchor)? {
                std::fs::remove_file(&anchor).map_err(|e| format!("Cannot clear local delete anchor: {e}"))?;
                return clear_local_delete_journal(base);
            }
        }
        Ok(_) => return Err("Local delete recovery found a changed path type".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(format!("Cannot inspect local delete recovery: {e}")),
    }
    if let Some(id) = &journal.provenance_id {
        local_delete_fault_point("provenance")?;
        provenance::retire_deleted_note_if_id(base, &journal.name, id)?;
    }
    if let Some(id) = &journal.local_id {
        crate::local_identity::retire_deleted_note_if_id(base, &journal.name, id)?;
    }
    std::fs::remove_file(&anchor).map_err(|e| format!("Cannot clear local delete anchor: {e}"))?;
    clear_local_delete_journal(base)
}

pub(crate) fn delete_local_note_at<F>(lyra_dir: &std::path::Path, file_name: &str, local_file_path: &std::path::Path, remove: F) -> Result<(), String>
where F: FnOnce(&std::path::Path) -> std::io::Result<()> {
    recover_local_delete_at(lyra_dir)?;
    let meta = match std::fs::symlink_metadata(local_file_path) {
        Ok(meta) if meta.file_type().is_file() => meta,
        Ok(_) => return Err("The local note path is not a regular file".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Cannot inspect local note: {e}")),
    };
    let _ = meta;
    let physical_id = crate::local_identity::physical_id_at_path(local_file_path)?;
    let ledger = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir))?;
    let provenance_id = ledger.and_then(|state| state.by_name.get(file_name).cloned());
    let local_id = crate::local_identity::registered_note_id(lyra_dir, file_name)?;
    let anchor_name = format!(".lyra_local_delete_anchor_{:032x}", rand::random::<u128>());
    let anchor = lyra_dir.join(&anchor_name);
    std::fs::hard_link(local_file_path, &anchor).map_err(|e| format!("Cannot preserve note identity before deletion: {e}"))?;
    let staged_name = format!(".lyra_local_delete_staged_{:032x}", rand::random::<u128>());
    let staged = lyra_dir.join(&staged_name);
    let content_sha256 = crate::local_identity::content_sha256(
        &std::fs::read(local_file_path).map_err(|e| format!("Cannot read note before deletion: {e}"))?);
    let journal = LocalDeleteJournal { version: 1, name: file_name.into(), physical_id, provenance_id, local_id, anchor: anchor_name, staged: staged_name, content_sha256: Some(content_sha256) };
    let bytes = serde_json::to_vec(&journal).map_err(|e| e.to_string())?;
    if let Err(e) = sync::write_file_atomic(&local_delete_journal_path(lyra_dir), &bytes) {
        let _ = std::fs::remove_file(&anchor);
        return Err(format!("Cannot prepare local deletion: {e}"));
    }
    if !crate::local_identity::same_physical(local_file_path, &anchor)? {
        clear_local_delete_journal(lyra_dir)?;
        std::fs::remove_file(&anchor).map_err(|e| format!("Cannot clear local delete anchor: {e}"))?;
        return Err("The note changed before local deletion".into());
    }
    local_delete_interference_point(local_file_path);
    crate::folders::rename_folder_no_replace(local_file_path, &staged)
        .map_err(|e| format!("Cannot stage local note deletion: {e}"))?;
    local_delete_fault_point("after_stage")?;
    local_delete_staged_interference_point(&staged);
    if !crate::local_identity::same_physical(&staged, &anchor)? {
        recover_local_delete_at(lyra_dir)?;
        return Err("The note changed while staging local deletion".into());
    }
    if journal.content_sha256.as_ref().is_none_or(|expected| {
        std::fs::read(&staged).ok().map(|bytes| crate::local_identity::content_sha256(&bytes)) != Some(expected.clone())
    }) {
        recover_local_delete_at(lyra_dir)?;
        return Err("The note content changed while staging local deletion".into());
    }
    if let Err(e) = remove(&staged) {
        recover_local_delete_at(lyra_dir)?;
        return Err(format!("No se pudo eliminar el archivo local: {e}"));
    }
    local_delete_fault_point("after_physical")?;
    recover_local_delete_at(lyra_dir)
}


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
pub async fn gdrive_login(_app: tauri::AppHandle, _client_request_id: Option<String>) -> Result<UserProfile, String> {
    if !REMOTE_SYNC_ENABLED {
        return Err("Google Drive está deshabilitado en esta versión".to_string());
    }
    let lyra_dir = resolve_lyra_dir(&_app)?;
    let profile = auth::start_oauth_flow(&_app).await?;

    // La sesión se abre con la identidad verificada (sub) recién guardada.
    // Iniciar sesión NO autoriza ninguna nota existente.
    let account = auth::verify_current_account(&_app)?;
    {
        // Serializado con sincronización, borrado y consentimiento: la sesión
        // nueva nunca se pisa con un guardado concurrente del libro.
        let _guard = sync::MANIFEST_LOCK.lock().await;
        provenance::start_account_session(&lyra_dir, &account.account_key, account.epoch)?;
    }

    // Trigger initial sync in background
    let app_clone = _app.clone();
    tokio::spawn(async move {
        let _ = run_sync_with_reason(app_clone, SyncReason::InitialConnection, _client_request_id).await;
    });
    Ok(profile)
}

#[tauri::command]
pub async fn gdrive_logout(_app: tauri::AppHandle) -> Result<bool, String> {
    // Sincronización remota deshabilitada: no revocar ni contactar Google; solo limpieza local segura.
    if !REMOTE_SYNC_ENABLED {
        let _ = {
            let _guard = sync::MANIFEST_LOCK.lock().await;
            let (state, _readable) = auth::take_auth_state_for_logout(&_app)?;
            if let Some(ref state) = state {
                let account_key = auth::get_account_key(&state.user);
                if let Ok(doc_dir) = _app.path().document_dir() {
                    let lyra_dir = doc_dir.join("lyra");
                    if sync::ensure_safe_base_dir(&lyra_dir).is_ok() {
                        let _ = provenance::end_account_session(&lyra_dir, &account_key);
                    }
                }
            }
            Ok::<(), String>(())
        };
        return Ok(true);
    }

    // Invalidate credentials and the account epoch while serialized with manifest work.
    let (state, readable) = {
        let _guard = sync::MANIFEST_LOCK.lock().await;
        let (state, readable) = auth::take_auth_state_for_logout(&_app)?;
        if let Some(ref state) = state {
        let account_key = auth::get_account_key(&state.user);
        if let Ok(doc_dir) = _app.path().document_dir() {
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
    if !REMOTE_SYNC_ENABLED {
        return Ok(());
    }
    auth::cancel_oauth_flow()
}

#[tauri::command]
pub async fn gdrive_get_status(_app: tauri::AppHandle) -> Result<SyncStatus, String> {
    if !REMOTE_SYNC_ENABLED {
        // Estado inerte: sin conexión remota, sin sincronización y sin lectura de credenciales
        // que pueda implicar operaciones de red o reactivar flujos experimentales.
        return Ok(SyncStatus {
            is_connected: false,
            is_syncing: false,
            user_email: None,
            user_name: None,
            user_photo: None,
            last_sync_timestamp: None,
            last_error: None,
            auto_sync_enabled: false,
            backend_version: Some(BACKEND_VERSION.to_string()),
            backend_build_timestamp: Some(BACKEND_BUILD_TIMESTAMP.to_string()),
        });
    }

    let auth_state = auth::load_auth_state(&_app)?;
    let is_connected = auth_state.is_some();
    let user_email = auth_state.as_ref().map(|s| s.user.email.clone());
    let user_name = auth_state.as_ref().and_then(|s| s.user.name.clone());
    let user_photo = auth_state.as_ref().and_then(|s| s.user.picture.clone());
    let auto_sync_enabled = auth_state
        .as_ref()
        .map(|s| s.auto_sync_enabled)
        .unwrap_or(true);

    let manifest = sync::load_manifest(&_app);
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
pub async fn gdrive_sync_now(_app: tauri::AppHandle, _reason: Option<String>, _request_id: Option<String>) -> Result<SyncResult, String> {
    if !REMOTE_SYNC_ENABLED {
        return Ok(SyncResult {
            sync_id: "disabled".to_string(),
            ..Default::default()
        });
    }
    let reason = if _reason.as_deref() == Some("authorization") {
        SyncReason::Authorization
    } else {
        SyncReason::Background
    };
    run_sync_with_reason(_app, reason, _request_id).await
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
        #[cfg(debug_assertions)]
        {
            let now_str = chrono::Utc::now().to_rfc3339();
            eprintln!("[GDrive Sync #{sync_id}] ({now_str}) Solicitud gdrive_sync_now recibida en backend.");
        }
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
                if let Err(_save_error) = update_manifest_last_error(&sync_manifest_path, Some(sanitized.clone())).await {
                    #[cfg(debug_assertions)]
                    eprintln!("[GDrive Sync #{sync_id}] Could not persist sync error: {_save_error}");
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

    if !REMOTE_SYNC_ENABLED {
        // Sincronización remota deshabilitada: solo borrado local y retiro de identidad/procedencia.
        // No se crean tombstones ni se realizan operaciones remotas, incluso con estado persistido.
        let _guard = sync::MANIFEST_LOCK.lock().await;
        return delete_local_note_at(&lyra_dir, &file_name, &local_file_path, |path| std::fs::remove_file(path));
    }

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
            if let Err(_e) = execute_remote_deletion(
                &lyra_dir, &manifest_path, &file_name, &pending, &account.account_key,
                || client.trash_file("", &did),
            ).await {
                #[cfg(debug_assertions)]
                eprintln!("[gdrive_delete_file] La eliminación remota de '{file_name}' queda pendiente: {_e}");
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
pub async fn gdrive_set_auto_sync(_app: tauri::AppHandle, _enabled: bool) -> Result<(), String> {
    if !REMOTE_SYNC_ENABLED {
        return Ok(());
    }
    auth::set_auto_sync_enabled(&_app, _enabled)
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
    _app: tauri::AppHandle,
) -> Result<Option<PendingAuthorizationView>, String> {
    if !REMOTE_SYNC_ENABLED {
        return Ok(None);
    }
    let account = match auth::verify_current_account(&_app) {
        Ok(account) => account,
        Err(_) => return Ok(None),
    };
    let lyra_dir = resolve_lyra_dir(&_app)?;
    provenance::load_pending_view(&lyra_dir, &account.account_key)
}

/// Autoriza explícitamente las notas de una solicitud concreta.
///
/// El backend revalida la solicitud; si el conjunto de notas cambió desde que se
/// mostró, no se autoriza nada.
#[tauri::command]
pub async fn gdrive_authorize_pending(
    _app: tauri::AppHandle,
    _request_id: String,
    _selected_ids: Vec<String>,
) -> Result<usize, String> {
    if !REMOTE_SYNC_ENABLED {
        return Ok(0);
    }
    let lyra_dir = resolve_lyra_dir(&_app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let account = auth::verify_current_account(&_app)?;
    provenance::authorize_selected_pending(&lyra_dir, &account.account_key, &_request_id, &_selected_ids, account.epoch)
}

#[tauri::command]
pub async fn gdrive_manage_local_notes(_app: tauri::AppHandle, _reopen_declined: bool) -> Result<LocalNoteManagementView, String> {
    if !REMOTE_SYNC_ENABLED {
        return Ok(LocalNoteManagementView {
            account_key: String::new(),
            account_email: None,
            notes: Vec::new(),
            request: None,
        });
    }
    let lyra_dir = resolve_lyra_dir(&_app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let account = auth::verify_current_account(&_app)?;
    let manifest = sync::load_manifest_for_account_dir(&lyra_dir, &account.account_key, Some(&account.email));
    provenance::inspect_local_notes(&lyra_dir, &account.account_key, Some(account.email), account.epoch, &manifest, _reopen_declined)
}

#[tauri::command]
pub async fn gdrive_is_internal_welcome(app: tauri::AppHandle, file_name: String) -> Result<bool, String> {
    // Operación local de procedencia; debe seguir disponible con sincronización remota deshabilitada.
    let lyra_dir = resolve_lyra_dir(&app)?;
    sync::resolve_safe_path(&lyra_dir, &file_name)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    provenance::is_verified_internal_welcome(&lyra_dir, &file_name)
}

/// Rechaza una solicitud concreta. No autoriza nada y no bloquea el uso local.
#[tauri::command]
pub async fn gdrive_decline_pending(
    _app: tauri::AppHandle,
    _request_id: String,
) -> Result<(), String> {
    if !REMOTE_SYNC_ENABLED {
        return Ok(());
    }
    let lyra_dir = resolve_lyra_dir(&_app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let account = auth::verify_current_account(&_app)?;
    provenance::decline_pending(&lyra_dir, &account.account_key, &_request_id)
}

/// Conserva la identidad y autorizaciones de una nota al renombrarla localmente.
#[tauri::command]
pub async fn gdrive_note_renamed(
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> Result<bool, String> {
    // Operación local de identidad/procedencia y renombrado físico; no depende de red remota.
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
    let account = if REMOTE_SYNC_ENABLED { auth::verify_current_account(&app).ok() } else { None };
    archive::projection(&lyra_dir, account.as_ref().map(|a| a.account_key.as_str()))
}

#[tauri::command]
pub async fn archive_set(app: tauri::AppHandle, file_name: String, archived: bool) -> Result<archive::ArchiveProjection, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let _archive_guard = archive::ARCHIVE_LOCK.lock().await;
    let account = if REMOTE_SYNC_ENABLED { auth::verify_current_account(&app).ok() } else { None };
    archive::set_archived(&lyra_dir, &file_name, archived, account.as_ref().map(|a| a.account_key.as_str()))?;
    if REMOTE_SYNC_ENABLED && IS_SYNCING.load(Ordering::SeqCst) {
        SYNC_QUEUED.store(true, Ordering::SeqCst);
    }
    archive::projection(&lyra_dir, account.as_ref().map(|a| a.account_key.as_str()))
}

#[tauri::command]
pub async fn archive_get_projection(app: tauri::AppHandle) -> Result<archive::ArchiveProjection, String> {
    let lyra_dir = resolve_lyra_dir(&app)?;
    let _guard = sync::MANIFEST_LOCK.lock().await;
    let _archive_guard = archive::ARCHIVE_LOCK.lock().await;
    let account = if REMOTE_SYNC_ENABLED { auth::verify_current_account(&app).ok() } else { None };
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


#[cfg(test)]
mod disabled_release_tests {
    use super::*;
    use std::fs;

    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "lyra_gdrive_disabled_{label}_{}_{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn remote_sync_kill_switch_is_disabled_in_backend() {
        assert!(!REMOTE_SYNC_ENABLED, "el backend debe mantener el kill-switch remoto deshabilitado");
    }

    #[test]
    fn disabled_status_is_inert_without_connection_or_sync() {
        let status = SyncStatus {
            is_connected: false,
            is_syncing: false,
            user_email: None,
            user_name: None,
            user_photo: None,
            last_sync_timestamp: None,
            last_error: None,
            auto_sync_enabled: false,
            backend_version: Some(BACKEND_VERSION.to_string()),
            backend_build_timestamp: Some(BACKEND_BUILD_TIMESTAMP.to_string()),
        };
        assert!(!status.is_connected);
        assert!(!status.is_syncing);
        assert!(!status.auto_sync_enabled);
        assert!(status.user_email.is_none());
        assert!(status.last_error.is_none());
    }

    #[test]
    fn archive_set_cannot_queue_remote_sync_when_disabled() {
        IS_SYNCING.store(true, Ordering::SeqCst);
        SYNC_QUEUED.store(false, Ordering::SeqCst);
        if REMOTE_SYNC_ENABLED && IS_SYNCING.load(Ordering::SeqCst) {
            SYNC_QUEUED.store(true, Ordering::SeqCst);
        }
        assert!(!SYNC_QUEUED.load(Ordering::SeqCst), "no debe encolar sync remoto con kill-switch deshabilitado");
        IS_SYNCING.store(false, Ordering::SeqCst);
        SYNC_QUEUED.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    #[allow(clippy::assertions_on_constants)]
    async fn disabled_delete_removes_local_file_retires_provenance_and_creates_no_remote_tombstone() {
        let dir = TestDir::new("delete");
        let lyra_dir = &dir.0;
        let file_name = "Nota local.txt";
        let local_path = lyra_dir.join(file_name);
        fs::write(&local_path, b"contenido local").unwrap();

        // Estado previo simulado: manifiesto con mapeo remoto y procedencia local (sin cuenta activa).
        let manifest_path = sync::get_legacy_manifest_path(lyra_dir);
        let mut manifest = sync::load_manifest_from_path(&manifest_path);
        manifest.files.insert(file_name.to_string(), types::FileManifestItem {
            drive_id: "remote-old".into(), md5: "x".into(), local_mtime: 1,
            remote_mtime: String::new(), local_size: 1,
        });
        sync::save_manifest_to_path(&manifest_path, &manifest).unwrap();
        provenance::record_local_write(lyra_dir, file_name, None, true).unwrap();

        // Exercise the same local deletion helper used by the disabled command.
        assert!(!REMOTE_SYNC_ENABLED);
        {
            let _guard = sync::MANIFEST_LOCK.lock().await;
            delete_local_note_at(lyra_dir, file_name, &local_path, |path| fs::remove_file(path)).unwrap();
        }

        assert!(!local_path.exists(), "el archivo local debe eliminarse");
        let after = sync::load_manifest_from_path(&manifest_path);
        assert!(after.pending_deletions.is_empty(), "no debe crear tombstones remotos");
        assert!(after.files.contains_key(file_name), "sin operación remota no debe mutar mapeos remotos existentes");
        let ledger = provenance::load_ledger(&provenance::get_ledger_path(lyra_dir)).unwrap().unwrap();
        let by_name_retired = !ledger.by_name.contains_key(file_name)
            || ledger.by_name.get(file_name).and_then(|id| ledger.notes.get(id)).map(|n| n.retired).unwrap_or(true);
        assert!(by_name_retired, "la identidad/procedencia local debe retirarse");
    }

    #[test]
    fn local_delete_failure_preserves_existing_provenance() {
        let dir = TestDir::new("delete_failure");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"keep").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        let (local_id, _) = crate::local_identity::open_note(&dir.0, name).unwrap();
        archive::set_archived(&dir.0, name, true, None).unwrap();
        let before = provenance::load_ledger(&provenance::get_ledger_path(&dir.0)).unwrap().unwrap();
        let note_id = before.by_name.get(name).unwrap().clone();

        let result = delete_local_note_at(&dir.0, name, &path, |_| {
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        let after = provenance::load_ledger(&provenance::get_ledger_path(&dir.0)).unwrap().unwrap();
        assert_eq!(after.by_name.get(name), Some(&note_id));
        assert!(!after.notes.get(&note_id).unwrap().retired);
        assert_eq!(crate::local_identity::registered_note_id(&dir.0, name).unwrap().as_deref(), Some(local_id.as_str()));
        assert!(archive::projection(&dir.0, None).unwrap().archived_names.contains(&name.to_string()));
    }

    #[test]
    fn local_delete_restart_retires_only_deleted_identity_after_path_reuse() {
        let dir = TestDir::new("delete_reuse");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"old").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        let old_id = provenance::load_ledger(&provenance::get_ledger_path(&dir.0)).unwrap().unwrap().by_name[name].clone();
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = Some("after_physical"));
        let result = delete_local_note_at(&dir.0, name, &path, |p| fs::remove_file(p));
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = None);
        assert!(result.is_err());
        assert!(!path.exists());
        assert!(local_delete_journal_path(&dir.0).exists());

        fs::write(&path, b"new").unwrap();
        recover_local_delete_at(&dir.0).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let ledger = provenance::load_ledger(&provenance::get_ledger_path(&dir.0)).unwrap().unwrap();
        assert!(ledger.notes[&old_id].retired);
        assert!(!ledger.by_name.contains_key(name));
        assert!(!local_delete_journal_path(&dir.0).exists());
        recover_local_delete_at(&dir.0).unwrap();
    }

    #[test]
    fn local_delete_metadata_failure_retries_without_deleting_any_file() {
        let dir = TestDir::new("delete_metadata_failure");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"old").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = Some("provenance"));
        let result = delete_local_note_at(&dir.0, name, &path, |p| fs::remove_file(p));
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = None);
        assert!(result.is_err());
        assert!(!path.exists());
        assert!(local_delete_journal_path(&dir.0).exists());
        recover_local_delete_at(&dir.0).unwrap();
        assert!(!local_delete_journal_path(&dir.0).exists());
    }

    #[test]
    fn local_delete_preserves_replacement_after_last_identity_check() {
        let dir = TestDir::new("delete_replacement");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"old").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        LOCAL_DELETE_INTERFERENCE.with(|hook| *hook.borrow_mut() = Some(|path| {
            fs::remove_file(path).unwrap();
            fs::write(path, b"new").unwrap();
        }));
        assert!(delete_local_note_at(&dir.0, name, &path, |p| fs::remove_file(p)).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let recovered = fs::read_dir(&dir.0).unwrap().flatten()
            .find(|entry| entry.file_name().to_string_lossy().contains("original recovered")).unwrap();
        assert_eq!(fs::read(recovered.path()).unwrap(), b"old");
        assert!(!local_delete_journal_path(&dir.0).exists());
        recover_local_delete_at(&dir.0).unwrap();
    }

    #[test]
    fn local_delete_restart_restores_staged_note_without_completing_deletion() {
        let dir = TestDir::new("delete_stage_restart");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"keep").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = Some("after_stage"));
        assert!(delete_local_note_at(&dir.0, name, &path, |p| fs::remove_file(p)).is_err());
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = None);
        assert!(!path.exists());
        recover_local_delete_at(&dir.0).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        assert!(!local_delete_journal_path(&dir.0).exists());
    }

    #[test]
    fn local_delete_recovery_does_not_restore_replaced_staging_file() {
        let dir = TestDir::new("delete_stage_replaced");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"original").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = Some("after_stage"));
        assert!(delete_local_note_at(&dir.0, name, &path, |p| fs::remove_file(p)).is_err());
        LOCAL_DELETE_FAULT.with(|fault| *fault.borrow_mut() = None);
        let journal = read_local_delete_journal(&dir.0).unwrap().unwrap();
        let staged = dir.0.join(&journal.staged);
        fs::remove_file(&staged).unwrap();
        fs::write(&staged, b"replacement").unwrap();
        assert!(recover_local_delete_at(&dir.0).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        let recovered = fs::read_dir(&dir.0).unwrap().flatten()
            .find(|entry| entry.file_name().to_string_lossy().contains("original recovered")).unwrap();
        assert_eq!(fs::read(recovered.path()).unwrap(), b"original");
        assert!(!local_delete_journal_path(&dir.0).exists());
        recover_local_delete_at(&dir.0).unwrap();
    }

    #[test]
    fn local_delete_preserves_in_place_change_to_staged_content() {
        let dir = TestDir::new("delete_stage_modified");
        let name = "note.txt";
        let path = dir.0.join(name);
        fs::write(&path, b"original").unwrap();
        provenance::record_local_write(&dir.0, name, None, true).unwrap();
        LOCAL_DELETE_STAGED_INTERFERENCE.with(|hook| *hook.borrow_mut() = Some(|staged| {
            fs::write(staged, b"external").unwrap();
        }));
        assert!(delete_local_note_at(&dir.0, name, &path, |p| fs::remove_file(p)).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert!(!local_delete_journal_path(&dir.0).exists());
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn no_pending_authorization_or_auth_dialog_state_when_disabled() {
        // Con kill-switch deshabilitado no se exponen solicitudes/eventos de autorización.
        assert!(!REMOTE_SYNC_ENABLED);
        let pending: Option<provenance::PendingAuthorizationView> = None;
        assert!(pending.is_none());
    }
}
