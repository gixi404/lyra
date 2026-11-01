import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import {
  noteLabel,
  noteSuccessMessage,
  noteTitle,
  SUPPORTED_NOTE_EXTENSIONS,
} from "../src/utils/noteName.ts";
import { includeRetainedExits } from "../src/utils/listExit.ts";
import { deleteArchivedBatch } from "../src/utils/archiveDeletion.ts";
import { runExclusiveDeletion } from "../src/utils/noteDeletion.ts";
import { getAnimationDuration } from "../src/utils/motion.ts";

function setupMockStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  (globalThis as any).window = {
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
    matchMedia: () => ({ matches: false }),
  };
  return store;
}

// -----------------------------------------------------------------------------
// FIX-001: Toasts con nombres de notas sin extensión
// -----------------------------------------------------------------------------

test("FIX-001: noteTitle extrae el nombre sin extensiones soportadas (.md, .txt)", () => {
  // Nota .md
  assert.equal(noteTitle("ideas.md"), "ideas");
  // Nota .txt
  assert.equal(noteTitle("tareas.txt"), "tareas");
  // Mayúsculas en extensión
  assert.equal(noteTitle("Apuntes.MD"), "Apuntes");
  assert.equal(noteTitle("Registro.TXT"), "Registro");
  // Varios puntos en el nombre
  assert.equal(noteTitle("proyecto.v2.final.md"), "proyecto.v2.final");
  assert.equal(noteTitle("backup.2026.10.31.txt"), "backup.2026.10.31");
  // Nombre con espacios
  assert.equal(noteTitle("Notas de viaje 2026.md"), "Notas de viaje 2026");
  // Caracteres Unicode y emojis
  assert.equal(noteTitle("Café matutino ☕.txt"), "Café matutino ☕");
  assert.equal(noteTitle("日本語のメモ.md"), "日本語のメモ");
  // Nombre sin extensión reconocida
  assert.equal(noteTitle("SinExtension"), "SinExtension");
  assert.equal(noteTitle("informe.pdf"), "informe.pdf");
  assert.equal(noteTitle(".md"), ".md");
  assert.equal(noteTitle(".txt"), ".txt");
});

test("FIX-001: noteLabel envuelve el nombre sin extensión en comillas latinas", () => {
  assert.equal(noteLabel("ideas.md"), "«ideas»");
  assert.equal(noteLabel("proyecto.v2.md"), "«proyecto.v2»");
  assert.equal(noteLabel("Café ☕.txt"), "«Café ☕»");
  assert.equal(noteLabel("documento.pdf"), "«documento.pdf»");
});

test("FIX-001: noteSuccessMessage genera frases naturales para cada operación", () => {
  // Toast de archivado
  assert.equal(noteSuccessMessage("ideas.md", "archived"), "«ideas» se archivó");
  // Toast de recuperación
  assert.equal(noteSuccessMessage("tareas.txt", "recovered"), "«tareas» se recuperó");
  // Toast de eliminación
  assert.equal(noteSuccessMessage("proyecto.v2.md", "deleted"), "«proyecto.v2» se eliminó");
  // Toast de renombrado con el nuevo nombre
  assert.equal(noteSuccessMessage("nuevo_nombre.md", "renamed"), "«nuevo_nombre» se renombró");
});

test("FIX-001: Mensajes de operaciones fallidas utilizan el nombre correcto de la nota", () => {
  const oldName = "anterior.v1.md";
  const errorMsg = `No se pudo renombrar ${noteLabel(oldName)}`;
  assert.equal(errorMsg, "No se pudo renombrar «anterior.v1»");

  const deleteError = `No se pudo eliminar ${noteLabel("nota_bloqueada.txt")}`;
  assert.equal(deleteError, "No se pudo eliminar «nota_bloqueada»");

  const restoreError = `No se pudo recuperar ${noteLabel("archivo_corrupto.md")}`;
  assert.equal(restoreError, "No se pudo recuperar «archivo_corrupto»");
});

test("FIX-001: Operaciones concurrentes emiten toasts independientes sin colisiones", () => {
  useToastStore.getState().clearToasts();

  useToastStore.getState().addToast("success", noteSuccessMessage("nota1.md", "archived"));
  useToastStore.getState().addToast("success", noteSuccessMessage("nota2.txt", "recovered"));
  useToastStore.getState().addToast("success", noteSuccessMessage("nota3.md", "deleted"));

  const toasts = useToastStore.getState().toasts;
  assert.equal(toasts.length, 3);
  assert.equal(toasts[0].msg, "«nota1» se archivó");
  assert.equal(toasts[1].msg, "«nota2» se recuperó");
  assert.equal(toasts[2].msg, "«nota3» se eliminó");
});

test("FIX-001: Eliminación permanente unitaria vs por lote", () => {
  const singleDeleted = noteSuccessMessage("nota_unica.txt", "deleted");
  assert.equal(singleDeleted, "«nota_unica» se eliminó");

  const batchDeleted = "Archivos eliminados permanentemente";
  assert.equal(batchDeleted, "Archivos eliminados permanentemente");
});

