use std::path::{Path, PathBuf};
use std::process::Command;
use minisign_verify::{PublicKey, Signature};
use base64::Engine;

pub const LYRA_UPDATER_PUBKEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQxQ0FBQzcxQkUwQjQ3NUIKUldSYlJ3dStjYXpLMFN4ejREUHQwaXlsT2FjejhITHRaRzVpR3pwN204cmM0WWdQaytIWGZZY3kK";

pub const LATEST_MANIFEST_URL: &str =
    "https://github.com/gixi404/lyra/releases/latest/download/latest.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallationFormat {
    AppImage,
    Deb,
    Rpm,
    Windows,
    MacOS,
    Standalone,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InstallationInfo {
    pub format: InstallationFormat,
    pub is_package_managed: bool,
    pub bundle_type: Option<String>,
    pub supports_official_updater: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NativeUpdateInfo {
    pub version: String,
    pub url: String,
    pub signature: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub package_format: InstallationFormat,
}

#[derive(Debug, serde::Deserialize)]
struct ManifestPlatform {
    pub signature: String,
    pub url: String,
}

#[derive(Debug, serde::Deserialize)]
struct LatestManifest {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub platforms: std::collections::HashMap<String, ManifestPlatform>,
}

/// Detects the installation format and packaging mechanism of the running binary.
pub fn detect_installation_format() -> InstallationInfo {
    #[cfg(target_os = "windows")]
    {
        let bt = tauri::utils::platform::bundle_type();
        let bt_str = bt.as_ref().map(|b| format!("{b:?}"));
        InstallationInfo {
            format: InstallationFormat::Windows,
            is_package_managed: true,
            bundle_type: bt_str,
            supports_official_updater: true,
        }
    }

    #[cfg(target_os = "macos")]
    {
        let bt = tauri::utils::platform::bundle_type();
        let bt_str = bt.as_ref().map(|b| format!("{b:?}"));
        InstallationInfo {
            format: InstallationFormat::MacOS,
            is_package_managed: true,
            bundle_type: bt_str,
            supports_official_updater: true,
        }
    }

    #[cfg(target_os = "linux")]
    {
        use tauri::utils::config::BundleType;
        let bt = tauri::utils::platform::bundle_type();
        let bt_str = bt.as_ref().map(|b| format!("{b:?}"));

        // 1. AppImage check (Environment variables or bundle_type)
        if std::env::var("APPIMAGE").is_ok()
            || std::env::var("APPDIR").is_ok()
            || bt == Some(BundleType::AppImage)
        {
            return InstallationInfo {
                format: InstallationFormat::AppImage,
                is_package_managed: false,
                bundle_type: bt_str,
                supports_official_updater: true,
            };
        }

        // 2. Official bundle_type if detected by Tauri
        if bt == Some(BundleType::Deb) {
            return InstallationInfo {
                format: InstallationFormat::Deb,
                is_package_managed: true,
                bundle_type: bt_str,
                supports_official_updater: true,
            };
        }
        if bt == Some(BundleType::Rpm) {
            return InstallationInfo {
                format: InstallationFormat::Rpm,
                is_package_managed: true,
                bundle_type: bt_str,
                supports_official_updater: true,
            };
        }

        // 3. Fallback inspection: current executable location & package query
        if let Ok(exe) = std::env::current_exe() {
            let exe_str = exe.to_string_lossy();
            if exe_str.starts_with("/usr/") || exe_str.starts_with("/opt/") {
                // Check dpkg tracking
                if Path::new("/var/lib/dpkg").exists() {
                    let in_dpkg = Command::new("dpkg")
                        .args(["-S", &exe_str])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if in_dpkg {
                        return InstallationInfo {
                            format: InstallationFormat::Deb,
                            is_package_managed: true,
                            bundle_type: bt_str,
                            supports_official_updater: false, // fallback runner handles it
                        };
                    }
                }

                // Check rpm tracking
                if Path::new("/var/lib/rpm").exists() || Path::new("/usr/lib/sysimage/rpm").exists() {
                    let in_rpm = Command::new("rpm")
                        .args(["-qf", &exe_str])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if in_rpm {
                        return InstallationInfo {
                            format: InstallationFormat::Rpm,
                            is_package_managed: true,
                            bundle_type: bt_str,
                            supports_official_updater: false, // fallback runner handles it
                        };
                    }
                }

                // Distribution heuristics if not tracked explicitly in db
                if Path::new("/etc/debian_version").exists() {
                    return InstallationInfo {
                        format: InstallationFormat::Deb,
                        is_package_managed: true,
                        bundle_type: bt_str,
                        supports_official_updater: false,
                    };
                }
                if Path::new("/etc/fedora-release").exists() || Path::new("/etc/redhat-release").exists() {
                    return InstallationInfo {
                        format: InstallationFormat::Rpm,
                        is_package_managed: true,
                        bundle_type: bt_str,
                        supports_official_updater: false,
                    };
                }
            }
        }

        InstallationInfo {
            format: InstallationFormat::Standalone,
            is_package_managed: false,
            bundle_type: bt_str,
            supports_official_updater: false,
        }
    }
}

/// Compares two semver version strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
pub fn compare_semver(a: &str, b: &str) -> i32 {
    let clean_a = a.trim_start_matches('v');
    let clean_b = b.trim_start_matches('v');
    let parts_a: Vec<u64> = clean_a.split('.').filter_map(|s| s.parse().ok()).collect();
    let parts_b: Vec<u64> = clean_b.split('.').filter_map(|s| s.parse().ok()).collect();

    let max_len = parts_a.len().max(parts_b.len());
    for i in 0..max_len {
        let val_a = parts_a.get(i).copied().unwrap_or(0);
        let val_b = parts_b.get(i).copied().unwrap_or(0);
        if val_a > val_b {
            return 1;
        } else if val_a < val_b {
            return -1;
        }
    }
    0
}

fn base64_to_string(b64_string: &str) -> Result<String, String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let decoded = engine
        .decode(b64_string.trim())
        .map_err(|e| format!("Base64 decode error: {e}"))?;
    std::str::from_utf8(&decoded)
        .map(|s| s.to_string())
        .map_err(|e| format!("UTF-8 decode error: {e}"))
}

