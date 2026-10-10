import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { themes } from "../utils/helpers";
import translations from "../utils/dictionary";
import type { Component } from "../utils/types";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (value?: string) => void;
  title: string;
  description?: string;
  hasInput?: boolean;
  initialValue?: string;
  inputPlaceholder?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
}

function Modal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  hasInput = false,
  initialValue = "",
  inputPlaceholder = "",
  confirmText,
  cancelText,
  variant = "primary",
}: ModalProps): Component | null {
  const d = translations();
  const { isDay } = themes();
  const [inputValue, setInputValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setInputValue(initialValue);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const len = inputRef.current.value.length;
          inputRef.current.setSelectionRange(len, len);
        }
      });
    }
  }, [isOpen, initialValue]);

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

  if (!isOpen) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (hasInput && !inputValue.trim()) return;
    onConfirm(hasInput ? inputValue.trim() : undefined);
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

  const finalConfirmText = confirmText || (variant === "danger" ? d.Delete : d.Add);
  const finalCancelText = cancelText || d.Cancel;
  const targetElement = document.getElementById("modal-root") || document.body;

  const modalContent = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/70"
      onMouseDown={handleBackdropEvent}
      onMouseUp={handleBackdropEvent}
      onClick={handleBackdropClick}
    >
      <div
        className={`w-full max-w-md p-6 rounded-2xl shadow-2xl border ${
          isDay
            ? "bg-white border-neutral-200 text-neutral-900"
            : "bg-zinc-900 border-zinc-800 text-zinc-100"
        }`}
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {description && (
          <p
            className={`mt-2 text-sm ${
              isDay ? "text-neutral-600" : "text-zinc-400"
            }`}
          >
            {description}
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-4">
          {hasInput && (
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              placeholder={inputPlaceholder}
              className={`w-full px-4 py-2.5 text-sm rounded-xl border outline-none transition-all ${
                isDay
                  ? "bg-neutral-50 border-neutral-300 text-neutral-900 focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-500/20"
                  : "bg-zinc-800/80 border-zinc-700 text-zinc-100 focus:border-sky-500 focus:bg-zinc-800 focus:ring-2 focus:ring-sky-500/20"
              }`}
            />
          )}

          <div className="flex items-center justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors ${
                isDay
                  ? "text-neutral-600 hover:bg-neutral-100"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              }`}
            >
              {finalCancelText}
            </button>
            <button
              type="submit"
              className={`px-4 py-2 text-sm font-medium rounded-xl transition-all shadow-sm ${
                variant === "danger"
                  ? "bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20"
                  : isDay
                  ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-600/20"
                  : "bg-sky-500 hover:bg-sky-400 text-zinc-950 font-semibold shadow-sky-500/20"
              }`}
            >
              {finalConfirmText}
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(modalContent, targetElement);
}

export default Modal;
