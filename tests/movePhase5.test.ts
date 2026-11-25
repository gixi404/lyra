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
  destinationFileOrder?: string[];
}

interface InvokeArgs {
  sourcePath?: string;
  destinationPath?: string;
  expectedNotes?: string[];
  destinationFileOrder?: string[];
  paths?: string[];
  path?: string;
  draftId?: string;
  payloadJson?: string;
}

function makeWindow(opts?: {
  failPrefsWrite?: boolean;
  pendingMove?: PendingMove | null;
  moveResultFor?: (cmd: string, args: InvokeArgs) => Array<{ oldPath: string; newPath: string }>;
  readText?: (path: string) => string;
  drafts?: Record<string, string | null>;
}) {
  const local = new Map<string, string>();
  const disk = new Map<string, string>();
  const drafts = new Map<string, string | null>(Object.entries(opts?.drafts ?? {}));
  let failPrefsWrite = opts?.failPrefsWrite ?? false;
  let pendingMove: PendingMove | null = opts?.pendingMove ?? null;
  let ackCalls = 0;
  let acknowledgedFileOrder: string | undefined;
  let moveCalls = 0;

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
          case "plugin:path|join":
            return (args.paths ?? []).join("/");
          case "plugin:fs|exists":
            return disk.has(args.path ?? "");
          case "plugin:fs|mkdir":
            return undefined;
          case "plugin:fs|read_text_file": {
            if (opts?.readText) return new TextEncoder().encode(opts.readText(args.path ?? ""));
            const content = disk.get(args.path ?? "");
            if (content === undefined) return new TextEncoder().encode("");
            return new TextEncoder().encode(content);
          }
          case "plugin:fs|write_text_file": {
            const path = decodeURIComponent(options?.headers?.path ?? "");
            if (path.endsWith(".preferences.json")) {
              if (failPrefsWrite) throw new Error("disk full (simulado)");
            }
            const bytes = args as unknown as Uint8Array;
            disk.set(path, new TextDecoder().decode(bytes));
            return undefined;
          }
          case "flush_editor_drafts":
            return undefined;
          case "read_draft_file":
            return drafts.has(args.draftId ?? "") ? drafts.get(args.draftId ?? "") : null;
          case "save_draft_file":
            drafts.set(args.draftId ?? "", args.payloadJson ?? null);
            return undefined;
          case "delete_draft_file":
            drafts.delete(args.draftId ?? "");
            return undefined;
          case "move_folder_local":
          case "move_note_local": {
            moveCalls++;
            const changes = opts?.moveResultFor
              ? opts.moveResultFor(cmd, args)
              : cmd === "move_note_local"
                ? [{ oldPath: args.sourcePath ?? "", newPath: args.destinationPath ?? "" }]
                : (args.expectedNotes ?? []).map((o) => ({ oldPath: o, newPath: o.replace(args.sourcePath ?? "", args.destinationPath ?? "") }));
            pendingMove = {
              sourcePath: args.sourcePath ?? "",
              destinationPath: args.destinationPath ?? "",
              isFolder: cmd === "move_folder_local",
              phase: "awaitingFrontend",
              notes: changes.map((n) => ({ oldPath: n.oldPath, newPath: n.newPath })),
              destinationFileOrder: args.destinationFileOrder,
            };
            return changes;
          }
          case "local_move_status":
            return pendingMove ? "pending" : "notMoved";
          case "pending_local_move":
            return pendingMove;
          case "acknowledge_local_move":
            acknowledgedFileOrder = JSON.parse(disk.get("lyra/.preferences.json") ?? "{}").fileOrder;
            ackCalls++;
            pendingMove = null;
            return undefined;
          default:
            return undefined;
        }
      },
    },
  };
  return {
    local, disk, drafts,
    setFailPrefsWrite: (v: boolean) => { failPrefsWrite = v; },
    getAckCalls: () => ackCalls,
    getAcknowledgedFileOrder: () => acknowledgedFileOrder,
    getMoveCalls: () => moveCalls,
    getPendingMove: () => pendingMove,
  };
}

