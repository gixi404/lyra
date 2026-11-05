use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const TARGET_MIME_TYPES: &[&str] = &["text/plain", "text/markdown", "text/x-markdown"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DefaultAppOutcome {
    AlreadyDefault {
        message: String,
    },
    ConfiguredAutomatically {
        configured_mimes: Vec<String>,
        message: String,
    },
    PartiallyConfigured {
        configured_mimes: Vec<String>,
        failed_mimes: Vec<String>,
        message: String,
    },
    ManualSettingsOpened {
        message: String,
    },
    InstructionsNeeded {
        reason: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DefaultAppSettingsResult {
    pub os: String,
    pub outcome: DefaultAppOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DefaultAppAssociationStatus {
    AllDefault,
    Partial {
        txt_default: bool,
        md_default: bool,
    },
    None,
    Unknown {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DefaultAppStatusResult {
    pub os: String,
    pub status: DefaultAppAssociationStatus,
}

pub fn get_default_app_status() -> Result<DefaultAppStatusResult, String> {
    match std::env::consts::OS {
        "linux" => {
            let status = check_linux_desktop_status(
                find_installed_lyra_desktop,
                query_xdg_mime_default,
            );
            Ok(DefaultAppStatusResult {
                os: "linux".to_string(),
                status,
            })
        }
        "windows" => Ok(DefaultAppStatusResult {
            os: "windows".to_string(),
            status: DefaultAppAssociationStatus::Unknown {
                reason: "Windows no permite consultar asociaciones sin elevación".to_string(),
            },
        }),
        "macos" => Ok(DefaultAppStatusResult {
            os: "macos".to_string(),
            status: DefaultAppAssociationStatus::Unknown {
                reason: "macOS gestiona asociaciones en el Finder".to_string(),
            },
        }),
        os => Ok(DefaultAppStatusResult {
            os: os.to_string(),
            status: DefaultAppAssociationStatus::Unknown {
                reason: format!("Sistema operativo no soportado para consulta directa: {os}"),
            },
        }),
    }
}

pub fn get_os_name() -> &'static str {
    std::env::consts::OS
}

/// URI oficial de Windows para la configuración de aplicaciones predeterminadas en Windows 10 y 11.
pub const MS_SETTINGS_DEFAULTAPPS_URI: &str = "ms-settings:defaultapps";

/// Argumentos estrictamente constantes e inmutables para invocar el URI de configuración
/// mediante cmd.exe en Windows.
pub const WINDOWS_CMD_START_ARGS: &[&str] = &["/C", "start", "", MS_SETTINGS_DEFAULTAPPS_URI];

/// Intenta configurar Lyra como aplicación predeterminada siguiendo las prioridades:
/// Prioridad 1: Configuración automática sin elevación y con verificación (Linux con xdg-mime).
/// Prioridad 2: Apertura de configuración manual nativa del SO (Windows 10/11).
/// Prioridad 3: Instrucciones específicas del sistema operativo (macOS, o fallback ante fallos).
pub fn open_default_apps_settings() -> Result<DefaultAppSettingsResult, String> {
    match std::env::consts::OS {
        "windows" => open_windows_default_apps(),
        "linux" => open_linux_default_apps(),
        "macos" => open_macos_default_apps(),
        os => Ok(DefaultAppSettingsResult {
            os: os.to_string(),
            outcome: DefaultAppOutcome::InstructionsNeeded {
                reason: format!("Sistema operativo no soportado directamente: {os}"),
            },
        }),
    }
}

pub fn open_windows_default_apps() -> Result<DefaultAppSettingsResult, String> {
    // Windows 10/11 no ofrece una API pública no privilegiada para asociar archivos
    // de texto sin manipular UserChoice (lo cual viola las protecciones de integridad del SO).
    // Por tanto, se ejecuta la Prioridad 2: abrir la interfaz oficial de Ajustes con argumentos constantes.
    let cmd_result = Command::new("cmd")
        .args(WINDOWS_CMD_START_ARGS)
        .spawn();

    match cmd_result {
        Ok(_) => Ok(DefaultAppSettingsResult {
            os: "windows".to_string(),
            outcome: DefaultAppOutcome::ManualSettingsOpened {
                message: "Se ha solicitado abrir la configuración de aplicaciones de Windows. Selecciona Lyra para asociar tus archivos .txt y .md.".to_string(),
            },
        }),
        Err(cmd_err) => {
            // Alternativa de respaldo con 'explorer.exe', también con argumento constante
            match Command::new("explorer").arg(MS_SETTINGS_DEFAULTAPPS_URI).spawn() {
                Ok(_) => Ok(DefaultAppSettingsResult {
                    os: "windows".to_string(),
                    outcome: DefaultAppOutcome::ManualSettingsOpened {
                        message: "Se ha solicitado abrir la configuración de aplicaciones de Windows. Selecciona Lyra para asociar tus archivos .txt y .md.".to_string(),
                    },
                }),
                Err(explorer_err) => Ok(DefaultAppSettingsResult {
                    os: "windows".to_string(),
                    outcome: DefaultAppOutcome::InstructionsNeeded {
                        reason: format!(
                            "No se pudo abrir la configuración de Windows automáticamente ({cmd_err}, {explorer_err})."
                        ),
                    },
                }),
            }
        }
    }
}

pub fn open_macos_default_apps() -> Result<DefaultAppSettingsResult, String> {
    // En macOS moderno (12+), las APIs de Launch Services para modificar asociaciones
    // por tipo de contenido están obsoletas y restringidas sin elevación o firmas internas.
    // Además, Ajustes del Sistema no cuenta con panel para extensiones de documentos.
    // Por tanto, se aplica Prioridad 3: instrucciones precisas del Finder.
    Ok(DefaultAppSettingsResult {
        os: "macos".to_string(),
        outcome: DefaultAppOutcome::InstructionsNeeded {
            reason: "macOS gestiona las asociaciones de archivos por extensión desde el Finder.".to_string(),
        },
    })
}

// -----------------------------------------------------------------------------
// Linux: Configuración inteligente y verificación con xdg-mime
// -----------------------------------------------------------------------------

pub fn open_linux_default_apps() -> Result<DefaultAppSettingsResult, String> {
    let outcome = configure_linux_desktop_associations(
        find_installed_lyra_desktop,
        query_xdg_mime_default,
        set_xdg_mime_default,
    );

    Ok(DefaultAppSettingsResult {
        os: "linux".to_string(),
        outcome,
    })
}

pub fn query_xdg_mime_default(mime: &str) -> Option<String> {
    let output = Command::new("xdg-mime")
        .args(["query", "default", mime])
        .output()
        .ok()?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

pub fn set_xdg_mime_default(desktop_file: &str, mime: &str) -> bool {
    Command::new("xdg-mime")
        .args(["default", desktop_file, mime])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn is_desktop_match(query_result: &str, desktop_file: &str) -> bool {
    let q = query_result.trim().to_lowercase();
    let d = desktop_file.trim().to_lowercase();
    if q == d {
        return true;
    }
    let is_q_lyra = q.ends_with(".desktop") && (q.contains("lyra") || q == "com.lyra.dev.desktop");
    let is_d_lyra = d.ends_with(".desktop") && (d.contains("lyra") || d == "com.lyra.dev.desktop");
    if is_q_lyra && is_d_lyra {
        return true;
    }
    false
}

pub fn get_linux_applications_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        let xdg_data_home = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join(".local").join("share"));
        dirs.push(xdg_data_home.join("applications"));

        // Flatpak user
        dirs.push(
            PathBuf::from(&home)
                .join(".local")
                .join("share")
                .join("flatpak")
                .join("exports")
                .join("share")
                .join("applications"),
        );
    }

    if let Ok(xdg_dirs) = std::env::var("XDG_DATA_DIRS") {
        for p in xdg_dirs.split(':') {
            if !p.is_empty() {
                dirs.push(PathBuf::from(p).join("applications"));
            }
        }
    } else {
        dirs.push(PathBuf::from("/usr/local/share/applications"));
        dirs.push(PathBuf::from("/usr/share/applications"));
    }

    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));

    dirs
}

pub fn find_installed_lyra_desktop() -> Option<String> {
    let dirs = get_linux_applications_dirs();
    find_lyra_desktop_file_in_dirs(&dirs)
}

pub fn is_valid_lyra_desktop_file(path: &Path) -> bool {
    if let Ok(content) = std::fs::read_to_string(path) {
        let mut has_name = false;
        let mut has_exec_or_wmclass = false;

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') || trimmed.is_empty() {
                continue;
            }
            if let Some((k, v)) = trimmed.split_once('=') {
                let key = k.trim();
                let val = v.trim();
                if key.eq_ignore_ascii_case("Name") && val.eq_ignore_ascii_case("Lyra") {
                    has_name = true;
                }
                if key.eq_ignore_ascii_case("StartupWMClass")
                    && (val.eq_ignore_ascii_case("com.lyra.dev") || val.eq_ignore_ascii_case("lyra"))
                {
                    has_exec_or_wmclass = true;
                }
                if key.eq_ignore_ascii_case("Exec") {
                    let lower = val.to_lowercase();
                    if lower.contains("lyra") {
                        has_exec_or_wmclass = true;
                    }
                }
            }
        }

        has_name || has_exec_or_wmclass
    } else {
        false
    }
}

