use keyring::{Entry, Error};

const SERVICE: &str = "com.lyra.dev.google-drive";
const ACTIVE_ACCOUNT: &str = "active-oauth-session";
const STORE_ERROR: &str = "El almacén seguro del sistema no está disponible o está bloqueado. Habilítalo o desbloquéalo y vuelve a intentarlo.";

pub trait CredentialStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, value: &[u8]) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
    fn probe(&self) -> Result<(), String>;
}

pub struct SystemCredentialStore;

/// F4 credentials are isolated by the local workspace ID. The legacy global
/// key remains available only to the old migration tests and is never used to
/// authenticate a workspace implicitly.
pub struct WorkspaceCredentialStore {
    user: String,
}

impl WorkspaceCredentialStore {
    pub fn new(workspace_id: &str) -> Result<Self, String> {
        crate::workspaces::ids::validate_id(workspace_id)?;
        Ok(Self { user: format!("workspace-{workspace_id}") })
    }
}

impl CredentialStore for WorkspaceCredentialStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        match SystemCredentialStore::entry(&self.user)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(_) => Err(STORE_ERROR.to_string()),
        }
    }

    fn write(&self, value: &[u8]) -> Result<(), String> {
        SystemCredentialStore::entry(&self.user)?.set_secret(value)
            .map_err(|_| STORE_ERROR.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match SystemCredentialStore::entry(&self.user)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err(STORE_ERROR.to_string()),
        }
    }

    fn probe(&self) -> Result<(), String> { SystemCredentialStore.probe() }
}

impl SystemCredentialStore {
    fn entry(user: &str) -> Result<Entry, String> {
        if !cfg!(any(target_os = "windows", target_os = "linux")) {
            return Err("El almacenamiento seguro de Google Drive no está disponible en esta plataforma".to_string());
        }
        Entry::new(SERVICE, user).map_err(|_| STORE_ERROR.to_string())
    }
}

impl CredentialStore for SystemCredentialStore {
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        match Self::entry(ACTIVE_ACCOUNT)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(_) => Err(STORE_ERROR.to_string()),
        }
    }

    fn write(&self, value: &[u8]) -> Result<(), String> {
        Self::entry(ACTIVE_ACCOUNT)?.set_secret(value)
            .map_err(|_| STORE_ERROR.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match Self::entry(ACTIVE_ACCOUNT)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err(STORE_ERROR.to_string()),
        }
    }

    fn probe(&self) -> Result<(), String> {
        // A read-only lookup cannot prove that a locked store accepts a new session.
        let user = format!("probe-{}-{}", std::process::id(), rand::random::<u64>());
        let entry = Self::entry(&user)?;
        let sample = rand::random::<u128>().to_le_bytes();
        entry.set_secret(&sample).map_err(|_| STORE_ERROR.to_string())?;
        let result = entry.get_secret().map_err(|_| STORE_ERROR.to_string());
        let cleanup = entry.delete_credential().map_err(|_| STORE_ERROR.to_string());
        if result?.as_slice() != sample { return Err(STORE_ERROR.to_string()); }
        cleanup
    }
}
