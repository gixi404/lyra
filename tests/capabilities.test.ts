import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const capPath = join(root, "src-tauri/capabilities/migrated.json");
const tauriPath = join(root, "src-tauri/tauri.conf.json");

test("M1-1 migrates.json no grants remove/rename/shell and keeps least-privilege fs set", () => {
  assert.ok(existsSync(capPath), "migrated.json missing");
  const cap = JSON.parse(readFileSync(capPath, "utf8"));
  const perms = cap.permissions as string[];
  assert.ok(!perms.includes("fs:allow-remove"), "remove must not be granted");
  assert.ok(!perms.includes("fs:allow-rename"), "rename must not be granted");
  assert.ok(!perms.includes("shell:allow-open"), "shell open must not be granted");
  assert.ok(!perms.includes("shell:default"), "shell default must not be granted");
  for (const required of ["fs:allow-read-file", "fs:allow-write-file", "fs:allow-read-dir", "fs:allow-mkdir", "fs:allow-exists", "fs:allow-stat"]) {
    assert.ok(perms.includes(required), `${required} must remain`);
  }
});

test("M1-2 tauri.conf.json requires literal leading dot (dotfiles out of fs scope)", () => {
  const conf = JSON.parse(readFileSync(tauriPath, "utf8"));
  assert.equal(conf.plugins?.fs?.requireLiteralLeadingDot, true);
});
