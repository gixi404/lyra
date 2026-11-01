use super::auth::TokenProvider;
use super::types::DriveFileMetadata;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileListResponse {
    #[serde(default)]
    pub files: Vec<DriveFileMetadata>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteFileStatus {
    Trashed,
    NotFound,
    Forbidden,
    Active(DriveFileMetadata),
}

#[derive(Clone)]
pub struct DriveClient {
    client: reqwest::Client,
    pub base_url: String,
    pub upload_url: String,
    token_provider: Option<Arc<dyn TokenProvider>>,
}

impl DriveClient {
    /// The caller persists this generated ID before sending a create request.
    pub async fn generate_file_id(&self, token: &str) -> Result<String, String> {
        let url = format!("{}/drive/v3/files/generateIds?count=1&space=drive&type=files", self.base_url);
        let response = self.execute_with_auth(token,
            |bearer| self.client.get(&url).bearer_auth(bearer).send()).await?;
        if !response.status().is_success() {
            return Err(format!("Cannot generate Drive file ID (HTTP {})", response.status()));
        }
        let body: serde_json::Value = response.json().await
            .map_err(|_| "Invalid generated Drive ID response")?;
        let ids = body.get("ids").and_then(serde_json::Value::as_array)
            .ok_or("Generated Drive ID response omitted ids")?;
        let id = match ids.as_slice() {
            [only] => only.as_str().ok_or("Generated Drive ID is not text")?,
            _ => return Err("Drive did not generate exactly one ID".into()),
        };
        if !super::workspace_sync::safe_remote_id(id) {
            return Err("Generated Drive ID is invalid".into());
        }
        Ok(id.to_string())
    }

    /// A 409 means the ID already exists; the caller must verify that object.
    pub async fn create_workspace_folder_with_id(
        &self, token: &str, workspace_id: &str, nonce: &str, id: &str,
    ) -> Result<Option<String>, String> {
        crate::workspaces::ids::validate_id(workspace_id)?;
        if !super::workspace_sync::safe_remote_id(id) || nonce.len() != 32 ||
            !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid workspace folder create identity".into());
        }
        let url = format!("{}/drive/v3/files?fields=id,mimeType,appProperties,parents,trashed", self.base_url);
        let body = json!({
            "id": id, "name": format!("Lyra {workspace_id}"),
            "mimeType": "application/vnd.google-apps.folder",
            "appProperties": {"lyra_workspace_nonce": nonce},
        });
        let response = self.execute_with_auth_idempotent(token, false,
            |bearer| self.client.post(&url).bearer_auth(bearer).json(&body).send()).await?;
        if response.status() == reqwest::StatusCode::CONFLICT { return Ok(None); }
        if !response.status().is_success() {
            return Err(format!("Cannot create workspace folder (HTTP {})", response.status()));
        }
        let created: serde_json::Value = response.json().await
            .map_err(|_| "Invalid created workspace folder")?;
        if created.get("id").and_then(serde_json::Value::as_str) != Some(id) ||
            created.get("mimeType").and_then(serde_json::Value::as_str) !=
                Some("application/vnd.google-apps.folder") ||
            created.get("appProperties").and_then(|props| props.get("lyra_workspace_nonce"))
                .and_then(serde_json::Value::as_str) != Some(nonce) {
            return Err("Created workspace folder identity was not confirmed".into());
        }
        Ok(Some(id.to_string()))
    }
    /// Convenience for tests. Production must checkpoint between the search
    /// and create calls because the workspace can change in that interval.
    #[cfg(test)]
    pub async fn get_or_create_workspace_folder(
        &self, token: &str, workspace_id: &str, nonce: &str,
    ) -> Result<String, String> {
        if let Some(id) = self.find_workspace_folder(token, nonce).await? { return Ok(id); }
        self.create_workspace_folder(token, workspace_id, nonce).await
    }

    /// Search only by a private nonce; no same-name legacy folder is adopted.
    #[allow(dead_code)] // F4 remote engine calls this through SyncPermit.
    pub async fn find_workspace_folder(&self, token: &str, nonce: &str) -> Result<Option<String>, String> {
        if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid workspace folder identity".into());
        }
        let query = format!("appProperties has {{ key='lyra_workspace_nonce' and value='{nonce}' }} and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
        let encoded = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
        let list_url = format!("{}/drive/v3/files?q={encoded}&spaces=drive&fields=nextPageToken,files(id,mimeType,appProperties)&pageSize=1000", self.base_url);
        let response = self.execute_with_auth(token, |bearer| self.client.get(&list_url).bearer_auth(bearer).send()).await?;
        if !response.status().is_success() {
            return Err(format!("Cannot find workspace folder (HTTP {})", response.status()));
        }
        let listing: serde_json::Value = response.json().await.map_err(|_| "Invalid workspace folder listing")?;
        if listing.get("nextPageToken").and_then(|value| value.as_str()).is_some_and(|value| !value.is_empty()) {
            return Err("Workspace folder search was incomplete".into());
        }
        let files = listing.get("files").and_then(|value| value.as_array())
            .ok_or("Workspace folder search omitted files")?;
        let mut matches = Vec::new();
        for file in files {
            if file.get("mimeType").and_then(|value| value.as_str()) != Some("application/vnd.google-apps.folder") ||
                file.get("appProperties").and_then(|value| value.get("lyra_workspace_nonce"))
                    .and_then(|value| value.as_str()) != Some(nonce) {
                return Err("Workspace folder search returned a foreign folder".into());
            }
            let id = file.get("id").and_then(|value| value.as_str()).filter(|id| !id.is_empty())
                .ok_or("Workspace folder search omitted an ID")?;
            matches.push(id);
        }
        match matches.as_slice() {
            [id] if !id.is_empty() => Ok(Some((*id).to_string())),
            [] => Ok(None),
            _ => Err("Multiple remote folders carry this workspace identity".into()),
        }
    }

    #[allow(dead_code)] // F4 remote engine calls this through SyncPermit.
    pub async fn create_workspace_folder(
        &self, token: &str, workspace_id: &str, nonce: &str,
    ) -> Result<String, String> {
        crate::workspaces::ids::validate_id(workspace_id)?;
        if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid workspace folder identity".into());
        }
        let create_url = format!("{}/drive/v3/files?fields=id,mimeType,appProperties", self.base_url);
        let body = json!({
            "name": format!("Lyra {workspace_id}"),
            "mimeType": "application/vnd.google-apps.folder",
            "appProperties": {"lyra_workspace_nonce": nonce},
        });
        let created = self.execute_with_auth_idempotent(token, false, |bearer| {
            self.client.post(&create_url).bearer_auth(bearer).json(&body).send()
        }).await?;
        if !created.status().is_success() {
            return Err(format!("Cannot create workspace folder (HTTP {})", created.status()));
        }
        let metadata: serde_json::Value = created.json().await.map_err(|_| "Invalid created workspace folder")?;
        if metadata.get("mimeType").and_then(|value| value.as_str()) != Some("application/vnd.google-apps.folder") ||
            metadata.get("appProperties").and_then(|value| value.get("lyra_workspace_nonce"))
                .and_then(|value| value.as_str()) != Some(nonce) {
            return Err("Created workspace folder identity was not confirmed".into());
        }
        metadata.get("id").and_then(|value| value.as_str()).filter(|id| !id.is_empty())
            .map(str::to_string).ok_or("Created workspace folder has no ID".into())
    }
    #[allow(dead_code)]
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|e| format!("Error creando cliente HTTP de Drive: {e}"))?;
        Ok(Self {
            client,
            base_url: "https://www.googleapis.com".to_string(),
            upload_url: "https://www.googleapis.com/upload/drive/v3".to_string(),
            token_provider: None,
        })
    }

    /// Cliente ligado a una cuenta y época concretas. Si la cuenta cambia a
    /// mitad de una operación, las peticiones fallan cerradas.
    pub fn new_with_app_for_account(
        app: &tauri::AppHandle,
        account_key: &str,
        epoch: u64,
    ) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|e| format!("Error creando cliente HTTP de Drive: {e}"))?;
        Ok(Self {
            client,
            base_url: "https://www.googleapis.com".to_string(),
            upload_url: "https://www.googleapis.com/upload/drive/v3".to_string(),
            token_provider: Some(Arc::new(super::auth::TauriTokenProvider::new_for_account(
                app.clone(),
                account_key.to_string(),
                epoch,
            ))),
        })
    }

    #[allow(dead_code)]
    pub fn new_with_provider(token_provider: Arc<dyn TokenProvider>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|e| format!("Error creando cliente HTTP de Drive: {e}"))?;
        Ok(Self {
            client,
            base_url: "https://www.googleapis.com".to_string(),
            upload_url: "https://www.googleapis.com/upload/drive/v3".to_string(),
            token_provider: Some(token_provider),
        })
    }

    #[cfg(test)]
    pub fn new_with_base_url(base_url: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("Error creando cliente HTTP de prueba: {e}"))?;
        Ok(Self {
            client,
            upload_url: format!("{base_url}/upload/drive/v3"),
            base_url,
            token_provider: None,
        })
    }

    #[cfg(test)]
    pub fn new_with_provider_and_base_url(
        token_provider: Arc<dyn TokenProvider>,
        base_url: String,
    ) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("Error creando cliente HTTP de prueba: {e}"))?;
        Ok(Self {
            client,
            upload_url: format!("{base_url}/upload/drive/v3"),
            base_url,
            token_provider: Some(token_provider),
        })
    }

    /// Ejecuta una petición HTTP con autorización Bearer:
    /// - Si la respuesta es HTTP 401 y hay un `token_provider` configurado, renueva el token
    ///   y reintenta la petición exactamente una sola vez.
    /// - Reintenta 429 y errores de servidor solo para solicitudes idempotentes.
    ///   con retroceso exponencial y jitter (respetando la cabecera Retry-After si existe).
    async fn execute_with_auth<F, Fut>(&self, token_override: &str, make_req: F) -> Result<reqwest::Response, String>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
    {
        self.execute_with_auth_idempotent(token_override, true, make_req).await
    }

    async fn execute_with_auth_idempotent<F, Fut>(
        &self,
        token_override: &str,
        is_idempotent: bool,
        make_req: F,
    ) -> Result<reqwest::Response, String>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
    {
        let mut current_token = if !token_override.trim().is_empty() {
            token_override.to_string()
        } else if let Some(ref provider) = self.token_provider {
            provider.get_token().await?
        } else {
            return Err("No se proveyó token de acceso ni proveedor de tokens.".to_string());
        };

        let mut token_refreshed = false;
        let max_transient_retries = 2;
        let mut attempt = 0;

        loop {
            let res = make_req(current_token.clone())
                .await
                .map_err(|e| format!("Error en petición HTTP: {e}"))?;

            if res.status() == reqwest::StatusCode::UNAUTHORIZED && !token_refreshed {
                if let Some(ref provider) = self.token_provider {
                    match provider.refresh_token(&current_token).await {
                        Ok(new_token) => {
                            token_refreshed = true;
                            current_token = new_token;
                            continue;
                        }
                        Err(e) => return Err(e.to_string()),
                    }
                }
            }

            let status = res.status();
            let is_rate_limit = status == reqwest::StatusCode::TOO_MANY_REQUESTS;
            let is_server_error = status == reqwest::StatusCode::INTERNAL_SERVER_ERROR
                || status == reqwest::StatusCode::BAD_GATEWAY
                || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
                || status == reqwest::StatusCode::GATEWAY_TIMEOUT;

            // A failed response does not prove that a POST was never applied.
            // The durable creation intent, not an automatic retry, resolves
            // its uncertain outcome.
            let should_retry = is_idempotent && (is_rate_limit || is_server_error);

            if should_retry && attempt < max_transient_retries {
                attempt += 1;
                let retry_after_secs = res
                    .headers()
                    .get("Retry-After")
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);

                let delay_ms = if retry_after_secs > 0 {
                    (retry_after_secs * 1000).min(5000)
                } else if cfg!(test) {
                    5
                } else {
                    let jitter: u64 = rand::random::<u64>() % 100;
                    (250 * (1 << attempt) + jitter).min(3000)
                };

                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                continue;
            }

            return Ok(res);
        }
    }

    #[cfg(test)]
    pub async fn get_or_create_lyra_folder(&self, token: &str) -> Result<String, String> {
        let query = "name = 'lyra' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
        let list_url = format!(
            "{}/drive/v3/files?q={}&spaces=drive&fields=files(id,name)",
            self.base_url,
            url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
        );

        let res = self
            .execute_with_auth(token, |tok| self.client.get(&list_url).bearer_auth(tok).send())
            .await?;

        if !res.status().is_success() {
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error en respuesta al buscar carpeta 'lyra': {err}"));
        }

        let list_data: FileListResponse = res
            .json()
            .await
            .map_err(|e| format!("Error al decodificar lista de carpetas: {e}"))?;

        if let Some(folder) = list_data.files.into_iter().next() {
            return Ok(folder.id);
        }

        // Crear carpeta 'lyra' en la raíz
        let create_body = json!({
            "name": "lyra",
            "mimeType": "application/vnd.google-apps.folder",
        });

        let create_url = format!("{}/drive/v3/files", self.base_url);
        let create_res = self
            .execute_with_auth_idempotent(token, false, |tok| {
                self.client.post(&create_url).bearer_auth(tok).json(&create_body).send()
            })
            .await?;

        if !create_res.status().is_success() {
            let status = create_res.status();
            let err = create_res.text().await.unwrap_or_default();
            return Err(format!("Google Drive rechazó la creación de la carpeta 'lyra' (HTTP {status}): {err}"));
        }

        let folder_meta: DriveFileMetadata = create_res
            .json()
            .await
            .map_err(|e| format!("Error decodificando metadatos de carpeta creada: {e}"))?;

        Ok(folder_meta.id)
    }

    pub async fn list_child_folders(
        &self, token: &str, parent_id: &str, folder_name: &str,
    ) -> Result<Vec<String>, String> {
        let query = format!("'{}' in parents and name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", parent_id, folder_name);
        let encoded = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
        let url = format!("{}/drive/v3/files?q={encoded}&spaces=drive&fields=nextPageToken,files(id,name)&pageSize=1000", self.base_url);
        let res = self.execute_with_auth(token, |tok| self.client.get(&url).bearer_auth(tok).send()).await?;
        if !res.status().is_success() {
            return Err(format!("Cannot list archive folders (HTTP {})", res.status()));
        }
        let data: FileListResponse = res.json().await.map_err(|e| format!("Invalid archive folder listing: {e}"))?;
        Ok(data.files.into_iter().filter(|f| f.name == folder_name && !f.id.is_empty()).map(|f| f.id).collect())
    }

    pub async fn create_child_folder(
        &self, token: &str, parent_id: &str, folder_name: &str,
    ) -> Result<String, String> {
        let url = format!("{}/drive/v3/files?fields=id,name", self.base_url);
        let body = json!({"name": folder_name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]});
        let res = self.execute_with_auth_idempotent(token, false, |tok| {
            self.client.post(&url).bearer_auth(tok).json(&body).send()
        }).await?;
        if !res.status().is_success() {
            return Err(format!("Cannot create archive folder (HTTP {})", res.status()));
        }
        let meta: DriveFileMetadata = res.json().await.map_err(|e| format!("Invalid archive folder response: {e}"))?;
        if meta.id.is_empty() { return Err("Archive folder response lacks an ID".to_string()) }
        Ok(meta.id)
    }

    pub async fn list_files_in_folder(
        &self,
        token: &str,
        folder_id: &str,
    ) -> Result<Vec<DriveFileMetadata>, String> {
        let mut all_files = Vec::new();
        let mut page_token: Option<String> = None;
        let mut seen_tokens = std::collections::HashSet::new();
        const MAX_PAGES: usize = 500;

        let query = format!("'{}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'", folder_id);
        let encoded_query = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();

        loop {
            let mut list_url = format!(
                "{}/drive/v3/files?q={}&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,trashed,appProperties,parents)",
                self.base_url, encoded_query
            );
            if let Some(ref pt) = page_token {
                let encoded_pt = url::form_urlencoded::byte_serialize(pt.as_bytes()).collect::<String>();
                list_url.push_str(&format!("&pageToken={encoded_pt}"));
            }

            let res = self
                .execute_with_auth(token, |tok| self.client.get(&list_url).bearer_auth(tok).send())
                .await?;

            if !res.status().is_success() {
                let status = res.status();
                let err = res.text().await.unwrap_or_default();
                return Err(format!("Error listando archivos de Google Drive (HTTP {status}): {err}"));
            }

            let list_data: FileListResponse = res
                .json()
                .await
                .map_err(|e| format!("Error parseando lista de archivos de Drive: {e}"))?;

            all_files.extend(list_data.files);

            match list_data.next_page_token {
                Some(next) if !next.trim().is_empty() => {
                    if seen_tokens.contains(&next) {
                        return Err(format!(
                            "Bucle infinito detectado en la paginación de Google Drive: token repetido '{next}'"
                        ));
                    }
                    if seen_tokens.len() >= MAX_PAGES {
                        return Err(format!(
                            "Límite máximo de páginas ({MAX_PAGES}) excedido durante la paginación de Google Drive"
                        ));
                    }
                    seen_tokens.insert(next.clone());
                    page_token = Some(next);
                }
                _ => break,
            }
        }

        Ok(all_files)
    }

    pub async fn upload_file(
        &self,
        token: &str,
        folder_id: &str,
        file_name: &str,
        content: &[u8],
        mtime_rfc3339: &str,
    ) -> Result<DriveFileMetadata, String> {
        self.upload_file_with_properties(token, folder_id, file_name, content, mtime_rfc3339,
            None, None, None).await?.ok_or("Unexpected conflict on non-idempotent upload".into())
    }

    pub async fn upload_workspace_file(
        &self,
        token: &str,
        folder_id: &str,
        file_name: &str,
        content: &[u8],
        mtime_rfc3339: &str,
        folder_nonce: &str,
        note_id: &str,
    ) -> Result<DriveFileMetadata, String> {
        if folder_nonce.len() != 32 || !folder_nonce.bytes().all(|c| c.is_ascii_hexdigit()) ||
            note_id.is_empty() || note_id.len() > 120 || !note_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            return Err("Invalid workspace note identity".into());
        }
        self.upload_file_with_properties(token, folder_id, file_name, content, mtime_rfc3339,
            Some((folder_nonce, note_id)), None, None).await?
            .ok_or("Unexpected conflict on non-idempotent workspace upload".into())
    }

    /// Returns `None` on 409. A caller must verify the existing ID before
    /// committing its local manifest; a matching status code alone is not proof.
    pub async fn upload_workspace_file_with_id(
        &self, token: &str, folder_id: &str, file_name: &str, content: &[u8],
        mtime_rfc3339: &str, folder_nonce: &str, note_id: &str,
        remote_id: &str, previous_id: Option<&str>,
    ) -> Result<Option<DriveFileMetadata>, String> {
        if !super::workspace_sync::safe_remote_id(folder_id) ||
            !super::workspace_sync::safe_remote_id(remote_id) ||
            previous_id.is_some_and(|id| !super::workspace_sync::safe_remote_id(id)) ||
            folder_nonce.len() != 32 || !folder_nonce.bytes().all(|c| c.is_ascii_hexdigit()) ||
            note_id.is_empty() || note_id.len() > 120 ||
            !note_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            return Err("Invalid immutable workspace upload identity".into());
        }
        self.upload_file_with_properties(token, folder_id, file_name, content, mtime_rfc3339,
            Some((folder_nonce, note_id)), Some(remote_id), previous_id).await
    }

    async fn upload_file_with_properties(
        &self,
        token: &str,
        folder_id: &str,
        file_name: &str,
        content: &[u8],
        mtime_rfc3339: &str,
        properties: Option<(&str, &str)>,
        remote_id: Option<&str>,
        previous_id: Option<&str>,
    ) -> Result<Option<DriveFileMetadata>, String> {
        let boundary = format!("lyra-{:032x}", rand::random::<u128>());
        let mut metadata = json!({
            "name": file_name,
            "parents": [folder_id],
            "modifiedTime": mtime_rfc3339,
        });
        if let Some((nonce, note_id)) = properties {
            metadata["appProperties"] = json!({
                "lyra_workspace_nonce": nonce,
                "lyra_note_id": note_id,
            });
        }
        if let Some(id) = remote_id { metadata["id"] = json!(id); }
        if let Some(id) = previous_id { metadata["appProperties"]["lyra_previous_id"] = json!(id); }

        let mime = if file_name.ends_with(".md") {
            "text/markdown; charset=utf-8"
        } else {
            "text/plain; charset=utf-8"
        };

        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes());
        body.extend_from_slice(metadata.to_string().as_bytes());
        body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let upload_url = format!(
            "{}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,md5Checksum,trashed,appProperties,parents",
            self.upload_url
        );
        let content_type = format!("multipart/related; boundary={boundary}");

        let res = self
            .execute_with_auth_idempotent(token, false, |tok| {
                self.client
                    .post(&upload_url)
                    .bearer_auth(tok)
                    .header("Content-Type", &content_type)
                    .body(body.clone())
                    .send()
            })
            .await?;

        if remote_id.is_some() && res.status() == reqwest::StatusCode::CONFLICT { return Ok(None); }
        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error al subir '{file_name}' a Drive (HTTP {status}): {err}"));
        }

        let meta: DriveFileMetadata = res
            .json()
            .await
            .map_err(|e| format!("Error decodificando metadatos de subida para '{file_name}': {e}"))?;

        Ok(Some(meta))
    }

    pub async fn update_file(
        &self,
        token: &str,
        file_id: &str,
        file_name: &str,
        content: &[u8],
        mtime_rfc3339: &str,
    ) -> Result<DriveFileMetadata, String> {
        let boundary = format!("lyra-{:032x}", rand::random::<u128>());
        let metadata = json!({
            "name": file_name,
            "modifiedTime": mtime_rfc3339,
        });

        let mime = if file_name.ends_with(".md") {
            "text/markdown; charset=utf-8"
        } else {
            "text/plain; charset=utf-8"
        };

        let mut body = Vec::new();
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes());
        body.extend_from_slice(metadata.to_string().as_bytes());
        body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(content);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let update_url = format!(
            "{}/files/{file_id}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,md5Checksum,trashed,appProperties",
            self.upload_url
        );
        let content_type = format!("multipart/related; boundary={boundary}");

        let res = self
            .execute_with_auth(token, |tok| {
                self.client
                    .patch(&update_url)
                    .bearer_auth(tok)
                    .header("Content-Type", &content_type)
                    .body(body.clone())
                    .send()
            })
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error en respuesta al actualizar '{file_name}' en Drive (HTTP {status}): {err}"));
        }

        let meta: DriveFileMetadata = res
            .json()
            .await
            .map_err(|e| format!("Error decodificando metadatos tras actualizar '{file_name}': {e}"))?;

        Ok(meta)
    }

    pub async fn download_file(&self, token: &str, file_id: &str) -> Result<Vec<u8>, String> {
        let download_url = format!("{}/drive/v3/files/{file_id}?alt=media", self.base_url);

        let res = self
            .execute_with_auth(token, |tok| self.client.get(&download_url).bearer_auth(tok).send())
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error descargando archivo desde Drive (HTTP {status}): {err}"));
        }

        let bytes = res
            .bytes()
            .await
            .map_err(|e| format!("Error leyendo bytes de descarga: {e}"))?;

        Ok(bytes.to_vec())
    }

    pub async fn trash_file(&self, token: &str, file_id: &str) -> Result<(), String> {
        let trash_url = format!("{}/drive/v3/files/{file_id}", self.base_url);
        let body = json!({ "trashed": true });

        let res = self
            .execute_with_auth(token, |tok| {
                self.client.patch(&trash_url).bearer_auth(tok).json(&body).send()
            })
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error al enviar archivo a papelera de Drive (HTTP {status}): {err}"));
        }

        Ok(())
    }

    pub async fn untrash_file(&self, token: &str, file_id: &str) -> Result<(), String> {
        let clean_id = file_id.trim();
        if clean_id.is_empty() {
            return Err("El identificador del archivo remoto está vacío".to_string());
        }
        let untrash_url = format!("{}/drive/v3/files/{clean_id}", self.base_url);
        let body = json!({ "trashed": false });

        let res = self
            .execute_with_auth(token, |tok| {
                self.client.patch(&untrash_url).bearer_auth(tok).json(&body).send()
            })
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error al restaurar archivo de papelera de Drive (HTTP {status}): {err}"));
        }

        Ok(())
    }

    pub async fn rename_file(
        &self,
        token: &str,
        file_id: &str,
        new_name: &str,
    ) -> Result<DriveFileMetadata, String> {
        let clean_id = file_id.trim();
        if clean_id.is_empty() {
            return Err("El identificador del archivo remoto en Drive está vacío".to_string());
        }
        let rename_url = format!(
            "{}/drive/v3/files/{clean_id}?fields=id,name,mimeType,modifiedTime,md5Checksum,trashed,appProperties,parents",
            self.base_url
        );
        let body = json!({ "name": new_name });

        let res = self
            .execute_with_auth(token, |tok| {
                self.client.patch(&rename_url).bearer_auth(tok).json(&body).send()
            })
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error al renombrar archivo en Drive (HTTP {status}): {err}"));
        }

        let meta: DriveFileMetadata = res
            .json()
            .await
            .map_err(|e| format!("Error decodificando metadatos tras renombrar '{clean_id}': {e}"))?;

        Ok(meta)
    }

    pub async fn check_file_status(
        &self,
        token: &str,
        file_id: &str,
    ) -> Result<RemoteFileStatus, String> {
        let clean_id = file_id.trim();
        if clean_id.is_empty() {
            return Err("El identificador del archivo remoto en Drive está vacío".to_string());
        }

        let url = format!(
            "{}/drive/v3/files/{clean_id}?fields=id,name,mimeType,modifiedTime,md5Checksum,trashed,appProperties,parents",
            self.base_url
        );

        let res = self
            .execute_with_auth(token, |tok| self.client.get(&url).bearer_auth(tok).send())
            .await?;

        if res.status() == reqwest::StatusCode::NOT_FOUND || res.status() == reqwest::StatusCode::GONE {
            return Ok(RemoteFileStatus::NotFound);
        }

        if res.status() == reqwest::StatusCode::FORBIDDEN {
            return Ok(RemoteFileStatus::Forbidden);
        }

        if !res.status().is_success() {
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Error en respuesta al consultar archivo '{clean_id}' en Drive: {err}"));
        }

        let meta: DriveFileMetadata = res
            .json()
            .await
            .map_err(|e| format!("Error parseando metadatos de '{clean_id}': {e}"))?;

        if meta.trashed.unwrap_or(false) {
            Ok(RemoteFileStatus::Trashed)
        } else {
            Ok(RemoteFileStatus::Active(meta))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn workspace_folder_search_ignores_legacy_names_and_creates_its_own_marker() {
        let (base_url, handle) = spawn_mock_server(|server| {
            let request = server.recv().unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Get);
            let query = url::Url::parse(&format!("http://localhost{}", request.url())).unwrap();
            let filter = query.query_pairs().find(|(key, _)| key == "q").unwrap().1;
            assert!(filter.contains("appProperties has"));
            assert!(filter.contains(NONCE));
            request.respond(tiny_http::Response::from_string(r#"{"files":[]}"#)).unwrap();

            let mut request = server.recv().unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Post);
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let body: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["appProperties"]["lyra_workspace_nonce"], NONCE);
            assert_eq!(body["name"], "Lyra ws_002");
            request.respond(tiny_http::Response::from_string(format!(
                r#"{{"id":"new-folder","mimeType":"application/vnd.google-apps.folder","appProperties":{{"lyra_workspace_nonce":"{NONCE}"}}}}"#
            ))).unwrap();
        });
        let client = DriveClient::new_with_base_url(base_url).unwrap();
        assert_eq!(client.get_or_create_workspace_folder("fake", "ws_002", NONCE).await.unwrap(), "new-folder");
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn duplicate_workspace_folder_identity_fails_closed() {
        let (base_url, handle) = spawn_mock_server(|server| {
            let request = server.recv().unwrap();
            request.respond(tiny_http::Response::from_string(format!(
                r#"{{"files":[{{"id":"one","mimeType":"application/vnd.google-apps.folder","appProperties":{{"lyra_workspace_nonce":"{NONCE}"}}}},{{"id":"two","mimeType":"application/vnd.google-apps.folder","appProperties":{{"lyra_workspace_nonce":"{NONCE}"}}}}]}}"#
            ))).unwrap();
        });
        let client = DriveClient::new_with_base_url(base_url).unwrap();
        assert!(client.get_or_create_workspace_folder("fake", "ws_002", NONCE).await
            .unwrap_err().contains("Multiple remote folders"));
        handle.join().unwrap();
    }

    fn spawn_mock_server<F>(handler: F) -> (String, std::thread::JoinHandle<()>)
    where
        F: FnOnce(tiny_http::Server) + Send + 'static,
    {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server
            .server_addr()
            .to_ip()
            .unwrap()
            .port();
        let base_url = format!("http://127.0.0.1:{port}");
        let handle = std::thread::spawn(move || {
            handler(server);
        });
        (base_url, handle)
    }

    #[test]
    fn test_file_list_response_with_pagination() {
        let json_raw = r#"{
            "nextPageToken": "token_page_2_xyz",
            "files": [
                {
                    "id": "file_1_id",
                    "name": "nota1.md",
                    "mimeType": "text/markdown",
                    "modifiedTime": "2026-10-27T10:00:00.000Z",
                    "md5Checksum": "c4ca4238a0b923820dcc509a6f75849b",
                    "trashed": false
                }
            ]
        }"#;

        let parsed: Result<FileListResponse, _> = serde_json::from_str(json_raw);
        assert!(parsed.is_ok());
        let response = parsed.unwrap();
        assert_eq!(response.next_page_token.as_deref(), Some("token_page_2_xyz"));
        assert_eq!(response.files.len(), 1);
        let f = &response.files[0];
        assert_eq!(f.id, "file_1_id");
        assert_eq!(f.name, "nota1.md");
        assert_eq!(f.mime_type.as_deref(), Some("text/markdown"));
        assert_eq!(f.modified_time.as_deref(), Some("2026-10-27T10:00:00.000Z"));
        assert_eq!(f.md5_checksum.as_deref(), Some("c4ca4238a0b923820dcc509a6f75849b"));
        assert_eq!(f.trashed, Some(false));
    }

    #[test]
    fn test_file_list_response_final_page_no_token() {
        let json_raw = r#"{
            "files": [
                {
                    "id": "file_last_id",
                    "name": "nota_final.txt",
                    "mimeType": "text/plain"
                }
            ]
        }"#;

        let parsed: Result<FileListResponse, _> = serde_json::from_str(json_raw);
        assert!(parsed.is_ok());
        let response = parsed.unwrap();
        assert_eq!(response.next_page_token, None);
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].name, "nota_final.txt");
    }

    #[tokio::test]
    async fn test_mock_pagination_multiple_pages() {
        let (base_url, handle) = spawn_mock_server(|server| {
            // Petición 1: devuelve página 1 con nextPageToken="token_p2"
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(!url.contains("pageToken"));
                let body = r#"{"nextPageToken":"token_p2","files":[{"id":"1","name":"file1.txt"}]}"#;
                let response = tiny_http::Response::from_string(body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
            // Petición 2: devuelve página 2 final sin nextPageToken
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.contains("pageToken=token_p2"));
                let body = r#"{"files":[{"id":"2","name":"file2.txt"}]}"#;
                let response = tiny_http::Response::from_string(body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let files = client.list_files_in_folder("dummy_token", "folder_123").await.unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "file1.txt");
        assert_eq!(files[1].name, "file2.txt");

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_pagination_intermediate_error() {
        let (base_url, handle) = spawn_mock_server(|server| {
            // Petición 1: éxito con token
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"nextPageToken":"token_err","files":[{"id":"1","name":"file1.txt"}]}"#;
                let response = tiny_http::Response::from_string(body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
            // Petición 2: error HTTP 500 (responde también a reintentos transitorios)
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(500)) {
                let response = tiny_http::Response::from_string("Google Drive Internal Error")
                    .with_status_code(500);
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let result = client.list_files_in_folder("dummy_token", "folder_123").await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Error listando archivos de Google Drive"));

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_pagination_infinite_loop_prevention() {
        let (base_url, handle) = spawn_mock_server(|server| {
            // Petición 1: devuelve token "stuck_token"
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"nextPageToken":"stuck_token","files":[{"id":"1","name":"file1.txt"}]}"#;
                let response = tiny_http::Response::from_string(body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
            // Petición 2: el servidor vuelve a devolver el mismo "stuck_token"
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"nextPageToken":"stuck_token","files":[{"id":"2","name":"file2.txt"}]}"#;
                let response = tiny_http::Response::from_string(body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let result = client.list_files_in_folder("dummy_token", "folder_123").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Bucle infinito detectado"));

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_check_file_status_trashed() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let body = r#"{"id":"f_trashed","name":"borrado.md","trashed":true}"#;
                let response = tiny_http::Response::from_string(body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let status = client.check_file_status("dummy_token", "f_trashed").await.unwrap();
        assert_eq!(status, RemoteFileStatus::Trashed);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_check_file_status_not_found_404() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let response = tiny_http::Response::from_string("File not found").with_status_code(404);
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let status = client.check_file_status("dummy_token", "f_nonexistent").await.unwrap();
        assert_eq!(status, RemoteFileStatus::NotFound);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_check_file_status_gone_410() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let response = tiny_http::Response::from_string("Resource permanently gone").with_status_code(410);
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let status = client.check_file_status("dummy_token", "f_gone").await.unwrap();
        assert_eq!(status, RemoteFileStatus::NotFound);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_check_file_status_500_is_error_not_deletion() {
        let (base_url, handle) = spawn_mock_server(|server| {
            while let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(500)) {
                let response = tiny_http::Response::from_string("Server Error 500").with_status_code(500);
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let result = client.check_file_status("dummy_token", "f_err").await;
        // ¡REGLA CRÍTICA!: Debe ser Err, NUNCA Ok(NotFound) ni Ok(Trashed)
        assert!(result.is_err());
        let err_text = result.unwrap_err();
        assert!(err_text.contains("Error en respuesta al consultar archivo"));

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_check_file_status_empty_id_rejected() {
        let client = DriveClient::new_with_base_url("http://127.0.0.1:9999".to_string()).unwrap();
        let result = client.check_file_status("dummy_token", "   ").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("está vacío"));
    }

    // ==========================================
    // PRUEBAS DE REGRESIÓN GD-006 (HTTP 401 & REFRESH)
    // ==========================================

    use super::super::auth::TokenRefreshError;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    struct MockTokenProvider {
        current_token: Arc<tokio::sync::Mutex<String>>,
        refresh_calls: Arc<AtomicUsize>,
        error_to_return: Option<TokenRefreshError>,
    }

    impl TokenProvider for MockTokenProvider {
        fn get_token(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>> {
            let tok_arc = self.current_token.clone();
            Box::pin(async move {
                let tok = tok_arc.lock().await;
                Ok(tok.clone())
            })
        }

        fn refresh_token(&self, failed_token: &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, TokenRefreshError>> + Send + '_>> {
            let calls = self.refresh_calls.clone();
            let tok_arc = self.current_token.clone();
            let err_opt = self.error_to_return.clone();
            let failed = failed_token.to_string();
            Box::pin(async move {
                let mut tok = tok_arc.lock().await;
                // Doble comprobación: si otro hilo ya renovó el token, retornar de inmediato
                if *tok != failed {
                    return Ok(tok.clone());
                }
                calls.fetch_add(1, Ordering::SeqCst);
                if let Some(err) = err_opt {
                    return Err(err);
                }
                *tok = "valid_renewed_token".to_string();
                Ok("valid_renewed_token".to_string())
            })
        }
    }

    #[tokio::test]
    async fn test_mock_401_retry_succeeds_with_renewed_token() {
        let (base_url, handle) = spawn_mock_server(|server| {
            // Intento 1: token viejo -> devuelve 401
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let auth_header = req
                    .headers()
                    .iter()
                    .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_default();
                assert_eq!(auth_header, "Bearer initial_expired_token");
                let response = tiny_http::Response::from_string(r#"{"error":{"code":401,"message":"Invalid Credentials"}}"#)
                    .with_status_code(401);
                let _ = req.respond(response);
            }
            // Intento 2: token renovado -> devuelve 200 OK
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let auth_header = req
                    .headers()
                    .iter()
                    .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_default();
                assert_eq!(auth_header, "Bearer valid_renewed_token");
                let response = tiny_http::Response::from_string("Contenido descargado con éxito");
                let _ = req.respond(response);
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("initial_expired_token".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: None,
        });

        let client = DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap();
        // Al pasar "" utiliza el token del provider
        let bytes = client.download_file("", "file_test_401").await.unwrap();
        assert_eq!(bytes, b"Contenido descargado con \xc3\xa9xito");
        // Debe haberse renovado exactamente una sola vez
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 1);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_401_second_attempt_also_401_fails_without_infinite_loop() {
        let (base_url, handle) = spawn_mock_server(|server| {
            // Intento 1: 401
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(tiny_http::Response::from_string("Unauthorized 1").with_status_code(401));
            }
            // Intento 2 (reintento con token renovado): también 401
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(tiny_http::Response::from_string("Unauthorized 2").with_status_code(401));
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("initial_token".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: None,
        });

        let client = DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap();
        let result = client.download_file("", "file_persistent_401").await;
        // Debe fallar con error
        assert!(result.is_err());
        // Se debe haber reintentado solo 1 vez (1 llamada de refresh)
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 1);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_401_refresh_network_error_propagates() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(tiny_http::Response::from_string("Unauthorized").with_status_code(401));
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("tok".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: Some(TokenRefreshError::Network("DNS lookup failed".to_string())),
        });

        let client = DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap();
        let result = client.download_file("", "file_net_err").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("DNS lookup failed"));
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 1);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_401_refresh_invalid_grant_propagates() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(tiny_http::Response::from_string("Unauthorized").with_status_code(401));
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("tok".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: Some(TokenRefreshError::InvalidGrant("Token revoked by user".to_string())),
        });

        let client = DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap();
        let result = client.download_file("", "file_invalid_grant").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid_grant"));
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 1);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_non_401_error_is_not_retried() {
        let (base_url, handle) = spawn_mock_server(|server| {
            // Servidor devuelve 500
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                let _ = req.respond(tiny_http::Response::from_string("Internal Google Error").with_status_code(500));
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("tok".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: None,
        });

        let client = DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap();
        let result = client.download_file("", "file_500").await;
        assert!(result.is_err());
        // NO debe haber llamado a refresh para un error 500
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 0);

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_concurrent_401_shared_refresh_and_subsequent_token_reuse() {
        use std::sync::atomic::AtomicUsize;

        let expired_reqs = Arc::new(AtomicUsize::new(0));
        let renewed_reqs = Arc::new(AtomicUsize::new(0));

        let exp_clone = expired_reqs.clone();
        let ren_clone = renewed_reqs.clone();

        let (base_url, handle) = spawn_mock_server(move |server| {
            // Manejamos un total de 5 peticiones:
            // 2 iniciales que recibirán 401
            // 2 reintentos con token renovado -> 200 OK
            // 1 subsiguiente con token renovado -> 200 OK
            for _ in 0..5 {
                if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                    let auth_header = req
                        .headers()
                        .iter()
                        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("authorization"))
                        .map(|h| h.value.as_str().to_string())
                        .unwrap_or_default();

                    if auth_header == "Bearer initial_expired_token" {
                        exp_clone.fetch_add(1, Ordering::SeqCst);
                        let response = tiny_http::Response::from_string(r#"{"error":{"code":401}}"#)
                            .with_status_code(401);
                        let _ = req.respond(response);
                    } else if auth_header == "Bearer valid_renewed_token" {
                        ren_clone.fetch_add(1, Ordering::SeqCst);
                        let response = tiny_http::Response::from_string("OK Content");
                        let _ = req.respond(response);
                    } else {
                        let response = tiny_http::Response::from_string("Bad Token").with_status_code(403);
                        let _ = req.respond(response);
                    }
                }
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("initial_expired_token".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: None,
        });

        let client = Arc::new(DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap());

        // 1. Dos peticiones concurrentes que fallan simultáneamente con 401
        let c1 = client.clone();
        let c2 = client.clone();

        let (res1, res2) = tokio::join!(
            tokio::spawn(async move { c1.download_file("", "file_A").await }),
            tokio::spawn(async move { c2.download_file("", "file_B").await })
        );

        let data1 = res1.unwrap().expect("Petición concurrente 1 debe recuperarse tras renovación");
        let data2 = res2.unwrap().expect("Petición concurrente 2 debe recuperarse tras renovación");

        assert_eq!(data1, b"OK Content");
        assert_eq!(data2, b"OK Content");

        // Regla GD-006: A pesar de que dos peticiones recibieron 401 simultáneamente,
        // la renovación compartida debe haberse ejecutado EXACTAMENTE una sola vez
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 1);

        // 2. Petición subsiguiente: debe reutilizar directamente el token renovado sin 401 ni nuevo refresh
        let res3 = client.download_file("", "file_C").await;
        let data3 = res3.expect("Petición subsiguiente debe reutilizar token renovado");
        assert_eq!(data3, b"OK Content");

        // El número de renovaciones debe permanecer en 1
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 1);

        // Verificamos los contadores del servidor HTTP
        assert_eq!(expired_reqs.load(Ordering::SeqCst), 2, "Hubo exactamente 2 llamadas con token expirado");
        assert_eq!(renewed_reqs.load(Ordering::SeqCst), 3, "Hubo exactamente 3 llamadas con token renovado");

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_upload_file_endpoint_and_body() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(mut req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.starts_with("/upload/drive/v3/files"), "URL debe contener prefijo /upload/drive/v3/files: {url}");
                assert!(url.contains("uploadType=multipart"));
                assert_eq!(req.method().as_str(), "POST");

                let content_type = req
                    .headers()
                    .iter()
                    .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("content-type"))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_default();
                assert!(content_type.starts_with("multipart/related; boundary="));

                let mut body = Vec::new();
                req.as_reader().read_to_end(&mut body).unwrap();
                let body_str = String::from_utf8_lossy(&body);
                assert!(body_str.contains("nueva_nota.txt"));
                assert!(body_str.contains("parent_folder_123"));
                assert!(body_str.contains("Contenido de prueba nuevo"));

                let response_body = r#"{
                    "id": "new_drive_id_123",
                    "name": "nueva_nota.txt",
                    "mimeType": "text/plain; charset=utf-8",
                    "modifiedTime": "2026-10-28T12:00:00.000Z",
                    "md5Checksum": "abc123md5",
                    "trashed": false
                }"#;
                let response = tiny_http::Response::from_string(response_body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let meta = client
            .upload_file(
                "token_123",
                "parent_folder_123",
                "nueva_nota.txt",
                b"Contenido de prueba nuevo",
                "2026-10-28T12:00:00Z",
            )
            .await
            .expect("upload_file debe completarse exitosamente");

        assert_eq!(meta.id, "new_drive_id_123");
        assert_eq!(meta.name, "nueva_nota.txt");
        assert_eq!(meta.md5_checksum.as_deref(), Some("abc123md5"));

        let _ = handle.join();
    }

    #[tokio::test]
    async fn non_idempotent_upload_does_not_retry_an_uncertain_429() {
        let (base_url, handle) = spawn_mock_server(|server| {
            let request = server.recv().unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Post);
            request.respond(tiny_http::Response::from_string("quota")
                .with_status_code(429)).unwrap();
            // Closing the server makes an accidental second POST observable as
            // a network error, but the first 429 must be returned directly.
        });
        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let error = client.upload_file("fake", "folder", "Note.md", b"content",
            "2026-10-28T12:00:00Z").await.unwrap_err();
        assert!(error.contains("429"), "{error}");
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn test_mock_update_file_endpoint_and_body() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(mut req)) = server.recv_timeout(Duration::from_secs(5)) {
                let url = req.url().to_string();
                assert!(url.starts_with("/upload/drive/v3/files/existing_id_999"), "URL debe contener /upload/drive/v3/files/existing_id_999: {url}");
                assert!(url.contains("uploadType=multipart"));
                assert_eq!(req.method().as_str(), "PATCH");

                let mut body = Vec::new();
                req.as_reader().read_to_end(&mut body).unwrap();
                let body_str = String::from_utf8_lossy(&body);
                assert!(body_str.contains("nota_editada.md"));
                assert!(body_str.contains("Contenido editado"));

                let response_body = r#"{
                    "id": "existing_id_999",
                    "name": "nota_editada.md",
                    "mimeType": "text/markdown; charset=utf-8",
                    "modifiedTime": "2026-10-28T13:00:00.000Z",
                    "md5Checksum": "def456md5",
                    "trashed": false
                }"#;
                let response = tiny_http::Response::from_string(response_body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let meta = client
            .update_file(
                "token_123",
                "existing_id_999",
                "nota_editada.md",
                b"Contenido editado",
                "2026-10-28T13:00:00Z",
            )
            .await
            .expect("update_file debe completarse exitosamente");

        assert_eq!(meta.id, "existing_id_999");
        assert_eq!(meta.name, "nota_editada.md");
        assert_eq!(meta.md5_checksum.as_deref(), Some("def456md5"));

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_503_retry_succeeds_on_second_attempt() {
        use std::sync::atomic::AtomicUsize;

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = attempts.clone();

        let (base_url, handle) = spawn_mock_server(move |server| {
            for _ in 0..2 {
                if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                    let count = attempts_clone.fetch_add(1, Ordering::SeqCst);
                    if count == 0 {
                        // Primer intento: error temporal 503 con Retry-After: 0
                        let response = tiny_http::Response::from_string("Service Unavailable")
                            .with_status_code(503)
                            .with_header(tiny_http::Header::from_bytes(&b"Retry-After"[..], &b"0"[..]).unwrap());
                        let _ = req.respond(response);
                    } else {
                        // Segundo intento: 200 OK
                        let response = tiny_http::Response::from_string("Exito tras reintento");
                        let _ = req.respond(response);
                    }
                }
            }
        });

        let provider = Arc::new(MockTokenProvider {
            current_token: Arc::new(tokio::sync::Mutex::new("tok".to_string())),
            refresh_calls: Arc::new(AtomicUsize::new(0)),
            error_to_return: None,
        });

        let client = DriveClient::new_with_provider_and_base_url(provider.clone(), base_url).unwrap();
        let result = client.download_file("", "file_503_retry").await;
        assert!(result.is_ok(), "Debe recuperarse exitosamente en el segundo intento");
        assert_eq!(result.unwrap(), b"Exito tras reintento");
        assert_eq!(attempts.load(Ordering::SeqCst), 2, "Debe haber realizado exactamente 2 intentos");
        assert_eq!(provider.refresh_calls.load(Ordering::SeqCst), 0, "No debe renovar token para errores 503");

        let _ = handle.join();
    }

    #[tokio::test]
    async fn test_mock_rename_file_endpoint_and_body() {
        let (base_url, handle) = spawn_mock_server(|server| {
            if let Ok(Some(req)) = server.recv_timeout(Duration::from_secs(5)) {
                assert_eq!(req.method().as_str(), "PATCH");
                assert!(req.url().contains("/drive/v3/files/file_to_rename"));
                let response_body = r#"{
                    "id": "file_to_rename",
                    "name": "nuevo_nombre.txt",
                    "trashed": false
                }"#;
                let response = tiny_http::Response::from_string(response_body)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = req.respond(response);
            }
        });

        let client = DriveClient::new_with_base_url(base_url).unwrap();
        let meta = client
            .rename_file("token_123", "file_to_rename", "nuevo_nombre.txt")
            .await
            .expect("rename_file debe completarse exitosamente");

        assert_eq!(meta.id, "file_to_rename");
        assert_eq!(meta.name, "nuevo_nombre.txt");

        let _ = handle.join();
    }
}
