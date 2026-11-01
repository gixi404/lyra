import test from "node:test";
import assert from "node:assert/strict";
import { noteLabel, noteSuccessMessage, noteTitle } from "../src/utils/noteName.ts";

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
