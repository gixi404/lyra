import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { documentDir, join } from "@tauri-apps/api/path";
import { useEffect, useLayoutEffect, useState } from "react";
import {
  AlignLeft as AlignIcon,
  ChevronDown,
  CaseSensitive as FontIcon,
  Command,
  Folder as FolderIcon,
  Focus as FocusIcon,
  RefreshCw as RefreshCwIcon,
  Sparkles,
  SunMoon,
} from "lucide-react";
import { twMerge } from "tailwind-merge";
import MainContainer from "../components/MainContainer";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import { MAIN_FOLDER, PAGES, THEMES } from "../utils/consts";
import translations from "../utils/dictionary";
import { navigation, scrollToNovedades, themes } from "../utils/helpers";
import {
  checkAndApplyUpdate,
  getIsCheckingUpdate,
  getPendingRestartVersion,
  restartInstalledUpdate,
} from "../utils/updater";
import type { Component } from "../utils/types";
import packageJson from "../../package.json";
import { configStore } from "../store/configStore";

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
  themesOptions: Options[] = [
    { value: THEMES.auto, label: d.System ?? "Sistema" },
    { value: THEMES.clearNigth, label: d.Night ?? "Noche" },
    { value: THEMES.Day, label: d.Day ?? "Día" },
  ] as const,
  shortcutsList = [
    { keys: "F11", label: "Pantalla completa" },
    { keys: "Ctrl + Z", label: "Deshacer cambio" },
    { keys: "Ctrl + Y", label: "Rehacer cambio" },
    { keys: "Esc", label: "Volver a la lista / Cerrar popup / Limpiar" },
    { keys: "Ctrl + F", label: "Buscar y reemplazar en editor" },
    { keys: "Ctrl + +", label: "Aumentar tamaño de letra" },
    { keys: "Ctrl + -", label: "Reducir tamaño de letra" },
    { keys: "/  ó  Ctrl + F", label: "Buscar en lista de archivos" },
    { keys: "Enter", label: "Abrir archivo único coincidente en búsqueda" },
  ] as const,
  // NOTA: Al agregar funcionalidades en esta lista o en notas de versión, NO usar formato
  // markdown (**negrita**, cursiva, enlaces, etc.). Cada elemento se muestra como texto plano directo.
  defaultChangelog = [
    "Nuevo tema 'Sistema'",
    "Mejoras visuales",
    "Correción de bugs",
  ] as const;

function parseChangelog(raw: string | null): string[] | null {
  if (!raw) return null;
  const parsed = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- ") || line.startsWith("* "))
    .map(line => line.replace(/^[-*]\s+/, ""));
  return parsed.length > 0 ? parsed : null;
}

