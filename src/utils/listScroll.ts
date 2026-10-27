if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
  try {
    window.history.scrollRestoration = "manual";
  } catch {}
}

let listScrollY = 0;

export function getListScroll(): number {
  try {
    const stored = window.sessionStorage.getItem("lyra_list_scroll");
    if (stored !== null) {
      const parsed = Number(stored);
      if (!Number.isNaN(parsed)) return parsed;
    }
  } catch {}
  return listScrollY;
}

export function setListScroll(y: number): void {
  const normalized = Math.max(0, Math.round(y));
  listScrollY = normalized;
  try {
    window.sessionStorage.setItem("lyra_list_scroll", String(normalized));
  } catch {}
}

export function resetListScroll(): void {
  listScrollY = 0;
  try {
    window.sessionStorage.removeItem("lyra_list_scroll");
  } catch {}
}
