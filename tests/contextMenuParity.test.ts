import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeMenuPosition, anchorHasMoved, isSameMenuPosition, MENU_OFFSET, MENU_PADDING } from "../src/utils/menuPosition.ts";
import {
  menuBackgroundColor,
  menuItemClass,
  menuPanelClass,
  menuSeparatorClass,
  menuTriggerClass,
} from "../src/utils/menuStyles.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

const anchor = { top: 100, left: 500, right: 520, bottom: 120, width: 20, height: 20 };
const viewport = { width: 1000, height: 800 };
const menu = { width: 176, height: 200 };

// ---------------------------------------------------------------------------
// Posicionamiento del menú flotante
// ---------------------------------------------------------------------------

test("menu position: the panel is placed under the anchor when there is room", () => {
  const result = computeMenuPosition({ anchor, menu, viewport });
  assert.equal(result.placement, "bottom");
  assert.equal(result.top, anchor.bottom + MENU_OFFSET);
  assert.equal(result.left, anchor.right - menu.width);
  assert.equal(result.shifted, false);
});

test("menu position: the panel flips above the anchor near the bottom edge", () => {
  const low = { top: 700, left: 500, right: 520, bottom: 720, width: 20, height: 20 };
  const result = computeMenuPosition({ anchor: low, menu, viewport });
  assert.equal(result.placement, "top");
  assert.equal(result.top, low.top - MENU_OFFSET - menu.height);
});

test("menu position: the panel shifts left when there is no room on the right", () => {
  const right = { top: 100, left: 980, right: 1000, bottom: 120, width: 20, height: 20 };
  const result = computeMenuPosition({ anchor: right, menu, viewport });
  assert.equal(result.shifted, true);
  assert.equal(result.left, viewport.width - menu.width - MENU_PADDING);
  assert.ok(result.left + menu.width <= viewport.width - MENU_PADDING);
});

test("menu position: the panel never leaves the viewport on the left edge", () => {
  const left = { top: 100, left: 0, right: 20, bottom: 120, width: 20, height: 20 };
  const result = computeMenuPosition({ anchor: left, menu, viewport, align: "start" });
  assert.equal(result.left, MENU_PADDING);
});

test("menu position: the panel is clamped inside a short viewport", () => {
  const short = { width: 1000, height: 260 };
  const result = computeMenuPosition({ anchor, menu, viewport: short });
  assert.ok(result.top >= MENU_PADDING, "the panel must not overflow the top");
  assert.ok(
    result.top + menu.height <= short.height - MENU_PADDING,
    "the panel must not overflow the bottom"
  );
});

test("menu position: the preferred placement is kept while the panel fits", () => {
  const roomAbove = { top: 600, left: 500, right: 520, bottom: 620, width: 20, height: 20 };
  const kept = computeMenuPosition({ anchor: roomAbove, menu, viewport, preferredPlacement: "top" });
  assert.equal(kept.placement, "top");

  const noRoomBelow = { top: 700, left: 500, right: 520, bottom: 720, width: 20, height: 20 };
  const flipped = computeMenuPosition({ anchor: noRoomBelow, menu, viewport, preferredPlacement: "bottom" });
  assert.equal(flipped.placement, "top", "the panel must flip when the preferred side does not fit");
});

test("menu follow: the anchor is only considered moved when it really changes", () => {
  const snapshot = { top: 100, bottom: 124, left: 500, right: 520 };
  assert.equal(anchorHasMoved(null, snapshot), true, "the first measurement counts as movement");
  assert.equal(anchorHasMoved(snapshot, { ...snapshot }), false);
  assert.equal(anchorHasMoved(snapshot, { ...snapshot, top: 90 }), true);
  assert.equal(anchorHasMoved(snapshot, { ...snapshot, left: 480 }), true);
});

test("menu follow: an unchanged position does not trigger a new render", () => {
  assert.equal(isSameMenuPosition(null, { top: 10, left: 20 }), false);
  assert.equal(isSameMenuPosition({ top: 10, left: 20 }, { top: 10, left: 20 }), true);
  assert.equal(isSameMenuPosition({ top: 10, left: 20 }, { top: 10, left: 21 }), false);
});

// ---------------------------------------------------------------------------
// Estilos compartidos
// ---------------------------------------------------------------------------

