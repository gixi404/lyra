export const DEFAULT_SCROLL_SPEED = 1.0;
export const MIN_SCROLL_SPEED = 0.5;
export const MAX_SCROLL_SPEED = 3.0;
export const SCROLL_SPEED_STEP = 0.25;
export const SCROLL_SPEED_STORAGE_KEY = "scroll-speed";

export const HANDLED_WHEEL_SYMBOL = Symbol.for("lyra.scrollSpeed.handled");

export interface LyraWheelEvent extends WheelEvent {
  [HANDLED_WHEEL_SYMBOL]?: boolean;
}

export interface ScrollSpeedState {
  remainder: number;
}

/**
 * Nota técnica sobre touchpads / trackpads:
 * La API DOM estándar WheelEvent no proporciona un mecanismo determinista para distinguir
 * entre una rueda física y un touchpad. Intentar clasificar el dispositivo mediante heurísticas
 * (como valores decimales, deltaMode o umbrales de píxeles) provoca que eventos legítimos
 * sean descartados silenciosamente, especialmente en Linux (Wayland / libinput / WebKitGTK)
 * donde las ruedas físicas generan saltos pequeños con deltaMode = 0.
 *
 * En consecuencia, el multiplicador se aplica a todos los eventos verticales compatibles.
 * Para preservar la máxima fluidez en touchpads con deltas fraccionarios continuos, se
 * mantiene un acumulador de residuo subpíxel (remainder).
 *
 * Limitación documentada:
 * Al interceptar wheel con preventDefault() y modificar scrollTop manualmente con un
 * multiplicador distinto de 1.0×, la distancia recorrida responde fielmente al multiplicador,
 * pero la inercia cinética nativa gestionada por el compositor del sistema operativo
 * puede comportarse con menor continuidad que con 1.0× (donde no se intercepta nada).
 */

/**
 * Valida y normaliza el multiplicador de velocidad de desplazamiento.
 * Si el valor no es numérico, es infinito, o está fuera del rango permitido [0.5, 3.0],
 * se devuelve el valor predeterminado 1.0.
 * Ajusta al múltiplo más cercano del incremento (0.25) para evitar imprecisiones de coma flotante.
 */
export function normalizeScrollSpeed(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_SCROLL_SPEED;
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) {
    return DEFAULT_SCROLL_SPEED;
  }
  if (num < MIN_SCROLL_SPEED || num > MAX_SCROLL_SPEED) {
    return DEFAULT_SCROLL_SPEED;
  }

  // Redondear al paso de 0.25 más cercano (ej. 1.25, 1.5, 1.75)
  const stepped = Math.round(num * 4) / 4;
  if (stepped < MIN_SCROLL_SPEED || stepped > MAX_SCROLL_SPEED) {
    return DEFAULT_SCROLL_SPEED;
  }
  return stepped;
}

/**
 * Formatea el multiplicador para su presentación visual:
 * 0.5×, 1.0×, 1.25×, 1.5×, etc.
 */
export function formatScrollSpeed(speed: number): string {
  const normalized = normalizeScrollSpeed(speed);
  const formatted = (normalized * 100) % 10 === 0 ? normalized.toFixed(1) : normalized.toFixed(2);
  return `${formatted}×`;
}

/**
 * Normaliza deltaMode según la especificación W3C:
 * - DOM_DELTA_PIXEL (0): píxeles directos.
 * - DOM_DELTA_LINE (1): líneas de texto (estándar ~16px).
 * - DOM_DELTA_PAGE (2): página completa (altura del contenedor visible o 800px).
 */
export function normalizeWheelDeltaY(deltaY: number, deltaMode: number, containerHeight: number): number {
  switch (deltaMode) {
    case 1: // DOM_DELTA_LINE
      return deltaY * 16;
    case 2: // DOM_DELTA_PAGE
      return deltaY * (containerHeight > 0 ? containerHeight : 800);
    case 0: // DOM_DELTA_PIXEL
    default:
      return deltaY;
  }
}

/**
 * Comprueba si el cursor se encuentra sobre un elemento anidado con su propio scroll
 * que aún tiene capacidad de desplazarse en la dirección indicada por deltaY.
 */