function resetStores() {
  fileStore.setState({
    files: [],
    folders: [],
    statsMap: {},
    selectedFile: { name: "", content: "" },
    folderListingWarnings: [],
    archivedFolders: [],
    folderArchiveError: null,
    folderArchiveLoaded: true,
    retainedExits: [],
    renderedOrder: { active: [], paper: [] },
    deletingFiles: [],
    exitingFiles: [],
    isEmptyingArchived: false,
  });
  configStore.setState({ prefTick: 0 });
}

test("moveLocalPath (nota, menú): mueve a otra carpeta, conserva orden manual al final, remapea store y refs; prefs no relacionadas intactas", async () => {
  const h = makeWindow();
  resetStores();
  fileStore.setState({
    files: ["A/n1.md", "A/n2.md", "B/m.md", "X/x.md"],
    folders: ["A", "B", "X"],
    statsMap: {
      "A/n1.md": { mtime: 1, birthtime: 1 },
      "A/n2.md": { mtime: 2, birthtime: 2 },
      "B/m.md": { mtime: 3, birthtime: 3 },
    },
    selectedFile: { name: "A/n1.md", content: "old" },
    archivedFolders: [],
  });
  h.local.set("fileOrder", JSON.stringify({ "A": ["A/n1.md", "A/n2.md"], "B": ["B/m.md"], "X": [] }));
  h.local.set("folderOrder", JSON.stringify({ "": ["A", "B", "X"] }));
  h.local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "A": true, "B": false, "X": false }));
  h.local.set("paper", JSON.stringify(["A/p.md", "X/q.md"]));
  h.local.set("A/n1.md-modified", "123");
  h.local.set("theme", "dark");

  const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
  await moveLocalPath("file", "A/n1.md", "B/n1.md");

  const s = fileStore.getState();
  assert.deepEqual([...s.files].sort(), ["A/n2.md", "B/m.md", "B/n1.md", "X/x.md"].sort());
  assert.ok(s.statsMap["B/n1.md"]);
  assert.equal(s.statsMap["A/n1.md"], undefined);
  assert.equal(s.selectedFile.name, "B/n1.md");
  assert.equal(s.archivedFolders.length, 0);

  const fileOrder = JSON.parse(h.local.get("fileOrder") ?? "{}") as Record<string, string[]>;
  assert.deepEqual(fileOrder["A"], ["A/n2.md"]);
  assert.deepEqual(fileOrder["B"], ["B/m.md", "B/n1.md"]);
  assert.deepEqual(fileOrder["X"], []);
  assert.deepEqual(JSON.parse(h.local.get("folderOrder") ?? "{}"), { "": ["A", "B", "X"] });
  assert.deepEqual(JSON.parse(h.local.get("paper") ?? "[]"), ["A/p.md", "X/q.md"]);
  assert.equal(h.local.get("B/n1.md-modified"), "123");
  assert.equal(h.local.get("A/n1.md-modified"), undefined);
  assert.equal(h.local.get("theme"), "dark");
  assert.equal(h.getAckCalls(), 1);
});

test("an ordered drop saves the selected position before acknowledging the move", async () => {
  const h = makeWindow();
  resetStores();
  const order = ["B/first.md", "B/x.md", "B/last.md"];
  h.local.set("fileOrder", JSON.stringify({ A: ["A/x.md"], B: ["B/first.md", "B/last.md"], C: ["C/other.md"] }));
  const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
  await moveLocalPath("file", "A/x.md", "B/x.md", order);
  assert.equal(h.getAckCalls(), 1);
  assert.deepEqual(JSON.parse(h.getAcknowledgedFileOrder() ?? "{}"), { A: [], B: order, C: ["C/other.md"] });
});

