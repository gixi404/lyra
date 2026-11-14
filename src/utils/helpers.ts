import { type ToastAction, type ToastType, useToastStore } from "../store/toastStore.ts";
import translations from "./dictionary.ts";
import usePreferences from "../hooks/usePreferences.ts";
import { configStore } from "../store/configStore.ts";
import { scheduleSavePersistentPreferences } from "./persistentPreferences.ts";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { type NavigateFunction, useNavigate } from "react-router-dom";
import {
  BASE_DIRECTORY,
  MAIN_FOLDER,
  THEMES,
} from "./consts.ts";
import { ensureWelcomeFileState, isWelcomeFileName } from "./welcome.ts";
import {
  ensureNoteExtension,
  getFileBaseName,
  getFileDirectory,
  getLegacyFileName,
  hasSupportedNoteExtension,
  isReservedWindowsFileName,
  normalizeStoredFileNames,
  resolveStoredFileName,
} from "./noteName.ts";
import { validateFolderName } from "./folderNameValidation.ts";
import { pathIs, scrollToNovedades } from "./navigation.ts";
import { logger } from "./logger.ts";

const DEFAULT_FILE_EXTENSION = ".txt";

function useAppNavigation(): Navigation {
  const navigate: NavigateFunction = useNavigate();

  function goTo(path: string): void {
    navigate(path);
  }

  return { goTo };
}

function notification(
  type: ToastType,
  msg: string,
  action?: ToastAction,
  durationMs?: number
): void {
  useToastStore.getState().addToast(type, msg, action, durationMs);
}



// Validación estricta y no destructiva de nombres de archivo. La misma política se
// aplica en Rust (is_safe_relative_path), que es la autoridad final. Cualquier carácter
// que no pueda representarse con seguridad en Linux/Windows/macOS se RECHAZA con una
// explicación, nunca se sustituye ni se elimina en silencio.
const FORBIDDEN_FILE_NAME_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];
export interface FileNameValidation { ok: boolean; reason?: string }
function validateFileName(name: string): FileNameValidation {
  if (!name || name.trim().length === 0) {
    return { ok: false, reason: "El nombre no puede estar vacío." };
  }
  if (name !== name.trim()) {
    return { ok: false, reason: "El nombre no puede empezar ni terminar con espacios." };
  }
  if ([...name].some(c => c.charCodeAt(0) <= 31)) {
    return { ok: false, reason: "El nombre contiene caracteres de control no permitidos." };
  }
  const forbidden = FORBIDDEN_FILE_NAME_CHARS.filter(c => name.includes(c));
  if (forbidden.length > 0) {
    return { ok: false, reason: `Carácter(es) no permitido(s): ${forbidden.join(" ")}. No se pueden usar / \\ : * ? " < > | en ningún sistema operativo compatible.` };
  }
  if (/^[ .]|[ .]$/.test(name)) {
    return { ok: false, reason: "El nombre no puede empezar ni terminar con puntos o espacios." };
  }
  if (len(name) > 60) {
    return { ok: false, reason: "El nombre es demasiado largo (máximo 60 caracteres)." };
  }
  if (isReservedWindowsFileName(name)) {
    return { ok: false, reason: `"${name.split(".")[0].toUpperCase()}" es un nombre reservado de Windows y no es válido como archivo.` };
  }
  return { ok: true };
}

// (validación de carpetas unificada en ./folderNameValidation.ts)

function nameIsValid(name: string): boolean {
  const result = validateFileName(name);
  if (!result.ok) notification("error", result.reason ?? "El nombre no es válido");
  return result.ok;
}

function getEditableFileName(fileName: string): string {
  return getLegacyFileName(fileName);
}

const resolveDisplayFileName = ensureNoteExtension;

function getCompatibleFileNames(fileName: string): string[] {
  if (!hasSupportedNoteExtension(fileName)) return [fileName];

  if (!fileName.endsWith(DEFAULT_FILE_EXTENSION)) return [fileName];

  const legacyName: string = getLegacyFileName(fileName);
  return Array.from(new Set([fileName, legacyName]));
}

