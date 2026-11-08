import test from "node:test";
import assert from "node:assert/strict";
import {
  hasSupportedNoteExtension,
  noteTitle,
  noteLabel,
  ensureNoteExtension,
  isReservedWindowsFileName,
} from "../src/utils/noteName.ts";
import { fileStore } from "../src/store/fileStore.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import { registerNavigator } from "../src/utils/navigation.ts";
import { handleExternalFileImport } from "../src/utils/fileImporter.ts";
import { registerEditorSession } from "../src/utils/editorPersistence.ts";
import { EditorSyncCoordinator } from "../src/utils/editorSyncCoordinator.ts";

function setupMockEnvironment() {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
    },
    sessionStorage: {
      getItem: (k: string) => store.get(`session:${k}`) ?? null,
      setItem: (k: string, v: string) => store.set(`session:${k}`, String(v)),
      removeItem: (k: string) => store.delete(`session:${k}`),
    },
    matchMedia: () => ({ matches: false }),
    __TAURI_INTERNALS__: {},
  };
  return store;
}

// -----------------------------------------------------------------------------
// 1. Extensiones nuevas y existentes
// -----------------------------------------------------------------------------

test("1. Todas las extensiones requeridas están soportadas", () => {
  const expectedExtensions = [
    ".txt", ".md", ".markdown",
    ".json", ".jsonc",
    ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".csv", ".log",
    ".html", ".htm", ".xml",
    ".css", ".scss",
    ".js", ".jsx", ".ts", ".tsx",
    ".py", ".rs", ".sh", ".sql",
  ];

  for (const ext of expectedExtensions) {
    assert.equal(
      hasSupportedNoteExtension(`archivo${ext}`),
      true,
      `Debe soportar ${ext}`
    );
    assert.equal(
      hasSupportedNoteExtension(`archivo${ext.toUpperCase()}`),
      true,
      `Debe soportar ${ext} en mayúsculas`
    );
  }

  // Extensiones no soportadas / binarias
  assert.equal(hasSupportedNoteExtension("archivo.bin"), false);
  assert.equal(hasSupportedNoteExtension("programa.exe"), false);
  assert.equal(hasSupportedNoteExtension("foto.png"), false);
  assert.equal(hasSupportedNoteExtension("documento.pdf"), false);
  assert.equal(hasSupportedNoteExtension("archivo_sin_extension"), false);
});

// -----------------------------------------------------------------------------
// 2. Visualización: Ocultar .txt y .md, mostrar el resto
// -----------------------------------------------------------------------------

test("2. noteTitle oculta solo .txt y .md, y muestra las demás extensiones", () => {
  // Ocultar .txt y .md
  assert.equal(noteTitle("ideas.txt"), "ideas");
  assert.equal(noteTitle("apuntes.md"), "apuntes");
  assert.equal(noteTitle("notas.MD"), "notas");
  assert.equal(noteTitle("tareas.TXT"), "tareas");

  // Mostrar formatos técnicos y estructurados
  assert.equal(noteTitle("config.json"), "config.json");
  assert.equal(noteTitle("servidor.js"), "servidor.js");
  assert.equal(noteTitle("componente.tsx"), "componente.tsx");
  assert.equal(noteTitle("script.py"), "script.py");
  assert.equal(noteTitle("modulo.rs"), "modulo.rs");
  assert.equal(noteTitle("estilos.css"), "estilos.css");
  assert.equal(noteTitle("datos.csv"), "datos.csv");
  assert.equal(noteTitle("esquema.sql"), "esquema.sql");
  assert.equal(noteTitle("documentacion.markdown"), "documentacion.markdown");

  // Desambiguación: archivos homónimos con diferente extensión
  assert.notEqual(noteTitle("servidor.txt"), noteTitle("servidor.js"));
  assert.equal(noteTitle("servidor.txt"), "servidor");
  assert.equal(noteTitle("servidor.js"), "servidor.js");
});

