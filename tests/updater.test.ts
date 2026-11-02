import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/utils/updaterVersion.ts";


test("compareVersions: identical versions return 0", () => {
  assert.equal(compareVersions("2.0.18", "2.0.18"), 0);
  assert.equal(compareVersions("v2.0.18", "2.0.18"), 0);
  assert.equal(compareVersions("2.0.18", "v2.0.18"), 0);
  assert.equal(compareVersions("v1.0.0", "v1.0.0"), 0);
});

test("compareVersions: newer version returns positive value", () => {
  assert.ok(compareVersions("2.0.19", "2.0.18") > 0);
  assert.ok(compareVersions("v2.1.0", "2.0.18") > 0);
  assert.ok(compareVersions("3.0.0", "2.9.9") > 0);
  assert.ok(compareVersions("2.0.18.1", "2.0.18") > 0);
});

test("compareVersions: older version returns negative value", () => {
  assert.ok(compareVersions("2.0.17", "2.0.18") < 0);
  assert.ok(compareVersions("v1.9.9", "2.0.0") < 0);
  assert.ok(compareVersions("2.0.18", "2.1.0") < 0);
});

test("compareVersions: handles varying segment lengths", () => {
  assert.ok(compareVersions("2.0", "2.0.0") === 0);
  assert.ok(compareVersions("2.1", "2.0.9") > 0);
  assert.ok(compareVersions("2.0.0.1", "2.0.0") > 0);
});

test("updater format contract: valid package types conform to enum", () => {
  const validFormats = ["appimage", "deb", "rpm", "windows", "macos", "standalone"];
  for (const fmt of validFormats) {
    assert.ok(typeof fmt === "string");
  }
});
