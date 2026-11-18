import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

test("note creation defers folder expansion until returning from the editor", () => {
  const form = read("src/components/Form.tsx");
  const fileFlowStart = form.indexOf("async function fileManagement");
  const fileFlowEnd = form.indexOf("} catch {", fileFlowStart);
  assert.ok(fileFlowStart > -1 && fileFlowEnd > fileFlowStart, "fileManagement flow must exist");
  const successFlow = form.slice(fileFlowStart, fileFlowEnd);
  const createIdx = successFlow.indexOf("await createFile(file.name, file.content)");
  const intentIdx = successFlow.indexOf("setCreatedNoteIntent(");
  const navIdx = successFlow.indexOf('goTo(PAGES.file)');
  assert.ok(createIdx > -1, "must create note physically");
  assert.ok(intentIdx > createIdx, "must record the created note after successful creation");
  assert.ok(navIdx > intentIdx, "must navigate after recording the intent");
  assert.equal(successFlow.includes('setItem("folderExpanded"'), false, "creation must not expand the visible list");
  const router = read("src/router.tsx");
  assert.ok(router.includes("expandCreatedNoteOnReturn("), "return navigation must apply the deferred expansion");
});

test("note creation failure path does not change expansion or listing state", () => {
  const form = read("src/components/Form.tsx");
  const fileFlowStart = form.indexOf("async function fileManagement");
  const fileFlowEnd = form.indexOf("  function handleCreateConfirm");
  assert.ok(fileFlowStart > -1 && fileFlowEnd > fileFlowStart);
  const catchFlow = form.slice(form.indexOf("} catch {", fileFlowStart), fileFlowEnd);
  assert.equal(/expandAncestorsForNote|setItem\(.folderExpanded|setFiles|setFilesWithStats|updateListFiles/.test(catchFlow), false);
});

test("note creation does not introduce a parallel refresh mechanism", () => {
  const form = read("src/components/Form.tsx");
  const fileFlowStart = form.indexOf("async function fileManagement");
  const fileFlowEnd = form.indexOf("  function handleCreateConfirm");
  const fileFlow = form.slice(fileFlowStart, fileFlowEnd);
  assert.equal(/setInterval|window\.addEventListener\(.focus|list_note_files_with_stats|getFilesWithStats\(/.test(fileFlow), false);
  const list = read("src/pages/List.tsx");
  assert.equal(list.includes("startLocalFirstListInitialization"), true, "mount-time initialization remains the list refresh mechanism");
});

test("context menus use Nueva nota label for Lyra and physical folders", () => {
  const menu = read("src/components/FolderMenu.tsx");
  assert.equal(menu.includes('label={d.NewNote}'), true);
  assert.equal(menu.includes('label="Crear archivo"'), false);
  const dialog = read("src/components/CreateNoteDialog.tsx");
  assert.equal(dialog.includes('aria-label={d.NewNote}'), true);
  const dict = read("src/utils/dictionary.ts");
  assert.equal(dict.includes('NewNote: "Nueva nota"'), true);
});
