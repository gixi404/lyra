use super::types::{OAuthTokens, StoredAuthState, UserProfile};
use super::credential_store::{CredentialStore, SystemCredentialStore};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;
use tauri::Manager;

static OAUTH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static OAUTH_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static ACTIVE_OAUTH_SERVER: Mutex<Option<Weak<tiny_http::Server>>> = Mutex::new(None);

/// Época global de la cuenta conectada. Se incrementa al iniciar sesión, al
/// cerrarla y cuando Google invalida las credenciales. Cualquier operación que
/// capture una época distinta a la actual debe abortar para no mezclar cuentas.
static ACCOUNT_EPOCH: AtomicU64 = AtomicU64::new(1);
static AUTH_STATE_LOCK: Mutex<()> = Mutex::new(());
type TokenLease = Mutex<Option<(String, i64)>>;
static TOKEN_LEASES: OnceLock<Mutex<Vec<Weak<TokenLease>>>> = OnceLock::new();

fn token_leases() -> &'static Mutex<Vec<Weak<TokenLease>>> {
    TOKEN_LEASES.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn account_epoch() -> u64 {
    ACCOUNT_EPOCH.load(Ordering::SeqCst)
}

pub fn bump_account_epoch() -> u64 {
    let epoch = ACCOUNT_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let mut leases = token_leases().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    leases.retain(|weak| {
        let Some(lease) = weak.upgrade() else { return false; };
        *lease.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        true
    });
    epoch
}

/// Cancela el proceso de inicio de sesión OAuth en curso si existe.
pub fn cancel_oauth_flow() -> Result<(), String> {
    let _guard = auth_lock()?;
    if OAUTH_IN_PROGRESS.load(Ordering::SeqCst) {
        OAUTH_CANCEL_REQUESTED.store(true, Ordering::SeqCst);
        if let Ok(active) = ACTIVE_OAUTH_SERVER.lock() {
            if let Some(weak) = active.as_ref() {
                if let Some(server) = weak.upgrade() {
                    server.unblock();
                }
            }
        }
    }
    Ok(())
}

/// Comprueba si hay un flujo OAuth activo.
#[allow(dead_code)]
pub fn is_oauth_in_progress() -> bool {
    OAUTH_IN_PROGRESS.load(Ordering::SeqCst)
}

const OLD_CONFIG_TOKEN_FILE_NAME: &str = "gdrive_token.json";
const LEGACY_TOKEN_FILE_NAME: &str = ".gdrive_token.json";
const OAUTH_SCOPES: &str = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
const LYRA_LOGO_BYTES: &[u8] = include_bytes!("../../../public/logo.png");
pub const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    #[serde(default = "default_token_type")]
    token_type: String,
}

fn default_token_type() -> String {
    "Bearer".to_string()
}

#[derive(Deserialize)]
struct GoogleUserInfo {
    #[serde(default, alias = "id")]
    sub: Option<String>,
    email: String,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Deserialize)]
struct OAuthConfigFile {
    client_id: String,
    client_secret: String,
}

/// Obtiene las credenciales de cliente OAuth 2.0 según la jerarquía de resolución:
/// 1. Variables de entorno en runtime (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
/// 2. Archivo de configuración `gdrive_oauth.json` en el directorio de configuración del usuario
/// 3. Archivo `.env` en local (para desarrollo)
/// 4. Credenciales de aplicación pública embebidas en tiempo de compilación (para builds oficiales de release)
///
/// Nota arquitectónica (RFC 8252 Sección 8.5):
/// Lyra es una aplicación de escritorio nativa ("Public Client"). Por definición de OAuth 2.0,
/// un cliente público no puede mantener la confidencialidad de un secreto en el dispositivo del usuario.
/// Para clientes de tipo "Desktop app", Google Cloud Console genera un `client_secret` que su endpoint
/// exige como identificador de la aplicación, mientras que la autenticidad y seguridad del intercambio
/// de código está garantizada por PKCE (RFC 7636) con SHA-256 (`S256`).
pub fn get_client_credentials(app: Option<&tauri::AppHandle>) -> Result<(String, String), String> {
    // Intentar cargar variables desde .env si existe en el entorno de desarrollo
    let _ = dotenvy::dotenv();

    // Nivel 1: Variables de entorno en tiempo de ejecución
    let env_id = std::env::var("GOOGLE_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let env_secret = std::env::var("GOOGLE_CLIENT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let (Some(id), Some(secret)) = (env_id, env_secret) {
        return Ok((id, secret));
    }

    // Nivel 2: Archivo de configuración en app_config_dir (~/.config/com.lyra.dev/gdrive_oauth.json)
    if let Some(app_handle) = app {
        if let Ok(config_dir) = app_handle.path().app_config_dir() {
            let oauth_json_path = config_dir.join("gdrive_oauth.json");
            if oauth_json_path.exists() {
                if let Ok(content) = fs::read_to_string(&oauth_json_path) {
                    if let Ok(cfg) = serde_json::from_str::<OAuthConfigFile>(&content) {
                        let id = cfg.client_id.trim().to_string();
                        let secret = cfg.client_secret.trim().to_string();
                        if !id.is_empty() && !secret.is_empty() {
                            return Ok((id, secret));
                        }
                    }
                }
            }
        }
    }

    // Nivel 3: Credenciales de build embebidas en tiempo de compilación (para builds oficiales empaquetados)
    let build_id = option_env!("GOOGLE_CLIENT_ID")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let build_secret = option_env!("GOOGLE_CLIENT_SECRET")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let (Some(id), Some(secret)) = (build_id, build_secret) {
        return Ok((id, secret));
    }

    let config_hint = if let Some(app_handle) = app {
        if let Ok(dir) = app_handle.path().app_config_dir() {
            format!("\nTambién puede ubicar sus credenciales en: {}", dir.join("gdrive_oauth.json").display())
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    Err(format!(
        "Credenciales de Google OAuth no configuradas. Configure GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en su entorno o archivo .env.{config_hint}"
    ))
}

pub fn sanitize_account_key(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

pub fn get_account_key(user: &UserProfile) -> String {
    if let Some(ref sub) = user.sub {
        let trimmed = sub.trim();
        if !trimmed.is_empty() {
            return sanitize_account_key(trimmed);
        }
    }
    sanitize_account_key(&user.email.to_lowercase())
}

/// Identidad verificada de la cuenta activa.
///
/// El `sub` de Google es el único identificador estable y verificado. El correo
/// puede cambiar de dueño y el frontend puede enviar cualquier valor, por lo
/// que ninguno de los dos se acepta como identidad de cuenta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAccount {
    pub sub: String,
    pub account_key: String,
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub epoch: u64,
}

pub fn verified_account_from_state(
    state: &StoredAuthState,
    epoch: u64,
) -> Result<VerifiedAccount, String> {
    let sub = state
        .user
        .sub
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "La cuenta conectada no tiene un identificador verificado de Google (sub). \
             Vuelve a conectar Google Drive para continuar de forma segura."
                .to_string()
        })?;

    Ok(VerifiedAccount {
        sub: sub.to_string(),
        account_key: sanitize_account_key(sub),
        email: state.user.email.clone(),
        name: state.user.name.clone(),
        picture: state.user.picture.clone(),
        epoch,
    })
}

/// Lee la cuenta activa y exige que tenga identidad verificada (`sub`).
pub fn verify_current_account(app: &tauri::AppHandle) -> Result<VerifiedAccount, String> {
    let _guard = auth_lock()?;
    let state = load_auth_state_unlocked(app)?
        .ok_or_else(|| "No hay una cuenta de Google Drive conectada.".to_string())?;
    verified_account_from_state(&state, account_epoch())
}

/// Former plaintext token path, used only to migrate and remove existing copies.
pub fn get_token_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No se pudo resolver el directorio de configuración de la aplicación: {e}"))?;
    Ok(config_dir.join(OLD_CONFIG_TOKEN_FILE_NAME))
}

/// Ruta heredada en ~/Documents/lyra/.gdrive_token.json (utilizada únicamente para migración)
pub fn get_legacy_token_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("No se pudo resolver la carpeta Documentos: {e}"))?;
    Ok(doc_dir.join("lyra").join(LEGACY_TOKEN_FILE_NAME))
}

fn auth_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    AUTH_STATE_LOCK.lock().map_err(|_| "No se pudo acceder al estado de autenticación".to_string())
}

