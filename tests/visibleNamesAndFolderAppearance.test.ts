import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";
import { configStore } from "../src/store/configStore.ts";
import { migratePreferences } from "../src/utils/pathOperations.ts";
import {
  clearVisibleName,
  displayFolderName,
  displayNoteLabel,
  displayNoteName,
  editableNoteBaseName,
  getDisplaySegment,
  getVisibleSegment,
  isPhysicallySafeSegment,
  pruneVisibleNameMetadata,
  remapVisibleNames,
  removeVisibleNamesForPath,
  resolvePhysicalSegment,
  setVisibleNameForPath,
} from "../src/utils/visibleNames.ts";
import {
  commitVisibleName,
  resolveNewFolderPhysicalPath,
  resolveNewNotePhysicalPath,
  resolveRenamedNotePhysicalPath,
  validateVisibleEntryName,
} from "../src/utils/visibleNameOps.ts";
import {
  getFolderIconColor,
  getFolderIconColors,
  getFolderIcons,
  getFolderTextColor,
  getFolderTextColors,
  remapFolderAppearance,
  resolveFolderColor,
  resolveFolderIcon,
  setFolderColor,
  setFolderIcon,
  setFolderIconColor,
  setFolderTextColor,
} from "../src/utils/folderAppearance.ts";

function setupWindow() {
  const local = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (local.has(k) ? local.get(k)! : null),
      setItem: (k: string, v: string) => { local.set(k, String(v)); },
      removeItem: (k: string) => { local.delete(k); },
      clear: () => { local.clear(); },
      get length() { return local.size; },
      key: (i: number) => Array.from(local.keys())[i] ?? null,
    },
    matchMedia: () => ({ matches: false, media: "", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent: () => false }),
    __TAURI_INTERNALS__: {
      invoke: async () => undefined,
    },
    __LYRA_METADATA_TEST_BYPASS__: true,
  };
  configStore.setState({ prefTick: 0 } as never);
  fileStore.setState({
    files: [],
    folders: [],
    statsMap: {},
    selectedFile: { name: "", content: "" },
    folderListingWarnings: [],
    archivedFolders: [],
    folderArchiveError: null,
    folderArchiveLoaded: true,
  } as never);
  return local;
}

test("phase 15/16: folder text/icon colors and icon are stored per folder, independent, and removable", () => {
  const local = setupWindow();
  setFolderTextColor("Trabajo", "blue");
  setFolderIconColor("Trabajo", "red");
  setFolderIcon("Trabajo", "star");
  setFolderColor("Trabajo/Sub", "pink"); // compat: aplica a texto e icono
  assert.equal(getFolderTextColors()["Trabajo"], "blue");
  assert.equal(getFolderIconColors()["Trabajo"], "red");
  assert.equal(getFolderIcons()["Trabajo"], "star");
  assert.equal(getFolderTextColors()["Trabajo/Sub"], "pink");
  assert.equal(getFolderIconColors()["Trabajo/Sub"], "pink");
  assert.equal(getFolderIcons()["Trabajo/Sub"], undefined);
  assert.ok(resolveFolderColor("blue", true));
  assert.ok(resolveFolderIcon("star"));

  setFolderTextColor("Trabajo", undefined);
  assert.equal(getFolderTextColors()["Trabajo"], undefined);
  assert.equal(getFolderIconColors()["Trabajo"], "red");
  setFolderIconColor("Trabajo", undefined);
  setFolderIcon("Trabajo", undefined);
  assert.equal(getFolderIconColors()["Trabajo"], undefined);
  assert.equal(getFolderIcons()["Trabajo"], undefined);
  assert.ok(!local.get("folderColors") || JSON.parse(local.get("folderColors")!)["Trabajo"] === undefined);
});

test("phase 15/16: folder appearance remaps on folder move and keeps text/icon colors independent", () => {
  setupWindow();
  setFolderTextColor("A", "mint");
  setFolderIconColor("A", "blue");
  setFolderTextColor("A/B", "amber");
  setFolderIconColor("A/B", "red");
  setFolderIcon("A", "book");
  setFolderIcon("A/B", "code");
  remapFolderAppearance("A", "Ren/A");
  assert.deepEqual(getFolderTextColors(), { "Ren/A": "mint", "Ren/A/B": "amber" });
  assert.deepEqual(getFolderIconColors(), { "Ren/A": "blue", "Ren/A/B": "red" });
  assert.deepEqual(getFolderIcons(), { "Ren/A": "book", "Ren/A/B": "code" });
});

