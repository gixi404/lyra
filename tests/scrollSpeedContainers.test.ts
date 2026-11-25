import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import {
  normalizeScrollSpeed,
  applyScrollSpeedWheel,
  HANDLED_WHEEL_SYMBOL,
} from "../src/utils/scrollSpeed.ts";
import {
  getScrollPos,
  getMaxScroll,
  applyListScroll,
} from "../src/utils/listScroll.ts";
import { configStore } from "../src/store/configStore.ts";

// ---------------------------------------------------------------------------
// 19. El listado usa un contenedor de scroll propio e independiente del editor
// ---------------------------------------------------------------------------
test("19. El listado usa un contenedor de scroll propio e independiente del documento/editor (List + Preferencias)", () => {
  const listPath = new URL("../src/pages/List.tsx", import.meta.url);
  const listCode = fs.readFileSync(listPath, "utf-8");

  // Scroll estructural: contenedor dedicado (no window) para evitar resets por html.in-editor/transiciones.
  assert.ok(listCode.includes("containerRef"), "List debe usar un contenedor de scroll dedicado");
  assert.ok(listCode.includes("useScrollSpeed(containerRef)"), "List debe aplicar velocidad sobre el contenedor dedicado");
  assert.ok(!listCode.includes("useScrollSpeed();"), "List no debe aplicar velocidad sobre window (contaminado por el editor)");
  assert.ok(listCode.includes('id="lyra-list-scroll-container"'), "List debe exponer el contenedor de scroll principal");
  assert.ok(listCode.includes("in-list-scroll"), "List debe aislar el scroll de documento mientras está montado");
  assert.ok(listCode.includes('el.addEventListener("scroll"') || listCode.includes('.addEventListener("scroll"'), "List debe registrar el scroll del contenedor");
  assert.ok(!listCode.includes('window.addEventListener("scroll"'), "List no debe depender del scroll de ventana");
  assert.ok(listCode.includes("el.scrollTop"), "List debe capturar la posición desde el contenedor");
  assert.ok(listCode.includes("setListScroll("), "List debe persistir la posición");
  assert.ok(listCode.includes("applyListScroll("), "List debe restaurar vía applyListScroll");

  const prefsPath = new URL("../src/pages/Preferences.tsx", import.meta.url);
  const prefsCode = fs.readFileSync(prefsPath, "utf-8");
  assert.ok(prefsCode.includes("useScrollSpeed();"), "Preferencias conserva useScrollSpeed() sobre window");

  // Una única invocación por página: sin listeners duplicados
  const countOccurrences = (code: string, needle: string) =>
    code.split(needle).length - 1;
  assert.strictEqual(countOccurrences(listCode, "useScrollSpeed("), 1, "List monta un único hook de velocidad");
  assert.strictEqual(countOccurrences(prefsCode, "useScrollSpeed("), 1, "Preferencias monta un único hook de velocidad");
});

// ---------------------------------------------------------------------------
// 20. TinyEditor lee la preferencia viva y re-adjunta su listener independiente
// ---------------------------------------------------------------------------
test("20. TinyEditor lee la preferencia viva y re-adjunta su listener independiente", () => {
  const editorPath = new URL("../src/components/TinyEditor.tsx", import.meta.url);
  const code = fs.readFileSync(editorPath, "utf-8");

  assert.ok(code.includes("myScrollSpeed"), "TinyEditor debe leer myScrollSpeed de usePreferences");
  assert.ok(code.includes("myScrollSpeed()"), "TinyEditor debe invocar myScrollSpeed() en cada render (reflejo inmediato de prefTick)");
  assert.ok(!code.includes("scrollSpeed = 1"), "TinyEditor no debe usar el valor estático por defecto 1");
  assert.ok(code.includes("delta *= scrollSpeed;"), "TinyEditor debe escalar el delta por scrollSpeed");
  assert.ok(code.includes("[syncScrollPos, scrollSpeed]"), "TinyEditor debe re-adjuntar wheel al cambiar scrollSpeed");

  // Guardas: no interferir con zoom ni scroll horizontal ni eventos no cancelables
  assert.ok(code.includes("e.ctrlKey"), "TinyEditor debe respetar zoom con Ctrl");
  assert.ok(code.includes("Math.abs(e.deltaX) > Math.abs(e.deltaY)"), "TinyEditor debe respetar desplazamiento horizontal");
  assert.ok(code.includes("e.cancelable"), "TinyEditor debe respetar eventos no cancelables");

  // El listener se adjunta al textarea real (no a window) y se limpia al desmontar/cambiar velocidad
  assert.ok(code.includes('el.addEventListener("wheel", handleWheel'), "TinyEditor adjunta wheel al textarea");
  assert.ok(code.includes('el.removeEventListener("wheel", handleWheel)'), "TinyEditor limpia wheel al desmontar o cambiar velocidad");

  // No se adjunta el hook global en el editor (evita doble aplicación: el textarea
  // ya es el scroller y window vería un scroll anidado y cedería)
  assert.ok(!code.includes("useScrollSpeed"), "TinyEditor no debe montar useScrollSpeed (usa su handler suave propio)");
});