test("an ordered drop recovers its selected position after an interrupted preference write", async () => {
  const h = makeWindow({ failPrefsWrite: true });
  resetStores();
  const initial = { A: ["A/x.md"], B: ["B/first.md", "B/last.md"] };
  const selected = ["B/first.md", "B/x.md", "B/last.md"];
  h.local.set("fileOrder", JSON.stringify(initial));
  const { moveLocalPath, recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  await assert.rejects(moveLocalPath("file", "A/x.md", "B/x.md", selected), /journal was kept for recovery/i);
  assert.equal(h.getAckCalls(), 0);
  assert.deepEqual(h.getPendingMove()?.destinationFileOrder, selected);
  // Simulate reopening with the last successfully saved preferences.
  h.local.set("fileOrder", JSON.stringify(initial));
  h.setFailPrefsWrite(false);
  await Promise.all([recoverPendingLocalMove(), recoverPendingLocalMove()]);
  assert.equal(h.getMoveCalls(), 1);
  assert.equal(h.getAckCalls(), 1);
  assert.deepEqual(JSON.parse(h.getAcknowledgedFileOrder() ?? "{}"), { A: [], B: selected });
});

test("moveLocalPath (nota): fallo de persistencia no reconoce journal; recovery exitosa es idempotente sin duplicar ni mover posición (destino sin entrada previa)", async () => {
  const h = makeWindow({ failPrefsWrite: true });
  resetStores();
  fileStore.setState({
    files: ["A/n.md", "B/x.md"],
    folders: ["A", "B"],
    statsMap: { "A/n.md": { mtime: 1, birthtime: 1 } },
    selectedFile: { name: "", content: "" },
    archivedFolders: [],
  });
  h.local.set("fileOrder", JSON.stringify({ "A": ["A/n.md"], "B": [] }));
  h.local.set("folderOrder", JSON.stringify({ "": ["A", "B"] }));
  h.local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "A": true, "B": true }));
  h.local.set("theme", "dark");

  const { moveLocalPath, recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  await assert.rejects(moveLocalPath("file", "A/n.md", "B/n.md"), /journal was kept for recovery/i);
  assert.equal(h.getAckCalls(), 0);
  assert.ok(h.getPendingMove());
  assert.deepEqual(JSON.parse(h.local.get("fileOrder") ?? "{}"), { "A": [], "B": ["B/n.md"] });
  assert.equal(h.local.get("theme"), "dark");

  h.setFailPrefsWrite(false);
  await recoverPendingLocalMove();
  assert.equal(h.getAckCalls(), 1);
  assert.equal(h.getPendingMove(), null);
  const snapshot = h.local.get("fileOrder");
  assert.deepEqual(JSON.parse(snapshot ?? "{}"), { "A": [], "B": ["B/n.md"] });
  assert.equal(h.local.get("theme"), "dark");

  await recoverPendingLocalMove();
  await recoverPendingLocalMove();
  assert.equal(h.getAckCalls(), 1);
  assert.deepEqual(JSON.parse(h.local.get("fileOrder") ?? "{}"), { "A": [], "B": ["B/n.md"] });
  const savedPath = Array.from(h.disk.keys()).find(k => k.endsWith(".preferences.json"));
  assert.ok(savedPath);
  const saved = JSON.parse(h.disk.get(savedPath) ?? "{}") as { fileOrder?: unknown };
  assert.deepEqual(JSON.parse(String(saved.fileOrder ?? "{}")), { "A": [], "B": ["B/n.md"] });
});

test("recoverPendingLocalMove tras reinicio simulado (prefs ya persistidas/migradas, journal pendiente) es idempotente para nota", async () => {
  const h2 = makeWindow({
    pendingMove: {
      sourcePath: "A/n.md",
      destinationPath: "B/n.md",
      isFolder: false,
      phase: "awaitingFrontend",
      notes: [{ oldPath: "A/n.md", newPath: "B/n.md" }],
    },
  });
  resetStores();
  fileStore.setState({ files: ["B/n.md", "B/z.md"], folders: ["A", "B"], statsMap: {}, selectedFile: { name: "", content: "" }, archivedFolders: [] });
  h2.local.set("fileOrder", JSON.stringify({ "A": [], "B": ["B/n.md", "B/z.md"] }));
  h2.local.set("folderOrder", JSON.stringify({ "": ["A", "B"] }));
  h2.local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "A": true, "B": true }));
  h2.local.set("paper", JSON.stringify([]));
  h2.local.set("theme", "nord");

  const { recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  await recoverPendingLocalMove();
  assert.equal(h2.getAckCalls(), 1);
  assert.deepEqual(JSON.parse(h2.local.get("fileOrder") ?? "{}"), { "A": [], "B": ["B/n.md", "B/z.md"] });
  assert.equal(h2.local.get("theme"), "nord");

  await recoverPendingLocalMove();
  assert.equal(h2.getAckCalls(), 1);
  assert.deepEqual(JSON.parse(h2.local.get("fileOrder") ?? "{}"), { "A": [], "B": ["B/n.md", "B/z.md"] });
});

