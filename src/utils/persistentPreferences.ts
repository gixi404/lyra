import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { BASE_DIRECTORY, MAIN_FOLDER } from "./consts";
import { configStore } from "../store/configStore";

const PREFERENCES_FILE_NAME = ".preferences.json";

export const PERSISTENT_KEYS = [
  "theme",
  "font",
  "font-size",
  "align-text",
  "spacing",
  "word-count",
  "last-modified",
  "paragraph-focus",
  "sortOption",
  "paper",
  "language",
  "lyra_initialized",
] as const;

export type PersistentKey = (typeof PERSISTENT_KEYS)[number];

export interface PreferencesData {
  theme?: string;
  font?: string;
  "font-size"?: string;
  "align-text"?: string;
  spacing?: string | number;
  "word-count"?: string | boolean;
  "last-modified"?: string | boolean;
  "paragraph-focus"?: string | boolean;
  sortOption?: string;
  paper?: string[];
  language?: string;
  lyra_initialized?: string | boolean;
  initialized?: boolean;
  updatedAt?: number;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function getPreferencesFilePath(): Promise<string> {
  return join(MAIN_FOLDER, PREFERENCES_FILE_NAME);
}

export async function initPersistentPreferences(): Promise<void> {
  try {
    const filePath = await getPreferencesFilePath();
    const hasFile = await exists(filePath, BASE_DIRECTORY);

    if (hasFile) {
      const content = await readTextFile(filePath, BASE_DIRECTORY);
      if (content.trim()) {
        const fileData = JSON.parse(content) as PreferencesData;
        let needsSave = false;

        // 1. Sincronizar 'paper' (Archivados)
        const localPaperRaw = window.localStorage.getItem("paper");
        let localPaper: string[] = [];
        try {
          if (localPaperRaw) {
            const parsed = JSON.parse(localPaperRaw);
            if (Array.isArray(parsed)) localPaper = parsed;
          }
        } catch {}

        const filePaper = Array.isArray(fileData.paper) ? fileData.paper : [];

        // Si local está vacío pero el archivo en disco tiene archivados, restaurar en local
        if (localPaper.length === 0 && filePaper.length > 0) {
          window.localStorage.setItem("paper", JSON.stringify(filePaper));
        } else if (localPaper.length > 0 && filePaper.length === 0) {
          fileData.paper = localPaper;
          needsSave = true;
        } else if (localPaper.length > 0 && filePaper.length > 0) {
          const merged = Array.from(new Set([...localPaper, ...filePaper]));
          window.localStorage.setItem("paper", JSON.stringify(merged));
          if (merged.length !== filePaper.length) {
            fileData.paper = merged;
            needsSave = true;
          }
        }

        // 2. Sincronizar el resto de preferencias
        for (const key of PERSISTENT_KEYS) {
          if (key === "paper") continue;
          const fileVal = fileData[key];
          const localVal = window.localStorage.getItem(key);

          if (localVal === null && fileVal !== undefined && fileVal !== null) {
            window.localStorage.setItem(key, String(fileVal));
          } else if (localVal !== null && fileVal === undefined) {
            (fileData as Record<string, unknown>)[key] = localVal;
            needsSave = true;
          }
        }

        if (fileData.initialized || fileData.lyra_initialized) {
          window.localStorage.setItem("lyra_initialized", "true");
        }

        if (needsSave) {
          fileData.updatedAt = Date.now();
          await writeTextFile(filePath, JSON.stringify(fileData, null, 2), BASE_DIRECTORY);
        }

        configStore.getState().bumpPrefTick();
        configStore.getState().toggleThemeTick();
      }
    } else {
      await savePersistentPreferencesNow();
    }
  } catch (err) {
    console.error("Error al inicializar preferencias persistentes:", err);
  }
}

export async function savePersistentPreferencesNow(): Promise<void> {
  try {
    const filePath = await getPreferencesFilePath();
    const data: PreferencesData = {
      updatedAt: Date.now(),
      initialized: true,
    };

    for (const key of PERSISTENT_KEYS) {
      const val = window.localStorage.getItem(key);
      if (val !== null) {
        if (key === "paper") {
          try {
            data.paper = JSON.parse(val);
          } catch {
            data.paper = [];
          }
        } else {
          (data as Record<string, unknown>)[key] = val;
        }
      }
    }

    await writeTextFile(filePath, JSON.stringify(data, null, 2), BASE_DIRECTORY);
  } catch (err) {
    console.error("Error al guardar preferencias persistentes en disco:", err);
  }
}

export function scheduleSavePersistentPreferences(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void savePersistentPreferencesNow();
  }, 150);
}
