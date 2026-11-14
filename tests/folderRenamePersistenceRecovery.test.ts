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

function setupHarness(opts?: {
  failPrefsWrite?: boolean;
  pendingMove?: PendingMove | null;
  moveResult?: Array<{ oldPath: string; newPath: string }>;
}) {
  const local = new Map<string, string>();
  const disk = new Map<string, string>();
  let failPrefsWrite = opts?.failPrefsWrite ?? false;
  let pendingMove: PendingMove | null = opts?.pendingMove ?? null;
  let ackCalls = 0;
  let moveCalls = 0;
  let prefsWriteAttempts = 0;

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
            const path = decodeURIComponent(options?.headers?.path ?? "");
            if (path.endsWith(".preferences.json")) {
              prefsWriteAttempts++;
              if (failPrefsWrite) throw new Error("disk full (simulado)");
            }
            const bytes = args as Uint8Array;
            disk.set(path, new TextDecoder().decode(bytes));
            return undefined;
          }
          // Editor/draft/no-op operations used by move flow
          case "flush_editor_drafts":
          case "read_draft_file":
            return null;
          case "save_draft_file":
          case "delete_draft_file":
            return undefined;
          case "move_folder_local":
          case "move_note_local": {
            moveCalls++;
            const changes = opts?.moveResult ?? (args as { expectedNotes?: Array<{ oldPath: string; newPath: string }> }).expectedNotes ?? [];
            pendingMove = {
              sourcePath: (args as { sourcePath: string }).sourcePath,
              destinationPath: (args as { destinationPath: string }).destinationPath,
              isFolder: cmd === "move_folder_local",
              phase: "awaitingFrontend",
              notes: changes.map(n => ({ oldPath: n.oldPath, newPath: n.newPath })),
            };
            return changes;
          }
          case "local_move_status":
            return pendingMove ? "pending" : "notMoved";
          case "pending_local_move":
            return pendingMove;
          case "acknowledge_local_move":
            ackCalls++;
            pendingMove = null;
            return undefined;
          default:
            return undefined;
        }
      },
    },
  };

  // Minimal store/config state
  fileStore.setState({
    files: ["Desarrollo/nota.md", "Desarrollo/Sub/otra.md", "Trabajo/ajena.md"],
    folders: ["Desarrollo", "Desarrollo/Sub", "Trabajo"],
    statsMap: {},
    selectedFile: { name: "", content: "" },
    folderListingWarnings: [],
    archivedFolders: [],
    folderArchiveError: null,
    folderArchiveLoaded: true,
  });
  configStore.setState({ prefTick: 0 });

  local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "Desarrollo": true, "Desarrollo/Sub": false, "Trabajo": true, "Desarrollo2": false }));
  local.set("folderOrder", JSON.stringify({ "": ["Trabajo", "Desarrollo", "Desarrollo2"], "Desarrollo": ["Desarrollo/Sub"], "Trabajo": [] }));
  local.set("fileOrder", JSON.stringify({ "Desarrollo": ["Desarrollo/nota.md"], "Desarrollo/Sub": ["Desarrollo/Sub/otra.md"], "Trabajo": ["Trabajo/ajena.md"] }));
  local.set("paper", JSON.stringify(["Desarrollo/archivada.md", "Trabajo/otra.md"]));

  return {
    local,
    disk,
    setFailPrefsWrite: (v: boolean) => { failPrefsWrite = v; },
    getAckCalls: () => ackCalls,
    getMoveCalls: () => moveCalls,
    getPrefsWriteAttempts: () => prefsWriteAttempts,
    getPendingMove: () => pendingMove,
  };
}

function expectedMigratedPrefs() {
  return {
    folderExpanded: { "root:lyra": true, "Programacion": true, "Programacion/Sub": false, "Trabajo": true, "Desarrollo2": false },
    folderOrder: { "": ["Trabajo", "Programacion", "Desarrollo2"], "Programacion": ["Programacion/Sub"], "Trabajo": [] },
    fileOrder: { "Programacion": ["Programacion/nota.md"], "Programacion/Sub": ["Programacion/Sub/otra.md"], "Trabajo": ["Trabajo/ajena.md"] },
    paper: ["Programacion/archivada.md", "Trabajo/otra.md"],
  };
}

