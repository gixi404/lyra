import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { persistOrderAfterPhysicalMove } from "../src/utils/persistAfterPhysicalMove.ts";
import {
  savePersistentPreferencesNow,
  PERSISTENT_KEYS,
} from "../src/utils/persistentPreferences.ts";
import useStorage from "../src/hooks/useStorage.ts";
import { useToastStore } from "../src/store/toastStore.ts";

const PREFS_PATH = "lyra/.preferences.json";

function setup(initialDisk: Record<string, string> = {}, initialLocal: Record<string, string> = {}) {
  const disk = new Map<string, string>(Object.entries(initialDisk));
  const localStore = new Map<string, string>(Object.entries(initialLocal));
  let failWrite = false;
  let writeCount = 0;

  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => localStore.get(k) ?? null,
      setItem: (k: string, v: string) => { localStore.set(k, String(v)); },
      removeItem: (k: string) => { localStore.delete(k); },
      clear: () => { localStore.clear(); },
    },
    matchMedia: () => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent: () => false }),
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => {
        switch (cmd) {
          case "plugin:path|join":
            return (args as { paths: string[] }).paths.join("/");
          case "plugin:fs|exists":
            return disk.has((args as { path: string }).path);
          case "plugin:fs|mkdir":
            return undefined;
          case "plugin:fs|read_text_file": {
            const content = disk.get((args as { path: string }).path);
            if (content === undefined) throw new Error("not found");
            return new TextEncoder().encode(content);
          }
          case "plugin:fs|write_text_file": {
            if (failWrite) throw new Error("disk full (simulado)");
            const bytes = args as Uint8Array;
            const path = decodeURIComponent(options?.headers?.path ?? "");
            disk.set(path, new TextDecoder().decode(bytes));
            writeCount++;
            return undefined;
          }
          default:
            throw new Error(`unexpected command: ${cmd}`);
        }
      },
    },
  };

  useToastStore.getState().clearToasts?.();
  return {
    disk,
    localStore,
    readDisk: (p: string) => disk.get(p),
    writes: () => writeCount,
    setFailWrite: (v: boolean) => { failWrite = v; },
    localFile: () => localStore.get("fileOrder"),
  };
}

test("1. Movimiento confirmado seguido de persistencia inmediata (sin debounce)", async () => {
  const t = setup({}, {});
  const moved = { "": ["documento.md"], Proyectos: ["Proyectos/nota.md"] };

  const ok = await persistOrderAfterPhysicalMove("fileOrder", moved);

  assert.equal(ok, true);
  // La escritura en disco ocurre de forma síncrona dentro de la llamada,
  // sin esperar a ningún temporizador.
  assert.equal(t.writes(), 1);
  const diskPrefs = JSON.parse(t.readDisk(PREFS_PATH)!) as { fileOrder: string; updatedAt: number };
  assert.equal(diskPrefs.fileOrder, JSON.stringify(moved));
  assert.equal(t.localFile(), JSON.stringify(moved));
  assert.equal(PERSISTENT_KEYS.includes("fileOrder"), true);
});