fn read_legacy_state(path: &Path) -> Result<Option<StoredAuthState>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("No se pudo inspeccionar un archivo de credenciales antiguo".to_string()),
    };
    if !metadata.file_type().is_file() || metadata.len() > 256 * 1024 {
        return Err("El archivo de credenciales antiguo no es válido".to_string());
    }
    let bytes = fs::read(path).map_err(|_| "No se pudo leer un archivo de credenciales antiguo".to_string())?;
    serde_json::from_slice(&bytes).map(Some)
        .map_err(|_| "El archivo de credenciales antiguo está dañado; no se modificó".to_string())
}

fn remove_legacy_files(paths: &[&Path]) -> Result<(), String> {
    for path in paths {
        match fs::symlink_metadata(path) {
            Ok(_) => fs::remove_file(path)
                .map_err(|_| "No se pudo retirar un JSON antiguo de credenciales".to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("No se pudo inspeccionar un JSON antiguo de credenciales".to_string()),
        }
    }
    Ok(())
}

fn read_secure_state<S: CredentialStore>(store: &S) -> Result<Option<StoredAuthState>, String> {
    store.read()?.map(|raw| {
        if raw.len() > 256 * 1024 {
            return Err("La credencial del almacén seguro supera el tamaño permitido".to_string());
        }
        if raw.first() != Some(&1) {
            return Err("La credencial del almacén seguro usa un formato desconocido".to_string());
        }
        bincode::deserialize(&raw[1..])
            .map_err(|_| "La credencial del almacén seguro está dañada".to_string())
    }).transpose()
}

fn same_state(left: &StoredAuthState, right: &StoredAuthState) -> bool {
    left == right
}

pub fn migrate_auth_state_at<S: CredentialStore>(
    store: &S, app_config_json: &Path, documents_json: &Path,
) -> Result<Option<StoredAuthState>, String> {
    let secure = read_secure_state(store)?;
    let config = read_legacy_state(app_config_json)?;
    let documents = read_legacy_state(documents_json)?;
    let old = match (&config, &documents) {
        (Some(a), Some(b)) if !same_state(a, b) => {
            return Err("Se encontraron dos archivos antiguos de credenciales diferentes; no se migró ninguno".to_string());
        }
        (Some(a), _) | (_, Some(a)) => Some(a.clone()),
        _ => None,
    };
    if let Some(current) = secure {
        if let Some(ref old) = old {
            if !same_state(&current, old) {
                return Err("La credencial segura y el JSON antiguo pertenecen a sesiones distintas; no se modificaron".to_string());
            }
            remove_legacy_files(&[app_config_json, documents_json])?;
        }
        return Ok(Some(current));
    }
    let Some(old) = old else { return Ok(None); };
    let raw = bincode::serialize(&old)
        .map_err(|_| "No se pudo preparar la migración de credenciales".to_string())?;
    let mut payload = vec![1];
    payload.extend(raw);
    store.write(&payload)?;
    let verified = read_secure_state(store)?
        .ok_or_else(|| "El almacén seguro no confirmó la migración".to_string())?;
    if !same_state(&old, &verified) {
        return Err("El almacén seguro devolvió credenciales distintas; los JSON antiguos se conservaron".to_string());
    }
    remove_legacy_files(&[app_config_json, documents_json])?;
    Ok(Some(verified))
}

fn load_auth_state_unlocked(app: &tauri::AppHandle) -> Result<Option<StoredAuthState>, String> {
    migrate_auth_state_at(&SystemCredentialStore, &get_token_file_path(app)?, &get_legacy_token_file_path(app)?)
}

pub fn load_auth_state(app: &tauri::AppHandle) -> Result<Option<StoredAuthState>, String> {
    let _guard = auth_lock()?;
    load_auth_state_unlocked(app)
}

fn load_auth_state_with_epoch(app: &tauri::AppHandle) -> Result<(Option<StoredAuthState>, u64), String> {
    let _guard = auth_lock()?;
    Ok((load_auth_state_unlocked(app)?, account_epoch()))
}

fn write_secure_state_at<S: CredentialStore>(store: &S, state: &StoredAuthState) -> Result<(), String> {
    let raw = bincode::serialize(state)
        .map_err(|_| "No se pudo preparar el estado de autenticación".to_string())?;
    let mut payload = vec![1];
    payload.extend(raw);
    store.write(&payload)?;
    let verified = read_secure_state(store)?
        .ok_or_else(|| "El almacén seguro no confirmó la escritura".to_string())?;
    if !same_state(state, &verified) {
        return Err("El almacén seguro no confirmó la integridad de las credenciales".to_string());
    }
    Ok(())
}

fn write_secure_state(state: &StoredAuthState) -> Result<(), String> {
    write_secure_state_at(&SystemCredentialStore, state)
}

pub fn prepare_new_auth(app: &tauri::AppHandle) -> Result<u64, String> {
    let _guard = auth_lock()?;
    let epoch = account_epoch();
    prepare_new_auth_at(&SystemCredentialStore, &get_token_file_path(app)?, &get_legacy_token_file_path(app)?)?;
    Ok(epoch)
}

fn prepare_new_auth_at<S: CredentialStore>(store: &S, app_config_json: &Path, documents_json: &Path) -> Result<(), String> {
    if migrate_auth_state_at(store, app_config_json, documents_json)?.is_some() {
        return Err("Ya hay una cuenta de Google Drive conectada. Desconéctala antes de conectar otra".to_string());
    }
    store.probe()
}

fn save_new_auth_state(app: &tauri::AppHandle, state: &StoredAuthState, expected_epoch: u64) -> Result<(), String> {
    let _guard = auth_lock()?;
    if OAUTH_CANCEL_REQUESTED.load(Ordering::SeqCst) {
        return Err("El inicio de sesión fue cancelado".to_string());
    }
    save_new_auth_state_at(&SystemCredentialStore, &get_token_file_path(app)?, &get_legacy_token_file_path(app)?, state, expected_epoch, account_epoch())?;
    bump_account_epoch();
    Ok(())
}

fn save_new_auth_state_at<S: CredentialStore>(store: &S, app_config_json: &Path, documents_json: &Path, state: &StoredAuthState, expected_epoch: u64, actual_epoch: u64) -> Result<(), String> {
    if actual_epoch != expected_epoch || migrate_auth_state_at(store, app_config_json, documents_json)?.is_some() {
        return Err("La sesión cambió durante la conexión; vuelve a intentarlo".to_string());
    }
    write_secure_state_at(store, state)
}

fn save_auth_state_bound(app: &tauri::AppHandle, state: &StoredAuthState, expected_epoch: u64, original_refresh: &str) -> Result<(), String> {
    let _guard = auth_lock()?;
    save_auth_state_bound_at(&SystemCredentialStore, &get_token_file_path(app)?, &get_legacy_token_file_path(app)?, state, expected_epoch, account_epoch(), original_refresh)
}

fn save_auth_state_bound_at<S: CredentialStore>(store: &S, app_config_json: &Path, documents_json: &Path, state: &StoredAuthState, expected_epoch: u64, actual_epoch: u64, original_refresh: &str) -> Result<(), String> {
    if actual_epoch != expected_epoch {
        return Err("La sesión cambió durante la renovación; se descartó el resultado obsoleto".to_string());
    }
    let current = migrate_auth_state_at(store, app_config_json, documents_json)?
        .ok_or_else(|| "La sesión se cerró durante la renovación".to_string())?;
    if current.user.sub != state.user.sub || current.tokens.refresh_token.as_deref() != Some(original_refresh) {
        return Err("La cuenta o su credencial cambió durante la renovación".to_string());
    }
    let mut next = state.clone();
    next.auto_sync_enabled = current.auto_sync_enabled;
    write_secure_state_at(store, &next)
}

pub fn set_auto_sync_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let _guard = auth_lock()?;
    if let Some(mut state) = load_auth_state_unlocked(app)? {
        state.auto_sync_enabled = enabled;
        write_secure_state(&state)?;
    }
    Ok(())
}

fn clear_auth_state_bound(app: &tauri::AppHandle, expected_epoch: u64, expected_sub: &Option<String>) -> Result<(), String> {
    let _guard = auth_lock()?;
    if account_epoch() != expected_epoch { return Ok(()); }
    let current = load_auth_state_unlocked(app)?;
    if current.as_ref().map(|state| &state.user.sub) != Some(expected_sub) { return Ok(()); }
    bump_account_epoch();
    remove_legacy_files(&[&get_token_file_path(app)?, &get_legacy_token_file_path(app)?])?;
    SystemCredentialStore.delete()
}