test("phase 17: visible names preserve valid Unicode and only diverge physically when necessary", () => {
  setupWindow();
  fileStore.setState({ files: [], folders: [] } as never);

  const safeUnicode = resolvePhysicalSegment({
    visibleSegment: "¿Idea increíble!.txt",
    kind: "file",
    parentDir: "",
    existingPhysicalSegments: [],
  });
  assert.equal(safeUnicode.physical, "¿Idea increíble!.txt");
  assert.equal(safeUnicode.differs, false);
  assert.equal(safeUnicode.visible, "¿Idea increíble!.txt");

  const invalidChars = resolvePhysicalSegment({
    visibleSegment: "Plan: A/B?.txt",
    kind: "file",
    parentDir: "",
    existingPhysicalSegments: [],
  });
  assert.notEqual(invalidChars.physical, "Plan: A/B?.txt");
  assert.equal(invalidChars.visible, "Plan: A/B?.txt");
  assert.match(invalidChars.physical, /\.txt$/);
  assert.equal(invalidChars.physical.includes("/"), false);
  assert.equal(invalidChars.physical.includes("?"), false);
  assert.equal(invalidChars.physical.includes(":"), false);
});

test("phase 17: physical safety rejects reserved names, trailing dots/spaces and forbidden chars; sanitization keeps readable names", () => {
  setupWindow();
  assert.equal(isPhysicallySafeSegment("CON.txt", "file"), false);
  assert.equal(isPhysicallySafeSegment("nombre. ", "folder"), false);
  assert.equal(isPhysicallySafeSegment(" nombre", "folder"), false);
  assert.equal(isPhysicallySafeSegment("a/b", "folder"), false);

  const reserved = resolvePhysicalSegment({
    visibleSegment: "CON.txt",
    kind: "file",
    parentDir: "",
    existingPhysicalSegments: [],
  });
  assert.notEqual(reserved.physical.toUpperCase().replace(/\.TXT$/i, ""), "CON");
  assert.equal(reserved.visible, "CON.txt");

  const trailing = resolvePhysicalSegment({
    visibleSegment: "nota final. ",
    kind: "folder",
    parentDir: "",
    existingPhysicalSegments: [],
  });
  assert.equal(trailing.physical.endsWith(" "), false);
  assert.equal(trailing.physical.endsWith("."), false);
  assert.equal(trailing.visible, "nota final. ");
});

test("phase 17: collisions are case-insensitive and never overwrite existing siblings", () => {
  setupWindow();
  fileStore.setState({ files: ["Nota.txt", "nota (2).txt"], folders: ["Proyectos"] } as never);

  const file = resolveNewNotePhysicalPath("NOTA", "");
  assert.equal(file.physicalPath.toLowerCase(), "nota (3).txt");
  assert.equal(file.visibleSegment, "NOTA.txt");

  const folder = resolveNewFolderPhysicalPath("proyectos", "");
  assert.equal(folder.physicalPath.toLowerCase(), "proyectos (2)");
  assert.equal(folder.visibleSegment, "proyectos");

  const existing = resolveNewNotePhysicalPath("Nota", "", "Nota.txt");
  assert.equal(existing.physicalPath, "Nota.txt");
});

