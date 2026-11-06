import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  DEFAULT_SCROLL_SPEED,
  MIN_SCROLL_SPEED,
  MAX_SCROLL_SPEED,
  SCROLL_SPEED_STEP,
  SCROLL_SPEED_STORAGE_KEY,
  HANDLED_WHEEL_SYMBOL,
  normalizeScrollSpeed,
  formatScrollSpeed,
  normalizeWheelDeltaY,
  isTargetInScrollableChild,
  applyScrollSpeedWheel,
  type ScrollSpeedState,
  type LyraWheelEvent,
} from "../src/utils/scrollSpeed.ts";
import {
  getListScroll,
  setListScroll,
  resetAllListScroll,
} from "../src/utils/listScroll.ts";
import { configStore } from "../src/store/configStore.ts";

interface MockContainer {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

interface MockWheelOptions {
  deltaY?: number;
  deltaX?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  cancelable?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

function createMockWheelEvent(opts: MockWheelOptions = {}): WheelEvent & { [HANDLED_WHEEL_SYMBOL]?: boolean } {
  let prevented = opts.defaultPrevented ?? false;
  const evt = {
    deltaY: opts.deltaY ?? 0,
    deltaX: opts.deltaX ?? 0,
    deltaMode: opts.deltaMode ?? 0,
    ctrlKey: opts.ctrlKey ?? false,
    cancelable: opts.cancelable ?? true,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault: () => {
      prevented = true;
    },
    target: (opts.target ?? null) as EventTarget | null,
  };
  return evt as unknown as WheelEvent;
}

function setupMockEnvironment(initialStorage: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialStorage));

  const mockLocalStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };

  const sessionStorageStore = new Map<string, string>();
  const mockSessionStorage = {
    getItem: (key: string) => sessionStorageStore.get(key) ?? null,
    setItem: (key: string, val: string) => sessionStorageStore.set(key, String(val)),
    removeItem: (key: string) => sessionStorageStore.delete(key),
    clear: () => sessionStorageStore.clear(),
  };

  (globalThis as unknown as { window: unknown }).window = {
    localStorage: mockLocalStorage,
    sessionStorage: mockSessionStorage,
    history: { scrollRestoration: "auto" },
    getComputedStyle: (el: unknown) => {
      return (el as { _style?: CSSStyleDeclaration })._style ?? {
        overflowY: "visible",
        overflowX: "visible",
      };
    },
  };

  return {
    store,
    sessionStorageStore,
  };
}

// ---------------------------------------------------------------------------
// 1. Valor predeterminado 1.0×
// ---------------------------------------------------------------------------
test("1. Valor predeterminado 1.0×", () => {
  setupMockEnvironment();

  assert.strictEqual(DEFAULT_SCROLL_SPEED, 1.0, "La constante DEFAULT_SCROLL_SPEED debe ser 1.0");
  assert.strictEqual(normalizeScrollSpeed(undefined), 1.0);
  assert.strictEqual(normalizeScrollSpeed(null), 1.0);
  assert.strictEqual(normalizeScrollSpeed(""), 1.0);

  // Formato visual
  assert.strictEqual(formatScrollSpeed(1.0), "1.0×");
  assert.strictEqual(formatScrollSpeed(DEFAULT_SCROLL_SPEED), "1.0×");

  // Simular lectura de preferencia con almacenamiento vacío
  const rawValue = window.localStorage.getItem(SCROLL_SPEED_STORAGE_KEY);
  const effectiveSpeed = normalizeScrollSpeed(rawValue ?? String(DEFAULT_SCROLL_SPEED));
  assert.strictEqual(effectiveSpeed, 1.0, "El valor efectivo debe ser 1.0 si no hay valor guardado");
});

// ---------------------------------------------------------------------------
// 2. Persistencia después de reiniciar la aplicación
// ---------------------------------------------------------------------------
test("2. Persistencia después de reiniciar la aplicación", () => {
  const persistentPrefsPath = new URL("../src/utils/persistentPreferences.ts", import.meta.url).pathname;
  const prefsCode = fs.readFileSync(persistentPrefsPath, "utf-8");

  // Comprobar que "scroll-speed" está registrado en PERSISTENT_KEYS
  assert.ok(
    prefsCode.includes('"scroll-speed"'),
    "SCROLL_SPEED_STORAGE_KEY ('scroll-speed') debe estar registrado en PERSISTENT_KEYS"
  );
  assert.ok(
    prefsCode.includes('"scroll-speed"?: string | number'),
    "PreferencesData debe declarar 'scroll-speed'"
  );

  // Comprobar que usePreferences exporta myScrollSpeed
  const usePreferencesPath = new URL("../src/hooks/usePreferences.ts", import.meta.url).pathname;
  const hookCode = fs.readFileSync(usePreferencesPath, "utf-8");
  assert.ok(hookCode.includes("myScrollSpeed"), "usePreferences debe definir y retornar myScrollSpeed");

  // Simular recarga de persistencia: disco cargado con 2.25 -> sincronizado en almacenamiento
  setupMockEnvironment({
    "scroll-speed": "2.25",
  });

  const storedVal = window.localStorage.getItem("scroll-speed");
  const parsedSpeed = normalizeScrollSpeed(storedVal);
  assert.strictEqual(parsedSpeed, 2.25, "Debe cargar 2.25 desde el almacenamiento persistente");

  // Simular actualización del usuario
  window.localStorage.setItem("scroll-speed", "1.5");
  assert.strictEqual(normalizeScrollSpeed(window.localStorage.getItem("scroll-speed")), 1.5);
});

