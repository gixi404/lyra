import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";
import { configStore } from "../src/store/configStore.ts";

interface PendingMove {
  sourcePath: string;
  destinationPath: string;
  isFolder: boolean;
  phase: "prepared" | "physical" | "awaitingFrontend" | "aborted";
  notes: Array<{ oldPath: string; newPath: string }>;
}

interface InvokeArgs {
  sourcePath?: string;
  destinationPath?: string;
  expectedNotes?: string[];
  paths?: string[];
  path?: string;
  draftId?: string;
  payloadJson?: string;
}

function makeWindow(opts?: { failPrefsWrite?: boolean; pendingMove?: PendingMove | null }) {
  const local = new Map<string, string>();
  const disk = new Map<string, string>();
  let failPrefsWrite = opts?.failPrefsWrite ?? false;
  let pendingMove: PendingMove | null = opts?.pendingMove ?? null;
  let ackCalls = 0;

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
      invoke: async (cmd: string, args: InvokeArgs, options?: { headers?: Record<string, string> }) => {
        switch (cmd) {
          case "plugin:path|join": return (args.paths ?? []).join("/");
          case "plugin:fs|exists": return disk.has(args.path ?? "");
          case "plugin:fs|mkdir": return undefined;
          case "plugin:fs|read_text_file": {
            const content = disk.get(args.path ?? "");
            if (content === undefined) throw new Error("not found");
            return new TextEncoder().encode(content);
          }
          case "plugin:fs|write_text_file": {
            const path = decodeURIComponent(options?.headers?.path ?? "");
            if (path.endsWith(".preferences.json") && failPrefsWrite) throw new Error("disk full (simulado)");
            disk.set(path, new TextDecoder().decode(args as unknown as Uint8Array));
            return undefined;
          }
          case "flush_editor_drafts": return undefined;
          case "read_draft_file": return null;
          case "save_draft_file":
          case "delete_draft_file": return undefined;
          case "move_folder_local":
          case "move_note_local": {
            const changes = cmd === "move_note_local"
              ? [{ oldPath: args.sourcePath ?? "", newPath: args.destinationPath ?? "" }]
              : (args.expectedNotes ?? []).map(o => ({ oldPath: o, newPath: o.replace(args.sourcePath ?? "", args.destinationPath ?? "") }));
            pendingMove = { sourcePath: args.sourcePath ?? "", destinationPath: args.destinationPath ?? "", isFolder: cmd === "move_folder_local", phase: "awaitingFrontend", notes: changes };
            return changes;
          }
          case "local_move_status": return pendingMove ? "pending" : "notMoved";
          case "pending_local_move": return pendingMove;
          case "acknowledge_local_move": ackCalls++; pendingMove = null; return undefined;
          default: return undefined;
        }
      },
    },
  };
  return { local, disk, setFailPrefsWrite: (v: boolean) => { failPrefsWrite = v; }, getAckCalls: () => ackCalls, getPendingMove: () => pendingMove };
}

function reset() {
  fileStore.setState({ files: [], folders: [], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [], folderListingWarnings: [], folderArchiveError: null, folderArchiveLoaded: true, retainedExits: [], renderedOrder: { active: [], paper: [] }, deletingFiles: [], exitingFiles: [], isEmptyingArchived: false });
  configStore.setState({ prefTick: 0 });
}

