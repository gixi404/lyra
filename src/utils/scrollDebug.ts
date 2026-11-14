import { invoke } from "@tauri-apps/api/core";

type DebugPayload = Record<string, unknown>;

const ENABLED = true;
let cleared = false;

function ts(): string {
  try {
    return `${Date.now()} ${performance.now().toFixed(3)}ms`;
  } catch {
    return String(Date.now());
  }
}

async function append(line: string): Promise<void> {
  if (!ENABLED) return;
  try {
    if (!cleared) {
      cleared = true;
      await invoke("scroll_debug_clear").catch(() => {});
    }
    await invoke("scroll_debug_append", { line }).catch(() => {});
  } catch {
    // diagnóstico best-effort
  }
}

export function scrollDebug(event: string, payload: DebugPayload = {}): void {
  if (!ENABLED || typeof window === "undefined") return;
  const entry = { t: ts(), event, ...payload };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = `${String(entry.t)} ${event}`;
  }
  try {
    console.log("[LYRA_SCROLL_DEBUG]", line);
  } catch {}
  void append(line);
}

export function snapshotScrollState(origin: string, extra: DebugPayload = {}): void {
  if (typeof document === "undefined") return;
  try {
    const container = document.getElementById("lyra-list-scroll-container") as HTMLElement | null;
    const html = document.documentElement;
    const body = document.body;
    const containerInfo = container
      ? {
          exists: true,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
          scrollable: container.scrollHeight - container.clientHeight > 2,
        }
      : { exists: false };
    let storedActive: string | null = null;
    let storedPaper: string | null = null;
    try {
      storedActive = window.sessionStorage.getItem("lyra_list_scroll_active") ?? window.sessionStorage.getItem("lyra_list_scroll");
      storedPaper = window.sessionStorage.getItem("lyra_list_scroll_paper");
    } catch {}
    let htmlOverflow: string | null = null;
    try {
      if (html && typeof getComputedStyle === "function") htmlOverflow = getComputedStyle(html).overflowY;
    } catch {}
    scrollDebug("snapshot", {
      origin,
      path: typeof window !== "undefined" ? window.location?.pathname : null,
      inEditor: !!html?.classList?.contains?.("in-editor"),
      htmlOverflow,
      windowScrollY: typeof window !== "undefined" ? window.scrollY : null,
      htmlScrollTop: html?.scrollTop ?? null,
      htmlScrollHeight: html?.scrollHeight ?? null,
      htmlClientHeight: html?.clientHeight ?? null,
      bodyScrollTop: body?.scrollTop ?? null,
      bodyScrollHeight: body?.scrollHeight ?? null,
      bodyClientHeight: body?.clientHeight ?? null,
      innerHeight: typeof window !== "undefined" ? window.innerHeight : null,
      container: containerInfo,
      storedActive,
      storedPaper,
      ...extra,
    });
  } catch {
    // diagnóstico best-effort: no debe romper flujo ni tests
  }
}