test("savePersistentPreferencesNow propaga errores de escritura al llamador", async () => {
  const { disk } = (() => {
    const local = new Map<string, string>([["theme", "dark"]]);
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => { local.set(k, String(v)); },
        removeItem: (k: string) => { local.delete(k); },
        clear: () => { local.clear(); },
      },
      matchMedia: () => ({ matches: false }),
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, _args: unknown, options?: { headers?: Record<string, string> }) => {
          if (cmd === "plugin:path|join") return "lyra/.preferences.json";
          if (cmd === "plugin:fs|exists") return false;
          if (cmd === "plugin:fs|mkdir") return undefined;
          if (cmd === "plugin:fs|write_text_file") {
            const path = decodeURIComponent(options?.headers?.path ?? "");
            if (path.endsWith(".preferences.json")) throw new Error("disk full (simulado)");
          }
          return undefined;
        },
      },
    };
    return { disk: new Map() };
  })();
  const { savePersistentPreferencesNow } = await import("../src/utils/persistentPreferences.ts");
  await assert.rejects(savePersistentPreferencesNow(), /disk full/);
  assert.equal(disk.size, 0);
});

test("moveLocalPath (renombrar carpeta): fallo de persistencia no reconoce journal y recovery exitosa es idempotente", async () => {
  const h = setupHarness({
    failPrefsWrite: true,
    moveResult: [
      { oldPath: "Desarrollo/Sub/otra.md", newPath: "Programacion/Sub/otra.md" },
      { oldPath: "Desarrollo/nota.md", newPath: "Programacion/nota.md" },
    ],
  });
  const { moveLocalPath, recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");

  await assert.rejects(
    moveLocalPath("folder", "Desarrollo", "Programacion"),
    /journal was kept for recovery/i,
  );
  // Backend completed move (awaitingFrontend) but ack must not run because persistence failed.
  assert.equal(h.getAckCalls(), 0);
  assert.ok(h.getPendingMove(), "journal must remain pending");
  // localStorage migration happened synchronously; persisted disk write failed.
  assert.deepEqual(JSON.parse(h.local.get("folderExpanded")!), expectedMigratedPrefs().folderExpanded);
  assert.deepEqual(JSON.parse(h.local.get("folderOrder")!), expectedMigratedPrefs().folderOrder);
  assert.deepEqual(JSON.parse(h.local.get("fileOrder")!), expectedMigratedPrefs().fileOrder);
  assert.deepEqual(JSON.parse(h.local.get("paper")!), expectedMigratedPrefs().paper);
  assert.equal(Array.from(h.disk.keys()).some(k => k.endsWith(".preferences.json")), false);

  // Successful recovery persists preferences and acknowledges journal.
  h.setFailPrefsWrite(false);
  await recoverPendingLocalMove();
  assert.equal(h.getAckCalls(), 1);
  assert.equal(h.getPendingMove(), null);
  const prefsPath = Array.from(h.disk.keys()).find(k => k.endsWith(".preferences.json"));
  assert.ok(prefsPath, "preferences must be persisted on successful recovery");
  const saved = JSON.parse(h.disk.get(prefsPath!)!);
  assert.deepEqual(JSON.parse(saved.folderExpanded), expectedMigratedPrefs().folderExpanded);
  assert.deepEqual(JSON.parse(saved.folderOrder), expectedMigratedPrefs().folderOrder);
  assert.deepEqual(JSON.parse(saved.fileOrder), expectedMigratedPrefs().fileOrder);

  // Recovery repeated is idempotent: no further ack, no preference drift/duplication.
  const snapshot = {
    folderExpanded: h.local.get("folderExpanded"),
    folderOrder: h.local.get("folderOrder"),
    fileOrder: h.local.get("fileOrder"),
    paper: h.local.get("paper"),
  };
  await recoverPendingLocalMove();
  assert.equal(h.getAckCalls(), 1);
  assert.deepEqual({
    folderExpanded: h.local.get("folderExpanded"),
    folderOrder: h.local.get("folderOrder"),
    fileOrder: h.local.get("fileOrder"),
    paper: h.local.get("paper"),
  }, snapshot);
});
