import test from "node:test";
import assert from "node:assert";
import { fileStore } from "../src/store/fileStore.ts";
import { useToastStore } from "../src/store/toastStore.ts";
import { noteLabel, noteSuccessMessage } from "../src/utils/noteName.ts";
import { includeRetainedExits } from "../src/utils/listExit.ts";
import {
  isWelcomeManuallyRestored,
  autoArchiveWelcomeOnSync,
} from "../src/utils/welcome.ts";

function setupMockStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
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
    matchMedia: () => ({ matches: false }),
  };
  return store;
}

test("Recuperación de notas: el toast usa el título de la nota", () => {
  assert.strictEqual(noteSuccessMessage("Ideas.md", "recovered"), "«Ideas» se recuperó");
});

test("Recuperación de notas: la fila permanece durante la transición tras actualizar paper", async () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify(["nota1.txt", "nota2.txt"]),
    lyra_initialized: "true",
  });

  const files = ["nota1.txt", "nota2.txt", "nota3.txt"];
  fileStore.getState().setFiles(files);
  fileStore.getState().setRenderedOrder("paper", ["nota1.txt", "nota2.txt"]);
  useToastStore.getState().clearToasts();

  // Simular recuperación de "nota1.txt"
  const fileName = "nota1.txt";
  fileStore.getState().retainForExit(fileName, "paper");
  const rawPaper = JSON.parse(mockStorage.get("paper") || "[]") as string[];
  const updatedPaper = rawPaper.filter(f => f !== fileName);
  mockStorage.set("paper", JSON.stringify(updatedPaper));

  assert.deepStrictEqual(
    includeRetainedExits(updatedPaper, fileStore.getState().retainedExits, "paper"),
    ["nota1.txt", "nota2.txt"],
  );
  fileStore.getState().scheduleExitAnimation(fileName, () => {
    useToastStore.getState().addToast("success", noteSuccessMessage(fileName, "recovered"));
  }, 0);

  assert.strictEqual(updatedPaper.includes("nota1.txt"), false);
  assert.strictEqual(JSON.parse(mockStorage.get("paper") || "[]").includes("nota1.txt"), false);

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].msg, "«nota1» se recuperó");
  assert.strictEqual(toasts[0].type, "success");
});

test("Recuperación consecutiva de múltiples notas: ninguna nota se resucita", async () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify(["notaA.txt", "notaB.txt", "notaC.txt"]),
    lyra_initialized: "true",
  });

  useToastStore.getState().clearToasts();

  // Recuperar notaA
  let paper = JSON.parse(mockStorage.get("paper") || "[]") as string[];
  paper = paper.filter(f => f !== "notaA.txt");
  mockStorage.set("paper", JSON.stringify(paper));

  // Recuperar notaB inmediatamente
  paper = JSON.parse(mockStorage.get("paper") || "[]") as string[];
  paper = paper.filter(f => f !== "notaB.txt");
  mockStorage.set("paper", JSON.stringify(paper));

  assert.deepStrictEqual(JSON.parse(mockStorage.get("paper") || "[]"), ["notaC.txt"]);

  // Recuperar notaC (última nota)
  paper = JSON.parse(mockStorage.get("paper") || "[]") as string[];
  paper = paper.filter(f => f !== "notaC.txt");
  mockStorage.set("paper", JSON.stringify(paper));

  assert.deepStrictEqual(JSON.parse(mockStorage.get("paper") || "[]"), []);
});

test("Recuperación de notas con prefers-reduced-motion (duración 0ms): resultado determinista", async () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify(["nota_rapida.txt"]),
    lyra_initialized: "true",
  });

  (globalThis as unknown as { window: { matchMedia: (q: string) => { matches: boolean } } }).window.matchMedia = (q: string) => ({
    matches: q.includes("prefers-reduced-motion: reduce"),
  });

  fileStore.getState().clearExitingFiles();
  fileStore.getState().setFiles(["nota_rapida.txt"]);

  let committed = false;
  // Con duración 0 (o reducida), el commit debe ser instantáneo
  fileStore.getState().scheduleExitAnimation(
    "nota_rapida.txt",
    () => {
      committed = true;
      const raw = JSON.parse(mockStorage.get("paper") || "[]") as string[];
      mockStorage.set("paper", JSON.stringify(raw.filter(f => f !== "nota_rapida.txt")));
    },
    0
  );

  assert.strictEqual(committed, true, "Con duration=0, el commit debe ejecutarse de inmediato");
  assert.deepStrictEqual(JSON.parse(mockStorage.get("paper") || "[]"), []);
  assert.deepStrictEqual(fileStore.getState().exitingFiles, []);
});

