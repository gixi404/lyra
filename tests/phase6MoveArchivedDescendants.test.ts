import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";

type PendingMove = { sourcePath: string; destinationPath: string; isFolder: boolean; phase: string; notes: Array<{ oldPath: string; newPath: string }> };

function makeWindow() {
  const local = new Map<string, string>();
  let pendingMove: PendingMove | null = null;
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
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        switch (cmd) {
          case "plugin:path|join": return ((args.paths as string[] | undefined) ?? []).join("/");
          case "plugin:fs|read_text_file": return new TextEncoder().encode("");
          case "flush_editor_drafts": return undefined;
          case "read_draft_file": return null;
          case "save_draft_file": return undefined;
          case "delete_draft_file": return undefined;
          case "move_folder_local": {
            const sourcePath = String(args.sourcePath);
            const destinationPath = String(args.destinationPath);
            const notes = ((args.expectedNotes as string[] | undefined) ?? []).map((o) => ({ oldPath: o, newPath: o.replace(sourcePath, destinationPath) }));
            pendingMove = { sourcePath, destinationPath, isFolder: true, phase: "awaitingFrontend", notes };
            return notes;
          }
          case "local_move_status": return pendingMove ? "pending" : "notMoved";
          case "pending_local_move": return pendingMove;
          case "acknowledge_local_move": ackCalls++; pendingMove = null; return undefined;
          default: return undefined;
        }
      },
    },
  } as unknown as Window & typeof globalThis;
  return { local, getAckCalls: () => ackCalls };
}

test("moveLocalPath (carpeta): remapea archivedFolders, paper, files/folders/statsMap y prefs al mover carpeta activa con descendientes archivados", async () => {
  const { moveLocalPath } = await import("../src/utils/pathOperations.ts");
  const origWindow = globalThis.window;
  try {
    const env = makeWindow();
    env.local.set("paper", JSON.stringify(["Work/ArchivedA/note.md", "Other/Keep/n.md"]));
    env.local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "Work": true, "Work/ArchivedA": false, "Other": true }));
    env.local.set("folderOrder", JSON.stringify({ "$top": ["Work", "Other"], "Work": ["Work/ArchivedA", "Work/Active"] }));
    env.local.set("fileOrder", JSON.stringify({ "Work/ArchivedA": ["Work/ArchivedA/note.md"], "Work/Active": ["Work/Active/a.md"] }));
    fileStore.setState({
      files: ["Work/Active/a.md", "Work/ArchivedA/note.md", "Other/Keep/n.md"],
      folders: ["Work", "Work/Active", "Work/ArchivedA", "Other", "Other/Keep"],
      statsMap: {
        "Work/Active/a.md": { modified: 1, created: 1, size: 1 },
        "Work/ArchivedA/note.md": { modified: 2, created: 2, size: 2 },
        "Other/Keep/n.md": { modified: 3, created: 3, size: 3 },
      } as unknown as typeof fileStore extends { getState: () => { statsMap: infer T } } ? T : never,
      archivedFolders: ["Work/ArchivedA", "Other/Keep"],
      listingGeneration: 5,
      fileIsEdited: false,
      selectedFile: { name: "", content: "" },
    });

    await moveLocalPath("folder", "Work", "Dst/Work");

    const state = fileStore.getState();
    assert.deepEqual(state.archivedFolders.sort(), ["Dst/Work/ArchivedA", "Other/Keep"].sort());
    assert.ok(state.folders.includes("Dst/Work/ArchivedA"));
    assert.ok(!state.folders.includes("Work/ArchivedA"));
    assert.ok(state.files.includes("Dst/Work/ArchivedA/note.md"));
    assert.ok(state.files.includes("Dst/Work/Active/a.md"));
    assert.ok(state.files.includes("Other/Keep/n.md"));
    assert.ok(!state.files.includes("Work/Active/a.md"));
    assert.ok(("Dst/Work/ArchivedA/note.md" in state.statsMap) && !("Work/ArchivedA/note.md" in state.statsMap));
    assert.ok("Other/Keep/n.md" in state.statsMap);

    const paper = JSON.parse(env.local.get("paper")!) as string[];
    assert.ok(paper.includes("Dst/Work/ArchivedA/note.md"));
    assert.ok(!paper.includes("Work/ArchivedA/note.md"));
    assert.ok(paper.includes("Other/Keep/n.md"));

    const folderExpanded = JSON.parse(env.local.get("folderExpanded")!) as Record<string, unknown>;
    assert.equal(folderExpanded["Work/ArchivedA"], undefined);
    assert.equal(folderExpanded["Dst/Work/ArchivedA"], false);
    assert.equal(folderExpanded["Other"], true);

    const folderOrder = JSON.parse(env.local.get("folderOrder")!) as Record<string, string[]>;
    assert.ok(JSON.stringify(folderOrder).includes("Dst/Work/ArchivedA"));
    assert.ok(!JSON.stringify(folderOrder).includes("\"Work/ArchivedA\""));
    assert.ok((folderOrder["Dst"] ?? []).includes("Dst/Work"));
    assert.ok(!((folderOrder["$top"] ?? folderOrder[""] ?? []) as string[]).includes("Work"));
    assert.ok(((folderOrder["$top"] ?? folderOrder[""] ?? []) as string[]).includes("Other"));

    const fileOrder = JSON.parse(env.local.get("fileOrder")!) as Record<string, string[]>;
    assert.deepEqual(fileOrder["Dst/Work/ArchivedA"], ["Dst/Work/ArchivedA/note.md"]);
    assert.deepEqual(fileOrder["Dst/Work/Active"], ["Dst/Work/Active/a.md"]);

    assert.equal(state.listingGeneration >= 6, true);
    assert.equal(env.getAckCalls(), 1);
  } finally {
    globalThis.window = origWindow;
  }
});

