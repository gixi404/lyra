import { BASE_DIRECTORY, INTRO_ES, MAIN_FOLDER, WELCOME_ES } from "./consts.ts";
import {
  exists as tauriExists,
  mkdir as tauriMkdir,
  readDir as tauriReadDir,
  readTextFile as tauriReadTextFile,
  writeTextFile as tauriWriteTextFile,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { scheduleSavePersistentPreferences } from "./persistentPreferences.ts";
import { fileStore } from "../store/fileStore.ts";
import { setArchiveState } from "./archiveState.ts";
import { hasSupportedNoteExtension } from "./noteName.ts";
import { logger } from "./logger.ts";

export const WELCOME_FILE_NAME: string = WELCOME_ES;

async function archiveWelcome(name: string, currentPaper: string[], storageOps: WelcomeStorageOps): Promise<void> {
  if (storageOps === defaultStorageOps && typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    await setArchiveState(name, true);
    return;
  }
  storageOps.setItem("paper", JSON.stringify(Array.from(new Set([...currentPaper, name]))));
  if (typeof window !== "undefined") scheduleSavePersistentPreferences();
}

export const LEGACY_WELCOME_NAMES: readonly string[] = [
  "Bienvenido a Lyra.txt",
  "¡Bienvenido a lyra!.txt",
  "¡Bienvenido a Lyra!.txt",
  "Bienvenido a Lyra",
  "¡Bienvenido a lyra!",
  "¡Bienvenido a Lyra!",
  "¡Bienvenid@ a Lyra!",
];

export interface WelcomeFsEntry {
  name: string;
  isFile: boolean;
  isDirectory?: boolean;
}

export interface WelcomeFsOps {
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string, options?: Record<string, unknown>) => Promise<void>;
  readDir: (path: string) => Promise<WelcomeFsEntry[]>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string, options?: Record<string, unknown>) => Promise<void>;
}

export interface WelcomeStorageOps {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

async function resolveWelcomePath(base: string, file: string): Promise<string> {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    try {
      return await join(base, file);
    } catch {}
  }
  return `${base}/${file}`;
}

const defaultFsOps: WelcomeFsOps = {
  exists: async (path: string) => tauriExists(path, BASE_DIRECTORY),
  mkdir: async (path: string, options?: Record<string, unknown>) => tauriMkdir(path, { ...BASE_DIRECTORY, ...options }),
  readDir: async (path: string) => {
    const entries = await tauriReadDir(path, BASE_DIRECTORY);
    return entries.map(e => ({ name: e.name, isFile: e.isFile }));
  },
  readTextFile: async (path: string) => tauriReadTextFile(path, BASE_DIRECTORY),
  writeTextFile: async (path: string, content: string, options?: Record<string, unknown>) =>
    tauriWriteTextFile(path, content, { ...BASE_DIRECTORY, ...options }),
};

const defaultStorageOps: WelcomeStorageOps = {
  getItem: (key: string) => {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  },
  setItem: (key: string, value: string) => {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  },
  removeItem: (key: string) => {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.removeItem(key);
  },
};

export function isWelcomeFileName(fileName: string): boolean {
  if (!fileName) return false;
  const lower = fileName.trim().toLowerCase();
  return (
    lower === "¡bienvenid@ a lyra!.txt" ||
    lower === "bienvenido a lyra.txt" ||
    lower === "¡bienvenido a lyra!.txt" ||
    lower === "¡bienvenid@ a lyra!" ||
    lower === "bienvenido a lyra" ||
    lower === "¡bienvenido a lyra!"
  );
}

export function isDefaultWelcomeContent(content: string): boolean {
  if (!content) return false;
  return content.replace(/\r\n/g, "\n") === INTRO_ES;
}

async function isInternalWelcome(name: string, content: string, fsOps: WelcomeFsOps): Promise<boolean> {
  if (fsOps === defaultFsOps && typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    return invoke<boolean>("gdrive_is_internal_welcome", { fileName: name });
  }
  return isDefaultWelcomeContent(content);
}

export function isWelcomeDismissed(storageOps: WelcomeStorageOps = defaultStorageOps): boolean {
  const val = storageOps.getItem("welcome_dismissed");
  return val === "true" || val === "1";
}

export function setWelcomeDismissed(
  dismissed = true,
  storageOps: WelcomeStorageOps = defaultStorageOps
): void {
  storageOps.setItem("welcome_dismissed", String(dismissed));
  if (typeof window !== "undefined") {
    scheduleSavePersistentPreferences();
  }
}

export function isWelcomeManuallyRestored(
  storageOps: WelcomeStorageOps = defaultStorageOps
): boolean {
  const val = storageOps.getItem("welcome_manually_restored");
  return val === "true" || val === "1";
}

export function setWelcomeManuallyRestored(
  restored = true,
  storageOps: WelcomeStorageOps = defaultStorageOps
): void {
  if (restored) {
    storageOps.setItem("welcome_manually_restored", "true");
  } else {
    storageOps.removeItem("welcome_manually_restored");
  }
}

export function handleWelcomeFileDeleted(
  fileName: string,
  storageOps: WelcomeStorageOps = defaultStorageOps
): void {
  if (isWelcomeFileName(fileName)) {
    setWelcomeDismissed(true, storageOps);
    setWelcomeManuallyRestored(false, storageOps);
  }
}

export interface WelcomeStateResult {
  created: boolean;
  activeWelcome: string | null;
}

