import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../src/utils/helpers.ts";
import {
  filterFilesByNormalizedSearch,
  getForcedExpandedForSearch,
  getNecessaryFolderPaths,
  matchesNormalizedSearch,
} from "../src/utils/searchProjection.ts";
import { buildFolderTree, ROOT_FOLDER_ID } from "../src/utils/folderTree.ts";
import { flattenVisible } from "../src/utils/flattenExplorer.ts";
import { configStore } from "../src/store/configStore.ts";
import { searchStore } from "../src/store/searchStore.ts";
import {
  applyListScroll,
  getListScroll,
  getMaxScroll,
  getScrollPos,
  resetAllListScroll,
  setListScroll,
} from "../src/utils/listScroll.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relativePath: string): string => readFileSync(join(root, relativePath), "utf8");

const FILES = [
  "Proyecto Lyra.txt",
  "Proyectos/Plan 2026.md",
  "proyectos/Archivo/Notas viejas.txt",
  "Personal/Diario.txt",
  "Personal/Proyecto privado.txt",
];

interface MockDom {
  setScrollHeight: (height: number) => void;
  setScrollTop: (top: number) => void;
  getScrollTop: () => number;
}

function setupMockDom(options?: { scrollHeight?: number; clientHeight?: number; initialScrollTop?: number }): MockDom {
  let scrollHeight = options?.scrollHeight ?? 2400;
  const clientHeight = options?.clientHeight ?? 800;
  let currentScrollTop = options?.initialScrollTop ?? 0;
  const sessionStorage = new Map<string, string>();

  const container = {
    id: "lyra-list-scroll-container",
    get scrollHeight() { return scrollHeight; },
    set scrollHeight(value: number) { scrollHeight = value; },
    clientHeight,
    get scrollTop() { return currentScrollTop; },
    set scrollTop(value: number) {
      currentScrollTop = Math.max(0, Math.min(value, Math.max(0, scrollHeight - clientHeight)));
    },
  };

  (globalThis as unknown as { window: unknown }).window = {
    innerHeight: clientHeight,
    sessionStorage: {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => sessionStorage.set(key, String(value)),
      removeItem: (key: string) => sessionStorage.delete(key),
      clear: () => sessionStorage.clear(),
    },
    history: { scrollRestoration: "manual" },
  };
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { scrollHeight, clientHeight, scrollTop: 0 },
    body: { scrollHeight, clientHeight, scrollTop: 0 },
    getElementById: (id: string) => (id === "lyra-list-scroll-container" ? container : null),
  };

  return {
    setScrollHeight: (height: number) => { scrollHeight = height; },
    setScrollTop: (top: number) => { container.scrollTop = top; },
    getScrollTop: () => container.scrollTop,
  };
}

function resetSearchState(): void {
  searchStore.setState({ search: "", sortOption: "mtime", sortOptions: ["mtime"], order: true });
  configStore.setState({ paperIsOpen: false });
  resetAllListScroll();
}

function filteredFiles(): string[] {
  return filterFilesByNormalizedSearch(FILES, normalize(searchStore.getState().search));
}

test("búsqueda -> abrir archivo -> regresar conserva texto y resultados en ciclos repetidos", () => {
  setupMockDom();
  resetSearchState();

  searchStore.getState().setSearch("proyecto");
  const expected = [
    "Proyecto Lyra.txt",
    "Proyectos/Plan 2026.md",
    "proyectos/Archivo/Notas viejas.txt",
    "Personal/Proyecto privado.txt",
  ];
  assert.deepEqual(filteredFiles(), expected);

  for (let cycle = 0; cycle < 8; cycle++) {
    // Abrir una nota filtrada (el editor no modifica el estado de búsqueda).
    assert.ok(filteredFiles().includes("Proyecto Lyra.txt"));

    // Regresar al explorador: un remontaje no debe llamar a resetSearch.
    assert.equal(searchStore.getState().search, "proyecto", `ciclo ${cycle}: el texto debe permanecer`);
    assert.deepEqual(filteredFiles(), expected, `ciclo ${cycle}: los resultados deben seguir filtrados`);
  }
});

