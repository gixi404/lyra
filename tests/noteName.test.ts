import test from "node:test";
import assert from "node:assert/strict";
import { ensureNoteExtension, hasSupportedNoteExtension, noteLabel, noteSuccessMessage, noteTitle } from "../src/utils/noteName.ts";

test("note titles remove only the final supported extension", () => {
  assert.equal(noteTitle("ideas.md"), "ideas");
  assert.equal(noteTitle("tareas.txt"), "tareas");
  assert.equal(noteTitle("proyecto.v2.md"), "proyecto.v2");
  assert.equal(noteTitle("Notas personales.MD"), "Notas personales");
  assert.equal(noteTitle("Café ☕.txt"), "Café ☕");
  assert.equal(noteTitle("Sin extensión"), "Sin extensión");
  assert.equal(noteTitle("informe.pdf"), "informe.pdf");
  assert.equal(noteTitle(".md"), ".md");
});

test("operation toasts use a natural phrase and the correct note identity", () => {
  assert.equal(noteSuccessMessage("ideas.md", "archived"), "«ideas» se archivó");
  assert.equal(noteSuccessMessage("Ideas.txt", "recovered"), "«Ideas» se recuperó");
  assert.equal(noteSuccessMessage("Ideas.txt", "deleted"), "«Ideas» se eliminó");
  assert.equal(noteSuccessMessage("nuevo.v2.md", "renamed"), "«nuevo.v2» se renombró");
  assert.equal(noteLabel("informe.pdf"), "«informe.pdf»");
});

test("una nota nueva sin extensión recibe .txt", () => {
  assert.equal(ensureNoteExtension("nota vacía"), "nota vacía.txt");
  assert.equal(ensureNoteExtension("ideas"), "ideas.txt");
});

test("las notas Markdown conservan .md", () => {
  assert.equal(ensureNoteExtension("apuntes.md"), "apuntes.md");
  assert.equal(ensureNoteExtension("proyecto.v2.md"), "proyecto.v2.md");
  assert.equal(ensureNoteExtension("borrador", "plantilla.md"), "borrador.md");
});

test("la extensión resuelta es aceptada por el listado", () => {
  const resolved = ensureNoteExtension("nota vacía");
  assert.equal(hasSupportedNoteExtension(resolved), true);
  assert.ok(resolved.endsWith(".txt"));
});

test("nombres con múltiples puntos conservan la extensión final", () => {
  assert.equal(ensureNoteExtension("proyecto.v2.final"), "proyecto.v2.final.txt");
  assert.equal(ensureNoteExtension("archivo.tar.gz.md"), "archivo.tar.gz.md");
});

test("no se agregan extensiones duplicadas", () => {
  assert.equal(ensureNoteExtension("nota.txt"), "nota.txt");
  assert.equal(ensureNoteExtension("nota.md"), "nota.md");
  assert.equal(ensureNoteExtension("nota.TXT"), "nota.TXT");
});
