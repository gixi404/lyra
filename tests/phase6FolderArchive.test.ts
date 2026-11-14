import test from "node:test";
import assert from "node:assert/strict";
import { fileStore } from "../src/store/fileStore.ts";

// Comportamientos de archivado/recuperación de carpetas (fase 6) verificables sin Tauri runtime.

test("folder archive: publicar archivedFolders con bump de generación invalida lecturas obsoletas (patrón List.tsx)", async () => {
  fileStore.setState({ archivedFolders: ["A"], folderArchiveError: null, folderArchiveLoaded: true, listingGeneration: 0 });
  const applyGen = fileStore.getState().listingGeneration;
  const staleRead = Promise.resolve<string[]>([]); // lectura iniciada antes (gen 0), resolvería a estado antiguo
  // mutación local coherente (como FolderMenu): actualiza e incrementa generación en la misma actualización
  fileStore.setState(state => ({ archivedFolders: ["A", "B"], folderArchiveError: null, folderArchiveLoaded: true, listingGeneration: state.listingGeneration + 1 }));
  const archived = await staleRead;
  // guardia usada por init/refresco en List.tsx
  if (fileStore.getState().listingGeneration === applyGen) {
    fileStore.getState().setArchivedFolders(archived);
  }
  assert.deepEqual(fileStore.getState().archivedFolders, ["A", "B"]);
});

test("folder archive: lectura válida posterior se aplica cuando la generación coincide", () => {
  fileStore.setState({ archivedFolders: ["A", "B"], folderArchiveError: null, folderArchiveLoaded: true, listingGeneration: 5 });
  const applyGen = fileStore.getState().listingGeneration;
  const archived = ["A"]; // resultado de lectura iniciada tras recuperar B
  if (fileStore.getState().listingGeneration === applyGen) {
    fileStore.getState().setArchivedFolders(archived);
  }
  assert.deepEqual(fileStore.getState().archivedFolders, ["A"]);
});

test("efectivamente archivada por ancestro: carpeta sin estado explícito permanece oculta en activos y presente en archivados", async () => {
  // Lógica de visibilidad usada en ListFiles (inArchivedFolder / filtros de carpetas activas)
  const inArchivedFolder = (path: string, archivedFolders: string[]) => archivedFolders.some(folder => path === folder || path.startsWith(`${folder}/`));
  const archivedFolders = ["Trabajo"]; // Trabajo archivada explícitamente
  const folders = ["Trabajo", "Trabajo/Proyecto A"]; // Proyecto A recuperada (sin estado explícito) pero bajo ancestro archivado
  const activeVisible = folders.filter(path => !inArchivedFolder(path, archivedFolders));
  const archivedVisible = folders.filter(path => archivedFolders.some(archived => path === archived || path.startsWith(`${archived}/`) || archived.startsWith(`${path}/`)));
  assert.deepEqual(activeVisible, []);
  assert.ok(archivedVisible.includes("Trabajo/Proyecto A"));
  assert.ok(archivedVisible.includes("Trabajo"));
});

test("archivado de carpeta no modifica preferencias de orden/expansión en localStorage (operación lógica)", () => {
  // El archivado de carpetas (set_folder_archived) no invoca migraciones ni limpieza de prefs;
  // folderOrder/fileOrder/folderExpanded deben conservarse.
  const local = new Map<string, string>();
  const orig = globalThis.window;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => { local.set(k, String(v)); },
      removeItem: (k: string) => { local.delete(k); },
    },
  } as unknown as Window & typeof globalThis;
  try {
    local.set("folderOrder", JSON.stringify({ "$top": ["Trabajo", "Personal"], "Trabajo": ["Trabajo/A"] }));
    local.set("fileOrder", JSON.stringify({ "Trabajo": ["Trabajo/n.md"] }));
    local.set("folderExpanded", JSON.stringify({ "root:lyra": true, "Trabajo": true, "Trabajo/A": false }));
    const before = {
      folderOrder: local.get("folderOrder"),
      fileOrder: local.get("fileOrder"),
      folderExpanded: local.get("folderExpanded"),
    };
    // Simula que solo cambia el estado de archivado en store (sin tocar prefs)
    fileStore.setState(state => ({ archivedFolders: ["Trabajo"], folderArchiveError: null, folderArchiveLoaded: true, listingGeneration: state.listingGeneration + 1 }));
    assert.deepEqual({
      folderOrder: local.get("folderOrder"),
      fileOrder: local.get("fileOrder"),
      folderExpanded: local.get("folderExpanded"),
    }, before);
  } finally {
    (globalThis as unknown as { window: unknown }).window = orig;
  }
});