test("folderOrder: carpeta → otra carpeta (primer nivel) mueve al final destino y conserva interno/otros", async () => {
  const h = makeWindow(); reset();
  fileStore.setState({ files: [], folders: ["A", "A/X", "A/X/Inner", "B", "C"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h.local.set("folderOrder", JSON.stringify({ "$top": ["A", "B", "C"], "A": ["A/X", "A/Z"], "A/X": ["A/X/Inner"], "B": ["B/Y"] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
  await moveLocalPath("folder", "A/X", "B/X");
  const fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["A"], ["A/Z"]);
  assert.deepEqual(fo["B"], ["B/Y", "B/X"]);
  assert.deepEqual(fo["B/X"], ["B/X/Inner"]);
  assert.deepEqual(fo["$top"], ["A", "B", "C"]);
});

test("folderOrder: primer nivel → subcarpeta y subcarpeta → primer nivel; destino sin orden previo", async () => {
  const h = makeWindow(); reset();
  fileStore.setState({ files: [], folders: ["A", "B"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h.local.set("folderOrder", JSON.stringify({ "$top": ["A", "B"], "B": [] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
  await moveLocalPath("folder", "A", "B/A");
  let fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["$top"], ["B"]);
  assert.deepEqual(fo["B"], ["B/A"]);

  // destino sin orden previo al mover a C (no existe lista C)
  reset();
  fileStore.setState({ files: [], folders: ["B", "B/A", "C"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h.local.set("folderOrder", JSON.stringify({ "$top": ["B", "C"], "B": ["B/A"] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  await moveLocalPath("folder", "B/A", "C/A");
  fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["B"], []);
  assert.deepEqual(fo["C"], ["C/A"]);

  // subcarpeta -> primer nivel
  reset();
  fileStore.setState({ files: [], folders: ["C", "C/A"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h.local.set("folderOrder", JSON.stringify({ "$top": ["C"], "C": ["C/A"] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  await moveLocalPath("folder", "C/A", "A");
  fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["C"], []);
  assert.deepEqual(fo["$top"], ["C", "A"]);
});

test("folderOrder: renombrado mismo dir conserva posición; conserva posición válida ya establecida en destino (idempotencia)", async () => {
  const h = makeWindow(); reset();
  // renombrado mismo dir (top-level) conserva posición
  fileStore.setState({ files: [], folders: ["A", "B", "C"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h.local.set("folderOrder", JSON.stringify({ "$top": ["A", "B", "C"] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  const { moveLocalPath, recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  await moveLocalPath("folder", "B", "B2");
  let fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["$top"], ["A", "B2", "C"]);

  // idempotencia/reintento con posición ya migrada correcta: no desplaza al final
  await recoverPendingLocalMove();
  fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["$top"], ["A", "B2", "C"]);

  // posición válida ya establecida en destino (ej. usuario reordenó tras migración): cubierta en test de recovery con pendingMove
});

test("folderOrder cross-dir: fallo persistencia y recovery posterior; recovery repetida sin duplicados ni desplazamiento", async () => {
  const h = makeWindow({ failPrefsWrite: true }); reset();
  fileStore.setState({ files: [], folders: ["A", "A/X", "B"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h.local.set("folderOrder", JSON.stringify({ "$top": ["A", "B"], "A": ["A/X"], "B": ["B/Y"] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  const { moveLocalPath, recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  await assert.rejects(moveLocalPath("folder", "A/X", "B/X"), /journal was kept for recovery/i);
  let fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["A"], []);
  assert.deepEqual(fo["B"], ["B/Y", "B/X"]);
  assert.equal(h.getAckCalls(), 0);

  h.setFailPrefsWrite(false);
  await recoverPendingLocalMove();
  assert.equal(h.getAckCalls(), 1);
  fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["B"], ["B/Y", "B/X"]);
  // repetida
  await recoverPendingLocalMove();
  await recoverPendingLocalMove();
  fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["B"], ["B/Y", "B/X"]);
  assert.equal(fo["B"].filter(x => x === "B/X").length, 1);
});

test("folderOrder: conserva posición válida ya establecida en destino en recovery idempotente (reinicio simulado)", async () => {
  // prefs ya migradas pero usuario reordenó destino después; journal pendiente awaitingFrontend
  const pendingMove: PendingMove = { sourcePath: "A/X", destinationPath: "B/X", isFolder: true, phase: "awaitingFrontend", notes: [] };
  const h = makeWindow({ pendingMove }); reset();
  fileStore.setState({ files: [], folders: ["A", "B", "B/X"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  // ya migrado y reordenado por usuario (X no al final)
  h.local.set("folderOrder", JSON.stringify({ "$top": ["A", "B"], "A": [], "B": ["B/X", "B/Y", "B/Z"] }));
  h.local.set("folderExpanded", "{}"); h.local.set("fileOrder", "{}"); h.local.set("paper", "[]");
  const { recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  await recoverPendingLocalMove();
  await recoverPendingLocalMove();
  const fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fo["B"], ["B/X", "B/Y", "B/Z"]); // conserva posición válida establecida
  assert.equal(h.getAckCalls(), 1);
});
