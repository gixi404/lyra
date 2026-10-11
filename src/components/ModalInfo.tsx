import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import {
  Info,
  FileText,
  Calendar,
  HardDrive,
  Type,
  X,
  Clock,
  AlignLeft,
  Hash,
} from "lucide-react";
import useFile, { type FileStats } from "../hooks/useFile";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

interface ModalInfoProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
}

function ModalInfo({ isOpen, onClose, fileName }: ModalInfoProps): Component | null {
  const { isDay } = themes();
  const { getFileStats } = useFile();
  const [stats, setStats] = useState<FileStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) return;
    let isMounted = true;
    setLoading(true);

    getFileStats(fileName)
      .then(res => {
        if (isMounted) {
          setStats(res);
          setLoading(false);
        }
      })
      .catch(err => {
        console.error("Error loading file stats:", err);
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, fileName]);

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
  const displayName = fileName.replace(/\.(txt|md)$/i, "");

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
                    <Info className={`w-5 h-5 ${isDay ? "text-indigo-600" : "text-sky-400"}`} />
                    <h3 className="text-base font-semibold tracking-tight">
                      Información del archivo
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

                <div className="mt-4">
                  <p className="text-sm font-medium truncate mb-4 opacity-80" title={displayName}>
                    {displayName}
                  </p>

                  {loading ? (
                    <div
                      className={`py-8 text-center text-xs ${
                        isDay ? "text-neutral-400" : "text-zinc-500"
                      }`}
                    >
                      Cargando información...
                    </div>
                  ) : stats ? (
                    <div className="flex flex-col gap-y-2.5 text-xs">
                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <FileText size={14} />
                          <span>Extensión</span>
                        </span>
                        <span
                          className={`font-mono font-medium uppercase px-2 py-0.5 rounded ${
                            isDay
                              ? "bg-neutral-100 text-neutral-800"
                              : "bg-zinc-800 text-zinc-200"
                          }`}
                        >
                          {stats.extension}
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <HardDrive size={14} />
                          <span>Peso</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.sizeFormatted}
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <Clock size={14} />
                          <span>Tiempo de lectura</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.readingTime}
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <Type size={14} />
                          <span>Cantidad de palabras</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.wordCount}
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <Hash size={14} />
                          <span>Cantidad de caracteres</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.charCount}
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <AlignLeft size={14} />
                          <span>Cantidad de párrafos</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.paragraphCount}
                        </span>
                      </div>

                      <div
                        className={`flex items-center justify-between py-1 border-b ${
                          isDay ? "border-neutral-100" : "border-zinc-800/60"
                        }`}
                      >
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <Calendar size={14} />
                          <span>Fecha de creación</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.createdAt}
                        </span>
                      </div>

                      <div className="flex items-center justify-between py-1">
                        <span
                          className={`flex items-center gap-x-2 ${
                            isDay ? "text-neutral-600" : "text-zinc-400"
                          }`}
                        >
                          <Calendar size={14} />
                          <span>Última edición</span>
                        </span>
                        <span
                          className={`font-medium ${
                            isDay ? "text-neutral-900" : "text-zinc-100"
                          }`}
                        >
                          {stats.modifiedAt}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="py-4 text-center text-xs text-rose-500">
                      No se pudo obtener la información.
                    </div>
                  )}
                </div>
              </animated.div>
            </animated.div>,
            targetElement
          )
      )}
    </>
  );
}

export default ModalInfo;
