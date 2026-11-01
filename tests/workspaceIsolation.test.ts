import test from "node:test";
import assert from "node:assert";
import {
  getNotesDir,
  resetNotesDir,
  setNotesDir,
} from "../src/utils/workspacePaths.ts";
import { reconcileDraftState } from "../src/utils/draftRecovery.ts";

/** Same shape the app uses: directory + file name, without touching the disk. */
function notePath(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

test("F1 isolation: two workspaces never resolve to the same note path", () => {
  resetNotesDir();
  setNotesDir("lyra/workspaces/ws_001");
  const first = notePath(getNotesDir(), "Nota.md");

  setNotesDir("lyra/workspaces/ws_002");
  const second = notePath(getNotesDir(), "Nota.md");

  assert.equal(first, "lyra/workspaces/ws_001/Nota.md");
  assert.equal(second, "lyra/workspaces/ws_002/Nota.md");
  assert.notEqual(first, second);
  assert.equal(first.startsWith("lyra/workspaces/ws_002/"), false);
  assert.equal(second.startsWith("lyra/workspaces/ws_001/"), false);
});

test("F1 isolation: switching workspace moves every path, not just some", () => {
  resetNotesDir();
  setNotesDir("lyra/workspaces/ws_003");

  const names = ["A.md", "B.txt", "carpeta/../C.md"];
  const before = names.map(name => notePath(getNotesDir(), name));

  setNotesDir("lyra/workspaces/ws_004");
  const after = names.map(name => notePath(getNotesDir(), name));

  for (let index = 0; index < names.length; index += 1) {
    assert.notEqual(before[index], after[index]);
    assert.ok(after[index].startsWith("lyra/workspaces/ws_004/"));
    assert.equal(after[index].includes("/ws_003/"), false);
  }
});

test("F1 isolation: the legacy root is never returned as a note directory", () => {
  resetNotesDir();
  assert.throws(() => getNotesDir(), /espacio de trabajo/);

  setNotesDir("lyra/workspaces/ws_001");
  const inside = notePath(getNotesDir(), "Nota.md");
  assert.equal(inside, "lyra/workspaces/ws_001/Nota.md");
  assert.equal(inside.startsWith("lyra/workspaces/"), true);
});

test("F1 isolation: an unsafe directory cannot pull notes out of place", () => {
  resetNotesDir();
  setNotesDir("lyra/workspaces/ws_001");

  // A backend payload cannot move reads outside Documents/lyra/workspaces.
  assert.equal(setNotesDir("../otra"), false);
  assert.equal(setNotesDir("lyra/workspaces/ws_001/../../ws_002"), false);
  assert.equal(setNotesDir("/tmp/lyra"), false);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_001");

  assert.equal(notePath(getNotesDir(), "Nota.md"), "lyra/workspaces/ws_001/Nota.md");
});

test("F1 drafts: a same-name pending draft remains available after moving to a workspace", async () => {
  resetNotesDir();
  setNotesDir("lyra/workspaces/ws_001");
  let cleared = false;
  const result = await reconcileDraftState({
    fileName: "A.md",
    diskContent: "saved note",
    draft: { content: "pending edit", updatedAt: 200 },
    diskMtime: 100,
    saveFile: async () => { throw new Error("unexpected write"); },
    readFile: async () => "",
    fileExists: async () => false,
    clearDraft: () => { cleared = true; },
  });
  assert.equal(result.action, "use_draft");
  assert.equal(result.contentToLoad, "pending edit");
  assert.equal(cleared, false);
  assert.equal(getNotesDir(), "lyra/workspaces/ws_001");
});
