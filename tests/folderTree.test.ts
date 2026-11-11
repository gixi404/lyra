import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFolderTree,
  defaultFolderExpandedState,
  expandFolderAncestors,
  insertEntry,
  parseFolderExpandedState,
  readFolderExpandedState,
  relocateEntry,
  remapPath,
  reorderEntries,
  reorderFolder,
  ROOT_FOLDER_ID,
  type FolderOrder,
} from "../src/utils/folderTree.ts";

test("the virtual root includes loose notes and empty nested folders", () => {
  const tree = buildFolderTree(["Work", "Work/Empty", "Personal"], ["root.txt", "Work/note.md"]);
  assert.equal(tree.name, "Lyra");
  assert.deepEqual(tree.files, ["root.txt"]);
  assert.deepEqual(tree.folders.map(folder => folder.path), ["Personal", "Work"]);
  assert.deepEqual(tree.folders[1].folders[0], { path: "Work/Empty", name: "Empty", folders: [], files: [] });
});

test("creating a note expands its destination and every ancestor", () => {
  assert.deepEqual(expandFolderAncestors({ A: false }, "A/B"), {
    [ROOT_FOLDER_ID]: true, A: true, "A/B": true,
  });
});

test("manual order is scoped to each parent and does not change paths", () => {
  const paths = ["A", "B", "A/One", "A/Two"];
  const order = reorderFolder({}, "", ["A", "B"], "B", "A", false);
  const tree = buildFolderTree(paths, [], { ...order, A: ["A/Two", "A/One"] });
  assert.deepEqual(tree.folders.map(folder => folder.path), ["B", "A"]);
  assert.deepEqual(tree.folders[1].folders.map(folder => folder.path), ["A/Two", "A/One"]);
});

test("folder path migration changes descendants but not similar sibling names", () => {
  assert.equal(remapPath("A/B/note.md", "A", "Projects/A"), "Projects/A/B/note.md");
  assert.equal(remapPath("AB/note.md", "A", "Projects/A"), "AB/note.md");
});

test("folder expansion defaults to root expanded when nothing is persisted", () => {
  assert.deepEqual(defaultFolderExpandedState(), { [ROOT_FOLDER_ID]: true });
  assert.deepEqual(parseFolderExpandedState(null), { [ROOT_FOLDER_ID]: true });
  assert.deepEqual(parseFolderExpandedState(""), { [ROOT_FOLDER_ID]: true });
  assert.deepEqual(parseFolderExpandedState("{bad json"), { [ROOT_FOLDER_ID]: true });
  assert.deepEqual(readFolderExpandedState({ getItem: (_key: string) => null }), { [ROOT_FOLDER_ID]: true });
});

test("folder expansion restores the exact persisted state for folders and subfolders", () => {
  const storage = {
    getItem: (key: string) => key === "folderExpanded"
      ? JSON.stringify({
          [ROOT_FOLDER_ID]: true,
          "Proyectos": true,
          "Proyectos/Lyra": false,
          "Personal": false,
        })
      : null,
  };

  assert.deepEqual(readFolderExpandedState(storage), {
    [ROOT_FOLDER_ID]: true,
    "Proyectos": true,
    "Proyectos/Lyra": false,
    "Personal": false,
  });
});

test("restoring folder expansion re-reads persisted state without changing it", () => {
  const persisted = JSON.stringify({
    [ROOT_FOLDER_ID]: false,
    "A": true,
    "A/B": false,
    "C": true,
  });
  const storage = { getItem: (_key: string) => persisted };

  const firstMount = readFolderExpandedState(storage);
  const afterReturningToExplorer = readFolderExpandedState(storage);
  const afterPreferenceRestore = parseFolderExpandedState(storage.getItem("folderExpanded"));

  assert.deepEqual(firstMount, afterReturningToExplorer);
  assert.deepEqual(firstMount, afterPreferenceRestore);
  assert.deepEqual(firstMount, {
    [ROOT_FOLDER_ID]: false,
    "A": true,
    "A/B": false,
    "C": true,
  });
});

test("reorderEntries applies arrayMove semantics in both directions", () => {
  // Forward: moving the first item after another places it at the target slot
  const order = reorderEntries({}, "", ["A", "B", "C"], "A", "C");
  assert.deepEqual(order[""], ["B", "C", "A"]);
  // Backward: moving the last item before an earlier one places it at that slot
  const order2 = reorderEntries({}, "", ["A", "B", "C"], "C", "A");
  assert.deepEqual(order2[""], ["C", "A", "B"]);
  // Moving onto itself is a no-op
  assert.deepEqual(reorderEntries({}, "", ["A", "B"], "A", "A"), {});
});

test("reorderEntries keeps per-parent scoping and ignores stale paths", () => {
  const order = reorderEntries({ "": ["root1", "root2"], "A": ["A/x", "A/y"] }, "A", ["A/x", "A/y"], "A/y", "A/x");
  assert.deepEqual(order[""], ["root1", "root2"]);
  assert.deepEqual(order["A"], ["A/y", "A/x"]);
});

