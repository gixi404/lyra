import { type ToastAction, type ToastType, useToastStore } from "../store/toastStore";
import translations from "./dictionary";
import usePreferences from "../hooks/usePreferences";
import { configStore } from "../store/configStore";
import { scheduleSavePersistentPreferences } from "./persistentPreferences";
import { exists, mkdir } from "@tauri-apps/plugin-fs";
import { type NavigateFunction, useNavigate } from "react-router-dom";
import {
  BASE_DIRECTORY,
  MAIN_FOLDER,
  PAGES,
  THEMES,
} from "./consts";
import { ensureWelcomeFileState, isWelcomeFileName } from "./welcome";
import { ensureNoteExtension, hasSupportedNoteExtension, noteTitle } from "./noteName";

const DEFAULT_FILE_EXTENSION = ".txt";

function navigation(): Navigation {
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

export function scrollToNovedades(): void {
  try {
    window.sessionStorage.removeItem("scroll_to_novedades");
  } catch {}

  const tryScroll = (attempts = 0) => {
    const el = document.getElementById("novedades-section");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (attempts < 25) {
      setTimeout(() => tryScroll(attempts + 1), 60);
    }
  };

  tryScroll();
}

function nameIsValid(name: string): boolean {
  const d = translations();

  if (!name || name.trim().length === 0) {
    notification("error", d.InvalidName);
    return false;
  }

  const regex: RegExp = /[\\/:*?"<>|]/,
    hasControlChars: boolean = /[\x00-\x1f]/.test(name),
    nameLong: boolean = len(name) > 60,
    invalidSymbols: boolean = regex.test(name) || hasControlChars,
    invalidStartEnd: boolean = /^[ .]|[ .]$/.test(name);

  if (nameLong) {
    notification("error", d.VeryLongName);
    return false;
  }

  if (invalidSymbols || invalidStartEnd) {
    notification("error", d.NoSpecialCharacters);
    return false;
  }

  const baseName = name.replace(/\.(txt|md)$/i, "").trim().toUpperCase();
  const reservedWindowsNames = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ]);

  if (reservedWindowsNames.has(baseName)) {
    notification("error", d.NoSpecialCharacters);
    return false;
  }

  return true;
}

function sanitizeFileName(name: string): string {
  return name.replace(/\?/g, "@");
}

function getLegacyFileName(fileName: string): string {
  return noteTitle(fileName);
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

function resolveStoredFileName(fileName: string, files: string[]): string | null {
  if (files.includes(fileName)) return fileName;
  if (hasSupportedNoteExtension(fileName)) return null;

  const txtMatch: string = `${fileName}.txt`;
  if (files.includes(txtMatch)) return txtMatch;

  const mdMatch: string = `${fileName}.md`;
  if (files.includes(mdMatch)) return mdMatch;

  return null;
}

function normalizeStoredFileNames(fileNames: string[], files: string[]): string[] {
  const normalizedNames = fileNames
    .map(fileName => resolveStoredFileName(fileName, files))
    .filter((fileName): fileName is string => Boolean(fileName));

  return Array.from(new Set(normalizedNames));
}

function themes(): Themes {
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
    console.error(`catch 'verifyMainFolder' ${errorMessage}`);
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

function pathIs(path: string): boolean {
  const currentPath: string = window.location.pathname;
  if (path === "/" || path === PAGES.list) {
    return (
      currentPath === "/" ||
      currentPath === "/index.html" ||
      currentPath === "" ||
      currentPath.endsWith("/index.html")
    );
  }
  return currentPath === path || currentPath.endsWith(path);
}

const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const len = (val: string | any[]): number => val.length;

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
  len,
  nameIsValid,
  navigation,
  normalize,
  notification,
  pathIs,
  resolveDisplayFileName,
  resolveStoredFileName,
  normalizeStoredFileNames,
  getCompatibleStorageKeys,
  getLegacyFileName,
  hasSupportedNoteExtension,
  sanitizeFileName,
  themes,
  verifyMainFolder,
  isWelcomeFileName,
};

export { hasSupportedNoteExtension as hasSupportedFileExtension };

interface Themes {
  isDay: boolean;
  isNigth: boolean;
}

type Navigation = { goTo: (path: string) => void };
