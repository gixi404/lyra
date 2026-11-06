import test from "node:test";
import assert from "node:assert/strict";
import {
  getFileBaseName,
  getFileDirectory,
  getLegacyFileName,
  hasSupportedNoteExtension,
  normalizeStoredFileNames,
  noteLabel,
  noteSuccessMessage,
  noteTitle,
} from "../src/utils/noteName.ts";

test("hasSupportedNoteExtension valida extensiones compatibles e incompatibles en rutas anidadas", () => {
  assert.equal(hasSupportedNoteExtension("nota.txt"), true);
  assert.equal(hasSupportedNoteExtension("trabajo/proyecto.md"), true);
  assert.equal(hasSupportedNoteExtension("trabajo/clientes/reunion.txt"), true);
  assert.equal(hasSupportedNoteExtension("desarrollo/rust/apuntes.rs"), true);
  assert.equal(hasSupportedNoteExtension("trabajo/foto.png"), false);
  assert.equal(hasSupportedNoteExtension("trabajo/binario.exe"), false);
  assert.equal(hasSupportedNoteExtension("trabajo/documento.pdf"), false);
});

test("getFileDirectory y getFileBaseName extraen correctamente carpetas y nombres", () => {
  // Archivo en la raíz
  assert.equal(getFileDirectory("nota.txt"), "");
  assert.equal(getFileBaseName("nota.txt"), "nota.txt");

  // Archivo en una subcarpeta
  assert.equal(getFileDirectory("trabajo/proyecto.md"), "trabajo");
  assert.equal(getFileBaseName("trabajo/proyecto.md"), "proyecto.md");

  // Archivo anidado en múltiples niveles
  assert.equal(getFileDirectory("trabajo/clientes/reunion.txt"), "trabajo/clientes");
  assert.equal(getFileBaseName("trabajo/clientes/reunion.txt"), "reunion.txt");

  // Separadores Windows normalizados
  assert.equal(getFileDirectory("desarrollo\\rust\\apuntes.rs"), "desarrollo/rust");
  assert.equal(getFileBaseName("desarrollo\\rust\\apuntes.rs"), "apuntes.rs");
});

test("noteTitle oculta .txt y .md pero conserva extensiones técnicas en subcarpetas", () => {
  // Raíz
  assert.equal(noteTitle("nota.txt"), "nota");
  assert.equal(noteTitle("ideas.md"), "ideas");
  assert.equal(noteTitle("config.json"), "config.json");

  // Subcarpeta simple
  assert.equal(noteTitle("trabajo/proyecto.md"), "proyecto");
  assert.equal(noteTitle("personal/ideas.md"), "ideas");

  // Subcarpeta multinivel
  assert.equal(noteTitle("trabajo/clientes/reunion.txt"), "reunion");

  // Extensiones técnicas
  assert.equal(noteTitle("desarrollo/rust/apuntes.rs"), "apuntes.rs");
  assert.equal(noteTitle("trabajo/scripts/backup.sh"), "backup.sh");
  assert.equal(noteTitle("backend/schema.sql"), "schema.sql");
});

test("noteLabel y noteSuccessMessage usan el título base adecuado en subcarpetas", () => {
  assert.equal(noteLabel("trabajo/clientes/reunion.txt"), "«reunion»");
  assert.equal(noteSuccessMessage("trabajo/clientes/reunion.txt", "archived"), "«reunion» se archivó");
  assert.equal(noteSuccessMessage("trabajo/clientes/reunion.txt", "recovered"), "«reunion» se recuperó");
  assert.equal(noteSuccessMessage("trabajo/clientes/reunion.txt", "deleted"), "«reunion» se eliminó");
  assert.equal(noteSuccessMessage("trabajo/clientes/reunion.txt", "renamed"), "«reunion» se renombró");
});

test("getLegacyFileName conserva la ruta de carpetas para evitar colisiones en localStorage", () => {
  assert.equal(getLegacyFileName("nota.txt"), "nota");
  assert.equal(getLegacyFileName("trabajo/reunion.txt"), "trabajo/reunion");
  assert.equal(getLegacyFileName("personal/reunion.txt"), "personal/reunion");
  assert.notEqual(getLegacyFileName("trabajo/reunion.txt"), getLegacyFileName("personal/reunion.txt"));
});

test("normalizeStoredFileNames preserva identidades de rutas anidadas", () => {
  const currentFiles = [
    "nota.txt",
    "trabajo/proyecto.md",
    "trabajo/clientes/reunion.txt",
    "personal/notas.txt",
    "desarrollo/notas.txt",
  ];

  const paper = [
    "nota.txt",
    "trabajo/clientes/reunion.txt",
    "personal/notas.txt",
  ];

  const normalized = normalizeStoredFileNames(paper, currentFiles);
  assert.deepEqual(normalized, [
    "nota.txt",
    "trabajo/clientes/reunion.txt",
    "personal/notas.txt",
  ]);

  // Si se guardó con nombre legacy sin extensión en subcarpeta
  const legacyPaper = ["trabajo/proyecto"];
  const resolved = normalizeStoredFileNames(legacyPaper, currentFiles);
  assert.deepEqual(resolved, ["trabajo/proyecto.md"]);
});

test("Dos archivos homónimos en distintas carpetas se distinguen sin colisionar", () => {
  const files = [
    "nota.txt",
    "trabajo/notas.txt",
    "personal/notas.txt",
    "desarrollo/rust/apuntes.rs",
  ];

  // Cálculo de homónimos
  const counts = new Map<string, number>();
  for (const f of files) {
    const title = noteTitle(f).toLowerCase();
    counts.set(title, (counts.get(title) || 0) + 1);
  }

  const homonymTitles = new Set<string>();
  for (const [title, count] of counts.entries()) {
    if (count > 1) homonymTitles.add(title);
  }

  assert.equal(homonymTitles.has("notas"), true);
  assert.equal(homonymTitles.has("nota"), false);
  assert.equal(homonymTitles.has("apuntes.rs"), false);

  // Distinción visual por carpeta
  const trabajoDir = getFileDirectory("trabajo/notas.txt");
  const personalDir = getFileDirectory("personal/notas.txt");
  const raizDir = getFileDirectory("nota.txt");

  assert.equal(trabajoDir, "trabajo");
  assert.equal(personalDir, "personal");
  assert.equal(raizDir, "");
});

test("Filtrado de búsqueda abarca tanto el nombre como las subcarpetas", () => {
  const files = [
    "nota.txt",
    "trabajo/proyecto.md",
    "trabajo/clientes/reunion.txt",
    "personal/ideas.md",
    "desarrollo/rust/apuntes.rs",
  ];

  // Búsqueda por subcarpeta "trabajo"
  const trabajoMatch = files.filter(f => f.toLowerCase().includes("trabajo"));
  assert.deepEqual(trabajoMatch, ["trabajo/proyecto.md", "trabajo/clientes/reunion.txt"]);

  // Búsqueda por subcarpeta profunda "clientes"
  const clientesMatch = files.filter(f => f.toLowerCase().includes("clientes"));
  assert.deepEqual(clientesMatch, ["trabajo/clientes/reunion.txt"]);

  // Búsqueda por nombre de archivo "apuntes"
  const apuntesMatch = files.filter(f => f.toLowerCase().includes("apuntes"));
  assert.deepEqual(apuntesMatch, ["desarrollo/rust/apuntes.rs"]);
});