pub fn take_auth_state_for_logout(app: &tauri::AppHandle) -> Result<(Option<StoredAuthState>, bool), String> {
    let _guard = auth_lock()?;
    take_auth_state_at(&SystemCredentialStore, &get_token_file_path(app)?, &get_legacy_token_file_path(app)?)
}

fn take_auth_state_at<S: CredentialStore>(store: &S, app_config_json: &Path, documents_json: &Path) -> Result<(Option<StoredAuthState>, bool), String> {
    bump_account_epoch();
    // Logout is explicit disposal: do not migrate plaintext just to delete it.
    let secure_result = read_secure_state(store);
    let config_result = read_legacy_state(app_config_json);
    let documents_result = read_legacy_state(documents_json);
    let readable = secure_result.is_ok() && config_result.is_ok() && documents_result.is_ok();
    let secure = secure_result.ok().flatten();
    let config = config_result.ok().flatten();
    let documents = documents_result.ok().flatten();
    let state = secure.or(config).or(documents);
    remove_legacy_files(&[app_config_json, documents_json])?;
    store.delete()?;
    Ok((state, readable))
}

fn generate_pkce() -> (String, String) {
    let mut random_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(random_bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    let challenge = URL_SAFE_NO_PAD.encode(hash);

    (verifier, challenge)
}

fn open_browser(url: &str) -> Result<(), String> {
    match std::env::consts::OS {
        "windows" => {
            std::process::Command::new("cmd")
                .args(["/c", "start", "", url])
                .spawn()
                .map_err(|e| format!("Error al abrir navegador en Windows: {e}"))?;
            Ok(())
        }
        "macos" => {
            std::process::Command::new("open")
                .arg(url)
                .spawn()
                .map_err(|e| format!("Error al abrir navegador en macOS: {e}"))?;
            Ok(())
        }
        "linux" => {
            if std::process::Command::new("xdg-open").arg(url).spawn().is_ok() {
                return Ok(());
            }
            std::process::Command::new("gio")
                .args(["open", url])
                .spawn()
                .map_err(|e| format!("Error al abrir navegador en Linux: {e}"))?;
            Ok(())
        }
        os => Err(format!("Sistema operativo no soportado para abrir navegador: {os}")),
    }
}

fn url_encode(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes()).collect()
}

pub fn wait_for_oauth_callback(
    server: tiny_http::Server,
    state_expected: &str,
    timeout: Duration,
) -> Result<String, String> {
    let server = Arc::new(server);
    if let Ok(mut active) = ACTIVE_OAUTH_SERVER.lock() {
        *active = Some(Arc::downgrade(&server));
    }
    struct ActiveServerGuard;
    impl Drop for ActiveServerGuard {
        fn drop(&mut self) {
            if let Ok(mut active) = ACTIVE_OAUTH_SERVER.lock() {
                *active = None;
            }
        }
    }
    let _active_server_guard = ActiveServerGuard;

    let start = std::time::Instant::now();

    loop {
        if OAUTH_CANCEL_REQUESTED.load(Ordering::SeqCst) {
            return Err("Inicio de sesión cancelado por el usuario.".to_string());
        }

        if start.elapsed() > timeout {
            return Err("Tiempo de espera agotado para el inicio de sesión en Google Drive.".to_string());
        }

        match server.recv_timeout(Duration::from_millis(250)) {
            Ok(Some(request)) => {
                let raw_url = request.url().to_string();
                let parsed_url = match url::Url::parse(&format!("http://localhost{raw_url}")) {
                    Ok(u) => u,
                    Err(e) => {
                        let _ = request.respond(tiny_http::Response::from_string("URL inválida").with_status_code(400));
                        return Err(format!("URL de callback inválida: {e}"));
                    }
                };

                if parsed_url.path() == "/callback" {
                    let query_pairs: std::collections::HashMap<_, _> =
                        parsed_url.query_pairs().into_owned().collect();

                    if let Some(err) = query_pairs.get("error") {
                        let resp_html = format!(
                            "<html><body style='background:#101010;color:#f87171;font-family:sans-serif;padding:3rem;text-align:center;'><h2>Error de autenticación: {err}</h2><p>Puedes cerrar esta ventana.</p></body></html>"
                        );
                        let response = tiny_http::Response::from_string(resp_html)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                        let _ = request.respond(response);
                        return Err(format!("Google denegó la autorización: {err}"));
                    }

                    let received_state = query_pairs.get("state").cloned().unwrap_or_default();
                    if received_state != state_expected {
                        let resp_html = "<html><body style='background:#101010;color:#f87171;font-family:sans-serif;padding:3rem;text-align:center;'><h2>Error de seguridad: Estado inválido (posible ataque CSRF).</h2></body></html>";
                        let response = tiny_http::Response::from_string(resp_html)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                        let _ = request.respond(response);
                        return Err("Validación de seguridad OAuth (CSRF) fallida.".to_string());
                    }

                    if let Some(code) = query_pairs.get("code") {
                        let logo_base64 = STANDARD.encode(LYRA_LOGO_BYTES);
                        let success_html = format!(
                            r#"<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Lyra - Google Drive Conectado</title>
  <style>
    body {{
      margin: 0;
      padding: 0;
      background-color: #101010;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }}
    .card {{
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 18px;
      padding: 3.25rem 2.5rem;
      text-align: center;
      max-width: 440px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }}
    .logo {{
      width: 72px;
      height: 72px;
      margin: 0 auto 1.5rem auto;
      display: block;
      object-fit: contain;
      filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.4));
    }}
    h2 {{
      margin: 0 0 0.85rem 0;
      font-size: 1.55rem;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.02em;
      text-wrap: pretty;
    }}
    p {{
      color: #e4e4e7;
      font-size: 1.05rem;
      line-height: 1.6;
      margin: 0.5rem 0;
      text-wrap: pretty;
    }}
    .subtext {{
      color: #d4d4d8;
      font-size: 0.95rem;
      line-height: 1.5;
      margin-top: 1.25rem;
      text-wrap: pretty;
      opacity: 0.9;
    }}
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="data:image/png;base64,{logo_base64}" alt="Lyra" />
    <h2>¡Conexión completada!</h2>
    <p>Tus archivos de Lyra ahora están seguros y sincronizados con Google Drive.</p>
    <p class="subtext">Ya puedes cerrar esta pestaña y volver al programa.</p>
  </div>
</body>
</html>"#
                        );
                        let response = tiny_http::Response::from_string(success_html)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                        let _ = request.respond(response);
                        return Ok(code.clone());
                    }
                }

                let response = tiny_http::Response::from_string("Ruta no encontrada")
                    .with_status_code(404);
                let _ = request.respond(response);
            }
            Ok(None) => continue,
            Err(e) => return Err(format!("Error en el servidor local de callback: {e}")),
        }
    }
}

