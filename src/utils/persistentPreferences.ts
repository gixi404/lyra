import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { BASE_DIRECTORY, MAIN_FOLDER } from "./consts.ts";
import { configStore } from "../store/configStore.ts";
import { logger } from "./logger.ts";

const PREFERENCES_FILE_NAME = ".preferences.json";

export async function ensurePreferencesDirectory(): Promise<void> {
  try {
    const mainFolderExists = await exists(MAIN_FOLDER, BASE_DIRECTORY);
    if (!mainFolderExists) {
      await mkdir(MAIN_FOLDER, { ...BASE_DIRECTORY, recursive: true });
    }
  } catch (err: unknown) {
    const msg = String(err);
    if (
      !msg.includes("os error 17") &&
      !msg.includes("ya existe") &&
      !msg.includes("AlreadyExists")
    ) {
      logger.warn("ensurePreferencesDirectory warning:", err);
    }
  }
}

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
  "lyra_theme_migrated_v2",
  "welcome_dismissed",
  "welcome_manually_restored",
  "scroll-speed",
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
  lyra_theme_migrated_v2?: string | boolean;
  welcome_dismissed?: string | boolean;
  welcome_manually_restored?: string | boolean;
  "scroll-speed"?: string | number;
  initialized?: boolean;
  updatedAt?: number;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function getPreferencesFilePath(): Promise<string> {
  return join(MAIN_FOLDER, PREFERENCES_FILE_NAME);
}

let initPreferencesPromise: Promise<void> | null = null;

export async function initPersistentPreferences(): Promise<void> {
  if (initPreferencesPromise) {
    return initPreferencesPromise;
  }
  initPreferencesPromise = initPersistentPreferencesInternal().finally(() => {
    initPreferencesPromise = null;
  });
  return initPreferencesPromise;
}

async function initPersistentPreferencesInternal(): Promise<void> {
  try {
    await ensurePreferencesDirectory();
    const filePath = await getPreferencesFilePath();
    const hasFile = await exists(filePath, BASE_DIRECTORY);

    if (hasFile) {
      const content = await readTextFile(filePath, BASE_DIRECTORY);
      if (content.trim()) {
        const fileData = JSON.parse(content) as PreferencesData;
        let needsSave = false;

        // 1. Sincronizar 'paper' (Archivados)
        const localPaperRaw = window.localStorage.getItem("paper");
        let localPaper: string[] | null = null;
        if (localPaperRaw !== null) {
          try {
            const parsed = JSON.parse(localPaperRaw);
            if (Array.isArray(parsed)) localPaper = parsed;
          } catch {}
        }

        const filePaper = Array.isArray(fileData.paper) ? fileData.paper : null;

        // Al iniciar la aplicación, .preferences.json en disco es la fuente autoritativa
        // persistente en ~/Documents/lyra/.preferences.json (incluyendo backups externos).
        if (filePaper !== null) {
          window.localStorage.setItem("paper", JSON.stringify(filePaper));
        } else if (localPaper !== null) {
          fileData.paper = localPaper;
          needsSave = true;
        } else {
          window.localStorage.setItem("paper", JSON.stringify([]));
          fileData.paper = [];
          needsSave = true;
        }

        // 2. Sincronizar el resto de preferencias
        const isThemeMigrated =
          fileData.lyra_theme_migrated_v2 === true ||
          fileData.lyra_theme_migrated_v2 === "true" ||
          window.localStorage.getItem("lyra_theme_migrated_v2") === "true";

        if (!isThemeMigrated) {
          fileData.theme = "auto";
          fileData.lyra_theme_migrated_v2 = true;
          window.localStorage.setItem("theme", "auto");
          window.localStorage.setItem("lyra_theme_migrated_v2", "true");
          needsSave = true;
        }

        for (const key of PERSISTENT_KEYS) {
          if (key === "paper") continue;
          const fileVal = fileData[key];
          const localVal = window.localStorage.getItem(key);

          if (fileVal !== undefined && fileVal !== null) {
            window.localStorage.setItem(key, String(fileVal));
          } else if (localVal !== null && fileVal === undefined) {
            (fileData as Record<string, unknown>)[key] = localVal;
            needsSave = true;
          }
        }

        if (fileData.initialized || fileData.lyra_initialized) {
          window.localStorage.setItem("lyra_initialized", "true");
        }

        const effectiveTimestamp = Number(fileData.updatedAt || Date.now());
        window.localStorage.setItem("lyra_preferences_updated_at", String(effectiveTimestamp));

        if (needsSave) {
          const now = Date.now();
          fileData.updatedAt = now;
          window.localStorage.setItem("lyra_preferences_updated_at", String(now));
          await writeTextFile(filePath, JSON.stringify(fileData, null, 2), BASE_DIRECTORY);
        }

        configStore.getState().bumpPrefTick();
        configStore.getState().toggleThemeTick();
      }
    } else {
      // Si no existe el archivo .preferences.json en disco, es un inicio limpio o la carpeta se reseteó.
      // Purgamos residuos huérfanos de archivados o estado de bienvenida previo.
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("welcome_dismissed");
        window.localStorage.removeItem("welcome_manually_restored");
        window.localStorage.setItem("paper", JSON.stringify([]));
        configStore.getState().bumpPrefTick();
      }
      await savePersistentPreferencesNow();
    }
  } catch (err) {
    logger.error("Error al inicializar preferencias persistentes:", err);
  }
}

interface QueuedSave {
  resolve: () => void;
  reject: (err: unknown) => void;
}

let isWriting = false;
let pendingQueue: QueuedSave[] = [];

export function savePersistentPreferencesNow(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  return new Promise<void>((resolve, reject) => {
    pendingQueue.push({ resolve, reject });
    void processSaveQueue();
  });
}

async function processSaveQueue(): Promise<void> {
  if (isWriting) return;
  if (pendingQueue.length === 0) return;

  isWriting = true;
  const currentBatch = [...pendingQueue];
  pendingQueue = [];

  try {
    await ensurePreferencesDirectory();
    const filePath = await getPreferencesFilePath();
    const now = Date.now();
    const data: PreferencesData = {
      updatedAt: now,
      initialized: true,
    };

    // El snapshot se captura en el momento exacto de escribir
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
    window.localStorage.setItem("lyra_preferences_updated_at", String(now));

    for (const req of currentBatch) {
      req.resolve();
    }
  } catch (err) {
    logger.error("Error al guardar preferencias persistentes en disco:", err);
    for (const req of currentBatch) {
      req.reject(err);
    }
  } finally {
    isWriting = false;
    if (pendingQueue.length > 0) {
      void processSaveQueue();
    }
  }
}

export async function flushPersistentPreferences(): Promise<void> {
  return savePersistentPreferencesNow();
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
