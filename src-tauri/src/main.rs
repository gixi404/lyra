#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use sys_locale::get_locale;

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

#[tauri::command]
fn get_system_lang() -> String {
    let lang: String = get_locale().unwrap_or_else(|| "invalid".to_string()).into();
    return lang;
}

fn main() -> () {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_system_lang, open_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
