#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[cfg_attr(not(test), allow(dead_code))] // F3 quarantines the remote engine until F4.
mod gdrive;
mod workspaces;

#[derive(serde::Serialize)]
struct NoteStats {
    mtime: u128,
    birthtime: u128,
}

#[derive(serde::Serialize)]
struct NoteListing {
    files: Vec<String>,
    stats: std::collections::HashMap<String, NoteStats>,
}

fn timestamp_ms(value: Option<std::time::SystemTime>) -> u128 {
    value.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis()).unwrap_or(0)
}

fn list_note_files_with_stats_at(dir: &Path) -> Result<NoteListing, String> {
    let mut listing = NoteListing { files: Vec::new(), stats: std::collections::HashMap::new() };
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Could not list notes: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not read note entry: {e}"))?;
        if !entry.file_type().map_err(|e| format!("Could not inspect note entry: {e}"))?.is_file() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else { continue; };
        if name.starts_with('.') || !(name.ends_with(".txt") || name.ends_with(".md")) {
            continue;
        }
        let stats = match entry.metadata() {
            Ok(metadata) => {
                let mtime = timestamp_ms(metadata.modified().ok());
                NoteStats { mtime, birthtime: metadata.created().ok().map(|time| timestamp_ms(Some(time))).unwrap_or(mtime) }
            }
            Err(_) => NoteStats { mtime: 0, birthtime: 0 },
        };
        listing.stats.insert(name.clone(), stats);
        listing.files.push(name);
    }
    Ok(listing)
}

#[tauri::command]
async fn list_note_files_with_stats(app: tauri::AppHandle) -> Result<NoteListing, String> {
    let documents = app.path().document_dir()
        .map_err(|e| format!("Could not resolve Documents: {e}"))?;
    // Notes live in the active workspace, never in the legacy root.
    let dir = workspaces::notes_dir_for(&app)?;
    gdrive::sync::ensure_safe_base_dir(&dir)?;
    let allowed = documents.canonicalize().map_err(|e| format!("Could not inspect Documents: {e}"))?;
    let actual = dir.canonicalize().map_err(|e| format!("Could not inspect notes folder: {e}"))?;
    if !actual.starts_with(&allowed) {
        return Err("Notes folder is outside Documents".to_string());
    }
    tokio::task::spawn_blocking(move || list_note_files_with_stats_at(&dir)).await
        .map_err(|e| format!("Could not finish note listing: {e}"))?
}

fn is_path_allowed(target: &std::path::Path, allowed_base: &std::path::Path) -> bool {
    if let (Ok(canonical_target), Ok(canonical_base)) =
        (target.canonicalize(), allowed_base.canonicalize())
    {
        canonical_target.starts_with(canonical_base) && canonical_target.is_dir()
    } else {
        false
    }
}

