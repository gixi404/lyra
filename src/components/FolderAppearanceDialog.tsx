import { useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { Check, X } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { themes } from "../utils/helpers.ts";
import { configStore } from "../store/configStore.ts";
import { scheduleSavePersistentPreferences } from "../utils/persistentPreferences.ts";
import {
  FOLDER_COLORS,
  FOLDER_ICONS,
  getFolderColor,
  getFolderIcon,
  setFolderColor,
  setFolderIcon,
  type FolderColorKey,
  type FolderIconKey,
} from "../utils/folderAppearance.ts";

interface Props {
  isOpen: boolean;
  folderPath: string;
  onClose: () => void;
}

/**
 * Diálogo unificado de personalización de carpeta.
 * Permite elegir color e icono en una sola vista, con opciones predeterminadas
 * integradas en las cuadrículas (sin botones de restablecimiento).
 */
export default function FolderAppearanceDialog({ isOpen, folderPath, onClose }: Props) {
  const { isDay } = themes();
  const currentColor = getFolderColor(folderPath) ?? "default";
  const currentIcon = getFolderIcon(folderPath) ?? "default";

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const preventScroll = (e: WheelEvent | TouchEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".modal-scrollable")) return;
      e.preventDefault();
    };
    window.addEventListener("wheel", preventScroll, { passive: false });
    window.addEventListener("touchmove", preventScroll, { passive: false });
    return () => {
      window.removeEventListener("wheel", preventScroll);
      window.removeEventListener("touchmove", preventScroll);
    };
  }, [isOpen]);

  function applyColor(key: FolderColorKey) {
    setFolderColor(folderPath, key === "default" ? undefined : key);
    configStore.getState().bumpPrefTick();
    scheduleSavePersistentPreferences();
  }

  function applyIcon(key: FolderIconKey) {
    setFolderIcon(folderPath, key === "default" ? undefined : key);
    configStore.getState().bumpPrefTick();
    scheduleSavePersistentPreferences();
  }

  const backdrop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onClose(); };
  const stop = (e: MouseEvent) => { e.stopPropagation(); };
  const targetElement = document.getElementById("modal-root") || document.body;

  const sectionTitleClass = twMerge(
    "text-xs font-medium mb-2",
    isDay ? "text-neutral-500" : "text-zinc-400"
  );

  return (
    <>
      {transitions((styles, item) => item && createPortal(
        <animated.div
          style={{ opacity: styles.opacity }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70"
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
          onMouseUp={e => { e.preventDefault(); e.stopPropagation(); }}
          onClick={backdrop}
        >
          <animated.div
            style={{ transform: styles.transform }}
            role="dialog"
            aria-modal="true"
            aria-label="Personalizar carpeta"
            className={twMerge(
              "relative w-[360px] max-w-[92vw] p-5 pt-4 rounded-2xl shadow-2xl border select-none",
              isDay ? "bg-white border-neutral-200 text-neutral-900" : "bg-zinc-900 border-zinc-800 text-zinc-100"
            )}
            onMouseDown={stop}
            onMouseUp={stop}
            onClick={stop}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              title="Cerrar"
              className={twMerge(
                "absolute top-3 right-3 p-1.5 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-500",
                isDay ? "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              )}
            >
              <X size={16} />
            </button>

            <div className="mb-4">
              <p className={sectionTitleClass}>Color</p>
              <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Color de carpeta">
                {FOLDER_COLORS.map(c => {
                  const selected = currentColor === c.key;
                  const swatchBg = c.key === "default" ? (isDay ? "#e5e7eb" : "#3f3f46") : c.swatch;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={c.label}
                      title={c.label}
                      onClick={() => applyColor(c.key)}
                      className={twMerge(
                        "relative w-10 h-10 mx-auto rounded-full border-2 flex items-center justify-center transition-all outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2",
                        selected
                          ? (isDay ? "border-neutral-900 ring-2 ring-offset-2 ring-neutral-900/20" : "border-white ring-2 ring-offset-2 ring-white/20 ring-offset-zinc-900")
                          : (isDay ? "border-transparent hover:scale-105" : "border-transparent hover:scale-105"),
                      )}
                      style={{ backgroundColor: swatchBg }}
                    >
                      {selected && <Check size={16} className={c.key === "default" ? (isDay ? "text-neutral-700" : "text-zinc-100") : "text-white"} strokeWidth={3} />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mb-4">
              <p className={sectionTitleClass}>Icono</p>
              <div className="grid grid-cols-5 gap-1.5 max-h-[220px] overflow-y-auto modal-scrollable pr-1" role="radiogroup" aria-label="Icono de carpeta">
                {FOLDER_ICONS.map(def => {
                  const selected = currentIcon === def.key;
                  const Icon = def.Icon;
                  return (
                    <button
                      key={def.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={def.label}
                      title={def.label}
                      onClick={() => applyIcon(def.key)}
                      className={twMerge(
                        "relative w-10 h-10 mx-auto rounded-xl flex items-center justify-center transition-all outline-none focus-visible:ring-2 focus-visible:ring-sky-500",
                        selected
                          ? (isDay ? "bg-neutral-900 text-white" : "bg-sky-500 text-white")
                          : (isDay ? "bg-neutral-100 text-neutral-700 hover:bg-neutral-200" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"),
                      )}
                    >
                      <Icon size={18} strokeWidth={2} />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-1" />
          </animated.div>
        </animated.div>,
        targetElement
      ))}
    </>
  );
}