test("3. noteLabel envuelve el título con comillas latinas según el tipo de archivo", () => {
  assert.equal(noteLabel("ideas.txt"), "«ideas»");
  assert.equal(noteLabel("script.py"), "«script.py»");
  assert.equal(noteLabel("config.json"), "«config.json»");
});

// -----------------------------------------------------------------------------
// 3. Validación de nombres y preservación de extensiones
// -----------------------------------------------------------------------------

test("4. ensureNoteExtension preserva la extensión al renombrar o crear", () => {
  // Sin extensión previa: añade .txt por defecto
  assert.equal(ensureNoteExtension("nueva_nota"), "nueva_nota.txt");

  // Si ya tiene extensión soportada, la conserva
  assert.equal(ensureNoteExtension("script.py"), "script.py");
  assert.equal(ensureNoteExtension("datos.json"), "datos.json");

  // Al renombrar una nota existente con otra extensión técnica, la preserva
  assert.equal(ensureNoteExtension("nuevo_script", "antiguo.py"), "nuevo_script.py");
  assert.equal(ensureNoteExtension("nueva_config", "ajustes.json"), "nueva_config.json");
  assert.equal(ensureNoteExtension("nuevo_estilo", "main.css"), "nuevo_estilo.css");
  assert.equal(ensureNoteExtension("borrador", "plantilla.md"), "borrador.md");
});

test("5. isReservedWindowsFileName detecta nombres reservados de Windows con cualquier extensión", () => {
  // Nombres reservados prohibidos con cualquier extensión
  assert.equal(isReservedWindowsFileName("CON.txt"), true);
  assert.equal(isReservedWindowsFileName("prn.json"), true);
  assert.equal(isReservedWindowsFileName("AUX.py"), true);
  assert.equal(isReservedWindowsFileName("nul.html"), true);
  assert.equal(isReservedWindowsFileName("COM1.rs"), true);

  // Nombres válidos
  assert.equal(isReservedWindowsFileName("servidor.py"), false);
  assert.equal(isReservedWindowsFileName("configuracion.json"), false);
  assert.equal(isReservedWindowsFileName("index.html"), false);
});

// -----------------------------------------------------------------------------
// 4. Importación individual, múltiple y fallos parciales
// -----------------------------------------------------------------------------

test("6. handleExternalFileImport procesa importación individual exitosa y navega", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  // Mock de tauri invoke
  const mockInvoke = async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      const paths = args?.paths as string[];
      return {
        imported: [
          { original_path: paths[0], file_name: "importado.py", size: 120 },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  fileStore.getState().setFiles([]);

  const ok = await handleExternalFileImport(["/home/user/descargas/importado.py"]);
  assert.equal(ok, true);

  // Se actualizó la lista en el store
  assert.equal(fileStore.getState().files.includes("importado.py"), true);
  // Se seleccionó el archivo y se navegó a /file
  assert.equal(fileStore.getState().selectedFile.name, "importado.py");
  assert.equal(navigatedTo, "/file");

  // Notificación de éxito
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, "success");
  assert.equal(toasts[0].msg.includes("importado.py"), true);
});

test("7. handleExternalFileImport procesa importación múltiple abriendo la primera nota", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      return {
        imported: [
          { original_path: "/path/nota1.py", file_name: "nota1.py", size: 100 },
          { original_path: "/path/nota2.json", file_name: "nota2.json", size: 200 },
          { original_path: "/path/nota3.css", file_name: "nota3.css", size: 300 },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  fileStore.getState().setFiles([]);

  const ok = await handleExternalFileImport(["/path/nota1.py", "/path/nota2.json", "/path/nota3.css"]);
  assert.equal(ok, true);

  // Los 3 archivos están en la lista
  assert.equal(fileStore.getState().files.includes("nota1.py"), true);
  assert.equal(fileStore.getState().files.includes("nota2.json"), true);
  assert.equal(fileStore.getState().files.includes("nota3.css"), true);

  // Se abrió el primero
  assert.equal(fileStore.getState().selectedFile.name, "nota1.py");
  assert.equal(navigatedTo, "/file");

  // Notificación de cantidad múltiple
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, "success");
  assert.equal(toasts[0].msg.includes("3 archivos"), true);
  assert.equal(toasts[0].msg.includes("nota1.py"), true);
});