// ---------------------------------------------------------------------------
// 21. listScroll: contenedor dedicado cuando aplica, fallback a ventana si no
// ---------------------------------------------------------------------------
test("21. listScroll prioriza el contenedor dedicado del listado y usa ventana como fallback", () => {
  const listScrollPath = new URL("../src/utils/listScroll.ts", import.meta.url);
  const code = fs.readFileSync(listScrollPath, "utf-8");

  assert.ok(code.includes("isDedicatedListScroller") || code.includes("in-list-scroll"), "listScroll debe reconocer el contenedor dedicado del listado");
  assert.ok(code.includes("getWindowScrollTop"), "listScroll debe exponer lectura del scroll de ventana");
  assert.ok(code.includes("getWindowMaxScroll"), "listScroll debe exponer máximo del scroll de ventana");
  assert.ok(code.includes("setWindowScrollTop"), "listScroll debe escribir el scroll de ventana");

  // Contenedor dedicado (modo lista): la posición y escritura van al contenedor, no a la ventana.
  let windowTop = 123;
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
  const fakeContainer = {
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTop: 250,
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: mockStorage,
    sessionStorage: mockStorage,
    scrollY: windowTop,
    innerHeight: 800,
    scrollTo: ({ top }: { top: number }) => {
      windowTop = top;
      (globalThis.window as unknown as { scrollY: number }).scrollY = top;
      (globalThis.document as unknown as { documentElement: { scrollTop: number } }).documentElement.scrollTop = top;
    },
    getComputedStyle: () => ({ overflowY: "auto", overflowX: "hidden" }),
  };
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => (id === "lyra-list-scroll-container" ? fakeContainer : null),
    documentElement: { scrollHeight: 3000, clientHeight: 800, scrollTop: windowTop, classList: { contains: (c: string) => c === "in-list-scroll" } },
    body: { scrollHeight: 3000, clientHeight: 800, scrollTop: windowTop },
  };

  assert.strictEqual(getScrollPos(), 250, "getScrollPos debe leer el contenedor dedicado del listado");
  assert.strictEqual(getMaxScroll(), 1200, "getMaxScroll debe ser 2000-800=1200 en el contenedor");
  applyListScroll(500);
  assert.strictEqual(fakeContainer.scrollTop, 500, "applyListScroll debe desplazar el contenedor dedicado");
  assert.strictEqual(windowTop, 123, "applyListScroll no debe tocar la ventana cuando el contenedor es el scroller");

  // Fallback a ventana cuando no hay contenedor dedicado.
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: () => null,
    documentElement: { scrollHeight: 3000, clientHeight: 800, scrollTop: windowTop, classList: { contains: () => false } },
    body: { scrollHeight: 3000, clientHeight: 800, scrollTop: windowTop },
  };
  assert.strictEqual(getScrollPos(), 123, "sin contenedor dedicado, getScrollPos debe leer la ventana");
  applyListScroll(400);
  assert.strictEqual(windowTop, 400, "sin contenedor dedicado, applyListScroll debe desplazar la ventana");
});

