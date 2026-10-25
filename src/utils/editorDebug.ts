import { writeTextFile } from "@tauri-apps/plugin-fs";
import { BASE_DIRECTORY, MAIN_FOLDER } from "./consts";

export interface LogEntry {
  timestamp: number;
  timeStr: string;
  category: "EVENT" | "STATE" | "RENDER" | "TRANSITION";
  name: string;
  details?: Record<string, unknown>;
}

class EditorDebugger {
  private logs: LogEntry[] = [];
  private readonly maxLogs: number = 300;
  private listeners: Array<() => void> = [];

  constructor() {
    if (typeof window !== "undefined") {
      (window as any).__lyraDebug = {
        getLogs: () => this.getFormattedLogs(),
        saveToFile: () => this.saveToFile(),
        clear: () => this.clear(),
        entries: this.logs,
      };
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public log(
    category: LogEntry["category"],
    name: string,
    details?: Record<string, unknown>
  ): void {
    if (!import.meta.env.DEV && this.listeners.length === 0) {
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

    if (import.meta.env.DEV) {
      const color =
        category === "TRANSITION"
          ? "#f59e0b"
          : category === "RENDER"
          ? "#8b5cf6"
          : category === "STATE"
          ? "#10b981"
          : "#00a8ff";
      console.log(
        `%c[${category}] ${name} @ ${timeStr} (+${entry.timestamp}ms)`,
        `color: ${color}; font-weight: bold`,
        details ?? ""
      );
    }

    this.notify();
  }

  public getRecentLogs(count: number = 8): LogEntry[] {
    return this.logs.slice(-count);
  }

  public getFormattedLogs(): string {
    const header = `=== LYRA EDITOR DEBUG LOG ===\nDate: ${new Date().toISOString()}\nTotal events: ${this.logs.length}\n\n`;
    const lines = this.logs.map(l => {
      const detailsStr = l.details ? JSON.stringify(l.details) : "";
      return `[${l.timeStr}] [${l.category}] ${l.name} ${detailsStr}`;
    });
    return header + lines.join("\n");
  }

  public async saveToFile(): Promise<string> {
    const logContent = this.getFormattedLogs();
    const fileName = `${MAIN_FOLDER}/editor_debug.log`;
    try {
      await writeTextFile(fileName, logContent, BASE_DIRECTORY);
      console.log(`[Lyra Debug] Log successfully written to ${fileName}`);
      return `Guardado con éxito en ~/Documents/${fileName}`;
    } catch (err) {
      console.error("[Lyra Debug] Failed to write log file:", err);
      // Fallback: download as text file in browser context
      try {
        const blob = new Blob([logContent], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "editor_debug.log";
        a.click();
        URL.revokeObjectURL(url);
        return "Descargado editor_debug.log";
      } catch (e) {
        return `Error al guardar: ${String(err)}`;
      }
    }
  }

  public clear(): void {
    this.logs = [];
    this.notify();
  }
}

export const editorDebug = new EditorDebugger();