/// Verifies data using a minisign base64 public key and signature.
pub fn verify_minisign(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let pubkey_raw = if pubkey_b64.trim().starts_with("untrusted comment:") {
        pubkey_b64.trim().to_string()
    } else {
        base64_to_string(pubkey_b64)?
    };

    let public_key = PublicKey::decode(&pubkey_raw)
        .map_err(|e| format!("Invalid minisign public key format: {e}"))?;

    let sig_raw = if signature_b64.trim().starts_with("untrusted comment:") {
        signature_b64.trim().to_string()
    } else {
        base64_to_string(signature_b64)?
    };

    let signature = Signature::decode(&sig_raw)
        .map_err(|e| format!("Invalid minisign signature format: {e}"))?;

    public_key
        .verify(data, &signature, true)
        .map_err(|e| format!("Cryptographic signature verification failed: {e}"))?;

    Ok(())
}


/// Checks the latest.json manifest for available RPM or DEB updates.
pub async fn check_native_update(
    format: InstallationFormat,
    current_version: &str,
) -> Result<Option<NativeUpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;

    let resp = client
        .get(LATEST_MANIFEST_URL)
        .header("User-Agent", "lyra-updater")
        .send()
        .await
        .map_err(|e| format!("Error connecting to update server: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Update server returned HTTP status {}", resp.status()));
    }

    let manifest: LatestManifest = resp
        .json()
        .await
        .map_err(|e| format!("Could not parse release manifest JSON: {e}"))?;

    if compare_semver(&manifest.version, current_version) <= 0 {
        return Ok(None);
    }

    let target_key = match format {
        InstallationFormat::Rpm => "linux-x86_64-rpm",
        InstallationFormat::Deb => "linux-x86_64-deb",
        _ => return Err(format!("Unsupported format for native updater: {:?}", format)),
    };

    let platform = manifest.platforms.get(target_key)
        .ok_or_else(|| format!("Target platform '{target_key}' not found in latest.json"))?;

    Ok(Some(NativeUpdateInfo {
        version: manifest.version,
        url: platform.url.clone(),
        signature: platform.signature.clone(),
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        package_format: format,
    }))
}

/// Downloads the package, validates its minisign signature, and writes it to a secure temporary directory.
pub async fn download_and_verify_package(
    url: &str,
    signature_b64: &str,
    format: InstallationFormat,
) -> Result<(tempfile::TempDir, PathBuf), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;

    let resp = client
        .get(url)
        .header("User-Agent", "lyra-updater")
        .send()
        .await
        .map_err(|e| format!("Error downloading update package: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download server returned HTTP status {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Error reading downloaded package bytes: {e}"))?;

    // Verify cryptographic signature BEFORE writing or executing anything
    verify_minisign(&bytes, signature_b64, LYRA_UPDATER_PUBKEY)?;

    let ext = match format {
        InstallationFormat::Rpm => "rpm",
        InstallationFormat::Deb => "deb",
        _ => return Err("Invalid format for package download".to_string()),
    };

    let tmp_dir = tempfile::Builder::new()
        .prefix("lyra_secure_update_")
        .tempdir()
        .map_err(|e| format!("Could not create secure temp directory: {e}"))?;

    let pkg_path = tmp_dir.path().join(format!("lyra-update.{ext}"));
    std::fs::write(&pkg_path, &bytes)
        .map_err(|e| format!("Could not write update package to disk: {e}"))?;

    Ok((tmp_dir, pkg_path))
}

