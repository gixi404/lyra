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
import { searchStore, type SortOptionId } from "../src/store/searchStore.ts";

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

interface MockDomHandle {
  container: MockContainerElement;
  setScrollHeight: (h: number) => void;
  setScrollTop: (t: number) => void;
  getScrollTop: () => number;
  setInEditor: (active: boolean) => void;
}

function setupMockDomWithEditor(options?: {
  scrollHeight?: number;
  clientHeight?: number;
  initialScrollTop?: number;
}): MockDomHandle {
  let scrollHeight = options?.scrollHeight ?? 2000;
  const clientHeight = options?.clientHeight ?? 800;
  let currentScrollTop = options?.initialScrollTop ?? 0;
  let inEditor = false;
  const storage = new Map<string, string>();

  const listContainer: MockContainerElement = {
    id: "lyra-list-scroll-container",
    get scrollHeight() { return scrollHeight; },
    set scrollHeight(h: number) { scrollHeight = h; },
    clientHeight,
    get scrollTop() { return currentScrollTop; },
    set scrollTop(val: number) {
      currentScrollTop = Math.max(0, Math.min(val, Math.max(0, scrollHeight - clientHeight)));
    },
  };

  const classSet = new Set<string>();
  const docElement = {
    scrollHeight,
    clientHeight,
    scrollTop: 0,
    classList: {
      add: (c: string) => { if (c === "in-editor") inEditor = true; classSet.add(c); },
      remove: (c: string) => { if (c === "in-editor") inEditor = false; classSet.delete(c); },
      contains: (c: string) => c === "in-editor" ? inEditor : classSet.has(c),
      toggle: (c: string, force?: boolean) => {
        const on = force === undefined ? !classSet.has(c) : force;
        if (on) { classSet.add(c); if (c === "in-editor") inEditor = true; }
        else { classSet.delete(c); if (c === "in-editor") inEditor = false; }
        return on;
      },
    },
  };
  const bodyElement = { scrollHeight, clientHeight, scrollTop: 0 };

  const mockWindow = {
    innerHeight: clientHeight,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, val: string) => storage.set(key, String(val)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
    history: { scrollRestoration: "auto" },
  };

  (globalThis as unknown as { window: unknown }).window = mockWindow;
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: docElement,
    body: bodyElement,
    getElementById: (id: string) => (id === "lyra-list-scroll-container" ? listContainer : null),
  };

  return {
    container: listContainer,
    setScrollHeight: (h: number) => {
      scrollHeight = h;
      currentScrollTop = Math.max(0, Math.min(currentScrollTop, Math.max(0, scrollHeight - clientHeight)));
    },
    setScrollTop: (t: number) => { listContainer.scrollTop = t; },
    getScrollTop: () => listContainer.scrollTop,
    setInEditor: (active: boolean) => {
      inEditor = active;
      if (active) classSet.add("in-editor"); else classSet.delete("in-editor");
    },
  };
}

test("10. Navegación real representativa: scroll→abrir editor→volver restaura exacto sin sobrescribir con 0", () => {
  const dom = setupMockDomWithEditor({ scrollHeight: 3200, clientHeight: 800, initialScrollTop: 740 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });
  searchStore.getState().setSearch("");

  // Usuario desplaza y el listado captura continuamente
  dom.setScrollTop(740);
  setListScroll(getScrollPos("active"), "active");
  assert.strictEqual(getListScroll("active"), 740);

  // Antes de abrir archivo (ItemFile/Form): captura explícita
  setListScroll(getScrollPos("active"), "active");

  // Entrar al editor: html.in-editor y el scroll DOM efectivo puede caer a 0 durante desmontaje/transición
  dom.setInEditor(true);
  dom.setScrollTop(0);
  // Montaje/desmontaje no debe degradar la posición guardada
  setListScroll(getScrollPos("active"), "active");
  assert.strictEqual(getListScroll("active"), 740, "No debe sobrescribirse con 0 en transición al editor");

  // Unmount del listado (simulado)
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { scrollHeight: 800, clientHeight: 800, scrollTop: 0, classList: { contains: () => true, add() {}, remove() {} } },
    body: { scrollHeight: 800, clientHeight: 800, scrollTop: 0 },
    getElementById: () => null,
  };
  assert.strictEqual(getListScroll("active"), 740, "Sobrevive al desmontaje");

  // Regreso: remount con contenido disponible
  const remount = setupMockDomWithEditor({ scrollHeight: 3200, clientHeight: 800, initialScrollTop: 0 });
  remount.setInEditor(false);
  const target = getListScroll("active");
  const restored = applyListScroll(target);
  assert.strictEqual(restored, 740);
  assert.strictEqual(getScrollPos("active"), 740, "Restauración exacta inmediata al volver");
});

