#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::Manager;

mod gdrive;
mod native_updater;


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
    let dir = documents.join("lyra");
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

    #[test]
    fn test_validate_update_url_parser() {
        use native_updater::validate_update_url;

        // Valid URLs
        let valid_github = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra-2.0.29-1.x86_64.rpm";
        assert!(validate_update_url(valid_github).is_ok());

        let valid_objects = "https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345/lyra.rpm";
        assert!(validate_update_url(valid_objects).is_ok());

        // Actual GitHub Release Asset CDN host
        let valid_release_assets = "https://release-assets.githubusercontent.com/github-production-release-asset/800827602/7004a272-738c-4122-b941-adec16c0c530?sp=r&rscd=attachment";
        assert!(validate_update_url(valid_release_assets).is_ok());

        let valid_github_releases = "https://github-releases.githubusercontent.com/12345/asset.rpm";
        assert!(validate_update_url(valid_github_releases).is_ok());

        // Host spoofing attempts
        let spoofed_domain = "https://github.com.attacker.com/gixi404/lyra/releases/download/v2.0.29/lyra.rpm";
        let err1 = validate_update_url(spoofed_domain).unwrap_err();
        assert!(err1.contains("Host no autorizado"));

        let spoofed_objects = "https://evil-objects.githubusercontent.com/asset/lyra.rpm";
        let err2 = validate_update_url(spoofed_objects).unwrap_err();
        assert!(err2.contains("Host no autorizado"));

        // Arbitrary githubusercontent subdomains with "release" must NOT be allowed (closed whitelist)
        let spoofed_wildcard = "https://arbitrary-release.githubusercontent.com/asset/lyra.rpm";
        let err_wildcard = validate_update_url(spoofed_wildcard).unwrap_err();
        assert!(err_wildcard.contains("Host no autorizado"));

        // Empty path on CDN host
        let empty_path = "https://objects.githubusercontent.com/";
        let err_empty = validate_update_url(empty_path).unwrap_err();
        assert!(err_empty.contains("Ruta vacía no permitida"));

        // Insecure scheme
        let http_url = "http://github.com/gixi404/lyra/releases/download/v2.0.29/lyra.rpm";
        let err3 = validate_update_url(http_url).unwrap_err();
        assert!(err3.contains("esquema debe ser estrictamente HTTPS"));

        // Wrong repository on github.com
        let foreign_repo = "https://github.com/malicious/fork/releases/download/v2.0.29/lyra.rpm";
        let err4 = validate_update_url(foreign_repo).unwrap_err();
        assert!(err4.contains("Ruta no permitida"));

        // Malformed URL
        assert!(validate_update_url("not a valid url").is_err());
    }

    #[test]
    fn test_validate_native_update_request_valid() {
        let url_rpm = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra-2.0.29-1.x86_64.rpm";
        let sig = "untrusted comment: signature\nRWRi...";
        let res_rpm = validate_native_update_request(url_rpm, sig, "rpm", native_updater::InstallationFormat::Rpm);
        assert_eq!(res_rpm.unwrap(), native_updater::InstallationFormat::Rpm);

        let url_deb = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra_2.0.29_amd64.deb";
        let res_deb = validate_native_update_request(url_deb, sig, "deb", native_updater::InstallationFormat::Deb);
        assert_eq!(res_deb.unwrap(), native_updater::InstallationFormat::Deb);

        // Also allows GitHub redirected objects domain
        let url_obj = "https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345/lyra.rpm";
        let res_obj = validate_native_update_request(url_obj, sig, "rpm", native_updater::InstallationFormat::Rpm);
        assert_eq!(res_obj.unwrap(), native_updater::InstallationFormat::Rpm);
    }

    #[test]
    fn test_validate_native_update_request_disallowed_urls() {
        let sig = "some_valid_looking_signature";
        let invalid_urls = [
            "http://github.com/gixi404/lyra/releases/download/v2.0.29/lyra.rpm",
            "https://attacker.com/malicious.rpm",
            "file:///tmp/malicious.rpm",
            "https://github.com/otherrepo/lyra/releases/download/v2.0.29/lyra.rpm",
            "https://github.com.evil.com/gixi404/lyra/releases/download/v2.0.29/lyra.rpm",
            "javascript:alert(1)",
        ];

        for url in invalid_urls {
            let res = validate_native_update_request(url, sig, "rpm", native_updater::InstallationFormat::Rpm);
            assert!(res.is_err(), "URL must be rejected: {url}");
        }
    }

    #[test]
    fn test_validate_native_update_request_empty_signature() {
        let url = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra.rpm";
        let res_empty = validate_native_update_request(url, "", "rpm", native_updater::InstallationFormat::Rpm);
        assert!(res_empty.is_err());
        assert!(res_empty.unwrap_err().contains("Firma criptográfica vacía"));

        let res_whitespace = validate_native_update_request(url, "   \n\t ", "rpm", native_updater::InstallationFormat::Rpm);
        assert!(res_whitespace.is_err());
        assert!(res_whitespace.unwrap_err().contains("Firma criptográfica vacía"));
    }

    #[test]
    fn test_validate_native_update_request_unsupported_formats() {
        let url = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra.exe";
        let sig = "valid_sig";
        for fmt in ["windows", "appimage", "dmg", "exe", "tar.gz", "unknown"] {
            let res = validate_native_update_request(url, sig, fmt, native_updater::InstallationFormat::Windows);
            assert!(res.is_err());
            assert!(res.unwrap_err().contains("Formato de actualización no soportado"));
        }
    }

    #[test]
    fn test_validate_native_update_request_format_mismatch() {
        let url_rpm = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra.rpm";
        let sig = "valid_sig";
        // Requesting RPM on Debian
        let res1 = validate_native_update_request(url_rpm, sig, "rpm", native_updater::InstallationFormat::Deb);
        assert!(res1.is_err());
        assert!(res1.unwrap_err().contains("no es compatible con la instalación activa"));

        // Requesting DEB on RPM
        let url_deb = "https://github.com/gixi404/lyra/releases/download/v2.0.29/lyra.deb";
        let res2 = validate_native_update_request(url_deb, sig, "deb", native_updater::InstallationFormat::Rpm);
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("no es compatible con la instalación activa"));

        // Requesting RPM on Windows
        let res3 = validate_native_update_request(url_rpm, sig, "rpm", native_updater::InstallationFormat::Windows);
        assert!(res3.is_err());
        assert!(res3.unwrap_err().contains("no es compatible con la instalación activa"));
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
fn get_installation_info() -> native_updater::InstallationInfo {
    native_updater::detect_installation_format()
}