/// Executes installation of the verified package using elevated privileges via pkexec.
pub fn install_package_elevated(pkg_path: &Path, format: InstallationFormat) -> Result<(), String> {
    if !pkg_path.exists() {
        return Err("Package file does not exist".to_string());
    }

    let path_str = pkg_path.to_string_lossy();

    match format {
        InstallationFormat::Rpm => {
            // 1. Try DNF (Fedora/RHEL standard, resolves dependencies)
            let dnf_status = Command::new("pkexec")
                .args(["dnf", "install", "-y", &path_str])
                .status();

            if let Ok(status) = dnf_status {
                if status.success() {
                    return Ok(());
                }
                if let Some(code) = status.code() {
                    if code == 126 || code == 127 {
                        return Err("Actualización cancelada por el usuario (permisos no otorgados)".to_string());
                    }
                }
            }

            // 2. Try RPM direct upgrade
            let rpm_status = Command::new("pkexec")
                .args(["rpm", "-U", &path_str])
                .status();

            if let Ok(status) = rpm_status {
                if status.success() {
                    return Ok(());
                }
                if let Some(code) = status.code() {
                    if code == 126 || code == 127 {
                        return Err("Actualización cancelada por el usuario (permisos no otorgados)".to_string());
                    }
                }
            }

            // 3. Try Zypper (openSUSE)
            let zypper_status = Command::new("pkexec")
                .args(["zypper", "--non-interactive", "install", &path_str])
                .status();

            if let Ok(status) = zypper_status {
                if status.success() {
                    return Ok(());
                }
            }

            Err("No se pudo instalar el paquete RPM con permisos administrativos".to_string())
        }
        InstallationFormat::Deb => {
            // 1. Try apt install (Debian/Ubuntu standard, resolves local package & dependencies)
            let apt_status = Command::new("pkexec")
                .args(["apt", "install", "-y", &path_str])
                .status();

            if let Ok(status) = apt_status {
                if status.success() {
                    return Ok(());
                }
                if let Some(code) = status.code() {
                    if code == 126 || code == 127 {
                        return Err("Actualización cancelada por el usuario (permisos no otorgados)".to_string());
                    }
                }
            }

            // 2. Fallback to dpkg -i
            let dpkg_status = Command::new("pkexec")
                .args(["dpkg", "-i", &path_str])
                .status();

            if let Ok(status) = dpkg_status {
                if status.success() {
                    return Ok(());
                }
                if let Some(code) = status.code() {
                    if code == 126 || code == 127 {
                        return Err("Actualización cancelada por el usuario (permisos no otorgados)".to_string());
                    }
                }
            }

            Err("No se pudo instalar el paquete DEB con permisos administrativos".to_string())
        }
        _ => Err(format!("Elevated installation unsupported for {:?}", format)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compare_semver() {
        assert_eq!(compare_semver("2.0.18", "2.0.18"), 0);
        assert_eq!(compare_semver("v2.0.19", "2.0.18"), 1);
        assert_eq!(compare_semver("2.0.18", "v2.0.19"), -1);
        assert_eq!(compare_semver("2.1.0", "2.0.19"), 1);
        assert_eq!(compare_semver("3.0.0", "2.9.9"), 1);
        assert_eq!(compare_semver("2.0.18", "2.0.18.1"), -1);
    }

    #[test]
    fn test_minisign_verification_valid() {
        let pubkey = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
        let signature = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
        let data = b"test";

        assert!(verify_minisign(data, signature, pubkey).is_ok());
    }

    #[test]
    fn test_minisign_verification_corrupted_data_fails() {
        let pubkey = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
        let signature = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
        let corrupted_data = b"tampered test payload";

        let result = verify_minisign(corrupted_data, signature, pubkey);
        assert!(result.is_err());
    }

    #[test]
    fn test_minisign_verification_with_base64_encoded_pubkey_and_sig() {
        let pubkey_raw = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
        let signature_raw = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
        let data = b"test";

        let engine = base64::engine::general_purpose::STANDARD;
        let pubkey_b64 = engine.encode(pubkey_raw);
        let sig_b64 = engine.encode(signature_raw);

        assert!(verify_minisign(data, &sig_b64, &pubkey_b64).is_ok());
    }

    #[test]
    fn test_detection_structure() {
        let info = detect_installation_format();
        // Just verify it returns a valid variant without panicking
        assert!([
            InstallationFormat::AppImage,
            InstallationFormat::Deb,
            InstallationFormat::Rpm,
            InstallationFormat::Windows,
            InstallationFormat::MacOS,
            InstallationFormat::Standalone,
        ].contains(&info.format));
    }
}
