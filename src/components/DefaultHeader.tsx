import useStorage from "../hooks/useStorage";
import { ArrowLeftIcon, Sun, Moon, Settings } from "lucide-react";
import { navigation, pathIs, themes } from "../utils/helpers";
import { PAGES, THEMES } from "../utils/consts";
import { configStore } from "../store/configStore";
import type { Component } from "../utils/types";
import { memo, type MouseEvent } from "react";

let activeThemeAnim: Animation | null = null;

function DefaultHeader(): Component {
  const { isDay } = themes(),
    { goTo } = navigation(),
    { setItem } = useStorage(),
    toggleThemeTick = configStore(state => state.toggleThemeTick),
    paperIsOpen = configStore(state => state.paperIsOpen),
    setPaperIsOpen = configStore(state => state.setPaperIsOpen);

  function cycleTheme(e?: MouseEvent<HTMLButtonElement>): void {
    const nextTheme = isDay ? THEMES.clearNigth : THEMES.Day;
    const root = document.getElementById("root");

    if (!root) {
      setItem("theme", nextTheme);
      toggleThemeTick();
      return;
    }

    // Cancelar animación previa si el usuario hace clics repetidos rápidamente
    if (activeThemeAnim) {
      activeThemeAnim.onfinish = null;
      activeThemeAnim.oncancel = null;
      activeThemeAnim.cancel();
      activeThemeAnim = null;
    }
    document.querySelectorAll(".theme-wave-snapshot").forEach(el => el.remove());

    // Coordenadas del botón para el origen de la onda circular
    let x = 70;
    let y = 34;
    if (e && e.currentTarget) {
      const rect = e.currentTarget.getBoundingClientRect();
      x = e.clientX || rect.left + rect.width / 2;
      y = e.clientY || rect.top + rect.height / 2;
    }

    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
    const clipX = x + scrollX;
    const clipY = y + scrollY;

    const rootWidth = root.offsetWidth;
    const rootHeight = root.offsetHeight;
    const endRadius = Math.hypot(
      Math.max(clipX, rootWidth - clipX),
      Math.max(clipY, rootHeight - clipY)
    );

    // 1. Snapshot del estado actual para mantener todo el contenido visible
    const snapshot = root.cloneNode(true) as HTMLElement;
    snapshot.id = "";
    snapshot.className = `${snapshot.className} theme-wave-snapshot`;
    snapshot.style.position = "absolute";
    snapshot.style.top = "0";
    snapshot.style.left = "0";
    snapshot.style.width = "100%";
    snapshot.style.minHeight = "100vh";
    snapshot.style.pointerEvents = "none";
    snapshot.style.zIndex = "0";
    snapshot.setAttribute("aria-hidden", "true");

    // Sincronizar textareas, inputs y scrolls en el snapshot para no perder el estado visual
    const origElements = root.querySelectorAll("*");
    const cloneElements = snapshot.querySelectorAll("*");
    origElements.forEach((el, i) => {
      const clone = cloneElements[i];
      if (clone) {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          (clone as HTMLInputElement | HTMLTextAreaElement).value = el.value;
        }
        if (el.scrollTop) clone.scrollTop = el.scrollTop;
        if (el.scrollLeft) clone.scrollLeft = el.scrollLeft;
      }
    });

    document.body.appendChild(snapshot);

    // 2. Aplicar el nuevo tema inmediatamente al contenido real
    setItem("theme", nextTheme);
    toggleThemeTick();

    root.style.position = "relative";
    root.style.zIndex = "1";
    root.style.willChange = "clip-path";

    // 3. Animar la propagación circular del nuevo tema revelándose sobre el snapshot con una transición suave y orgánica
    try {
      const anim = root.animate(
        [
          { clipPath: `circle(0px at ${clipX}px ${clipY}px)` },
          { clipPath: `circle(${endRadius}px at ${clipX}px ${clipY}px)` },
        ],
        {
          duration: 650,
          easing: "cubic-bezier(0.4, 0, 0.1, 1)",
        }
      );

      activeThemeAnim = anim;

      const cleanup = () => {
        snapshot.remove();
        root.style.position = "";
        root.style.zIndex = "";
        root.style.clipPath = "";
        root.style.willChange = "";
        if (activeThemeAnim === anim) {
          activeThemeAnim = null;
        }
      };

      anim.onfinish = cleanup;
      anim.oncancel = cleanup;
    } catch {
      snapshot.remove();
      root.style.position = "";
      root.style.zIndex = "";
      root.style.clipPath = "";
      root.style.willChange = "";
      activeThemeAnim = null;
    }
  }

  function handleSettingsClick(): void {
    if (pathIs(PAGES.preferences)) {
      goTo(PAGES.list);
    } else {
      goTo(PAGES.preferences);
    }
  }

  return (
    <>
      {/* Botones de acción / volver a la izquierda */}
      <div
        className="auto-hide-ui no-print fixed top-4 left-4 sm:left-6 z-50 flex items-center gap-x-2 h-[36px]"
        style={{
          transform: "translateZ(0)",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
        }}
      >
        {pathIs(PAGES.file) && (
          <button
            onClick={() => goTo(PAGES.list)}
            className={`p-2 rounded-xl transition-all duration-150 active:scale-95 shadow-sm border cursor-pointer ${
              isDay
                ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
            }`}
            aria-label="Volver a la lista"
            title="Volver a la lista"
          >
            <ArrowLeftIcon size={18} />
          </button>
        )}

        {pathIs(PAGES.preferences) && (
          <>
            <button
              type="button"
              onClick={handleSettingsClick}
              className={`p-2 rounded-xl transition-all duration-150 active:scale-95 shadow-sm border cursor-pointer ${
                isDay
                  ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
              aria-label="Volver a la lista"
              title="Volver a la lista"
            >
              <ArrowLeftIcon size={18} />
            </button>

            <button
              type="button"
              onClick={cycleTheme}
              className={`p-2 rounded-xl transition-all duration-150 active:scale-95 shadow-sm border cursor-pointer ${
                isDay
                  ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
              aria-label="Cambiar tema"
              title="Cambiar tema"
            >
              {isDay ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </>
        )}

        {pathIs(PAGES.list) && (
          <>
            {paperIsOpen ? (
              <button
                type="button"
                onClick={() => setPaperIsOpen(false)}
                className={`p-2 rounded-xl transition-all duration-150 active:scale-95 shadow-sm border cursor-pointer ${
                  isDay
                    ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                    : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
                aria-label="Volver a documentos"
                title="Volver a documentos"
              >
                <ArrowLeftIcon size={18} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSettingsClick}
                className={`p-2 rounded-xl transition-all duration-150 active:scale-95 shadow-sm border cursor-pointer ${
                  isDay
                    ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                    : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
                aria-label="Configuración"
                title="Configuración"
              >
                <Settings size={18} />
              </button>
            )}

            <button
              type="button"
              onClick={cycleTheme}
              className={`p-2 rounded-xl transition-all duration-150 active:scale-95 shadow-sm border cursor-pointer ${
                isDay
                  ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
              aria-label="Cambiar tema"
              title="Cambiar tema"
            >
              {isDay ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </>
        )}
      </div>

      {/* Icono y texto Lyra a la derecha */}
      <div
        className="auto-hide-ui no-print fixed top-4 right-4 sm:right-6 z-50 flex items-center gap-x-2.5 h-[36px]"
        style={{
          transform: "translateZ(0)",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
        }}
      >
        {(pathIs(PAGES.list) || pathIs(PAGES.preferences)) && (
          <div className="flex items-center gap-x-2.5 select-none opacity-90">
            <span className={`text-base font-bold tracking-tight ${isDay ? "text-neutral-800" : "text-neutral-100"}`}>
              Lyra
            </span>
            <img src="/logo.png" alt="Lyra" className="w-[26px] h-[26px] object-contain" />
          </div>
        )}
      </div>
    </>
  );
}

export default memo(DefaultHeader);
