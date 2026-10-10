#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use tauri::Manager;

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    match std::env::consts::OS {
        "windows" => {
            Command::new("explorer")
                .arg(path)
                .spawn()
                .map_err(|e: std::io::Error| e.to_string())?;
            Ok(())
        }
        "linux" => {
            let xdg_status = Command::new("xdg-open")
                .arg(&path)
                .status()
                .map_err(|e: std::io::Error| e.to_string())?;

            if xdg_status.success() {
                return Ok(());
            }

            Command::new("gio")
                .arg("open")
                .arg(path)
                .status()
                .map_err(|e: std::io::Error| e.to_string())
                .and_then(|status| {
                    if status.success() {
                        Ok(())
                    } else {
                        Err(format!(
                            "Failed to open folder with Linux desktop opener (xdg-open exit status: {xdg_status}; gio open exit status: {status})"
                        ))
                    }
                })
        }
        os => Err(format!("Unsupported OS for open_folder: {os}")),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
