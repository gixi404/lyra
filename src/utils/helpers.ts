import { useToastStore } from "../store/toastStore";
import translations from "./dictionary";
import usePreferences from "../hooks/usePreferences";
import { configStore } from "../store/configStore";
import { exists, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
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

const reload = (): void => window.location.reload();

function navigation(): Navigation {
  const navigate: NavigateFunction = useNavigate();

  function goTo(path: string): void {
    document.startViewTransition(() => flushSync(() => navigate(path)));
  }

  return { goTo };
}

function notification(type: "success" | "error", msg: string): void {
  useToastStore.getState().addToast(type, msg);
}

function nameIsValid(name: string): boolean {
  const d = translations(),
    regex: RegExp = /[\\/:*"<>|]/,
    nameLong: boolean = len(name) > 60,
    invalidSymbols: boolean = regex.test(name),
    invalidStartEnd: boolean = /^[ .]|[ .]$/.test(name);

  if (nameLong) {
    notification("error", d.VeryLongName);
    return false;
  }

  if (invalidSymbols || invalidStartEnd) {
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

  while (true) {
    const mainFolderExists: boolean = await exists(MAIN_FOLDER, BASE_DIRECTORY);
    const path: string = await join(MAIN_FOLDER, welcome);
    if (!mainFolderExists) {
      mkdir(MAIN_FOLDER, BASE_DIRECTORY)
        .then(() => writeTextFile(path, intro, BASE_DIRECTORY))
        .catch((e: unknown) => {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.error(`catch 'verifyMainFolder' ${errorMessage}`);
        });
      break;
    } else break;
  }
}

function copyText(text: string): void {
  const d = translations();
  navigator.clipboard.writeText(text);
  notification("success", d.CopiedToClipboard);
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
  return currentPath == path;
}

const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const len = (val: string | any[]): number => val.length;

export {
  copyText,
  getDate,
  getEditableFileName,
  len,
  nameIsValid,
  navigation,
  normalize,
  notification,
  pathIs,
  reload,
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
