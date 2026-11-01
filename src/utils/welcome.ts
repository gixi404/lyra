import { BASE_DIRECTORY, INTRO_ES, WELCOME_ES } from "./consts.ts";
import { currentLegacyWorkspaceId, currentNotesDir, currentSyncRequest, currentWorkspaceId, getNotesDir } from "./workspacePaths.ts";
import { workspaceNoteKeys } from "./workspaceNoteKeys.ts";
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

export const WELCOME_FILE_NAME: string = WELCOME_ES;

async function archiveWelcome(name: string, currentPaper: string[], storageOps: WelcomeStorageOps): Promise<void> {
  if (storageOps === defaultStorageOps && typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    const origin = currentNotesDir();
    const { setArchiveState } = await import("./archiveState");
    if (!origin || currentNotesDir() !== origin) return;
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
}

export interface WelcomeFsOps {
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string, options?: any) => Promise<void>;
  readDir: (path: string) => Promise<WelcomeFsEntry[]>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string, options?: any) => Promise<void>;
}

export interface WelcomeStorageOps {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

async function resolveWelcomePath(base: string, file: string): Promise<string> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      return await join(base, file);
    } catch {}
  }
  return `${base}/${file}`;
}

const defaultFsOps: WelcomeFsOps = {
  exists: async (path: string) => tauriExists(path, BASE_DIRECTORY),
  mkdir: async (path: string, options?: any) => tauriMkdir(path, { ...BASE_DIRECTORY, ...options }),
  readDir: async (path: string) => {
    const entries = await tauriReadDir(path, BASE_DIRECTORY);
    return entries.map(e => ({ name: e.name, isFile: e.isFile }));
  },
  readTextFile: async (path: string) => tauriReadTextFile(path, BASE_DIRECTORY),
  writeTextFile: async (path: string, content: string, options?: any) =>
    tauriWriteTextFile(path, content, { ...BASE_DIRECTORY, ...options }),
};

const defaultStorageOps: WelcomeStorageOps = {
  getItem: (key: string) => {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const keys = key.startsWith("welcome_")
      ? workspaceNoteKeys([key], "", "", currentWorkspaceId(), currentLegacyWorkspaceId())
      : [key];
    for (const item of keys) {
      const value = window.localStorage.getItem(item);
      if (value !== null) return value;
    }
    return null;
  },
  setItem: (key: string, value: string) => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const keys = key.startsWith("welcome_")
      ? workspaceNoteKeys([key], "", "", currentWorkspaceId(), currentLegacyWorkspaceId())
      : [key];
    window.localStorage.setItem(keys[0], value);
    if (keys.length > 1) window.localStorage.setItem(keys[1], value);
  },
  removeItem: (key: string) => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const keys = key.startsWith("welcome_")
      ? workspaceNoteKeys([key], "", "", currentWorkspaceId(), currentLegacyWorkspaceId())
      : [key];
    keys.forEach(item => window.localStorage.removeItem(item));
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
  if (fsOps === defaultFsOps && typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    const request = currentSyncRequest();
    if (!request) return false;
    return invoke<boolean>("gdrive_is_internal_welcome", { fileName: name, request });
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

export async function ensureWelcomeFileState(
  fsOps: WelcomeFsOps = defaultFsOps,
  storageOps: WelcomeStorageOps = defaultStorageOps
): Promise<WelcomeStateResult> {
  try {
    const notesDir = getNotesDir();
    const workspaceId = currentWorkspaceId();
    const isTauri = fsOps === defaultFsOps && typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
    const assertCurrent = () => {
      if (isTauri && (currentNotesDir() !== notesDir || currentWorkspaceId() !== workspaceId)) {
        throw new Error("Welcome operation belongs to another workspace");
      }
    };
    const folderExists = await fsOps.exists(notesDir);
    assertCurrent();
    if (!folderExists) {
      if (isTauri) throw new Error("The active workspace directory is unavailable");
      storageOps.removeItem("welcome_dismissed");
      storageOps.removeItem("welcome_manually_restored");
      try {
        storageOps.setItem("paper", JSON.stringify([]));
      } catch {}
      try {
        await fsOps.mkdir(notesDir, { recursive: true });
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

    const entries = await fsOps.readDir(notesDir);
    assertCurrent();
    const validFiles = entries
      .filter(e => e.isFile && !e.name.startsWith("."))
      .map(e => e.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && (name.endsWith(".txt") || name.endsWith(".md"))
      );

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

    // Escenario E: Si la carpeta local contiene notas reales
    if (realNotes.length > 0) {
      // Si existe un archivo de bienvenida activo y no fue restaurado manualmente por el usuario
      if (existingWelcome && !isArchived && !isWelcomeManuallyRestored(storageOps)) {
        try {
          const welcomePath = await resolveWelcomePath(notesDir, existingWelcome);
          const content = await fsOps.readTextFile(welcomePath);
          assertCurrent();
          // Autoarchivar sólo si el contenido es el predeterminado (no modificado por el usuario)
          if (await isInternalWelcome(existingWelcome, content, fsOps)) {
            assertCurrent();
            await archiveWelcome(existingWelcome, localPaper, storageOps);
            try {
              fileStore.getState().editedFile();
            } catch {}
            return { created: false, activeWelcome: null };
          }
        } catch (readErr) {
          console.warn("No se pudo inspeccionar contenido del archivo de bienvenida:", readErr);
        }
      }
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
      const welcomePath = await resolveWelcomePath(notesDir, WELCOME_FILE_NAME);
      assertCurrent();
      const created = fsOps === defaultFsOps && typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__
        ? await invoke<boolean>("create_internal_welcome", { content: INTRO_ES, expectedWorkspaceId: workspaceId })
        : await fsOps.writeTextFile(welcomePath, INTRO_ES, { createNew: true }).then(() => true);
      assertCurrent();

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
    console.error("Error en ensureWelcomeFileState:", err);
    return { created: false, activeWelcome: null };
  }
}

export async function autoArchiveWelcomeOnSync(
  downloadedFiles: string[],
  fsOps: WelcomeFsOps = defaultFsOps,
  storageOps: WelcomeStorageOps = defaultStorageOps
): Promise<boolean> {
  const origin = currentNotesDir();
  if (!origin) return false;
  const hasRealNotes = (downloadedFiles || []).some(f => !isWelcomeFileName(f));
  if (!hasRealNotes) {
    return false;
  }

  try {
    const entries = await fsOps.readDir(origin);
    if (currentNotesDir() !== origin) return false;
    const validFiles = entries
      .filter(e => e.isFile && !e.name.startsWith("."))
      .map(e => e.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && (name.endsWith(".txt") || name.endsWith(".md"))
      );

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

    const welcomePath = await resolveWelcomePath(origin, existingWelcome);
    if (currentNotesDir() !== origin) return false;
    const content = await fsOps.readTextFile(welcomePath);
    if (currentNotesDir() !== origin) return false;

    // Sólo autoarchivar si no fue modificado por el usuario
    if (await isInternalWelcome(existingWelcome, content, fsOps)) {
      if (currentNotesDir() !== origin) return false;
      await archiveWelcome(existingWelcome, localPaper, storageOps);
      if (currentNotesDir() !== origin) return false;
      try {
        fileStore.getState().editedFile();
      } catch {}
      return true;
    }
  } catch (err) {
    console.warn("Error al intentar autoarchivar archivo de bienvenida tras sincronización:", err);
  }
  return false;
}