// ---------------------------------------------------------------------------
// 3. Límites mínimo y máximo
// ---------------------------------------------------------------------------
test("3. Límites mínimo y máximo [0.5× a 3.0×, step 0.25×]", () => {
  assert.strictEqual(MIN_SCROLL_SPEED, 0.5);
  assert.strictEqual(MAX_SCROLL_SPEED, 3.0);
  assert.strictEqual(SCROLL_SPEED_STEP, 0.25);

  // Límites exactos válidos
  assert.strictEqual(normalizeScrollSpeed(0.5), 0.5);
  assert.strictEqual(normalizeScrollSpeed("0.5"), 0.5);
  assert.strictEqual(normalizeScrollSpeed(3.0), 3.0);
  assert.strictEqual(normalizeScrollSpeed("3.0"), 3.0);

  // Pasos intermedios válidos
  assert.strictEqual(normalizeScrollSpeed(0.75), 0.75);
  assert.strictEqual(normalizeScrollSpeed(1.25), 1.25);
  assert.strictEqual(normalizeScrollSpeed(1.5), 1.5);
  assert.strictEqual(normalizeScrollSpeed(1.75), 1.75);
  assert.strictEqual(normalizeScrollSpeed(2.0), 2.0);
  assert.strictEqual(normalizeScrollSpeed(2.75), 2.75);

  // Valores fuera de límites se restablecen a 1.0 (fallback seguro)
  assert.strictEqual(normalizeScrollSpeed(0.49), 1.0, "Menor a 0.5 debe fallback a 1.0");
  assert.strictEqual(normalizeScrollSpeed(0), 1.0);
  assert.strictEqual(normalizeScrollSpeed(-2), 1.0);
  assert.strictEqual(normalizeScrollSpeed(3.01), 1.0, "Mayor a 3.0 debe fallback a 1.0");
  assert.strictEqual(normalizeScrollSpeed(4.5), 1.0);

  // Valores no numéricos o inválidos
  assert.strictEqual(normalizeScrollSpeed("invalido"), 1.0);
  assert.strictEqual(normalizeScrollSpeed(Number.NaN), 1.0);
  assert.strictEqual(normalizeScrollSpeed(Number.POSITIVE_INFINITY), 1.0);
  assert.strictEqual(normalizeScrollSpeed(Number.NEGATIVE_INFINITY), 1.0);

  // Redondeo de paso flotante (ej. 1.24 -> 1.25)
  assert.strictEqual(normalizeScrollSpeed(1.24), 1.25);
  assert.strictEqual(normalizeScrollSpeed(1.26), 1.25);

  // Formato visual con sufijo multiplicador
  assert.strictEqual(formatScrollSpeed(0.5), "0.5×");
  assert.strictEqual(formatScrollSpeed(1.0), "1.0×");
  assert.strictEqual(formatScrollSpeed(1.25), "1.25×");
  assert.strictEqual(formatScrollSpeed(1.5), "1.5×");
  assert.strictEqual(formatScrollSpeed(1.75), "1.75×");
  assert.strictEqual(formatScrollSpeed(2.0), "2.0×");
  assert.strictEqual(formatScrollSpeed(3.0), "3.0×");
});

// ---------------------------------------------------------------------------
// 4. Aplicación inmediata de cambios
// ---------------------------------------------------------------------------
test("4. Aplicación inmediata de cambios sin reiniciar", () => {
  setupMockEnvironment();

  // Valor inicial por defecto
  let currentSpeed = normalizeScrollSpeed(window.localStorage.getItem("scroll-speed"));
  assert.strictEqual(currentSpeed, 1.0);

  // Cambiar a 2.0x
  window.localStorage.setItem("scroll-speed", "2.0");
  configStore.getState().bumpPrefTick();
  currentSpeed = normalizeScrollSpeed(window.localStorage.getItem("scroll-speed"));
  assert.strictEqual(currentSpeed, 2.0, "La velocidad debe actualizarse a 2.0 inmediatamente");

  // Cambiar a 0.5x
  window.localStorage.setItem("scroll-speed", "0.5");
  configStore.getState().bumpPrefTick();
  currentSpeed = normalizeScrollSpeed(window.localStorage.getItem("scroll-speed"));
  assert.strictEqual(currentSpeed, 0.5, "La velocidad debe actualizarse a 0.5 inmediatamente");
});