export function isTargetInScrollableChild(
  target: EventTarget | null,
  container: HTMLElement | Window,
  deltaY: number
): boolean {
  if (!target) return false;
  const isElement =
    typeof Element !== "undefined"
      ? target instanceof Element
      : typeof (target as { parentElement?: unknown }).parentElement !== "undefined";
  if (!isElement) return false;

  const isWindow = typeof window !== "undefined" && (container === window || !container);
  let current: Element | null = target as Element;
  while (
    current &&
    (isWindow
      ? current !== document.body && current !== document.documentElement
      : current !== container)
  ) {
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      try {
        const style = window.getComputedStyle(current);
        if (style) {
          const overflowY = style.overflowY;
          if (overflowY === "auto" || overflowY === "scroll") {
            const canScrollUp = deltaY < 0 && current.scrollTop > 0;
            const canScrollDown =
              deltaY > 0 && current.scrollTop + current.clientHeight < current.scrollHeight;
            if (canScrollUp || canScrollDown) {
              return true;
            }
          }
        }
      } catch {}
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Procesa un evento wheel aplicando el multiplicador de velocidad si corresponde.
 * Devuelve true si el evento fue interceptado y aplicado; false si se mantuvo el comportamiento nativo.
 */
export function applyScrollSpeedWheel(
  e: WheelEvent,
  target: HTMLElement | Window,
  speed: number,
  state?: ScrollSpeedState
): boolean {
  // 1. Con 1.0x se mantiene exactamente el comportamiento nativo actual
  if (Math.abs(speed - DEFAULT_SCROLL_SPEED) < 0.001) {
    return false;
  }

  // 2. No interceptar eventos con Ctrl (zoom de página / pinch-to-zoom)
  if (e.ctrlKey) {
    return false;
  }

  // 3. Evitar aplicar el multiplicador dos veces o si ya fue prevenido
  const lyraEvent = e as LyraWheelEvent;
  if (e.defaultPrevented || lyraEvent[HANDLED_WHEEL_SYMBOL]) {
    return false;
  }

  // 4. No bloquear desplazamiento puramente horizontal ni deltas nulos
  if (e.deltaY === 0) {
    return false;
  }
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    return false;
  }

  const isWindow =
    (typeof window !== "undefined" && (target === window || !target)) ||
    (typeof target === "object" &&
      target !== null &&
      "scrollTo" in target &&
      !("scrollTop" in target));
  const currentScrollTop = isWindow
    ? window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0
    : (target as HTMLElement).scrollTop;
  const scrollHeight = isWindow
    ? Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0
      )
    : (target as HTMLElement).scrollHeight;
  const clientHeight = isWindow
    ? window.innerHeight || document.documentElement?.clientHeight || 0
    : (target as HTMLElement).clientHeight;

  // 5. No interferir con scrolls anidados que puedan desplazarse en esta dirección
  if (isTargetInScrollableChild(e.target, target, e.deltaY)) {
    return false;
  }

  // 6. Respetar los límites superior e inferior del contenedor
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  if (maxScroll <= 0) {
    return false;
  }
  if (e.deltaY < 0 && currentScrollTop <= 0) {
    return false;
  }
  if (e.deltaY > 0 && currentScrollTop >= maxScroll) {
    return false;
  }

  // 7. Usar preventDefault() únicamente cuando el evento sea cancelable
  if (typeof e.cancelable === "boolean" && !e.cancelable) {
    return false;
  }
  e.preventDefault();
  lyraEvent[HANDLED_WHEEL_SYMBOL] = true;

  // 8. Normalizar deltaMode
  const normalizedDelta = normalizeWheelDeltaY(e.deltaY, e.deltaMode, clientHeight);
  const scaledDelta = normalizedDelta * speed;

  // 9. Acumulador de subpíxeles para touchpad y ratones de alta resolución
  const currentRemainder = state ? state.remainder : 0;
  const exactTarget = currentScrollTop + currentRemainder + scaledDelta;
  const clampedTarget = Math.max(0, Math.min(maxScroll, exactTarget));
  const roundedTarget = Math.round(clampedTarget);

  if (state) {
    state.remainder = clampedTarget - roundedTarget;
  }

  if (isWindow) {
    window.scrollTo({ top: roundedTarget, left: 0, behavior: "instant" });
    if (document.documentElement && document.documentElement.scrollTop !== roundedTarget) {
      document.documentElement.scrollTop = roundedTarget;
    }
  } else {
    (target as HTMLElement).scrollTop = roundedTarget;
  }
  return true;
}
