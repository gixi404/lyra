use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub token_type: String,
}

impl std::fmt::Debug for OAuthTokens {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("OAuthTokens")
            .field("access_token", &"[redacted]")
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "[redacted]"))
            .field("expires_at", &self.expires_at)
            .field("token_type", &self.token_type)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserProfile {
    #[serde(default)]
    pub sub: Option<String>,
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredAuthState {
    pub tokens: OAuthTokens,
    pub user: UserProfile,
    #[serde(default = "default_auto_sync")]
    pub auto_sync_enabled: bool,
}

fn default_auto_sync() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatus {
    pub is_connected: bool,
    pub is_syncing: bool,
    pub user_email: Option<String>,
    pub user_name: Option<String>,
    pub user_photo: Option<String>,
    pub last_sync_timestamp: Option<i64>,
    pub last_error: Option<String>,
    pub auto_sync_enabled: bool,
    #[serde(default)]
    pub backend_version: Option<String>,
    #[serde(default)]
    pub backend_build_timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingDeletion {
    #[serde(default)]
    pub drive_id: Option<String>,
    pub deleted_at: i64,
    #[serde(default)]
    pub account_key: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileManifestItem {
    pub drive_id: String,
    pub md5: String,
    pub local_mtime: i64,
    pub remote_mtime: String,
    #[serde(default)]
    pub local_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
    pub version: u32,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub account_email: Option<String>,
    pub drive_folder_id: String,
    pub last_sync_timestamp: i64,
    pub files: HashMap<String, FileManifestItem>,
    #[serde(default)]
    pub pending_deletions: HashMap<String, PendingDeletion>,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl Default for SyncManifest {
    fn default() -> Self {
        Self {
            version: 1,
            account_id: None,
            account_email: None,
            drive_folder_id: String::new(),
            last_sync_timestamp: 0,
            files: HashMap::new(),
            pending_deletions: HashMap::new(),
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncResult {
    #[serde(default)]
    pub sync_id: String,
    pub uploaded: Vec<String>,
    pub downloaded: Vec<String>,
    pub conflicts: Vec<String>,
    pub deleted_remote: Vec<String>,
    pub errors: Vec<String>,
    /// `true` si quedaron notas locales esperando consentimiento explícito
    /// para la cuenta activa (AUD-001).
    #[serde(default)]
    pub pending_authorization: bool,
    /// Notas cuya subida se bloqueó por falta de autorización en este ciclo.
    #[serde(default)]
    pub blocked_uploads: Vec<String>,
    #[serde(default)]
    pub archive_conflicts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileMetadata {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub md5_checksum: Option<String>,
    #[serde(default)]
    pub trashed: Option<bool>,
    #[serde(default)]
    pub app_properties: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub parents: Vec<String>,
}
