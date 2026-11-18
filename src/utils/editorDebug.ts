import { writeTextFile } from "@tauri-apps/plugin-fs";
import { BASE_DIRECTORY, MAIN_FOLDER } from "./consts.ts";
import { logger } from "./logger.ts";

export interface LogEntry {
  timestamp: number;
  timeStr: string;
  category: "EVENT" | "STATE" | "RENDER" | "TRANSITION";
  name: string;
  details?: Record<string, unknown>;
}

const DEV_DIAGNOSTICS_ENABLED =
  typeof import.meta !== "undefined" &&
  Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

class EditorDebugger {
  private logs: LogEntry[] = [];
  private readonly maxLogs: number = 300;
  private listeners: Array<() => void> = [];

  constructor() {
    // Sin exposición global ni recopilación implícita en producción.
  }

  public subscribe(listener: () => void): () => void {
    if (!DEV_DIAGNOSTICS_ENABLED) {
      return () => {};
    }
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(): void {
    if (!DEV_DIAGNOSTICS_ENABLED) return;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public log(
    category: LogEntry["category"],
    name: string,
    details?: Record<string, unknown>
  ): void {
    if (!DEV_DIAGNOSTICS_ENABLED) {
      return;
    }

    const now = performance.now();
    const date = new Date();
    const timeStr = `${date.toTimeString().split(" ")[0]}.${date.getMilliseconds().toString().padStart(3, "0")}`;

    const entry: LogEntry = {
      timestamp: Math.round(now),
      timeStr,
      category,
      name,
      details,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    const color =
      category === "TRANSITION"
        ? "#f59e0b"
        : category === "RENDER"
        ? "#8b5cf6"
        : category === "STATE"
        ? "#10b981"
        : "#00a8ff";
    logger.log(
      `%c[${category}] ${name} @ ${timeStr} (+${entry.timestamp}ms)`,
      `color: ${color}; font-weight: bold`,
      details ?? ""
    );

    this.notify();
  }

  public getRecentLogs(count: number = 8): LogEntry[] {
    if (!DEV_DIAGNOSTICS_ENABLED) return [];
    return this.logs.slice(-count);
  }

  public getFormattedLogs(): string {
    if (!DEV_DIAGNOSTICS_ENABLED) return "";
    const header = `=== LYRA EDITOR DEBUG LOG ===\nDate: ${new Date().toISOString()}\nTotal events: ${this.logs.length}\n\n`;
    const lines = this.logs.map(l => {
      const detailsStr = l.details ? JSON.stringify(l.details) : "";
      return `[${l.timeStr}] [${l.category}] ${l.name} ${detailsStr}`;
    });
    return header + lines.join("\n");
  }

  public async saveToFile(): Promise<string> {
    if (!DEV_DIAGNOSTICS_ENABLED) {
      return "Diagnóstico deshabilitado";
    }
    const logContent = this.getFormattedLogs();
    const fileName = `${MAIN_FOLDER}/editor_debug.log`;
    try {
      await writeTextFile(fileName, logContent, BASE_DIRECTORY);
      logger.log(`[Lyra Debug] Log successfully written to ${fileName}`);
      return `Guardado con éxito en ~/Documents/${fileName}`;
    } catch (err) {
      logger.error("[Lyra Debug] Failed to write log file:", err);
      return `Error al guardar: ${String(err)}`;
    }
  }

  public clear(): void {
    if (!DEV_DIAGNOSTICS_ENABLED) return;
    this.logs = [];
    this.notify();
  }
}

export const editorDebug = new EditorDebugger();