// ---------------------------------------------------------------------------
// 22. Sin dobles aplicaciones: HANDLED, defaultPrevented, ctrl, horizontal, cancelable
// ---------------------------------------------------------------------------
test("22. Sin aplicaciones duplicadas ni interferencias (HANDLED, ctrl, horizontal, cancelable)", () => {
  const hookPath = new URL("../src/hooks/useScrollSpeed.ts", import.meta.url);
  const hookCode = fs.readFileSync(hookPath, "utf-8");
  assert.ok(hookCode.includes("removeEventListener"), "useScrollSpeed debe limpiar el listener");
  assert.ok(hookCode.includes("passive: false"), "useScrollSpeed debe usar passive: false para permitir preventDefault");

  function createEvt(opts: Record<string, unknown> = {}) {
    let prevented = (opts.defaultPrevented as boolean) ?? false;
    return {
      deltaY: (opts.deltaY as number) ?? 50,
      deltaX: (opts.deltaX as number) ?? 0,
      deltaMode: (opts.deltaMode as number) ?? 0,
      ctrlKey: (opts.ctrlKey as boolean) ?? false,
      cancelable: (opts.cancelable as boolean) ?? true,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault: () => {
        prevented = true;
      },
      target: (opts.target ?? null) as EventTarget | null,
    } as unknown as WheelEvent;
  }

  const container = { scrollHeight: 2000, clientHeight: 800, scrollTop: 100 } as unknown as HTMLElement;

  // Evento ya prevenido: no aplicar dos veces
  {
    const e = createEvt({ defaultPrevented: true });
    assert.strictEqual(applyScrollSpeedWheel(e, container, 2.0), false);
  }
  // Símbolo HANDLED: no aplicar dos veces
  {
    const e = createEvt({}) as WheelEvent & { [HANDLED_WHEEL_SYMBOL]?: boolean };
    e[HANDLED_WHEEL_SYMBOL] = true;
    assert.strictEqual(applyScrollSpeedWheel(e, container, 2.0), false);
  }
  // Ctrl (zoom): no interceptar
  {
    const e = createEvt({ ctrlKey: true });
    assert.strictEqual(applyScrollSpeedWheel(e, container, 2.0), false);
    assert.strictEqual(e.defaultPrevented, false);
  }
  // Horizontal predominante: no interceptar
  {
    const e = createEvt({ deltaX: 80, deltaY: 20 });
    assert.strictEqual(applyScrollSpeedWheel(e, container, 2.0), false);
  }
  // No cancelable: no interceptar
  {
    const e = createEvt({ cancelable: false });
    assert.strictEqual(applyScrollSpeedWheel(e, container, 2.0), false);
  }
  // deltaY nulo: no interceptar
  {
    const e = createEvt({ deltaY: 0, deltaX: 50 });
    assert.strictEqual(applyScrollSpeedWheel(e, container, 2.0), false);
  }
  // 1x nativo: no interceptar
  {
    const e = createEvt({ deltaY: 50 });
    assert.strictEqual(applyScrollSpeedWheel(e, container, 1.0), false);
    assert.strictEqual(e.defaultPrevented, false);
  }
});

// ---------------------------------------------------------------------------
// 23. Velocidades 0.5x, 1x, 1.25x, 2x, 3x graduales y aplicables sin reiniciar
// ---------------------------------------------------------------------------
test("23. Velocidades graduales 0.5x / 1x / 1.25x / 2x / 3x y actualización sin reiniciar", () => {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    getComputedStyle: () => ({ overflowY: "visible", overflowX: "visible" }),
  };

  const speeds: Array<{ speed: number; expected: number }> = [
    { speed: 0.5, expected: 520 }, // 500 + 40*0.5
    { speed: 1.0, expected: 500 }, // 1x nativo: no interceptado
    { speed: 1.25, expected: 550 }, // 500 + 40*1.25
    { speed: 2.0, expected: 580 }, // 500 + 40*2
    { speed: 3.0, expected: 620 }, // 500 + 40*3
  ];

  for (const { speed, expected } of speeds) {
    const container = { scrollHeight: 3000, clientHeight: 800, scrollTop: 500 } as unknown as HTMLElement;
    let prevented = false;
    const evt = {
      deltaY: 40,
      deltaX: 0,
      deltaMode: 0,
      ctrlKey: false,
      cancelable: true,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault: () => {
        prevented = true;
      },
      target: null,
    } as unknown as WheelEvent;

    if (speed === 1.0) {
      assert.strictEqual(applyScrollSpeedWheel(evt, container, speed), false, "1x debe conservar nativo");
      assert.strictEqual(container.scrollTop, 500);
    } else {
      assert.strictEqual(applyScrollSpeedWheel(evt, container, speed), true, `${speed}x debe interceptar`);
      assert.strictEqual(container.scrollTop, expected, `${speed}x debe desplazar ${40 * speed}px`);
    }
  }

  // La velocidad se actualiza sin reiniciar: lectura viva de localStorage + bump
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
    },
    getComputedStyle: () => ({ overflowY: "visible", overflowX: "visible" }),
  };
  store.set("scroll-speed", "1.25");
  assert.strictEqual(normalizeScrollSpeed(store.get("scroll-speed")), 1.25);
  configStore.getState().bumpPrefTick();
  store.set("scroll-speed", "3");
  assert.strictEqual(normalizeScrollSpeed(store.get("scroll-speed")), 3.0);
});
