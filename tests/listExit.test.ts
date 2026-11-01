import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";
import { includeRetainedExits } from "../src/utils/listExit.ts";
import { noteSuccessMessage } from "../src/utils/noteName.ts";

test("archive toast uses the current note title without its extension", () => {
  assert.equal(noteSuccessMessage("ideas.md", "archived"), "«ideas» se archivó");
  assert.equal(noteSuccessMessage("Notas personales.md", "archived"), "«Notas personales» se archivó");
});

test("an archived note remains renderable until its successful exit commits", () => {
  const name = "ideas.md";
  fileStore.getState().setFilesWithStats([name, "other.md"], {});
  fileStore.getState().setRenderedOrder("active", [name, "other.md"]);
  fileStore.getState().retainForExit(name, "active");
  assert.deepEqual(includeRetainedExits(["other.md"], fileStore.getState().retainedExits, "active"), [name, "other.md"]);
  assert.deepEqual(includeRetainedExits([], fileStore.getState().retainedExits, "paper"), []);
  fileStore.getState().releaseRetainedExit(name);
  assert.deepEqual(includeRetainedExits(["other.md"], fileStore.getState().retainedExits, "active"), ["other.md"]);
});

test("an in-flight deletion survives list refresh and is released after the exit", () => {
  const name = "tareas.md";
  fileStore.getState().setFilesWithStats([name], {});
  fileStore.getState().setRenderedOrder("paper", [name]);
  fileStore.getState().retainForExit(name, "paper");
  fileStore.getState().setFilesWithStats([], {});
  assert.deepEqual(includeRetainedExits([], fileStore.getState().retainedExits, "paper"), [name]);
  let committed = false;
  fileStore.getState().scheduleExitAnimation(name, () => { committed = true; }, 0);
  assert.equal(committed, true);
  assert.deepEqual(fileStore.getState().retainedExits, []);
});

test("rapid exits retain their original positions while other notes stay ordered", () => {
  fileStore.getState().setRenderedOrder("active", ["a.md", "b.md", "c.md", "d.md"]);
  fileStore.getState().retainForExit("b.md", "active");
  fileStore.getState().retainForExit("d.md", "active");
  assert.deepEqual(
    includeRetainedExits(["a.md", "c.md"], fileStore.getState().retainedExits, "active"),
    ["a.md", "b.md", "c.md", "d.md"],
  );
  fileStore.getState().releaseRetainedExit("b.md");
  fileStore.getState().releaseRetainedExit("d.md");
});
