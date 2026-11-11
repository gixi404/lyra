import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { getFileBaseName } from "../utils/noteName.ts";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { fileStore } from "../store/fileStore.ts";
import { notification, themes } from "../utils/helpers.ts";
import { invoke } from "@tauri-apps/api/core";
import FolderPicker from "./FolderPicker.tsx";

interface MoveItemDialogProps {
  isOpen: boolean;
  kind: "file" | "folder";
  /** Ruta relativa del elemento a mover. */
  itemName: string;
  onClose: () => void;
  /** Carpetas que no pueden ser destino (la propia carpeta y sus descendientes). */
  excluded?: string[];
}

/**
 * Diálogo de movimiento compartido por archivos y carpetas.
 * Ambos tipos de elemento usan exactamente el mismo popup y las mismas acciones.
 */
export default function MoveItemDialog({ isOpen, kind, itemName, onClose, excluded = [] }: MoveItemDialogProps) {
  const { isDay } = themes();
  const folders = fileStore(state => state.folders);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const isFolder = kind === "folder";
  const baseName = getFileBaseName(itemName);
  const title = isFolder ? `Mover ${baseName} a...` : "Mover archivo";

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) return;
    setDestination("");
  }, [isOpen, itemName]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, busy]);

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

  async function createFolder(parent: string, name: string): Promise<string> {
    const path = parent ? `${parent}/${name}` : name;
    await invoke("create_folder", { relativePath: path });
    fileStore.getState().setFolders([...fileStore.getState().folders, path]);
    return path;
  }

  async function move() {
    if (busy) return;
    setBusy(true);
    try {
      const target = destination ? `${destination}/${baseName}` : baseName;
      const warnings = await moveLocalPath(kind, itemName, target);
      warnings.forEach(warning => notification("error", warning));
      onClose();
    } catch (error) {
      notification("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void move();
  };

  const handleBackdropClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!busy) onClose();
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
              aria-busy={busy}
              className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70"
              onMouseDown={handleBackdropEvent}
              onMouseUp={handleBackdropEvent}
              onClick={handleBackdropClick}
            >
              <animated.div
                style={{ transform: styles.transform }}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={`w-[420px] max-w-[92vw] p-6 rounded-2xl shadow-2xl border select-none ${
                  isDay
                    ? "bg-white border-neutral-200 text-neutral-900"
                    : "bg-zinc-900 border-zinc-800 text-zinc-100"
                }`}
                onMouseDown={e => e.stopPropagation()}
                onMouseUp={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
              >
                <h3 className="text-lg font-semibold tracking-tight">{title}</h3>

                <form onSubmit={handleSubmit} className="mt-4">
                  <FolderPicker
                    folders={folders}
                    value={destination}
                    onChange={setDestination}
                    onCreateFolder={createFolder}
                    excluded={excluded}
                    label=""
                  />

                  <div className="flex items-center gap-3 mt-6">
                    <button
                      type="button"
                      onClick={onClose}
                      disabled={busy}
                      className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-colors select-none ${
                        busy
                          ? "opacity-40 cursor-not-allowed text-neutral-400"
                          : isDay
                          ? "text-neutral-600 enabled:hover:bg-neutral-100"
                          : "text-zinc-400 enabled:hover:bg-zinc-800 enabled:hover:text-zinc-200"
                      } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:shadow-none`}
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-all select-none ${
                        busy
                          ? `${isDay ? "bg-accent text-ink" : "bg-sky-500 text-zinc-950"} opacity-40 cursor-not-allowed shadow-none`
                          : isDay
                          ? "bg-accent enabled:hover:bg-accent-hover text-ink shadow-accent/20 active:enabled:scale-95"
                          : "bg-sky-500 enabled:hover:bg-sky-400 text-zinc-950 font-semibold shadow-sky-500/20 active:enabled:scale-95"
                      } disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100 ${
                        isDay ? "disabled:hover:bg-accent" : "disabled:hover:bg-sky-500"
                      }`}
                    >
                      Mover
                    </button>
                  </div>
                </form>
              </animated.div>
            </animated.div>,
            targetElement
          )
      )}
    </>
  );
}
