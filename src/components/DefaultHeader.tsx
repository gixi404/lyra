import useStorage from "../hooks/useStorage";
import { ArrowLeftIcon, Sun, Moon, Settings } from "lucide-react";
import { navigation, pathIs, themes } from "../utils/helpers";
import { PAGES, THEMES } from "../utils/consts";
import { configStore } from "../store/configStore";
import type { Component } from "../utils/types";
import type { MouseEvent } from "react";

function DefaultHeader(): Component {
  const { isDay } = themes(),
    { goTo } = navigation(),
    { setItem } = useStorage(),
    toggleThemeTick = configStore(state => state.toggleThemeTick);

  function cycleTheme(e: MouseEvent<HTMLButtonElement>): void {
    const nextTheme = isDay ? THEMES.clearNigth : THEMES.Day;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || rect.left + rect.width / 2;
    const y = e.clientY || rect.top + rect.height / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const updateThemeState = () => {
      setItem("theme", nextTheme);
      toggleThemeTick();
    };

    if ("startViewTransition" in (window as any).document) {
      const transition = (window.document as any).startViewTransition(() => {
        updateThemeState();
      });

      transition.ready.then(() => {
        const clipPath = [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${endRadius}px at ${x}px ${y}px)`,
        ];
        ((window as any).document as Document).documentElement.animate(
          {
            clipPath: clipPath,
          },
          {
            duration: 450,
            easing: "ease-in-out",
            pseudoElement: "::view-transition-new(root)",
          }
        );
      });
    } else {
      const doc = (window as any).document as Document;
      const ripple = doc.createElement("div");
      const nextIsDay = nextTheme === THEMES.Day;

      ripple.style.position = "fixed";
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      ripple.style.width = "0px";
      ripple.style.height = "0px";
      ripple.style.borderRadius = "50%";
      ripple.style.backgroundColor = nextIsDay ? "#e0e0e0" : "#101010";
      ripple.style.transform = "translate(-50%, -50%)";
      ripple.style.transition = "width 450ms cubic-bezier(0.4, 0, 0.2, 1), height 450ms cubic-bezier(0.4, 0, 0.2, 1)";
      ripple.style.pointerEvents = "none";
      ripple.style.zIndex = "99999";
      doc.body.appendChild(ripple);

      requestAnimationFrame(() => {
        const diameter = endRadius * 2.2;
        ripple.style.width = `${diameter}px`;
        ripple.style.height = `${diameter}px`;
      });

      setTimeout(() => {
        updateThemeState();
        setTimeout(() => {
          ripple.remove();
        }, 150);
      }, 400);
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
      <div className="auto-hide-ui no-print fixed top-4 left-4 sm:left-6 z-50 flex items-center gap-x-2">
        {pathIs(PAGES.list) && (
          <div className="flex items-center gap-x-2.5 select-none opacity-90">
            <img src="/logo.png" alt="Lyra" className="w-[26px] h-[26px] object-contain" />
            <span className={`text-base font-bold tracking-tight ${isDay ? "text-neutral-800" : "text-neutral-100"}`}>
              Lyra
            </span>
          </div>
        )}

        {pathIs(PAGES.file) && (
          <button
            onClick={() => goTo(PAGES.list)}
            className={`p-2 rounded-xl transition-colors shadow-sm border cursor-pointer ${
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
      </div>

      <div className="auto-hide-ui no-print fixed top-4 right-4 sm:right-6 z-50 flex items-center gap-x-2">
        {(pathIs(PAGES.list) || pathIs(PAGES.preferences)) && (
          <>
            <button
              type="button"
              onClick={cycleTheme}
              className={`p-2 rounded-xl transition-colors shadow-sm border cursor-pointer ${
                isDay
                  ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
              aria-label="Cambiar tema"
            >
              {isDay ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            <button
              type="button"
              onClick={handleSettingsClick}
              className={`p-2 rounded-xl transition-colors shadow-sm border cursor-pointer ${
                isDay
                  ? "bg-white/90 border-neutral-200 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100"
                  : "bg-zinc-900/90 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
              aria-label={pathIs(PAGES.preferences) ? "Volver a la lista" : "Configuración"}
            >
              {pathIs(PAGES.preferences) ? <ArrowLeftIcon size={18} /> : <Settings size={18} />}
            </button>
          </>
        )}
      </div>
    </>
  );
}

export default DefaultHeader;