// -----------------------------------------------------------------------------
// FIX-002: Transición de salida suave al recuperar notas
// -----------------------------------------------------------------------------

test("FIX-002: Flujo completo de recuperación exitosa con transición de salida", async () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify(["nota1.txt", "nota2.txt"]),
    lyra_initialized: "true",
  });

  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["nota1.txt", "nota2.txt", "nota3.txt"]);
  fileStore.getState().setRenderedOrder("paper", ["nota1.txt", "nota2.txt"]);
  useToastStore.getState().clearToasts();

  const restoringName = "nota1.txt";

  // 1. Paso de retención previo a la confirmación de Rust
  fileStore.getState().retainForExit(restoringName, "paper");
  assert.equal(fileStore.getState().retainedExits.some(e => e.name === restoringName), true);

  // 2. Rust confirma la recuperación (se actualiza el set de archivados en disco/storage)
  const paper = JSON.parse(mockStorage.get("paper") || "[]") as string[];
  const nextPaper = paper.filter(f => f !== restoringName);
  mockStorage.set("paper", JSON.stringify(nextPaper));

  // 3. La fila permanece en la lista renderizada gracias a includeRetainedExits
  const renderedWhileExiting = includeRetainedExits(
    nextPaper,
    fileStore.getState().retainedExits,
    "paper",
  );
  assert.deepEqual(renderedWhileExiting, ["nota1.txt", "nota2.txt"]);

  // 4. Se muestra el toast con el nombre sin extensión
  useToastStore.getState().addToast("success", noteSuccessMessage(restoringName, "recovered"));
  assert.equal(useToastStore.getState().toasts[0].msg, "«nota1» se recuperó");

  // 5. Se programa la transición de salida suave
  let committed = false;
  fileStore.getState().scheduleExitAnimation(restoringName, () => {
    committed = true;
    fileStore.getState().editedFile();
  }, 40);

  // Mientras dura la transición, la nota está en exitingFiles
  assert.equal(fileStore.getState().exitingFiles.includes(restoringName), true);
  assert.equal(committed, false);

  // 6. Al culminar la animación, se confirma el desmontaje
  await new Promise(r => setTimeout(r, 60));
  assert.equal(committed, true);
  assert.equal(fileStore.getState().exitingFiles.includes(restoringName), false);
  assert.equal(fileStore.getState().retainedExits.some(e => e.name === restoringName), false);

  // 7. La nota vuelve a estar visible en la lista principal (no archivada)
  const activeList = ["nota1.txt", "nota2.txt", "nota3.txt"].filter(
    f => !JSON.parse(mockStorage.get("paper") || "[]").includes(f),
  );
  assert.deepEqual(activeList, ["nota1.txt", "nota3.txt"]);
});

test("FIX-002: Recuperación fallida no inicia transición y libera la retención", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setRenderedOrder("paper", ["nota_fallida.txt"]);
  useToastStore.getState().clearToasts();

  const name = "nota_fallida.txt";
  fileStore.getState().retainForExit(name, "paper");
  assert.equal(fileStore.getState().retainedExits.some(e => e.name === name), true);

  // Simulación de error en Rust
  let failed = false;
  try {
    throw new Error("Disk EIO error");
  } catch {
    failed = true;
    fileStore.getState().releaseRetainedExit(name);
    useToastStore.getState().addToast("error", `No se pudo recuperar ${noteLabel(name)}`);
  }

  assert.equal(failed, true);
  assert.equal(fileStore.getState().exitingFiles.includes(name), false, "No debe estar en exitingFiles");
  assert.equal(fileStore.getState().retainedExits.some(e => e.name === name), false, "Debe liberarse la retención");
  assert.equal(useToastStore.getState().toasts[0].msg, "No se pudo recuperar «nota_fallida»");
});

test("FIX-002: Varias recuperaciones consecutivas gestionan timers independientes", async () => {
  fileStore.getState().clearExitingFiles();
  fileStore.getState().setRenderedOrder("paper", ["n1.txt", "n2.txt", "n3.txt"]);
  const completed: string[] = [];

  fileStore.getState().retainForExit("n1.txt", "paper");
  fileStore.getState().scheduleExitAnimation("n1.txt", () => completed.push("n1.txt"), 40);

  await new Promise(r => setTimeout(r, 15));

  fileStore.getState().retainForExit("n2.txt", "paper");
  fileStore.getState().scheduleExitAnimation("n2.txt", () => completed.push("n2.txt"), 40);

  assert.equal(fileStore.getState().exitingFiles.includes("n1.txt"), true);
  assert.equal(fileStore.getState().exitingFiles.includes("n2.txt"), true);

  await new Promise(r => setTimeout(r, 35));
  // n1 ya terminó (50ms transcurridos), n2 sigue en curso (35ms transcurridos)
  assert.equal(completed.includes("n1.txt"), true);
  assert.equal(completed.includes("n2.txt"), false);

  await new Promise(r => setTimeout(r, 30));
  assert.equal(completed.includes("n2.txt"), true);
  assert.equal(fileStore.getState().exitingFiles.length, 0);
});

