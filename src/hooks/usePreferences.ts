import useStorage from "./useStorage";
import { getCompatibleStorageKeys, normalizeStoredFileNames } from "../utils/helpers";
import { LANGS, TEXT_ALIGNS, TEXT_SIZES, THEMES } from "../utils/consts";

function usePreferences(): Preferences {
  const { getItem } = useStorage();
  const readBoolean = (key: string, fallback: string): boolean =>
    JSON.parse(getItem(key, fallback)) as boolean;

  function myLastModified(): boolean {
    return readBoolean("last-modified", "true");
  }

  function myLangLabel(): string {
    return myLangValue() == LANGS.en ? "English" : "Español";
  }

  function myLangValue(defaultValue?: string): string {
    if (defaultValue === "nothing") return getItem("language", defaultValue);
    return getItem("language", LANGS.en);
  }

  function myFontLabel(): string {
    switch (myFontValue()) {
      case "font-duo":
        return "Monospace";

      case "font-sara":
        return "Sarabun";

      case "font-cursive":
        return "Cursive";

      case "font-revert":
        return "Revert";

      case "font-serif":
        return "Sans serif";

      default:
        return "Monospace";
    }
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

  function myOpacity(): number {
    return Number(getItem("opacity", "10"));
  }

  function myFontSize(): string {
    return getItem("font-size", TEXT_SIZES.lg);
  }

  function myTheme(): string {
    return getItem("theme", THEMES.clearNigth);
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
    myLangLabel,
    myLangValue,
    myFontLabel,
    myFontValue,
    myAlign,
    myWordCount,
    mySpacing,
    myOpacity,
    myFontSize,
    myTheme,
    myPaper,
    myScroll,
  };
}

export default usePreferences;

interface Preferences {
  myLastModified: () => boolean;
  myLangLabel: () => string;
  myLangValue: (defaultValue?: string) => string;
  myFontLabel: () => string;
  myFontValue: () => string;
  myAlign: () => string;
  myWordCount: () => boolean;
  mySpacing: () => number;
  myOpacity: () => number;
  myFontSize: () => string;
  myTheme: () => string;
  myPaper: (files?: string[]) => string[];
  myScroll: (fileName: string) => number;
}
