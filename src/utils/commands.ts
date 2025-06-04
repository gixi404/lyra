import translations from "./dictionary";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { appWindow } from "@tauri-apps/api/window";
import { notification, pathIs } from "./helpers";
import { PAGES, TEXT_SIZES } from "./consts";
import type { Dispatch, SetStateAction } from "react";
import type { stylesText } from "./types";

async function toggleFullScreen(): Promise<void> {
  const isFullScreen: boolean = await appWindow.isFullscreen();
  if (isFullScreen) appWindow.setFullscreen(false);
  else appWindow.setFullscreen(true);
}

function increaseText(styles: stylesText, setStyles: fnStyles): void {
  if (pathIs(PAGES.file)) {
    const { setItem } = useStorage();
    const { myFontSize } = usePreferences();
    const { sm, md, lg, xl, xxl, xxxl } = TEXT_SIZES;

    function changeSize(): string {
      switch (myFontSize()) {
        case sm:
          return md;

        case md:
          return lg;

        case lg:
          return xl;

        case xl:
          return xxl;

        case xxl:
          return xxxl;

        case xxxl:
          return xxxl;

        default:
          return lg;
      }
    }

    setItem("font-size", changeSize());
    setStyles({ ...styles, fontSize: changeSize() });
  }
}

function reduceText(styles: stylesText, setStyles: fnStyles): void {
  if (pathIs(PAGES.file)) {
    const { setItem } = useStorage();
    const { myFontSize } = usePreferences();
    const { sm, md, lg, xl, xxl, xxxl } = TEXT_SIZES;

    function changeSize(): string {
      switch (myFontSize()) {
        case sm:
          return sm;

        case md:
          return sm;

        case lg:
          return md;

        case xl:
          return lg;

        case xxl:
          return xl;

        case xxxl:
          return xxl;

        default:
          return lg;
      }
    }

    setItem("font-size", changeSize());
    setStyles({ ...styles, fontSize: changeSize() });
  }
}

function toggleSpellchecker(spellCheck: boolean, setSpellCheck: any): void {
  if (pathIs(PAGES.file)) {
    const d = translations();
    if (spellCheck) {
      notification("error", d.SpellcheckerOff);
      setSpellCheck(false);
    } else {
      notification("success", d.SpellcheckerOn);
      setSpellCheck(true);
    }
  }
}

export { increaseText, reduceText, toggleFullScreen, toggleSpellchecker };

type fnStyles = Dispatch<SetStateAction<stylesText>>;
