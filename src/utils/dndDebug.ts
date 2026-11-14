import { writeTextFile } from "@tauri-apps/plugin-fs";
import { BASE_DIRECTORY, MAIN_FOLDER } from "./consts.ts";

type DndDiagDetails = Record<string, unknown>;

interface DndDiagEntry {
  t: string;
  ms: number;
  name: string;
  details?: DndDiagDetails;
}

const LOG_PATH = `${MAIN_FOLDER}/dnd-debug.log`;
const MAX_ENTRIES = 4000;
const MOVE_THROTTLE_MS = 50;

class DndDiagLogger {
  private entries: DndDiagEntry[] = [];
  private startedAt = 0;
  private lastMoveAt = 0;
  private lastMoveSig = "";
  private flushTimer: number | null = null;
  private flushing = false;
  private dirty = false;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.entries = [];
    this.startedAt = Date.now();
    this.lastMoveAt = 0;
    this.lastMoveSig = "";
    this.log("diag-init", { cleared: true, path: `~/Documents/${LOG_PATH}` });
    await this.flush(true);
  }

  log(name: string, details?: DndDiagDetails): void {
    const now = new Date();
    const ms = typeof performance !== "undefined" ? Math.round(performance.now()) : 0;
    this.entries.push({ t: now.toISOString(), ms, name, details });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.dirty = true;
    if (name.startsWith("drag-") || name.includes("cancel") || name.includes("cleanup") || name.includes("drop") || name.includes("pointerup") || name === "diag-init") {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  logMove(details: DndDiagDetails): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const target = details.target as { type?: string; containerKey?: string; folderPath?: string; index?: number } | null | undefined;
    const sig = JSON.stringify({
      x: details.px,
      y: details.py,
      tx: target?.type ?? null,
      tc: target?.containerKey ?? target?.folderPath ?? null,
      ti: target?.index ?? null,
    });
    if (now - this.lastMoveAt < MOVE_THROTTLE_MS && sig === this.lastMoveSig) return;
    this.lastMoveAt = now;
    this.lastMoveSig = sig;
    this.log("pointermove", details);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    if (typeof window === "undefined") return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 250);
  }

  private format(): string {
    const header = `=== LYRA DND DEBUG LOG ===\nstartedAt=${new Date(this.startedAt).toISOString()}\npath=~/Documents/${LOG_PATH}\nentries=${this.entries.length}\n\n`;
    return header + this.entries.map(e => `[${e.t} +${e.ms}ms] ${e.name} ${e.details ? JSON.stringify(e.details) : ""}`).join("\n");
  }

  async flush(immediate = false): Promise<void> {
    if (!immediate && !this.dirty) return;
    if (this.flushing) return;
    this.flushing = true;
    try {
      const content = this.format();
      await writeTextFile(LOG_PATH, content, BASE_DIRECTORY);
      this.dirty = false;
    } catch {
      // ignore (non-tauri / fs unavailable)
    } finally {
      this.flushing = false;
    }
  }
}

export const dndDebug = new DndDiagLogger();