test("menu styles: files and folders share a single panel, item and separator style", () => {
  const dayPanel = menuPanelClass(true);
  const nightPanel = menuPanelClass(false);
  assert.ok(dayPanel.includes("w-44"));
  assert.ok(dayPanel.includes("rounded-xl"));
  assert.ok(dayPanel.includes("border-neutral-200"));
  assert.ok(nightPanel.includes("border-zinc-700"));
  assert.ok(dayPanel.includes("shadow-xl"));
  assert.ok(nightPanel.includes("shadow-2xl"));

  assert.ok(menuSeparatorClass(true).includes("border-neutral-100"));
  assert.ok(menuSeparatorClass(false).includes("border-zinc-800/80"));

  assert.equal(menuBackgroundColor(true), "#ffffff");
  assert.equal(menuBackgroundColor(false), "#18181b");
});

test("menu styles: the archive action keeps the red hover in both themes", () => {
  assert.ok(menuItemClass(true, "danger").includes("hover:bg-danger-subtle"));
  assert.ok(menuItemClass(true, "danger").includes("hover:text-danger-text"));
  assert.ok(menuItemClass(false, "danger").includes("hover:bg-rose-500/20"));
  assert.ok(menuItemClass(false, "danger").includes("hover:text-rose-400"));
});

test("menu styles: the file trigger is hidden until hover or focus", () => {
  const hidden = menuTriggerClass(false, { reveal: "hover" });
  assert.ok(hidden.includes("opacity-0"));
  assert.ok(hidden.includes("group-hover:opacity-100"));
  assert.ok(hidden.includes("group-focus-within:opacity-100"));
  assert.ok(hidden.includes("focus-visible:opacity-100"));
  assert.ok(!hidden.includes("display:none"), "hiding must not change the layout");
  assert.ok(!hidden.includes("hidden"), "hiding must not change the layout");

  const visible = menuTriggerClass(false, { reveal: "hover", open: true });
  assert.ok(visible.includes("opacity-100"));
  assert.ok(!visible.includes("opacity-0"), "the trigger stays visible while the menu is open");
});

test("menu styles: the folder trigger is always visible", () => {
  const always = menuTriggerClass(false, { reveal: "always" });
  assert.ok(!always.includes("opacity-0"));
  assert.ok(!always.includes("group-hover:opacity-100"));
  assert.ok(always.includes("rounded-md"), "the folder trigger keeps the shared trigger style");
});

// ---------------------------------------------------------------------------
// Estructura de los componentes
// ---------------------------------------------------------------------------

const menuSources = [
  "src/components/MenuFile.tsx",
  "src/components/MenuPaperFile.tsx",
  "src/components/FolderMenu.tsx",
];

