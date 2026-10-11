import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import {
  AlignLeft as AlignIcon,
  ChevronDown,
  CaseSensitive as FontIcon,
  Folder as FolderIcon,
  Focus as FocusIcon,
} from "lucide-react";
import { useState } from "react";
import { twMerge } from "tailwind-merge";
import MainContainer from "../components/MainContainer";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { MAIN_FOLDER } from "../utils/consts";
import translations from "../utils/dictionary";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

const d = translations(),
  fontsOptions: Options[] = [
    { value: "font-duo", label: "iA Writer Duo" },
    { value: "font-inter", label: "Inter" },
    { value: "font-fira", label: "Fira Code" },
    { value: "font-jetbrains", label: "JetBrains Mono" },
    { value: "font-roboto", label: "Roboto" },
    { value: "font-lora", label: "Lora" },
    { value: "font-merriweather", label: "Merriweather" },
    { value: "font-opensans", label: "Open Sans" },
    { value: "font-poppins", label: "Poppins" },
    { value: "font-montserrat", label: "Montserrat" },
    { value: "font-sourcecode", label: "Source Code Pro" },
    { value: "font-spacemono", label: "Space Mono" },
    { value: "font-playfair", label: "Playfair Display" },
    { value: "font-nunito", label: "Nunito" },
    { value: "font-cinzel", label: "Cinzel" },
  ] as const,
  alignsOptions: Options[] = [
    { value: "start", label: d.Left },
    { value: "center", label: d.Centered },
    { value: "end", label: d.Right },
  ] as const,
  shortcutsList = [
    { keys: "Ctrl + Z", label: "Deshacer cambio" },
    { keys: "Ctrl + Y", label: "Rehacer cambio" },
    { keys: "Ctrl + F", label: "Buscar y reemplazar" },
    { keys: "Ctrl + +", label: "Aumentar tamaño de letra" },
    { keys: "Ctrl + -", label: "Reducir tamaño de letra" },
    { keys: "F11", label: "Pantalla completa" },
  ] as const;

function Preferences(): Component {
  const { isDay } = themes(),
    {
      myFontValue,
      myAlign,
      myParagraphFocus,
    } = usePreferences(),
    { setItem } = useStorage(),
    [paragraphFocus, setParagraphFocus] = useState<boolean>(myParagraphFocus());

  function changeFont(value: string): void {
    setItem("font", value);
  }

  function changeAlign(val: string): void {
    setItem("align-text", val);
  }

  function toggleParagraphFocus(): void {
    const nextVal = !paragraphFocus;
    setParagraphFocus(nextVal);
    setItem("paragraph-focus", JSON.stringify(nextVal));
  }

  async function openFolder(): Promise<void> {
    try {
      const docPath: string = await documentDir();
      const path: string = await join(docPath, MAIN_FOLDER);
      await invoke("open_folder", { path });
    } catch (err: any) {
      console.error(`catch 'openFolder' ${err?.message || err}`);
    }
  }

  return (
    <MainContainer>
      <div className="flex flex-col items-center justify-start w-full min-h-screen pt-14 sm:pt-20 px-4 pb-12">
        <div className="flex-col lg:flex-row mb-14 flex justify-center items-center overflow-x-hidden w-full px-6 sm:px-10 gap-x-6 gap-y-12 sm:gap-y-20">
          <div className="w-full px-4 sm:px-6 md:px-0 lg:w-3/6 lg:max-w-[470px] flex flex-col justify-center items-center gap-y-10 sm:gap-y-14">
            {/* Mis archivos */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <FolderIcon size={24} className="sm:w-[28px] sm:h-[28px]" />
                <p className="text-sm sm:text-md">Mis archivos</p>
              </div>
              <button
                type="button"
                onClick={openFolder}
                className={twMerge(
                  "cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 rounded-md border text-sm sm:text-base font-medium outline-none transition-colors flex items-center justify-center gap-x-2",
                  isDay
                    ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50 shadow-sm"
                    : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c] shadow-sm"
                )}
              >
                <FolderIcon size={16} />
                <span>Abrir</span>
              </button>
            </div>

            {/* Fuente */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <FontIcon size={30} className="sm:w-[38px] sm:h-[38px]" />
                <p className="text-sm sm:text-md">{d.Font}</p>
              </div>
              <div className="relative">
                <select
                  value={myFontValue()}
                  onChange={e => changeFont(e.target.value)}
                  className={twMerge(
                    "appearance-none cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 pr-8 rounded-md border text-sm sm:text-base font-medium outline-none transition-colors",
                    isDay
                      ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50"
                      : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c]"
                  )}
                >
                  {fontsOptions.map(opt => (
                    <option
                      key={opt.value}
                      value={opt.value}
                      className={isDay ? "bg-white text-gray-900" : "bg-[#222222] text-zinc-100"}
                    >
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-60" />
              </div>
            </div>

            {/* Alineación */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <AlignIcon size={22} className="sm:w-[25px] sm:h-[25px]" />
                <p className="text-sm sm:text-md">{d.Aligment}</p>
              </div>
              <div className="relative">
                <select
                  value={myAlign()}
                  onChange={e => changeAlign(e.target.value)}
                  className={twMerge(
                    "appearance-none cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 pr-8 rounded-md border text-sm sm:text-base font-medium outline-none transition-colors",
                    isDay
                      ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50"
                      : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c]"
                  )}
                >
                  {alignsOptions.map(opt => (
                    <option
                      key={opt.value}
                      value={opt.value}
                      className={isDay ? "bg-white text-gray-900" : "bg-[#222222] text-zinc-100"}
                    >
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-60" />
              </div>
            </div>

            {/* Enfoque en párrafo */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <FocusIcon size={22} className="sm:w-[25px] sm:h-[25px]" />
                <p className="text-sm sm:text-md">{d.ParagraphFocus ?? "Enfoque en párrafo"}</p>
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={toggleParagraphFocus}
                  className={twMerge(
                    "cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 rounded-md border text-sm font-medium outline-none transition-colors flex items-center justify-center gap-x-2",
                    isDay
                      ? paragraphFocus
                        ? "bg-indigo-50 text-indigo-600 border-indigo-300 font-semibold"
                        : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                      : paragraphFocus
                        ? "bg-sky-500/20 text-sky-300 border-sky-400/50 font-semibold"
                        : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c]"
                  )}
                >
                  {paragraphFocus ? (d.Enabled ?? "Activado") : (d.Disabled ?? "Desactivado")}
                </button>
              </div>
            </div>

            {/* Atajos de teclado */}
            <div
              className={twMerge(
                "w-full flex flex-col gap-y-2.5 pt-4 border-t",
                isDay ? "border-neutral-300" : "border-zinc-800"
              )}
            >
              {shortcutsList.map(sc => (
                <div key={sc.keys} className="flex items-center justify-between text-xs sm:text-sm">
                  <span className={isDay ? "text-neutral-700" : "text-neutral-300"}>{sc.label}</span>
                  <kbd
                    className={twMerge(
                      "px-2 py-1 rounded font-mono text-xs font-semibold shadow-xs border",
                      isDay
                        ? "bg-white text-neutral-800 border-neutral-300"
                        : "bg-zinc-800 text-zinc-200 border-zinc-700"
                    )}
                  >
                    {sc.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </MainContainer>
  );
}

export default Preferences;

type Options = {
  readonly value: string;
  readonly label: string;
};