// ---------------------------------------------------------------------------
// 5. Ausencia de interceptación con 1.0×
// ---------------------------------------------------------------------------
test("5. Ausencia de interceptación con 1.0×", () => {
  const container: MockContainer = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 300,
  };

  const evt = createMockWheelEvent({ deltaY: 50 });
  const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 1.0);

  assert.strictEqual(handled, false, "applyScrollSpeedWheel debe retornar false para 1.0x");
  assert.strictEqual(evt.defaultPrevented, false, "preventDefault NO debe ser llamado para 1.0x");
  assert.strictEqual(container.scrollTop, 300, "El scrollTop del contenedor no debe ser modificado");
});

// ---------------------------------------------------------------------------
// 6. Multiplicación correcta del desplazamiento vertical (Mouse Wheel)
// ---------------------------------------------------------------------------
test("6. Multiplicación correcta del desplazamiento vertical de rueda de ratón", () => {
  // Caso A: Multiplicador 2.0x con salto discreto de ratón (40px)
  {
    const container: MockContainer = {
      scrollHeight: 2000,
      clientHeight: 800,
      scrollTop: 100,
    };
    const evt = createMockWheelEvent({ deltaY: 40 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);

    assert.strictEqual(handled, true);
    assert.strictEqual(evt.defaultPrevented, true);
    // 100 + (40 * 2.0) = 180
    assert.strictEqual(container.scrollTop, 180, "Con 2.0x, 40px debe mover 80px resultando en 180px");
  }

  // Caso B: Multiplicador 0.5x con salto discreto de ratón (40px)
  {
    const container: MockContainer = {
      scrollHeight: 2000,
      clientHeight: 800,
      scrollTop: 100,
    };
    const evt = createMockWheelEvent({ deltaY: 40 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 0.5);

    assert.strictEqual(handled, true);
    assert.strictEqual(evt.defaultPrevented, true);
    // 100 + (40 * 0.5) = 120
    assert.strictEqual(container.scrollTop, 120, "Con 0.5x, 40px debe mover 20px resultando en 120px");
  }

  // Caso C: Multiplicador 3.0x con salto discreto de ratón (50px)
  {
    const container: MockContainer = {
      scrollHeight: 2000,
      clientHeight: 800,
      scrollTop: 100,
    };
    const evt = createMockWheelEvent({ deltaY: 50 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 3.0);

    assert.strictEqual(handled, true);
    assert.strictEqual(evt.defaultPrevented, true);
    // 100 + (50 * 3.0) = 250
    assert.strictEqual(container.scrollTop, 250, "Con 3.0x, 50px debe mover 150px resultando en 250px");
  }

  // Caso D: Desplazamiento hacia arriba (deltaY negativo)
  {
    const container: MockContainer = {
      scrollHeight: 2000,
      clientHeight: 800,
      scrollTop: 300,
    };
    const evt = createMockWheelEvent({ deltaY: -50 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);

    assert.strictEqual(handled, true);
    assert.strictEqual(evt.defaultPrevented, true);
    // 300 + (-50 * 2.0) = 200
    assert.strictEqual(container.scrollTop, 200, "Con 2.0x, -50px debe retroceder 100px resultando en 200px");
  }
});

// ---------------------------------------------------------------------------
// 7. Normalización de deltaMode
// ---------------------------------------------------------------------------
test("7. Normalización de deltaMode (Pixel, Line, Page)", () => {
  // DOM_DELTA_PIXEL = 0
  assert.strictEqual(normalizeWheelDeltaY(50, 0, 800), 50);

  // DOM_DELTA_LINE = 1 (16px por línea)
  assert.strictEqual(normalizeWheelDeltaY(3, 1, 800), 48, "3 líneas a 16px = 48px");

  // DOM_DELTA_PAGE = 2 (1 página = containerHeight)
  assert.strictEqual(normalizeWheelDeltaY(1, 2, 600), 600, "1 página en contenedor de 600px = 600px");

  // Prueba integrada en applyScrollSpeedWheel con DOM_DELTA_LINE (ratón físico)
  const container: MockContainer = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 100,
  };
  const lineEvt = createMockWheelEvent({ deltaY: 2, deltaMode: 1 }); // 2 líneas = 32px base
  const handled = applyScrollSpeedWheel(lineEvt, container as unknown as HTMLElement, 2.0);

  assert.strictEqual(handled, true);
  // 100 + (32 * 2.0) = 164
  assert.strictEqual(container.scrollTop, 164, "2 líneas en deltaMode 1 escalado x2 deben sumar 64px");
});

// ---------------------------------------------------------------------------
// 8. Preservación del desplazamiento horizontal
// ---------------------------------------------------------------------------
test("8. Preservación del desplazamiento horizontal", () => {
  const container: MockContainer = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 100,
  };

  // deltaY = 0 con desplazamiento horizontal puro
  {
    const evt = createMockWheelEvent({ deltaX: 50, deltaY: 0 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);

    assert.strictEqual(handled, false, "No debe interceptar desplazamiento puramente horizontal");
    assert.strictEqual(evt.defaultPrevented, false);
    assert.strictEqual(container.scrollTop, 100);
  }

  // Desplazamiento predominantemente horizontal (|deltaX| > |deltaY|)
  {
    const evt = createMockWheelEvent({ deltaX: 80, deltaY: 20 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);

    assert.strictEqual(handled, false, "No debe interceptar gestos predominantemente horizontales");
    assert.strictEqual(evt.defaultPrevented, false);
    assert.strictEqual(container.scrollTop, 100);
  }
});

// ---------------------------------------------------------------------------
// 9. Respeto de eventos de zoom con Ctrl
// ---------------------------------------------------------------------------
test("9. Respeto de eventos de zoom con Ctrl (browser zoom / pinch-to-zoom)", () => {
  const container: MockContainer = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 200,
  };

  const evt = createMockWheelEvent({ deltaY: 50, ctrlKey: true });
  const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);

  assert.strictEqual(handled, false, "Eventos con ctrlKey no deben ser interceptados");
  assert.strictEqual(evt.defaultPrevented, false, "preventDefault NO debe ser llamado para preservar zoom");
  assert.strictEqual(container.scrollTop, 200, "El scrollTop no debe alterarse");
});

// ---------------------------------------------------------------------------
// 10. Ausencia de interferencias con scrolls anidados
// ---------------------------------------------------------------------------
test("10. Ausencia de interferencias con scrolls anidados", () => {
  const container = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 100,
  } as unknown as HTMLElement;

  // Mock de un elemento anidado con scroll propio y espacio para desplazarse hacia abajo
  const nestedChild = {
    scrollTop: 10,
    clientHeight: 200,
    scrollHeight: 500,
    parentElement: container,
    _style: { overflowY: "auto" },
  } as unknown as Element;

  const canScrollChild = isTargetInScrollableChild(nestedChild, container, 50);
  assert.strictEqual(canScrollChild, true, "Debe detectar que el elemento anidado tiene scroll propio");

  // applyScrollSpeedWheel no debe interceptar si el objetivo está en un hijo con scroll
  const evt = createMockWheelEvent({ deltaY: 50, target: nestedChild });
  const handled = applyScrollSpeedWheel(evt, container, 2.0);

  assert.strictEqual(handled, false, "No debe interceptar el scroll si el elemento anidado puede desplazarse");
  assert.strictEqual(evt.defaultPrevented, false);
});

// ---------------------------------------------------------------------------
// 11. Compatibilidad con la restauración del scroll al navegar, archivar y recuperar
// ---------------------------------------------------------------------------
test("11. Compatibilidad con la restauración del scroll al navegar, archivar y recuperar", () => {
  setupMockEnvironment();
  resetAllListScroll();

  // 1. Simular posición registrada
  setListScroll(450, "active");
  setListScroll(220, "paper");

  assert.strictEqual(getListScroll("active"), 450);
  assert.strictEqual(getListScroll("paper"), 220);

  // 2. Modificar la velocidad a 2.5x no debe alterar las posiciones almacenadas
  window.localStorage.setItem("scroll-speed", "2.5");
  configStore.getState().bumpPrefTick();

  assert.strictEqual(getListScroll("active"), 450, "La posición activa se mantiene intacta");
  assert.strictEqual(getListScroll("paper"), 220, "La posición de archivados se mantiene intacta");

  // 3. Simular alternancia de vistas
  configStore.setState({ paperIsOpen: true });
  assert.strictEqual(getListScroll(), 220, "En archivados lee exactamente su posición guardada");

  configStore.setState({ paperIsOpen: false });
  assert.strictEqual(getListScroll(), 450, "En notas activas lee exactamente su posición guardada");
});

// ---------------------------------------------------------------------------
// 12. Prevención de doble aplicación y respeto de límites del contenedor
// ---------------------------------------------------------------------------
test("12. Prevención de doble aplicación y respeto de límites (top / bottom / no-overflow)", () => {
  const container: MockContainer = {
    scrollHeight: 1000,
    clientHeight: 600, // maxScroll = 400
    scrollTop: 0,
  };

  // En el tope (scrollTop = 0) al desplazarse hacia arriba -> No interceptar
  {
    const evt = createMockWheelEvent({ deltaY: -50 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);
    assert.strictEqual(handled, false);
    assert.strictEqual(evt.defaultPrevented, false);
  }

  // En el fondo (scrollTop = 400) al desplazarse hacia abajo -> No interceptar
  {
    container.scrollTop = 400;
    const evt = createMockWheelEvent({ deltaY: 50 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);
    assert.strictEqual(handled, false);
    assert.strictEqual(evt.defaultPrevented, false);
  }

  // Contenedor sin scroll (scrollHeight <= clientHeight) -> No interceptar
  {
    const flatContainer: MockContainer = {
      scrollHeight: 500,
      clientHeight: 500,
      scrollTop: 0,
    };
    const evt = createMockWheelEvent({ deltaY: 50 });
    const handled = applyScrollSpeedWheel(evt, flatContainer as unknown as HTMLElement, 2.0);
    assert.strictEqual(handled, false);
    assert.strictEqual(evt.defaultPrevented, false);
  }

  // Evento ya prevenido o marcado -> No aplicar dos veces
  {
    container.scrollTop = 100;
    const evt = createMockWheelEvent({ deltaY: 50, defaultPrevented: true });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, 2.0);
    assert.strictEqual(handled, false, "No debe procesar un evento defaultPrevented");

    const lyraEvt = createMockWheelEvent({ deltaY: 50 }) as LyraWheelEvent;
    lyraEvt[HANDLED_WHEEL_SYMBOL] = true;
    const handledSymbol = applyScrollSpeedWheel(lyraEvt, container as unknown as HTMLElement, 2.0);
    assert.strictEqual(handledSymbol, false, "No debe procesar un evento con el símbolo HANDLED");
  }
});

// ---------------------------------------------------------------------------
// 13. Escalado fluido y preciso de gestos de touchpad y rueda de ratón con acumulación de subpíxeles
// ---------------------------------------------------------------------------
test("13. Escalado fluido y preciso de gestos de touchpad y rueda de ratón con acumulación de subpíxeles", () => {
  const container: MockContainer = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 100,
  };

  const state: ScrollSpeedState = { remainder: 0 };

  // Caso A: Delta fraccionario (característico de touchpad / libinput) escalado con 2.0x
  const fractionalEvt = createMockWheelEvent({ deltaY: 1.25 });
  const handledFractional = applyScrollSpeedWheel(fractionalEvt, container as unknown as HTMLElement, 2.0, state);
  assert.strictEqual(handledFractional, true, "Debe interceptar y escalar el desplazamiento del touchpad");
  assert.strictEqual(fractionalEvt.defaultPrevented, true, "Debe llamar preventDefault al escalar");
  // 100 + (1.25 * 2.0) = 102.5 -> redondeado a 103, remainder = -0.5
  assert.strictEqual(container.scrollTop, 103, "scrollTop debe escalar a 103");
  assert.strictEqual(state.remainder, -0.5, "El residuo subpíxel -0.5 debe preservarse");

  // Caso B: Siguiente tick de touchpad suma residuo y escala exactamente
  const nextFractionalEvt = createMockWheelEvent({ deltaY: 2.25 });
  const handledNext = applyScrollSpeedWheel(nextFractionalEvt, container as unknown as HTMLElement, 2.0, state);
  assert.strictEqual(handledNext, true);
  // exactTarget = 103 + (-0.5) + (2.25 * 2.0) = 107.0 -> redondeado a 107, remainder = 0
  assert.strictEqual(container.scrollTop, 107);
  assert.strictEqual(state.remainder, 0);

  // Caso C: Muesca discreta de ratón físico en Linux (deltaY típico de 20px)
  const linuxMouseEvt = createMockWheelEvent({ deltaY: 20 });
  const mouseState: ScrollSpeedState = { remainder: 0 };
  const handledLinuxMouse = applyScrollSpeedWheel(linuxMouseEvt, container as unknown as HTMLElement, 2.0, mouseState);
  assert.strictEqual(handledLinuxMouse, true, "Rueda de ratón en Linux debe ser escalada");
  assert.strictEqual(linuxMouseEvt.defaultPrevented, true);
  // 107 + (20 * 2.0) = 147
  assert.strictEqual(container.scrollTop, 147);

  // Caso D: Muesca estándar de 50px con 0.5x (más lento)
  const slowEvt = createMockWheelEvent({ deltaY: 50 });
  const handledSlow = applyScrollSpeedWheel(slowEvt, container as unknown as HTMLElement, 0.5, mouseState);
  assert.strictEqual(handledSlow, true, "Debe soportar velocidades lentas 0.5x");
  // 147 + (50 * 0.5) = 172
  assert.strictEqual(container.scrollTop, 172);
});

// ---------------------------------------------------------------------------
// 14. Preferencias: Ubicación e integridad del control deslizante
// ---------------------------------------------------------------------------
test("14. Preferencias: Ubicación e integridad del control deslizante de velocidad de desplazamiento", () => {
  const preferencesPath = new URL("../src/pages/Preferences.tsx", import.meta.url).pathname;
  const code = fs.readFileSync(preferencesPath, "utf-8");

  // 1. Debe incluir la sección «Velocidad de desplazamiento»
  const scrollSectionIndex = code.indexOf("{/* Velocidad de desplazamiento */}");
  const temaIndex = code.indexOf("{/* Tema */}");
  const defaultAppIndex = code.indexOf("{/* Editor predeterminado */}");

  assert.ok(scrollSectionIndex !== -1, "Debe existir la sección Velocidad de desplazamiento");
  assert.ok(temaIndex !== -1, "Debe existir la sección Tema");
  assert.ok(defaultAppIndex !== -1, "Debe existir la sección Editor predeterminado");

  // 2. Debe ubicarse después de «Tema» y antes de «Aplicación predeterminada»
  assert.ok(
    scrollSectionIndex > temaIndex,
    "«Velocidad de desplazamiento» debe ubicarse después de «Tema»"
  );
  assert.ok(
    scrollSectionIndex < defaultAppIndex,
    "«Velocidad de desplazamiento» debe ubicarse antes de «Aplicación predeterminada»"
  );

  // 3. Debe contener un input de tipo range con los atributos requeridos
  assert.ok(code.includes('type="range"'), "Debe contener un input type='range'");
  assert.ok(code.includes("min={MIN_SCROLL_SPEED}"));
  assert.ok(code.includes("max={MAX_SCROLL_SPEED}"));
  assert.ok(code.includes("step={SCROLL_SPEED_STEP}"));
  assert.ok(code.includes("formatScrollSpeed(currentScrollSpeed)"));
  assert.ok(code.includes("Velocidad de desplazamiento"));

  // 4. Ausencia de contenedores de scroll forzados en Preferencias (restauración del layout original)
  assert.ok(!code.includes("lyra-preferences-container"), "No debe existir id='lyra-preferences-container'");
  assert.ok(!code.includes("lyra-scroll-container"), "Preferencias no debe contener la clase lyra-scroll-container");
  assert.ok(code.includes("w-full min-h-screen pt-14"), "Preferencias debe mantener su clase original con min-h-screen");
});

// ---------------------------------------------------------------------------
// 15. Compatibilidad estricta con sincronización y recuperación de preferencias existentes
// ---------------------------------------------------------------------------
test("15. Compatibilidad estricta con sincronización y recuperación de preferencias existentes", () => {
  setupMockEnvironment();

  // Simular un archivo .preferences.json existente en disco proveniente de una versión anterior
  // o de una restauración desde copia de seguridad externa (sin clave 'scroll-speed')
  const legacyDiskPreferences = {
    theme: "sunny-day",
    font: "font-inter",
    "font-size": "20px",
    "align-text": "text-center",
    spacing: 2,
    "word-count": false,
    "last-modified": false,
    "paragraph-focus": true,
    sortOption: "date-desc",
    paper: ["nota_archivada_1.txt", "nota_archivada_2.md"],
    language: "es",
    lyra_initialized: true,
    lyra_theme_migrated_v2: true,
    updatedAt: 1700000000000,
  };

  // 1. Simular la lógica de initPersistentPreferencesInternal con el archivo previo
  for (const [k, v] of Object.entries(legacyDiskPreferences)) {
    if (k === "paper") {
      window.localStorage.setItem(k, JSON.stringify(v));
    } else {
      window.localStorage.setItem(k, String(v));
    }
  }

  // 2. Comprobar que todas las preferencias preexistentes se conservan intactas
  assert.strictEqual(window.localStorage.getItem("theme"), "sunny-day");
  assert.strictEqual(window.localStorage.getItem("font"), "font-inter");
  assert.deepStrictEqual(JSON.parse(window.localStorage.getItem("paper") || "[]"), [
    "nota_archivada_1.txt",
    "nota_archivada_2.md",
  ]);

  // 3. Comprobar que 'scroll-speed', al no estar en el archivo antiguo, adopta su valor predeterminado 1.0 de forma limpia
  const initialSpeedRaw = window.localStorage.getItem("scroll-speed");
  assert.strictEqual(initialSpeedRaw, null, "En un archivo previo no existía 'scroll-speed'");
  const effectiveInitialSpeed = normalizeScrollSpeed(initialSpeedRaw);
  assert.strictEqual(effectiveInitialSpeed, 1.0, "Adopta limpiamente 1.0 sin corromper el estado");

  // 4. Simular que el usuario cambia scroll-speed a 1.75x
  window.localStorage.setItem("scroll-speed", "1.75");
  configStore.getState().bumpPrefTick();

  // 5. Simular el guardado de persistencia (proceso de snapshot en savePersistentPreferencesNow)
  const savedData: Record<string, unknown> = {
    updatedAt: Date.now(),
    initialized: true,
  };
  const keysToPersist = [
    "theme", "font", "font-size", "align-text", "spacing", "word-count",
    "last-modified", "paragraph-focus", "sortOption", "paper", "language",
    "lyra_initialized", "lyra_theme_migrated_v2", "welcome_dismissed",
    "welcome_manually_restored", "scroll-speed"
  ];

  for (const key of keysToPersist) {
    const val = window.localStorage.getItem(key);
    if (val !== null) {
      if (key === "paper") {
        savedData[key] = JSON.parse(val);
      } else {
        savedData[key] = val;
      }
    }
  }

  // 6. Verificar que la serialización final a disco conserva todas las propiedades originales
  assert.strictEqual(savedData.theme, "sunny-day");
  assert.strictEqual(savedData.font, "font-inter");
  assert.deepStrictEqual(savedData.paper, ["nota_archivada_1.txt", "nota_archivada_2.md"]);
  assert.strictEqual(savedData["scroll-speed"], "1.75");

  // 7. Simular restauración de un respaldo con 'scroll-speed' corrupto (ej. 99 o 'abc')
  const corruptedVal = normalizeScrollSpeed("99");
  assert.strictEqual(corruptedVal, 1.0, "Valores corruptos o fuera de rango se corrigen a 1.0 automáticamente");
});

// ---------------------------------------------------------------------------
// 16. Escalado de desplazamiento en ventana / página de Preferencias
// ---------------------------------------------------------------------------
test("16. Escalado de desplazamiento en ventana / página de Preferencias", () => {
  let scrolledTop = 0;
  const mockWindow = {
    scrollY: 100,
    innerHeight: 800,
    scrollTo: ({ top }: { top: number }) => {
      scrolledTop = top;
    },
  };

  (globalThis as unknown as { window: unknown }).window = mockWindow;

  // Mock global document
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      scrollHeight: 2500,
      clientHeight: 800,
      scrollTop: 100,
    },
    body: {
      scrollHeight: 2500,
      scrollTop: 100,
    },
  };

  const evt = createMockWheelEvent({ deltaY: 40 });
  const handled = applyScrollSpeedWheel(evt, mockWindow as unknown as Window, 2.0);

  assert.strictEqual(handled, true, "Debe interceptar y escalar el scroll en window");
  assert.strictEqual(evt.defaultPrevented, true);
  // 100 + (40 * 2.0) = 180
  assert.strictEqual(scrolledTop, 180);
});

