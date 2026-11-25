import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFolderTree, type FolderOrder } from "../src/utils/folderTree.ts";
import {
  buildFileOrderFromPaths,
  mergeCapturedFileOrder,
  registerFileOrderCapture,
} from "../src/utils/manualOrder.ts";
import { hydrateSortOptionFromStorage, resolveSortOption, searchStore } from "../src/store/searchStore.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

function fakeStorage(initial: Record<string, string> = {}): { values: Map<string, string>; storage: Storage } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: () => null,
      get length() { return values.size; },
    } as Storage,
  };
}

function restoreSearchSort(sortOption: "mtime" | "az" | "za" | "recent" | "oldest" | "random" | "manual" = "mtime"): void {
  searchStore.setState({ sortOption, sortOptions: [sortOption], order: sortOption !== "za" });
}

test("sort defaults to Última edición only when there is no valid saved preference", () => {
  assert.equal(resolveSortOption(null), "mtime");
  assert.equal(resolveSortOption(undefined), "mtime");
  assert.equal(resolveSortOption(""), "mtime");
  assert.equal(resolveSortOption("invalid"), "mtime");
  assert.equal(resolveSortOption("manual"), "manual");
});

test("restarting respects a saved sort preference", () => {
  const { storage } = fakeStorage({ sortOption: "az" });
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    hydrateSortOptionFromStorage();
    assert.equal(searchStore.getState().sortOption, "az");
    hydrateSortOptionFromStorage();
    assert.equal(searchStore.getState().sortOption, "az");
  } finally {
    restoreSearchSort();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
});

test("Manual adopts the current visual order and ignores an older manual order", () => {
  const files = ["B/zeta.md", "B/alfa.md", "A/segunda.md", "A/primera.md"];
  const captured = buildFileOrderFromPaths(files);
  const oldOrder: FolderOrder = {
    A: ["A/primera.md", "A/segunda.md"],
    B: ["B/alfa.md", "B/zeta.md"],
  };
  const merged = mergeCapturedFileOrder(oldOrder, captured);
  const tree = buildFolderTree(["A", "B"], files, {}, merged);

  assert.deepEqual(captured, {
    B: ["B/zeta.md", "B/alfa.md"],
    A: ["A/segunda.md", "A/primera.md"],
  });
  assert.deepEqual(tree.folders.find(folder => folder.path === "A")?.files, ["A/segunda.md", "A/primera.md"]);
  assert.deepEqual(tree.folders.find(folder => folder.path === "B")?.files, ["B/zeta.md", "B/alfa.md"]);
});

test("switching to Manual persists the criterion and captured order without changing positions", async () => {
  const local = fakeStorage({
    fileOrder: JSON.stringify({ A: ["A/primera.md", "A/segunda.md"], Otros: ["Otros/viejo.md"] }),
  });
  const disk = { value: "" };
  const previousLocalStorage = globalThis.localStorage;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const windowMock = {
    localStorage: local.storage,
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { path?: string; paths?: string[] } | Uint8Array) => {
        if (command === "plugin:path|join") return (args as { paths: string[] }).paths.join("/");
        if (command === "plugin:fs|exists") return false;
        if (command === "plugin:fs|mkdir") return undefined;
        if (command === "plugin:fs|write_text_file") {
          disk.value = new TextDecoder().decode(args as Uint8Array);
          return undefined;
        }
        throw new Error(`unexpected IPC ${command}`);
      },
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local.storage });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  const unregister = registerFileOrderCapture(() =>
    buildFileOrderFromPaths(["A/segunda.md", "A/primera.md", "Otros/viejo.md"])
  );
  try {
    restoreSearchSort("mtime");
    searchStore.getState().setSortOption("manual");
    assert.equal(searchStore.getState().sortOption, "manual");
    assert.equal(local.values.get("sortOption"), "manual");
    assert.deepEqual(JSON.parse(local.values.get("fileOrder") ?? "{}"), {
      A: ["A/segunda.md", "A/primera.md"],
      Otros: ["Otros/viejo.md"],
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    const saved = JSON.parse(disk.value) as { sortOption?: string; fileOrder?: string };
    assert.equal(saved.sortOption, "manual");
    assert.deepEqual(JSON.parse(saved.fileOrder ?? "{}"), {
      A: ["A/segunda.md", "A/primera.md"],
      Otros: ["Otros/viejo.md"],
    });
  } finally {
    unregister();
    restoreSearchSort();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocalStorage });
    if (previousWindow === undefined) {
      delete (globalThis as unknown as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  }
});

test("repeated automatic/manual changes capture the order visible immediately before Manual", () => {
  const azVisual = ["A/alfa.md", "A/zeta.md", "B/uno.md"];
  const mtimeVisual = ["B/uno.md", "A/zeta.md", "A/alfa.md"];

  const first = mergeCapturedFileOrder({}, buildFileOrderFromPaths(azVisual));
  assert.deepEqual(first, { A: ["A/alfa.md", "A/zeta.md"], B: ["B/uno.md"] });

  // Al volver desde otro criterio automático, el orden manual anterior no debe reaparecer.
  const second = mergeCapturedFileOrder(first, buildFileOrderFromPaths(mtimeVisual));
  assert.deepEqual(second, { A: ["A/zeta.md", "A/alfa.md"], B: ["B/uno.md"] });

  const tree = buildFolderTree(["A", "B"], mtimeVisual, {}, second);
  assert.deepEqual(tree.folders.find(folder => folder.path === "A")?.files, ["A/zeta.md", "A/alfa.md"]);
  assert.deepEqual(tree.folders.find(folder => folder.path === "B")?.files, ["B/uno.md"]);
});

test("ListFiles does not apply an automatic order while Manual is selected", () => {
  const source = read("src/components/ListFiles.tsx");
  const sortBlock = source.slice(source.indexOf("const sorted ="), source.indexOf("const matchingRetained"));
  assert.match(sortBlock, /sortOption === "manual"\s*\? filtered/, "Manual must keep the current list order");
  assert.equal(/if \(sortOption === "manual"\)/.test(sortBlock), false, "Manual must not enter an automatic comparator");
});

test("the explorer switches to Manual only after the drag actually starts", () => {
  const source = read("src/components/FolderExplorer.tsx");
  const dragStart = source.slice(source.indexOf("onDragStart={"), source.indexOf("onDragOver={"));
  const rowLookup = dragStart.indexOf("dragRowRef.current = row?.kind === \"file\" ? row : null");
  const switchIndex = dragStart.indexOf('setSortOption("manual")');
  assert.ok(rowLookup > -1, "the drag start must identify the dragged file row");
  assert.ok(switchIndex > rowLookup, "Manual must be selected during onDragStart, not on pointer down");
  assert.ok(dragStart.includes('searchStore.getState().sortOption !== "manual"'), "already-manual drags must not capture again");
  assert.ok(source.includes("searchStore.getState().sortOption === \"manual\""), "drop handling must use the live sort criterion");
});

test("Escape cancellation keeps the manual criterion and performs no order change", () => {
  const source = read("src/components/FolderExplorer.tsx");
  assert.ok(source.includes('if (reason === "cancel" || !target) return null;'), "cancel must not mutate file order");
  const dragEnd = source.slice(source.indexOf("onDragEnd={"), source.indexOf("</DragDropProvider>"));
  assert.equal(dragEnd.includes('setSortOption("mtime")'), false, "cancel must not revert the criterion automatically");
});
