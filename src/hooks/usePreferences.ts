import useStorage from "./useStorage";
import { getCompatibleStorageKeys, normalizeStoredFileNames } from "../utils/helpers";
import { TEXT_ALIGNS, TEXT_SIZES, THEMES } from "../utils/consts";
import { configStore } from "../store/configStore";

function usePreferences(): Preferences {
  configStore(state => state.prefTick);
  const { getItem, setItem } = useStorage();
  const readBoolean = (key: string, fallback: string): boolean =>
    JSON.parse(getItem(key, fallback)) as boolean;

  function myLastModified(): boolean {
    return readBoolean("last-modified", "true");
  }

  function myFontLabel(): string {
    const map: Record<string, string> = {
      "font-duo": "iA Writer Duo",
      "font-inter": "Inter",
      "font-fira": "Fira Code",
      "font-jetbrains": "JetBrains Mono",
      "font-roboto": "Roboto",
      "font-lora": "Lora",
      "font-merriweather": "Merriweather",
      "font-opensans": "Open Sans",
      "font-poppins": "Poppins",
      "font-montserrat": "Montserrat",
      "font-sourcecode": "Source Code Pro",
      "font-spacemono": "Space Mono",
      "font-playfair": "Playfair Display",
      "font-nunito": "Nunito",
      "font-cinzel": "Cinzel",
    };
    return map[myFontValue()] || "iA Writer Duo";
  }

  function myFontValue(): string {
    return getItem("font", "font-duo");
  }

  function myAlign(): string {
    return getItem("align-text", TEXT_ALIGNS.start);
  }

  function myWordCount(): boolean {
    return readBoolean("word-count", "true");
  }

  function mySpacing(): number {
    return Number(getItem("spacing", "0"));
  }

  function myFontSize(): string {
    return getItem("font-size", TEXT_SIZES.lg);
  }

  function myTheme(): string {
    const savedTheme = getItem("theme", "nothing");
    if (savedTheme === "nothing" || savedTheme === "auto") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const defaultTheme = prefersDark ? THEMES.clearNigth : THEMES.Day;
      setItem("theme", defaultTheme);
      return defaultTheme;
    }
    return savedTheme;
  }

  function myParagraphFocus(): boolean {
    return readBoolean("paragraph-focus", "false");
  }

  function myPaper(files: string[] = []): string[] {
    const paper: string[] = JSON.parse(getItem("paper", "[]")) as string[];
    return files.length > 0 ? normalizeStoredFileNames(paper, files) : paper;
  }

  function myScroll(fileName: string): number {
    const scrollKeys: string[] = getCompatibleStorageKeys(fileName, "-scroll");
    const scrollValue: string | null = scrollKeys.reduce<string | null>((value, key) => {
      if (value !== null) return value;
      return window.localStorage.getItem(key);
    }, null);
    const scroll: number = Number(scrollValue ?? "0");
    return scroll;
  }

  return {
    myLastModified,
    myFontLabel,
    myFontValue,
    myAlign,
    myWordCount,
    mySpacing,
    myFontSize,
    myTheme,
    myParagraphFocus,
    myPaper,
    myScroll,
  };
}

export default usePreferences;

interface Preferences {
  myLastModified: () => boolean;
  myFontLabel: () => string;
  myFontValue: () => string;
  myAlign: () => string;
  myWordCount: () => boolean;
  mySpacing: () => number;
  myFontSize: () => string;
  myTheme: () => string;
  myParagraphFocus: () => boolean;
  myPaper: (files?: string[]) => string[];
  myScroll: (fileName: string) => number;
}
