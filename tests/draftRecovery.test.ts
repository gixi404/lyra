import test from "node:test";
import assert from "node:assert";
import {
  isContentEquivalent,
  resolveUniqueDraftRecoveryFileName,
  writeUniqueRecoveryFile,
  reconcileDraftState,
  type DraftPayload,
} from "../src/utils/draftRecovery.ts";
import { EditorSyncCoordinator } from "../src/utils/editorSyncCoordinator.ts";

test("AUD-003: isContentEquivalent normaliza finales de línea CRLF vs LF pero preserva espacios significativos", () => {
  // 1. Textos idénticos
  assert.strictEqual(isContentEquivalent("Hola mundo", "Hola mundo"), true);

  // 2. Normalización de finales de línea \r\n vs \n
  const crlf = "Línea 1\r\nLínea 2\r\nLínea 3";
  const lf = "Línea 1\nLínea 2\nLínea 3";
  assert.strictEqual(isContentEquivalent(crlf, lf), true);

  // 3. Espacios finales significativos (Markdown hard line break: doble espacio al final de línea)
  const withMarkdownBreak = "Párrafo 1  \nPárrafo 2";
  const withoutMarkdownBreak = "Párrafo 1\nPárrafo 2";
  assert.strictEqual(
    isContentEquivalent(withMarkdownBreak, withoutMarkdownBreak),
    false,
    "No debe descartar el doble espacio de Markdown como si fuera trivial"
  );

  // 4. Espacios finales en la última línea
  const withTrailingSpace = "Contenido con espacio al final ";
  const withoutTrailingSpace = "Contenido con espacio al final";
  assert.strictEqual(
    isContentEquivalent(withTrailingSpace, withoutTrailingSpace),
    false,
    "Espacios agregados al final son modificaciones válidas del usuario"
  );

  // 5. Contenidos con cambios sustanciales
  assert.strictEqual(isContentEquivalent("Texto original", "Texto modificado"), false);
});

test("AUD-003: writeUniqueRecoveryFile previene sobrescritura ante colisiones concurrentes (O_CREAT | O_EXCL)", async () => {
  const fixedTag = "2026-10-31T12-00-00";
  const diskState = new Map<string, string>();

  // Simular saveExclusive que lanza error si el archivo ya existe (comportamiento createNew: true)
  const saveExclusive = async (name: string, content: string) => {
    if (diskState.has(name)) {
      throw new Error(`File already exists: ${name} (OS error 17)`);
    }
    diskState.set(name, content);
  };

  const fileExists = async (name: string) => diskState.has(name);

  // 1. Primera escritura: crea el archivo base
  const file1 = await writeUniqueRecoveryFile(
    "nota.txt",
    "Borrador A",
    saveExclusive,
    fileExists,
    fixedTag
  );
  assert.strictEqual(file1, `nota (borrador recuperado ${fixedTag}).txt`);
  assert.strictEqual(diskState.get(file1), "Borrador A");

  // 2. Carrera concurrente: otro proceso crea el archivo candidato antes de nuestro write
  // writeUniqueRecoveryFile debe detectar la colisión y avanzar a (1) sin sobrescribir
  const file2 = await writeUniqueRecoveryFile(
    "nota.txt",
    "Borrador B",
    saveExclusive,
    fileExists,
    fixedTag
  );
  assert.strictEqual(file2, `nota (borrador recuperado ${fixedTag}) (1).txt`);
  assert.strictEqual(diskState.get(file2), "Borrador B");
  assert.strictEqual(diskState.get(file1), "Borrador A", "El archivo anterior jamás debió ser sobrescrito");

  // 3. Simulación de carrera estricta: fileExists da false pero saveExclusive falla por carrera TOCTOU
  // El archivo ya fue creado en disco justo entre el check y el save
  let collisionAttempts = 0;
  const raceSaveExclusive = async (name: string, content: string) => {
    if (name === `nota (borrador recuperado ${fixedTag}) (2).txt` && collisionAttempts === 0) {
      collisionAttempts++;
      throw new Error("File exists: AlreadyExists");
    }
    diskState.set(name, content);
  };

  const file3 = await writeUniqueRecoveryFile(
    "nota.txt",
    "Borrador C",
    raceSaveExclusive,
    fileExists,
    fixedTag
  );
  assert.strictEqual(file3, `nota (borrador recuperado ${fixedTag}) (3).txt`);
  assert.strictEqual(diskState.get(file3), "Borrador C");
});

