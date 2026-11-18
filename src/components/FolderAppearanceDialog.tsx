import { useEffect, useRef, useState, type MouseEvent } from "react";
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
  getFolderIcon,
  getFolderIconColor,
  getFolderTextColor,
  setFolderIcon,
  setFolderIconColor,
  setFolderTextColor,
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
 * Permite elegir icono y, mediante un selector, el color de carpeta o de texto.
 */
export default function FolderAppearanceDialog({ isOpen, folderPath, onClose }: Props) {
  const { isDay } = themes();
  const [colorTarget, setColorTarget] = useState<"folder" | "text">("folder");
  const [textColor, setTextColor] = useState<string>("default");
  const [iconColor, setIconColor] = useState<string>("default");
  const [icon, setIcon] = useState<string>("default");
  const onCloseRef = useRef(onClose);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    const justOpened = !wasOpenRef.current;
    wasOpenRef.current = true;
    if (justOpened) {
      setColorTarget("folder");
    }
    setTextColor(getFolderTextColor(folderPath) ?? "default");
    setIconColor(getFolderIconColor(folderPath) ?? "default");
    setIcon(getFolderIcon(folderPath) ?? "default");
  }, [isOpen, folderPath]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

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
    const value = key === "default" ? undefined : key;
    if (colorTarget === "folder") {
      setIconColor(key);
      setFolderIconColor(folderPath, value);
    } else {
      setTextColor(key);
      setFolderTextColor(folderPath, value);
    }
    configStore.getState().bumpPrefTick();
    scheduleSavePersistentPreferences();
  }

  function applyIcon(key: FolderIconKey) {
    setIcon(key);
    setFolderIcon(folderPath, key === "default" ? undefined : key);
    configStore.getState().bumpPrefTick();
    scheduleSavePersistentPreferences();
  }

  const backdrop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onClose(); };
  const stop = (e: MouseEvent) => { e.stopPropagation(); };
  const targetElement = document.getElementById("modal-root") || document.body;

  const sectionTitleClass = twMerge(
    "text-sm font-medium",
    isDay ? "text-neutral-700" : "text-zinc-200"
  );

  const selectedColor = colorTarget === "folder" ? iconColor : textColor;
  const colorLabel = colorTarget === "folder" ? "Color carpeta" : "Color texto";

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
              "relative w-[700px] max-w-[94vw] p-5 pt-4 rounded-2xl shadow-2xl border select-none",
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
                isDay ? "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900" : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              )}
            >
              <X size={16} />
            </button>

            <div className="mt-2 flex flex-col sm:flex-row gap-6">
              <div className="min-w-0 flex-1">
                <div className="mb-3 flex h-9 items-center">
                  <p className={sectionTitleClass}>Icono</p>
                </div>
                <div className="grid grid-cols-5 gap-1.5 max-h-[260px] overflow-y-auto modal-scrollable pr-1" role="radiogroup" aria-label="Icono de carpeta">
                  {FOLDER_ICONS.map(def => {
                    const selected = icon === def.key;
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

              <div className="min-w-0 flex-1">
                <div className="mb-3 flex h-9 items-center">
                  <div
                    className={twMerge(
                      "inline-flex rounded-xl p-1 gap-1",
                      isDay ? "bg-neutral-100" : "bg-zinc-800"
                    )}
                    role="tablist"
                    aria-label="Color a personalizar"
                  >
                    {([
                      { key: "folder" as const, label: "Color carpeta" },
                      { key: "text" as const, label: "Color texto" },
                    ]).map(opt => {
                      const selected = colorTarget === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          role="tab"
                          aria-selected={selected}
                          onClick={() => setColorTarget(opt.key)}
                          className={twMerge(
                            "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-500",
                            selected
                              ? (isDay ? "bg-white text-neutral-900 shadow-sm" : "bg-zinc-700 text-zinc-100")
                              : (isDay ? "text-neutral-700 hover:text-neutral-900" : "text-zinc-300 hover:text-zinc-100")
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={colorLabel}>
                  {FOLDER_COLORS.map(c => {
                    const selected = selectedColor === c.key;
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
                          "relative w-10 h-10 mx-auto rounded-xl border-2 flex items-center justify-center transition-all outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2",
                          selected
                            ? (isDay ? "border-neutral-900 ring-2 ring-offset-2 ring-neutral-900/20" : "border-white ring-2 ring-offset-2 ring-white/20 ring-offset-zinc-900")
                            : "border-transparent hover:scale-105",
                        )}
                        style={{ backgroundColor: swatchBg }}
                      >
                        {selected && <Check size={16} className={c.key === "default" ? (isDay ? "text-neutral-700" : "text-zinc-100") : "text-white"} strokeWidth={3} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </animated.div>
        </animated.div>,
        targetElement
      ))}
    </>
  );
}
