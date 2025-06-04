import useStorage from "./useStorage";
import { LANGS, TEXT_ALIGNS, TEXT_SIZES, THEMES } from "../utils/consts";

function usePreferences(): Preferences {
  const { getItem } = useStorage();

  function myLastModified(): boolean {
    const modified: boolean = JSON.parse(getItem("last-modified", "true"));
    return modified;
  }

  function myLangLabel(): string {
    const lang: string = getItem("language", LANGS.en);
    return lang == LANGS.en ? "English" : "Español";
  }

  function myLangValue(defaultValue?: string): string {
    const lang: string = getItem("language", defaultValue || LANGS.en);
    return lang;
  }

  function myFontLabel(): string {
    const font: string = getItem("font", "font-duo");

    switch (font) {
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
    const font: string = getItem("font", "font-duo");
    return font;
  }

  function myAlign(): string {
    const align: string = getItem("align-text", TEXT_ALIGNS.start);
    return align;
  }

  function myWordCount(): boolean {
    const count: boolean = JSON.parse(getItem("word-count", "true"));
    return count;
  }

  function mySpacing(): number {
    const spacing: number = Number(getItem("spacing", "0"));
    return spacing;
  }

  function myOpacity(): number {
    const opacity: number = Number(getItem("opacity", "10"));
    return opacity;
  }

  function myFontSize(): string {
    const fontSize: string = getItem("font-size", TEXT_SIZES.lg);
    return fontSize;
  }

  function myTheme(): string {
    const theme = getItem("theme", THEMES.clearNigth);
    return theme;
  }

  function myPaper(): string[] {
    const paper: string[] = JSON.parse(getItem("paper", "[]"));
    return paper;
  }

  function myScroll(fileName: string): number {
    const scroll: number = Number(getItem(`${fileName}-scroll`, "0"));
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
  myPaper: () => string[];
  myScroll: (fileName: string) => number;
}
