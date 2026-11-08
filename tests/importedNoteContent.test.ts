import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/utils/fileImporter.ts"), "utf8");

test("A1-1 discriminated signature distinguishes content from error", () => {
  assert.ok(src.includes('export type ImportedNoteContent'), "discriminated type must exist");
  assert.ok(src.includes('{ ok: true; content: string }'), "ok true variant required");
  assert.ok(src.includes('{ ok: false; error: string }'), "ok false variant required");
  assert.ok(!src.includes('Promise<string>'), "must not return plain string");
});

test("A1-2 no falsy empty-string sentinel remains in read path", () => {
  // The function must not conclude with `return ""` — every failure is ok:false.
  const fnStart = src.indexOf("export async function readImportedNoteContent");
  const fnEnd = src.indexOf("}", src.indexOf("return { ok: true, content }"));
  const fnBody = src.slice(fnStart, fnEnd + 1);
  assert.ok(!fnBody.match(/return\s+""\s*;?/m), "read path must not return bare empty string");
  assert.ok(fnBody.includes('ok: false'), "failure branch must use ok:false");
});

test("A1-3 navigation guarded by ok check, not by truthiness", () => {
  const guard = src.indexOf("if (!res.ok)");
  assert.ok(guard !== -1, "handleExternalFileImport must check !res.ok before navigating");
  const between = src.slice(guard, guard + 600);
  assert.ok(between.includes("notification("), "must notify on read error");
  assert.ok(between.includes('"error"'), "must notify as error on read error");
  assert.ok(between.includes("return finish("), "must return without navigating on error");
  const navIdx = src.indexOf("navigateTo(PAGES.file);", guard);
  assert.ok(navIdx > guard && navIdx < guard + 600, "navigation must appear after the guard");
});