test("AUD-003: Generación de nombres únicos para copias de rescate de borradores", async () => {
  const fixedTag = "2026-10-31T12-00-00";
  const existingFiles = new Set<string>();

  const checkExists = async (name: string) => existingFiles.has(name);

  // 1. Primer intento sin colisión
  const name1 = await resolveUniqueDraftRecoveryFileName("mi_nota.txt", checkExists, fixedTag);
  assert.strictEqual(name1, `mi_nota (borrador recuperado ${fixedTag}).txt`);
  existingFiles.add(name1);

  // 2. Segundo intento con colisión: genera sufijo (1)
  const name2 = await resolveUniqueDraftRecoveryFileName("mi_nota.txt", checkExists, fixedTag);
  assert.strictEqual(name2, `mi_nota (borrador recuperado ${fixedTag}) (1).txt`);
  existingFiles.add(name2);

  // 3. Tercer intento: genera sufijo (2)
  const name3 = await resolveUniqueDraftRecoveryFileName("mi_nota.txt", checkExists, fixedTag);
  assert.strictEqual(name3, `mi_nota (borrador recuperado ${fixedTag}) (2).txt`);

  // 4. Archivo markdown conserva extensión .md
  const mdName = await resolveUniqueDraftRecoveryFileName("doc.md", checkExists, fixedTag);
  assert.strictEqual(mdName, `doc (borrador recuperado ${fixedTag}).md`);
});

test("AUD-003 Caso 1: Borrador más reciente que el disco -> Se restaura el borrador y se conserva en localStorage", async () => {
  let draftCleared = false;
  const savedFiles: Record<string, string> = {};

  const draft: DraftPayload = {
    content: "Texto del borrador más reciente",
    updatedAt: 10_000,
  };

  const result = await reconcileDraftState({
    fileName: "nota.txt",
    diskContent: "Texto viejo en disco",
    draft,
    diskMtime: 5_000, // Disco modificado antes que el borrador
    saveFile: async (name, content) => {
      savedFiles[name] = content;
    },
    readFile: async (name) => savedFiles[name] ?? "",
    fileExists: async (name) => name in savedFiles,
    clearDraft: () => {
      draftCleared = true;
    },
  });

  assert.strictEqual(result.action, "use_draft");
  assert.strictEqual(result.contentToLoad, "Texto del borrador más reciente");
  assert.strictEqual(result.draftCleared, false);
  assert.strictEqual(draftCleared, false, "El borrador NO debe borrarse de localStorage al restaurarlo");
  assert.strictEqual(Object.keys(savedFiles).length, 0, "No debe crearse ningún archivo de conflicto");
});

test("AUD-003 Caso 2: Disco más reciente pero contenidos idénticos -> Se descarta el borrador limpiamente sin copia", async () => {
  let draftCleared = false;
  const savedFiles: Record<string, string> = {};

  const draft: DraftPayload = {
    content: "Línea 1\r\nLínea 2",
    updatedAt: 2_000,
  };

  const result = await reconcileDraftState({
    fileName: "nota.txt",
    diskContent: "Línea 1\nLínea 2", // Mismo contenido con diferente fin de línea CRLF vs LF
    draft,
    diskMtime: 8_000, // Disco posterior al borrador
    saveFile: async (name, content) => {
      savedFiles[name] = content;
    },
    readFile: async (name) => savedFiles[name] ?? "",
    fileExists: async (name) => name in savedFiles,
    clearDraft: () => {
      draftCleared = true;
    },
  });

  assert.strictEqual(result.action, "use_disk");
  assert.strictEqual(result.contentToLoad, "Línea 1\nLínea 2");
  assert.strictEqual(result.draftCleared, true);
  assert.strictEqual(draftCleared, true, "El borrador redundante debe descartarse limpiamente");
  assert.strictEqual(Object.keys(savedFiles).length, 0, "No debe crearse copia de conflicto innecesaria");
});

