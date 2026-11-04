import { PAGES } from "./consts.ts";

export type NavigateHandler = (path: string) => void | Promise<unknown>;

let navigatorHandler: NavigateHandler | null = null;
let pendingNavigation: string | null = null;

function fallbackLocation(path: string): void {
  if (typeof window !== "undefined" && window.location && !pathIs(path)) {
    window.location.pathname = path;
  }
}

function executeHandlerSafely(handler: NavigateHandler, path: string, fallbackToLocation = false): void {
  try {
    const result = handler(path);
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch((err) => {
        console.warn(`Error asíncrono al ejecutar navegación a '${path}':`, err);
        if (fallbackToLocation) {
          fallbackLocation(path);
        }
      });
    }
  } catch (e) {
    console.warn(`Error sincrónico al ejecutar navegación a '${path}':`, e);
    if (fallbackToLocation) {
      fallbackLocation(path);
    }
  }
}

export function registerNavigator(handler: NavigateHandler): () => void {
  navigatorHandler = handler;
  if (pendingNavigation) {
    const target = pendingNavigation;
    pendingNavigation = null;
    executeHandlerSafely(handler, target, false);
  }
  return () => {
    if (navigatorHandler === handler) {
      navigatorHandler = null;
    }
  };
}

export function navigateTo(path: string): void {
  if (navigatorHandler) {
    executeHandlerSafely(navigatorHandler, path, true);
  } else {
    // Si el router aún no se ha registrado (arranque temprano), encolar para ejecutar al registrar
    pendingNavigation = path;
  }
}

export function getPendingNavigation(): string | null {
  return pendingNavigation;
}

export function pathIs(path: string): boolean {
  if (typeof window === "undefined" || !window.location) {
    return false;
  }
  const currentPath: string = window.location.pathname;
  if (path === "/" || path === PAGES.list) {
    return (
      currentPath === "/" ||
      currentPath === "/index.html" ||
      currentPath === "" ||
      currentPath.endsWith("/index.html")
    );
  }
  return currentPath === path || currentPath.endsWith(path);
}

export function scrollToNovedades(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  try {
    window.sessionStorage.removeItem("scroll_to_novedades");
  } catch {}

  const tryScroll = (attempts = 0) => {
    const el = document.getElementById("novedades-section");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (attempts < 25) {
      setTimeout(() => tryScroll(attempts + 1), 60);
    }
  };

  tryScroll();
}
