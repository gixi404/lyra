import { configStore } from "../store/configStore.ts";
import { scrollDebug, snapshotScrollState } from "./scrollDebug.ts";

/**
 * Scroll de la pantalla principal (lista de notas / archivados).
 *
 * Responsabilidad:
 * - Fuente de verdad única: posiciones por vista ("active" | "paper") en memoria y sessionStorage.
 * - El scroll real del listado ocurre en window/document (html con overflow-y: scroll), salvo que
 *   el contenedor #lyra-list-scroll-container sea scrollable por sí mismo.
 * - La captura se realiza durante el desplazamiento del usuario y antes de abandonar la lista;
 *   la restauración la orquesta el componente List al volver a montarse.
 *
 * Garantías a conservar:
 * - No sobrescribir la posición guardada con 0 en montajes/desmontajes/inicializaciones no intencionales.
 * - No interferir con el scroll interno del editor (gestionado por separado en este módulo/editor).
 * - Si el contenido es más corto al volver, aplicar la posición válida más cercana sin bucles indefinidos.
 * - Las actualizaciones periódicas del listado no deben reiniciar el scroll del usuario.
 */
if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
  try {
    window.history.scrollRestoration = "manual";
  } catch {}
}

export type ListViewMode = "active" | "paper";

const listScrollPositions: Record<ListViewMode, number> = {
  active: 0,
  paper: 0,
};

function clampScroll(y: number): number {
  if (!Number.isFinite(y)) return 0;
  return Math.max(0, Math.round(y));
}

function isInEditor(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  if (!root || typeof (root as unknown as { classList?: { contains?: unknown } }).classList?.contains !== "function") {
    return false;
  }
  try {
    return root.classList.contains("in-editor");
  } catch {
    return false;
  }
}

// Initialize from sessionStorage if available
if (typeof window !== "undefined" && window.sessionStorage) {
  try {
    const storedActive = window.sessionStorage.getItem("lyra_list_scroll_active") ??
      window.sessionStorage.getItem("lyra_list_scroll");
    if (storedActive !== null) {
      const parsed = Number(storedActive);
      if (!Number.isNaN(parsed)) {
        listScrollPositions.active = clampScroll(parsed);
      }
    }
    const storedPaper = window.sessionStorage.getItem("lyra_list_scroll_paper");
    if (storedPaper !== null) {
      const parsed = Number(storedPaper);
      if (!Number.isNaN(parsed)) {
        listScrollPositions.paper = clampScroll(parsed);
      }
    }
  } catch {}
}

export function getEffectiveView(view?: ListViewMode): ListViewMode {
  if (view) return view;
  try {
    return configStore.getState().paperIsOpen ? "paper" : "active";
  } catch {
    return "active";
  }
}

export function getListScroll(view?: ListViewMode): number {
  const mode = getEffectiveView(view);
  let result = listScrollPositions[mode];
  try {
    const key = `lyra_list_scroll_${mode}`;
    const stored = window.sessionStorage.getItem(key) ??
      (mode === "active" ? window.sessionStorage.getItem("lyra_list_scroll") : null);
    if (stored !== null) {
      const parsed = Number(stored);
      if (!Number.isNaN(parsed)) {
        const normalized = clampScroll(parsed);
        listScrollPositions[mode] = normalized;
        result = normalized;
      }
    }
  } catch {}
  scrollDebug("getListScroll", { view: mode, result });
  return result;
}

export function setListScroll(y: number, view?: ListViewMode): void {
  const mode = getEffectiveView(view);
  const normalized = clampScroll(y);
  const prev = listScrollPositions[mode];
  const inEditor = isInEditor();
  // Nunca degradar la posición guardada con lecturas DOM transitorias (p. ej. html overflow:hidden al entrar al editor).
  if (inEditor && normalized === 0 && prev > 0) {
    scrollDebug("setListScroll.skip", { view: mode, requested: y, normalized, prev, inEditor, reason: "in-editor-zero-guard" });
    return;
  }
  listScrollPositions[mode] = normalized;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(`lyra_list_scroll_${mode}`, String(normalized));
      if (mode === "active") {
        window.sessionStorage.setItem("lyra_list_scroll", String(normalized));
      }
    }
  } catch {}
  scrollDebug("setListScroll.write", { view: mode, requested: y, normalized, prev, inEditor });
  snapshotScrollState("after-setListScroll", { view: mode, normalized });
}

/** Captura la posición actual del DOM solo si el listado está visible (fuera del editor). */
export function captureListScroll(view?: ListViewMode): number {
  const mode = getEffectiveView(view);
  if (isInEditor()) {
    const stored = getListScroll(mode);
    scrollDebug("captureListScroll.skip", { view: mode, reason: "in-editor", stored });
    return stored;
  }
  const pos = getScrollPos(mode);
  scrollDebug("captureListScroll", { view: mode, pos });
  setListScroll(pos, mode);
  return pos;
}