test("insertEntry inserts at index and relocates existing entries without duplicating", () => {
  let order = insertEntry({}, "", "A", 0);
  order = insertEntry(order, "", "B", 1);
  order = insertEntry(order, "", "C", 0);
  assert.deepEqual(order[""], ["C", "A", "B"]);
  // Relocating the same entry keeps a single copy and moves it
  order = insertEntry(order, "", "A", 2);
  assert.deepEqual(order[""], ["C", "B", "A"]);
});

test("relocateEntry moves an entry from the old parent list to the new parent, keeping index on rename", () => {
  const order = relocateEntry(
    { "": ["A", "B", "C"], "A": ["A/n1.md", "A/n2.md"], "B": [] },
    { oldPath: "A/n2.md", newPath: "B/n2.md" },
  );
  assert.deepEqual(order["A"], ["A/n1.md"]);
  assert.deepEqual(order["B"], ["B/n2.md"]);
  // same-parent rename keeps the slot
  const order2 = relocateEntry({ "A": ["A/n1.md", "A/n2.md"] }, { oldPath: "A/n2.md", newPath: "A/n2-renamed.md" });
  assert.deepEqual(order2["A"], ["A/n1.md", "A/n2-renamed.md"]);
});

test("buildFolderTree applies fileOrder only when provided", () => {
  const tree = buildFolderTree([], ["a.md", "b.md", "c.md"], {}, { "": ["c.md", "a.md"] });
  assert.deepEqual(tree.files, ["c.md", "a.md", "b.md"]);
  // Without fileOrder the input order is preserved verbatim
  const tree2 = buildFolderTree([], ["c.md", "a.md"], {});
  assert.deepEqual(tree2.files, ["c.md", "a.md"]);
});

test("buildFolderTree ignores stale fileOrder entries for missing files", () => {
  const tree = buildFolderTree([], ["a.md"], {}, { "": ["gone.md", "a.md"] });
  assert.deepEqual(tree.files, ["a.md"]);
});

test("cross-folder move + restart preserves source and destination order (simulated migrate + drop)", () => {
  // Estado inicial: carpeta A con [a1, a2, a3], carpeta B con [b1, b2]
  let fileOrder: FolderOrder = { A: ["A/a1.txt", "A/a2.txt", "A/a3.txt"], B: ["B/b1.txt", "B/b2.txt"] };

  // moveLocalPath aplica relocateEntry (carpeta destino, mover a2 al índice indicado)
  const changes = [{ oldPath: "A/a2.txt", newPath: "B/a2.txt" }];

  // 1) Lo que hace migratePreferences para un cruce de carpeta: elimina el viejo
  //    de todas las listas y añade el nuevo al final del destino.
  fileOrder = relocateEntry(fileOrder, changes[0]);
  assert.deepEqual(fileOrder.A, ["A/a1.txt", "A/a3.txt"]);
  assert.deepEqual(fileOrder.B, ["B/b1.txt", "B/b2.txt", "B/a2.txt"]);

  // 2) Lo que hace el handler del drop: inserta en la posición exacta elegida (índice 1)
  fileOrder = insertEntry(fileOrder, "B", "B/a2.txt", 1);
  assert.deepEqual(fileOrder.A, ["A/a1.txt", "A/a3.txt"]);
  assert.deepEqual(fileOrder.B, ["B/b1.txt", "B/a2.txt", "B/b2.txt"]);

  // 3) Simula "reinicio": el árbol se construye con fileOrder actual
  const files = ["A/a1.txt", "A/a3.txt", "B/b1.txt", "B/a2.txt", "B/b2.txt"];
  const tree = buildFolderTree(["A", "B"], files, {}, fileOrder);
  const A = tree.folders.find(f => f.path === "A");
  const B = tree.folders.find(f => f.path === "B");
  assert.deepEqual(A?.files, ["A/a1.txt", "A/a3.txt"]);
  assert.deepEqual(B?.files, ["B/b1.txt", "B/a2.txt", "B/b2.txt"]);
});

test("folder move (entire folder) remaps fileOrder keys and values", () => {
  const fileOrder: FolderOrder = {
    "A": ["A/n1.md", "A/n2.md"],
    "A/Sub": ["A/Sub/m1.md"],
    "B": ["B/x.md"],
  };
  const folderMove = { oldPath: "A", newPath: "Z/Dest" };
  const rename = (p: string) => p === folderMove.oldPath ? folderMove.newPath
    : p.startsWith(folderMove.oldPath + "/") ? folderMove.newPath + p.slice(folderMove.oldPath.length) : p;
  const next: FolderOrder = {};
  for (const [parent, entries] of Object.entries(fileOrder)) {
    if (!Array.isArray(entries)) continue;
    next[rename(parent)] = entries.map(rename);
  }
  assert.deepEqual(Object.keys(next).sort(), ["B", "Z/Dest", "Z/Dest/Sub"]);
  assert.deepEqual(next["Z/Dest"], ["Z/Dest/n1.md", "Z/Dest/n2.md"]);
  assert.deepEqual(next["Z/Dest/Sub"], ["Z/Dest/Sub/m1.md"]);
  assert.deepEqual(next["B"], ["B/x.md"]);
});
