import { type ToastAction, useToastStore } from "../store/toastStore";
import translations from "./dictionary";
import usePreferences from "../hooks/usePreferences";
import { configStore } from "../store/configStore";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { flushSync } from "react-dom";
import { join } from "@tauri-apps/api/path";
import { type NavigateFunction, useNavigate } from "react-router-dom";
import {
  BASE_DIRECTORY,
  INTRO_ES,
  MAIN_FOLDER,
  THEMES,
  WELCOME_ES,
} from "./consts";

const DEFAULT_FILE_EXTENSION = ".txt";
const SUPPORTED_FILE_EXTENSIONS = [".txt", ".md"] as const;

function navigation(): Navigation {
  const navigate: NavigateFunction = useNavigate();

  function goTo(path: string): void {
    if ("startViewTransition" in document) {
      (document as any).startViewTransition(() => flushSync(() => navigate(path)));
    } else {
      navigate(path);
    }
  }

  return { goTo };
}

function notification(
  type: "success" | "error" | "info",
  msg: string,
  action?: ToastAction,
  durationMs?: number
): void {
  useToastStore.getState().addToast(type, msg, action, durationMs);
}

export function scrollToNovedades(): void {
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

function hasSupportedFileExtension(fileName: string): boolean {
  return SUPPORTED_FILE_EXTENSIONS.some(extension => fileName.endsWith(extension));
}

function getLegacyFileName(fileName: string): string {
  const matchingExtension = SUPPORTED_FILE_EXTENSIONS.find(extension => fileName.endsWith(extension));
  return matchingExtension ? fileName.slice(0, -matchingExtension.length) : fileName;
}

function getEditableFileName(fileName: string): string {
  return getLegacyFileName(fileName);
}

function resolveDisplayFileName(fileName: string, currentName?: string): string {
  if (hasSupportedFileExtension(fileName)) return fileName;
  if (currentName?.endsWith(".md")) return `${fileName}.md`;
  return `${fileName}${DEFAULT_FILE_EXTENSION}`;
}

function getCompatibleFileNames(fileName: string): string[] {
  if (!hasSupportedFileExtension(fileName)) return [fileName];

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
  if (hasSupportedFileExtension(fileName)) return null;

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
  let isDay: boolean = theme === THEMES.Day;
  if (theme === "auto") {
    isDay = !window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  const isNigth: boolean = !isDay;
  return { isDay, isNigth };
}

async function verifyMainFolder(): Promise<void> {
  const welcome: string = WELCOME_ES,
    intro: string = INTRO_ES;

  try {
    const mainFolderExists: boolean = await exists(MAIN_FOLDER, BASE_DIRECTORY);
    const path: string = await join(MAIN_FOLDER, welcome);

    if (!mainFolderExists) {
      await mkdir(MAIN_FOLDER, BASE_DIRECTORY);
      await writeTextFile(path, intro, BASE_DIRECTORY);
    } else {
      const welcomeExists: boolean = await exists(path, BASE_DIRECTORY);
      if (!welcomeExists) {
        await writeTextFile(path, intro, BASE_DIRECTORY);
      } else {
        try {
          const currentContent = await readTextFile(path, BASE_DIRECTORY);
          if (
            currentContent.includes("<p>") ||
            (currentContent.includes("&oacute;") && currentContent.includes("&ntilde;"))
          ) {
            await writeTextFile(path, intro, BASE_DIRECTORY);
          }
        } catch (readErr) {
          console.warn("Could not inspect welcome file content:", readErr);
        }
      }
    }

    // Purgar borradores obsoletos o residuales con formato HTML de bienvenida en localStorage
    const localKeys = Object.keys(window.localStorage);
    for (const key of localKeys) {
      if (key.toLowerCase().includes("bienvenido") || key.startsWith("lyra-draft:")) {
        const val = window.localStorage.getItem(key) || "";
        if (
          val.includes("<p>") ||
          (val.includes("&oacute;") && val.includes("&ntilde;"))
        ) {
          window.localStorage.removeItem(key);
        }
      }
    }

    // Asegurarse de que en la primera instalación el archivo de bienvenida nunca esté en archivados
    const isInit = window.localStorage.getItem("lyra_initialized");
    if (!isInit) {
      window.localStorage.setItem("lyra_initialized", "true");
      const rawPaper = JSON.parse(window.localStorage.getItem("paper") || "[]");
      if (Array.isArray(rawPaper)) {
        const cleanPaper = rawPaper.filter(
          (name: string) => !name.toLowerCase().includes("bienvenido a lyra")
        );
        window.localStorage.setItem("paper", JSON.stringify(cleanPaper));
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
  return currentPath === path;
}

const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const len = (val: string | any[]): number => val.length;

export {
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
  hasSupportedFileExtension,
  sanitizeFileName,
  themes,
  verifyMainFolder,
};

interface Themes {
  isDay: boolean;
  isNigth: boolean;
}

type Navigation = { goTo: (path: string) => void };
