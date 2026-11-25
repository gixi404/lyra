import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from > -1, `missing start marker: ${start}`);
  assert.ok(to > from, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

test("creating a folder from the destination picker does not submit the file form", () => {
  const modal = read("src/components/Modal.tsx");
  const modalSubmit = sliceBetween(modal, "const handleSubmit =", "const handleBackdropClick =");
  const preventIdx = modalSubmit.indexOf("e.preventDefault()");
  const stopIdx = modalSubmit.indexOf("e.stopPropagation()");
  const confirmIdx = modalSubmit.indexOf("onConfirm(");
  assert.ok(preventIdx > -1, "the folder dialog must prevent its own form submission");
  assert.ok(stopIdx > preventIdx, "the folder dialog submit must stop propagation to ancestor forms");
  assert.ok(confirmIdx > stopIdx, "only the folder dialog must handle its submit");

  const dialog = read("src/components/CreateNoteDialog.tsx");
  const fileSubmit = sliceBetween(dialog, "const handleSubmit =", "const handleBackdropClick =");
  const ownFormIdx = fileSubmit.indexOf("e.target !== e.currentTarget");
  const createIdx = fileSubmit.indexOf("onCreate(name.trim(), folder)");
  assert.ok(ownFormIdx > -1, "the file dialog must ignore submits bubbled from nested portal forms");
  assert.ok(createIdx > ownFormIdx, "the file must only be created from the dialog's own submit");
});

test("the destination picker selects the created folder and keeps the previous target on cancel or error", () => {
  const picker = read("src/components/FolderPicker.tsx");
  const createFn = sliceBetween(picker, "async function create", "const title =");
  const awaitIdx = createFn.indexOf("await onCreateFolder(value, name)");
  const selectIdx = createFn.indexOf("onChange(path)");
  const closeIdx = createFn.indexOf("setCreating(false)");
  assert.ok(awaitIdx > -1, "the folder must be created with the currently selected folder as parent");
  assert.ok(selectIdx > awaitIdx, "the created folder must become the selected destination");
  assert.ok(closeIdx > selectIdx, "the dialog must close only after selecting the new destination");

  const catchBlock = createFn.slice(createFn.indexOf("} catch"));
  assert.equal(/onChange\s*\(/.test(catchBlock), false, "an error must keep the previous destination");

  const closeFn = sliceBetween(picker, "function closeCreate", "async function create");
  assert.equal(/onChange\s*\(/.test(closeFn), false, "cancelling must keep the previous destination");
});

test("the file dialog preserves the typed data and creates the file in the selected destination", () => {
  const dialog = read("src/components/CreateNoteDialog.tsx");
  const resetEffect = sliceBetween(dialog, "useEffect(() => {", "  }, [isOpen, initialFolder]);");
  assert.ok(resetEffect.includes("setName(\"\")"), "the form must reset only when the dialog opens");
  assert.ok(resetEffect.includes("setFolder(initialFolder)"), "the initial destination must come from the opening context");
  assert.equal(resetEffect.includes("folders"), false, "creating a folder must not reset the typed file name or destination");
  assert.ok(dialog.includes("onCreate(name.trim(), folder)"), "the file must use the destination selected in the picker");

  const form = read("src/components/Form.tsx");
  assert.ok(form.includes("setCreatedNoteIntent(displayName, \"active\")"), "returning from the editor must keep the created-note intent");
  const router = read("src/router.tsx");
  assert.ok(router.includes("expandCreatedNoteOnReturn("), "returning from the editor must keep the automatic expansion and scroll reveal");
});