test("context menu: files, archived files and folders render the same shared menu", () => {
  for (const source of menuSources) {
    const code = read(source);
    assert.ok(code.includes("ContextMenu"), `${source} must use the shared ContextMenu`);
    assert.ok(code.includes("MenuItem"), `${source} must use the shared MenuItem`);
    assert.ok(code.includes("MenuSeparator"), `${source} must use the shared MenuSeparator`);
    assert.ok(
      !code.includes("absolute right-0 w-44"),
      `${source} must not render the menu inline (it was clipped by the folder overflow)`
    );
    assert.ok(
      !/className=\{twMerge\(\s*"absolute/.test(code),
      `${source} must not position the menu absolutely inside the row`
    );
  }
});

test("context menu: the shared panel is portaled to the body with fixed positioning", () => {
  const code = read("src/components/ContextMenu.tsx");
  assert.ok(code.includes("createPortal"), "the panel must be rendered through a portal");
  assert.ok(code.includes("document.body"), "the portal target must be the document body");
  assert.ok(code.includes('"fixed'), "the panel must use fixed positioning");
  assert.ok(code.includes("z-[9990]"), "the panel must paint above the explorer list");
  assert.ok(code.includes("useTransition"), "the shared menu must keep the original animation");
  assert.ok(code.includes("duration: 150"), "the shared menu must keep the original timing");
});

test("context menu: the follow loop stops on its own and is cancelled on close", () => {
  const code = read("src/components/ContextMenu.tsx");
  assert.ok(code.includes("cancelAnimationFrame"), "the pending frame must be cancelled");
  assert.ok(code.includes("stopFollow"), "the follow loop must be stopped explicitly");
  assert.ok(code.includes("IDLE_FRAMES"), "the loop must stop when the anchor stays still");
  assert.ok(code.includes("stableFramesRef"), "the loop must track the stability of the anchor");
  assert.ok(code.includes("isSameMenuPosition"), "an unchanged position must not re-render");
  assert.ok(code.includes("ResizeObserver"), "layout changes must restart the measurement");
});

test("context menu: the file trigger is revealed on hover and the folder trigger stays visible", () => {
  assert.ok(read("src/components/MenuFile.tsx").includes('reveal="hover"'));
  assert.ok(read("src/components/MenuPaperFile.tsx").includes('reveal="hover"'));
  assert.ok(!read("src/components/FolderMenu.tsx").includes('reveal="hover"'));
});

test("context menu: Información is always the last action of the menu", () => {
  const sources = [
    "src/components/MenuFile.tsx",
    "src/components/MenuPaperFile.tsx",
    "src/components/FolderMenu.tsx",
  ];
  for (const source of sources) {
    const code = read(source);
    const items = [...code.matchAll(/<MenuItem\b[\s\S]*?\/>/g)].map(match => match[0]);
    assert.ok(items.length >= 2, `${source} must render menu items`);
    const labels = items.map(item => /label="([^"]+)"/.exec(item)?.[1] ?? "");
    const last = labels[labels.length - 1];
    assert.equal(last, "Información", `${source} must end with Información (got ${labels.join(", ")})`);
    assert.equal(labels.filter(label => label === "Información").length, 1, `${source} must show Información once`);
  }
});

test("context menu: every action keeps its icon, including Mover a…", () => {
  const sources = [
    "src/components/MenuFile.tsx",
    "src/components/MenuPaperFile.tsx",
    "src/components/FolderMenu.tsx",
  ];
  for (const source of sources) {
    const code = read(source);
    const items = [...code.matchAll(/<MenuItem\b[\s\S]*?\/>/g)].map(match => match[0]);
    for (const item of items) {
      const label = /label="([^"]+)"/.exec(item)?.[1] ?? "";
      assert.ok(item.includes("icon={"), `${source}: «${label}» must keep its icon`);
    }
  }
  // El icono de «Mover a…» es el mismo en archivos y carpetas.
  assert.ok(/icon=\{MoveIcon\}\s*\n\s*label="Mover a…"/.test(read("src/components/MenuFile.tsx")));
  assert.ok(/icon=\{MoveIcon\}\s*\n\s*label="Mover a…"/.test(read("src/components/FolderMenu.tsx")));
});

test("context menu: the archive action of files keeps the danger style", () => {
  const code = read("src/components/MenuFile.tsx");
  assert.ok(/label=\{d\.MoveToTrashLabel \?\? "Archivar"\}/.test(code));
  assert.ok(/tone="danger"/.test(code));
});

// ---------------------------------------------------------------------------
// Confirmación de archivado de carpetas
// ---------------------------------------------------------------------------

test("folder menu: archiving a folder requires the shared confirmation dialog", () => {
  const code = read("src/components/FolderMenu.tsx");
  assert.ok(code.includes("<Modal"), "folders must reuse the shared dialog");
  assert.ok(code.includes('mode === "archive"'), "the archive action must open a confirmation step");
  assert.ok(code.includes('variant="danger"'), "the confirmation must use the danger variant");
  assert.ok(code.includes("d.MoveToTrashFolder"), "the confirmation must adapt the title to folders");
  assert.ok(code.includes("d.ArchiveFolderDescription"), "the confirmation must mention subfolders and notes");
  assert.ok(code.includes("d.Confirm") && code.includes("d.Cancel"), "the same buttons as the files");

  const archiveItem = code.slice(code.indexOf('label="Archivar"'));
  assert.ok(
    archiveItem.includes('setMode("archive")'),
    "the archive entry must open the confirmation instead of archiving immediately"
  );
  assert.ok(
    !/label="Archivar"[\s\S]{0,400}setArchived\(true\)/.test(code),
    "the archive entry must not archive without confirmation"
  );
});

