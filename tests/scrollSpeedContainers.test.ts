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
// 19. El listado aplica la velocidad sobre el scroll real de la ventana
// ---------------------------------------------------------------------------
test("19. El listado aplica la velocidad sobre el scroll real de la ventana (List + Preferencias)", () => {
  const listPath = new URL("../src/pages/List.tsx", import.meta.url).pathname;
  const listCode = fs.readFileSync(listPath, "utf-8");

  // El scroll real del listado es el de la ventana (html overflow-y: scroll),
  // igual que en Preferencias. El hook debe usarse sin ref al div interno.
  assert.ok(listCode.includes("useScrollSpeed();"), "List debe invocar useScrollSpeed() sobre window");
  assert.ok(!listCode.includes("useScrollSpeed(containerRef)"), "List no debe adjuntar la velocidad al div interno no-scrollable");

  // La posición se registra desde la ventana, no desde el div
  assert.ok(listCode.includes('window.addEventListener("scroll"'), "List debe registrar el scroll de la ventana");
  assert.ok(listCode.includes("getScrollPos("), "List debe guardar la posición vía getScrollPos");
  assert.ok(listCode.includes("applyListScroll("), "List debe restaurar vía applyListScroll");
  assert.ok(!listCode.includes("containerRef"), "List no debe conservar ref al contenedor no-scrollable");

  const prefsPath = new URL("../src/pages/Preferences.tsx", import.meta.url).pathname;
  const prefsCode = fs.readFileSync(prefsPath, "utf-8");
  assert.ok(prefsCode.includes("useScrollSpeed();"), "Preferencias usa useScrollSpeed() sobre window");

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
  const editorPath = new URL("../src/components/TinyEditor.tsx", import.meta.url).pathname;
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
// 21. listScroll es consciente del modelo real: ventana si el div no es scrollable
// ---------------------------------------------------------------------------
test("21. listScroll usa la ventana cuando el div del listado no es scrollable", () => {
  const listScrollPath = new URL("../src/utils/listScroll.ts", import.meta.url).pathname;
  const code = fs.readFileSync(listScrollPath, "utf-8");

  assert.ok(code.includes("isListContainerScrollable"), "listScroll debe distinguir contenedor scrollable de ventana");
  assert.ok(code.includes("getWindowScrollTop"), "listScroll debe exponer lectura del scroll de ventana");
  assert.ok(code.includes("getWindowMaxScroll"), "listScroll debe exponer máximo del scroll de ventana");
  assert.ok(code.includes("setWindowScrollTop"), "listScroll debe escribir el scroll de ventana");

  // Comportamiento funcional: div no-scrollable (scrollHeight == clientHeight)
  // pero ventana con contenido. getScrollPos/applyListScroll/getMaxScroll deben operar en ventana.
  let windowTop = 123;
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
  const fakeContainer = {
    scrollHeight: 800,
    clientHeight: 800, // no-scrollable: max = 0
    scrollTop: 0,
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
    getComputedStyle: () => ({ overflowY: "visible", overflowX: "visible" }),
  };
  (globalThis as unknown as { document: unknown }).document = {
    getElementById: (id: string) => (id === "lyra-list-scroll-container" ? fakeContainer : null),
    documentElement: { scrollHeight: 3000, clientHeight: 800, scrollTop: windowTop },
    body: { scrollHeight: 3000, clientHeight: 800, scrollTop: windowTop },
  };

  // Con div no-scrollable, la posición y el máximo vienen de la ventana,
  // y la escritura va a la ventana (no al div).
  assert.strictEqual(getScrollPos(), 123, "getScrollPos debe leer la ventana si el div no es scrollable");
  assert.strictEqual(getMaxScroll(), 2200, "getMaxScroll debe ser 3000-800=2200 en ventana");
  const clamped = applyListScroll(500);
  assert.strictEqual(clamped, 500, "applyListScroll debe aplicar 500 en la ventana");
  assert.strictEqual(windowTop, 500, "La ventana debe haber recibido el scroll 500");
  assert.strictEqual(fakeContainer.scrollTop, 0, "El div no-scrollable no debe recibir el scroll");

  // Verificación por inspección: cuando el contenedor no es scrollable se usa la ventana
  assert.ok(
    code.includes("isListContainerScrollable(container)") && code.includes("getWindowScrollTop()"),
    "getScrollPos debe delegar a la ventana si el contenedor no es scrollable"
  );
  assert.ok(
    code.includes("return getWindowMaxScroll()") || code.includes("return setWindowScrollTop(y)"),
    "getMaxScroll/applyListScroll deben delegar a la ventana si el contenedor no es scrollable"
  );
});

// ---------------------------------------------------------------------------
// 22. Sin dobles aplicaciones: HANDLED, defaultPrevented, ctrl, horizontal, cancelable
// ---------------------------------------------------------------------------
test("22. Sin aplicaciones duplicadas ni interferencias (HANDLED, ctrl, horizontal, cancelable)", () => {
  const hookPath = new URL("../src/hooks/useScrollSpeed.ts", import.meta.url).pathname;
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
