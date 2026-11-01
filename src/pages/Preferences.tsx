import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { documentDir, join } from "@tauri-apps/api/path";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { THEMES } from "../utils/consts";
import { getNotesDir } from "../utils/workspacePaths";
import translations from "../utils/dictionary";
import { scrollToNovedades, themes } from "../utils/helpers";
import {
  checkAndApplyUpdate,
  getIsCheckingUpdate,
  getPendingRestartVersion,
  restartInstalledUpdate,
} from "../utils/updater";
import type { Component } from "../utils/types";
import packageJson from "../../package.json";
import { useSyncStore } from "../store/syncStore";
import { configStore } from "../store/configStore";
import GoogleDriveIcon from "../components/GoogleDriveIcon";
import Modal from "../components/Modal";
import { createLogoutConfirmation } from "../utils/logoutConfirmation";

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
    "Sincronización de archivos con Google Drive.",
    "Nuevo tema \"Sistema\".",
    "Correción de bugs.",
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
  const { isDay } = themes(),
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
    }),
    [hasCheckedUpdates, setHasCheckedUpdates] = useState<boolean>(false),
    [hasSyncedInView, setHasSyncedInView] = useState<boolean>(false),
    [logoutDialogOpen, setLogoutDialogOpen] = useState(false),
    [isLoggingOut, setIsLoggingOut] = useState(false),
    {
      isConnected,
      isSyncing,
      userEmail,
      lastSyncTimestamp,
      lastError,
      fetchStatus,
      login,
      logout,
      syncNow,
    } = useSyncStore();
  const logoutConfirmationRef = useRef(createLogoutConfirmation(logout));

  async function confirmLogout(): Promise<void> {
    if (logoutConfirmationRef.current.isPending()) return;
    setIsLoggingOut(true);
    try {
      if (await logoutConfirmationRef.current.confirm()) setLogoutDialogOpen(false);
    } finally {
      setIsLoggingOut(false);
    }
  }

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    return () => {
      // Cancelar flujo OAuth activo al salir de Preferencias
      const state = useSyncStore.getState();
      if (!state.isConnected && state.isSyncing) {
        void state.cancelLogin();
      }
    };
  }, []);

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

    if (getIsCheckingUpdate() || hasCheckedUpdates) return;
    setHasCheckedUpdates(true);
    setCheckingUpdate(true);
    try {
      await checkAndApplyUpdate(true);
      const raw = window.localStorage.getItem("lyra_release_notes");
      const parsed = parseChangelog(raw);
      if (parsed) setReleaseNotes(parsed);
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
      const path: string = await join(docPath, getNotesDir());
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
            {/* Google Drive */}
            <div
              className={twMerge(
                "w-full flex flex-col gap-y-3.5 p-4 rounded-xl border transition-colors",
                isDay
                  ? "bg-white/80 border-gray-200/90 shadow-xs"
                  : "bg-[#18181b]/70 border-zinc-800 shadow-xs"
              )}
            >
              <div className="flex justify-between items-center w-full gap-x-2">
                <div className="flex items-center gap-x-2 sm:gap-x-3">
                  <GoogleDriveIcon
                    size={26}
                    className="sm:w-[28px] sm:h-[28px] shrink-0"
                  />
                  <div>
                    <div className="flex items-center gap-x-2">
                      <p className={`text-sm sm:text-md font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>Google Drive</p>
                      {isConnected && (
                        <span
                          className={twMerge(
                            "text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full",
                            isDay
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-emerald-950/60 text-emerald-300 border border-emerald-800/50"
                          )}
                        >
                          Conectado
                        </span>
                      )}
                    </div>
                    <p className={`text-xs leading-tight ${isDay ? "text-neutral-600" : "text-zinc-300"}`}>
                      {isConnected ? (
                        userEmail ?? "Carpeta 'lyra' sincronizada"
                      ) : (
                        <>
                          Sincroniza tus archivos con
                          <br />
                          la nube
                        </>
                      )}
                    </p>
                  </div>
                </div>

                {!isConnected ? (
                  <button
                    type="button"
                    onClick={login}
                    disabled={isSyncing}
                    className={twMerge(
                      "cursor-pointer w-[120px] sm:w-[140px] h-10 px-3 rounded-md border text-sm font-medium outline-none transition-colors flex items-center justify-center gap-x-2",
                      isDay
                        ? "bg-indigo-600 text-white border-indigo-700 hover:bg-indigo-700 shadow-sm"
                        : "bg-indigo-600 text-white border-indigo-500 hover:bg-indigo-500 shadow-sm",
                      isSyncing && "opacity-60 cursor-not-allowed"
                    )}
                  >
                    <span>{isSyncing ? "Conectando..." : "Conectar"}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      console.log("[Preferences] Click en botón Sincronizar", {
                        isConnected,
                        isSyncing,
                        hasSyncedInView,
                        lastError,
                      });
                      if (isSyncing) {
                        console.warn("[Preferences] Click ignorado: isSyncing ya está en curso");
                        return;
                      }
                      await syncNow(false);
                      if (!useSyncStore.getState().lastError) {
                        setHasSyncedInView(true);
                        setTimeout(() => setHasSyncedInView(false), 3000);
                      }
                    }}
                    disabled={isSyncing}
                    className={twMerge(
                      "cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 rounded-md border text-sm font-medium outline-none transition-colors flex items-center justify-center gap-x-2",
                      isDay
                        ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50 shadow-sm"
                        : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c] shadow-sm",
                      isSyncing && "opacity-60 cursor-not-allowed"
                    )}
                  >
                    {isSyncing ? (
                      <RefreshCwIcon size={14} className="animate-spin" />
                    ) : hasSyncedInView ? null : (
                      <RefreshCwIcon size={14} />
                    )}
                    <span>
                      {isSyncing
                        ? "Sincronizando..."
                        : hasSyncedInView
                        ? "Sincronizado"
                        : "Sincronizar"}
                    </span>
                  </button>
                )}
              </div>

              {lastError && (
                <div
                  className={twMerge(
                    "w-full p-2.5 rounded-lg border text-xs flex flex-col gap-y-2 mt-1",
                    isDay
                      ? "bg-red-50/90 border-red-200 text-red-800"
                      : "bg-red-950/30 border-red-800/50 text-red-200"
                  )}
                >
                  <span className="font-medium leading-relaxed">{lastError}</span>
                  <div className="flex items-center gap-x-2">
                    {lastError.includes("revocada") ||
                    lastError.includes("invalid_grant") ||
                    lastError.includes("expirado") ||
                    !isConnected ? (
                      <button
                        type="button"
                        onClick={login}
                        disabled={isSyncing}
                        className={twMerge(
                          "cursor-pointer px-2.5 py-1 rounded text-xs font-medium border transition-colors",
                          isDay
                            ? "bg-white text-red-700 border-red-300 hover:bg-red-50"
                            : "bg-zinc-900 text-red-300 border-red-800 hover:bg-zinc-800"
                        )}
                      >
                        Reconectar cuenta
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void syncNow(false)}
                        disabled={isSyncing}
                        className={twMerge(
                          "cursor-pointer px-2.5 py-1 rounded text-xs font-medium border transition-colors",
                          isDay
                            ? "bg-white text-red-700 border-red-300 hover:bg-red-50"
                            : "bg-zinc-900 text-red-300 border-red-800 hover:bg-zinc-800"
                        )}
                      >
                        Reintentar sincronización
                      </button>
                    )}
                  </div>
                </div>
              )}

              {isConnected && (
                <div
                  className={twMerge(
                    "flex flex-col gap-y-2.5 pt-3 border-t text-xs",
                    isDay ? "border-gray-200" : "border-zinc-800"
                  )}
                >
                  <div className="flex justify-between items-center text-xs">
                    <span className={isDay ? "text-neutral-700 font-medium" : "text-zinc-300 font-medium"}>
                      {lastSyncTimestamp
                        ? `Última sincronización: ${new Date(
                            lastSyncTimestamp
                          ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                        : "Sin sincronizaciones previas"}
                    </span>
                    <button
                      type="button"
                      onClick={() => { logoutConfirmationRef.current.open(); setLogoutDialogOpen(true); }}
                      className={twMerge(
                        "cursor-pointer w-24 h-7 rounded text-xs font-medium border transition-colors flex items-center justify-center text-center",
                        isDay
                          ? "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"
                          : "bg-red-950/40 text-red-300 border-red-800/60 hover:bg-red-900/40"
                      )}
                      title="Desconectar cuenta"
                    >
                      Desconectar
                    </button>
                  </div>
                </div>
              )}
            </div>

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
                disabled={checkingUpdate || (!pendingVersion && hasCheckedUpdates)}
                className={twMerge(
                  "cursor-pointer w-[140px] sm:w-[160px] h-10 px-3 rounded-md border text-sm font-medium outline-none transition-colors flex items-center justify-center gap-x-2",
                  isDay
                    ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50 shadow-sm"
                    : "bg-[#222222] text-zinc-100 border-zinc-700 hover:bg-[#2c2c2c] shadow-sm",
                  (checkingUpdate || (!pendingVersion && hasCheckedUpdates)) && "opacity-60 cursor-not-allowed"
                )}
              >
                {checkingUpdate ? (
                  <RefreshCwIcon size={14} className="animate-spin" />
                ) : pendingVersion ? (
                  <RefreshCwIcon size={14} />
                ) : hasCheckedUpdates ? null : (
                  <RefreshCwIcon size={14} />
                )}
                <span>
                  {checkingUpdate
                    ? "Buscando..."
                    : pendingVersion
                    ? "Reiniciar"
                    : hasCheckedUpdates
                    ? "Comprobado"
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
      <Modal
        isOpen={logoutDialogOpen}
        onClose={() => { if (!isLoggingOut) { logoutConfirmationRef.current.cancel(); setLogoutDialogOpen(false); } }}
        onConfirm={() => { void confirmLogout(); }}
        title="¿Cerrar sesión de Google Drive?"
        description={`Se desconectará Google Drive. Tus notas locales permanecerán disponibles. Los cambios pendientes podrán sincronizarse cuando vuelvas a conectar esta cuenta.${isSyncing ? " Hay una sincronización en curso que puede quedar interrumpida." : ""}`}
        confirmText={isLoggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
        cancelText="Cancelar"
        variant="danger"
      />
    </MainContainer>
  );
}

export default Preferences;

type Options = {
  readonly value: string;
  readonly label: string;
};
