import toast from "react-hot-toast";
import translations from "./dictionary";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { createDir, exists, writeTextFile } from "@tauri-apps/api/fs";
import { flushSync } from "react-dom";
import { join } from "@tauri-apps/api/path";
import { type NavigateFunction, useNavigate } from "react-router-dom";
import {
  BASE_DIRECTORY,
  INTRO_EN,
  INTRO_ES,
  LANGS,
  MAIN_FOLDER,
  THEMES,
  WELCOME_EN,
  WELCOME_ES,
} from "./consts";
import type { Timer } from "./types";

const reload = (): void => window.location.reload();

function navigation(): Navigation {
  const navigate: NavigateFunction = useNavigate();

  function goTo(path: string): void {
    document.startViewTransition(() => flushSync(() => navigate(path)));
  }

  return { goTo };
}

function notification(type: "success" | "error", msg: string): void {
  toast[type](msg, {
    duration: 2000,
    style: {
      backgroundColor: "#202020",
      color: "#fff",
      padding: "6px 20px",
    },
  });
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

function themes(): Themes {
  const { myTheme } = usePreferences(),
    isDay: boolean = myTheme() == THEMES.Day,
    isNigth: boolean = myTheme() == THEMES.clearNigth;
  return { isDay, isNigth };
}

async function getSystemLang(): Promise<string> {
  //* Arroja error al obtener el idioma del sistema.
  // const lang: string = await invoke("get_system_lang");
  // if (lang.startsWith("es-")) return LANGS.es;
  // else return LANGS.en;
  return Promise.resolve(LANGS.es);
}

async function verifySystemLang(): Promise<void> {
  const { setItem } = useStorage();
  const { myLangValue } = usePreferences();
  if (myLangValue("nothing") == "nothing") {
    let lang: string = await getSystemLang();
    lang = lang == LANGS.es ? LANGS.es : LANGS.en;
    setItem("language", lang);
    reload();
  }
}

async function verifyMainFolder(): Promise<void> {
  // const systemLang: string = await getSystemLang(),
  // isSpanish: boolean = systemLang == LANGS.es,
  const isSpanish: boolean = true,
    welcome: string = isSpanish ? WELCOME_ES : WELCOME_EN,
    intro: string = isSpanish ? INTRO_ES : INTRO_EN;

  while (true) {
    const mainFolderExists: boolean = await exists(MAIN_FOLDER, BASE_DIRECTORY);
    const path: string = await join(MAIN_FOLDER, welcome);
    if (!mainFolderExists) {
      createDir(MAIN_FOLDER, BASE_DIRECTORY)
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

function stylesSelect(): any {
  const { isDay } = themes();
  return {
    placeholder: (styles: any) => ({
      ...styles,
      color: isDay ? "#000" : "#d8d8d8",
    }),
    singleValue: (styles: any) => ({
      ...styles,
      color: isDay ? "#000" : "#d8d8d8",
    }),
    control: (styles: any) => ({
      ...styles,
      backgroundColor: isDay ? "#ffffff" : "#2b2b2b",
      border: isDay ? "1px solid #9ca3af" : "1px solid #c0c0c0",
      color: isDay ? "#111827" : "#d8d8d8",
      boxShadow: isDay ? "0 1px 2px 0 rgba(0, 0, 0, 0.05)" : "0",
      width: "160px",
    }),
    option: (styles: any) => ({
      ...styles,
      ":active": { backgroundColor: isDay ? "#e5e7eb" : "#2b2b2b" },
      ":hover": { backgroundColor: isDay ? "#f3f4f6" : "#3e3e3e" },
      backgroundColor: isDay ? "#ffffff" : "#2b2b2b",
      border: 0,
      color: isDay ? "#111827" : "#e7e7e7",
    }),
    menu: (styles: any) => ({
      ...styles,
      backgroundColor: isDay ? "#ffffff" : "#2b2b2b",
      marginTop: 2,
      boxShadow: isDay ? "0 4px 6px -1px rgba(0, 0, 0, 0.1)" : "none",
    }),
  };
}

function featherAnimation(): () => void {
  const feather = document.getElementById("feather") as HTMLDivElement;
  const timer: Timer = setTimeout(() => feather?.classList.add("visible"), 300);
  return () => clearTimeout(timer);
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
  featherAnimation,
  getDate,
  getSystemLang,
  len,
  nameIsValid,
  navigation,
  normalize,
  notification,
  pathIs,
  reload,
  sanitizeFileName,
  stylesSelect,
  themes,
  verifyMainFolder,
  verifySystemLang,
};

interface Themes {
  isDay: boolean;
  isNigth: boolean;
}

type Navigation = { goTo: (path: string) => void };