test("folder menu: archiving is only performed from the confirmation handler", () => {
  const code = read("src/components/FolderMenu.tsx");
  const invokeIndex = code.indexOf('invoke<string[]>("set_folder_archived"');
  assert.ok(invokeIndex > 0, "the archive command must still be used");
  const handlerIndex = code.indexOf("async function setArchived");
  assert.ok(handlerIndex > 0 && handlerIndex < invokeIndex, "the command must live inside the confirmation handler");
  assert.ok(code.includes('onConfirm={() => void setArchived(true)}'), "the confirmation must trigger the archive");
});

// ---------------------------------------------------------------------------
// Popups compartidos
// ---------------------------------------------------------------------------

test("folder menu: rename, move and information reuse the popups of the files", () => {
  const code = read("src/components/FolderMenu.tsx");
  assert.ok(code.includes("MoveItemDialog"), "the move dialog must be shared");
  assert.ok(code.includes("InfoModal"), "the information window must be shared");
  assert.ok(code.includes('mode === "rename"'), "renaming must go through a dialog");
  assert.ok(code.includes("hasInput"), "the rename dialog must reuse the shared input dialog");
});

test("create popup: the visible Crear archivo title is gone", () => {
  const code = read("src/components/CreateNoteDialog.tsx");
  assert.ok(!code.includes("Crear archivo</h3>"), "the Crear archivo title must be removed");
  assert.ok(!/<h2[^>]*>Crear archivo<\/h2>/.test(code), "the Crear archivo title must be removed");
  assert.ok(code.includes("Nombre del nuevo archivo"), "the name field must be preserved");
  assert.ok(code.includes("¿Cómo se llama la obra maestra?"), "the name placeholder must be preserved");
  assert.ok(code.includes("FolderPicker"), "the destination folder picker must be preserved");
  assert.ok(code.includes("d.Cancel") && code.includes("d.Create"), "the buttons must be preserved");
});

// ---------------------------------------------------------------------------
// Popups disponibles en tema claro y oscuro
// ---------------------------------------------------------------------------

test("shared popups: the move, create and folder picker dialogs honour the theme", () => {
  const dialogs = [
    "src/components/MoveItemDialog.tsx",
    "src/components/CreateNoteDialog.tsx",
    "src/components/FolderPicker.tsx",
  ];
  for (const source of dialogs) {
    const code = read(source);
    assert.ok(code.includes("themes()"), `${source} must read the active theme`);
    assert.ok(code.includes("isDay"), `${source} must adapt its colours to the theme`);
    assert.ok(code.includes("bg-white"), `${source} must define a light theme surface`);
    assert.ok(code.includes("bg-zinc-"), `${source} must keep the dark theme surface`);
  }
});

test("shared popups: the move dialog is the same component for files and folders", () => {
  const code = read("src/components/MoveItemDialog.tsx");
  assert.ok(code.includes('kind: "file" | "folder"'), "the dialog must serve both element types");
  assert.ok(code.includes("moveLocalPath(kind"), "the same operation flow must be used");
  assert.ok(
    code.includes('Mover ${displayName} a...') || code.includes('Mover ${baseName} a...'),
    "the folder move dialog must include the folder name in its title"
  );
  assert.ok(code.includes('"Mover archivo"'), "the file move dialog must keep a move title");
});

// ---------------------------------------------------------------------------
// Reglas de negocio intactas
// ---------------------------------------------------------------------------

test("folder menu: the virtual root keeps its protected actions", () => {
  const code = read("src/components/FolderMenu.tsx");
  assert.ok(code.includes('const isRoot = path === ""'), "the virtual root must be detected");
  assert.ok(code.includes("const canManage = !isRoot && !archived && !structural"));
  assert.ok(code.includes("const canCreate = !archived && !structural"));

  const manageBlock = code.slice(code.indexOf("{canManage && <>"), code.indexOf("{archived && <>"));
  assert.ok(manageBlock.includes('label="Renombrar"'), "the rename entry must live in the managed block");
  assert.ok(manageBlock.includes('label="Archivar"'), "the archive entry must live in the managed block");

  const createBlock = code.slice(code.indexOf("{canCreate && <>"), code.indexOf("{canManage && <>"));
  assert.ok(createBlock.includes('label={d.NewNote}'), "the note creation entry must live in the creation block");
  assert.ok(createBlock.includes('label={isRoot ? "Nueva carpeta" : "Nueva subcarpeta"}'), "the folder creation entry must keep root/folder-specific labels");
});
