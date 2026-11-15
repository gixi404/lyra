import test from "node:test";
import assert from "node:assert/strict";
import { buildFolderTree, ROOT_FOLDER_ID } from "../src/utils/folderTree.ts";
import { flattenVisible } from "../src/utils/flattenExplorer.ts";
import {
  getForcedExpandedForSearch,
  getNecessaryFolderPaths,
  getNoteAncestorFolders,
} from "../src/utils/searchProjection.ts";

test("getNoteAncestorFolders returns cumulative ancestor directories", () => {
  assert.deepEqual(getNoteAncestorFolders("README.txt"), []);
  assert.deepEqual(getNoteAncestorFolders("Desarrollo/nota.txt"), ["Desarrollo"]);
  assert.deepEqual(getNoteAncestorFolders("Desarrollo/Proyectos/Lyra/doc.txt"), [
    "Desarrollo",
    "Desarrollo/Proyectos",
    "Desarrollo/Proyectos/Lyra",
  ]);
});

test("getNecessaryFolderPaths includes all ancestors for every matching note", () => {
  const needed = getNecessaryFolderPaths([
    "Desarrollo/Proyectos/Lyra/Documentación.txt",
    "Finanzas/2026/Presupuesto.txt",
    "Nota raíz.txt",
  ]);
  assert.deepEqual([...needed].sort(), [
    "Desarrollo",
    "Desarrollo/Proyectos",
    "Desarrollo/Proyectos/Lyra",
    "Finanzas",
    "Finanzas/2026",
  ]);
});

test("getForcedExpandedForSearch expands ancestors and Lyra for root matches", () => {
  assert.deepEqual(
    getForcedExpandedForSearch(["Nota raíz.txt", "A/B/C/n.txt"], true),
    {
      [ROOT_FOLDER_ID]: true,
      A: true,
      "A/B": true,
      "A/B/C": true,
    },
  );
  assert.deepEqual(getForcedExpandedForSearch(["Nota raíz.txt"], false), {});
});

test("recursive search projection shows only matching notes and required ancestors regardless of collapse state", () => {
  const allFolders = ["Desarrollo", "Desarrollo/Proyectos", "Desarrollo/Proyectos/Lyra", "Desarrollo/Proyectos/Otros", "Finanzas"];
  const matchingFiles = ["Desarrollo/Proyectos/Lyra/Documentación.txt"];
  const necessary = getNecessaryFolderPaths(matchingFiles);
  const folders = allFolders.filter(path => necessary.has(path));

  const collapsedState = {
    [ROOT_FOLDER_ID]: false,
    Desarrollo: false,
    "Desarrollo/Proyectos": false,
    "Desarrollo/Proyectos/Lyra": false,
  };
  const tree = buildFolderTree(folders, matchingFiles);
  const rows = flattenVisible(
    tree,
    { ...collapsedState, ...getForcedExpandedForSearch(matchingFiles, true) },
    true,
  );

  assert.deepEqual(rows.map(row => [row.kind, row.path, row.open, row.depth]), [
    ["folder", "", true, 0],
    ["folder", "Desarrollo", true, 0],
    ["folder", "Desarrollo/Proyectos", true, 1],
    ["folder", "Desarrollo/Proyectos/Lyra", true, 2],
    ["file", "Desarrollo/Proyectos/Lyra/Documentación.txt", true, 3],
  ]);
});

test("search projection hides branches without matches while preserving visible order within kept branches", () => {
  const allFolders = ["A", "A/Uno", "A/Dos", "B", "B/Tres"];
  const allFiles = ["A/Uno/a.txt", "A/Dos/b.txt", "B/Tres/c.txt"];
  const matchingFiles = ["A/Uno/a.txt", "B/Tres/c.txt"];
  const necessary = getNecessaryFolderPaths(matchingFiles);
  const folders = allFolders.filter(path => necessary.has(path));
  const order = { $top: ["B", "A"], A: ["A/Dos", "A/Uno"], B: ["B/Tres"] };

  const tree = buildFolderTree(folders, matchingFiles, order);
  const rows = flattenVisible(tree, { ...getForcedExpandedForSearch(matchingFiles, true) }, true, order);

  assert.deepEqual(rows.map(row => row.path), [
    "",
    "B",
    "B/Tres",
    "B/Tres/c.txt",
    "A",
    "A/Uno",
    "A/Uno/a.txt",
  ]);
  assert.ok(!allFiles.some(path => path === "A/Dos/b.txt" && rows.some(row => row.path === path)));
  assert.ok(!rows.some(row => row.path === "A/Dos"));
});

