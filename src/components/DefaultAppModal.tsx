import { useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { AppWindow, Info, X } from "lucide-react";
import { themes } from "../utils/helpers";
import { getDefaultAppInstructions } from "../utils/defaultApp";
import type { Component } from "../utils/types";
import { twMerge } from "tailwind-merge";

interface DefaultAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  os: string;
}

export function DefaultAppModal({ isOpen, onClose, os }: DefaultAppModalProps): Component | null {
  const { isDay } = themes();
  const instructions = getDefaultAppInstructions(os);

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const targetElement =
    typeof document !== "undefined"
      ? document.getElementById("modal-root") || document.body
      : null;

  if (!targetElement) return null;

  return createPortal(
    transitions((style, item) =>
      item ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-default-app-title"
          className="fixed inset-0 z-[99990] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs select-none"
          onClick={onClose}
        >
          <animated.div
            style={style}
            onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
            className={twMerge(
              "w-full max-w-lg p-6 rounded-2xl flex flex-col gap-y-5 border shadow-2xl overflow-hidden",
              isDay
                ? "bg-white border-neutral-300 text-neutral-800 shadow-neutral-400/30"
                : "bg-zinc-900 border-zinc-700 text-zinc-100 shadow-black/70"
            )}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-x-3">
              <div className="flex items-center gap-x-3">
                <div
                  className={twMerge(
                    "p-2.5 rounded-xl flex items-center justify-center",
                    isDay ? "bg-neutral-100 text-neutral-800" : "bg-zinc-800 text-zinc-200"
                  )}
                >
                  <AppWindow size={22} />
                </div>
                <div>
                  <h2
                    id="modal-default-app-title"
                    className="text-base sm:text-lg font-semibold tracking-tight"
                  >
                    {instructions.title}
                  </h2>
                  <p
                    className={twMerge(
                      "text-xs leading-relaxed mt-0.5",
                      isDay ? "text-neutral-500" : "text-zinc-400"
                    )}
                  >
                    {instructions.subtitle}
                  </p>
                </div>
              </div>

              <button
                type="button"
                aria-label="Cerrar modal"
                onClick={onClose}
                className={twMerge(
                  "cursor-pointer p-1.5 rounded-lg transition-colors shrink-0",
                  isDay
                    ? "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                )}
              >
                <X size={18} />
              </button>
            </div>

            {/* Steps list */}
            <ol className="flex flex-col gap-y-3 pl-1">
              {instructions.steps.map((step, idx) => (
                <li key={idx} className="flex items-start gap-x-3 text-xs sm:text-sm leading-relaxed">
                  <span
                    className={twMerge(
                      "flex items-center justify-center shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold mt-0.5",
                      isDay
                        ? "bg-neutral-200 text-neutral-800"
                        : "bg-zinc-800 text-zinc-200 border border-zinc-700"
                    )}
                  >
                    {idx + 1}
                  </span>
                  <span className={isDay ? "text-neutral-700" : "text-zinc-300"}>{step}</span>
                </li>
              ))}
            </ol>

            {/* Note / Tip callout */}
            {instructions.note && (
              <div
                className={twMerge(
                  "p-3 rounded-xl flex items-start gap-x-2.5 text-xs leading-relaxed border",
                  isDay
                    ? "bg-neutral-50 border-neutral-200 text-neutral-600"
                    : "bg-zinc-800/60 border-zinc-700 text-zinc-300"
                )}
              >
                <Info size={16} className="shrink-0 mt-0.5 opacity-80" />
                <span>{instructions.note}</span>
              </div>
            )}

            {/* Footer */}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className={twMerge(
                  "cursor-pointer px-4 h-9 rounded-lg border text-xs sm:text-sm font-medium transition-colors shadow-xs outline-none",
                  isDay
                    ? "bg-white text-gray-900 border-gray-300 hover:bg-gray-50"
                    : "bg-zinc-800 text-zinc-100 border-zinc-700 hover:bg-zinc-700"
                )}
              >
                Entendido
              </button>
            </div>
          </animated.div>
        </div>
      ) : null
    ),
    targetElement
  );
}

export default DefaultAppModal;
