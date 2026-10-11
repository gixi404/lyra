import { useEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { SlidersHorizontal, X, Check } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { searchStore, type SortOptionId } from "../store/searchStore";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

interface ModalSortProps {
  isOpen: boolean;
  onClose: () => void;
}

const SORT_OPTIONS: { id: SortOptionId; label: string }[] = [
  { id: "mtime", label: "Última edición" },
  { id: "az", label: "A-Z" },
  { id: "za", label: "Z-A" },
  { id: "recent", label: "Más reciente" },
  { id: "oldest", label: "Más antiguo" },
  { id: "random", label: "Aleatorio" },
];

function ModalSort({ isOpen, onClose }: ModalSortProps): Component | null {
  const { isDay } = themes();
  const { sortOption, setSortOption } = searchStore(
    useShallow(state => ({
      sortOption: (state.sortOption || state.sortOptions?.[0] || "mtime") as SortOptionId,
      setSortOption: state.setSortOption || state.toggleSortOption,
    }))
  );

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleBackdropClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const handleBackdropEvent = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const targetElement = document.getElementById("modal-root") || document.body;

  return (
    <>
      {transitions(
        (styles, item) =>
          item &&
          createPortal(
            <animated.div
              style={{ opacity: styles.opacity }}
              className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
              onMouseDown={handleBackdropEvent}
              onMouseUp={handleBackdropEvent}
              onClick={handleBackdropClick}
            >
              <animated.div
                style={{ transform: styles.transform }}
                className={`w-full max-w-sm p-6 rounded-2xl shadow-2xl border ${
                  isDay
                    ? "bg-white border-neutral-200 text-neutral-900"
                    : "bg-zinc-900 border-zinc-800 text-zinc-100"
                }`}
                onMouseDown={e => e.stopPropagation()}
                onMouseUp={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
              >
                {/* Cabecera con título e icono X arriba a la derecha */}
                <div
                  className={`flex items-center justify-between pb-3 border-b ${
                    isDay ? "border-neutral-200" : "border-zinc-800"
                  }`}
                >
                  <div className="flex items-center gap-x-2.5">
                    <SlidersHorizontal className={`w-5 h-5 ${isDay ? "text-indigo-600" : "text-sky-400"}`} />
                    <h3 className="text-base font-semibold tracking-tight">
                      Ordenar archivos
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Cerrar"
                    className={`p-1 rounded-lg transition-colors cursor-pointer ${
                      isDay
                        ? "text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100"
                        : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                    }`}
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="mt-4 flex flex-col gap-y-1.5">
                  {SORT_OPTIONS.map(opt => {
                    const isChecked = sortOption === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setSortOption(opt.id);
                        }}
                        className={`flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors cursor-pointer select-none ${
                          isChecked
                            ? isDay
                              ? "bg-indigo-50/80 border-indigo-200 text-indigo-900"
                              : "bg-sky-500/10 border-sky-500/30 text-sky-200"
                            : isDay
                              ? "bg-neutral-50/60 border-neutral-200/80 text-neutral-700 hover:bg-neutral-100"
                              : "bg-zinc-800/40 border-zinc-800 text-zinc-300 hover:bg-zinc-800/80"
                        }`}
                      >
                        <span>{opt.label}</span>
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                            isChecked
                              ? isDay
                                ? "bg-indigo-600 border-indigo-600 text-white"
                                : "bg-sky-500 border-sky-500 text-black"
                              : isDay
                                ? "border-neutral-300 bg-white"
                                : "border-zinc-600 bg-zinc-800"
                          }`}
                        >
                          {isChecked && <Check size={12} strokeWidth={3} />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </animated.div>
            </animated.div>,
            targetElement
          )
      )}
    </>
  );
}

export default ModalSort;