test("un remontaje del explorador no reinicia la búsqueda (protección del efecto de montaje)", () => {
  setupMockDom();
  resetSearchState();
  searchStore.getState().setSearch("plan");

  // Regresión del reinicio causado por el guard de "primer montaje" en ListFiles.
  const source = readSource("src/components/ListFiles.tsx");
  assert.equal(source.includes("isFirstMountRef"), false,
    "ListFiles no debe usar un guard de primer montaje que se rompa al remontar o con StrictMode");
  assert.equal(source.includes("previousPaperIsOpenRef"), true,
    "ListFiles debe comparar la vista anterior con la actual antes de limpiar la búsqueda");

  const resetEffectStart = source.indexOf("const previousPaperIsOpenRef");
  const resetCall = source.indexOf("resetSearch();", resetEffectStart);
  const guard = source.indexOf("if (previousPaperIsOpenRef.current === paperIsOpen) return;", resetEffectStart);
  assert.ok(guard !== -1 && guard < resetCall,
    "resetSearch solo puede ejecutarse después de confirmar un cambio real de vista");

  assert.equal(searchStore.getState().search, "plan");
});

test("borrar manualmente el filtro recupera la vista normal", () => {
  setupMockDom();
  resetSearchState();
  searchStore.getState().setSearch("personal");
  assert.deepEqual(filteredFiles(), ["Personal/Diario.txt", "Personal/Proyecto privado.txt"]);

  searchStore.getState().setSearch("");
  assert.equal(searchStore.getState().search, "");
  assert.deepEqual(filteredFiles(), FILES);
});

test("conserva el filtro cuando no hay resultados y tras varias navegaciones", () => {
  setupMockDom();
  resetSearchState();
  searchStore.getState().setSearch("sin-coincidencias-posibles");

  for (let cycle = 0; cycle < 6; cycle++) {
    assert.equal(searchStore.getState().search, "sin-coincidencias-posibles");
    assert.deepEqual(filteredFiles(), []);
  }

  // Borrar el filtro sin resultados también recupera la vista normal.
  searchStore.getState().setSearch("");
  assert.deepEqual(filteredFiles(), FILES);
});

test("mantiene la expansión forzada por búsqueda y restaura el snapshot original al limpiar", () => {
  setupMockDom();
  resetSearchState();

  const snapshot = {
    [ROOT_FOLDER_ID]: false,
    "Proyectos": false,
    "proyectos": false,
    "proyectos/Archivo": false,
    "Personal": true,
  };
  const folders = ["Proyectos", "proyectos", "proyectos/Archivo", "Personal"];

  searchStore.getState().setSearch("proyecto");
  const matches = filteredFiles();
  const necessary = getNecessaryFolderPaths(matches);

  for (let cycle = 0; cycle < 5; cycle++) {
    const forced = getForcedExpandedForSearch(matches, true);
    const rows = flattenVisible(
      buildFolderTree(folders.filter(path => necessary.has(path)), matches),
      { ...snapshot, ...forced },
      true,
    );
    for (const path of matches) {
      assert.ok(rows.some(row => row.kind === "file" && row.path === path && row.open),
        `ciclo ${cycle}: ${path} debe permanecer visible y expandido`);
    }
    assert.deepEqual(snapshot, {
      [ROOT_FOLDER_ID]: false,
      "Proyectos": false,
      "proyectos": false,
      "proyectos/Archivo": false,
      "Personal": true,
    }, "la proyección de búsqueda no debe mutar la expansión real");
  }

  // Al limpiar, vuelve el estado de expansión original (sin forzar ramas).
  searchStore.getState().setSearch("");
  const restoredRows = flattenVisible(buildFolderTree(folders, FILES), snapshot, true);
  assert.equal(restoredRows.find(row => row.path === "Proyectos/Plan 2026.md")?.open, false);
  assert.equal(restoredRows.find(row => row.path === "proyectos")?.open, true);
  assert.equal(restoredRows.find(row => row.path === "proyectos/Archivo/Notas viejas.txt")?.open, false);
});

