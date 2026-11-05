import test from "node:test";
import assert from "node:assert";
import {
  applyListScroll,
  clearEditorScroll,
  getEditorScroll,
  getListContainer,
  getListScroll,
  getMaxScroll,
  getScrollPos,
  resetAllListScroll,
  setEditorScroll,
  setListScroll,
} from "../src/utils/listScroll.ts";
import { configStore } from "../src/store/configStore.ts";
import { searchStore } from "../src/store/searchStore.ts";

interface MockContainerElement {
  id: string;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function setupMockDom(options?: {
  scrollHeight?: number;
  clientHeight?: number;
  initialScrollTop?: number;
}) {
  let scrollHeight = options?.scrollHeight ?? 2000;
  const clientHeight = options?.clientHeight ?? 800;
  let currentScrollTop = options?.initialScrollTop ?? 0;

  const storage = new Map<string, string>();

  const listContainer: MockContainerElement = {
    id: "lyra-list-scroll-container",
    get scrollHeight() {
      return scrollHeight;
    },
    set scrollHeight(h: number) {
      scrollHeight = h;
    },
    clientHeight,
    get scrollTop() {
      return currentScrollTop;
    },
    set scrollTop(val: number) {
      currentScrollTop = Math.max(0, Math.min(val, Math.max(0, scrollHeight - clientHeight)));
    },
  };

  const docElement = {
    scrollHeight,
    clientHeight,
    scrollTop: 0,
  };

  const bodyElement = {
    scrollHeight,
    clientHeight,
    scrollTop: 0,
  };

  const mockWindow = {
    innerHeight: clientHeight,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, val: string) => storage.set(key, String(val)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
    history: {
      scrollRestoration: "auto",
    },
  };

  (globalThis as unknown as { window: unknown }).window = mockWindow;
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: docElement,
    body: bodyElement,
    getElementById: (id: string) => {
      if (id === "lyra-list-scroll-container") return listContainer;
      return null;
    },
  };

  return {
    container: listContainer,
    setScrollHeight: (h: number) => {
      scrollHeight = h;
      currentScrollTop = Math.max(0, Math.min(currentScrollTop, Math.max(0, scrollHeight - clientHeight)));
    },
    setScrollTop: (t: number) => {
      listContainer.scrollTop = t;
    },
    getScrollTop: () => listContainer.scrollTop,
  };
}

test("1. Ciclo completo: Abrir editor y regresar restaura la posición exacta del contenedor", () => {
  const dom = setupMockDom({ scrollHeight: 3000, clientHeight: 800, initialScrollTop: 650 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });

  // 1. Usuario navega en el listado hasta y = 650
  assert.strictEqual(getScrollPos(), 650);

  // 2. Al abrir la nota, se captura el scroll actual del contenedor
  setListScroll(dom.getScrollTop(), "active");
  assert.strictEqual(getListScroll("active"), 650);

  // 3. Al abrir el editor, el listado se desmonta
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
    body: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
    getElementById: () => null,
  };

  // Verificar que el almacenamiento en sesión NO fue sobreescrito con 0
  assert.strictEqual(getListScroll("active"), 650);

  // 4. Usuario regresa del editor: el contenedor de la lista se remonta con su contenido
  const restoredDom = setupMockDom({ scrollHeight: 3000, clientHeight: 800, initialScrollTop: 0 });
  assert.strictEqual(restoredDom.getScrollTop(), 0, "Al montar inicia en 0");

  // 5. useLayoutEffect restaura inmediatamente la posición guardada
  const target = getListScroll("active");
  restoredDom.setScrollTop(target);

  assert.strictEqual(restoredDom.getScrollTop(), 650, "El contenedor debe quedar exactamente en 650");
});

test("2. Ciclo completo: Archivados conserva su scroll de forma independiente tras desmontar", () => {
  const dom = setupMockDom({ scrollHeight: 2500, clientHeight: 800, initialScrollTop: 480 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: true });

  setListScroll(dom.getScrollTop(), "paper");
  assert.strictEqual(getListScroll("paper"), 480);

  // Desmontar
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
    body: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
    getElementById: () => null,
  };

  assert.strictEqual(getListScroll("paper"), 480);

  // Remontar
  const restoredDom = setupMockDom({ scrollHeight: 2500, clientHeight: 800, initialScrollTop: 0 });
  const target = getListScroll("paper");
  restoredDom.setScrollTop(target);

  assert.strictEqual(restoredDom.getScrollTop(), 480, "Archivados recupera 480 exactamente");
});

test("3. Stress test: Abrir y cerrar notas 20 veces desde distintas posiciones conserva la posición", () => {
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });

  for (let i = 1; i <= 20; i++) {
    const position = i * 45; // 45, 90, 135, ...
    const dom = setupMockDom({ scrollHeight: 4000, clientHeight: 800, initialScrollTop: position });
    setListScroll(dom.getScrollTop(), "active");
    assert.strictEqual(getListScroll("active"), position);

    // Simular unmount hacia editor
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
      body: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
      getElementById: () => null,
    };

    // Simular remount al regresar
    const remountDom = setupMockDom({ scrollHeight: 4000, clientHeight: 800, initialScrollTop: 0 });
    remountDom.setScrollTop(getListScroll("active"));
    assert.strictEqual(remountDom.getScrollTop(), position, `Iteración ${i} debe restaurar ${position}`);
  }
});

