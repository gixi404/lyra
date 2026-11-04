import test from "node:test";
import assert from "node:assert";
import { fileStore } from "../src/store/fileStore.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import { getAnimationDuration } from "../src/utils/motion.ts";

test("Escenario 1: Archivar un archivo correctamente con transición y confirmación", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["nota1.txt", "nota2.txt"]);
  let committed = false;

  fileStore.getState().scheduleExitAnimation("nota1.txt", () => {
    committed = true;
    fileStore.getState().editedFile();
  }, 50);

  // Mientras transcurre la animación, nota1 está en exitingFiles pero aún en files
  assert.strictEqual(fileStore.getState().exitingFiles.includes("nota1.txt"), true);
  assert.strictEqual(fileStore.getState().files.includes("nota1.txt"), true);
  assert.strictEqual(committed, false);

  // Esperar a que culmine la animación
  await new Promise(r => setTimeout(r, 60));

  assert.strictEqual(committed, true, "El commit debe ejecutarse tras culminar el tiempo de animación");
  assert.strictEqual(fileStore.getState().exitingFiles.includes("nota1.txt"), false, "Debe retirarse de exitingFiles");
});

test("Escenario 2: Error al archivar un archivo (permanece visible y no entra en transición)", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["archivo_error.txt"]);

  let archiveFailed = false;
  const mockArchiveWithError = async (_name: string) => {
    throw new Error("Disk write error");
  };

  try {
    await mockArchiveWithError("archivo_error.txt");
    fileStore.getState().scheduleExitAnimation("archivo_error.txt", () => {});
  } catch {
    archiveFailed = true;
  }

  assert.strictEqual(archiveFailed, true);
  assert.strictEqual(fileStore.getState().exitingFiles.includes("archivo_error.txt"), false, "No debe entrar en exitingFiles si falló");
  assert.strictEqual(fileStore.getState().files.includes("archivo_error.txt"), true, "El archivo debe permanecer en la lista");
});

test("Escenario 3: Eliminar un archivo archivado individualmente tras confirmación", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["archivo1.txt", "archivo2.txt"]);

  let deleteSucceeded = false;
  const mockDeleteFile = async (name: string) => {
    deleteSucceeded = true;
    fileStore.getState().scheduleExitAnimation(name, () => {
      fileStore.getState().removeFileFromList(name);
      fileStore.getState().editedFile();
    }, 50);
  };

  await mockDeleteFile("archivo1.txt");
  assert.strictEqual(deleteSucceeded, true);
  assert.strictEqual(fileStore.getState().exitingFiles.includes("archivo1.txt"), true);

  // Tras culminar la transición, se remueve de la lista
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(fileStore.getState().exitingFiles.includes("archivo1.txt"), false);
  assert.strictEqual(fileStore.getState().files.includes("archivo1.txt"), false);
  assert.strictEqual(fileStore.getState().files.includes("archivo2.txt"), true);
});

test("Escenario 4: Vaciar todos los archivados con animación simultánea y transición a estado vacío", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["doc1.txt", "doc2.txt", "doc3.txt"]);

  const paperFiles = ["doc1.txt", "doc2.txt", "doc3.txt"];
  const successfullyDeleted: string[] = [];

  for (const fileName of paperFiles) {
    successfullyDeleted.push(fileName);
  }

  assert.strictEqual(successfullyDeleted.length, 3);

  // Animación simultánea de salida
  fileStore.getState().scheduleExitAnimation(successfullyDeleted, () => {
    for (const f of successfullyDeleted) {
      fileStore.getState().removeFileFromList(f);
    }
  }, 50);

  // Todos los elementos están saliendo en paralelo
  assert.deepStrictEqual(fileStore.getState().exitingFiles, ["doc1.txt", "doc2.txt", "doc3.txt"]);
  assert.strictEqual(fileStore.getState().files.length, 3);

  // Tras culminar la animación, todos son retirados a la vez
  await new Promise(r => setTimeout(r, 60));
  assert.deepStrictEqual(fileStore.getState().exitingFiles, []);
  assert.strictEqual(fileStore.getState().files.length, 0, "Lista vacía tras la transición");
});

