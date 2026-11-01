import test from "node:test";
import assert from "node:assert";
import {
  EditorSyncCoordinator,
  generateConflictFileName,
} from "../src/utils/editorSyncCoordinator.ts";

test("GD-007 Caso 1: Una escritura iniciada antes de gdrive:sync_finished no sobrescribe el contenido remoto", async () => {
  const diskState: Record<string, string> = {
    "nota.md": "Contenido Inicial",
  };

  let writeResolve: (() => void) | null = null;
  const slowWritePromise = new Promise<void>(resolve => {
    writeResolve = resolve;
  });

  let writesCount = 0;
  const coordinator = new EditorSyncCoordinator({
    fileName: "nota.md",
    initialContent: "Contenido Inicial",
    saveFileContent: async (name, content) => {
      writesCount++;
      if (content === "Contenido Viejo Local") {
        // Simular retraso de escritura I/O
        await slowWritePromise;
      }
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // 1. El usuario escribe texto local
  coordinator.handleUserContentChange("Contenido Viejo Local");

  // 2. Se encola la persistencia en disco antes de que termine el sync
  const pendingSave = coordinator.persistLatestToDisk();

  // 3. Mientras la escritura previa estaba en vuelo/cola, Google Drive sincroniza un cambio remoto
  diskState["nota.md"] = "Contenido Remoto Nuevo";

  // 4. Se dispara el evento de sincronización terminada
  const syncHandling = coordinator.handleSyncFinished({
    downloaded: ["nota.md"],
    deleted_remote: [],
  });

  // Liberar la escritura lenta previa
  writeResolve!();

  await pendingSave;
  await syncHandling;

  // ¡REGLA CRÍTICA!: La nota en disco debe tener la versión remota,
  // y la escritura vieja encolada previa al sync no debe haber pisado la versión remota
  assert.strictEqual(
    coordinator.getLatestContent(),
    "Contenido Remoto Nuevo",
    "El contenido en memoria debe ser el remoto recién sincronizado"
  );
  assert.strictEqual(
    diskState["nota.md"],
    "Contenido Remoto Nuevo",
    "El archivo en disco principal no debe ser pisado por la escritura vieja"
  );
});

test("GD-007 Caso 2: Si hay cambios locales pendientes, se crea la copia de conflicto y se conserva el texto local", async () => {
  const diskState: Record<string, string> = {
    "documento.txt": "Versión 1 de la nota",
  };

  let conflictCreatedName = "";
  let conflictContentSaved = "";

  const coordinator = new EditorSyncCoordinator({
    fileName: "documento.txt",
    initialContent: "Versión 1 de la nota",
    saveFileContent: async (name, content) => {
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
    onConflictCreated: (conflictFileName, edits) => {
      conflictCreatedName = conflictFileName;
      conflictContentSaved = edits;
    },
  });

  // El usuario tiene cambios locales activos en el editor que aún no se sincronizan
  const localEdits = "Edición local importantísima que el usuario no puede perder";
  coordinator.handleUserContentChange(localEdits);
  assert.strictEqual(coordinator.getIsDirty(), true);

  // Llega un cambio remoto a documento.txt desde Drive
  diskState["documento.txt"] = "Versión remota modificada desde otro dispositivo";

  await coordinator.handleSyncFinished({
    downloaded: ["documento.txt"],
    deleted_remote: [],
  });

  // 1. Debe haberse creado una copia de conflicto para la edición local
  assert.ok(conflictCreatedName.includes("edición local"));
  assert.ok(conflictCreatedName.endsWith(".txt"));
  assert.strictEqual(conflictContentSaved, localEdits);
  assert.strictEqual(diskState[conflictCreatedName], localEdits);

  // 2. La nota principal debe haberse actualizado con la versión remota
  assert.strictEqual(coordinator.getLatestContent(), "Versión remota modificada desde otro dispositivo");
  assert.strictEqual(diskState["documento.txt"], "Versión remota modificada desde otro dispositivo");

  // 3. El estado de dirty debe volver a false
  assert.strictEqual(coordinator.getIsDirty(), false);
});

test("GD-007 Caso 3: Al desmontar el editor durante o tras la sincronización, no se dispara un autosave obsoleto", async () => {
  const diskState: Record<string, string> = {
    "apuntes.md": "Texto Remoto en Disco",
  };

  let writesCount = 0;
  const coordinator = new EditorSyncCoordinator({
    fileName: "apuntes.md",
    initialContent: "Texto Inicial",
    saveFileContent: async (name, content) => {
      writesCount++;
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // La sincronización finaliza y actualiza el archivo
  await coordinator.handleSyncFinished({
    downloaded: ["apuntes.md"],
    deleted_remote: [],
  });

  assert.strictEqual(coordinator.getIsDirty(), false);
  const writesBeforeUnmount = writesCount;

  // Se desmonta el componente (e.g. usuario cambia de nota)
  await coordinator.handleUnmount();

  // ¡REGLA CRÍTICA!: No debe dispararse ninguna escritura espuria en el desmontaje
  assert.strictEqual(writesCount, writesBeforeUnmount, "No debe escribir en disco al desmontar si no está dirty");
  assert.strictEqual(diskState["apuntes.md"], "Texto Remoto en Disco");
});

test("GD-007 Caso 4: Los temporizadores y las escrituras en cola no provocan guardados duplicados ni pérdida de datos", async () => {
  const diskState: Record<string, string> = {
    "lista.txt": "A",
  };

  let saveCalls = 0;
  const coordinator = new EditorSyncCoordinator({
    fileName: "lista.txt",
    initialContent: "A",
    autosaveDebounceMs: 20,
    saveFileContent: async (name, content) => {
      saveCalls++;
      diskState[name] = content;
    },
    readFileContent: async name => diskState[name],
  });

  // Ráfaga rápida de escritura (simulando mecanografía)
  coordinator.handleUserContentChange("AB");
  coordinator.handleUserContentChange("ABC");
  coordinator.handleUserContentChange("ABCD");

  // Esperar a que el debounce se resuelva
  await new Promise(r => setTimeout(r, 50));
  await coordinator.flushAutosave();

  // Debe haberse guardado una sola vez con el snapshot final
  assert.strictEqual(saveCalls, 1);
  assert.strictEqual(diskState["lista.txt"], "ABCD");

  // Si se vuelve a solicitar guardar sin cambios, no debe generar escrituras duplicadas
  await coordinator.persistLatestToDisk();
  assert.strictEqual(saveCalls, 1, "No debe guardar de nuevo si no hay cambios reales");
});

test("GD-007 Caso 5: Formato del nombre del archivo de conflicto y extensiones", () => {
  const name1 = generateConflictFileName("mi_nota.md", "2026-10-27T22-00-15");
  assert.strictEqual(name1, "mi_nota (edición local 2026-10-27T22-00-15).md");

  const name2 = generateConflictFileName("archivo_sin_ext", "2026-10-27T22-00-15");
  assert.strictEqual(name2, "archivo_sin_ext (edición local 2026-10-27T22-00-15).txt");

  const name3 = generateConflictFileName("nota.doble.punto.md", "2026-10-27T22-00-15", 2);
  assert.strictEqual(name3, "nota.doble.punto (edición local 2026-10-27T22-00-15) (2).md");
});

test("GD-007 Paso 3.0: Colisiones consecutivas de copias de conflicto no se sobreescriben", async () => {
  const existingFiles = new Set<string>([
    "nota (edición local 2026-10-27T22-00-00).md",
    "nota (edición local 2026-10-27T22-00-00) (1).md",
  ]);

  const checkExists = async (name: string) => existingFiles.has(name);

  const { resolveUniqueConflictFileName } = await import("../src/utils/editorSyncCoordinator.ts");
  const uniqueName = await resolveUniqueConflictFileName(
    "nota.md",
    checkExists,
    "2026-10-27T22-00-00"
  );

  // Ya existían el base y el (1), por lo tanto debe elegir (2)
  assert.strictEqual(uniqueName, "nota (edición local 2026-10-27T22-00-00) (2).md");
});

test("GD-007 Paso 3.0: En handleSyncFinished, si ya existe una copia de conflicto, se preserva y se genera la siguiente", async () => {
  const diskState: Record<string, string> = {
    "apunte.md": "Remoto version 1",
  };

  let checkedTimes = 0;
  const coordinator = new EditorSyncCoordinator({
    fileName: "apunte.md",
    initialContent: "Remoto version 1",
    checkFileExists: async name => {
      checkedTimes++;
      if (checkedTimes === 1) {
        // Simular que el nombre base ya existe previamente en disco
        diskState[name] = "Copia previa existente";
        return true;
      }
      return name in diskState;
    },
    saveFileContent: async (name, content) => {
      diskState[name] = content;
    },
    readFileContent: async name => {
      if (name in diskState) return diskState[name];
      throw new Error("File not found");
    },
  });

  // Usuario hace cambios locales nuevos
  coordinator.handleUserContentChange("Nuevo cambio local en colisión temporal");

  // Llega evento de sincronización
  await coordinator.handleSyncFinished({
    downloaded: ["apunte.md"],
    deleted_remote: [],
  });

  // Debe haberse creado la copia incremental (1) sin sobrescribir la copia base
  const createdKeys = Object.keys(diskState).filter(k => k.includes("edición local"));
  assert.strictEqual(createdKeys.length, 2, "Deben coexistir ambas copias de conflicto");
  const baseKey = createdKeys.find(k => !k.includes("(1)"));
  const incKey = createdKeys.find(k => k.includes("(1)"));
  assert.ok(baseKey && incKey, "Debe existir la copia base y la copia incremental (1)");
  assert.strictEqual(diskState[baseKey!], "Copia previa existente");
  assert.strictEqual(diskState[incKey!], "Nuevo cambio local en colisión temporal");
});
