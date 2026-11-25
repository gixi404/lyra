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

  const persists = [...src.matchAll(/persistOrderAfterPhysicalMove\(/g)].map(m => m.index ?? -1);
  assert.equal(persists.length, 1, "folder moves keep their separate order write");
  assert.equal(src.match(/moveLocalPath\("file", draggedPath, destinationPath, selectedOrder\)/g)?.length, 2,
    "both file drop paths pass the selected order into the move transaction");

  // Reordenamientos puros (mismo contenedor/padre) no persisten en disco de forma inmediata.
  // Archivo: reorden dentro del mismo contenedor (isSameContainer) aplica orden y retorna sin moveLocalPath/persist.
  const sameContainerIdx = src.indexOf("if (isSameContainer)");
  assert.ok(sameContainerIdx !== -1, "debe existir rama de reorden de archivo en mismo contenedor");
  const sameContainerBlockEnd = src.indexOf("const destinationPath = containerKey", sameContainerIdx);
  assert.ok(sameContainerBlockEnd > sameContainerIdx, "tras reorden en mismo contenedor debe continuar flujo de movimiento cross-container");
  const sameContainerBlock = src.slice(sameContainerIdx, sameContainerBlockEnd);
  assert.ok(!sameContainerBlock.includes("persistOrderAfterPhysicalMove"), "reorden de archivo no persiste inmediatamente");
  assert.ok(!sameContainerBlock.includes("moveLocalPath"), "reorden de archivo no mueve físicamente");
  assert.ok(sameContainerBlock.includes("applyFileOrder"), "reorden de archivo aplica orden en memoria");

  // Carpeta: reorden entre hermanos (folder-reorder) no persiste inmediatamente ni mueve físicamente.
  const folderReorderIdx = src.indexOf('if (target.type === "folder-reorder")');
  assert.ok(folderReorderIdx !== -1, "debe existir rama de reorden de carpeta entre hermanos");
  const folderReorderEnd = src.indexOf('if (target.type === "folder-into")', folderReorderIdx);
  assert.ok(folderReorderEnd > folderReorderIdx);
  const folderReorderBlock = src.slice(folderReorderIdx, folderReorderEnd);
  assert.ok(!folderReorderBlock.includes("persistOrderAfterPhysicalMove"), "reorden de carpeta no persiste inmediatamente");
  assert.ok(!folderReorderBlock.includes("moveEntry"), "reorden de carpeta no mueve físicamente");
  assert.ok(!folderReorderBlock.includes("moveLocalPath"), "reorden de carpeta no mueve físicamente");

  // Carpeta: mismo padre en folder-into es reorden lógico, no movimiento físico.
  const sameParentIdx = src.indexOf("if (sourceKey === targetKey)");
  assert.ok(sameParentIdx !== -1, "debe existir rama de carpeta en mismo padre (reorden lógico)");
  const sameParentEnd = src.indexOf("if (destinationPath === draggedPath)", sameParentIdx);
  assert.ok(sameParentEnd > sameParentIdx);
  const sameParentBlock = src.slice(sameParentIdx, sameParentEnd);
  assert.ok(!sameParentBlock.includes("persistOrderAfterPhysicalMove"), "reorden lógico de carpeta no persiste inmediatamente");
  assert.ok(!sameParentBlock.includes("moveEntry"), "reorden lógico de carpeta no mueve físicamente");

  // En movimientos físicos fallidos (antes de completarse) no debe persistirse inmediatamente.
  assert.ok(src.includes('await moveLocalPath("file"'), "movimiento físico de archivo ejecuta moveLocalPath");
  const fileCatchBlocks = [...src.matchAll(/await moveLocalPath\("file"[\s\S]*?\} catch \(error\) \{[\s\S]*?\} finally \{/g)].map(m => m[0]);
  assert.ok(fileCatchBlocks.length >= 1, "debe existir manejo de error en movimiento físico de archivo");
  for (const block of fileCatchBlocks) {
    const catchPart = block.slice(block.indexOf("} catch"));
    assert.ok(!catchPart.includes("persistOrderAfterPhysicalMove"), "fallo de movimiento físico de archivo no persiste inmediatamente");
  }
  // Carpeta: si el movimiento falla no se persiste (persist está tras confirmación)
  const folderMoveIdx = src.indexOf('if (!(await moveEntry("folder"');
  assert.ok(folderMoveIdx !== -1);
  const folderPersistIdx = src.indexOf('persistOrderAfterPhysicalMove("folderOrder"', folderMoveIdx);
  assert.ok(folderPersistIdx > folderMoveIdx, "persistencia de carpeta solo tras movimiento confirmado");
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
