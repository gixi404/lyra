//! Respaldo persistente de borradores en `~/Documents/lyra/.drafts/` (M9).
//!
//! Un fichero por nota: `<draftId>.json` con el payload completo (draft + estado).
//! El `draftId` es un hash estable de la ruta relativa (homónimos en
//! subdirectorios no colisionan). No es una nota: vive en un directorio oculto
//! excluido del listado de notas.

use std::path::{Path, PathBuf};

pub const DRAFTS_DIR_NAME: &str = ".drafts";
pub const MAX_DRAFT_JSON_BYTES: usize = 32 * 1024 * 1024;

pub fn is_valid_draft_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn drafts_dir(lyra_dir: &Path) -> PathBuf {
    lyra_dir.join(DRAFTS_DIR_NAME)
}

pub fn ensure_drafts_dir(lyra_dir: &Path) -> Result<PathBuf, String> {
    crate::gdrive::sync::ensure_safe_base_dir(lyra_dir)?;
    let dir = drafts_dir(lyra_dir);
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "El directorio de borradores '{}' es un enlace simbólico no permitido",
                    dir.display()
                ));
            }
            if !meta.file_type().is_dir() {
                return Err(format!(
                    "La ruta de borradores '{}' no es un directorio válido",
                    dir.display()
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&dir)
                .map_err(|e| format!("No se pudo crear el directorio de borradores: {e}"))?;
            // Confirmar que no fuimos suplantados por un symlink entre create y check.
            let meta = std::fs::symlink_metadata(&dir)
                .map_err(|e| format!("No se pudo auditar el directorio de borradores: {e}"))?;
            if meta.file_type().is_symlink() || !meta.file_type().is_dir() {
                return Err(format!(
                    "El directorio de borradores '{}' es inseguro",
                    dir.display()
                ));
            }
        }
        Err(e) => {
            return Err(format!("No se pudo acceder al directorio de borradores: {e}"));
        }
    }
    Ok(dir)
}

pub fn draft_path(lyra_dir: &Path, draft_id: &str) -> Result<PathBuf, String> {
    if !is_valid_draft_id(draft_id) {
        return Err(format!("Identificador de borrador inválido: '{draft_id}'"));
    }
    let dir = ensure_drafts_dir(lyra_dir)?;
    Ok(dir.join(format!("{draft_id}.json")))
}

pub fn save_draft_file(lyra_dir: &Path, draft_id: &str, payload_json: &str) -> Result<(), String> {
    if payload_json.len() > MAX_DRAFT_JSON_BYTES {
        return Err("El borrador supera el límite de seguridad de 32 MB y no puede guardarse".to_string());
    }
    let path = draft_path(lyra_dir, draft_id)?;
    crate::gdrive::sync::write_file_atomic(&path, payload_json.as_bytes())
        .map_err(|e| format!("No se pudo persistir el borrador: {e}"))?;
    Ok(())
}

/// Devuelve el contenido crudo del JSON o `None` si no existe.
/// Un payload corrupto se devuelve tal cual para que el frontend decida
/// de forma conservadora (sin borrar datos).
pub fn read_draft_file(lyra_dir: &Path, draft_id: &str) -> Result<Option<String>, String> {
    if !is_valid_draft_id(draft_id) {
        return Err(format!("Identificador de borrador inválido: '{draft_id}'"));
    }
    let dir = ensure_drafts_dir(lyra_dir)?;
    let path = dir.join(format!("{draft_id}.json"));
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("No se pudo leer el borrador: {e}")),
    }
}

pub fn delete_draft_file(lyra_dir: &Path, draft_id: &str) -> Result<(), String> {
    if !is_valid_draft_id(draft_id) {
        return Err(format!("Identificador de borrador inválido: '{draft_id}'"));
    }
    let dir = ensure_drafts_dir(lyra_dir)?;
    let path = dir.join(format!("{draft_id}.json"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("No se pudo eliminar el borrador: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lyra() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let lyra = dir.path().join("lyra");
        std::fs::create_dir(&lyra).unwrap();
        (dir, lyra)
    }

    #[test]
    fn valid_ids() {
        assert!(is_valid_draft_id("0123456789abcdef"));
        assert!(is_valid_draft_id("0123456789ABCDEF"));
        assert!(!is_valid_draft_id("../evil"));
        assert!(!is_valid_draft_id(""));
        assert!(!is_valid_draft_id("no-separador"));
    }

    #[test]
    fn save_read_delete_roundtrip() {
        let (_t, lyra) = lyra();
        save_draft_file(&lyra, "0123456789abcdef", r#"{"v":1,"content":"hola"}"#).unwrap();
        assert_eq!(
            read_draft_file(&lyra, "0123456789abcdef").unwrap().as_deref(),
            Some(r#"{"v":1,"content":"hola"}"#)
        );
        delete_draft_file(&lyra, "0123456789abcdef").unwrap();
        assert_eq!(read_draft_file(&lyra, "0123456789abcdef").unwrap(), None);
        // Borrar inexistente es OK.
        delete_draft_file(&lyra, "0123456789abcdef").unwrap();
    }

    #[test]
    fn invalid_id_rejected() {
        let (_t, lyra) = lyra();
        assert!(save_draft_file(&lyra, "../evil", "{}").is_err());
        assert!(read_draft_file(&lyra, "..").is_err());
    }

    #[test]
    fn oversize_rejected() {
        let (_t, lyra) = lyra();
        let big = "X".repeat(MAX_DRAFT_JSON_BYTES + 1);
        assert!(save_draft_file(&lyra, "0123456789abcdef", &big).is_err());
    }

    #[test]
    fn corrupt_payload_returned_raw() {
        let (_t, lyra) = lyra();
        save_draft_file(&lyra, "0123456789abcdef", "no-json").unwrap();
        assert_eq!(
            read_draft_file(&lyra, "0123456789abcdef").unwrap().as_deref(),
            Some("no-json")
        );
    }
}