#[tauri::command]
fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() || !path_buf.is_dir() {
        return Err("Path does not exist or is not a directory".to_string());
    }

    let documents_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("Could not resolve documents directory: {e}"))?;
    let allowed_lyra = documents_dir.join("lyra");
    let allowed_downloads = app.path().download_dir().ok();

    let is_allowed = is_path_allowed(&path_buf, &allowed_lyra)
        || allowed_downloads
            .as_ref()
            .map(|d| is_path_allowed(&path_buf, d))
            .unwrap_or(false);

    if !is_allowed {
        return Err("Access denied: path is outside authorized folders".to_string());
    }

    let canonical_path = path_buf
        .canonicalize()
        .map_err(|e| format!("Could not canonicalize path: {e}"))?;

    match std::env::consts::OS {
        "windows" => {
            Command::new("explorer")
                .arg(&canonical_path)
                .spawn()
                .map_err(|e: std::io::Error| e.to_string())?;
            Ok(())
        }
        "macos" => {
            let status = Command::new("open")
                .arg(&canonical_path)
                .status()
                .map_err(|e: std::io::Error| e.to_string())?;

            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "Failed to open folder on macOS (exit status: {status})"
                ))
            }
        }
        "linux" => {
            if let Ok(xdg_status) = Command::new("xdg-open").arg(&canonical_path).status() {
                if xdg_status.success() {
                    return Ok(());
                }
            }

            match Command::new("gio").arg("open").arg(&canonical_path).status() {
                Ok(gio_status) if gio_status.success() => Ok(()),
                Ok(gio_status) => Err(format!(
                    "Failed to open folder on Linux (gio open exit status: {gio_status})"
                )),
                Err(e) => Err(format!("Failed to open folder on Linux: {e}")),
            }
        }
        os => Err(format!("Unsupported OS for open_folder: {os}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn list_notes_batches_metadata_and_ignores_internal_files() {
        let dir = std::env::temp_dir().join(format!("lyra_listing_{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        assert!(list_note_files_with_stats_at(&dir).unwrap().files.is_empty());
        for index in 0..1000 {
            fs::write(dir.join(format!("note-{index}.txt")), "sample").unwrap();
        }
        fs::write(dir.join("canción.md"), "sample").unwrap();
        fs::write(dir.join(".gdrive_manifest.json"), "private").unwrap();
        fs::write(dir.join("image.png"), "private").unwrap();
        fs::create_dir(dir.join("folder.md")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("note-0.txt"), dir.join("linked.md")).unwrap();
        let listed = list_note_files_with_stats_at(&dir).unwrap();
        assert_eq!(listed.files.len(), 1001);
        assert_eq!(listed.stats.len(), 1001);
        assert!(listed.files.contains(&"canción.md".to_string()));
        assert!(!listed.files.contains(&".gdrive_manifest.json".to_string()));
        assert!(!listed.files.contains(&"linked.md".to_string()));
        assert!(listed.stats["canción.md"].mtime > 0);
        fs::rename(dir.join("note-0.txt"), dir.join("renamed.md")).unwrap();
        fs::remove_file(dir.join("note-1.txt")).unwrap();
        let updated = list_note_files_with_stats_at(&dir).unwrap();
        assert_eq!(updated.files.len(), 1000);
        assert!(updated.files.contains(&"renamed.md".to_string()));
        assert!(!updated.files.contains(&"note-0.txt".to_string()));
        assert!(!updated.files.contains(&"note-1.txt".to_string()));
        fs::write(dir.join("new.md"), "sample").unwrap();
        assert!(list_note_files_with_stats_at(&dir).unwrap().files.contains(&"new.md".to_string()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn list_notes_reports_missing_directory() {
        let dir = std::env::temp_dir().join(format!("lyra_missing_{}", rand::random::<u64>()));
        assert!(list_note_files_with_stats_at(&dir).is_err());
    }

    #[test]
    fn local_listing_does_not_depend_on_archive_or_drive_state() {
        let dir = std::env::temp_dir().join(format!("lyra_local_listing_{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Local.md"), "fictional note").unwrap();
        fs::write(dir.join(".lyra_archive_state.json"), "{invalid").unwrap();
        assert!(gdrive::archive::projection(&dir, None).is_err());
        let listed = list_note_files_with_stats_at(&dir).unwrap();
        assert_eq!(listed.files, ["Local.md"]);
        assert!(listed.stats.contains_key("Local.md"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_is_path_allowed_valid_subdir() {
        let temp_base = std::env::temp_dir().join("lyra_test_base");
        let temp_sub = temp_base.join("notes");
        let _ = fs::create_dir_all(&temp_sub);

        assert!(is_path_allowed(&temp_base, &temp_base));
        assert!(is_path_allowed(&temp_sub, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
    }

    #[test]
    fn test_is_path_allowed_outside() {
        let temp_base = std::env::temp_dir().join("lyra_test_base2");
        let temp_outside = std::env::temp_dir().join("lyra_test_outside");
        let _ = fs::create_dir_all(&temp_base);
        let _ = fs::create_dir_all(&temp_outside);

        assert!(!is_path_allowed(&temp_outside, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
        let _ = fs::remove_dir_all(&temp_outside);
    }

    #[test]
    fn test_is_path_allowed_path_traversal() {
        let temp_base = std::env::temp_dir().join("lyra_test_traversal");
        let temp_sub = temp_base.join("notes");
        let _ = fs::create_dir_all(&temp_sub);

        let escape_path = temp_sub.join("../../..");
        assert!(!is_path_allowed(&escape_path, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
    }

    #[test]
    fn test_is_path_allowed_prefix_trick() {
        let temp_base = std::env::temp_dir().join("lyra_test_pref");
        let temp_evil = std::env::temp_dir().join("lyra_test_pref_evil");
        let _ = fs::create_dir_all(&temp_base);
        let _ = fs::create_dir_all(&temp_evil);

        assert!(!is_path_allowed(&temp_evil, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
        let _ = fs::remove_dir_all(&temp_evil);
    }

    #[test]
    fn test_is_path_allowed_file_rejected() {
        let temp_base = std::env::temp_dir().join("lyra_test_file");
        let temp_file = temp_base.join("note.txt");
        let _ = fs::create_dir_all(&temp_base);
        let _ = fs::write(&temp_file, "content");

        assert!(!is_path_allowed(&temp_file, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
    }

    #[cfg(unix)]
    #[test]
    fn test_is_path_allowed_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp_base = std::env::temp_dir().join("lyra_test_sym");
        let temp_outside = std::env::temp_dir().join("lyra_test_sym_out");
        let _ = fs::create_dir_all(&temp_base);
        let _ = fs::create_dir_all(&temp_outside);

        let symlink_path = temp_base.join("link_to_outside");
        let _ = symlink(&temp_outside, &symlink_path);

        assert!(!is_path_allowed(&symlink_path, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
        let _ = fs::remove_dir_all(&temp_outside);
    }

    #[test]
    fn test_is_path_allowed_nonexistent() {
        let temp_base = std::env::temp_dir().join("lyra_test_nonexistent_base");
        let temp_fake = temp_base.join("fake_dir_12345");
        let _ = fs::create_dir_all(&temp_base);

        assert!(!is_path_allowed(&temp_fake, &temp_base));

        let _ = fs::remove_dir_all(&temp_base);
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn create_note(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
    expected_workspace_id: String,
) -> Result<(), String> {
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
    workspaces::ensure_active_workspace_for(&app, &expected_workspace_id)?;
    let lyra_dir = workspaces::editable_notes_dir_for(&app)?;
    gdrive::sync::ensure_safe_base_dir(&lyra_dir)?;
    gdrive::sync::resolve_safe_path(&lyra_dir, &file_name)?;
    let runtime = workspaces::Runtime::from_app(&app)?;
    let ctx = runtime.ctx();
    let request = workspaces::sync_context::current(&ctx.documents, &ctx.config)?;
    let kind = workspaces::sync_context::resolve(&ctx.documents, &ctx.config, &request)?.kind;
    let account = if kind == workspaces::types::WorkspaceKind::GoogleDrive {
        None // F4 authorizes the workspace, never a newly created note.
    } else {
        gdrive::auth::verify_current_account(&app).ok()
    };
    gdrive::sync::get_file_lock_coordinator().with_file_lock(&file_name, || {
        gdrive::provenance::create_local_note(
            &lyra_dir, &file_name, content.as_bytes(),
            account.as_ref().map(|a| a.account_key.as_str()),
        )
    })
}

/// Migration recovery notes are local-only, even when an OAuth session exists.
#[tauri::command]
async fn workspace_rescue_draft(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
    expected_workspace_id: String,
) -> Result<(), String> {
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
    workspaces::ensure_active_workspace_for(&app, &expected_workspace_id)?;
    let lyra_dir = workspaces::editable_notes_dir_for(&app)?;
    gdrive::sync::ensure_safe_base_dir(&lyra_dir)?;
    gdrive::sync::resolve_safe_path(&lyra_dir, &file_name)?;
    gdrive::sync::get_file_lock_coordinator().with_file_lock(&file_name, || {
        gdrive::provenance::create_local_note(&lyra_dir, &file_name, content.as_bytes(), None)
    })
}

#[tauri::command]
async fn create_internal_welcome(app: tauri::AppHandle, content: String, expected_workspace_id: String) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    const NAME: &str = "¡Bienvenid@ a Lyra!.txt";
    const ORIGINAL_SHA256: &str = "abacc64832e3b1767687bc2bca1070b0413119090b229c70c7e8c162f6a76fa5";
    let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
    if digest != ORIGINAL_SHA256 { return Err("Invalid welcome content".into()); }
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
    workspaces::ensure_active_workspace_for(&app, &expected_workspace_id)?;
    let lyra_dir = workspaces::editable_notes_dir_for(&app)?;
    gdrive::sync::ensure_safe_base_dir(&lyra_dir)?;
    let target = gdrive::sync::resolve_safe_path(&lyra_dir, NAME)?;
    gdrive::sync::get_file_lock_coordinator().with_file_lock(NAME, || {
        if target.exists() { return Ok(false); }
        gdrive::provenance::create_local_note(&lyra_dir, NAME, content.as_bytes(), None)?;
        gdrive::provenance::mark_internal_welcome(&lyra_dir, NAME, content.as_bytes())?;
        Ok(true)
    })
}

#[tauri::command]
async fn save_note_atomic(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
    expected_workspace_id: String,
) -> Result<i64, String> {
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
    workspaces::ensure_active_workspace_for(&app, &expected_workspace_id)?;
    let lyra_dir = workspaces::editable_notes_dir_for(&app)?;
    let target_path = gdrive::sync::resolve_safe_path(&lyra_dir, &file_name)
        .map_err(|e| format!("Ruta o nombre de archivo inválido: {e}"))?;

    // Coordinación exclusiva por archivo para prevenir condiciones de carrera TOCTOU
    // con descargas o reemplazos concurrentes del motor de Google Drive.
    let mtime = gdrive::sync::get_file_lock_coordinator().with_file_lock(&file_name, || {
        // If the file was replaced externally, its old permissions are retired
        // before writing any new Lyra content into it.
        gdrive::provenance::invalidate_changed_note(&lyra_dir, &file_name)?;
        gdrive::sync::write_file_atomic(&target_path, content.as_bytes())
            .map_err(|e| format!("Error en guardado atómico de '{file_name}': {e}"))?;

        let mtime = std::fs::metadata(&target_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

        if let Err(e) = gdrive::provenance::record_local_write(&lyra_dir, &file_name, None, false) {
            eprintln!("[save_note_atomic] Note saved locally without updated cloud authorization: {e}");
        }
        Ok::<i64, String>(mtime)
    })?;

    Ok(mtime)
}

#[tauri::command]
fn check_and_drain_recovered_notes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let lyra_dir = workspaces::notes_dir_for(&app)?;

    // Escanear temporales huérfanos que hayan superado el TTL
    gdrive::sync::clean_stale_tmp_save_files(&lyra_dir);

    // Drenar las notas rescatadas que no se hayan notificado aún
    let recovered = gdrive::sync::drain_recovered_notes();
    Ok(recovered)
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        // En distribuciones Wayland modernas (Fedora, Arch, etc.), los paquetes AppImage
        // construidos en CI pueden incorporar librerías antiguas de Wayland incompatibles
        // con el compositor del host y drivers Mesa recientes, provocando el fallo
        // "Could not create default EGL display: EGL_BAD_PARAMETER" y pantalla negra.
        // Si detectamos la biblioteca nativa en el host y no está en LD_PRELOAD, relanzar
        // de forma transparente el proceso vinculando la biblioteca del sistema.
        if std::env::var("LYRA_WAYLAND_WRAPPED").is_err() {
            let candidate_libs = [
                "/usr/lib64/libwayland-client.so.0",
                "/lib64/libwayland-client.so.0",
                "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0",
                "/usr/lib/libwayland-client.so.0",
            ];

            if let Some(host_lib) = candidate_libs.iter().find(|p| std::path::Path::new(p).exists()) {
                let current_preload = std::env::var("LD_PRELOAD").unwrap_or_default();
                if !current_preload.contains("libwayland-client") {
                    let new_preload = if current_preload.is_empty() {
                        host_lib.to_string()
                    } else {
                        format!("{}:{}", host_lib, current_preload)
                    };

                    if let Ok(current_exe) = std::env::current_exe() {
                        use std::os::unix::process::CommandExt;
                        let mut cmd = std::process::Command::new(current_exe);
                        cmd.args(std::env::args().skip(1));
                        cmd.env("LD_PRELOAD", new_preload);
                        cmd.env("LYRA_WAYLAND_WRAPPED", "1");
                        let _ = cmd.exec();
                    }
                }
            }
        }

        // En Wayland/WebKitGTK, el renderizador DMA-BUF provoca que al redimensionar,
        // arrastrar o poner la ventana en pantalla completa, el compositor estire el buffer
        // antiguo durante unos milisegundos produciendo parpadeo y contenido deformado.
        // Desactivar el renderizador DMA-BUF fuerza el uso del buffer sincronizado de GTK.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            eprintln!(
                "[Lyra Backend] Iniciando v{} (compilado: {})",
                gdrive::BACKEND_VERSION,
                gdrive::BACKEND_BUILD_TIMESTAMP
            );

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }

            gdrive::sync::set_app_handle_for_recovery(app.handle().clone());

            // A missing system directory is shown by the workspace gate and
            // can be retried without selecting an alternate notes folder.
            let runtime_state = workspaces::RuntimeState::default();
            if let Err(error) = runtime_state.resolve(app.handle()) {
                eprintln!("[workspaces] {error}");
            }
            app.manage(runtime_state);

            let cleanup_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(lyra_dir) = workspaces::notes_dir_for(&cleanup_handle) {
                    gdrive::sync::clean_stale_tmp_save_files(&lyra_dir);
                }
            });

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                // Fallback de seguridad: si el frontend no solicita mostrar la ventana,
                // forzar visibilidad tras 800ms para evitar que la app quede oculta.
                std::thread::sleep(std::time::Duration::from_millis(800));
                let handle = app_handle.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        if !window.is_visible().unwrap_or(true) {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_folder,
            show_main_window,
            save_note_atomic,
            list_note_files_with_stats,
            create_note,
            workspace_rescue_draft,
            create_internal_welcome,
            check_and_drain_recovered_notes,
            workspaces::workspace_get_state,
            workspaces::migration_retry,
            workspaces::migration_resolve_item,
            workspaces::migration_import_stray,
            workspaces::migration_defer_stray,
            workspaces::migration_resolve_retire,
            workspaces::workspace_create,
            workspaces::workspace_rename,
            workspaces::workspace_select,
            workspaces::workspace_delete,
            gdrive::get_backend_build_info,
            gdrive::gdrive_login,
            gdrive::gdrive_logout,
            gdrive::gdrive_cancel_login,
            gdrive::gdrive_get_status,
            gdrive::gdrive_sync_now,
            gdrive::gdrive_delete_file,
            gdrive::gdrive_set_auto_sync,
            gdrive::gdrive_get_pending_authorizations,
            gdrive::gdrive_manage_local_notes,
            gdrive::gdrive_is_internal_welcome,
            gdrive::gdrive_authorize_pending,
            gdrive::gdrive_decline_pending,
            gdrive::gdrive_note_renamed,
            gdrive::archive_initialize,
            gdrive::archive_set,
            gdrive::archive_get_projection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
