#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use tauri::Manager;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }

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
        .invoke_handler(tauri::generate_handler![open_folder, show_main_window])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