test("8. handleExternalFileImport comunica errores parciales sin perder los archivos válidos", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      return {
        imported: [
          { original_path: "/path/valido.rs", file_name: "valido.rs", size: 500 },
        ],
        errors: [
          { path: "/path/binario.exe", error: "El formato '.exe' no es compatible" },
          { path: "/path/corrupto.py", error: "El archivo contiene bytes nulos binarios" },
        ],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  fileStore.getState().setFiles([]);

  const ok = await handleExternalFileImport(["/path/valido.rs", "/path/binario.exe", "/path/corrupto.py"]);
  assert.equal(ok, true);

  // El válido se importó y se abrió
  assert.equal(fileStore.getState().files.includes("valido.rs"), true);
  assert.equal(fileStore.getState().selectedFile.name, "valido.rs");
  assert.equal(navigatedTo, "/file");

  // Se reportaron los 2 errores y el éxito
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 3);
  const errorToasts = toasts.filter(t => t.type === "error");
  assert.equal(errorToasts.length, 2);
  assert.equal(errorToasts.some(t => t.msg.includes(".exe")), true);
  assert.equal(errorToasts.some(t => t.msg.includes("bytes nulos")), true);
  assert.equal(toasts.some(t => t.type === "success" && t.msg.includes("valido.rs")), true);
});

// -----------------------------------------------------------------------------
// 5. Protección de cambios pendientes del editor antes de navegar
// -----------------------------------------------------------------------------

