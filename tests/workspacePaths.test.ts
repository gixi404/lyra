import test from "node:test";
import assert from "node:assert";
import {
  getNotesDir,
  isWorkspaceNotesDir,
  resetNotesDir,
  setNotesDir,
} from "../src/utils/workspacePaths.ts";

test("F1 paths: note access is blocked before the backend identifies a workspace", () => {
  resetNotesDir();
  assert.throws(() => getNotesDir(), /espacio de trabajo/);
  assert.equal(isWorkspaceNotesDir(), false);
});

test("F1 paths: a workspace directory reported by the backend is accepted", () => {
  resetNotesDir();
  assert.equal(setNotesDir("lyra/workspaces/ws_001"), true);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_001");
  assert.equal(isWorkspaceNotesDir(), true);

  assert.equal(setNotesDir("lyra/workspaces/ws_012"), true);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_012");
});

test("F1 paths: trailing slashes and Windows separators are normalised", () => {
  resetNotesDir();
  assert.equal(setNotesDir("lyra/workspaces/ws_003/"), true);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_003");

  assert.equal(setNotesDir("lyra\\workspaces\\ws_004"), true);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_004");
});

test("F1 paths: unsafe or unexpected directories are rejected and the previous one is kept", () => {
  resetNotesDir();
  setNotesDir("lyra/workspaces/ws_001");

  // Absolute paths, traversal and unrelated roots must never redirect notes.
  const rejected = [
    "",
    "   ",
    "/home/user/Documents/lyra",
    "C:/Users/user/Documents/lyra",
    "lyra/../otra",
    "lyra/workspaces/../../otra",
    "lyra/workspaces/ws_001/extra",
    "lyra/workspaces/not_a_workspace",
    "lyra/workspaces/ws_1",
    "otra/workspaces/ws_001",
    "lyra",
    "workspaces/ws_001",
  ];

  for (const candidate of rejected) {
    assert.equal(setNotesDir(candidate), false, `should reject ${JSON.stringify(candidate)}`);
    assert.equal(getNotesDir(), "lyra/workspaces/ws_001");
  }

  assert.equal(setNotesDir(null), false);
  assert.equal(setNotesDir(undefined), false);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_001");
});

test("F1 paths: resetting blocks note access", () => {
  setNotesDir("lyra/workspaces/ws_005");
  resetNotesDir();
  assert.throws(() => getNotesDir(), /espacio de trabajo/);
  assert.equal(isWorkspaceNotesDir(), false);
});