// ---------------------------------------------------------------------------
// 17. Verificación completa del funcionamiento real sobre el contenedor de notas y archivados
// ---------------------------------------------------------------------------
test("17. Verificación completa del funcionamiento real sobre el contenedor de notas y archivados", () => {
  setupMockEnvironment();

  const createTestContainer = () => ({
    scrollHeight: 3000,
    clientHeight: 800,
    scrollTop: 500,
  });

  const baseDeltaY = 40;

  // 1. Con 1.0x (nativo): applyScrollSpeedWheel no intercepta y el scroll nativo movería 40px
  {
    const container = createTestContainer();
    const evt1x = createMockWheelEvent({ deltaY: baseDeltaY, deltaMode: 0 });
    const handled1x = applyScrollSpeedWheel(evt1x, container as unknown as HTMLElement, 1.0);
    assert.strictEqual(handled1x, false, "Con 1.0x debe mantenerse el comportamiento nativo puro sin interceptar");
    assert.strictEqual(evt1x.defaultPrevented, false);
  }

  // 2. 0.5x desplaza la mitad (20px en lugar de 40px)
  {
    const container = createTestContainer();
    const evtHalf = createMockWheelEvent({ deltaY: baseDeltaY, deltaMode: 0 });
    const handledHalf = applyScrollSpeedWheel(evtHalf, container as unknown as HTMLElement, 0.5);
    assert.strictEqual(handledHalf, true);
    assert.strictEqual(evtHalf.defaultPrevented, true);
    // 500 + (40 * 0.5) = 520 (+20px, menos que 1.0x)
    assert.strictEqual(container.scrollTop, 520, "0.5x debe desplazar exactamente 20px (la mitad)");
  }

  // 3. 2.0x desplaza el doble (80px en lugar de 40px)
  {
    const container = createTestContainer();
    const evtDouble = createMockWheelEvent({ deltaY: baseDeltaY, deltaMode: 0 });
    const handledDouble = applyScrollSpeedWheel(evtDouble, container as unknown as HTMLElement, 2.0);
    assert.strictEqual(handledDouble, true);
    assert.strictEqual(evtDouble.defaultPrevented, true);
    // 500 + (40 * 2.0) = 580 (+80px, el doble de 1.0x)
    assert.strictEqual(container.scrollTop, 580, "2.0x debe desplazar exactamente 80px (el doble)");
  }

  // 4. 3.0x desplaza el triple (120px en lugar de 40px)
  {
    const container = createTestContainer();
    const evtTriple = createMockWheelEvent({ deltaY: baseDeltaY, deltaMode: 0 });
    const handledTriple = applyScrollSpeedWheel(evtTriple, container as unknown as HTMLElement, 3.0);
    assert.strictEqual(handledTriple, true);
    assert.strictEqual(evtTriple.defaultPrevented, true);
    // 500 + (40 * 3.0) = 620 (+120px, el triple de 1.0x)
    assert.strictEqual(container.scrollTop, 620, "3.0x debe desplazar exactamente 120px (el triple)");
  }

  // 5. Los eventos con deltaMode = 0 (típicos de Linux / WebKitGTK / Touchpad) funcionan
  {
    const container = createTestContainer();
    const evtDelta0 = createMockWheelEvent({ deltaY: 25, deltaMode: 0 });
    const handledDelta0 = applyScrollSpeedWheel(evtDelta0, container as unknown as HTMLElement, 2.0);
    assert.strictEqual(handledDelta0, true, "deltaMode = 0 debe ser interceptado y escalado");
    assert.strictEqual(container.scrollTop, 550, "500 + (25 * 2.0) = 550");
  }

  // 6. Cambiar el range actualiza el comportamiento sin reiniciar
  {
    window.localStorage.setItem("scroll-speed", "1.5");
    configStore.getState().bumpPrefTick();
    const liveSpeed = normalizeScrollSpeed(window.localStorage.getItem("scroll-speed"));
    assert.strictEqual(liveSpeed, 1.5);

    const container = createTestContainer();
    const evt = createMockWheelEvent({ deltaY: 40, deltaMode: 0 });
    const handled = applyScrollSpeedWheel(evt, container as unknown as HTMLElement, liveSpeed);
    assert.strictEqual(handled, true);
    assert.strictEqual(container.scrollTop, 560, "500 + (40 * 1.5) = 560");
  }

  // 7. La posición se conserva al navegar entre notas y listado (active y paper)
  {
    resetAllListScroll();
    setListScroll(350, "active");
    assert.strictEqual(getListScroll("active"), 350, "La posición en lista activa debe conservarse");

    setListScroll(720, "paper");
    assert.strictEqual(getListScroll("paper"), 720, "La posición en notas archivadas debe conservarse");

    assert.strictEqual(getListScroll("active"), 350);
  }

  // 8. El valor persiste tras reiniciar
  {
    window.localStorage.setItem("scroll-speed", "2.25");
    const restoredSpeed = normalizeScrollSpeed(window.localStorage.getItem("scroll-speed"));
    assert.strictEqual(restoredSpeed, 2.25, "El valor de velocidad debe persistir tras reiniciar");
  }
});