function Preferences(): Component {
  const { goTo } = navigation(),
    { isDay } = themes(),
    {
      myFontValue,
      myAlign,
      myParagraphFocus,
    } = usePreferences(),
    { getItem, setItem } = useStorage(),
    toggleThemeTick = configStore(state => state.toggleThemeTick),
    paragraphFocus = myParagraphFocus(),
    savedTheme = getItem("theme", THEMES.auto),
    currentTheme =
      savedTheme === THEMES.Day || savedTheme === "Day"
        ? THEMES.Day
        : savedTheme === THEMES.clearNigth || savedTheme === "dark-nigth"
        ? THEMES.clearNigth
        : THEMES.auto,
    [currentVersion, setCurrentVersion] = useState<string>(packageJson.version),
    [checkingUpdate, setCheckingUpdate] = useState<boolean>(() => getIsCheckingUpdate()),
    [releaseNotes, setReleaseNotes] = useState<readonly string[]>(() => {
      try {
        const raw = window.localStorage.getItem("lyra_release_notes");
        const parsed = parseChangelog(raw);
        if (parsed) return parsed;
      } catch {}
      return defaultChangelog;
    });

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT")
      ) {
        return;
      }
      if (document.querySelector("#modal-root > div, [role='dialog']")) return;
      goTo(PAGES.list);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [goTo]);

  useEffect(() => {
    void getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    let shouldScrollToNovedades = false;
    try {
      shouldScrollToNovedades = window.sessionStorage.getItem("scroll_to_novedades") === "true";
      window.sessionStorage.removeItem("scroll_to_novedades");
    } catch {}

    if (shouldScrollToNovedades) {
      window.scrollTo(0, 0);
      scrollToNovedades();
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }, []);

  const pendingVersion = getPendingRestartVersion();

  async function handleCheckUpdate(): Promise<void> {
    const pending = getPendingRestartVersion();
    if (pending) {
      await restartInstalledUpdate();
      return;
    }

    if (getIsCheckingUpdate() || checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      await checkAndApplyUpdate(true);
      const raw = window.localStorage.getItem("lyra_release_notes");
      const parsed = parseChangelog(raw);
      if (parsed) setReleaseNotes(parsed);
    } catch {
    } finally {
      setCheckingUpdate(false);
    }
  }

  function changeFont(value: string): void {
    setItem("font", value);
  }

  function changeAlign(val: string): void {
    setItem("align-text", val);
  }

  function toggleParagraphFocus(): void {
    setItem("paragraph-focus", JSON.stringify(!paragraphFocus));
  }

  function changeTheme(val: string): void {
    setItem("theme", val);
    toggleThemeTick();
  }

  async function openFolder(): Promise<void> {
    try {
      const docPath: string = await documentDir();
      const path: string = await join(docPath, MAIN_FOLDER);
      await invoke("open_folder", { path });
    } catch (err) {
      console.error(`catch 'openFolder' ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <MainContainer>
      <div className="flex flex-col items-center justify-start w-full min-h-screen pt-14 sm:pt-20 px-4 pb-12">
        <div className="flex-col lg:flex-row mb-14 flex justify-center items-center overflow-x-hidden w-full px-6 sm:px-10 gap-x-6 gap-y-12 sm:gap-y-20">
          <div className="w-full px-4 sm:px-6 md:px-0 lg:w-3/6 lg:max-w-[470px] flex flex-col justify-center items-center gap-y-10 sm:gap-y-14">
            {/* Actualizaciones */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <RefreshCwIcon size={24} className="sm:w-[28px] sm:h-[28px]" />
                <div>
                  <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>Actualizaciones</p>
                  <p className={`text-xs ${isDay ? "text-neutral-600" : "text-zinc-300"}`}>
                    {pendingVersion
                      ? `Versión ${currentVersion} (v${pendingVersion} lista)`
                      : `Versión ${currentVersion}`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCheckUpdate}
                disabled={checkingUpdate}
                className={twMerge(
                  "cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 rounded-md border text-sm font-medium outline-none transition-colors flex items-center justify-center gap-x-2",
                  isDay
                    ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50 shadow-sm"
                    : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c] shadow-sm",
                  checkingUpdate && "opacity-40 cursor-not-allowed"
                )}
              >
                <RefreshCwIcon size={14} className={checkingUpdate ? "animate-spin" : undefined} />
                <span>
                  {pendingVersion
                    ? "Reiniciar"
                    : checkingUpdate
                    ? "Buscando..."
                    : "Buscar"}
                </span>
              </button>
            </div>

            {/* Mis archivos */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <FolderIcon size={24} className="sm:w-[28px] sm:h-[28px]" />
                <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>Mis archivos</p>
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
                <span>Abrir</span>
              </button>
            </div>

            {/* Fuente */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <FontIcon size={30} className="sm:w-[38px] sm:h-[38px]" />
                <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>{d.Font}</p>
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
                <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>{d.Aligment}</p>
              </div>
              <div className="relative">
                <select
                  value={myAlign()}
                  onChange={e => changeAlign(e.target.value)}
                  className={twMerge(
                    "appearance-none cursor-pointer w-[140px] sm:w-[160px] h-10 px-8 text-center [text-align-last:center] rounded-md border text-sm sm:text-base font-medium outline-none transition-colors",
                    isDay
                      ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50"
                      : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c]"
                  )}
                >
                  {alignsOptions.map(opt => (
                    <option
                      key={opt.value}
                      value={opt.value}
                      className={isDay ? "bg-white text-gray-900 text-center" : "bg-[#222222] text-zinc-100 text-center"}
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
                <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>{d.ParagraphFocus ?? "Enfoque en párrafo"}</p>
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

            {/* Tema */}
            <div className="flex justify-between items-center w-full gap-x-2">
              <div className="flex justify-center items-center gap-x-2 sm:gap-x-3">
                <SunMoon size={22} className="sm:w-[25px] sm:h-[25px]" />
                <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>Tema</p>
              </div>
              <div className="relative">
                <select
                  value={currentTheme}
                  onChange={e => changeTheme(e.target.value)}
                  className={twMerge(
                    "appearance-none cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 pr-8 rounded-md border text-sm sm:text-base font-medium outline-none transition-colors",
                    isDay
                      ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50"
                      : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c]"
                  )}
                >
                  {themesOptions.map(opt => (
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


            {/* Bloque inferior: Novedades y Atajos */}
            <div className="w-full flex flex-col gap-y-4">
              {/* Novedades / Cambios recientes */}
              <div
                id="novedades-section"
                className={twMerge(
                  "scroll-mt-20 w-full flex flex-col gap-y-2.5 pt-4 border-t",
                  isDay ? "border-neutral-300" : "border-zinc-800"
                )}
              >
                <div className="flex items-center gap-x-2">
                  <Sparkles size={16} className={isDay ? "text-amber-500" : "text-amber-400"} />
                  <h3 className={twMerge("text-xs sm:text-sm font-semibold", isDay ? "text-neutral-900" : "text-white")}>
                    Novedades de la versión {currentVersion}
                  </h3>
                </div>
                <ul className={twMerge("flex flex-col gap-y-1 text-xs sm:text-[13px] pl-4 list-disc", isDay ? "text-neutral-700" : "text-zinc-200")}>
                  {releaseNotes.map((item, idx) => (
                    <li key={idx} className="leading-relaxed">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Comandos / Atajos de teclado */}
              <div
                className={twMerge(
                  "w-full flex flex-col gap-y-2.5 pt-4 border-t",
                  isDay ? "border-neutral-300" : "border-zinc-800"
                )}
              >
                <div className="flex items-center gap-x-2 pb-1">
                  <Command size={16} className={isDay ? "text-neutral-700" : "text-zinc-300"} />
                  <h3 className={twMerge("text-xs sm:text-sm font-semibold", isDay ? "text-neutral-900" : "text-white")}>
                    Comandos
                  </h3>
                </div>
                {shortcutsList.map(sc => (
                  <div key={sc.keys} className="flex items-center justify-between text-xs sm:text-sm">
                    <span className={isDay ? "text-neutral-800 font-medium" : "text-zinc-200 font-medium"}>{sc.label}</span>
                    <kbd
                      className={twMerge(
                        "px-2 py-1 rounded font-mono text-xs font-semibold shadow-xs border",
                        isDay
                          ? "bg-white text-neutral-900 border-neutral-300"
                          : "bg-zinc-800 text-white border-zinc-700"
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
      </div>
    </MainContainer>
  );
}

export default Preferences;

type Options = {
  readonly value: string;
  readonly label: string;
};