test("conserva el scroll de los resultados filtrados a través de la ida y vuelta al editor", () => {
  const dom = setupMockDom({ scrollHeight: 3200, clientHeight: 800 });
  resetSearchState();

  searchStore.getState().setSearch("proyecto");
  assert.equal(getScrollPos(), 0, "una nueva búsqueda comienza arriba");
  assert.equal(getListScroll("active"), 0, "la intención de scroll también se reinicia al buscar");

  for (let cycle = 1; cycle <= 6; cycle++) {
    const position = 120 + cycle * 75;
    dom.setScrollTop(position);
    // Captura equivalente a List.handleScroll (ahora también activa durante búsqueda).
    setListScroll(dom.getScrollTop(), "active");
    assert.equal(getListScroll("active"), position);

    // Ida al editor: el DOM cae a 0 pero la intención guardada sobrevive.
    dom.setScrollTop(0);
    assert.equal(getListScroll("active"), position);

    // Regreso: el listado restaura la posición guardada sobre la vista filtrada.
    assert.equal(applyListScroll(getListScroll("active")), position, `ciclo ${cycle}`);
    assert.equal(dom.getScrollTop(), position);
  }

  assert.equal(searchStore.getState().search, "proyecto");
});

test("el ordenamiento actual sobrevive a la búsqueda y a la navegación", () => {
  setupMockDom();
  resetSearchState();

  searchStore.getState().setSortOption("az");
  searchStore.getState().setSearch("proyecto");
  assert.equal(searchStore.getState().sortOption, "az");

  for (let cycle = 0; cycle < 5; cycle++) {
    assert.equal(searchStore.getState().sortOption, "az");
    assert.equal(searchStore.getState().order, true);
    assert.deepEqual(filteredFiles(), [
      "Proyecto Lyra.txt",
      "Proyectos/Plan 2026.md",
      "proyectos/Archivo/Notas viejas.txt",
      "Personal/Proyecto privado.txt",
    ]);
  }

  searchStore.getState().setSearch("");
  assert.equal(searchStore.getState().sortOption, "az");
});

test("coincidencias por ruta física y por nombre visible, incluyendo acentos", () => {
  setupMockDom();
  resetSearchState();

  assert.equal(matchesNormalizedSearch("Documentación/Reunión.txt", normalize("documentacion")), true);
  assert.equal(matchesNormalizedSearch("Documentación/Reunión.txt", normalize("reunion")), true);
  assert.equal(matchesNormalizedSearch("Documentación/Reunión.txt", normalize("inexistente")), false);
  assert.equal(matchesNormalizedSearch("otra.txt", ""), true);
});

test("la vista filtrada no altera el orden manual persistido del explorador", () => {
  setupMockDom();
  resetSearchState();

  const storage = new Map<string, string>();
  const previousLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });

  try {
    const order = JSON.stringify({ "": ["Personal/Diario.txt", "Proyecto Lyra.txt"] });
    storage.set("fileOrder", order);
    const before = storage.get("fileOrder");

    searchStore.getState().setSearch("proyecto");
    for (let cycle = 0; cycle < 4; cycle++) {
      assert.equal(storage.get("fileOrder"), before, `ciclo ${cycle}: búsqueda no debe reescribir el orden`);
      assert.equal(searchStore.getState().search, "proyecto");
    }
    searchStore.getState().setSearch("");
    assert.equal(storage.get("fileOrder"), before, "limpiar la búsqueda tampoco reescribe el orden manual");
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousLocalStorage });
  }
});

test("el scroll se clampea correctamente si los resultados filtrados son más cortos", () => {
  const dom = setupMockDom({ scrollHeight: 3000, clientHeight: 800 });
  resetSearchState();
  searchStore.getState().setSearch("proyecto");
  setListScroll(700, "active");

  dom.setScrollHeight(1000);
  assert.equal(getMaxScroll(), 200);
  assert.equal(applyListScroll(getListScroll("active")), 200);
  assert.equal(getListScroll("active"), 700, "la intención guardada no se pierde si el contenido vuelve a crecer");

  dom.setScrollHeight(3000);
  assert.equal(applyListScroll(getListScroll("active")), 700);
});