test("dynamic search updates keep all required branches expanded for simultaneous matches", () => {
  const allFolders = ["Docs", "Docs/API", "Docs/Guías", "Src", "Src/UI"];
  const matchingFiles = ["Docs/API/ref.txt", "Src/UI/nota.txt"];
  const folders = allFolders.filter(path => getNecessaryFolderPaths(matchingFiles).has(path));
  const tree = buildFolderTree(folders, matchingFiles);
  const rows = flattenVisible(tree, getForcedExpandedForSearch(matchingFiles, true), true);

  assert.ok(rows.some(row => row.kind === "file" && row.path === "Docs/API/ref.txt" && row.open));
  assert.ok(rows.some(row => row.kind === "file" && row.path === "Src/UI/nota.txt" && row.open));
  assert.ok(rows.some(row => row.kind === "folder" && row.path === "Docs" && row.open));
  assert.ok(rows.some(row => row.kind === "folder" && row.path === "Docs/API" && row.open));
  assert.ok(rows.some(row => row.kind === "folder" && row.path === "Src" && row.open));
  assert.ok(rows.some(row => row.kind === "folder" && row.path === "Src/UI" && row.open));
  assert.ok(!rows.some(row => row.path === "Docs/Guías"));
});

test("restoring from a captured snapshot returns the exact previous expansion state", () => {
  const snapshot = {
    [ROOT_FOLDER_ID]: false,
    Desarrollo: true,
    "Desarrollo/Proyectos": false,
    Finanzas: false,
  };
  const matchingFiles = ["Desarrollo/Proyectos/Lyra/Documentación.txt"];
  const allFolders = ["Desarrollo", "Desarrollo/Proyectos", "Desarrollo/Proyectos/Lyra", "Finanzas"];
  const folders = allFolders.filter(path => getNecessaryFolderPaths(matchingFiles).has(path));

  // Proyección temporal durante búsqueda: no muta snapshot.
  const projected = { ...snapshot, ...getForcedExpandedForSearch(matchingFiles, true) };
  const searchRows = flattenVisible(buildFolderTree(folders, matchingFiles), projected, true);
  assert.ok(searchRows.some(row => row.path === "Desarrollo/Proyectos/Lyra/Documentación.txt" && row.open));

  // Al limpiar la búsqueda se restaura el snapshot original exacto.
  const restoredRows = flattenVisible(buildFolderTree(allFolders, []), snapshot, true);
  assert.equal(restoredRows.find(row => row.path === "")?.open, true); // fila raíz siempre visible
  assert.equal(restoredRows.find(row => row.path === "Desarrollo")?.open, true);
  assert.equal(restoredRows.find(row => row.path === "Desarrollo/Proyectos")?.open, true); // visible, pero plegada
  assert.equal(restoredRows.find(row => row.path === "Desarrollo/Proyectos/Lyra")?.open, false); // oculta por padre plegado
  assert.equal(restoredRows.find(row => row.path === "Finanzas")?.open, true); // carpeta de primer nivel siempre visible
  assert.deepEqual(snapshot, {
    [ROOT_FOLDER_ID]: false,
    Desarrollo: true,
    "Desarrollo/Proyectos": false,
    Finanzas: false,
  });
});

test("archived view projection respects archived visibility rules and prunes non-matching branches", () => {
  const archivedFolders = ["Archivo", "Archivo/2025"];
  const archivedFiles = ["Archivo/2025/informe.txt", "Archivo/2025/otro.txt"];
  const matchingFiles = archivedFiles.filter(f => f.includes("informe"));
  const folders = archivedFolders.filter(path => getNecessaryFolderPaths(matchingFiles).has(path));
  const rows = flattenVisible(buildFolderTree(folders, matchingFiles), getForcedExpandedForSearch(matchingFiles, false), false);

  assert.deepEqual(rows.map(row => row.path), [
    "Archivo",
    "Archivo/2025",
    "Archivo/2025/informe.txt",
  ]);
  assert.ok(!rows.some(row => row.path === "Archivo/2025/otro.txt"));
});
