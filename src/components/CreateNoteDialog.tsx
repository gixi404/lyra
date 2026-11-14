import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { animated, useTransition } from "@react-spring/web";
import { themes } from "../utils/helpers.ts";
import translations from "../utils/dictionary.ts";
import FolderPicker from "./FolderPicker.tsx";

export default function CreateNoteDialog({ isOpen, folders, initialFolder = "", onClose, onCreate, onCreateFolder }: {
  isOpen: boolean;
  folders: string[];
  initialFolder?: string;
  onClose: () => void;
  onCreate: (name: string, folder: string) => void;
  onCreateFolder: (parent: string, name: string) => Promise<string>;
}) {
  const d = translations();
  const { isDay } = themes();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(initialFolder);
  const inputRef = useRef<HTMLInputElement>(null);

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setFolder(initialFolder);

    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        const len = inputRef.current.value.length;
        inputRef.current.setSelectionRange(len, len);
      }
    };

    const rafId = requestAnimationFrame(focusInput);
    const t1 = setTimeout(focusInput, 50);
    const t2 = setTimeout(focusInput, 160);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isOpen, initialFolder]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
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

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim(), folder);
  };

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
              className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70"
              onMouseDown={handleBackdropEvent}
              onMouseUp={handleBackdropEvent}
              onClick={handleBackdropClick}
            >
              <animated.div
                style={{ transform: styles.transform }}
                role="dialog"
                aria-modal="true"
                aria-label={d.NewNote}
                className={`w-[420px] max-w-[92vw] p-6 rounded-2xl shadow-2xl border select-none ${
                  isDay
                    ? "bg-white border-neutral-200 text-neutral-900"
                    : "bg-zinc-900 border-zinc-800 text-zinc-100"
                }`}
                onMouseDown={e => e.stopPropagation()}
                onMouseUp={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
              >
                <form onSubmit={handleSubmit}>
                  <label
                    className="block text-sm mb-2"
                    htmlFor="new-note-name"
                  >
                    Nombre del nuevo archivo
                  </label>
                  <input
                    id="new-note-name"
                    ref={inputRef}
                    autoFocus
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="¿Cómo se llama la obra maestra?"
                    className={`w-full px-4 py-2.5 text-sm rounded-xl border outline-none transition-all ${
                      isDay
                        ? "bg-neutral-50 border-neutral-300 text-neutral-900 focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20"
                        : "bg-zinc-800/80 border-zinc-700 text-zinc-100 focus:border-sky-500 focus:bg-zinc-800 focus:ring-2 focus:ring-sky-500/20"
                    }`}
                  />

                  <div className="mt-4">
                    <FolderPicker
                      folders={folders}
                      value={folder}
                      onChange={setFolder}
                      onCreateFolder={onCreateFolder}
                    />
                  </div>

                  <div className="flex items-center gap-3 mt-6">
                    <button
                      type="button"
                      onClick={onClose}
                      className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-colors select-none ${
                        isDay
                          ? "text-neutral-600 enabled:hover:bg-neutral-100"
                          : "text-zinc-400 enabled:hover:bg-zinc-800 enabled:hover:text-zinc-200"
                      } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:shadow-none`}
                    >
                      {d.Cancel}
                    </button>
                    <button
                      type="submit"
                      disabled={!name.trim()}
                      className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-all select-none disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100 ${
                        isDay
                          ? "bg-accent enabled:hover:bg-accent-hover text-ink shadow-accent/20 active:enabled:scale-95 disabled:hover:bg-accent"
                          : "bg-sky-500 enabled:hover:bg-sky-400 text-zinc-950 font-semibold shadow-sky-500/20 active:enabled:scale-95 disabled:hover:bg-sky-500"
                      }`}
                    >
                      {d.Create}
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