pub fn find_lyra_desktop_file_in_dirs(dirs: &[PathBuf]) -> Option<String> {
    // 1. Prioridad: nombres canónicos estándar verificando contenido
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for exact in &["lyra.desktop", "com.lyra.dev.desktop"] {
            let candidate = dir.join(exact);
            if candidate.is_file() && is_valid_lyra_desktop_file(&candidate) {
                return Some((*exact).to_string());
            }
        }
    }

    // 2. Coincidencia con archivos .desktop cuyo nombre contenga "lyra" y cuyo contenido sea válido
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                        let lower = file_name.to_lowercase();
                        if lower.ends_with(".desktop")
                            && lower.contains("lyra")
                            && is_valid_lyra_desktop_file(&path)
                        {
                            return Some(file_name.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

pub fn configure_linux_desktop_associations<F, Q, S>(
    desktop_finder: F,
    mut querier: Q,
    mut setter: S,
) -> DefaultAppOutcome
where
    F: FnOnce() -> Option<String>,
    Q: FnMut(&str) -> Option<String>,
    S: FnMut(&str, &str) -> bool,
{
    let desktop_file = match desktop_finder() {
        Some(df) => df,
        None => {
            return DefaultAppOutcome::InstructionsNeeded {
                reason: "Lyra no se encuentra registrada en el menú de aplicaciones del sistema. Utiliza el gestor de archivos para asociarla.".to_string(),
            };
        }
    };

    // 1. Comprobar si ya es la aplicación predeterminada para todos los formatos objetivo
    let mut all_already_default = true;
    for mime in TARGET_MIME_TYPES {
        let current = querier(mime);
        let is_match = current
            .as_deref()
            .map(|cur| is_desktop_match(cur, &desktop_file))
            .unwrap_or(false);
        if !is_match {
            all_already_default = false;
            break;
        }
    }

    if all_already_default {
        return DefaultAppOutcome::AlreadyDefault {
            message: "Lyra ya es la aplicación predeterminada para archivos de texto (.txt y .md).".to_string(),
        };
    }

    // 2. Configurar las asociaciones requeridas
    let mut configured = Vec::new();
    let mut failed = Vec::new();

    for mime in TARGET_MIME_TYPES {
        let success = setter(&desktop_file, mime);
        if success {
            // Verificar consultando la asociación efectiva del sistema
            let verify = querier(mime);
            let verified = verify
                .as_deref()
                .map(|cur| is_desktop_match(cur, &desktop_file))
                .unwrap_or(false);

            if verified {
                configured.push((*mime).to_string());
            } else {
                failed.push((*mime).to_string());
            }
        } else {
            failed.push((*mime).to_string());
        }
    }

    if failed.is_empty() && !configured.is_empty() {
        DefaultAppOutcome::ConfiguredAutomatically {
            configured_mimes: configured,
            message: "Lyra se ha configurado como aplicación predeterminada para archivos .txt y .md.".to_string(),
        }
    } else if !configured.is_empty() {
        DefaultAppOutcome::PartiallyConfigured {
            configured_mimes: configured,
            failed_mimes: failed,
            message: "Lyra se configuró para parte de tus archivos de texto, pero requiere configuración manual para el resto.".to_string(),
        }
    } else {
        DefaultAppOutcome::InstructionsNeeded {
            reason: "El sistema no permitió aplicar las asociaciones automáticamente. Sigue las instrucciones del gestor de archivos.".to_string(),
        }
    }
}

pub fn check_linux_desktop_status<F, Q>(
    desktop_finder: F,
    mut querier: Q,
) -> DefaultAppAssociationStatus
where
    F: FnOnce() -> Option<String>,
    Q: FnMut(&str) -> Option<String>,
{
    let desktop_file = match desktop_finder() {
        Some(df) => df,
        None => {
            return DefaultAppAssociationStatus::Unknown {
                reason: "Lyra no se encuentra registrada en las aplicaciones del sistema".to_string(),
            };
        }
    };

    let txt_match = querier("text/plain")
        .as_deref()
        .map(|cur| is_desktop_match(cur, &desktop_file))
        .unwrap_or(false);

    let md_match = querier("text/markdown")
        .as_deref()
        .map(|cur| is_desktop_match(cur, &desktop_file))
        .unwrap_or_else(|| {
            querier("text/x-markdown")
                .as_deref()
                .map(|cur| is_desktop_match(cur, &desktop_file))
                .unwrap_or(false)
        });

    if txt_match && md_match {
        DefaultAppAssociationStatus::AllDefault
    } else if !txt_match && !md_match {
        DefaultAppAssociationStatus::None
    } else {
        DefaultAppAssociationStatus::Partial {
            txt_default: txt_match,
            md_default: md_match,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_get_os_name_valid() {
        let os = get_os_name();
        assert!(!os.is_empty());
        assert_eq!(os, std::env::consts::OS);
    }

    #[test]
    fn test_default_app_settings_result_serialization() {
        let res = DefaultAppSettingsResult {
            os: "linux".to_string(),
            outcome: DefaultAppOutcome::AlreadyDefault {
                message: "Ya configurado".to_string(),
            },
        };
        let json = serde_json::to_string(&res).expect("serialization failed");
        let deserialized: DefaultAppSettingsResult =
            serde_json::from_str(&json).expect("deserialization failed");
        assert_eq!(res, deserialized);
    }

    #[test]
    fn test_windows_arguments_are_strict_constants() {
        assert_eq!(MS_SETTINGS_DEFAULTAPPS_URI, "ms-settings:defaultapps");
        assert_eq!(WINDOWS_CMD_START_ARGS.len(), 4);
        assert_eq!(WINDOWS_CMD_START_ARGS[0], "/C");
        assert_eq!(WINDOWS_CMD_START_ARGS[1], "start");
        assert_eq!(WINDOWS_CMD_START_ARGS[2], "");
        assert_eq!(WINDOWS_CMD_START_ARGS[3], "ms-settings:defaultapps");
    }

    #[test]
    fn test_open_macos_default_apps_contract() {
        let res = open_macos_default_apps().expect("macos handler failed");
        assert_eq!(res.os, "macos");
        match res.outcome {
            DefaultAppOutcome::InstructionsNeeded { reason } => {
                assert!(reason.contains("Finder"));
            }
            other => panic!("Esperaba InstructionsNeeded, obtuvo {other:?}"),
        }
    }

    #[test]
    fn test_is_desktop_match_cases() {
        assert!(is_desktop_match("lyra.desktop", "lyra.desktop"));
        assert!(is_desktop_match("LYRA.DESKTOP\n", "lyra.desktop"));
        assert!(is_desktop_match("lyra.desktop", "com.lyra.dev.desktop"));
        assert!(!is_desktop_match("gedit.desktop", "lyra.desktop"));
        assert!(!is_desktop_match("org.gnome.TextEditor.desktop", "lyra.desktop"));
    }

    #[test]
    fn test_find_lyra_desktop_file_in_dirs() {
        let dir = tempdir().unwrap();
        let app_dir = dir.path().join("applications");
        std::fs::create_dir_all(&app_dir).unwrap();

        // Sin archivo .desktop
        assert_eq!(find_lyra_desktop_file_in_dirs(std::slice::from_ref(&app_dir)), None);

        // Crear lyra.desktop
        std::fs::write(app_dir.join("lyra.desktop"), "[Desktop Entry]\nName=Lyra").unwrap();
        assert_eq!(
            find_lyra_desktop_file_in_dirs(std::slice::from_ref(&app_dir)),
            Some("lyra.desktop".to_string())
        );
    }

    #[test]
    fn test_is_valid_lyra_desktop_file() {
        let dir = tempdir().unwrap();
        let valid_by_name = dir.path().join("lyra.desktop");
        std::fs::write(&valid_by_name, "[Desktop Entry]\nName=Lyra\nExec=/usr/bin/lyra").unwrap();
        assert!(is_valid_lyra_desktop_file(&valid_by_name));

        let valid_by_wmclass = dir.path().join("com.lyra.dev.desktop");
        std::fs::write(&valid_by_wmclass, "[Desktop Entry]\nName=Text Editor\nStartupWMClass=com.lyra.dev").unwrap();
        assert!(is_valid_lyra_desktop_file(&valid_by_wmclass));

        let invalid = dir.path().join("other.desktop");
        std::fs::write(&invalid, "[Desktop Entry]\nName=GEdit\nExec=gedit").unwrap();
        assert!(!is_valid_lyra_desktop_file(&invalid));
    }

    #[test]
    fn test_linux_associations_already_default_is_idempotent() {
        let mut setter_calls = 0;
        let outcome = configure_linux_desktop_associations(
            || Some("lyra.desktop".to_string()),
            |mime| match mime {
                "text/plain" => Some("lyra.desktop".to_string()),
                "text/markdown" => Some("lyra.desktop".to_string()),
                "text/x-markdown" => Some("lyra.desktop".to_string()),
                _ => None,
            },
            |_desktop, _mime| {
                setter_calls += 1;
                true
            },
        );

        assert_eq!(setter_calls, 0, "No debe ejecutar setters si ya es default");
        match outcome {
            DefaultAppOutcome::AlreadyDefault { message } => {
                assert!(message.contains(".txt y .md"));
            }
            other => panic!("Esperaba AlreadyDefault, obtuvo {other:?}"),
        }
    }

    #[test]
    fn test_linux_associations_successful_automatic_configuration() {
        let state = std::sync::Mutex::new(std::collections::HashMap::from([
            ("text/plain".to_string(), "gedit.desktop".to_string()),
            ("text/markdown".to_string(), "code.desktop".to_string()),
            ("text/x-markdown".to_string(), "code.desktop".to_string()),
        ]));

        let outcome = configure_linux_desktop_associations(
            || Some("lyra.desktop".to_string()),
            |mime| state.lock().unwrap().get(mime).cloned(),
            |desktop, mime| {
                state.lock().unwrap().insert(mime.to_string(), desktop.to_string());
                true
            },
        );

        match outcome {
            DefaultAppOutcome::ConfiguredAutomatically { configured_mimes, .. } => {
                assert_eq!(configured_mimes.len(), 3);
                assert!(configured_mimes.contains(&"text/plain".to_string()));
                assert!(configured_mimes.contains(&"text/markdown".to_string()));
                assert!(configured_mimes.contains(&"text/x-markdown".to_string()));
            }
            other => panic!("Esperaba ConfiguredAutomatically, obtuvo {other:?}"),
        }
    }

    #[test]
    fn test_linux_associations_partial_configuration() {
        let state = std::sync::Mutex::new(std::collections::HashMap::from([
            ("text/plain".to_string(), "gedit.desktop".to_string()),
            ("text/markdown".to_string(), "code.desktop".to_string()),
            ("text/x-markdown".to_string(), "code.desktop".to_string()),
        ]));

        let outcome = configure_linux_desktop_associations(
            || Some("lyra.desktop".to_string()),
            |mime| state.lock().unwrap().get(mime).cloned(),
            |desktop, mime| {
                if mime == "text/plain" {
                    state.lock().unwrap().insert(mime.to_string(), desktop.to_string());
                    true
                } else {
                    false
                }
            },
        );

        match outcome {
            DefaultAppOutcome::PartiallyConfigured {
                configured_mimes,
                failed_mimes,
                ..
            } => {
                assert_eq!(configured_mimes, vec!["text/plain"]);
                assert_eq!(failed_mimes, vec!["text/markdown", "text/x-markdown"]);
            }
            other => panic!("Esperaba PartiallyConfigured, obtuvo {other:?}"),
        }
    }

    #[test]
    fn test_linux_associations_unregistered_app_falls_back_to_instructions() {
        let outcome = configure_linux_desktop_associations(
            || None,
            |_| Some("gedit.desktop".to_string()),
            |_, _| true,
        );

        match outcome {
            DefaultAppOutcome::InstructionsNeeded { reason } => {
                assert!(reason.contains("no se encuentra registrada"));
            }
            other => panic!("Esperaba InstructionsNeeded, obtuvo {other:?}"),
        }
    }

    #[test]
    fn test_check_linux_desktop_status_all_default() {
        let status = check_linux_desktop_status(
            || Some("lyra.desktop".to_string()),
            |mime| match mime {
                "text/plain" => Some("lyra.desktop".to_string()),
                "text/markdown" => Some("lyra.desktop".to_string()),
                _ => None,
            },
        );
        assert_eq!(status, DefaultAppAssociationStatus::AllDefault);
    }

    #[test]
    fn test_check_linux_desktop_status_partial() {
        let status = check_linux_desktop_status(
            || Some("lyra.desktop".to_string()),
            |mime| match mime {
                "text/plain" => Some("lyra.desktop".to_string()),
                "text/markdown" => Some("gedit.desktop".to_string()),
                _ => None,
            },
        );
        assert_eq!(
            status,
            DefaultAppAssociationStatus::Partial {
                txt_default: true,
                md_default: false,
            }
        );
    }

    #[test]
    fn test_check_linux_desktop_status_none() {
        let status = check_linux_desktop_status(
            || Some("lyra.desktop".to_string()),
            |_| Some("gedit.desktop".to_string()),
        );
        assert_eq!(status, DefaultAppAssociationStatus::None);
    }

    #[test]
    fn test_check_linux_desktop_status_unregistered() {
        let status = check_linux_desktop_status(
            || None,
            |_| Some("gedit.desktop".to_string()),
        );
        match status {
            DefaultAppAssociationStatus::Unknown { reason } => {
                assert!(reason.contains("no se encuentra registrada"));
            }
            other => panic!("Esperaba Unknown, obtuvo {other:?}"),
        }
    }

    #[test]
    fn test_default_app_status_result_serialization() {
        let res = DefaultAppStatusResult {
            os: "linux".to_string(),
            status: DefaultAppAssociationStatus::Partial {
                txt_default: true,
                md_default: false,
            },
        };
        let json = serde_json::to_string(&res).expect("serialization failed");
        let deserialized: DefaultAppStatusResult =
            serde_json::from_str(&json).expect("deserialization failed");
        assert_eq!(res, deserialized);
    }
}