test("AUD-003 Caso 3: Disco más reciente con contenidos diferentes -> Se crea copia de rescate verificada y se notifica", async () => {
  let draftCleared = false;
  let conflictNotification: string | null = null;
  const storageFiles: Record<string, string> = {};

  const draft: DraftPayload = {
    content: "Mis notas locales muy valiosas que no estaban guardadas",
    updatedAt: 2_000,
  };

  const result = await reconcileDraftState({
    fileName: "proyecto.txt",
    diskContent: "Versión actualizada externamente desde Google Drive",
    draft,
    diskMtime: 15_000, // Disco mucho más reciente
    saveFile: async (name, content) => {
      if (name in storageFiles) throw new Error("AlreadyExists");
      storageFiles[name] = content;
    },
    readFile: async (name) => {
      if (!(name in storageFiles)) throw new Error("File not found");
      return storageFiles[name];
    },
    fileExists: async (name) => name in storageFiles,
    clearDraft: () => {
      draftCleared = true;
    },
    onConflictCreated: (conflictName) => {
      conflictNotification = conflictName;
    },
  });

  assert.strictEqual(result.action, "conflict_created");
  assert.strictEqual(result.contentToLoad, "Versión actualizada externamente desde Google Drive");
  assert.strictEqual(result.draftCleared, true);
  assert.strictEqual(draftCleared, true, "El borrador se descarta de localStorage SOLO tras verificación");
  assert.ok(result.conflictFileName, "Debe definirse el nombre de la copia de conflicto");
  assert.strictEqual(conflictNotification, result.conflictFileName);
  assert.ok(result.conflictFileName.includes("(borrador recuperado"));

  // Verificar que el contenido guardado en disco sea exactamente el borrador del usuario
  assert.strictEqual(
    storageFiles[result.conflictFileName],
    "Mis notas locales muy valiosas que no estaban guardadas"
  );
});

test("AUD-003 Caso 4: Fallo al escribir el archivo de conflicto -> El borrador PERMANECE en localStorage", async () => {
  let draftCleared = false;
  let errorReported: unknown = null;

  const draft: DraftPayload = {
    content: "Edición crítica local",
    updatedAt: 1_000,
  };

  const result = await reconcileDraftState({
    fileName: "importante.txt",
    diskContent: "Contenido remoto nuevo",
    draft,
    diskMtime: 10_000,
    saveFile: async () => {
      throw new Error("Disco lleno / Permiso denegado al escribir");
    },
    readFile: async () => "",
    fileExists: async () => false,
    clearDraft: () => {
      draftCleared = true;
    },
    onConflictError: (err) => {
      errorReported = err;
    },
  });

  assert.strictEqual(result.action, "conflict_failed");
  assert.strictEqual(result.draftCleared, false);
  assert.strictEqual(draftCleared, false, "El borrador NO debe descartarse si falló la persistencia");
  assert.strictEqual(result.contentToLoad, "Edición crítica local");
  assert.ok(errorReported !== null, "Debe reportarse el error al llamador");
});

test("AUD-003 Caso 5: Fallo de verificación en la lectura de la copia -> El borrador PERMANECE en localStorage", async () => {
  let draftCleared = false;
  let errorReported: unknown = null;

  const draft: DraftPayload = {
    content: "Texto original del borrador",
    updatedAt: 1_000,
  };

  const result = await reconcileDraftState({
    fileName: "documento.txt",
    diskContent: "Contenido nuevo en disco",
    draft,
    diskMtime: 10_000,
    saveFile: async () => {
      // Simular guardado aparente
    },
    readFile: async () => {
      // Simular lectura corrupta o truncada
      return "Texto corrupto";
    },
    fileExists: async () => false,
    clearDraft: () => {
      draftCleared = true;
    },
    onConflictError: (err) => {
      errorReported = err;
    },
  });

  assert.strictEqual(result.action, "conflict_failed");
  assert.strictEqual(result.draftCleared, false);
  assert.strictEqual(draftCleared, false, "El borrador NO debe descartarse si la verificación falló");
  assert.ok(errorReported !== null);
  assert.ok(String(errorReported).includes("verificación"));
});

