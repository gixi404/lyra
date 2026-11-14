import test from "node:test";
import assert from "node:assert/strict";
import { validateFolderName } from "../src/utils/folderNameValidation.ts";

test("validateFolderName accepts valid cross-platform folder names", () => {
  for (const name of ["Proyectos", "mi carpeta", "A_B-1", "café", "Proyecto 2026"]) {
    assert.deepEqual(validateFolderName(name), { ok: true }, name);
  }
});

test("validateFolderName rejects empty and edge-whitespace names", () => {
  assert.equal(validateFolderName("").ok, false);
  assert.equal(validateFolderName("   ").ok, false);
  assert.equal(validateFolderName(" nombre").ok, false);
  assert.equal(validateFolderName("nombre ").ok, false);
});

test("validateFolderName rejects names incompatible with Fedora and Windows", () => {
  const invalid = [
    "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b",
    ".oculta", "oculta.", "CON", "con.txt", "NUL", "LPT1",
  ];
  for (const name of invalid) {
    assert.equal(validateFolderName(name).ok, false, name);
  }
  const control = "abc\u0001def";
  assert.equal(validateFolderName(control).ok, false);
});

test("validateFolderName rejects overly long names", () => {
  assert.equal(validateFolderName("a".repeat(61)).ok, false);
  assert.equal(validateFolderName("a".repeat(60)).ok, true);
});