function getCompatibleStorageKeys(fileName: string, suffix: string = "", prefix: string = ""): string[] {
  return getCompatibleFileNames(fileName).map(name => {
    const scopedName = prefix ? `${prefix}:${name}` : name;
    return `${scopedName}${suffix}`;
  });
}

function useThemes(): Themes {
  configStore(state => state.themeTick);
  const { myTheme } = usePreferences(),
    theme = myTheme();
  let isDay: boolean = theme === THEMES.Day || theme === "Day";
  if (theme === THEMES.auto || theme === "auto" || theme === "nothing" || !theme) {
    isDay = !window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  const isNigth: boolean = !isDay;
  return { isDay, isNigth };
}

let verifyFolderPromise: Promise<void> | null = null;

async function verifyMainFolder(): Promise<void> {
  if (verifyFolderPromise) {
    return verifyFolderPromise;
  }
  verifyFolderPromise = verifyMainFolderInternal().finally(() => {
    verifyFolderPromise = null;
  });
  return verifyFolderPromise;
}

async function verifyMainFolderInternal(): Promise<void> {
  try {
    const mainFolderExists: boolean = await exists(MAIN_FOLDER, BASE_DIRECTORY);

    if (!mainFolderExists) {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("welcome_dismissed");
        window.localStorage.removeItem("welcome_manually_restored");
        window.localStorage.setItem("paper", JSON.stringify([]));
        configStore.getState().bumpPrefTick();
      }
      try {
        await mkdir(MAIN_FOLDER, { ...BASE_DIRECTORY, recursive: true });
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

    // Comprobación y creación/autoarchivado autoritativo del archivo de bienvenida
    await ensureWelcomeFileState();

    if (!window.localStorage.getItem("theme")) {
      window.localStorage.setItem("theme", THEMES.auto);
    }
    if (!window.localStorage.getItem("lyra_initialized")) {
      window.localStorage.setItem("lyra_initialized", "true");
      scheduleSavePersistentPreferences();
    }

    // Purgar borradores obsoletos o residuales con formato HTML de bienvenida en localStorage
    const localKeys = Object.keys(window.localStorage);
    for (const key of localKeys) {
      if (
        key.toLowerCase().includes("bienvenid") ||
        key.startsWith("lyra-draft:")
      ) {
        const val = window.localStorage.getItem(key) || "";
        if (
          val.includes("<p>") ||
          (val.includes("&oacute;") && val.includes("&ntilde;"))
        ) {
          window.localStorage.removeItem(key);
        }
      }
    }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logger.error(`catch 'verifyMainFolder' ${errorMessage}`);
  }
}

function getDate(): string {
  const d = translations(),
    date = new Date(),
    day = date.getDate().toString().padStart(2, "0"),
    month = (date.getMonth() + 1).toString().padStart(2, "0"),
    year = date.getFullYear().toString().slice(-2),
    hour = date.getHours().toString().padStart(2, "0"),
    minutes = date.getMinutes().toString().padStart(2, "0"),
    formattedDate = `${hour}:${minutes} h ${d.On} ${day}/${month}/${year}`;
  return formattedDate;
}



const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const len = (val: string | readonly unknown[]): number => val.length;

function getAnimationDuration(): number {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return 0;
  }
  return 200;
}

export {
  getAnimationDuration,
  getDate,
  getEditableFileName,
  getFileBaseName,
  getFileDirectory,
  len,
  nameIsValid,
  useAppNavigation,
  useAppNavigation as navigation,
  normalize,
  notification,
  pathIs,
  resolveDisplayFileName,
  resolveStoredFileName,
  normalizeStoredFileNames,
  getCompatibleStorageKeys,
  getLegacyFileName,
  hasSupportedNoteExtension,
  validateFileName,
  validateFolderName,
  scrollToNovedades,
  useThemes,
  useThemes as themes,
  verifyMainFolder,
  isWelcomeFileName,
};

export { hasSupportedNoteExtension as hasSupportedFileExtension };

interface Themes {
  isDay: boolean;
  isNigth: boolean;
}

type Navigation = { goTo: (path: string) => void };
