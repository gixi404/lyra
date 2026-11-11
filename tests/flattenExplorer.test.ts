import test from "node:test";
import assert from "node:assert/strict";
import { buildFolderTree } from "../src/utils/folderTree.ts";
import { flattenVisible } from "../src/utils/flattenExplorer.ts";

const FOLDERS = ["Proyectos", "Proyectos/Frontend", "Proyectos/Backend", "Personal"];
const FILES = [
  "README.txt",
  "Proyectos/notas.txt",
  "Proyectos/Frontend/app.txt",
  "Proyectos/Frontend/estilos.css",
  "Proyectos/Backend/api.txt",
  "Proyectos/Backend/config.sql",
  "Personal/ideas.txt",
];

function treeFrom() {
  return buildFolderTree(FOLDERS, FILES, {}, { "": FILES.filter(f => !f.includes("/")) });
}

function byId(rows: { id: string; open: boolean }[], id: string) {
  const row = rows.find(row => row.id === id);
  assert.ok(row, `fila ${id} existe`);
  return row;
}

test("flatten respects showRoot and Lyra ordering", () => {
  const rows = flattenVisible(treeFrom(), {}, true, {});
  assert.equal(rows[0].id, "folder:");
  assert.equal(rows[0].isRoot, true);
  assert.equal(rows[0].path, "");
  assert.equal(rows[0].open, true);
  // root files go at depth 1 when Lyra is expanded (default)
  assert.equal(rows[1].path, "README.txt");
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[1].open, true);
});

test("flatten orders top-level folders by $top and nests children below their parent", () => {
  const rows = flattenVisible(treeFrom(), {}, true, { $top: ["Personal", "Proyectos"] });
  const ids = rows.map(r => r.id);
  assert.deepEqual(ids, [
    "folder:",
    "file:README.txt",
    "folder:Personal",
    "file:Personal/ideas.txt",
    "folder:Proyectos",
    "folder:Proyectos/Backend",
    "file:Proyectos/Backend/api.txt",
    "file:Proyectos/Backend/config.sql",
    "folder:Proyectos/Frontend",
    "file:Proyectos/Frontend/app.txt",
    "file:Proyectos/Frontend/estilos.css",
    "file:Proyectos/notas.txt",
  ]);
  assert.ok(rows.every(row => row.open));
});

test("closing Lyra hides only its direct files; top-level folders stay visible", () => {
  const rows = flattenVisible(treeFrom(), { "root:lyra": false }, true, {});
  assert.equal(byId(rows, "folder:").open, true);
  assert.equal(byId(rows, "file:README.txt").open, false);
  assert.equal(byId(rows, "folder:Personal").open, true);
  assert.equal(byId(rows, "folder:Proyectos").open, true);
  assert.equal(byId(rows, "file:Proyectos/notas.txt").open, true);
  assert.equal(byId(rows, "file:Personal/ideas.txt").open, true);
});

test("closing a nested folder flags its subtree closed only", () => {
  const rows = flattenVisible(treeFrom(), { "Proyectos": false, "Proyectos/Frontend": true }, true, {});
  assert.equal(byId(rows, "folder:Proyectos").open, true);
  assert.equal(byId(rows, "folder:Proyectos/Frontend").open, false);
  assert.equal(byId(rows, "file:Proyectos/Frontend/app.txt").open, false);
  assert.equal(byId(rows, "file:Proyectos/Backend/api.txt").open, false);
  assert.equal(byId(rows, "file:Proyectos/notas.txt").open, false);
  assert.equal(byId(rows, "file:Personal/ideas.txt").open, true);
});

test("closing Lyra keeps top-level folders mounted and visible, only root files close", () => {
  const rows = flattenVisible(treeFrom(), { "root:lyra": false }, true, { $top: ["Proyectos", "Personal"] });
  const ids = rows.map(r => r.id);
  assert.deepEqual(ids, [
    "folder:",
    "file:README.txt",
    "folder:Proyectos",
    "folder:Proyectos/Backend",
    "file:Proyectos/Backend/api.txt",
    "file:Proyectos/Backend/config.sql",
    "folder:Proyectos/Frontend",
    "file:Proyectos/Frontend/app.txt",
    "file:Proyectos/Frontend/estilos.css",
    "file:Proyectos/notas.txt",
    "folder:Personal",
    "file:Personal/ideas.txt",
  ]);
  assert.equal(byId(rows, "file:README.txt").open, false);
  assert.ok(rows.filter(r => r.id !== "file:README.txt").every(row => row.open));
});

test("showRoot=false renders all rows at depth 0/1 without the Lyra row", () => {
  const rows = flattenVisible(treeFrom(), {}, false, { $top: ["Personal", "Proyectos"] });
  const ids = rows.map(r => r.id);
  assert.deepEqual(ids, [
    "folder:Personal",
    "file:Personal/ideas.txt",
    "folder:Proyectos",
    "folder:Proyectos/Backend",
    "file:Proyectos/Backend/api.txt",
    "file:Proyectos/Backend/config.sql",
    "folder:Proyectos/Frontend",
    "file:Proyectos/Frontend/app.txt",
    "file:Proyectos/Frontend/estilos.css",
    "file:Proyectos/notas.txt",
    "file:README.txt",
  ]);
});

test("ids are unique and depth matches tree nesting", () => {
  const rows = flattenVisible(treeFrom(), {}, true, {});
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  const depths = new Map(rows.map(r => [r.id, r.depth]));
  assert.equal(depths.get("file:README.txt"), 1);
  assert.equal(depths.get("folder:Proyectos/Frontend"), 1);
  assert.equal(depths.get("file:Proyectos/Frontend/app.txt"), 2);
  assert.equal(depths.get("folder:Proyectos/Backend"), 1);
  assert.equal(depths.get("file:Proyectos/Backend/api.txt"), 2);
});

test("closing a folder flags exactly its subtree closed", () => {
  const rows = flattenVisible(treeFrom(), { "Proyectos/Frontend": false }, true, {});
  assert.equal(byId(rows, "folder:Proyectos/Frontend").open, true);
  assert.equal(byId(rows, "file:Proyectos/Frontend/app.txt").open, false);
  assert.equal(byId(rows, "file:Proyectos/Frontend/estilos.css").open, false);
  assert.equal(byId(rows, "file:Proyectos/Backend/api.txt").open, true);
});