pub async fn start_oauth_flow(app: &tauri::AppHandle) -> Result<UserProfile, String> {
    if OAUTH_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("Ya hay un proceso de inicio de sesión en curso. Por favor, completa o cancela el intento actual.".to_string());
    }
    OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);

    struct OAuthProgressGuard;
    impl Drop for OAuthProgressGuard {
        fn drop(&mut self) {
            OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
            OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        }
    }
    let _guard = OAuthProgressGuard;

    // Refuse to open the browser unless the native store can persist a session.
    let expected_epoch = prepare_new_auth(app)?;

    let (client_id, client_secret) = get_client_credentials(Some(app))?;

    let (code_verifier, code_challenge) = generate_pkce();

    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let state_token = URL_SAFE_NO_PAD.encode(state_bytes);

    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("No se pudo iniciar el servidor local de autenticación: {e}"))?;

    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "No se pudo obtener la dirección IP local".to_string())?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        url_encode(&client_id),
        url_encode(&redirect_uri),
        url_encode(OAUTH_SCOPES),
        url_encode(&code_challenge),
        url_encode(&state_token)
    );

    open_browser(&auth_url)?;

    let state_expected = state_token.clone();
    let auth_code = tokio::task::spawn_blocking(move || {
        wait_for_oauth_callback(server, &state_expected, OAUTH_TIMEOUT)
    })
    .await
    .map_err(|e| format!("Error en la tarea de autenticación: {e}"))??;

    // Intercambiar código por tokens
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let token_params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("code", auth_code.as_str()),
        ("code_verifier", code_verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri.as_str()),
    ];

    let token_res = http_client
        .post("https://oauth2.googleapis.com/token")
        .form(&token_params)
        .send()
        .await
        .map_err(|e| format!("Error al contactar el servidor de tokens de Google: {e}"))?;

    if !token_res.status().is_success() {
        return Err(format!("Error canjeando código de autorización con Google ({})", token_res.status()));
    }

    let token_data: TokenResponse = token_res
        .json()
        .await
        .map_err(|e| format!("Error al decodificar tokens de Google: {e}"))?;

    let now_sec = chrono::Utc::now().timestamp();
    let expires_at = now_sec + token_data.expires_in - 60;

    // Obtener información del usuario
    let user_res = http_client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&token_data.access_token)
        .send()
        .await
        .map_err(|e| format!("Error al obtener perfil del usuario: {e}"))?;

    if !user_res.status().is_success() {
        let status = user_res.status();
        return Err(format!("Google no permitió verificar la identidad de la cuenta ({status})"));
    }

    let user_info: GoogleUserInfo = user_res
        .json()
        .await
        .map_err(|e| format!("Error al decodificar el perfil de la cuenta de Google: {e}"))?;

    let verified_sub = user_info
        .sub
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Google no devolvió un identificador de cuenta verificado (sub). \
             No se puede conectar la cuenta de forma segura. Inténtalo de nuevo."
                .to_string()
        })?
        .to_string();

    let user_profile = UserProfile {
        sub: Some(verified_sub),
        email: user_info.email,
        name: user_info.name,
        picture: user_info.picture,
    };

    let tokens = OAuthTokens {
        access_token: token_data.access_token,
        refresh_token: token_data.refresh_token,
        expires_at,
        token_type: token_data.token_type,
    };

    let auth_state = StoredAuthState {
        tokens,
        user: user_profile.clone(),
        auto_sync_enabled: true,
    };

    if OAUTH_CANCEL_REQUESTED.load(Ordering::SeqCst) {
        return Err("El inicio de sesión fue cancelado".to_string());
    }
    save_new_auth_state(app, &auth_state, expected_epoch)?;

    Ok(user_profile)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenRefreshError {
    InvalidGrant(String),
    Network(String),
    Other(String),
}

impl std::fmt::Display for TokenRefreshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenRefreshError::InvalidGrant(msg) => write!(f, "Sesión revocada o inválida (invalid_grant): {msg}"),
            TokenRefreshError::Network(msg) => write!(f, "Error de red al renovar credenciales: {msg}"),
            TokenRefreshError::Other(msg) => write!(f, "Error al renovar credenciales: {msg}"),
        }
    }
}

pub trait TokenProvider: Send + Sync {
    fn get_token(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>;
    fn refresh_token(&self, failed_token: &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, TokenRefreshError>> + Send + '_>>;
}

static REFRESH_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn token_from_lease(lease: Option<&(String, i64)>, now: i64) -> Option<String> {
    lease.and_then(|(token, expires_at)| (*expires_at > now + 30).then(|| token.clone()))
}

/// Renueva el token de acceso ante expiración o respuesta HTTP 401.
/// - Implementa doble comprobación para evitar renovaciones concurrentes redundantes.
/// - Si Google responde `invalid_grant`, limpia las credenciales locales y notifica la necesidad de reconexión.
/// - Si ocurre un error de red transitorio, preserva los tokens locales.
pub async fn refresh_access_token_if_needed(
    app: &tauri::AppHandle,
    failed_token: Option<&str>,
    expected_account_key: &str,
    expected_account_epoch: u64,
) -> Result<(String, i64), TokenRefreshError> {
    let _guard = REFRESH_MUTEX.lock().await;

    let (auth_state_opt, expected_epoch) = load_auth_state_with_epoch(app)
        .map_err(|e| TokenRefreshError::Other(format!("Error leyendo estado de autenticación: {e}")))?;
    let mut auth_state = auth_state_opt
        .ok_or_else(|| TokenRefreshError::InvalidGrant("No hay una cuenta de Google Drive conectada.".to_string()))?;
    let actual = verified_account_from_state(&auth_state, expected_epoch).map_err(TokenRefreshError::Other)?;
    ensure_account_matches(Some(expected_account_key), Some(expected_account_epoch), &actual)
        .map_err(TokenRefreshError::Other)?;

    // Doble comprobación: si otro hilo concurrente ya renovó el token, reutilizarlo inmediatamente
    if let Some(failed) = failed_token {
        if auth_state.tokens.access_token != failed {
            return Ok((auth_state.tokens.access_token, auth_state.tokens.expires_at));
        }
    }

    let refresh_token = match auth_state.tokens.refresh_token.as_ref() {
        Some(t) if !t.trim().is_empty() => t.clone(),
        _ => {
            let _ = clear_auth_state_bound(app, expected_epoch, &auth_state.user.sub);
            return Err(TokenRefreshError::InvalidGrant(
                "No se encontró token de actualización (refresh token). Por favor, vuelve a iniciar sesión.".to_string(),
            ));
        }
    };

    let (client_id, client_secret) = get_client_credentials(Some(app))
        .map_err(TokenRefreshError::Other)?;

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| TokenRefreshError::Network(format!("Error creando cliente HTTP: {e}")))?;

    let refresh_params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("refresh_token", refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];

    let res = match http_client
        .post("https://oauth2.googleapis.com/token")
        .form(&refresh_params)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Error de red temporal: NO borramos los tokens locales
            return Err(TokenRefreshError::Network(format!("Fallo de conexión al contactar a Google: {e}")));
        }
    };

    let status = res.status();
    if !status.is_success() {
        let err_text = res.text().await.unwrap_or_default();
        if err_text.contains("invalid_grant") || (status == reqwest::StatusCode::BAD_REQUEST && err_text.contains("revoked")) {
            // El usuario revocó el acceso en Google o cambió la clave: limpiar credenciales locales
            let _ = clear_auth_state_bound(app, expected_epoch, &auth_state.user.sub);
            return Err(TokenRefreshError::InvalidGrant(
                "Acceso revocado en Google (invalid_grant). Es necesario volver a conectar la cuenta.".to_string(),
            ));
        }
        if status.is_server_error() {
            return Err(TokenRefreshError::Network(format!("Servidores de Google no disponibles ({status})")));
        }
        return Err(TokenRefreshError::Other(format!("Error de Google ({status})")));
    }

    let refreshed: TokenResponse = res
        .json()
        .await
        .map_err(|e| TokenRefreshError::Other(format!("Error decodificando respuesta de token renovado: {e}")))?;

    let now_sec = chrono::Utc::now().timestamp();
    auth_state.tokens.access_token = refreshed.access_token.clone();
    auth_state.tokens.expires_at = now_sec + refreshed.expires_in - 60;
    if refreshed.refresh_token.is_some() {
        auth_state.tokens.refresh_token = refreshed.refresh_token;
    }

    save_auth_state_bound(app, &auth_state, expected_epoch, &refresh_token)
        .map_err(|e| TokenRefreshError::Other(format!("Error guardando tokens renovados: {e}")))?;

    Ok((refreshed.access_token, auth_state.tokens.expires_at))
}

pub async fn get_valid_access_token(app: &tauri::AppHandle, expected_account_key: &str, expected_account_epoch: u64) -> Result<(String, i64), String> {
    let (auth_state_opt, epoch) = load_auth_state_with_epoch(app)?;
    let auth_state = auth_state_opt.ok_or_else(|| "No hay una cuenta de Google Drive conectada.".to_string())?;
    let actual = verified_account_from_state(&auth_state, epoch)?;
    ensure_account_matches(Some(expected_account_key), Some(expected_account_epoch), &actual)?;

    let now_sec = chrono::Utc::now().timestamp();
    if auth_state.tokens.expires_at > now_sec + 30 {
        return Ok((auth_state.tokens.access_token, auth_state.tokens.expires_at));
    }

    refresh_access_token_if_needed(app, None, expected_account_key, expected_account_epoch)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Clone)]