test("recoverPendingLocalMove (awaitingFrontend): mantiene coherencia de prefs/archivados tras mover carpeta con descendientes archivados", async () => {
  const { recoverPendingLocalMove } = await import("../src/utils/pathOperations.ts");
  const origWindow = globalThis.window;
  try {
    const local = new Map<string, string>();
    let ackCalls = 0;
    const pendingMove = {
      sourcePath: "Work",
      destinationPath: "Dst/Work",
      isFolder: true,
      phase: "awaitingFrontend",
      notes: [
        { oldPath: "Work/ArchivedA/note.md", newPath: "Dst/Work/ArchivedA/note.md" },
        { oldPath: "Work/Active/a.md", newPath: "Dst/Work/Active/a.md" },
      ],
    };
    globalThis.window = {
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => { local.set(k, String(v)); },
        removeItem: (k: string) => { local.delete(k); },
        clear: () => { local.clear(); },
        get length() { return local.size; },
        key: (i: number) => Array.from(local.keys())[i] ?? null,
      },
      matchMedia: () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, onchange:null, dispatchEvent:()=>false }),
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string) => {
          if (cmd === "pending_local_move") return pendingMove;
          if (cmd === "acknowledge_local_move") { ackCalls++; return undefined; }
          if (cmd === "read_draft_file") return null;
          if (cmd === "delete_draft_file" || cmd === "save_draft_file") return undefined;
          return undefined;
        },
      },
    } as unknown as Window & typeof globalThis;

    local.set("paper", JSON.stringify(["Work/ArchivedA/note.md", "Other/Keep/n.md"]));
    local.set("folderExpanded", JSON.stringify({ "Work": true, "Work/ArchivedA": false }));
    local.set("folderOrder", JSON.stringify({ "$top": ["Work", "Other"], "Work": ["Work/ArchivedA"] }));
    local.set("fileOrder", JSON.stringify({ "Work/ArchivedA": ["Work/ArchivedA/note.md"] }));

    await recoverPendingLocalMove();
    const paper = JSON.parse(local.get("paper")!) as string[];
    assert.ok(paper.includes("Dst/Work/ArchivedA/note.md"));
    assert.ok(paper.includes("Other/Keep/n.md"));
    assert.equal((JSON.parse(local.get("folderExpanded")!) as Record<string, unknown>)["Dst/Work/ArchivedA"], false);
    assert.ok(JSON.stringify(local.get("folderOrder")).includes("Dst/Work/ArchivedA"));
    assert.deepEqual((JSON.parse(local.get("fileOrder")!) as Record<string, string[]>)["Dst/Work/ArchivedA"], ["Dst/Work/ArchivedA/note.md"]);
    assert.equal(ackCalls, 1);
  } finally {
    globalThis.window = origWindow;
  }
});
