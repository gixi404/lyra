#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use sys_locale::get_locale;

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_system_lang() -> String {
    let lang: String = get_locale().unwrap_or_else(|| "invalid".to_string()).into();
    return lang;
}

fn main() -> () {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_system_lang])
        .invoke_handler(tauri::generate_handler![open_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