pub struct TauriTokenProvider {
    app: tauri::AppHandle,
    expected_account_key: Option<String>,
    expected_epoch: Option<u64>,
    token_lease: Arc<TokenLease>,
    token_load_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl TauriTokenProvider {
    /// Proveedor ligado a una cuenta y época concretas.
    ///
    /// Si la cuenta cambia o se cierra sesión a mitad de una operación, cualquier
    /// petición de token falla cerrado en lugar de usar credenciales de otra cuenta.
    pub fn new_for_account(
        app: tauri::AppHandle,
        account_key: String,
        epoch: u64,
    ) -> Self {
        let token_lease = Arc::new(Mutex::new(None));
        {
            let mut leases = token_leases().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            leases.retain(|lease| lease.strong_count() > 0);
            leases.push(Arc::downgrade(&token_lease));
        }
        Self {
            app,
            expected_account_key: Some(account_key),
            expected_epoch: Some(epoch),
            token_lease,
            token_load_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn ensure_same_account(&self) -> Result<(), String> {
        if self.expected_account_key.is_none() { return Err("Token provider has no account binding".into()); }
        if self.expected_epoch != Some(account_epoch()) {
            return Err("La sesión de Google Drive cambió durante la operación".into());
        }
        Ok(())
    }

    fn cached_token(&self) -> Result<Option<String>, String> {
        let lease = self.token_lease.lock().map_err(|_| "Token cache unavailable")?;
        Ok(token_from_lease(lease.as_ref(), chrono::Utc::now().timestamp()))
    }
}

/// Comprueba que la cuenta verificada siga siendo la misma con la que comenzó
/// una operación. Si cambió la cuenta o la época de sesión, falla cerrado.
pub fn ensure_account_matches(
    expected_account_key: Option<&str>,
    expected_epoch: Option<u64>,
    actual: &VerifiedAccount,
) -> Result<(), String> {
    if let Some(expected) = expected_account_key {
        if actual.account_key != expected {
            return Err(
                "La cuenta de Google Drive cambió durante la operación. \
                 Se canceló la sincronización para evitar mezclar notas entre cuentas."
                    .to_string(),
            );
        }
    }
    if let Some(expected_epoch) = expected_epoch {
        if actual.epoch != expected_epoch {
            return Err(
                "La sesión de Google Drive cambió durante la operación. \
                 Se canceló la sincronización para evitar mezclar notas entre cuentas."
                    .to_string(),
            );
        }
    }
    Ok(())
}

impl TokenProvider for TauriTokenProvider {
    fn get_token(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>> {
        Box::pin(async move {
            self.ensure_same_account()?;
            if let Some(token) = self.cached_token()? {
                self.ensure_same_account()?;
                return Ok(token);
            }
            let _load_guard = self.token_load_lock.lock().await;
            self.ensure_same_account()?;
            if let Some(token) = self.cached_token()? {
                self.ensure_same_account()?;
                return Ok(token);
            }
            let (token, expires_at) = get_valid_access_token(&self.app,
                self.expected_account_key.as_deref().ok_or("Missing account binding")?,
                self.expected_epoch.ok_or("Missing account epoch")?).await?;
            self.ensure_same_account()?;
            *self.token_lease.lock().map_err(|_| "Token cache unavailable")? = Some((token.clone(), expires_at));
            if let Err(error) = self.ensure_same_account() {
                *self.token_lease.lock().map_err(|_| "Token cache unavailable")? = None;
                return Err(error);
            }
            Ok(token)
        })
    }

    fn refresh_token(&self, failed_token: &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, TokenRefreshError>> + Send + '_>> {
        let failed = failed_token.to_string();
        Box::pin(async move {
            self.ensure_same_account().map_err(TokenRefreshError::Other)?;
            let (token, expires_at) = refresh_access_token_if_needed(&self.app, Some(&failed),
                self.expected_account_key.as_deref().ok_or_else(|| TokenRefreshError::Other("Missing account binding".into()))?,
                self.expected_epoch.ok_or_else(|| TokenRefreshError::Other("Missing account epoch".into()))?).await?;
            self.ensure_same_account().map_err(TokenRefreshError::Other)?;
            *self.token_lease.lock().map_err(|_| TokenRefreshError::Other("Token cache unavailable".into()))? =
                Some((token.clone(), expires_at));
            if let Err(error) = self.ensure_same_account() {
                *self.token_lease.lock().map_err(|_| TokenRefreshError::Other("Token cache unavailable".into()))? = None;
                return Err(TokenRefreshError::Other(error));
            }
            Ok(token)
        })
    }
}

/// Revoca un token en el endpoint oficial de Google (`https://oauth2.googleapis.com/revoke`).
#[allow(dead_code)]
pub async fn revoke_token_remote(token: &str, http_client: &reqwest::Client) -> Result<(), String> {
    revoke_token_remote_with_url("https://oauth2.googleapis.com/revoke", token, http_client).await
}

pub async fn revoke_token_remote_with_url(
    endpoint: &str,
    token: &str,
    http_client: &reqwest::Client,
) -> Result<(), String> {
    let params = [("token", token)];
    let res = http_client
        .post(endpoint)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Error de red al revocar token: {e}"))?;

    if res.status().is_success() {
        Ok(())
    } else {
        let status = res.status();
        Err(format!("Google devolvió código {status} al revocar el acceso"))
    }
}

pub async fn revoke_logout_state(state: Option<StoredAuthState>) -> bool {
    revoke_logout_state_with_url(state, "https://oauth2.googleapis.com/revoke").await
}

async fn revoke_logout_state_with_url(state: Option<StoredAuthState>, endpoint: &str) -> bool {
    let Some(state) = state else { return true; };
    let token = state.tokens.refresh_token.as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&state.tokens.access_token);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(6)).build()
        .unwrap_or_else(|_| reqwest::Client::new());
    if let Err(error) = revoke_token_remote_with_url(endpoint, token, &client).await {
        let safe_error = super::sync::sanitize_error_message(&error);
        eprintln!("[GDrive] Remote revocation failed: {safe_error}");
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_lease_reuses_only_a_still_valid_access_token() {
        let lease = ("fictional-access".to_string(), 1_100);
        assert_eq!(token_from_lease(Some(&lease), 1_000).as_deref(), Some("fictional-access"));
        assert_eq!(token_from_lease(Some(&lease), 1_070), None);
        assert_eq!(token_from_lease(None, 1_000), None);
    }

    #[test]
    fn test_oauth_scopes_uses_drive_file_and_userinfo() {
        let scopes: Vec<&str> = OAUTH_SCOPES.split_whitespace().collect();
        assert!(
            scopes.contains(&"https://www.googleapis.com/auth/drive.file"),
            "Debe incluir el scope no restringido drive.file"
        );
        assert!(
            scopes.contains(&"https://www.googleapis.com/auth/userinfo.email"),
            "Debe mantener userinfo.email"
        );
        assert!(
            scopes.contains(&"https://www.googleapis.com/auth/userinfo.profile"),
            "Debe mantener userinfo.profile"
        );
        assert!(
            !scopes.contains(&"https://www.googleapis.com/auth/drive"),
            "NO debe contener el scope restringido drive"
        );
    }

    #[test]
    fn test_generate_pkce_valid_format() {
        let (verifier, challenge) = generate_pkce();

        // RFC 7636: verifier entre 43 y 128 caracteres en URL-safe base64 sin padding
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert!(!verifier.contains('='));
        assert!(!verifier.contains('+'));
        assert!(!verifier.contains('/'));

        // Challenge debe ser SHA-256 de verifier en base64url sin padding (43 caracteres para 32 bytes)
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains('='));

        // Verificar cálculo determinista del challenge
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let expected_challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(challenge, expected_challenge);
    }

    #[test]
    fn test_url_encode_special_characters() {
        assert_eq!(url_encode("hello world"), "hello+world");
        assert_eq!(url_encode("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
    }

    #[test]
    fn test_bound_operation_fails_closed_when_account_or_epoch_changes() {
        let account = |key: &str, epoch: u64| VerifiedAccount {
            sub: key.to_string(),
            account_key: key.to_string(),
            email: format!("{key}@example.com"),
            name: None,
            picture: None,
            epoch,
        };
        let current = account("account_b", 7);

        assert!(ensure_account_matches(Some("account_b"), Some(7), &current).is_ok());
        assert!(ensure_account_matches(None, None, &current).is_ok());

        let account_changed = ensure_account_matches(Some("account_a"), Some(7), &current)
            .expect_err("Cambiar de cuenta debe cancelar la operación");
        assert!(account_changed.contains("cuenta de Google Drive cambió"));

        let session_changed = ensure_account_matches(Some("account_b"), Some(8), &current)
            .expect_err("Volver a iniciar sesión debe cancelar la operación");
        assert!(session_changed.contains("sesión de Google Drive cambió"));
    }

    #[test]
    fn test_verified_account_requires_google_sub() {
        let mut state = StoredAuthState {
            tokens: OAuthTokens {
                access_token: "token".to_string(),
                refresh_token: None,
                expires_at: 1893456000,
                token_type: "Bearer".to_string(),
            },
            user: UserProfile {
                sub: None,
                email: "sin-sub@example.com".to_string(),
                name: None,
                picture: None,
            },
            auto_sync_enabled: true,
        };

        let err = verified_account_from_state(&state, 1)
            .expect_err("Sin sub no hay identidad verificada");
        assert!(err.contains("sub"));

        state.user.sub = Some("  ".to_string());
        assert!(verified_account_from_state(&state, 1).is_err(), "Un sub vacío no es identidad válida");

        state.user.sub = Some("sub_verificado".to_string());
        let account = verified_account_from_state(&state, 3).unwrap();
        assert_eq!(account.sub, "sub_verificado");
        assert_eq!(account.account_key, sanitize_account_key("sub_verificado"));
        assert_eq!(account.epoch, 3);
    }

    #[test]
    fn test_stored_auth_state_serialization_roundtrip() {
        let state = StoredAuthState {
            tokens: OAuthTokens {
                access_token: "test_access_token".to_string(),
                refresh_token: Some("test_refresh_token".to_string()),
                expires_at: 1893456000,
                token_type: "Bearer".to_string(),
            },
            user: UserProfile {
                sub: Some("test_sub_123".to_string()),
                email: "test@example.com".to_string(),
                name: Some("Test User".to_string()),
                picture: None,
            },
            auto_sync_enabled: true,
        };

        let serialized = serde_json::to_string(&state).expect("serialize");
        let deserialized: StoredAuthState = serde_json::from_str(&serialized).expect("deserialize");

        assert_eq!(deserialized.tokens.access_token, "test_access_token");
        assert_eq!(deserialized.tokens.refresh_token.as_deref(), Some("test_refresh_token"));
        assert_eq!(deserialized.user.email, "test@example.com");
        assert!(deserialized.auto_sync_enabled);
    }

    #[test]
    fn test_client_credentials_from_env() {
        std::env::set_var("GOOGLE_CLIENT_ID", "test_mock_id_123");
        std::env::set_var("GOOGLE_CLIENT_SECRET", "test_mock_secret_456");

        let creds = get_client_credentials(None);
        assert!(creds.is_ok());
        let (id, secret) = creds.unwrap();
        assert_eq!(id, "test_mock_id_123");
        assert_eq!(secret, "test_mock_secret_456");
    }

    #[test]
    fn test_oauth_config_file_deserialization() {
        let json_data = r#"{
            "client_id": "config_file_id.apps.googleusercontent.com",
            "client_secret": "GOCSPX-secret123"
        }"#;

        let parsed: Result<OAuthConfigFile, _> = serde_json::from_str(json_data);
        assert!(parsed.is_ok());
        let cfg = parsed.unwrap();
        assert_eq!(cfg.client_id, "config_file_id.apps.googleusercontent.com");
        assert_eq!(cfg.client_secret, "GOCSPX-secret123");
    }

    #[derive(Default)]
    struct MockCredentialStore {
        value: Mutex<Option<Vec<u8>>>,
        fail_read: AtomicBool,
        fail_write: AtomicBool,
        fail_delete: AtomicBool,
        fail_read_after_write: AtomicBool,
        tamper_write: AtomicBool,
    }

    impl CredentialStore for MockCredentialStore {
        fn read(&self) -> Result<Option<Vec<u8>>, String> {
            if self.fail_read.load(Ordering::SeqCst) {
                return Err("Secure store unavailable or locked".into());
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn write(&self, value: &[u8]) -> Result<(), String> {
            if self.fail_write.load(Ordering::SeqCst) {
                return Err("Secure store unavailable or locked".into());
            }
            *self.value.lock().unwrap() = Some(if self.tamper_write.load(Ordering::SeqCst) {
                vec![1, 0, 0]
            } else {
                value.to_vec()
            });
            if self.fail_read_after_write.load(Ordering::SeqCst) {
                self.fail_read.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err("Secure store unavailable or locked".into());
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
        fn probe(&self) -> Result<(), String> {
            if self.fail_read.load(Ordering::SeqCst) || self.fail_write.load(Ordering::SeqCst) {
                Err("Secure store unavailable or locked".into())
            } else {
                Ok(())
            }
        }
    }

    fn mock_auth_state(sub: &str) -> StoredAuthState {
        StoredAuthState {
            tokens: OAuthTokens {
                access_token: format!("fake-access-{sub}"),
                refresh_token: Some(format!("fake-refresh-{sub}")),
                expires_at: 1_900_000_000,
                token_type: "Bearer".into(),
            },
            user: UserProfile {
                sub: Some(sub.into()),
                email: format!("{sub}@example.test"),
                name: None,
                picture: None,
            },
            auto_sync_enabled: true,
        }
    }

    fn mock_credential_paths() -> (PathBuf, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("lyra_secure_auth_{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        (dir.clone(), dir.join("gdrive_token.json"), dir.join(".gdrive_token.json"))
    }

    #[test]
    fn test_secure_store_initial_save_and_restore() {
        let store = MockCredentialStore::default();
        let state = mock_auth_state("account-a");
        write_secure_state_at(&store, &state).unwrap();
        assert_eq!(read_secure_state(&store).unwrap(), Some(state));
        let raw = store.value.lock().unwrap().clone().unwrap();
        assert_eq!(raw.first(), Some(&1));
        assert_ne!(raw.first(), Some(&b'{'));
    }

    #[test]
    fn test_migration_verifies_and_removes_both_known_json_copies() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let state = mock_auth_state("account-a");
        let raw = serde_json::to_vec(&state).unwrap();
        fs::write(&config, &raw).unwrap();
        fs::write(&legacy, &raw).unwrap();
        assert_eq!(migrate_auth_state_at(&store, &config, &legacy).unwrap(), Some(state.clone()));
        assert!(!config.exists());
        assert!(!legacy.exists());
        assert_eq!(migrate_auth_state_at(&store, &config, &legacy).unwrap(), Some(state));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_migration_fails_closed_on_corrupt_or_conflicting_legacy_files() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        fs::write(&legacy, b"{invalid secret json").unwrap();
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), b"{invalid secret json");
        fs::write(&legacy, serde_json::to_vec(&mock_auth_state("account-a")).unwrap()).unwrap();
        fs::write(&config, serde_json::to_vec(&mock_auth_state("account-b")).unwrap()).unwrap();
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        assert!(config.exists() && legacy.exists());
        assert!(store.value.lock().unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_migration_write_failure_or_locked_store_preserves_plaintext_for_retry() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let raw = serde_json::to_vec(&mock_auth_state("account-a")).unwrap();
        fs::write(&config, &raw).unwrap();
        store.fail_read.store(true, Ordering::SeqCst);
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        store.fail_read.store(false, Ordering::SeqCst);
        store.fail_write.store(true, Ordering::SeqCst);
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        assert_eq!(fs::read(&config).unwrap(), raw);
        assert!(store.value.lock().unwrap().is_none());
        store.fail_write.store(false, Ordering::SeqCst);
        assert!(migrate_auth_state_at(&store, &config, &legacy).unwrap().is_some());
        assert!(!config.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_interrupted_migration_retains_json_then_recovers() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let state = mock_auth_state("account-a");
        fs::write(&legacy, serde_json::to_vec(&state).unwrap()).unwrap();
        store.fail_read_after_write.store(true, Ordering::SeqCst);
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        assert!(legacy.exists());
        store.fail_read.store(false, Ordering::SeqCst);
        store.fail_read_after_write.store(false, Ordering::SeqCst);
        assert_eq!(migrate_auth_state_at(&store, &config, &legacy).unwrap(), Some(state));
        assert!(!legacy.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_migration_readback_corruption_keeps_legacy_file() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let raw = serde_json::to_vec(&mock_auth_state("account-a")).unwrap();
        fs::write(&legacy, &raw).unwrap();
        store.tamper_write.store(true, Ordering::SeqCst);
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        assert_eq!(fs::read(&legacy).unwrap(), raw);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_secure_account_mismatch_never_overwrites_or_deletes_other_account() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let active = mock_auth_state("account-a");
        write_secure_state_at(&store, &active).unwrap();
        fs::write(&config, serde_json::to_vec(&mock_auth_state("account-b")).unwrap()).unwrap();
        assert!(migrate_auth_state_at(&store, &config, &legacy).is_err());
        assert_eq!(read_secure_state(&store).unwrap(), Some(active));
        assert!(config.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_new_login_requires_writable_store_and_no_active_account() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        store.fail_write.store(true, Ordering::SeqCst);
        assert!(prepare_new_auth_at(&store, &config, &legacy).is_err());
        assert!(save_new_auth_state_at(&store, &config, &legacy, &mock_auth_state("account-a"), 4, 4).is_err());
        store.fail_write.store(false, Ordering::SeqCst);
        prepare_new_auth_at(&store, &config, &legacy).unwrap();
        assert!(save_new_auth_state_at(&store, &config, &legacy, &mock_auth_state("account-a"), 4, 5).is_err());
        save_new_auth_state_at(&store, &config, &legacy, &mock_auth_state("account-a"), 4, 4).unwrap();
        assert!(prepare_new_auth_at(&store, &config, &legacy).is_err());
        assert!(save_new_auth_state_at(&store, &config, &legacy, &mock_auth_state("account-b"), 4, 4).is_err());
        assert_eq!(read_secure_state(&store).unwrap(), Some(mock_auth_state("account-a")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_refresh_rejects_stale_epoch_and_wrong_account() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let original = mock_auth_state("account-a");
        write_secure_state_at(&store, &original).unwrap();
        let mut renewed = original.clone();
        renewed.tokens.access_token = "renewed-fake-access".into();
        let original_refresh = original.tokens.refresh_token.as_deref().unwrap();
        assert!(save_auth_state_bound_at(&store, &config, &legacy, &renewed, 7, 8, original_refresh).is_err());
        assert!(save_auth_state_bound_at(&store, &config, &legacy, &mock_auth_state("account-b"), 7, 7, original_refresh).is_err());
        assert_eq!(read_secure_state(&store).unwrap(), Some(original));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_refresh_accepts_rotation_and_preserves_newer_preference() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let original = mock_auth_state("account-a");
        write_secure_state_at(&store, &original).unwrap();
        let mut current = original.clone();
        current.auto_sync_enabled = false;
        write_secure_state_at(&store, &current).unwrap();
        let mut renewed = original.clone();
        renewed.tokens.access_token = "renewed-fake-access".into();
        renewed.tokens.refresh_token = Some("rotated-fake-refresh".into());
        save_auth_state_bound_at(&store, &config, &legacy, &renewed, 7, 7, "fake-refresh-account-a").unwrap();
        let stored = read_secure_state(&store).unwrap().unwrap();
        assert_eq!(stored.tokens.access_token, "renewed-fake-access");
        assert_eq!(stored.tokens.refresh_token.as_deref(), Some("rotated-fake-refresh"));
        assert!(!stored.auto_sync_enabled);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_account_switch_requires_logout_and_rejects_old_refresh_result() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let account_a = mock_auth_state("account-a");
        write_secure_state_at(&store, &account_a).unwrap();
        assert!(save_new_auth_state_at(&store, &config, &legacy, &mock_auth_state("account-b"), 3, 3).is_err());
        assert_eq!(take_auth_state_at(&store, &config, &legacy).unwrap(), (Some(account_a.clone()), true));
        save_new_auth_state_at(&store, &config, &legacy, &mock_auth_state("account-b"), 4, 4).unwrap();
        assert!(save_auth_state_bound_at(&store, &config, &legacy, &account_a, 3, 4, "fake-refresh-account-a").is_err());
        assert_eq!(read_secure_state(&store).unwrap(), Some(mock_auth_state("account-b")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_token_debug_and_store_errors_do_not_expose_secrets() {
        let state = mock_auth_state("account-a");
        let debug = format!("{state:?}");
        assert!(!debug.contains("fake-access-account-a"));
        assert!(!debug.contains("fake-refresh-account-a"));
        let store = MockCredentialStore::default();
        store.fail_write.store(true, Ordering::SeqCst);
        let error = write_secure_state_at(&store, &state).unwrap_err();
        assert!(!error.contains("fake-access-account-a"));
        assert!(!error.contains("fake-refresh-account-a"));
    }

    #[test]
    fn test_public_ipc_structs_never_expose_tokens() {
        use crate::gdrive::types::{SyncResult, SyncStatus};

        let user = UserProfile {
            sub: None,
            email: "user@test.com".to_string(),
            name: Some("Test".to_string()),
            picture: None,
        };
        let user_json = serde_json::to_string(&user).unwrap();
        assert!(!user_json.contains("token"));
        assert!(!user_json.contains("secret"));

        let status = SyncStatus {
            is_connected: true,
            is_syncing: false,
            user_email: Some("user@test.com".to_string()),
            user_name: Some("Test".to_string()),
            user_photo: None,
            last_sync_timestamp: Some(123456789),
            last_error: None,
            auto_sync_enabled: true,
            backend_version: Some("2.0.13".to_string()),
            backend_build_timestamp: Some("2026-10-29T00:00:00Z".to_string()),
        };
        let status_json = serde_json::to_string(&status).unwrap();
        assert!(!status_json.contains("token"));
        assert!(!status_json.contains("secret"));

        let res = SyncResult {
            sync_id: "test-sync".to_string(),
            uploaded: vec!["file1.md".to_string()],
            downloaded: vec![],
            conflicts: vec![],
            deleted_remote: vec![],
            errors: vec![],
            ..Default::default()
        };
        let res_json = serde_json::to_string(&res).unwrap();
        assert!(!res_json.contains("token"));
        assert!(!res_json.contains("secret"));
    }

    static TEST_OAUTH_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn bind_server_with_drain(
        addr: &str,
        timeout: Duration,
    ) -> Result<tiny_http::Server, Box<dyn std::error::Error + Send + Sync + 'static>> {
        let start = std::time::Instant::now();
        loop {
            match tiny_http::Server::http(addr) {
                Ok(server) => return Ok(server),
                Err(e) => {
                    if start.elapsed() >= timeout {
                        return Err(e);
                    }
                    std::thread::yield_now();
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    #[tokio::test]
    async fn test_oauth_cancellation_and_concurrency_flags() {
        let _lock = TEST_OAUTH_MUTEX.lock().await;
        // Asegurar estado inicial limpio
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        assert!(!is_oauth_in_progress());
        assert!(!OAUTH_CANCEL_REQUESTED.load(Ordering::SeqCst));

        // Si no está en progreso, cancel_oauth_flow() no debe activar cancelación
        assert!(cancel_oauth_flow().is_ok());
        assert!(!OAUTH_CANCEL_REQUESTED.load(Ordering::SeqCst));

        // Marcamos progreso
        OAUTH_IN_PROGRESS.store(true, Ordering::SeqCst);
        assert!(is_oauth_in_progress());

        // Ahora cancelar sí debe activar OAUTH_CANCEL_REQUESTED
        assert!(cancel_oauth_flow().is_ok());
        assert!(OAUTH_CANCEL_REQUESTED.load(Ordering::SeqCst));

        // Limpieza final
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn test_mock_remote_revocation_success() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let endpoint = format!("http://127.0.0.1:{port}/revoke");

        let handle = std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let response = tiny_http::Response::from_string("OK").with_status_code(200);
                let _ = req.respond(response);
            }
        });

        let http_client = reqwest::Client::new();
        let res = revoke_token_remote_with_url(&endpoint, "valid_mock_refresh_token", &http_client).await;
        assert!(res.is_ok());

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_remote_revocation_error() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let endpoint = format!("http://127.0.0.1:{port}/revoke");

        let handle = std::thread::spawn(move || {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let response = tiny_http::Response::from_string(r#"{"error":"invalid_token"}"#).with_status_code(400);
                let _ = req.respond(response);
            }
        });

        let http_client = reqwest::Client::new();
        let res = revoke_token_remote_with_url(&endpoint, "expired_mock_token", &http_client).await;
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("400"));
        assert!(!err.contains("expired_mock_token"));

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_logout_deletes_secure_credential_before_remote_response() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let note = dir.join("fictional-note.md");
        fs::write(&note, "safe local content").unwrap();
        let state = mock_auth_state("account-a");
        write_secure_state_at(&store, &state).unwrap();
        let epoch = account_epoch();
        let (captured, readable) = take_auth_state_at(&store, &config, &legacy).unwrap();
        assert!(readable);
        assert_eq!(captured, Some(state));
        assert!(account_epoch() > epoch);
        assert!(store.value.lock().unwrap().is_none());
        assert_eq!(fs::read_to_string(&note).unwrap(), "safe local content");

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/revoke", server.server_addr());
        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server_thread = std::thread::spawn(move || {
            let request = server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            reached_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            request.respond(tiny_http::Response::empty(200)).unwrap();
        });
        let task = tokio::spawn(async move { revoke_logout_state_with_url(captured, &endpoint).await });
        tokio::task::spawn_blocking(move || reached_rx.recv_timeout(Duration::from_secs(5)).unwrap()).await.unwrap();
        assert!(store.value.lock().unwrap().is_none());
        release_tx.send(()).unwrap();
        assert!(task.await.unwrap());
        server_thread.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn test_remote_revocation_failure_does_not_restore_local_session() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        write_secure_state_at(&store, &mock_auth_state("account-a")).unwrap();
        let (captured, readable) = take_auth_state_at(&store, &config, &legacy).unwrap();
        assert!(readable);
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/revoke", server.server_addr());
        let handle = std::thread::spawn(move || {
            if let Ok(Some(request)) = server.recv_timeout(Duration::from_secs(5)) {
                request.respond(tiny_http::Response::empty(500)).unwrap();
            }
        });
        assert!(!revoke_logout_state_with_url(captured, &endpoint).await);
        assert!(store.value.lock().unwrap().is_none());
        handle.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_logout_store_delete_failure_is_reported_without_restoring_plaintext() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        write_secure_state_at(&store, &mock_auth_state("account-a")).unwrap();
        store.fail_delete.store(true, Ordering::SeqCst);
        let epoch = account_epoch();
        assert!(take_auth_state_at(&store, &config, &legacy).is_err());
        assert!(account_epoch() > epoch);
        assert!(store.value.lock().unwrap().is_some());
        assert!(!config.exists() && !legacy.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_logout_removes_legacy_json_without_migrating_it_first() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        let state = mock_auth_state("account-a");
        fs::write(&config, serde_json::to_vec(&state).unwrap()).unwrap();
        fs::write(&legacy, serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(take_auth_state_at(&store, &config, &legacy).unwrap(), (Some(state), true));
        assert!(!config.exists() && !legacy.exists());
        assert!(store.value.lock().unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_logout_removes_corrupt_secure_credential_without_claiming_revocation() {
        let store = MockCredentialStore::default();
        let (dir, config, legacy) = mock_credential_paths();
        *store.value.lock().unwrap() = Some(vec![1, 0, 0]);
        let (captured, readable) = take_auth_state_at(&store, &config, &legacy).unwrap();
        assert!(captured.is_none());
        assert!(!readable);
        assert!(store.value.lock().unwrap().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn test_real_oauth_server_cancel_frees_port_and_allows_subsequent_login() {
        let _lock = TEST_OAUTH_MUTEX.lock().await;
        // Asegurar estado inicial limpio
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        // 1. Iniciamos un servidor real en un puerto dinámico del sistema operativo
        let server1 = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let assigned_port = server1.server_addr().to_ip().unwrap().port();

        OAUTH_IN_PROGRESS.store(true, Ordering::SeqCst);

        // Hilo 1: Espera callback en el servidor real
        let server1_thread = std::thread::spawn(move || {
            wait_for_oauth_callback(server1, "state_cancel_test", Duration::from_secs(10))
        });

        // Esperar brevemente a que el servidor esté en su bucle de escucha
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Cancelar el flujo mientras el servidor está escuchando
        assert!(cancel_oauth_flow().is_ok());

        // El servidor 1 debe haber detectado la cancelación en <= 250ms y haber terminado
        let result1 = server1_thread.join().unwrap();
        assert!(result1.is_err());
        assert!(result1.unwrap_err().contains("cancelado por el usuario"));

        // Limpiar banderas como lo hace OAuthProgressGuard en start_oauth_flow
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        // 2. Comprobar que el puerto asignado fue COMPLETAMENTE liberado
        // Intentamos enlazar un segundo servidor exactamente en el MISMO puerto
        let server2 = bind_server_with_drain(&format!("127.0.0.1:{assigned_port}"), Duration::from_secs(5))
            .expect("El puerto debe estar libre tras la cancelación del servidor anterior");

        OAUTH_IN_PROGRESS.store(true, Ordering::SeqCst);

        // Hilo 2: Segundo intento de inicio de sesión
        let state2 = "state_success_test".to_string();
        let server2_thread = std::thread::spawn(move || {
            wait_for_oauth_callback(server2, &state2, Duration::from_secs(10))
        });

        // Simular que el navegador del usuario completa la autorización y redirige a /callback
        let http_client = reqwest::Client::new();
        let callback_url = format!(
            "http://127.0.0.1:{assigned_port}/callback?code=mock_google_code_xyz&state=state_success_test"
        );
        let resp = http_client.get(&callback_url).send().await.unwrap();
        assert!(resp.status().is_success());
        let html_body = resp.text().await.unwrap();
        assert!(html_body.contains("¡Conexión completada!"));

        // El hilo 2 debe haber retornado el código exitosamente sin interferencia del flujo previo
        let result2 = server2_thread.join().unwrap();
        assert!(result2.is_ok());
        assert_eq!(result2.unwrap(), "mock_google_code_xyz");

        // Limpieza final
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn test_oauth_callback_timeout_frees_port_and_allows_subsequent_login() {
        let _lock = TEST_OAUTH_MUTEX.lock().await;
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        // 1. Iniciamos un servidor real en un puerto dinámico
        let server1 = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let assigned_port = server1.server_addr().to_ip().unwrap().port();

        OAUTH_IN_PROGRESS.store(true, Ordering::SeqCst);

        // Hilo 1: Espera callback con un timeout breve (300ms) sin recibir peticiones
        let server1_thread = std::thread::spawn(move || {
            wait_for_oauth_callback(server1, "state_timeout_test", Duration::from_millis(300))
        });

        let result1 = server1_thread.join().unwrap();
        assert!(result1.is_err(), "Debe fallar al expirar el timeout");
        let err_msg = result1.unwrap_err();
        assert!(
            err_msg.contains("Tiempo de espera agotado"),
            "El mensaje de error debe indicar que el tiempo de espera expiró: {err_msg}"
        );

        // Limpiar banderas como lo hace OAuthProgressGuard al salir start_oauth_flow
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);

        // 2. Comprobar que el puerto asignado fue COMPLETAMENTE liberado tras el timeout
        let server2 = bind_server_with_drain(&format!("127.0.0.1:{assigned_port}"), Duration::from_secs(5))
            .expect("El puerto debe estar libre tras el timeout del servidor anterior");

        OAUTH_IN_PROGRESS.store(true, Ordering::SeqCst);

        // Hilo 2: Reintento posterior de inicio de sesión
        let state2 = "state_retry_test".to_string();
        let server2_thread = std::thread::spawn(move || {
            wait_for_oauth_callback(server2, &state2, Duration::from_secs(10))
        });

        // Simular que el usuario completa el inicio de sesión en el segundo intento
        let http_client = reqwest::Client::new();
        let callback_url = format!(
            "http://127.0.0.1:{assigned_port}/callback?code=mock_retry_code_123&state=state_retry_test"
        );
        let resp = http_client.get(&callback_url).send().await.unwrap();
        assert!(resp.status().is_success());

        let result2 = server2_thread.join().unwrap();
        assert!(result2.is_ok());
        assert_eq!(result2.unwrap(), "mock_retry_code_123");

        // Limpieza final
        OAUTH_IN_PROGRESS.store(false, Ordering::SeqCst);
        OAUTH_CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    }
}