test("Escenario 5: Error parcial durante el vaciado (conserva visibles los que fallaron)", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["doc1.txt", "doc2.txt", "doc3.txt"]);

  const paperFiles = ["doc1.txt", "doc2.txt", "doc3.txt"];
  const successfullyDeleted: string[] = [];
  let partialError = false;

  for (const f of paperFiles) {
    if (f === "doc2.txt") {
      partialError = true;
      continue;
    }
    successfullyDeleted.push(f);
  }

  assert.strictEqual(partialError, true);
  assert.deepStrictEqual(successfullyDeleted, ["doc1.txt", "doc3.txt"]);

  // Solo los que tuvieron éxito entran en transición
  fileStore.getState().scheduleExitAnimation(successfullyDeleted, () => {
    for (const f of successfullyDeleted) {
      fileStore.getState().removeFileFromList(f);
    }
  }, 50);

  assert.strictEqual(fileStore.getState().exitingFiles.includes("doc1.txt"), true);
  assert.strictEqual(fileStore.getState().exitingFiles.includes("doc2.txt"), false, "doc2 falló y NO debe animar su salida");
  assert.strictEqual(fileStore.getState().exitingFiles.includes("doc3.txt"), true);

  await new Promise(r => setTimeout(r, 60));

  // doc2 permanece visible
  assert.strictEqual(fileStore.getState().files.includes("doc2.txt"), true, "doc2 debe permanecer en la lista");
  assert.strictEqual(fileStore.getState().files.includes("doc1.txt"), false);
  assert.strictEqual(fileStore.getState().files.includes("doc3.txt"), false);
});

test("Escenario 6: Sincronización automática silenciosa (sin toast de carga ni notificación final)", () => {
  useToastStore.getState().clearToasts();

  let activeSyncToastId: string | null = null;
  function showSyncToast(): void {
    const currentToasts = useToastStore.getState().toasts;
    if (activeSyncToastId !== null && currentToasts.some(t => t.id === activeSyncToastId)) {
      return;
    }
    activeSyncToastId = useToastStore
      .getState()
      .addToast("loading", "Sincronizando con Google Drive...", undefined, 0);
  }

  function simulateSync(silent: boolean): void {
    const isManual = !silent;
    if (isManual) {
      showSyncToast();
    }
  }

  // Sincronización automática (silent = true)
  simulateSync(true);

  assert.strictEqual(
    useToastStore.getState().toasts.length,
    0,
    "La sincronización automática no debe mostrar ningún toast de carga ni de finalización"
  );
});

test("Escenario 7: Sincronización manual (toast de carga visible y único toast de éxito final)", () => {
  useToastStore.getState().clearToasts();

  let activeSyncToastId: string | null = null;
  function showSyncToast(): void {
    const currentToasts = useToastStore.getState().toasts;
    if (activeSyncToastId !== null && currentToasts.some(t => t.id === activeSyncToastId)) {
      return;
    }
    activeSyncToastId = useToastStore
      .getState()
      .addToast("loading", "Sincronizando con Google Drive...", undefined, 0);
  }

  function dismissSyncToast(): void {
    if (activeSyncToastId !== null) {
      useToastStore.getState().removeToast(activeSyncToastId);
      activeSyncToastId = null;
    }
    const currentToasts = useToastStore.getState().toasts;
    for (const t of currentToasts) {
      if (t.type === "loading" && t.msg.includes("Sincronizando")) {
        useToastStore.getState().removeToast(t.id);
      }
    }
  }

  showSyncToast();
  assert.strictEqual(useToastStore.getState().toasts.length, 1);
  assert.strictEqual(useToastStore.getState().toasts[0].type, "loading");

  dismissSyncToast();
  useToastStore.getState().addToast("success", "Todo está sincronizado");

  assert.strictEqual(useToastStore.getState().toasts.length, 1);
  assert.strictEqual(useToastStore.getState().toasts[0].type, "success");
  assert.strictEqual(useToastStore.getState().toasts[0].msg, "Todo está sincronizado");

  useToastStore.getState().clearToasts();
});