test("phase 17: rename preserves physical extension/format and stores visible metadata only when needed", () => {
  setupWindow();
  fileStore.setState({ files: ["docs/readme.md", "docs/script.py"], folders: ["docs"] } as never);

  const md = resolveRenamedNotePhysicalPath("Guía: inicio", "docs/readme.md");
  assert.match(md.physicalPath, /^docs\/.+\.md$/);
  assert.equal(md.visibleSegment, "Guía: inicio.md");
  commitVisibleName(md.physicalPath, "file", md.visibleSegment);
  assert.equal(getVisibleSegment(md.physicalPath, "file"), md.visibleSegment);
  assert.equal(displayNoteName(md.physicalPath), "Guía: inicio");
  assert.equal(editableNoteBaseName(md.physicalPath), "Guía: inicio");

  const py = resolveRenamedNotePhysicalPath("Script útil", "docs/script.py");
  assert.equal(py.physicalPath, "docs/Script útil.py");
  assert.equal(py.visibleSegment, "Script útil.py");
  commitVisibleName(py.physicalPath, "file", py.visibleSegment);
  assert.equal(displayNoteName(py.physicalPath), "Script útil.py");

  // aligned visible == physical drops override
  commitVisibleName("docs/simple.txt", "file", "simple.txt");
  assert.equal(getVisibleSegment("docs/simple.txt", "file"), undefined);
  assert.equal(displayNoteName("docs/simple.txt"), "simple");
  assert.equal(displayNoteLabel("docs/simple.txt"), "«simple»");
});

test("phase 17: folder display and editable names use visible metadata with physical fallback", () => {
  setupWindow();
  setVisibleNameForPath("Trabajo/Docs", "folder", "Documentos: importantes");
  assert.equal(displayFolderName("Trabajo/Docs"), "Documentos: importantes");
  assert.equal(getDisplaySegment("Trabajo/Docs", "folder"), "Documentos: importantes");
  clearVisibleName("Trabajo/Docs", "folder");
  assert.equal(displayFolderName("Trabajo/Docs"), "Docs");
});

test("phase 17: visible-name metadata remaps on moves and retains unresolved historical values", () => {
  setupWindow();
  setVisibleNameForPath("A/nota.txt", "file", "Idea?.txt");
  setVisibleNameForPath("A", "folder", "Área/A");

  remapVisibleNames([], { oldPath: "A", newPath: "B" });
  assert.equal(getVisibleSegment("B/nota.txt", "file"), "Idea?.txt");
  assert.equal(getVisibleSegment("B", "folder"), "Área/A");
  assert.equal(getVisibleSegment("A/nota.txt", "file"), undefined);

  pruneVisibleNameMetadata(["B/otra.txt"], ["B"]);
  assert.equal(getVisibleSegment("B/nota.txt", "file"), "Idea?.txt");
  assert.equal(getVisibleSegment("B", "folder"), "Área/A");
});

test("phase 17 integrity: reused physical paths must fall back to physical/default metadata", () => {
  setupWindow();
  setVisibleNameForPath("nota.txt", "file", "Nombre visible?.txt");
  setFolderTextColor("Docs", "blue");
  setFolderIconColor("Docs", "red");
  setFolderIcon("Docs", "star");
  setVisibleNameForPath("Docs", "folder", "Documentos visibles");

  // Reutilización/sustitución detectada: se elimina la asociación personalizada.
  clearVisibleName("nota.txt", "file");
  removeVisibleNamesForPath("Docs", "folder", false);
  setFolderTextColor("Docs", undefined);
  setFolderIconColor("Docs", undefined);
  setFolderIcon("Docs", undefined);

  assert.equal(displayNoteName("nota.txt"), "nota");
  assert.equal(displayFolderName("Docs"), "Docs");
  assert.equal(getFolderTextColor("Docs"), undefined);
  assert.equal(getFolderIconColor("Docs"), undefined);
  assert.equal(getFolderIcons()["Docs"], undefined);
  assert.equal(getVisibleSegment("Docs", "folder"), undefined);
});

test("phase 17: migratePreferences remaps visible-name keys and drops redundant overrides", async () => {
  const local = setupWindow();
  fileStore.setState({
    files: ["A/n.txt"],
    folders: ["A", "A/Sub"],
  } as never);
  local.set("noteVisibleNames", JSON.stringify({ "A/n.txt": "Nombre?.txt", "A/mismo.txt": "mismo.txt" }));
  local.set("folderVisibleNames", JSON.stringify({ "A": "Área/A", "A/Sub": "Sub" }));

  migratePreferences([{ oldPath: "A/n.txt", newPath: "B/n.txt" }], { oldPath: "A", newPath: "B" });
  const noteNames = JSON.parse(local.get("noteVisibleNames") ?? "{}") as Record<string, string>;
  const folderNames = JSON.parse(local.get("folderVisibleNames") ?? "{}") as Record<string, string>;
  assert.equal(noteNames["B/n.txt"], "Nombre?.txt");
  assert.equal(noteNames["A/n.txt"], undefined);
  assert.equal(noteNames["A/mismo.txt"], undefined);
  assert.equal(folderNames["B"], "Área/A");
  assert.equal(folderNames["B/Sub"], undefined); // became identical to physical segment
  // Allow any scheduled async preference persistence to settle in the stubbed environment.
  await new Promise(resolve => setTimeout(resolve, 20));
});