test("moveLocalPath (carpeta): remapea files/statsMap/archivedFolders del store y conserva expansión interna/prefs de descendientes archivados lógicos", async () => {
  const h = makeWindow();
  resetStores();
  fileStore.setState({
    files: ["P/a.md", "P/Sub/b.md", "Q/c.md"],
    folders: ["P", "P/Sub", "P/Arc", "Q"],
    statsMap: { "P/a.md": { mtime: 1, birthtime: 1 }, "P/Sub/b.md": { mtime: 2, birthtime: 2 } },
    selectedFile: { name: "P/a.md", content: "x" },
    archivedFolders: ["P/Arc"],
  });
  h.local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "P": true, "P/Sub": false, "P/Arc": false, "Q": true }));
  h.local.set("folderOrder", JSON.stringify({ "": ["P", "Q"], "P": ["P/Sub", "P/Arc"], "Q": [] }));
  h.local.set("fileOrder", JSON.stringify({ "P": ["P/a.md"], "P/Sub": ["P/Sub/b.md"], "Q": ["Q/c.md"] }));
  h.local.set("paper", JSON.stringify(["P/Sub/arch.md", "Q/c.md"]));

  const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
  await moveLocalPath("folder", "P", "Q/P");

  const s = fileStore.getState();
  assert.deepEqual([...s.files].sort(), ["Q/P/Sub/b.md", "Q/P/a.md", "Q/c.md"].sort());
  assert.ok(s.statsMap["Q/P/a.md"]);
  assert.ok(s.statsMap["Q/P/Sub/b.md"]);
  assert.equal(s.statsMap["P/a.md"], undefined);
  assert.deepEqual([...s.folders].sort(), ["Q", "Q/P", "Q/P/Arc", "Q/P/Sub"].sort());
  assert.deepEqual(s.archivedFolders, ["Q/P/Arc"]);
  assert.equal(s.selectedFile.name, "Q/P/a.md");

  const expanded = JSON.parse(h.local.get("folderExpanded") ?? "{}") as Record<string, boolean>;
  assert.equal(expanded["Q/P"], true);
  assert.equal(expanded["Q/P/Sub"], false);
  assert.equal(expanded["Q/P/Arc"], false);
  assert.equal(expanded["Q"], true);
  assert.equal(expanded["root:lyra"], true);
  assert.deepEqual(JSON.parse(h.local.get("paper") ?? "[]"), ["Q/P/Sub/arch.md", "Q/c.md"]);
});

test("migratePreferences: mover nota a destino sin fileOrder previo crea entrada al final; carpeta a destino sin folderOrder previo", async () => {
  const h = makeWindow();
  resetStores();
  h.local.set("fileOrder", JSON.stringify({ "A": ["A/n.md"] }));
  h.local.set("folderOrder", JSON.stringify({ "": ["A"] }));
  h.local.set("folderExpanded", JSON.stringify({ "root:lyra": true }));
  h.local.set("paper", JSON.stringify([]));

  const { migratePreferences } = await import("../src/utils/pathOperations.ts");
  await migratePreferences([{ oldPath: "A/n.md", newPath: "B/n.md" }]);
  assert.deepEqual(JSON.parse(h.local.get("fileOrder") ?? "{}"), { "A": [], "B": ["B/n.md"] });

  await migratePreferences([], { oldPath: "A/Sub", newPath: "B/Sub" });
  const fo = JSON.parse(h.local.get("folderOrder") ?? "{}") as Record<string, unknown>;
  assert.ok(fo[""] !== undefined);
});