export function resetListScroll(view?: ListViewMode): void {
  const mode = getEffectiveView(view);
  listScrollPositions[mode] = 0;
  try {
    window.sessionStorage.removeItem(`lyra_list_scroll_${mode}`);
    if (mode === "active") {
      window.sessionStorage.removeItem("lyra_list_scroll");
    }
  } catch {}
}

export function resetAllListScroll(): void {
  resetListScroll("active");
  resetListScroll("paper");
}

export function getListContainer(): HTMLElement | null {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return null;
  return document.getElementById("lyra-list-scroll-container");
}

function isInListScrollMode(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const root = document.documentElement as unknown as { classList?: { contains?: (n: string) => boolean } };
    return !!root?.classList?.contains?.("in-list-scroll");
  } catch {
    return false;
  }
}

// Contenedor de scroll del listado: dedicado (modo lista) o, por compatibilidad,
// un contenedor con overflow/altura scrollable.
function isDedicatedListScroller(el: HTMLElement): boolean {
  if (isInListScrollMode()) return true;
  try {
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") return true;
    }
  } catch {}
  try {
    return (el.scrollHeight - el.clientHeight) > 2;
  } catch {
    return false;
  }
}

function getWindowScrollTop(): number {
  if (typeof window === "undefined") return 0;
  const fromWindow = typeof window.scrollY === "number" ? window.scrollY : 0;
  if (fromWindow) return fromWindow;
  if (typeof document === "undefined") return 0;
  return document.documentElement?.scrollTop || document.body?.scrollTop || 0;
}

function getWindowMaxScroll(): number {
  if (typeof document === "undefined" || typeof window === "undefined") return 0;
  const docEl = document.documentElement;
  const body = document.body;
  const scrollHeight = Math.max(docEl?.scrollHeight || 0, body?.scrollHeight || 0);
  const clientHeight = window.innerHeight || docEl?.clientHeight || body?.clientHeight || 0;
  return Math.max(0, scrollHeight - clientHeight);
}

function setWindowScrollTop(y: number): number {
  const max = getWindowMaxScroll();
  const clamped = Math.max(0, Math.min(Math.round(y), max));
  if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
    try { window.scrollTo({ top: clamped, left: 0, behavior: "instant" as ScrollBehavior }); } catch { window.scrollTo(0, clamped); }
  }
  try {
    if (typeof document !== "undefined" && document.documentElement && document.documentElement.scrollTop !== clamped) {
      document.documentElement.scrollTop = clamped;
    }
  } catch {}
  return clamped;
}

export function getScrollPos(view?: ListViewMode): number {
  const container = getListContainer();
  if (container && isDedicatedListScroller(container)) {
    return container.scrollTop || 0;
  }
  if (container || typeof window !== "undefined") {
    return getWindowScrollTop();
  }
  const mode = getEffectiveView(view);
  return listScrollPositions[mode] ?? 0;
}

export function getMaxScroll(): number {
  const container = getListContainer();
  if (container && isDedicatedListScroller(container)) {
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }
  return getWindowMaxScroll();
}

export function applyListScroll(y: number): number {
  const container = getListContainer();
  if (container && isDedicatedListScroller(container)) {
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped = Math.max(0, Math.min(Math.round(y), max));
    container.scrollTop = clamped;
    scrollDebug("applyListScroll", { requested: y, result: clamped, target: "container", max });
    snapshotScrollState("after-applyListScroll", { requested: y, result: clamped, target: "container" });
    return clamped;
  }
  if (typeof window !== "undefined" && (container || typeof document !== "undefined")) {
    const result = setWindowScrollTop(y);
    scrollDebug("applyListScroll", { requested: y, result, target: "window", max: getMaxScroll() });
    snapshotScrollState("after-applyListScroll", { requested: y, result, target: "window" });
    return result;
  }
  const result = Math.max(0, Math.round(y));
  scrollDebug("applyListScroll", { requested: y, result, target: "none", max: 0 });
  snapshotScrollState("after-applyListScroll", { requested: y, result, target: "none" });
  return result;
}

// In-memory per-note editor reading position
const editorScrollPositions = new Map<string, number>();

export function getEditorScroll(fileName: string): number {
  if (!fileName) return 0;
  return editorScrollPositions.get(fileName) ?? 0;
}

export function setEditorScroll(fileName: string, y: number): void {
  if (!fileName) return;
  const normalized = Math.max(0, Math.round(y));
  editorScrollPositions.set(fileName, normalized);
}

export function clearEditorScroll(fileName?: string): void {
  if (fileName) {
    editorScrollPositions.delete(fileName);
  } else {
    editorScrollPositions.clear();
  }
}