test("phase 17: validation accepts visible characters and rejects control chars/empty/too-long names", () => {
  assert.equal(validateVisibleEntryName("¿Qué tal: idea / v2?", "file").ok, true);
  assert.equal(validateVisibleEntryName("Carpeta: investigación", "folder").ok, true);
  assert.equal(validateVisibleEntryName("", "file").ok, false);
  assert.equal(validateVisibleEntryName("   ", "folder").ok, false);
  assert.equal(validateVisibleEntryName("a\nb", "file").ok, false);
  assert.equal(validateVisibleEntryName("a".repeat(201), "file").ok, false);
});

test("phase 17: technical extensions remain visible in display names while .txt/.md stay hidden", () => {
  setupWindow();
  setVisibleNameForPath("src/app.tsx", "file", "Pantalla: inicio.tsx");
  assert.equal(displayNoteName("src/app.tsx"), "Pantalla: inicio.tsx");
  setVisibleNameForPath("docs/nota.txt", "file", "Nota: especial.txt");
  assert.equal(displayNoteName("docs/nota.txt"), "Nota: especial");
  setVisibleNameForPath("docs/guia.md", "file", "Guía.md");
  assert.equal(displayNoteName("docs/guia.md"), "Guía");
});

test("phase 17 correction: special characters in visible names display exactly as entered (not sanitized physical)", () => {
  const local = setupWindow();
  fileStore.setState({ files: [], folders: [] } as never);

  // Creación de nota con caracteres especiales incompatibles con el nombre físico.
  const created = resolveNewNotePhysicalPath("¿Qué hacer?.txt", "");
  assert.equal(created.visibleSegment, "¿Qué hacer?.txt");
  assert.notEqual(created.physicalPath, created.visibleSegment);
  assert.match(created.physicalPath, /_+\.txt$/); // físico saneado, sin mostrar esto en UI
  commitVisibleName(created.physicalPath, "file", created.visibleSegment);
  assert.equal(displayNoteName(created.physicalPath), "¿Qué hacer?");
  assert.equal(getVisibleSegment(created.physicalPath, "file"), "¿Qué hacer?.txt");

  // Renombrado que conserva caracteres especiales visibles y extensión oculta.
  fileStore.setState({ files: [created.physicalPath], folders: [] } as never);
  const renamed = resolveRenamedNotePhysicalPath("Trabajo/Personal.txt", created.physicalPath);
  assert.equal(renamed.visibleSegment, "Trabajo/Personal.txt");
  commitVisibleName(renamed.physicalPath, "file", renamed.visibleSegment);
  assert.equal(displayNoteName(renamed.physicalPath), "Trabajo/Personal");

  // Carpeta: visible exacto con caracteres especiales.
  const folder = resolveNewFolderPhysicalPath("Proyecto: Lyra", "");
  assert.equal(folder.visibleSegment, "Proyecto: Lyra");
  commitVisibleName(folder.physicalPath, "folder", folder.visibleSegment);
  assert.equal(displayFolderName(folder.physicalPath), "Proyecto: Lyra");

  // Persistencia tras "reinicio": recarga desde localStorage.
  const noteNamesRaw = local.get("noteVisibleNames");
  const folderNamesRaw = local.get("folderVisibleNames");
  setupWindow();
  if (noteNamesRaw) window.localStorage.setItem("noteVisibleNames", noteNamesRaw);
  if (folderNamesRaw) window.localStorage.setItem("folderVisibleNames", folderNamesRaw);
  assert.equal(displayNoteName(created.physicalPath), "¿Qué hacer?");
  assert.equal(displayNoteName(renamed.physicalPath), "Trabajo/Personal");
  assert.equal(displayFolderName(folder.physicalPath), "Proyecto: Lyra");
});