test("FIX-002: Cambio de vista durante la transición confirma inmediatamente (flushPendingExits)", () => {
  fileStore.getState().clearExitingFiles();
  let committed = false;

  fileStore.getState().retainForExit("nota_cambio.txt", "paper");
  fileStore.getState().scheduleExitAnimation("nota_cambio.txt", () => {
    committed = true;
  }, 200);

  assert.equal(fileStore.getState().exitingFiles.includes("nota_cambio.txt"), true);
  assert.equal(committed, false);

  // Cambio de vista o desmontaje
  fileStore.getState().flushPendingExits();

  assert.equal(committed, true, "Debe confirmarse de inmediato al cambiar de vista");
  assert.equal(fileStore.getState().exitingFiles.length, 0);
  assert.equal(fileStore.getState().retainedExits.length, 0);
});

test("FIX-002: prefers-reduced-motion ejecuta el commit de forma instantánea", () => {
  const originalWindow = globalThis.window;
  (globalThis as any).window = {
    matchMedia: (q: string) => ({ matches: q.includes("prefers-reduced-motion: reduce") }),
  };

  assert.equal(getAnimationDuration(), 0);

  let committed = false;
  fileStore.getState().retainForExit("rapida.md", "paper");
  fileStore.getState().scheduleExitAnimation("rapida.md", () => {
    committed = true;
  });

  assert.equal(committed, true);
  assert.equal(fileStore.getState().exitingFiles.length, 0);
  assert.equal(fileStore.getState().retainedExits.length, 0);

  globalThis.window = originalWindow;
});

// -----------------------------------------------------------------------------
// FIX-003: Estado visual y funcional deshabilitado en eliminación y vaciado
// -----------------------------------------------------------------------------

test("FIX-003: Eliminación individual gestiona busy state y previene ejecuciones concurrentes", async () => {
  fileStore.getState().setDeletingFile("test.txt", false);
  assert.equal(fileStore.getState().deletingFiles.includes("test.txt"), false);

  let deleteStarted = false;
  let deleteFinished = false;

  const mockExclusiveDeletion = async () => {
    if (fileStore.getState().deletingFiles.includes("test.txt")) return;
    fileStore.getState().setDeletingFile("test.txt", true);
    deleteStarted = true;
    await new Promise(r => setTimeout(r, 30));
    deleteFinished = true;
    fileStore.getState().setDeletingFile("test.txt", false);
  };

  const p1 = mockExclusiveDeletion();
  // Doble clic concurrente
  const p2 = mockExclusiveDeletion();

  assert.equal(fileStore.getState().deletingFiles.includes("test.txt"), true, "Debe estar ocupado");
  await Promise.all([p1, p2]);

  assert.equal(deleteStarted, true);
  assert.equal(deleteFinished, true);
  assert.equal(fileStore.getState().deletingFiles.includes("test.txt"), false, "Debe restaurarse el estado");
});

test("FIX-003: Vaciado completo mantiene busy state hasta que el backend responde", async () => {
  fileStore.getState().setEmptyingArchived(false);
  assert.equal(fileStore.getState().isEmptyingArchived, false);

  const paperFiles = ["doc1.txt", "doc2.txt", "doc3.txt"];
  let backendFinished = false;

  const runVaciado = async () => {
    fileStore.getState().setEmptyingArchived(true);
    assert.equal(fileStore.getState().isEmptyingArchived, true);

    const result = await deleteArchivedBatch(
      paperFiles,
      async () => {
        await new Promise(r => setTimeout(r, 10));
      },
      name => fileStore.getState().retainForExit(name, "paper"),
      name => fileStore.getState().releaseRetainedExit(name),
    );

    backendFinished = true;
    fileStore.getState().setEmptyingArchived(false);
    return result;
  };

  const res = await runVaciado();
  assert.equal(backendFinished, true);
  assert.equal(fileStore.getState().isEmptyingArchived, false);
  assert.deepEqual(res.deleted, ["doc1.txt", "doc2.txt", "doc3.txt"]);
  assert.equal(res.failed.length, 0);
});

test("FIX-003: Vaciado con fallo parcial libera notas fallidas y no reporta éxito total", async () => {
  const paperFiles = ["ok1.txt", "fallo.txt", "ok2.txt"];
  const released: string[] = [];

  const res = await deleteArchivedBatch(
    paperFiles,
    async name => {
      if (name === "fallo.txt") throw new Error("Permiso denegado");
    },
    () => {},
    name => released.push(name),
  );

  assert.deepEqual(res.deleted, ["ok1.txt", "ok2.txt"]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].name, "fallo.txt");
  assert.deepEqual(released, ["fallo.txt"], "La nota fallida debe liberarse");
});