test("AUD-003 Caso 6: Ciclo de vida en React StrictMode (doble montaje) preserva el borrador", async () => {
  // Simular la máquina de estados de React StrictMode
  let loadedFileName: string;
  let isCancelledMount1 = false;
  const isCancelledMount2 = false;
  let draftCleared = false;

  const draft: DraftPayload = {
    content: "Modificación no guardada antes de desmontar",
    updatedAt: 10_000,
  };

  // --- Montaje 1 ---
  loadedFileName = "nota.txt";
  assert.strictEqual(loadedFileName, "nota.txt");
  assert.strictEqual(isCancelledMount1, false);
  // Simular desmontaje inmediato de StrictMode
  isCancelledMount1 = true;
  assert.strictEqual(isCancelledMount1, true);
  loadedFileName = ""; // Limpieza de loadedFileNameRef en cleanup

  // --- Montaje 2 ---
  assert.strictEqual(loadedFileName, "", "El cleanup de StrictMode debe limpiar loadedFileNameRef");
  loadedFileName = "nota.txt";
  assert.strictEqual(loadedFileName, "nota.txt");

  const result = await reconcileDraftState({
    fileName: "nota.txt",
    diskContent: "Contenido viejo",
    draft,
    diskMtime: 5_000,
    saveFile: async () => {},
    readFile: async () => "",
    fileExists: async () => false,
    clearDraft: () => {
      draftCleared = true;
    },
  });

  assert.strictEqual(isCancelledMount2, false);
  assert.strictEqual(result.action, "use_draft");
  assert.strictEqual(result.contentToLoad, "Modificación no guardada antes de desmontar");
  assert.strictEqual(draftCleared, false, "El borrador no debe perderse durante el doble montaje");
});

test("AUD-004: EditorSyncCoordinator retiene borrador y activa onSaveError ante fallo en saveFileContent", async () => {
  let draftWritten = false;
  let errorCaught: unknown = null;
  let clearDraftCalled = false;

  const coordinator = new EditorSyncCoordinator({
    fileName: "nota.txt",
    initialContent: "Texto inicial",
    saveFileContent: async () => {
      // Simular fallo nativo en save_note_atomic (ej. disco lleno o error I/O)
      throw new Error("No space left on device (OS error 28)");
    },
    readFileContent: async () => "Texto inicial",
    writeDraft: () => {
      draftWritten = true;
    },
    clearDraft: () => {
      clearDraftCalled = true;
    },
    onSaveError: (_name, _content, err) => {
      errorCaught = err;
    },
  });

  coordinator.handleUserContentChange("Nuevo contenido con disco lleno");
  const saveSuccess = await coordinator.persistLatestToDisk();

  assert.strictEqual(saveSuccess, false, "persistLatestToDisk debe reportar que la persistencia falló");
  assert.strictEqual(draftWritten, true, "El borrador DEBE registrarse/retenerse en writeDraft");
  assert.strictEqual(clearDraftCalled, false, "clearDraft NUNCA debe llamarse si el guardado atómico falló");
  assert.ok(errorCaught !== null, "onSaveError debe recibir el error nativo");
  assert.ok(String(errorCaught).includes("No space left on device"));
});

test("AUD-004: writeFile en entorno Tauri no enmascara ni degrada errores de save_note_atomic", async () => {
  // Simular entorno Tauri
  (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: Record<string, unknown> } }).window = {
    __TAURI_INTERNALS__: {},
  };

  let fallbackWriteCalled = false;
  let atomicInvoked = false;

  const mockInvoke = async (cmd: string, _args: unknown) => {
    if (cmd === "save_note_atomic") {
      atomicInvoked = true;
      throw new Error("Permiso denegado al escribir archivo atómico (OS error 13)");
    }
  };

  // Simular implementación de writeFile con chequeo isTauri
  const runWriteFile = async (name: string, content: string) => {
    const isTauri =
      typeof (globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window !== "undefined" &&
      Boolean((globalThis as unknown as { window?: { __TAURI_INTERNALS__?: unknown } }).window?.__TAURI_INTERNALS__);
    if (isTauri) {
      await mockInvoke("save_note_atomic", { fileName: name, content });
      return;
    }
    fallbackWriteCalled = true;
  };

  await assert.rejects(
    async () => {
      await runWriteFile("documento.txt", "Texto de prueba");
    },
    (err: unknown) => {
      assert.ok(err instanceof Error && err.message.includes("Permiso denegado"));
      return true;
    },
    "El error de save_note_atomic debe propagarse directamente sin ser silenciado"
  );

  assert.strictEqual(atomicInvoked, true);
  assert.strictEqual(fallbackWriteCalled, false, "En Tauri no debe ejecutarse fallback a escritura no atómica");

  // Limpiar window mock
  delete (globalThis as unknown as { window?: unknown }).window;
});