async function getSupportedFilesRecursively(
  fsOps: WelcomeFsOps,
  folder: string,
  relPrefix = ""
): Promise<string[]> {
  try {
    const entries = await fsOps.readDir(folder);
    const validFiles: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isFile && hasSupportedNoteExtension(entry.name)) {
        validFiles.push(relPath);
      } else if (!entry.isFile || entry.isDirectory) {
        try {
          const sub = await getSupportedFilesRecursively(fsOps, `${folder}/${entry.name}`, relPath);
          validFiles.push(...sub);
        } catch {
          // ignore unreadable subfolders
        }
      }
    }
    return validFiles;
  } catch {
    return [];
  }
}

export async function ensureWelcomeFileState(
  fsOps: WelcomeFsOps = defaultFsOps,
  storageOps: WelcomeStorageOps = defaultStorageOps
): Promise<WelcomeStateResult> {
  try {
    const folderExists = await fsOps.exists(MAIN_FOLDER);
    if (!folderExists) {
      storageOps.removeItem("welcome_dismissed");
      storageOps.removeItem("welcome_manually_restored");
      try {
        storageOps.setItem("paper", JSON.stringify([]));
      } catch {}
      try {
        await fsOps.mkdir(MAIN_FOLDER, { recursive: true });
      } catch (mkdirErr: unknown) {
        const msg = String(mkdirErr);
        if (
          !msg.includes("os error 17") &&
          !msg.includes("ya existe") &&
          !msg.includes("AlreadyExists")
        ) {
          throw mkdirErr;
        }
      }
    }

    const validFiles = await getSupportedFilesRecursively(fsOps, MAIN_FOLDER);

    const existingWelcome = validFiles.find(name => isWelcomeFileName(name));
    const realNotes = validFiles.filter(name => !isWelcomeFileName(name));

    let localPaper: string[] = [];
    try {
      const raw = storageOps.getItem("paper");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localPaper = parsed;
      }
    } catch {}

    const paperSet = new Set(localPaper);
    const isArchived = existingWelcome ? paperSet.has(existingWelcome) : false;

    // Si la carpeta local contiene notas reales, el archivo de bienvenida permanece visible
    // hasta que el usuario lo elimine o archive explícitamente. No se autoarchiva al crear notas.
    if (realNotes.length > 0) {
      return {
        created: false,
        activeWelcome: existingWelcome && !isArchived ? existingWelcome : null,
      };
    }

    // Si la carpeta local no contiene ninguna nota
    if (validFiles.length === 0) {
      // Si el usuario eliminó intencionalmente el archivo de bienvenida, evitar recreaciones infinitas
      if (isWelcomeDismissed(storageOps)) {
        return { created: false, activeWelcome: null };
      }

      // Crear el archivo de bienvenida
      const welcomePath = await resolveWelcomePath(MAIN_FOLDER, WELCOME_FILE_NAME);
      const created = fsOps === defaultFsOps && typeof window !== "undefined" && window.__TAURI_INTERNALS__
        ? await invoke<boolean>("create_internal_welcome", { content: INTRO_ES })
        : await fsOps.writeTextFile(welcomePath, INTRO_ES, { createNew: true }).then(() => true);

      // Asegurarse de que el nuevo archivo de bienvenida no esté en archivados
      if (localPaper.some(name => isWelcomeFileName(name))) {
        const cleanedPaper = localPaper.filter(name => !isWelcomeFileName(name));
        storageOps.setItem("paper", JSON.stringify(cleanedPaper));
        if (typeof window !== "undefined") {
          scheduleSavePersistentPreferences();
        }
      }

      try {
        fileStore.getState().updateListFiles(WELCOME_FILE_NAME);
      } catch {}

      return { created, activeWelcome: WELCOME_FILE_NAME };
    }

    // Si existe el archivo de bienvenida y no hay notas reales
    return {
      created: false,
      activeWelcome: existingWelcome && !isArchived ? existingWelcome : null,
    };
  } catch (err) {
    logger.error("Error en ensureWelcomeFileState:", err);
    return { created: false, activeWelcome: null };
  }
}

export async function autoArchiveWelcomeOnSync(
  downloadedFiles: string[],
  fsOps: WelcomeFsOps = defaultFsOps,
  storageOps: WelcomeStorageOps = defaultStorageOps
): Promise<boolean> {
  const hasRealNotes = (downloadedFiles || []).some(f => !isWelcomeFileName(f));
  if (!hasRealNotes) {
    return false;
  }

  try {
    const validFiles = await getSupportedFilesRecursively(fsOps, MAIN_FOLDER);

    const existingWelcome = validFiles.find(name => isWelcomeFileName(name));
    if (!existingWelcome) {
      return false;
    }

    let localPaper: string[] = [];
    try {
      const raw = storageOps.getItem("paper");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localPaper = parsed;
      }
    } catch {}

    if (localPaper.includes(existingWelcome)) {
      return false;
    }

    if (isWelcomeManuallyRestored(storageOps)) {
      return false;
    }

    const welcomePath = await resolveWelcomePath(MAIN_FOLDER, existingWelcome);
    const content = await fsOps.readTextFile(welcomePath);

    // Sólo autoarchivar si no fue modificado por el usuario
    if (await isInternalWelcome(existingWelcome, content, fsOps)) {
      await archiveWelcome(existingWelcome, localPaper, storageOps);
      try {
        fileStore.getState().editedFile();
      } catch {}
      return true;
    }
  } catch (err) {
    logger.warn("Error al intentar autoarchivar archivo de bienvenida tras sincronización:", err);
  }
  return false;
}