test("9. handleExternalFileImport bloquea la navegación si el guardado pendiente del editor falla", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      return {
        imported: [
          { original_path: "/path/nuevo.txt", file_name: "nuevo.txt", size: 50 },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  // Simular sesión de editor con cambios sucios cuyo guardado falla
  const failingCoordinator = new EditorSyncCoordinator({
    fileName: "nota_actual.txt",
    initialContent: "Original",
    saveFileContent: async () => {
      throw new Error("Disco lleno o error de E/S simulado");
    },
    readFileContent: async () => "Original",
  });
  failingCoordinator.handleUserContentChange("Texto modificado sucio");
  assert.equal(failingCoordinator.getIsDirty(), true);

  const release = registerEditorSession(failingCoordinator);

  try {
    fileStore.getState().setSelectedFile({ name: "nota_actual.txt", content: "Original" });

    const ok = await handleExternalFileImport(["/path/nuevo.txt"]);
    assert.equal(ok, true);

    // El archivo importado SÍ se agregó a la lista disponible
    assert.equal(fileStore.getState().files.includes("nuevo.txt"), true);

    // Pero NO se cambió de nota ni se navegó, protegiendo el editor sucio
    assert.equal(fileStore.getState().selectedFile.name, "nota_actual.txt");
    assert.equal(navigatedTo, "");

    // Se informó al usuario del error
    const toasts = useToastStore.getState().toasts;
    assert.equal(toasts.some(t => t.type === "error" && t.msg.includes("cambios pendientes")), true);
  } finally {
    release();
  }
});

// -----------------------------------------------------------------------------
// 6. Deduplicación de eventos repetidos
// -----------------------------------------------------------------------------

test("10. handleExternalFileImport ignora eventos repetidos en la ventana de deduplicación", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let invokeCount = 0;
  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      invokeCount++;
      return {
        imported: [
          { original_path: "/path/repetido.txt", file_name: "repetido.txt", size: 50 },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  // Primera invocación
  const first = await handleExternalFileImport(["/path/repetido.txt"]);
  assert.equal(first, true);
  assert.equal(invokeCount, 1);

  // Segunda invocación inmediata con la misma ruta
  const second = await handleExternalFileImport(["/path/repetido.txt"]);
  assert.equal(second, false, "Debe ser ignorada por la deduplicación");
  assert.equal(invokeCount, 1, "No debe invocar el backend una segunda vez");
});

// -----------------------------------------------------------------------------
// 7. Apertura de archivos internos vs externos sin duplicados
// -----------------------------------------------------------------------------

test("11. handleExternalFileImport con archivo interno: se abre directamente sin crear copias ni mostrar toast de importación", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      // Backend detecta archivo interno mediante is_internal_lyra_file
      return {
        imported: [
          {
            original_path: "/home/user/Documents/lyra/mi_nota.txt",
            file_name: "mi_nota.txt",
            size: 120,
            is_internal: true,
          },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  fileStore.getState().setSelectedFile({ name: "otra_nota.txt", content: "Otra" });
  fileStore.getState().setFiles(["otra_nota.txt", "mi_nota.txt"]);

  const ok = await handleExternalFileImport(["/home/user/Documents/lyra/mi_nota.txt"]);
  assert.equal(ok, true);

  // La nota se seleccionó y se navegó al editor
  assert.equal(fileStore.getState().selectedFile.name, "mi_nota.txt");
  assert.equal(navigatedTo, "/file");

  // Al ser un archivo interno, NO se debe mostrar notificación de "se importó copia"
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.some(t => t.msg.includes("se importó")), false);
});

test("12. handleExternalFileImport con archivo ya abierto: reutiliza la nota activa sin duplicar ni recargar", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      return {
        imported: [
          {
            original_path: "/home/user/Documents/lyra/activa.txt",
            file_name: "activa.txt",
            size: 50,
            is_internal: true,
          },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  // Simular nota activa en el editor
  fileStore.getState().setSelectedFile({ name: "activa.txt", content: "Contenido modificado en memoria" });
  const generationBefore = fileStore.getState().selectionGeneration;

  const ok = await handleExternalFileImport(["/home/user/Documents/lyra/activa.txt"]);
  assert.equal(ok, true);

  // No debe re-ejecutar setSelectedFile (la generación no cambia)
  assert.equal(fileStore.getState().selectionGeneration, generationBefore);
  assert.equal(fileStore.getState().selectedFile.name, "activa.txt");
  assert.equal(fileStore.getState().selectedFile.content, "Contenido modificado en memoria");
  assert.equal(navigatedTo, "/file");
});

test("13. handleExternalFileImport con archivo externo: crea copia y notifica éxito", async () => {
  setupMockEnvironment();
  useToastStore.getState().clearToasts();

  let navigatedTo = "";
  registerNavigator(path => {
    navigatedTo = path;
  });

  const mockInvoke = async (cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "import_external_files") {
      return {
        imported: [
          {
            original_path: "/home/user/Downloads/externo.md",
            file_name: "externo.md",
            size: 200,
            is_internal: false,
          },
        ],
        errors: [],
      };
    }
    if (cmd === "plugin:fs|read_text_file") return new TextEncoder().encode("contenido");
    if (cmd.startsWith("plugin:path|")) return "lyra/nota.txt";
    return null;
  };
  (globalThis as unknown as { window: { __TAURI_INTERNALS__: unknown } }).window.__TAURI_INTERNALS__ = {
    invoke: mockInvoke,
  };

  const ok = await handleExternalFileImport(["/home/user/Downloads/externo.md"]);
  assert.equal(ok, true);

  assert.equal(fileStore.getState().selectedFile.name, "externo.md");
  assert.equal(navigatedTo, "/file");

  // Notificación de éxito para archivo externo
  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.some(t => t.type === "success" && t.msg.includes("externo")), true);
});