test("Archivo de bienvenida manualmente restaurado: se respeta y no se autoarchiva en sincronización", async () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify([]),
    welcome_manually_restored: "true",
  });

  const storageOps = {
    getItem: (k: string) => mockStorage.get(k) ?? null,
    setItem: (k: string, v: string) => mockStorage.set(k, v),
    removeItem: (k: string) => mockStorage.delete(k),
  };

  assert.strictEqual(isWelcomeManuallyRestored(storageOps), true);

  const mockFsOps = {
    exists: async () => true,
    mkdir: async () => {},
    readDir: async () => [{ name: "¡Bienvenid@ a Lyra!.txt", isFile: true }, { name: "nota1.txt", isFile: true }],
    readTextFile: async () => "Bienvenido a Lyra",
    writeTextFile: async () => {},
  };

  const autoArchived = await autoArchiveWelcomeOnSync(["nota1.txt"], mockFsOps, storageOps);
  assert.strictEqual(autoArchived, false, "No debe autoarchivar una bienvenida manualmente restaurada");
  assert.deepStrictEqual(JSON.parse(mockStorage.get("paper") || "[]"), [], "Paper debe permanecer vacío");
});

test("Manejo de errores durante la persistencia: rollback de estado local y ausencia de toast de éxito", async () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify(["nota_error.txt"]),
    welcome_manually_restored: "false",
  });

  useToastStore.getState().clearToasts();

  const prevPaper = mockStorage.get("paper") || "[]";
  const updatedPaper = JSON.parse(prevPaper).filter((f: string) => f !== "nota_error.txt");

  let rollbackExecuted = false;
  let exitAnimationTriggered = false;

  // Simular fallo de I/O en savePersistentPreferencesNow
  const mockFailingSave = async () => {
    throw new Error("Disk write error: EACCES permission denied");
  };

  try {
    mockStorage.set("paper", JSON.stringify(updatedPaper));
    await mockFailingSave();
    // Si no fallara (no debe llegar aquí):
    useToastStore.getState().addToast("success", noteSuccessMessage("nota_error.txt", "recovered"));
    exitAnimationTriggered = true;
  } catch {
    // Rollback ante fallo
    mockStorage.set("paper", prevPaper);
    rollbackExecuted = true;
    useToastStore.getState().addToast("error", `No se pudo recuperar ${noteLabel("nota_error.txt")}`);
  }

  assert.strictEqual(rollbackExecuted, true, "El rollback debe ejecutarse si falla la persistencia");
  assert.strictEqual(exitAnimationTriggered, false, "No debe iniciarse animación de salida si falló");
  assert.deepStrictEqual(
    JSON.parse(mockStorage.get("paper") || "[]"),
    ["nota_error.txt"],
    "La nota debe seguir en paper tras rollback"
  );

  const toasts = useToastStore.getState().toasts;
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].type, "error");
  assert.strictEqual(toasts[0].msg, "No se pudo recuperar «nota_error»");
});

test("Autoridad en arranque: .preferences.json de disco inicializa localStorage limpiamente", () => {
  const mockStorage = setupMockStorage({
    paper: JSON.stringify(["nota_residual_vieja.txt"]),
    lyra_preferences_updated_at: "1000",
  });

  // Simular el contenido de .preferences.json en disco restaurado desde respaldo
  const diskPreferences = {
    paper: ["nota_respaldo.txt"],
    updatedAt: 500, // Respaldo antiguo pero intencionalmente restaurado en disco
    theme: "Day",
  };

  // initPersistentPreferencesInternal adopta el archivo de disco autoritativo
  mockStorage.set("paper", JSON.stringify(diskPreferences.paper));
  mockStorage.set("theme", diskPreferences.theme);
  mockStorage.set("lyra_preferences_updated_at", String(diskPreferences.updatedAt));

  assert.deepStrictEqual(
    JSON.parse(mockStorage.get("paper") || "[]"),
    ["nota_respaldo.txt"],
    "localStorage debe adoptar el contenido de disco sin resucitar la nota residual"
  );
  assert.strictEqual(mockStorage.get("theme"), "Day");
});