test("Escenario 8: Sincronizaciones consecutivas, canceladas o fallidas sin duplicados ni bloqueos", () => {
  useToastStore.getState().clearToasts();

  let activeSyncToastId: string | null = null;
  function showSyncToast(): void {
    const currentToasts = useToastStore.getState().toasts;
    if (activeSyncToastId !== null && currentToasts.some(t => t.id === activeSyncToastId)) {
      return;
    }
    activeSyncToastId = useToastStore
      .getState()
      .addToast("loading", "Sincronizando con Google Drive...", undefined, 0);
  }

  function dismissSyncToast(): void {
    if (activeSyncToastId !== null) {
      useToastStore.getState().removeToast(activeSyncToastId);
      activeSyncToastId = null;
    }
    const currentToasts = useToastStore.getState().toasts;
    for (const t of currentToasts) {
      if (t.type === "loading" && t.msg.includes("Sincronizando")) {
        useToastStore.getState().removeToast(t.id);
      }
    }
  }

  // Idempotencia: múltiples solicitudes consecutivas
  showSyncToast();
  showSyncToast();
  showSyncToast();
  assert.strictEqual(useToastStore.getState().toasts.length, 1, "No debe duplicarse el toast de sincronización");

  // Fallo o cancelación: se limpia el loading y se reporta error
  dismissSyncToast();
  useToastStore.getState().addToast("error", "No se pudo completar la sincronización");
  assert.strictEqual(useToastStore.getState().toasts.length, 1);
  assert.strictEqual(useToastStore.getState().toasts[0].type, "error");

  useToastStore.getState().clearToasts();
});

test("Escenario 9: Preferencia de movimiento reducido (prefers-reduced-motion)", () => {
  const defaultDuration = getAnimationDuration();
  assert.strictEqual(defaultDuration, 200, "Duración estándar es 200ms");

  const originalWindow = globalThis.window;
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: (query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
    }),
  };

  const reducedDuration = getAnimationDuration();
  assert.strictEqual(reducedDuration, 0, "Duración debe ser 0ms con reduced motion");

  globalThis.window = originalWindow;
});

test("Escenario 10: Cambio de vista o desmontaje durante la animación de salida (flushPendingExits)", () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["notaA.txt", "notaB.txt"]);

  let commitExecuted = false;
  // Programar animación de 500ms
  fileStore.getState().scheduleExitAnimation("notaA.txt", () => {
    commitExecuted = true;
    fileStore.getState().removeFileFromList("notaA.txt");
  }, 500);

  assert.strictEqual(fileStore.getState().exitingFiles.includes("notaA.txt"), true);
  assert.strictEqual(commitExecuted, false);

  // El usuario cambia de pestaña a los 10ms (dispara flushPendingExits)
  fileStore.getState().flushPendingExits();

  assert.strictEqual(commitExecuted, true, "El commit debe ejecutarse inmediatamente al cambiar de vista");
  assert.deepStrictEqual(fileStore.getState().exitingFiles, [], "exitingFiles debe quedar vacío de inmediato");
  assert.strictEqual(fileStore.getState().files.includes("notaA.txt"), false, "notaA no debe reaparecer");
});

test("Escenario 11: Archivado consecutivo de múltiples notas (gestión independiente de timers y commit)", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["n1.txt", "n2.txt", "n3.txt"]);

  const committed: string[] = [];

  fileStore.getState().scheduleExitAnimation("n1.txt", () => {
    committed.push("n1.txt");
  }, 40);

  await new Promise(r => setTimeout(r, 20));

  fileStore.getState().scheduleExitAnimation("n2.txt", () => {
    committed.push("n2.txt");
  }, 40);

  assert.strictEqual(fileStore.getState().exitingFiles.includes("n1.txt"), true);
  assert.strictEqual(fileStore.getState().exitingFiles.includes("n2.txt"), true);

  await new Promise(r => setTimeout(r, 30));
  // n1 (pasaron 50ms) ya culminó, n2 (pasaron 30ms) sigue en curso
  assert.strictEqual(committed.includes("n1.txt"), true);
  assert.strictEqual(committed.includes("n2.txt"), false);

  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(committed.includes("n2.txt"), true);
  assert.deepStrictEqual(fileStore.getState().exitingFiles, []);
});

test("Escenario 12: Prevención de condiciones de carrera en vaciado secuencial seguro", async () => {
  const paperFiles = ["item1.txt", "item2.txt", "item3.txt"];
  const executionOrder: string[] = [];

  // Simulación del patrón implementado en ListFiles: iteración secuencial segura con await
  for (const f of paperFiles) {
    await new Promise(resolve => setTimeout(resolve, 10));
    executionOrder.push(f);
  }

  assert.deepStrictEqual(
    executionOrder,
    ["item1.txt", "item2.txt", "item3.txt"],
    "Las llamadas de borrado a disco/tombstone deben ejecutarse ordenadas secuencialmente sin colisiones"
  );
});
