//! Persisted and derived workspace types.

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 2;
/// Maximum number of workspaces. Enforced by the backend, not by the UI.
pub const WORKSPACE_LIMIT: usize = 5;
pub const DEFAULT_WORKSPACE_NAME: &str = "Mi espacio";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceKind {
    Local,
    GoogleDrive,
}

impl WorkspaceKind {
    pub fn is_drive(self) -> bool {
        matches!(self, WorkspaceKind::GoogleDrive)
    }
}

/// Binding between a workspace and a verified Google account (F4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountBinding {
    /// Stable Google subject identifier (`sub`), never the email.
    pub sub: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub kind: WorkspaceKind,
    pub created_at: i64,
    #[serde(default)]
    pub account: Option<AccountBinding>,
    /// True when a Drive workspace was rebuilt from its marker: the account
    /// binding is temporarily unknown, so the workspace must stay read-only
    /// until the user reconnects on purpose.
    #[serde(default)]
    pub linkage_lost: bool,
}

impl Workspace {
    /// Directory relative to `~/Documents`; derived from the validated id so
    /// it can never point anywhere else. Includes the `lyra/` root because the
    /// frontend resolves it with `BaseDirectory.Document`.
    pub fn relative_dir(&self) -> String {
        format!("lyra/workspaces/{}", self.id)
    }

    pub fn write_policy(&self) -> WritePolicy {
        if self.linkage_lost || self.kind.is_drive() && self.account.is_none() {
            WritePolicy::ReadOnly
        } else {
            WritePolicy::Editable
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceRegistry {
    pub schema_version: u32,
    pub active_workspace_id: String,
    pub workspaces: Vec<Workspace>,
    pub next_seq: u32,
    #[serde(default)]
    pub migrated_at: Option<i64>,
    #[serde(default)]
    pub migration_id: Option<String>,
    #[serde(default)]
    pub epoch: u64,
}

impl WorkspaceRegistry {
    pub fn new(workspace: Workspace, migration_id: Option<String>, migrated_at: Option<i64>) -> Self {
        let next_seq = crate::workspaces::ids::parse_seq(&workspace.id)
            .map(|seq| seq.saturating_add(1))
            .unwrap_or(1);
        let active_workspace_id = workspace.id.clone();
        Self {
            schema_version: SCHEMA_VERSION,
            active_workspace_id,
            workspaces: vec![workspace],
            next_seq,
            migrated_at,
            migration_id,
            epoch: 1,
        }
    }

    pub fn active(&self) -> Option<&Workspace> {
        self.workspaces
            .iter()
            .find(|workspace| workspace.id == self.active_workspace_id)
    }

    pub fn is_valid(&self) -> bool {
        let mut subjects = std::collections::HashSet::new();
        self.schema_version == SCHEMA_VERSION
            && !self.workspaces.is_empty()
            && self.workspaces.len() <= WORKSPACE_LIMIT
            && self
                .workspaces
                .iter()
                .all(|workspace| {
                    crate::workspaces::ids::validate_id(&workspace.id).is_ok()
                        && match (&workspace.kind, &workspace.account) {
                            (WorkspaceKind::GoogleDrive, Some(account)) =>
                                !account.sub.trim().is_empty() && subjects.insert(account.sub.as_str()),
                            (WorkspaceKind::Local, Some(_)) => false,
                            (_, None) => true,
                        }
                })
            && self.active().is_some()
    }
}

/// Marker written inside every workspace. Reconstructible: it deliberately
/// does not store the account `sub` or the remote folder id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMarker {
    pub schema_version: u32,
    pub workspace_id: String,
    pub name: String,
    pub kind: WorkspaceKind,
    pub created_at: i64,
    pub origin: String,
}

/// Runtime status of a workspace directory. Never persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    Ready,
    Missing,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WritePolicy {
    Editable,
    ReadOnly,
}

/// DTO handed to the frontend. `directory` is relative to `~/Documents`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub kind: WorkspaceKind,
    pub status: WorkspaceStatus,
    pub write_policy: WritePolicy,
    pub linkage_lost: bool,
    pub directory: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(kind: WorkspaceKind, account: Option<AccountBinding>) -> Workspace {
        Workspace {
            id: "ws_001".to_string(),
            name: DEFAULT_WORKSPACE_NAME.to_string(),
            kind,
            created_at: 1,
            account,
            linkage_lost: false,
        }
    }

    #[test]
    fn local_workspaces_are_editable() {
        assert_eq!(workspace(WorkspaceKind::Local, None).write_policy(), WritePolicy::Editable);
    }

    #[test]
    fn rebuilt_drive_workspace_is_read_only() {
        let mut rebuilt = workspace(WorkspaceKind::GoogleDrive, None);
        assert_eq!(rebuilt.write_policy(), WritePolicy::ReadOnly);
        rebuilt.linkage_lost = true;
        assert_eq!(rebuilt.write_policy(), WritePolicy::ReadOnly);
        rebuilt.account = Some(AccountBinding { sub: "sub".into(), email: "a@b.c".into() });
        rebuilt.linkage_lost = false;
        assert_eq!(rebuilt.write_policy(), WritePolicy::Editable);
    }

    #[test]
    fn relative_dir_is_derived_from_the_id() {
        assert_eq!(workspace(WorkspaceKind::Local, None).relative_dir(), "lyra/workspaces/ws_001");
    }

    #[test]
    fn registry_rejects_invalid_identifiers() {
        let mut registry = WorkspaceRegistry::new(workspace(WorkspaceKind::Local, None), None, None);
        assert!(registry.is_valid());
        registry.workspaces[0].id = "../escape".to_string();
        assert!(!registry.is_valid());
    }

    #[test]
    fn registry_rejects_duplicate_google_subjects_and_local_bindings() {
        let mut first = workspace(WorkspaceKind::GoogleDrive, Some(AccountBinding {
            sub: "subject-a".into(), email: "one@example.test".into(),
        }));
        let mut second = first.clone();
        second.id = "ws_002".into();
        let mut registry = WorkspaceRegistry::new(first.clone(), None, None);
        registry.workspaces.push(second);
        assert!(!registry.is_valid());
        first.kind = WorkspaceKind::Local;
        registry.workspaces = vec![first];
        assert!(!registry.is_valid());
    }
}