test("11. Ciclos repetidos, carpetas expandidas/subcarpetas y distintos modos de ordenamiento", () => {
  resetAllListScroll();
  searchStore.getState().setSearch("");
  configStore.setState({ paperIsOpen: false });

  const sortModes: SortOptionId[] = ["recent", "oldest", "az", "za"];
  for (let i = 1; i <= 12; i++) {
    // Representa contenido con carpetas/subcarpetas expandidas (altura grande, posiciones profundas)
    const deepHeight = 6000 + i * 200;
    const position = 300 + i * 180; // posiciones en distintas profundidades
    const mode = sortModes[i % sortModes.length];
    searchStore.getState().setSortOption(mode);

    const dom = setupMockDomWithEditor({ scrollHeight: deepHeight, clientHeight: 800, initialScrollTop: position });
    dom.setInEditor(false);
    setListScroll(getScrollPos("active"), "active");

    // Abrir editor
    dom.setInEditor(true);
    dom.setScrollTop(0);
    setListScroll(0, "active"); // intento de degradación debe ignorarse por guardia in-editor

    // Volver
    const back = setupMockDomWithEditor({ scrollHeight: deepHeight, clientHeight: 800, initialScrollTop: 0 });
    back.setInEditor(false);
    const restored = applyListScroll(getListScroll("active"));
    assert.strictEqual(restored, position, `Ciclo ${i} (${mode}) debe restaurar ${position}`);
    assert.strictEqual(getListScroll("active"), position);
  }
});

test("12. Actualizaciones periódicas del listado no invalidan ni reinician la posición guardada", () => {
  const dom = setupMockDomWithEditor({ scrollHeight: 4000, clientHeight: 800, initialScrollTop: 1200 });
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });
  dom.setInEditor(false);

  setListScroll(getScrollPos("active"), "active");
  assert.strictEqual(getListScroll("active"), 1200);

  // Refresco periódico cambia altura (crece/baja temporalmente) sin interacción del usuario
  dom.setScrollHeight(3800);
  assert.strictEqual(getListScroll("active"), 1200, "Posición guardada no se pierde por refresco");
  // Contenido más corto pero la posición guardada sigue siendo válida: no debe alterarse
  assert.strictEqual(applyListScroll(getListScroll("active")), 1200, "Mantiene la posición si sigue siendo válida");
  // La intención almacenada permanece
  assert.strictEqual(getListScroll("active"), 1200);

  // Si el contenido se reduce por debajo de la posición guardada, se aplica la posición válida más cercana
  dom.setScrollHeight(1500); // maxScroll = 700
  assert.strictEqual(applyListScroll(getListScroll("active")), 700, "Se clampa a la posición válida más cercana");
  assert.strictEqual(getListScroll("active"), 1200, "La intención guardada no se pierde si el contenido puede volver a crecer");

  // El contenido crece de nuevo (p. ej. carpetas expandidas / refresco completo)
  dom.setScrollHeight(4200);
  const restoredWhenGrows = applyListScroll(getListScroll("active"));
  assert.strictEqual(restoredWhenGrows, 1200, "Recupera la posición objetivo cuando el contenido vuelve a tener altura");

  // Desplazamiento manual posterior debe actualizar almacenamiento
  dom.setScrollTop(1500);
  setListScroll(getScrollPos("active"), "active");
  assert.strictEqual(getListScroll("active"), 1500);
});

test("13. Montaje/inicialización no sobrescribe la posición guardada y vista archivados independiente", () => {
  resetAllListScroll();
  configStore.setState({ paperIsOpen: false });
  setListScroll(900, "active");
  setListScroll(450, "paper");

  // Simula montaje inicial leyendo 0 del DOM antes de restaurar, en contexto visible: no debe degradar
  const mountDom = setupMockDomWithEditor({ scrollHeight: 3000, clientHeight: 800, initialScrollTop: 0 });
  mountDom.setInEditor(false);
  // Un guardado accidental de 0 en montaje visible sí representaría reset; la responsabilidad es no llamarlo.
  // Verificamos que la fuente de verdad conserva el valor y que la restauración aplica correctamente.
  assert.strictEqual(getListScroll("active"), 900);
  applyListScroll(getListScroll("active"));
  assert.strictEqual(getScrollPos("active"), 900);

  // Transición/montaje durante editor: incluso si alguien intenta persistir 0, se ignora
  mountDom.setInEditor(true);
  setListScroll(0, "active");
  assert.strictEqual(getListScroll("active"), 900, "Guardia in-editor preserva posición");

  // Archivados conserva independencia
  configStore.setState({ paperIsOpen: true });
  mountDom.setInEditor(false);
  assert.strictEqual(getListScroll("paper"), 450);
  applyListScroll(getListScroll("paper"));
  assert.strictEqual(getScrollPos("paper"), 450);
});