test("2. Movimiento fallido: la persistencia inmediata NO se ejecuta y el orden queda intacto", () => {
  const explorerPath = new URL("../src/components/FolderExplorer.tsx", import.meta.url).pathname;
  const src = fs.readFileSync(explorerPath, "utf-8");

  const moveGuards = [...src.matchAll(/if \(!\(await moveEntry\(/g)].map(m => m.index ?? -1);
  const persists = [...src.matchAll(/persistOrderAfterPhysicalMove\(/g)].map(m => m.index ?? -1);
  assert.equal(moveGuards.length, 2, "debe haber dos ramas de movimiento físico (inside y cross-directory)");
  assert.equal(persists.length, 2, "la persistencia inmediata existe solo en esas dos ramas");
  for (const p of persists) {
    assert.ok(
      moveGuards.some(g => g < p),
      "cada persistencia inmediata está precedida por el guard del movimiento confirmado",
    );
  }

  // El reordenamiento puro (sin movimiento físico) no persiste en disco, solo localStorage
  const reorderStart = src.indexOf("// Reordenamiento puro");
  const crossDirStart = src.indexOf("// Movimiento entre carpetas", reorderStart);
  assert.ok(reorderStart !== -1 && crossDirStart !== -1);
  assert.ok(
    !src.slice(reorderStart, crossDirStart).includes("persistOrderAfterPhysicalMove"),
    "el reordenamiento puro NO persiste en disco de forma inmediata",
  );
});

test("3. Escritura debounced pendiente seguida de guardado inmediato: el guardado inmediato gana y cancela el debounce", async () => {
  const t = setup({}, {});
  const { setItem } = useStorage();

  // Un setItem genérico programa una escritura debounced (150 ms)
  setItem("fileOrder", JSON.stringify({ "": ["beta.md"] }));
  assert.equal(t.writes(), 0, "el debounce aún no ha escrito nada");

  // Guardado inmediato: escribe ya y cancela el temporizador pendiente
  await savePersistentPreferencesNow();
  assert.equal(t.writes(), 1);
  const diskPrefs = JSON.parse(t.readDisk(PREFS_PATH)!) as { fileOrder: string };
  assert.equal(diskPrefs.fileOrder, JSON.stringify({ "": ["beta.md"] }));

  // Si el debounce hubiera sobrevivido, se dispararía tras ~150 ms y añadiría otra escritura
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(t.writes(), 1, "el debounce pendiente fue cancelado y no sobrescribió nada");
});

test("4. Dos movimientos consecutivos: el disco refleja el estado final, sin interleaving ni pérdida", async () => {
  const t = setup({}, {});

  await persistOrderAfterPhysicalMove("fileOrder", { "": ["uno.md"] });
  await persistOrderAfterPhysicalMove("fileOrder", { "": ["dos.md"], "Proyectos": ["Proyectos/tres.md"] });

  const diskPrefs = JSON.parse(t.readDisk(PREFS_PATH)!) as { fileOrder: string };
  assert.equal(diskPrefs.fileOrder, JSON.stringify({ "": ["dos.md"], "Proyectos": ["Proyectos/tres.md"] }));
  assert.equal(t.localFile(), JSON.stringify({ "": ["dos.md"], "Proyectos": ["Proyectos/tres.md"] }));
});

test("5a. Error durante la persistencia: no lanza, avisa y permite reintentar con estado coherente", async () => {
  const t = setup({}, {});
  t.setFailWrite(true);

  const ok = await persistOrderAfterPhysicalMove("fileOrder", { "": ["x.md"] });

  assert.equal(ok, false);
  // localStorage se mantiene coherente (el movimiento ya ocurrió)
  assert.equal(t.localFile(), JSON.stringify({ "": ["x.md"] }));
  // No hay archivo en disco (la escritura falló), pero el estado no es ambiguo
  assert.equal(t.readDisk(PREFS_PATH), undefined);
  // Se notificó al usuario
  const toasts = useToastStore.getState().toasts;
  assert.ok(toasts.some(toast => toast.msg.includes("no se pudo guardar")));

  // Reintento con disco recuperado: se escribe el estado más reciente
  t.setFailWrite(false);
  const ok2 = await persistOrderAfterPhysicalMove("fileOrder", { "": ["x.md", "y.md"] });
  assert.equal(ok2, true);
  assert.match(t.readDisk(PREFS_PATH)!, /y\.md/);
});

test("5b. savePersistentPreferencesNow ante error: la promesa rechaza y el gestor sigue operativo", async () => {
  const t = setup({}, { fileOrder: '{"":["a.md"]}' });
  t.setFailWrite(true);

  await assert.rejects(savePersistentPreferencesNow(), /disk full/);

  // El gestor de escrituras se recupera (isWriting se libera) para la siguiente llamada
  t.setFailWrite(false);
  await savePersistentPreferencesNow();
  assert.match(t.readDisk(PREFS_PATH)!, /fileOrder/);
});