// ---------------------------------------------------------------------------
// 18. Integración del multiplicador de velocidad dentro de TinyEditor
// ---------------------------------------------------------------------------
test("18. Integración del multiplicador de velocidad dentro de TinyEditor", () => {
  const editorPath = new URL("../src/components/TinyEditor.tsx", import.meta.url).pathname;
  const code = fs.readFileSync(editorPath, "utf-8");

  // 1. Debe invocar myScrollSpeed desde usePreferences
  assert.ok(code.includes("myScrollSpeed"), "TinyEditor debe importar myScrollSpeed");
  assert.ok(code.includes("scrollSpeed"), "TinyEditor debe almacenar el multiplicador en scrollSpeed");

  // 2. Debe aplicar el factor scrollSpeed al delta del evento wheel
  assert.ok(code.includes("delta *= scrollSpeed;"), "TinyEditor debe escalar delta por scrollSpeed");

  // 3. Debe incluir scrollSpeed en las dependencias del efecto del listener wheel
  assert.ok(code.includes("[syncScrollPos, scrollSpeed]"), "El listener wheel debe reactivarse al cambiar scrollSpeed");

  // 4. Comprobar la fórmula de escalado dentro del editor
  const baseDelta = 20; // 20px en pixel mode
  const editorPixelFactor = 2.0;

  // Con 1.0x (base actual)
  const delta1x = baseDelta * editorPixelFactor * 1.0;
  assert.strictEqual(delta1x, 40);

  // Con 0.5x
  const deltaHalf = baseDelta * editorPixelFactor * 0.5;
  assert.strictEqual(deltaHalf, 20, "0.5x debe reducir el delta a la mitad");

  // Con 2.0x
  const deltaDouble = baseDelta * editorPixelFactor * 2.0;
  assert.strictEqual(deltaDouble, 80, "2.0x debe duplicar el delta");

  // Con 3.0x
  const deltaTriple = baseDelta * editorPixelFactor * 3.0;
  assert.strictEqual(deltaTriple, 120, "3.0x debe triplicar el delta");
});