#[tauri::command]
async fn check_native_update(
    format: Option<String>,
    current_version: Option<String>,
) -> Result<Option<native_updater::NativeUpdateInfo>, String> {
    let install_info = native_updater::detect_installation_format();
    let fmt = match format.as_deref() {
        Some("rpm") => native_updater::InstallationFormat::Rpm,
        Some("deb") => native_updater::InstallationFormat::Deb,
        _ => install_info.format,
    };
    let cur_ver = current_version.unwrap_or_else(|| gdrive::BACKEND_VERSION.to_string());
    native_updater::check_native_update(fmt, &cur_ver).await
}

pub fn validate_native_update_request(
    url: &str,
    signature: &str,
    format: &str,
    current_format: native_updater::InstallationFormat,
) -> Result<native_updater::InstallationFormat, String> {
    // 1. Validar URL con parser estricto y correspondencia de host exacto
    native_updater::validate_update_url(url)?;

    // 2. Validar que la firma criptográfica no esté vacía
    if signature.trim().is_empty() {
        return Err("Firma criptográfica vacía o no proporcionada".to_string());
    }

    // 3. Validar correspondencia estricta de formato del gestor de paquetes
    let fmt = match format {
        "rpm" => native_updater::InstallationFormat::Rpm,
        "deb" => native_updater::InstallationFormat::Deb,
        _ => return Err(format!("Formato de actualización no soportado: {format}")),
    };

    if current_format != fmt {
        return Err(format!(
            "El formato de actualización solicitado ({format}) no es compatible con la instalación activa ({current_format:?})"
        ));
    }

    Ok(fmt)
}

#[tauri::command]
async fn apply_native_update(
    url: String,
    signature: String,
    format: String,
) -> Result<(), String> {
    let _guard = native_updater::NativeUpdateLockGuard::try_acquire()?;
    let detected = native_updater::detect_installation_format();
    let fmt = validate_native_update_request(&url, &signature, &format, detected.format)?;
    let (_tmp_dir, pkg_path) = native_updater::download_and_verify_package(&url, &signature, fmt).await?;
    native_updater::install_package_elevated(&pkg_path, fmt)
}


#[tauri::command]
async fn create_note(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
) -> Result<(), String> {
    let doc_dir = app.path().document_dir().map_err(|e| format!("Cannot resolve Documents: {e}"))?;
    let lyra_dir = doc_dir.join("lyra");
    gdrive::sync::resolve_safe_path(&lyra_dir, &file_name)?;
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
    let account = gdrive::auth::verify_current_account(&app).ok();
    gdrive::sync::get_file_lock_coordinator().with_file_lock(&file_name, || {
        gdrive::provenance::create_local_note(
            &lyra_dir, &file_name, content.as_bytes(),
            account.as_ref().map(|a| a.account_key.as_str()),
        )
    })
}

#[tauri::command]
async fn create_internal_welcome(app: tauri::AppHandle, content: String) -> Result<bool, String> {
    use sha2::{Digest, Sha256};
    const NAME: &str = "¡Bienvenid@ a Lyra!.txt";
    const ORIGINAL_SHA256: &str = "abacc64832e3b1767687bc2bca1070b0413119090b229c70c7e8c162f6a76fa5";
    let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
    if digest != ORIGINAL_SHA256 { return Err("Invalid welcome content".into()); }
    let lyra_dir = app.path().document_dir().map_err(|e| e.to_string())?.join("lyra");
    gdrive::sync::ensure_safe_base_dir(&lyra_dir)?;
    let target = gdrive::sync::resolve_safe_path(&lyra_dir, NAME)?;
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
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
) -> Result<i64, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("No se pudo resolver Documentos: {e}"))?;
    let lyra_dir = doc_dir.join("lyra");
    let target_path = gdrive::sync::resolve_safe_path(&lyra_dir, &file_name)
        .map_err(|e| format!("Ruta o nombre de archivo inválido: {e}"))?;

    // Coordinación exclusiva por archivo para prevenir condiciones de carrera TOCTOU
    // con descargas o reemplazos concurrentes del motor de Google Drive.
    let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
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
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("No se pudo resolver Documentos: {e}"))?;
    let lyra_dir = doc_dir.join("lyra");

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

            let cleanup_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(doc_dir) = cleanup_handle.path().document_dir() {
                    let lyra_dir = doc_dir.join("lyra");
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
            get_installation_info,
            check_native_update,
            apply_native_update,
            create_internal_welcome,
            check_and_drain_recovered_notes,
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
