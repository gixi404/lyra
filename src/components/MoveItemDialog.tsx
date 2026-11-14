import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { invoke } from "@tauri-apps/api/core";
import { getFileBaseName, getFileDirectory } from "../utils/noteName.ts";
import { displayFolderName, displayNoteName } from "../utils/visibleNames.ts";
import { moveLocalPath } from "../utils/pathOperations.ts";
import { fileStore } from "../store/fileStore.ts";
import useStorage from "../hooks/useStorage.ts";
import { savePersistentPreferencesNow } from "../utils/persistentPreferences.ts";
import { expandAncestorsForNote, expandParentPath, readFolderExpandedState } from "../utils/folderTree.ts";
import { notification, themes } from "../utils/helpers.ts";
import { commitVisibleName, resolveNewFolderPhysicalPath, validateVisibleEntryName } from "../utils/visibleNameOps.ts";
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
  const { setItem } = useStorage();
  const folders = fileStore(state => state.folders);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const isFolder = kind === "folder";
  const displayName = isFolder ? displayFolderName(itemName) : displayNoteName(itemName);
  const title = isFolder ? `Mover ${displayName} a...` : "Mover archivo";

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) return;
    // Preseleccionar el directorio padre actual (raíz = "").
    setDestination(getFileDirectory(itemName));
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
    const validation = validateVisibleEntryName(name, "folder");
    if (!validation.ok) throw new Error(validation.reason ?? "El nombre no es válido");
    const { physicalPath, visibleSegment } = resolveNewFolderPhysicalPath(name, parent);
    await invoke("create_folder", { relativePath: physicalPath });
    fileStore.getState().setFolders([...fileStore.getState().folders, physicalPath]);
    // Confirmar metadatos visibles tras la creación física.
    commitVisibleName(physicalPath, "folder", visibleSegment);
    if (parent) {
      const nextExpanded = expandParentPath(readFolderExpandedState(window.localStorage), parent);
      setItem("folderExpanded", JSON.stringify(nextExpanded));
    }
    return physicalPath;
  }

  async function move() {
    if (busy) return;
    const physicalBase = getFileBaseName(itemName);
    const target = destination ? `${destination}/${physicalBase}` : physicalBase;
    // Directorio actual: cerrar sin invocar moveLocalPath ni operaciones físicas.
    if (target === itemName) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const warnings = await moveLocalPath(kind, itemName, target);
      warnings.forEach(warning => notification("error", warning));
      // Leer el estado actualizado tras el remapeo de preferencias del movimiento
      // (evita sobrescribir con un snapshot anterior). Aplicar expansión solo tras
      // confirmar el movimiento físico y solo cuando es necesario.
      const current = readFolderExpandedState(window.localStorage);
      let next = current;
      if (kind === "file") {
        // Nota a raíz: desplegar «Lyra»; nota a carpeta: desplegar destino y ancestros sin forzar Lyra.
        next = expandAncestorsForNote(current, destination);
      } else {
        // Carpeta movida a raíz: no modificar «Lyra»; dentro de otra: desplegar destino y ancestros.
        // Se conserva el estado propio/descendientes ya remapeado por migratePreferences.
        if (destination) {
          next = expandParentPath(current, destination);
        }
      }
      if (next !== current) {
        setItem("folderExpanded", JSON.stringify(next));
        try {
          await savePersistentPreferencesNow();
        } catch {
          // El movimiento físico ya finalizó; la expansión visual es preferencia no crítica.
          notification("error", "El elemento se movió, pero no se pudo guardar la expansión del explorador.");
        }
      }
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