test("4. Stress test: Alternar entre notas activas y archivadas 20 veces mantiene posiciones independientes", () => {
  resetAllListScroll();
  const dom = setupMockDom({ scrollHeight: 3500, clientHeight: 800 });

  setListScroll(720, "active");
  setListScroll(310, "paper");

  for (let i = 0; i < 20; i++) {
    // Alternar a active
    configStore.setState({ paperIsOpen: false });
    dom.setScrollTop(getListScroll("active"));
    assert.strictEqual(dom.getScrollTop(), 720);

    // Alternar a paper
    configStore.setState({ paperIsOpen: true });
    dom.setScrollTop(getListScroll("paper"));
    assert.strictEqual(dom.getScrollTop(), 310);
  }
});

test("5. TinyEditor: Conserva la posición de lectura independiente para múltiples notas", () => {
  clearEditorScroll();

  for (let i = 1; i <= 5; i++) {
    const note = `Nota_${i}.md`;
    const readPos = i * 250;
    setEditorScroll(note, readPos);
    assert.strictEqual(getEditorScroll(note), readPos);
  }

  // Verificar que cada nota retiene su posición sin interferir con las otras
  assert.strictEqual(getEditorScroll("Nota_1.md"), 250);
  assert.strictEqual(getEditorScroll("Nota_3.md"), 750);
  assert.strictEqual(getEditorScroll("Nota_5.md"), 1250);
  assert.strictEqual(getEditorScroll("Nota_Inexistente.md"), 0);
});

test("6. Archivar o eliminar notas: La posición se clamplea al nuevo máximo cuando la altura se reduce", () => {
  const dom = setupMockDom({ scrollHeight: 2000, clientHeight: 800, initialScrollTop: 1150 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });

  setListScroll(1150, "active");
  assert.strictEqual(getMaxScroll(), 1200);

  // Se archivan varias notas del final y la altura total baja a 1300px (maxScroll = 500)
  dom.setScrollHeight(1300);
  assert.strictEqual(getMaxScroll(), 500);

  const target = getListScroll("active");
  const clamped = Math.min(target, getMaxScroll());
  dom.setScrollTop(clamped);
  setListScroll(clamped, "active");

  assert.strictEqual(dom.getScrollTop(), 500, "Se ajusta al máximo disponible (500)");
  assert.strictEqual(getListScroll("active"), 500);
});

test("7. Búsquedas y cambios de orden reinician el scroll del contenedor a 0", () => {
  const dom = setupMockDom({ scrollHeight: 3000, clientHeight: 800, initialScrollTop: 800 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });

  setListScroll(800, "active");
  assert.strictEqual(getListScroll("active"), 800);

  // Al escribir en búsqueda, se limpia a 0
  searchStore.getState().setSearch("proyecto");
  assert.strictEqual(dom.getScrollTop(), 0, "Búsqueda activa restablece el scroll visual a 0");

  // Al cambiar la ordenación, se reinicia el scroll del contenedor
  dom.setScrollTop(600);
  setListScroll(600, "active");
  searchStore.getState().setSortOption("recent");
  assert.strictEqual(dom.getScrollTop(), 0, "Cambio de orden restablece el scroll visual a 0");
  assert.strictEqual(getListScroll("active"), 0);
});

test("8. Desplazamiento manual posterior actualiza el almacenamiento sin ser sobrescrito", () => {
  const dom = setupMockDom({ scrollHeight: 3000, clientHeight: 800, initialScrollTop: 300 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });

  // Posición inicial guardada
  setListScroll(300, "active");
  assert.strictEqual(getListScroll("active"), 300);

  // Usuario se desplaza manualmente a 950
  dom.setScrollTop(950);
  setListScroll(dom.getScrollTop(), "active");

  // La nueva posición debe ser 950 sin volver tardíamente a 300
  assert.strictEqual(getListScroll("active"), 950);
});

test("9. Tolerancia a entorno sin montar o SSR", () => {
  const prevWindow = (globalThis as unknown as { window?: unknown }).window;
  const prevDocument = (globalThis as unknown as { document?: unknown }).document;

  resetAllListScroll();
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: unknown }).document;

  try {
    assert.doesNotThrow(() => {
      assert.strictEqual(getListContainer(), null);
      assert.strictEqual(getScrollPos(), 0);
      assert.strictEqual(getMaxScroll(), 0);
      assert.strictEqual(applyListScroll(500), 500);
      assert.strictEqual(getEditorScroll("nota.txt"), 0);
      setEditorScroll("nota.txt", 100);
      assert.strictEqual(getEditorScroll("nota.txt"), 100);
    });
  } finally {
    (globalThis as unknown as { window?: unknown }).window = prevWindow;
    (globalThis as unknown as { document?: unknown }).document = prevDocument;
  }
});
