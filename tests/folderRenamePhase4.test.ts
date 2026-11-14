import { test } from "node:test";
import assert from "node:assert/strict";
import { remapPath, relocateEntry, type FolderOrder } from "../src/utils/folderTree.ts";

function remapRecordValues(map: Record<string, unknown>, oldPath: string, newPath: string): Record<string, unknown> {
  const rename = (path: string) => remapPath(path, oldPath, newPath);
  const next: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(map)) {
    next[rename(path)] = Array.isArray(item) ? item.map((entry: string) => rename(entry)) : item;
  }
  return next;
}

function remapStringRecord(map: FolderOrder, oldPath: string, newPath: string): FolderOrder {
  const rename = (path: string) => remapPath(path, oldPath, newPath);
  const next: FolderOrder = {};
  for (const [parent, entries] of Object.entries(map)) {
    if (!Array.isArray(entries)) continue;
    next[rename(parent)] = entries.map((entry: string) => rename(entry));
  }
  return next;
}

test("folder rename remaps folderExpanded for folder and all descendants, preserves unrelated and Lyra", () => {
  const expanded = {
    "root:lyra": true,
    "Desarrollo": true,
    "Desarrollo/Backend": false,
    "Desarrollo/Backend/API": true,
    "Desarrollo2": false,
    "Trabajo/Desarrollo": true,
  };
  const next = remapRecordValues(expanded, "Desarrollo", "Programacion") as Record<string, boolean>;
  assert.deepEqual(next, {
    "root:lyra": true,
    "Programacion": true,
    "Programacion/Backend": false,
    "Programacion/Backend/API": true,
    "Desarrollo2": false,
    "Trabajo/Desarrollo": true,
  });
});

test("folder rename remaps folderOrder keys and values preserving positions", () => {
  const order: FolderOrder = {
    "": ["Trabajo", "Desarrollo", "Desarrollo2"],
    "Desarrollo": ["Desarrollo/Backend", "Desarrollo/Docs"],
    "Desarrollo/Backend": ["Desarrollo/Backend/API"],
    "Trabajo": ["Trabajo/Desarrollo"],
  };
  const next = remapStringRecord(order, "Desarrollo", "Programacion");
  assert.deepEqual(next, {
    "": ["Trabajo", "Programacion", "Desarrollo2"],
    "Programacion": ["Programacion/Backend", "Programacion/Docs"],
    "Programacion/Backend": ["Programacion/Backend/API"],
    "Trabajo": ["Trabajo/Desarrollo"],
  });
});

test("folder rename remaps fileOrder keys and values preserving manual positions", () => {
  const fileOrder: FolderOrder = {
    "": ["raiz.md", "Desarrollo2-nota.md"],
    "Desarrollo": ["Desarrollo/b.md", "Desarrollo/a.md"],
    "Desarrollo/Backend": ["Desarrollo/Backend/api.txt"],
    "Trabajo": ["Trabajo/desarrollo-nota.md"],
  };
  const next = remapStringRecord(fileOrder, "Desarrollo", "Programacion");
  assert.deepEqual(next, {
    "": ["raiz.md", "Desarrollo2-nota.md"],
    "Programacion": ["Programacion/b.md", "Programacion/a.md"],
    "Programacion/Backend": ["Programacion/Backend/api.txt"],
    "Trabajo": ["Trabajo/desarrollo-nota.md"],
  });
});

test("remapPath preserves references with similar prefixes not related to renamed folder", () => {
  assert.equal(remapPath("Desarrollo2/nota.md", "Desarrollo", "Programacion"), "Desarrollo2/nota.md");
  assert.equal(remapPath("Desarrollos/nota.md", "Desarrollo", "Programacion"), "Desarrollos/nota.md");
  assert.equal(remapPath("Trabajo/Desarrollo/nota.md", "Desarrollo", "Programacion"), "Trabajo/Desarrollo/nota.md");
  assert.equal(remapPath("Desarrollo", "Desarrollo", "Programacion"), "Programacion");
  assert.equal(remapPath("Desarrollo/Sub/nota.md", "Desarrollo", "Programacion"), "Programacion/Sub/nota.md");
});

test("folder rename remap is idempotent for already-migrated paths", () => {
  const order: FolderOrder = {
    "": ["Trabajo", "Programacion", "Desarrollo2"],
    "Programacion": ["Programacion/Backend"],
    "Programacion/Backend": ["Programacion/Backend/API"],
  };
  const once = remapStringRecord(order, "Desarrollo", "Programacion");
  const twice = remapStringRecord(once, "Desarrollo", "Programacion");
  assert.deepEqual(twice, once);
});

test("note rename in same parent preserves index via relocateEntry", () => {
  const order = relocateEntry({ "A": ["A/n1.md", "A/n2.md", "A/n3.md"] }, { oldPath: "A/n2.md", newPath: "A/n2-renamed.md" });
  assert.deepEqual(order["A"], ["A/n1.md", "A/n2-renamed.md", "A/n3.md"]);
});

test("remap for descendant note preference keys preserves unrelated keys", () => {
  const rename = (path: string) => remapPath(path, "Desarrollo", "Programacion");
  const keys = [
    "Desarrollo/nota.md-modified",
    "Desarrollo/Backend/api.txt-scroll",
    "Desarrollo2/nota.md-modified",
    "Trabajo/Desarrollo/nota.md-modified",
  ];
  const remapped = keys.map(key => {
    const suffix = key.endsWith("-modified") ? "-modified" : "-scroll";
    const base = key.slice(0, -suffix.length);
    return `${rename(base)}${suffix}`;
  });
  assert.deepEqual(remapped, [
    "Programacion/nota.md-modified",
    "Programacion/Backend/api.txt-scroll",
    "Desarrollo2/nota.md-modified",
    "Trabajo/Desarrollo/nota.md-modified",
  ]);
});
