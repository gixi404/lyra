import { configStore } from "../store/configStore.ts";

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

// Initialize from sessionStorage if available
if (typeof window !== "undefined" && window.sessionStorage) {
  try {
    const storedActive = window.sessionStorage.getItem("lyra_list_scroll_active") ??
      window.sessionStorage.getItem("lyra_list_scroll");
    if (storedActive !== null) {
      const parsed = Number(storedActive);
      if (!Number.isNaN(parsed)) {
        listScrollPositions.active = Math.max(0, Math.round(parsed));
      }
    }
    const storedPaper = window.sessionStorage.getItem("lyra_list_scroll_paper");
    if (storedPaper !== null) {
      const parsed = Number(storedPaper);
      if (!Number.isNaN(parsed)) {
        listScrollPositions.paper = Math.max(0, Math.round(parsed));
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
  try {
    const key = `lyra_list_scroll_${mode}`;
    const stored = window.sessionStorage.getItem(key) ??
      (mode === "active" ? window.sessionStorage.getItem("lyra_list_scroll") : null);
    if (stored !== null) {
      const parsed = Number(stored);
      if (!Number.isNaN(parsed)) {
        const normalized = Math.max(0, Math.round(parsed));
        listScrollPositions[mode] = normalized;
        return normalized;
      }
    }
  } catch {}
  return listScrollPositions[mode];
}

export function setListScroll(y: number, view?: ListViewMode): void {
  const mode = getEffectiveView(view);
  const normalized = Math.max(0, Math.round(y));
  listScrollPositions[mode] = normalized;
  try {
    window.sessionStorage.setItem(`lyra_list_scroll_${mode}`, String(normalized));
    if (mode === "active") {
      window.sessionStorage.setItem("lyra_list_scroll", String(normalized));
    }
  } catch {}
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

// El contenedor del listado (#lyra-list-scroll-container) no es un scroll
// independiente: el layout de MainContainer (html overflow-y: scroll) hace
// que desplace la ventana. Solo es un scroll propio si su contenido excede
// su altura visible.
function isListContainerScrollable(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight > 2;
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
    window.scrollTo({ top: clamped, left: 0, behavior: "instant" });
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
  if (container && isListContainerScrollable(container)) {
    return container.scrollTop;
  }
  if (container || typeof window !== "undefined") {
    // El desplazamiento real ocurre en la ventana; si ya hay contenedor pero
    // no es scrollable, su scrollTop es 0 y engañaría a los llamadores.
    return getWindowScrollTop();
  }
  const mode = getEffectiveView(view);
  return listScrollPositions[mode] ?? 0;
}

export function getMaxScroll(): number {
  const container = getListContainer();
  if (container && isListContainerScrollable(container)) {
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }
  return getWindowMaxScroll();
}

export function applyListScroll(y: number): number {
  const container = getListContainer();
  if (container && isListContainerScrollable(container)) {
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    const clamped = Math.max(0, Math.min(Math.round(y), max));
    container.scrollTop = clamped;
    return clamped;
  }
  if (typeof window !== "undefined" && (container || typeof document !== "undefined")) {
    return setWindowScrollTop(y);
  }
  return Math.max(0, Math.round(y));
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
