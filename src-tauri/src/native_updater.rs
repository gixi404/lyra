use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use minisign_verify::{PublicKey, Signature};
use base64::Engine;

pub static NATIVE_UPDATE_LOCK: AtomicBool = AtomicBool::new(false);

/// RAII lock guard that guarantees mutual exclusion during native package update operations.
#[derive(Debug)]
pub struct NativeUpdateLockGuard;

impl NativeUpdateLockGuard {
    pub fn try_acquire() -> Result<Self, String> {
        if NATIVE_UPDATE_LOCK
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Ok(Self)
        } else {
            Err("UPDATE_BUSY: Ya hay una operación de actualización en curso".to_string())
        }
    }
}

impl Drop for NativeUpdateLockGuard {
    fn drop(&mut self) {
        NATIVE_UPDATE_LOCK.store(false, Ordering::SeqCst);
    }
}

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
                supports_official_updater: false,
            };
        }
        if bt == Some(BundleType::Rpm) {
            return InstallationInfo {
                format: InstallationFormat::Rpm,
                is_package_managed: true,
                bundle_type: bt_str,
                supports_official_updater: false,
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

/// Checks whether an executable binary exists either in PATH or common system directories.
pub fn binary_exists(bin: &str) -> bool {
    if Path::new(bin).is_absolute() {
        return Path::new(bin).exists();
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let full = dir.join(bin);
            if full.is_file() {
                return true;
            }
            #[cfg(windows)]
            {
                if full.with_extension("exe").is_file()
                    || full.with_extension("cmd").is_file()
                    || full.with_extension("bat").is_file()
                {
                    return true;
                }
            }
        }
    }
    #[cfg(unix)]
    {
        Path::new("/usr/bin").join(bin).exists()
            || Path::new("/bin").join(bin).exists()
            || Path::new("/usr/local/bin").join(bin).exists()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElevatedStatus {
    Cancelled,
    AuthDenied,
    InstallerFailed,
}

/// Resolves the optimal package installation tool and arguments for the current distribution.
/// Checks distribution release signatures and configuration paths to avoid selecting
/// incompatible managers (e.g. dummy/isolated dnf on openSUSE, or foreign apt on Fedora).
pub fn resolve_package_installer(format: InstallationFormat) -> (&'static str, Vec<&'static str>) {
    match format {
        InstallationFormat::Rpm => {
            let is_fedora_rhel = Path::new("/etc/fedora-release").exists()
                || Path::new("/etc/redhat-release").exists()
                || Path::new("/etc/dnf").exists();

            let is_suse = Path::new("/etc/zypp").exists()
                || Path::new("/etc/SuSE-release").exists();

            if is_fedora_rhel && binary_exists("dnf") {
                ("dnf", vec!["install", "-y"])
            } else if is_suse && binary_exists("zypper") {
                ("zypper", vec!["--non-interactive", "install"])
            } else {
                ("rpm", vec!["-U"])
            }
        }
        InstallationFormat::Deb => {
            let is_debian_ubuntu = Path::new("/etc/debian_version").exists()
                || Path::new("/etc/apt").exists();

            if is_debian_ubuntu && binary_exists("apt") {
                ("apt", vec!["install", "-y"])
            } else {
                ("dpkg", vec!["-i"])
            }
        }
        _ => ("", vec![]),
    }
}

/// Classifies the execution outcome into:
/// 1. Voluntary user cancellation (dismissed prompt, Ctrl+C / SIGINT, SIGTERM)
/// 2. Authorization denied / permission refusal by system policy or bad credentials
/// 3. Installer failure (package manager returned error code or failed dependencies)
pub fn classify_elevated_execution(code: Option<i32>, signal: Option<i32>, stderr: &str) -> ElevatedStatus {
    let lower = stderr.to_lowercase();

    // 1. Explicit voluntary cancellation from Polkit / agent
    if lower.contains("request dismissed")
        || lower.contains("dismissed")
        || lower.contains("rehusó la autenticación")
        || lower.contains("descartó")
        || lower.contains("descartada")
        || lower.contains("user dismissed")
        || lower.contains("user cancelled")
        || lower.contains("user canceled")
    {
        return ElevatedStatus::Cancelled;
    }

    // Process interrupted by user signal (SIGINT = 2 / Ctrl+C, SIGTERM = 15)
    if let Some(sig) = signal {
        if sig == 2 || sig == 15 {
            return ElevatedStatus::Cancelled;
        }
    }

    // 2. Explicit authorization denied / policy rejection / wrong credentials
    if lower.contains("not authorized")
        || lower.contains("no autorizado")
        || lower.contains("authorization refused")
        || lower.contains("autorización denegada")
        || lower.contains("autorización rechazada")
        || lower.contains("not permitted")
    {
        return ElevatedStatus::AuthDenied;
    }

    // pkexec exit code 126 without dismissed message indicates lack of authorization
    if code == Some(126) {
        return ElevatedStatus::AuthDenied;
    }

    // 3. Fallback: package manager failure or system error
    ElevatedStatus::InstallerFailed
}

/// Helper that checks if the status corresponds specifically to voluntary user cancellation.
#[cfg(test)]
pub fn is_cancellation_status(code: Option<i32>, signal: Option<i32>, stderr: &str) -> bool {
    classify_elevated_execution(code, signal, stderr) == ElevatedStatus::Cancelled
}

/// Executes installation of the verified package using elevated privileges via pkexec.
/// Guaranteed to invoke pkexec at most ONCE, preventing repeated authentication popups.
pub fn install_package_elevated(pkg_path: &Path, format: InstallationFormat) -> Result<(), String> {
    if !pkg_path.exists() {
        return Err("Package file does not exist".to_string());
    }

    let (installer_cmd, installer_args) = resolve_package_installer(format);
    if installer_cmd.is_empty() {
        return Err(format!("Elevated installation unsupported for {:?}", format));
    }

    let path_str = pkg_path.to_string_lossy();
    let mut cmd = Command::new("pkexec");
    cmd.arg(installer_cmd);
    for arg in installer_args {
        cmd.arg(arg);
    }
    cmd.arg(path_str.as_ref());

    let output = cmd
        .output()
        .map_err(|e| format!("INSTALL_FAILED: No se pudo ejecutar pkexec: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let code = output.status.code();

    #[cfg(unix)]
    let signal = output.status.signal();
    #[cfg(not(unix))]
    let signal = None;

    match classify_elevated_execution(code, signal, &stderr) {
        ElevatedStatus::Cancelled => {
            Err("UPDATE_CANCELLED: Actualización cancelada por el usuario".to_string())
        }
        ElevatedStatus::AuthDenied => {
            Err("AUTH_DENIED: Permisos administrativos no otorgados o denegados por la directiva de seguridad".to_string())
        }
        ElevatedStatus::InstallerFailed => {
            let err_details = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else if !stdout.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                format!("código de salida {:?}", code)
            };
            Err(format!("INSTALL_FAILED: Error en el gestor de paquetes ({installer_cmd}): {err_details}"))
        }
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

        // RPM and DEB must never claim official updater support to avoid multi-prompt fallbacks
        if info.format == InstallationFormat::Rpm || info.format == InstallationFormat::Deb {
            assert!(!info.supports_official_updater);
        }
    }

    #[test]
    fn test_classify_elevated_execution_distinguishes_cancellation_denial_and_failure() {
        // 1. Voluntary cancellations:
        // Polkit "Request dismissed"
        assert_eq!(
            classify_elevated_execution(Some(126), None, "Error executing command as another user: Request dismissed\n"),
            ElevatedStatus::Cancelled
        );
        // User interruption signal (SIGINT = 2 / Ctrl+C)
        assert_eq!(
            classify_elevated_execution(None, Some(2), ""),
            ElevatedStatus::Cancelled
        );
        // User termination signal (SIGTERM = 15)
        assert_eq!(
            classify_elevated_execution(None, Some(15), ""),
            ElevatedStatus::Cancelled
        );
        // Spanish locale dismissal
        assert_eq!(
            classify_elevated_execution(Some(1), None, "El usuario rehusó la autenticación."),
            ElevatedStatus::Cancelled
        );

        // 2. Authorization denied / permission refusal:
        // Polkit "Not authorized"
        assert_eq!(
            classify_elevated_execution(Some(126), None, "Error executing command as another user: Not authorized\n"),
            ElevatedStatus::AuthDenied
        );
        // Exit code 126 without dismissed message
        assert_eq!(
            classify_elevated_execution(Some(126), None, ""),
            ElevatedStatus::AuthDenied
        );
        // Policy rejection message
        assert_eq!(
            classify_elevated_execution(Some(1), None, "pkexec: not authorized by system policy"),
            ElevatedStatus::AuthDenied
        );

        // 3. Package manager / system installer failures:
        // DNF transaction test error
        assert_eq!(
            classify_elevated_execution(Some(1), None, "Error: Transaction test error: file /usr/bin/lyra conflicts with file from package lyra-2.0.21"),
            ElevatedStatus::InstallerFailed
        );
        // Dpkg error
        assert_eq!(
            classify_elevated_execution(Some(1), None, "dpkg: error processing package lyra (--install)"),
            ElevatedStatus::InstallerFailed
        );
        // Executable not found (code 127)
        assert_eq!(
            classify_elevated_execution(Some(127), None, "pkexec: command not found"),
            ElevatedStatus::InstallerFailed
        );
        // Process crash (e.g. SIGSEGV = 11) is an installer failure, NOT a voluntary cancellation
        assert_eq!(
            classify_elevated_execution(None, Some(11), "Segmentation fault"),
            ElevatedStatus::InstallerFailed
        );
    }

    #[test]
    fn test_is_cancellation_status() {
        assert!(is_cancellation_status(Some(126), None, "Request dismissed"));
        assert!(is_cancellation_status(None, Some(2), ""));
        assert!(!is_cancellation_status(Some(126), None, "Not authorized"));
        assert!(!is_cancellation_status(Some(1), None, "Package error"));
    }

    #[test]
    fn test_resolve_package_installer_rpm_and_deb() {
        let (rpm_cmd, rpm_args) = resolve_package_installer(InstallationFormat::Rpm);
        assert!(rpm_cmd == "dnf" || rpm_cmd == "zypper" || rpm_cmd == "rpm");
        assert!(!rpm_args.is_empty());

        let (deb_cmd, deb_args) = resolve_package_installer(InstallationFormat::Deb);
        assert!(deb_cmd == "apt" || deb_cmd == "dpkg");
        assert!(!deb_args.is_empty());

        let (win_cmd, _) = resolve_package_installer(InstallationFormat::Windows);
        assert_eq!(win_cmd, "");
    }

    #[test]
    fn test_binary_exists() {
        // Platform-specific standard shell/command binary availability check
        #[cfg(unix)]
        {
            assert!(binary_exists("sh"));
        }

        #[cfg(windows)]
        {
            assert!(binary_exists("cmd.exe") || binary_exists("cmd"));
        }

        // Non-existent binary must return false on all platforms
        assert!(!binary_exists("definitely_non_existent_binary_xyz123"));
    }

    #[test]
    fn test_install_package_elevated_nonexistent_file() {
        let nonexistent = std::env::temp_dir().join("nonexistent_lyra_package_12345.rpm");
        let result = install_package_elevated(&nonexistent, InstallationFormat::Rpm);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Package file does not exist");
    }

    #[test]
    fn test_native_update_lock_guard_mutual_exclusion() {
        // First acquisition must succeed
        let guard1 = NativeUpdateLockGuard::try_acquire();
        assert!(guard1.is_ok(), "First acquisition must succeed");

        // Concurrent acquisition while guard1 is held must fail with UPDATE_BUSY
        let guard2 = NativeUpdateLockGuard::try_acquire();
        assert!(guard2.is_err(), "Concurrent acquisition must fail");
        assert_eq!(
            guard2.unwrap_err(),
            "UPDATE_BUSY: Ya hay una operación de actualización en curso"
        );

        // Drop guard1 and verify that subsequent acquisition succeeds
        drop(guard1);
        let guard3 = NativeUpdateLockGuard::try_acquire();
        assert!(guard3.is_ok(), "Subsequent acquisition after drop must succeed");
        drop(guard3);
    }
}
