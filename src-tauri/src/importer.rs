use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::gdrive;

pub const MAX_IMPORT_FILE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ImportedFile {
    pub original_path: String,
    pub file_name: String,
    pub size: u64,
    #[serde(default)]
    pub is_internal: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ImportError {
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ImportBatchResult {
    pub imported: Vec<ImportedFile>,
    pub errors: Vec<ImportError>,
}

/// Sanitiza un nombre de archivo externo eliminando caracteres incompatibles en POSIX y Windows,
/// preservando la extensión original.
pub fn sanitize_import_stem(raw_stem: &str) -> String {
    let mut clean: String = raw_stem
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();

    // Eliminar espacios y puntos iniciales/finales
    clean = clean.trim_matches(|c| c == ' ' || c == '.').to_string();

    if clean.is_empty() {
        clean = "archivo".to_string();
    }

    // Comprobar nombres reservados de Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    let upper = clean.to_ascii_uppercase();
    if gdrive::sync::WINDOWS_RESERVED_NAMES.contains(&upper.as_str()) {
        clean = format!("{clean}_nota");
    }

    clean
}

/// Separa de forma segura el stem y la extensión de un nombre de archivo.
pub fn split_import_filename(name: &str) -> (String, String) {
    if let Some(dot_idx) = name.rfind('.') {
        (name[..dot_idx].to_string(), name[dot_idx..].to_string())
    } else {
        (name.to_string(), String::new())
    }
}

/// Valida y lee un archivo externo de forma segura respetando el límite de 20 MB,
/// rechazando archivos binarios y codificaciones incompatibles con UTF-8,
/// sin alterar los bytes originales (preserva BOM, saltos de línea CRLF/LF e indentación).
pub fn read_and_validate_external_file(source_path: &Path) -> Result<(String, Vec<u8>), String> {
    let path_str = source_path.to_string_lossy().to_string();

    // 1. Validar que la ruta existe
    if !source_path.exists() {
        return Err(format!("El archivo '{path_str}' no existe"));
    }

    // 2. Metadatos de la ruta y resolución de symlinks
    let metadata = fs::symlink_metadata(source_path)
        .map_err(|e| format!("No se pudo inspeccionar '{path_str}': {e}"))?;

    let final_metadata = if metadata.file_type().is_symlink() {
        fs::metadata(source_path)
            .map_err(|e| format!("El enlace simbólico '{path_str}' no apunta a un archivo válido: {e}"))?
    } else {
        metadata
    };

    if !final_metadata.is_file() {
        return Err(format!("'{path_str}' no es un archivo regular (es un directorio o dispositivo especial)"));
    }

    // 3. Comprobar límite estricto de tamaño (20 MB) antes de leer a memoria
    let size = final_metadata.len();
    if size > MAX_IMPORT_FILE_SIZE {
        let size_mb = size as f64 / (1024.0 * 1024.0);
        return Err(format!(
            "El archivo supera el límite de seguridad de 20 MB ({:.2} MB). Para proteger el rendimiento, no puede importarse.",
            size_mb
        ));
    }

    // 4. Validar extensión compatible
    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Nombre de archivo inválido en ruta '{path_str}'"))?;

    if !gdrive::sync::has_supported_extension(file_name) {
        let (_, ext) = split_import_filename(file_name);
        return Err(format!(
            "El formato de archivo '{}' no es compatible con Lyra",
            if ext.is_empty() { "sin extensión" } else { &ext }
        ));
    }

    // 5. Lectura en modo solo lectura del archivo externo (el archivo fuente nunca se modifica)
    let mut file = fs::File::open(source_path)
        .map_err(|e| format!("No se pudo abrir '{path_str}' para lectura: {e}"))?;

    let mut bytes = Vec::with_capacity(size as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Error de lectura en '{path_str}': {e}"))?;

    // 6. Detección de binarios mediante búsqueda de bytes nulos (null bytes \0)
    if bytes.contains(&0) {
        return Err(format!("El archivo '{file_name}' es binario o contiene bytes nulos no permitidos"));
    }

    // 7. Validación estricta de codificación UTF-8
    // Conserva íntegramente los bytes (incluyendo UTF-8 BOM EF BB BF si estuviese presente)
    if std::str::from_utf8(&bytes).is_err() {
        return Err(format!(
            "El archivo '{file_name}' contiene una codificación incompatible (se requiere texto plano en UTF-8)"
        ));
    }

    // 8. Control adicional de caracteres de control no imprimibles
    // Permitir tabulador (9), LF (10), CR (13)
    let non_printable_control = bytes.iter().any(|&b| b < 32 && b != 9 && b != 10 && b != 13);
    if non_printable_control {
        return Err(format!("El archivo '{file_name}' contiene caracteres de control binarios incompatibles"));
    }

    Ok((file_name.to_string(), bytes))
}

/// Genera un nombre seguro y exclusivo en `base_dir` evitando colisiones mediante sufijos `(1)`, `(2)`, etc.
/// Escribe atómicamente la copia con `create_new(true)`. Si ocurre un fallo, remueve el fichero incompleto.
pub fn write_unique_imported_file(
    base_dir: &Path,
    original_filename: &str,
    bytes: &[u8],
) -> Result<String, String> {
    gdrive::sync::ensure_safe_base_dir(base_dir)?;

    let (stem, ext) = split_import_filename(original_filename);
    let safe_stem = sanitize_import_stem(&stem);
    let safe_ext = ext.to_ascii_lowercase();

    // 1. Intento con el nombre original limpio
    let initial_name = format!("{safe_stem}{safe_ext}");
    if gdrive::sync::is_safe_filename(&initial_name) {
        let initial_path = base_dir.join(&initial_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&initial_path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    let _ = fs::remove_file(&initial_path);
                    return Err(format!("Error escribiendo copia de '{initial_name}': {e}"));
                }
                return Ok(initial_name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Proceder a buscar sufijo único incremental
            }
            Err(e) => {
                return Err(format!("Error al crear nota importada '{initial_name}': {e}"));
            }
        }
    }

    // 2. Colisión: generar sufijo numérico secuencial ` (1)`, ` (2)`, ...
    for counter in 1..=10000 {
        let candidate_name = format!("{safe_stem} ({counter}){safe_ext}");
        if !gdrive::sync::is_safe_filename(&candidate_name) {
            continue;
        }
        let candidate_path = base_dir.join(&candidate_name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate_path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
                    let _ = fs::remove_file(&candidate_path);
                    return Err(format!("Error escribiendo copia de '{candidate_name}': {e}"));
                }
                return Ok(candidate_name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Error creando archivo candidato '{candidate_name}': {e}")),
        }
    }

    Err(format!("No se pudo encontrar un nombre disponible para '{original_filename}' tras 10000 intentos"))
}

/// Comprueba de forma canónica y segura si una ruta apunta a un archivo que ya reside
/// directamente dentro del directorio de notas de Lyra (`lyra_dir`).
///
/// Resuelve symlinks, rutas relativas/absolutas, normalización de separadores y `..`.
/// Rechaza subdirectorios, rutas fuera de `lyra_dir`, archivos ocultos o extensiones no soportadas.
pub fn is_internal_lyra_file(lyra_dir: &Path, file_path: &Path) -> Option<String> {
    let canonical_lyra = lyra_dir.canonicalize().ok()?;
    let canonical_file = file_path.canonicalize().ok()?;

    if !canonical_file.is_file() {
        return None;
    }

    let parent = canonical_file.parent()?;
    if parent == canonical_lyra {
        let file_name = canonical_file.file_name()?.to_str()?;
        if !file_name.starts_with('.') && gdrive::sync::has_supported_extension(file_name) {
            return Some(file_name.to_string());
        }
    }

    None
}

/// Importa un conjunto de archivos externos hacia `lyra_dir` de forma atómica y segura,
/// o reconoce y abre directamente archivos que ya pertenecen internamente a Lyra sin duplicarlos.
/// Registra cada nota importada en la procedencia local de Google Drive para permitir su sincronización.
pub async fn import_paths(
    lyra_dir: &Path,
    paths: &[String],
    active_account: Option<&str>,
) -> ImportBatchResult {
    let mut result = ImportBatchResult::default();

    // Asegurar que el directorio de Lyra exista
    if let Err(e) = fs::create_dir_all(lyra_dir) {
        result.errors.push(ImportError {
            path: lyra_dir.to_string_lossy().to_string(),
            error: format!("No se pudo crear el directorio de notas de Lyra: {e}"),
        });
        return result;
    }

    for raw_path in paths {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Manejar posibles URLs file:// pasadas por el sistema operativo
        let resolved_path = if trimmed.starts_with("file://") {
            if let Ok(parsed_url) = url::Url::parse(trimmed) {
                if let Ok(file_path) = parsed_url.to_file_path() {
                    file_path
                } else {
                    PathBuf::from(trimmed)
                }
            } else {
                PathBuf::from(trimmed)
            }
        } else {
            PathBuf::from(trimmed)
        };

        // Comprobar primero si la ruta apunta a un archivo que ya pertenece directamente a Lyra
        if let Some(internal_name) = is_internal_lyra_file(lyra_dir, &resolved_path) {
            let size = resolved_path.metadata().map(|m| m.len()).unwrap_or(0);
            result.imported.push(ImportedFile {
                original_path: trimmed.to_string(),
                file_name: internal_name,
                size,
                is_internal: true,
            });
            continue;
        }

        // Caso A: Archivo externo -> validar y crear copia segura
        match read_and_validate_external_file(&resolved_path) {
            Ok((orig_name, bytes)) => {
                // Coordinación con el cerrojo de Google Drive y manifest lock
                let _guard = gdrive::sync::MANIFEST_LOCK.lock().await;
                match write_unique_imported_file(lyra_dir, &orig_name, &bytes) {
                    Ok(created_name) => {
                        let size = bytes.len() as u64;
                        // Registrar procedencia de la nueva nota importada
                        if let Err(e) = gdrive::provenance::record_local_write(
                            lyra_dir,
                            &created_name,
                            active_account,
                            true,
                        ) {
                            eprintln!("[Importer] Nota importada localmente, aviso en procedencia: {e}");
                        }

                        result.imported.push(ImportedFile {
                            original_path: trimmed.to_string(),
                            file_name: created_name,
                            size,
                            is_internal: false,
                        });
                    }
                    Err(err) => {
                        result.errors.push(ImportError {
                            path: trimmed.to_string(),
                            error: err,
                        });
                    }
                }
            }
            Err(err) => {
                result.errors.push(ImportError {
                    path: trimmed.to_string(),
                    error: err,
                });
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_validate_rejects_missing_file() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("no_existe.txt");
        assert!(read_and_validate_external_file(&missing).is_err());
    }

    #[test]
    fn test_validate_rejects_directory() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("carpeta.txt");
        fs::create_dir(&sub).unwrap();
        assert!(read_and_validate_external_file(&sub).is_err());
    }

    #[test]
    fn test_validate_rejects_unsupported_extension() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("archivo.bin");
        fs::write(&file, b"contenido").unwrap();
        let err = read_and_validate_external_file(&file).unwrap_err();
        assert!(err.contains("no es compatible"));
    }

    #[test]
    fn test_validate_rejects_null_bytes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("ejecutable.py");
        fs::write(&file, b"print('hola')\0print('mundo')").unwrap();
        let err = read_and_validate_external_file(&file).unwrap_err();
        assert!(err.contains("binario") || err.contains("nulos"));
    }

    #[test]
    fn test_validate_rejects_invalid_utf8() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("codigo.rs");
        // Secuencia inválida en UTF-8
        fs::write(&file, [0xFF, 0xFE, 0xFD]).unwrap();
        let err = read_and_validate_external_file(&file).unwrap_err();
        assert!(err.contains("incompatible") || err.contains("UTF-8"));
    }

    #[test]
    fn test_validate_rejects_non_printable_control_bytes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("prueba.json");
        // Carácter de control 0x07 (BEL) no imprimible
        fs::write(&file, b"{\x07}").unwrap();
        let err = read_and_validate_external_file(&file).unwrap_err();
        assert!(err.contains("caracteres de control"));
    }

    #[test]
    fn test_validate_preserves_utf8_bom_and_original_bytes() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("con_bom.txt");
        // UTF-8 BOM seguido de texto con CRLF
        let original_data = b"\xEF\xBB\xBFHola mundo\r\nSegunda linea\r\n";
        fs::write(&file, original_data).unwrap();

        let (name, read_bytes) = read_and_validate_external_file(&file).unwrap();
        assert_eq!(name, "con_bom.txt");
        assert_eq!(read_bytes, original_data, "Debe preservar exactamente los bytes originales sin remover BOM ni alterar CRLF");

        // Verificar que el archivo original no fue modificado
        assert_eq!(fs::read(&file).unwrap(), original_data);
    }

    #[test]
    fn test_collision_resolution_generates_sequential_names() {
        let dir = tempdir().unwrap();
        let content1 = b"Version 1";
        let content2 = b"Version 2";
        let content3 = b"Version 3";

        let name1 = write_unique_imported_file(dir.path(), "config.json", content1).unwrap();
        assert_eq!(name1, "config.json");
        assert_eq!(fs::read(dir.path().join(&name1)).unwrap(), content1);

        let name2 = write_unique_imported_file(dir.path(), "config.json", content2).unwrap();
        assert_eq!(name2, "config (1).json");
        assert_eq!(fs::read(dir.path().join(&name2)).unwrap(), content2);

        let name3 = write_unique_imported_file(dir.path(), "config.json", content3).unwrap();
        assert_eq!(name3, "config (2).json");
        assert_eq!(fs::read(dir.path().join(&name3)).unwrap(), content3);

        // Ningún archivo previo fue sobrescrito
        assert_eq!(fs::read(dir.path().join("config.json")).unwrap(), content1);
        assert_eq!(fs::read(dir.path().join("config (1).json")).unwrap(), content2);
        assert_eq!(fs::read(dir.path().join("config (2).json")).unwrap(), content3);
    }

    #[test]
    fn test_collision_resolution_with_various_extensions() {
        let dir = tempdir().unwrap();
        let py_name1 = write_unique_imported_file(dir.path(), "script.py", b"print(1)").unwrap();
        let py_name2 = write_unique_imported_file(dir.path(), "script.py", b"print(2)").unwrap();
        assert_eq!(py_name1, "script.py");
        assert_eq!(py_name2, "script (1).py");

        let html_name1 = write_unique_imported_file(dir.path(), "index.html", b"<h1>1</h1>").unwrap();
        let html_name2 = write_unique_imported_file(dir.path(), "index.html", b"<h1>2</h1>").unwrap();
        assert_eq!(html_name1, "index.html");
        assert_eq!(html_name2, "index (1).html");
    }

    #[tokio::test]
    async fn test_import_paths_batch_success_and_partial_failures() {
        let src_dir = tempdir().unwrap();
        let dest_dir = tempdir().unwrap();

        // Archivo 1: Válido (.py)
        let valid_py = src_dir.path().join("calculo.py");
        fs::write(&valid_py, b"def suma(a, b): return a + b").unwrap();

        // Archivo 2: Inválido (binario con null byte)
        let invalid_bin = src_dir.path().join("corrupto.txt");
        fs::write(&invalid_bin, b"test\0null").unwrap();

        // Archivo 3: Válido (.json)
        let valid_json = src_dir.path().join("ajustes.json");
        fs::write(&valid_json, b"{\"tema\": \"oscuro\"}").unwrap();

        // Archivo 4: Extensión no soportada (.exe)
        let unsupported = src_dir.path().join("programa.exe");
        fs::write(&unsupported, b"mz...").unwrap();

        let paths = vec![
            valid_py.to_string_lossy().to_string(),
            invalid_bin.to_string_lossy().to_string(),
            valid_json.to_string_lossy().to_string(),
            unsupported.to_string_lossy().to_string(),
        ];

        let result = import_paths(dest_dir.path(), &paths, None).await;

        // Se importaron 2 archivos válidos
        assert_eq!(result.imported.len(), 2);
        assert_eq!(result.imported[0].file_name, "calculo.py");
        assert_eq!(result.imported[1].file_name, "ajustes.json");

        // Hubo 2 errores correspondientes a los inválidos
        assert_eq!(result.errors.len(), 2);
        assert!(result.errors.iter().any(|e| e.error.contains("binario")));
        assert!(result.errors.iter().any(|e| e.error.contains("no es compatible")));

        // Los archivos originales permanecen intactos
        assert!(valid_py.exists());
        assert!(invalid_bin.exists());
        assert!(valid_json.exists());
        assert!(unsupported.exists());

        // Los archivos de destino existen con el contenido correcto
        assert_eq!(fs::read(dest_dir.path().join("calculo.py")).unwrap(), b"def suma(a, b): return a + b");
        assert_eq!(fs::read(dest_dir.path().join("ajustes.json")).unwrap(), b"{\"tema\": \"oscuro\"}");
    }

    #[test]
    fn test_validate_rejects_file_exceeding_20mb() {
        let dir = tempdir().unwrap();
        let large_file = dir.path().join("demasiado_grande.log");
        let file = fs::File::create(&large_file).unwrap();
        // Crear archivo sparse de 21 MB (sin ocupar 21 MB reales en disco)
        file.set_len(21 * 1024 * 1024).unwrap();

        let err = read_and_validate_external_file(&large_file).unwrap_err();
        assert!(err.contains("20 MB"), "Debe indicar que supera el límite de 20 MB: {err}");
    }

    #[test]
    fn test_validate_preserves_crlf_and_tabs() {
        let dir = tempdir().unwrap();
        let code_file = dir.path().join("formato.py");
        let exact_bytes = b"def test():\r\n\tval = 1\r\n\treturn val\r\n";
        fs::write(&code_file, exact_bytes).unwrap();

        let (_, read_bytes) = read_and_validate_external_file(&code_file).unwrap();
        assert_eq!(read_bytes, exact_bytes);
    }

    #[test]
    fn test_sanitize_import_stem_removes_forbidden_and_reserved_names() {
        assert_eq!(sanitize_import_stem("mi:archivo*invalido"), "mi_archivo_invalido");
        assert_eq!(sanitize_import_stem("...nombre..."), "nombre");
        assert_eq!(sanitize_import_stem(""), "archivo");
        // Windows reserved name
        assert_eq!(sanitize_import_stem("CON"), "CON_nota");
        assert_eq!(sanitize_import_stem("prn"), "prn_nota");
        assert_eq!(sanitize_import_stem("aux"), "aux_nota");
    }

    #[test]
    fn test_is_internal_lyra_file_detection() {
        let lyra_dir = tempdir().unwrap();
        let external_dir = tempdir().unwrap();

        // 1. Archivo interno directo
        let internal_file = lyra_dir.path().join("ejemplo.txt");
        fs::write(&internal_file, "contenido").unwrap();
        assert_eq!(
            is_internal_lyra_file(lyra_dir.path(), &internal_file),
            Some("ejemplo.txt".to_string())
        );

        // 2. Archivo externo con el mismo nombre
        let external_file = external_dir.path().join("ejemplo.txt");
        fs::write(&external_file, "contenido externo").unwrap();
        assert_eq!(
            is_internal_lyra_file(lyra_dir.path(), &external_file),
            None
        );

        // 3. Archivo dentro de subdirectorio (Lyra solo admite raíz de notas)
        let sub_dir = lyra_dir.path().join("subcarpeta");
        fs::create_dir(&sub_dir).unwrap();
        let sub_file = sub_dir.join("nota.txt");
        fs::write(&sub_file, "sub").unwrap();
        assert_eq!(
            is_internal_lyra_file(lyra_dir.path(), &sub_file),
            None
        );

        // 4. Ruta con escape de directorio ..
        let outside_file = lyra_dir.path().join("../fuera.txt");
        fs::write(&outside_file, "fuera").unwrap();
        assert_eq!(
            is_internal_lyra_file(lyra_dir.path(), &outside_file),
            None
        );

        // 5. Archivo oculto interno
        let hidden = lyra_dir.path().join(".manifest.json");
        fs::write(&hidden, "{}").unwrap();
        assert_eq!(
            is_internal_lyra_file(lyra_dir.path(), &hidden),
            None
        );

        // 6. Archivo no soportado interno
        let image = lyra_dir.path().join("foto.png");
        fs::write(&image, b"png").unwrap();
        assert_eq!(
            is_internal_lyra_file(lyra_dir.path(), &image),
            None
        );

        // 7. Symlink externo que apunta al archivo interno
        #[cfg(unix)]
        {
            let symlink_path = external_dir.path().join("link_to_internal.txt");
            std::os::unix::fs::symlink(&internal_file, &symlink_path).unwrap();
            assert_eq!(
                is_internal_lyra_file(lyra_dir.path(), &symlink_path),
                Some("ejemplo.txt".to_string())
            );
        }

        // 8. Symlink interno que apunta hacia afuera
        #[cfg(unix)]
        {
            let internal_symlink = lyra_dir.path().join("link_to_external.txt");
            std::os::unix::fs::symlink(&external_file, &internal_symlink).unwrap();
            assert_eq!(
                is_internal_lyra_file(lyra_dir.path(), &internal_symlink),
                None
            );
        }
    }

    #[tokio::test]
    async fn test_import_paths_internal_file_is_not_duplicated() {
        let lyra_dir = tempdir().unwrap();
        let internal_file = lyra_dir.path().join("nota_existente.md");
        fs::write(&internal_file, "# Contenido original").unwrap();

        let paths = vec![internal_file.to_string_lossy().to_string()];

        // Primera apertura
        let res1 = import_paths(lyra_dir.path(), &paths, None).await;
        assert_eq!(res1.imported.len(), 1);
        assert_eq!(res1.imported[0].file_name, "nota_existente.md");
        assert!(res1.imported[0].is_internal);
        assert_eq!(res1.errors.len(), 0);

        // Segunda apertura repetida
        let res2 = import_paths(lyra_dir.path(), &paths, None).await;
        assert_eq!(res2.imported.len(), 1);
        assert_eq!(res2.imported[0].file_name, "nota_existente.md");
        assert!(res2.imported[0].is_internal);

        // Verificar que no se creó ningún archivo adicional como nota_existente (1).md
        let entries: Vec<_> = fs::read_dir(lyra_dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(entries, vec!["nota_existente.md"]);
    }

    #[tokio::test]
    async fn test_import_paths_external_same_name_resolves_collision() {
        let lyra_dir = tempdir().unwrap();
        let external_dir = tempdir().unwrap();

        // Archivo interno existente
        let internal_file = lyra_dir.path().join("documento.txt");
        fs::write(&internal_file, "texto interno original").unwrap();

        // Archivo externo con el mismo nombre
        let external_file = external_dir.path().join("documento.txt");
        fs::write(&external_file, "texto externo nuevo").unwrap();

        let paths = vec![external_file.to_string_lossy().to_string()];
        let res = import_paths(lyra_dir.path(), &paths, None).await;

        assert_eq!(res.imported.len(), 1);
        assert_eq!(res.imported[0].file_name, "documento (1).txt");
        assert!(!res.imported[0].is_internal);

        // El archivo interno original no debe haber sido tocado
        assert_eq!(fs::read_to_string(&internal_file).unwrap(), "texto interno original");

        // La copia importada existe con el contenido externo
        let copy_path = lyra_dir.path().join("documento (1).txt");
        assert_eq!(fs::read_to_string(&copy_path).unwrap(), "texto externo nuevo");
    }
}
