import { useEffect, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { X, type LucideIcon } from "lucide-react";
import { themes } from "../utils/helpers.ts";

interface InfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon: LucideIcon;
  name: string;
  children: ReactNode;
}

/**
 * Marco común de las ventanas de información (archivos y carpetas).
 * Define el backdrop, la animación, la cabecera y la distribución de las filas,
 * de modo que ambos popups sean visualmente indistinguibles.
 */
export default function InfoModal({ isOpen, onClose, title, icon: Icon, name, children }: InfoModalProps) {
  const { isDay } = themes();

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
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
      {transitions((styles, item) =>
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
              className={`modal-scrollable w-[380px] max-w-[92vw] h-[430px] max-h-[90vh] p-6 rounded-2xl shadow-2xl border flex flex-col justify-start select-none ${
                isDay
                  ? "bg-white border-neutral-200 text-neutral-900"
                  : "bg-zinc-900 border-zinc-800 text-zinc-100"
              }`}
              onMouseDown={e => e.stopPropagation()}
              onMouseUp={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              <div
                className={`flex items-center justify-between pb-3 border-b shrink-0 ${
                  isDay ? "border-neutral-200" : "border-zinc-800"
                }`}
              >
                <div className="flex items-center gap-x-2.5">
                  <Icon className={`w-5 h-5 ${isDay ? "text-accent-text" : "text-sky-400"}`} />
                  <h3 className="text-base font-semibold tracking-tight">{title}</h3>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Cerrar"
                  className={`p-1 rounded-lg transition-all duration-150 active:scale-95 cursor-pointer ${
                    isDay
                      ? "text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                  }`}
                >
                  <X size={16} />
                </button>
              </div>

              <p className="text-sm font-medium truncate mt-3 mb-2 opacity-80 shrink-0" title={name}>
                {name}
              </p>

              <div className="flex-1 flex flex-col justify-center overflow-hidden">
                {children}
              </div>
            </animated.div>
          </animated.div>,
          targetElement
        )
      )}
    </>
  );
}

interface InfoRowProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  /** La última fila no dibuja separador inferior. */
  last?: boolean;
}

/** Fila de dato dentro de una ventana de información. */
export function InfoRow({ icon: Icon, label, value, last = false }: InfoRowProps) {
  const { isDay } = themes();
  return (
    <div
      className={`flex items-center justify-between py-1 ${last ? "" : "border-b"} ${
        isDay ? "border-neutral-100" : "border-zinc-800/60"
      }`}
    >
      <span className={`flex items-center gap-x-2 ${isDay ? "text-neutral-600" : "text-zinc-400"}`}>
        <Icon size={14} />
        <span>{label}</span>
      </span>
      <span className={`font-medium ${isDay ? "text-neutral-900" : "text-zinc-100"}`}>{value}</span>
    </div>
  );
}