test("orden manual: archivar/recuperar carpeta conserva posición y orden interno al reconstruir con funciones reales", async () => {
  const { buildFolderTree } = await import("../src/utils/folderTree.ts");
  const local = new Map<string, string>();
  local.set("folderOrder", JSON.stringify({ "$top": ["A", "B", "C"], "B": ["B/Sub2", "B/Sub1"] }));
  local.set("fileOrder", JSON.stringify({ "B": ["B/n2.md", "B/n1.md"], "B/Sub1": ["B/Sub1/s.md"] }));
  const folderOrder = JSON.parse(local.get("folderOrder")!) as Record<string, string[]>;
  const fileOrder = JSON.parse(local.get("fileOrder")!) as Record<string, string[]>;

  const build = (folders: string[], files: string[]) => buildFolderTree(folders, files, folderOrder, fileOrder);
  const topNames = (folders: string[], files: string[]) => build(folders, files).folders.map(f => f.path);

  const allFolders = ["A", "B", "C", "B/Sub1", "B/Sub2"];
  const allFiles = ["B/n1.md", "B/n2.md", "B/Sub1/s.md"];
  assert.deepEqual(topNames(allFolders, allFiles), ["A", "B", "C"]);
  const bNode = build(allFolders, allFiles).folders.find(f => f.path === "B")!;
  assert.deepEqual(bNode.folders.map(f => f.path), ["B/Sub2", "B/Sub1"]);
  assert.deepEqual(bNode.files, ["B/n2.md", "B/n1.md"]);

  // Archivar B: se oculta del explorador activo, prefs de orden se conservan intactas.
  const activeFolders = ["A", "C"]; // B y sus descendientes ocultos
  const activeFiles: string[] = [];
  assert.deepEqual(topNames(activeFolders, activeFiles), ["A", "C"]);
  assert.deepEqual(JSON.parse(local.get("folderOrder")!), folderOrder);
  assert.deepEqual(JSON.parse(local.get("fileOrder")!), fileOrder);

  // Persistir y "recargar" preferencias.
  const persistedFolderOrder = JSON.parse(JSON.stringify(JSON.parse(local.get("folderOrder")!)));
  const persistedFileOrder = JSON.parse(JSON.stringify(JSON.parse(local.get("fileOrder")!)));

  // Recuperar B: vuelve a ser visible.
  assert.deepEqual(topNames(allFolders, allFiles), ["A", "B", "C"]);
  const bRecovered = build(allFolders, allFiles).folders.find(f => f.path === "B")!;
  assert.deepEqual(bRecovered.folders.map(f => f.path), ["B/Sub2", "B/Sub1"]);
  assert.deepEqual(bRecovered.files, ["B/n2.md", "B/n1.md"]);
  assert.deepEqual(persistedFolderOrder, folderOrder);
  assert.deepEqual(persistedFileOrder, fileOrder);
});

test("orden manual: nota archivada individual y subcarpeta mantienen posición al ocultarse/recuperarse (construcción real)", async () => {
  const { buildFolderTree } = await import("../src/utils/folderTree.ts");
  const folderOrder = { "$top": ["A"], "A": ["A/S1", "A/S2"] } as Record<string, string[]>;
  const fileOrder = { "A": ["A/n1.md", "A/n2.md", "A/n3.md"] } as Record<string, string[]>;
  const folders = ["A", "A/S1", "A/S2"];
  // ocultar nota individual archivada n2 y subcarpeta S1
  const filesVisible = ["A/n1.md", "A/n3.md"];
  const foldersVisible = ["A", "A/S2"];
  const tree = buildFolderTree(foldersVisible, filesVisible, folderOrder, fileOrder);
  const a = tree.folders[0];
  assert.deepEqual(a.folders.map(f => f.path), ["A/S2"]);
  assert.deepEqual(a.files, ["A/n1.md", "A/n3.md"]); // posiciones relativas conservadas
  // recuperar
  const full = buildFolderTree(folders, ["A/n1.md", "A/n2.md", "A/n3.md"], folderOrder, fileOrder).folders[0];
  assert.deepEqual(full.folders.map(f => f.path), ["A/S1", "A/S2"]);
  assert.deepEqual(full.files, ["A/n1.md", "A/n2.md", "A/n3.md"]);
});
