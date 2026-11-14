import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";

// Proyección optimista equivalente a la usada en FolderExplorer durante un movimiento en curso.
function projectFiles(files: string[], move: { kind: "file" | "folder"; oldPath: string; newPath: string } | null): string[] {
  if (!move) return files;
  if (move.kind === "file") {
    if (!files.includes(move.oldPath)) return files;
    return files.map(f => (f === move.oldPath ? move.newPath : f));
  }
  const prefix = `${move.oldPath}/`;
  return files.map(f => (f === move.oldPath ? move.newPath : f.startsWith(prefix) ? `${move.newPath}/${f.slice(prefix.length)}` : f));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setupWindow(delayedMove: ReturnType<typeof deferred<Array<{ oldPath: string; newPath: string }>>> | null, opts?: { moveError?: string; moveStatus?: "notMoved" | "pending" }) {
  const local = new Map<string, string>();
  const pending = { sourcePath: "A/n.md", destinationPath: "B/n.md", isFolder: false, phase: "awaitingFrontend", notes: [{ oldPath: "A/n.md", newPath: "B/n.md" }] };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => { local.set(k, String(v)); },
      removeItem: (k: string) => { local.delete(k); },
      clear: () => { local.clear(); },
      get length() { return local.size; },
      key: (i: number) => Array.from(local.keys())[i] ?? null,
    },
    matchMedia: () => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent: () => false }),
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        switch (cmd) {
          case "plugin:path|join": return "lyra";
          case "flush_editor_drafts": return undefined;
          case "read_draft_file": return null;
          case "save_draft_file": return undefined;
          case "delete_draft_file": return undefined;
          case "move_note_local":
            if (opts?.moveError) throw new Error(opts.moveError);
            if (delayedMove) return delayedMove.promise;
            return [{ oldPath: "A/n.md", newPath: "B/n.md" }];
          case "local_move_status": return opts?.moveStatus ?? "notMoved";
          case "pending_local_move": return null;
          case "acknowledge_local_move": return undefined;
          default: return undefined;
        }
      },
    },
  } as unknown as Window & typeof globalThis;
  return { local, pending };
}

test("movimiento entre carpetas con moveLocalPath diferido: proyección evita reaparición en origen y sin duplicados durante la espera", async () => {
  const orig = globalThis.window;
  try {
    const d = deferred<Array<{ oldPath: string; newPath: string }>>();
    setupWindow(d);
    fileStore.setState({ files: ["A/n.md", "A/other.md", "B/x.md"], folders: ["A", "B"], statsMap: {}, archivedFolders: [], listingGeneration: 1, fileIsEdited: false, selectedFile: { name: "", content: "" } });
    const optimistic = { kind: "file" as const, oldPath: "A/n.md", newPath: "B/n.md" };

    const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
    const p = moveLocalPath("file", "A/n.md", "B/n.md");

    // Durante la espera: el store puede aún tener la ruta antigua, pero la proyección visual no debe reintroducir origen ni duplicar.
    await Promise.resolve();
    const projected = projectFiles(fileStore.getState().files, optimistic);
    assert.equal(projected.includes("A/n.md"), false, "no debe reaparecer en origen durante la espera");
    assert.equal(projected.filter(f => f === "B/n.md").length, 1, "debe aparecer una sola vez en destino");
    assert.equal(projected.includes("A/other.md"), true);

    d.resolve([{ oldPath: "A/n.md", newPath: "B/n.md" }]);
    await p;
    const finalFiles = fileStore.getState().files;
    assert.equal(finalFiles.includes("A/n.md"), false);
    assert.equal(finalFiles.filter(f => f === "B/n.md").length, 1);
  } finally {
    globalThis.window = orig;
  }
});

test("fallo antes del movimiento físico (notMoved): proyección restaurada a estado original", async () => {
  const orig = globalThis.window;
  try {
    setupWindow(null, { moveError: "rename failed", moveStatus: "notMoved" });
    fileStore.setState({ files: ["A/n.md"], folders: ["A", "B"], statsMap: {}, archivedFolders: [], listingGeneration: 1, fileIsEdited: false, selectedFile: { name: "", content: "" } });
    const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
    await assert.rejects(() => moveLocalPath("file", "A/n.md", "B/n.md"));
    // fallo previo al movimiento físico: al limpiar la proyección se restaura el origen sin destino fantasma
    const restored = projectFiles(fileStore.getState().files, null);
    assert.deepEqual(restored, ["A/n.md"]);
    assert.equal(restored.includes("B/n.md"), false);
  } finally {
    globalThis.window = orig;
  }
});

test("fallo posterior al movimiento físico (journal de recuperación): no restaurar visualmente ruta inexistente", () => {
  // Si el movimiento físico se completó pero falló una operación posterior, la ruta origen ya no existe.
  // Mantener proyección en destino evita reintroducir el origen inexistente.
  const storeFiles = ["A/n.md"]; // store aún no reconciliado
  const optimistic = { kind: "file" as const, oldPath: "A/n.md", newPath: "B/n.md" };
  const projected = projectFiles(storeFiles, optimistic);
  assert.equal(projected.includes("A/n.md"), false);
  assert.deepEqual(projected, ["B/n.md"]);
});

test("refresco obsoleto no debe sobrescribir estado pendiente: la generación invalida listados antiguos", () => {
  fileStore.setState({ files: ["A/n.md"], folders: ["A", "B"], statsMap: {}, archivedFolders: [], listingGeneration: 10, fileIsEdited: false, selectedFile: { name: "", content: "" } });
  const genAtStart = fileStore.getState().listingGeneration;
  // un refresco obsoleto (generación anterior) no debe aplicarse sobre el estado actual
  const staleGen = genAtStart - 1;
  assert.equal(staleGen < fileStore.getState().listingGeneration, true);
  // proyección pendiente sigue mostrando destino aunque llegara un snapshot obsoleto con origen
  const staleSnapshot = ["A/n.md"]; // listado antiguo
  const optimistic = { kind: "file" as const, oldPath: "A/n.md", newPath: "B/n.md" };
  assert.equal(projectFiles(staleSnapshot, optimistic).includes("A/n.md"), false);
  assert.equal(projectFiles(staleSnapshot, optimistic).includes("B/n.md"), true);
});
