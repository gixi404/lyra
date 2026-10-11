import { useState, useEffect, useRef, useCallback } from "react";
import { animated, useTransition } from "@react-spring/web";
import { ChevronUp, ChevronDown, Replace, ReplaceAll, X, CaseSensitive } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

export interface SearchState {
  query: string;
  matchIndices: number[];
  currentIndex: number;
  matchCase?: boolean;
}

interface SearchReplaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  content: string;
  onContentChange: (newContent: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  onSearchStateChange?: (state: SearchState | null) => void;
}

function SearchReplaceModal({
  isOpen,
  onClose,
  content,
  onContentChange,
  textareaRef,
  onSearchStateChange,
}: SearchReplaceModalProps): Component {
  const { isDay } = themes();
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matchIndices, setMatchIndices] = useState<number[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const transitions = useTransition(isOpen, {
    from: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    enter: { opacity: 1, transform: "scale(1) translateY(0px)" },
    leave: { opacity: 0, transform: "scale(0.96) translateY(6px)" },
    config: { duration: 150 },
  });

  useEffect(() => {
    return () => {
      document.getElementById("search-scroll-mirror")?.remove();
      onSearchStateChange?.(null);
    };
  }, [onSearchStateChange]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent): void => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("touchstart", handleClickOutside);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("touchstart", handleClickOutside);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 50);
      return () => clearTimeout(timer);
    } else {
      onSearchStateChange?.(null);
    }
  }, [isOpen, onSearchStateChange]);

  useEffect(() => {
    if (!isOpen || !searchQuery || matchIndices.length === 0) {
      onSearchStateChange?.(null);
    } else {
      onSearchStateChange?.({
        query: searchQuery,
        matchIndices,
        currentIndex: currentMatchIndex,
        matchCase,
      });
    }
  }, [isOpen, searchQuery, matchIndices, currentMatchIndex, matchCase, onSearchStateChange]);

  useEffect(() => {
    if (!searchQuery) {
      setMatchIndices([]);
      setCurrentMatchIndex(0);
      return;
    }

    const indices: number[] = [];
    const queryStr = matchCase ? searchQuery : searchQuery.toLowerCase();
    const contentStr = matchCase ? content : content.toLowerCase();
    let idx = contentStr.indexOf(queryStr);

    while (idx !== -1) {
      indices.push(idx);
      idx = contentStr.indexOf(queryStr, idx + searchQuery.length || 1);
    }

    setMatchIndices(indices);
    if (indices.length > 0) {
      setCurrentMatchIndex(prev => (prev >= indices.length ? 0 : prev));
    } else {
      setCurrentMatchIndex(0);
    }
  }, [searchQuery, content, matchCase]);

  const highlightMatch = useCallback(
    (index: number) => {
      const textarea = textareaRef.current;
      if (!textarea || matchIndices.length === 0) return;

      const start = matchIndices[index];
      if (start === undefined) return;
      const end = start + searchQuery.length;

      textarea.setSelectionRange(start, end);

      const style = window.getComputedStyle(textarea);

      let mirror = document.getElementById("search-scroll-mirror");
      if (!mirror) {
        mirror = document.createElement("div");
        mirror.id = "search-scroll-mirror";
        mirror.style.position = "absolute";
        mirror.style.top = "-9999px";
        mirror.style.left = "-9999px";
        mirror.style.visibility = "hidden";
        mirror.style.pointerEvents = "none";
        document.body.appendChild(mirror);
      }

      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.wordWrap = "break-word";
      mirror.style.overflowWrap = "break-word";
      mirror.style.boxSizing = style.boxSizing;
      mirror.style.width = style.width;
      mirror.style.fontFamily = style.fontFamily;
      mirror.style.fontSize = style.fontSize;
      mirror.style.lineHeight = style.lineHeight;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.paddingLeft = style.paddingLeft;
      mirror.style.paddingRight = style.paddingRight;
      mirror.style.paddingTop = style.paddingTop;

      const textBeforeMatch = textarea.value.substring(0, start);
      mirror.textContent = textBeforeMatch;

      const matchSpan = document.createElement("span");
      matchSpan.textContent = "|";
      mirror.appendChild(matchSpan);

      const matchTopInTextarea = matchSpan.offsetTop;
      const targetScroll = Math.max(0, matchTopInTextarea - textarea.clientHeight / 3);
      textarea.scrollTop = targetScroll;
      textarea.dispatchEvent(new Event("scroll"));
    },
    [matchIndices, searchQuery.length, textareaRef]
  );

  useEffect(() => {
    if (isOpen && matchIndices.length > 0) {
      highlightMatch(currentMatchIndex);
    }
  }, [currentMatchIndex, highlightMatch, isOpen, matchIndices.length]);

  function handleNext() {
    if (matchIndices.length === 0) return;
    const nextIdx = (currentMatchIndex + 1) % matchIndices.length;
    setCurrentMatchIndex(nextIdx);
    highlightMatch(nextIdx);
  }

  function handlePrev() {
    if (matchIndices.length === 0) return;
    const prevIdx = (currentMatchIndex - 1 + matchIndices.length) % matchIndices.length;
    setCurrentMatchIndex(prevIdx);
    highlightMatch(prevIdx);
  }

  function handleReplace() {
    if (matchIndices.length === 0) return;
    const start = matchIndices[currentMatchIndex];
    if (start === undefined) return;
    const end = start + searchQuery.length;

    const newContent = content.substring(0, start) + replaceQuery + content.substring(end);
    const newCaretPos = start + replaceQuery.length;
    onContentChange(newContent);

    const textarea = textareaRef.current;
    if (textarea) {
      textarea.setSelectionRange(newCaretPos, newCaretPos);
    }
  }

  function handleReplaceAll() {
    if (matchIndices.length === 0 || !searchQuery) return;
    const flags = matchCase ? "g" : "gi";
    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const newContent = content.replace(regex, () => replaceQuery);
    onContentChange(newContent);

    const textarea = textareaRef.current;
    if (textarea) {
      const safePos = Math.min(textarea.selectionStart, newContent.length);
      textarea.setSelectionRange(safePos, safePos);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrev();
      } else {
        handleNext();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      handleNext();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      handlePrev();
    }
  }

  return (
    <>
      {transitions(
        (styles, item) =>
          item && (
            <animated.div
              ref={modalRef}
              style={{
                opacity: styles.opacity,
                transform: styles.transform,
                transformOrigin: "top right",
              }}
              onKeyDown={handleKeyDown}
              className={twMerge(
                "search-replace-modal no-print fixed top-4 right-4 z-[9999] p-3 rounded-xl shadow-2xl border backdrop-blur-lg flex flex-col gap-2 w-[340px] sm:w-[380px]",
                isDay
                  ? "bg-white/95 text-neutral-800 border-neutral-300 shadow-neutral-300/40"
                  : "bg-zinc-900/95 text-zinc-100 border-zinc-700/80 shadow-black/50"
              )}
            >
      <div
        className={twMerge(
          "flex items-center justify-between gap-2 border-b pb-2",
          isDay ? "border-neutral-200" : "border-zinc-800"
        )}
      >
        <span className="text-xs font-semibold uppercase tracking-wider opacity-70">
          Buscar y Reemplazar
        </span>
        <button
          type="button"
          onClick={onClose}
          className={twMerge(
            "p-1 rounded-lg transition-colors cursor-pointer",
            isDay
              ? "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          )}
          aria-label="Cerrar búsqueda"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Buscar..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className={twMerge(
            "flex-1 px-2.5 py-1.5 rounded-lg text-sm border outline-none transition-colors",
            isDay
              ? "bg-neutral-100 border-neutral-300 focus:border-indigo-500 text-neutral-900 placeholder:text-neutral-400"
              : "bg-zinc-800 border-zinc-700 focus:border-sky-400 text-zinc-100 placeholder:text-zinc-500"
          )}
        />
        <span className="text-xs font-mono opacity-70 min-w-[38px] text-center">
          {matchIndices.length > 0 ? `${currentMatchIndex + 1}/${matchIndices.length}` : "0/0"}
        </span>
        <button
          type="button"
          onClick={() => setMatchCase(prev => !prev)}
          className={twMerge(
            "p-1.5 rounded-lg border transition-colors cursor-pointer flex items-center justify-center",
            matchCase
              ? isDay
                ? "bg-indigo-50 text-indigo-600 border-indigo-300 font-bold"
                : "bg-sky-500/20 text-sky-300 border-sky-400/60 font-bold"
              : isDay
                ? "bg-white border-neutral-300 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100"
                : "bg-zinc-800/80 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
          )}
          title={matchCase ? "Coincidir mayúsculas y minúsculas: activado" : "Coincidir mayúsculas y minúsculas: desactivado"}
          aria-label="Coincidir mayúsculas y minúsculas"
        >
          <CaseSensitive size={15} strokeWidth={matchCase ? 2.5 : 2} />
        </button>
        <button
          type="button"
          onClick={handlePrev}
          disabled={matchIndices.length === 0}
          className={twMerge(
            "p-1.5 rounded-lg border disabled:opacity-30 transition-colors cursor-pointer",
            isDay
              ? "bg-white border-neutral-300 hover:bg-neutral-100 text-neutral-700"
              : "bg-zinc-800/80 border-zinc-700 hover:bg-zinc-700 text-zinc-200"
          )}
          title="Anterior (Shift+Enter)"
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={matchIndices.length === 0}
          className={twMerge(
            "p-1.5 rounded-lg border disabled:opacity-30 transition-colors cursor-pointer",
            isDay
              ? "bg-white border-neutral-300 hover:bg-neutral-100 text-neutral-700"
              : "bg-zinc-800/80 border-zinc-700 hover:bg-zinc-700 text-zinc-200"
          )}
          title="Siguiente (Enter)"
        >
          <ChevronDown size={15} />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          placeholder="Reemplazar con..."
          value={replaceQuery}
          onChange={e => setReplaceQuery(e.target.value)}
          className={twMerge(
            "flex-1 px-2.5 py-1.5 rounded-lg text-sm border outline-none transition-colors",
            isDay
              ? "bg-neutral-100 border-neutral-300 focus:border-indigo-500 text-neutral-900 placeholder:text-neutral-400"
              : "bg-zinc-800 border-zinc-700 focus:border-sky-400 text-zinc-100 placeholder:text-zinc-500"
          )}
        />
        <button
          type="button"
          onClick={handleReplace}
          disabled={matchIndices.length === 0}
          className={twMerge(
            "p-1.5 rounded-lg border disabled:opacity-30 transition-colors flex items-center gap-1 text-xs cursor-pointer",
            isDay
              ? "bg-white border-neutral-300 hover:bg-neutral-100 text-neutral-700"
              : "bg-zinc-800/80 border-zinc-700 hover:bg-zinc-700 text-zinc-200"
          )}
          title="Reemplazar"
        >
          <Replace size={14} />
        </button>
        <button
          type="button"
          onClick={handleReplaceAll}
          disabled={matchIndices.length === 0}
          className={twMerge(
            "p-1.5 rounded-lg border disabled:opacity-30 transition-colors flex items-center gap-1 text-xs cursor-pointer",
            isDay
              ? "bg-white border-neutral-300 hover:bg-neutral-100 text-neutral-700"
              : "bg-zinc-800/80 border-zinc-700 hover:bg-zinc-700 text-zinc-200"
          )}
          title="Reemplazar Todo"
        >
          <ReplaceAll size={14} />
        </button>
      </div>
        </animated.div>
      )
  )}
</>
);
}

export default SearchReplaceModal;
