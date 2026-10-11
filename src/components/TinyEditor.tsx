import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import { twMerge } from "tailwind-merge";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import SearchReplaceModal, { type SearchState } from "./SearchReplaceModal";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

interface TinyEditorProps {
  content: string;
  onContentChange: (content: string) => void;
  onWordCountChange: (count: number) => void;
}

const WORD_COUNT_DEBOUNCE_MS = 250;

function TinyEditor({
  content,
  onContentChange,
  onWordCountChange,
}: TinyEditorProps): Component {
  const textareaRef = useRef<HTMLTextAreaElement>(null),
    displayRef = useRef<HTMLDivElement>(null),
    mirrorRef = useRef<HTMLDivElement | null>(null),
    contentRef = useRef<string>(content),
    rafIdRef = useRef<number | null>(null),
    caretRafRef = useRef<number | null>(null),
    { isDay } = themes(),
    { myFontSize, myAlign, mySpacing, myParagraphFocus, myFontValue } = usePreferences(),
    [fontSizeOverride, setFontSizeOverride] = useState<string | null>(null),
    fontSize: string = fontSizeOverride ?? myFontSize(),
    fontClass: string = myFontValue(),
    textAlign: string = myAlign(),
    letterSpacing: number = mySpacing(),
    isParagraphFocus: boolean = myParagraphFocus(),
    [selectionStart, setSelectionStart] = useState<number>(0),
    [selectionEnd, setSelectionEnd] = useState<number>(0),
    [isSearchOpen, setIsSearchOpen] = useState<boolean>(false),
    [searchState, setSearchState] = useState<SearchState | null>(null);

  contentRef.current = content;

  useEffect(() => {
    return () => {
      if (wordTimerRef.current) {
        clearTimeout(wordTimerRef.current);
        wordTimerRef.current = null;
      }
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (caretRafRef.current !== null) {
        cancelAnimationFrame(caretRafRef.current);
        caretRafRef.current = null;
      }
      if (mirrorRef.current) {
        mirrorRef.current.remove();
        mirrorRef.current = null;
      }
      document.documentElement.classList.remove("is-typing");
      document.body.classList.remove("is-typing");
      if (textareaRef.current) {
        textareaRef.current.classList.remove("is-typing-editor");
      }
    };
  }, []);

  const paragraphs = useMemo(() => content.split("\n"), [content]);

  const paragraphStartIndices = useMemo(() => {
    const indices: number[] = [];
    let charCounter = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      indices.push(charCounter);
      charCounter += paragraphs[i].length + 1;
    }
    return indices;
  }, [paragraphs]);

  const renderParagraphContent = useCallback(
    (p: string, paraStartChar: number) => {
      if (!p) return "";
      if (!searchState || !searchState.query || searchState.matchIndices.length === 0) {
        return p;
      }

      const { query, matchIndices, currentIndex } = searchState;
      const queryLen = query.length;
      const paraEndChar = paraStartChar + p.length;

      const matchesInPara: { startInPara: number; endInPara: number; isActive: boolean }[] = [];

      for (let mIdx = 0; mIdx < matchIndices.length; mIdx++) {
        const matchStart = matchIndices[mIdx];
        const matchEnd = matchStart + queryLen;

        if (matchStart >= paraStartChar && matchStart < paraEndChar) {
          matchesInPara.push({
            startInPara: matchStart - paraStartChar,
            endInPara: Math.min(p.length, matchEnd - paraStartChar),
            isActive: mIdx === currentIndex,
          });
        }
      }

      if (matchesInPara.length === 0) return p;

      const elements: React.ReactNode[] = [];
      let lastIdx = 0;

      matchesInPara.forEach((m, idx) => {
        if (m.startInPara > lastIdx) {
          elements.push(p.substring(lastIdx, m.startInPara));
        }

        const matchText = p.substring(m.startInPara, m.endInPara);
        const activeClass = m.isActive
          ? isDay
            ? "bg-blue-500 text-white rounded-xs"
            : "bg-sky-400 text-slate-950 rounded-xs"
          : isDay
            ? "bg-blue-200/80 text-blue-950 rounded-xs"
            : "bg-sky-500/30 text-sky-200 rounded-xs";

        elements.push(
          <mark key={idx} className={`${activeClass} inline`}>
            {matchText}
          </mark>
        );

        lastIdx = m.endInPara;
      });

      if (lastIdx < p.length) {
        elements.push(p.substring(lastIdx));
      }

      return elements;
    },
    [isDay, searchState]
  );

  const { startIdx, endIdx } = useMemo(() => {
    let charCounter = 0;
    let sIdx = 0;
    let eIdx = 0;
    const selMin = Math.min(selectionStart, selectionEnd);
    const selMax = Math.max(selectionStart, selectionEnd);

    for (let i = 0; i < paragraphs.length; i++) {
      const len = paragraphs[i].length + 1;
      if (selMin >= charCounter && selMin < charCounter + len) {
        sIdx = i;
      }
      if (selMax >= charCounter && selMax < charCounter + len) {
        eIdx = i;
      }
      charCounter += len;
    }

    if (selMax >= content.length) {
      eIdx = Math.max(0, paragraphs.length - 1);
    }

    return { startIdx: sIdx, endIdx: eIdx };
  }, [content.length, paragraphs, selectionStart, selectionEnd]);

  const syncScrollPos = useCallback(() => {
    const textarea = textareaRef.current;
    const display = displayRef.current;
    if (!textarea || !display) return;
    if (textarea.scrollLeft !== 0) {
      textarea.scrollLeft = 0;
    }
    display.style.transform = `translate3d(0, ${-textarea.scrollTop}px, 0)`;
  }, []);

  const updateCaretState = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setSelectionStart(textarea.selectionStart);
    setSelectionEnd(textarea.selectionEnd);
    syncScrollPos();
  }, [syncScrollPos]);

  const keepCaretCentered = useCallback(() => {
    if (caretRafRef.current !== null) {
      cancelAnimationFrame(caretRafRef.current);
    }

    caretRafRef.current = requestAnimationFrame(() => {
      caretRafRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;

      const position = textarea.selectionStart;
      const style = window.getComputedStyle(textarea);

      let mirror = mirrorRef.current;
      if (!mirror) {
        mirror = document.createElement("div");
        mirror.style.position = "absolute";
        mirror.style.top = "-9999px";
        mirror.style.left = "-9999px";
        mirror.style.visibility = "hidden";
        mirror.style.pointerEvents = "none";
        document.body.appendChild(mirror);
        mirrorRef.current = mirror;
      }

      mirror.style.whiteSpace = "pre-wrap";
      mirror.style.wordBreak = "break-word";
      mirror.style.overflowWrap = "break-word";
      mirror.style.fontVariantLigatures = "none";
      mirror.style.fontFeatureSettings = '"liga" 0, "clig" 0, "calt" 0';
      mirror.style.boxSizing = style.boxSizing;
      mirror.style.width = style.width;
      mirror.style.fontFamily = style.fontFamily;
      mirror.style.fontSize = style.fontSize;
      mirror.style.lineHeight = style.lineHeight;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.paddingLeft = style.paddingLeft;
      mirror.style.paddingRight = style.paddingRight;
      mirror.style.paddingTop = style.paddingTop;

      const textBeforeCaret = textarea.value.substring(0, position);
      mirror.textContent = textBeforeCaret;

      const caretSpan = document.createElement("span");
      caretSpan.textContent = "|";
      mirror.appendChild(caretSpan);

      const caretTopInTextarea = caretSpan.offsetTop;
      const caretViewportY = caretTopInTextarea - textarea.scrollTop;
      const minViewportY = 70;
      const maxViewportY = textarea.clientHeight * 0.65;

      if (caretViewportY > maxViewportY) {
        textarea.scrollTop = caretTopInTextarea - maxViewportY;
      } else if (caretViewportY < minViewportY) {
        textarea.scrollTop = Math.max(0, caretTopInTextarea - minViewportY);
      }

      syncScrollPos();
    });
  }, [syncScrollPos]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (displayRef.current) {
        displayRef.current.style.transform = `translate3d(0, ${-el.scrollTop}px, 0)`;
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });
    handleScroll();

    return () => {
      el.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, []);

  const handleInteraction = useCallback(() => {
    updateCaretState();
    if (!isTypingWordRef.current && textareaRef.current) {
      lastSnapshotRef.current.caretPos = textareaRef.current.selectionStart;
      lastSnapshotRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [updateCaretState]);

  const markTyping = useCallback(() => {
    (window as any).__lastTypingTime = Date.now();
    document.documentElement.classList.add("is-typing");
    document.body.classList.add("is-typing");
    if (textareaRef.current && !textareaRef.current.classList.contains("is-typing-editor")) {
      textareaRef.current.classList.add("is-typing-editor");
    }
  }, []);

  const handleKeyDown = useCallback(() => {
    markTyping();
  }, [markTyping]);

  const handleKeyUp = useCallback(() => {
    updateCaretState();
    keepCaretCentered();
  }, [updateCaretState, keepCaretCentered]);

  const { setItem } = useStorage();

  interface HistorySnapshot {
    content: string;
    caretPos: number;
    scrollTop: number;
  }

  const undoStackRef = useRef<HistorySnapshot[]>([]);
  const redoStackRef = useRef<HistorySnapshot[]>([]);
  const lastSnapshotRef = useRef<HistorySnapshot>({
    content,
    caretPos: 0,
    scrollTop: 0,
  });
  const isTypingWordRef = useRef<boolean>(false);
  const wordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleUndo = useCallback(() => {
    if (wordTimerRef.current) {
      clearTimeout(wordTimerRef.current);
      wordTimerRef.current = null;
    }

    if (undoStackRef.current.length === 0) return;

    const currentContent = contentRef.current;
    const textarea = textareaRef.current;
    const currentCaret = textarea ? textarea.selectionStart : currentContent.length;
    const currentScrollTop = textarea ? textarea.scrollTop : 0;

    redoStackRef.current.push({
      content: currentContent,
      caretPos: currentCaret,
      scrollTop: currentScrollTop,
    });
    if (redoStackRef.current.length > 100) {
      redoStackRef.current.shift();
    }

    const targetSnapshot = undoStackRef.current.pop()!;
    lastSnapshotRef.current = targetSnapshot;
    isTypingWordRef.current = false;

    onContentChange(targetSnapshot.content);

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = textareaRef.current;
      if (!el) return;
      const targetCaret = Math.min(targetSnapshot.caretPos, targetSnapshot.content.length);
      el.setSelectionRange(targetCaret, targetCaret);
      if (targetSnapshot.scrollTop > 0) {
        el.scrollTop = targetSnapshot.scrollTop;
      }
      syncScrollPos();
      keepCaretCentered();
      setSelectionStart(targetCaret);
      setSelectionEnd(targetCaret);
    });
  }, [onContentChange, syncScrollPos, keepCaretCentered]);

  const handleRedo = useCallback(() => {
    if (wordTimerRef.current) {
      clearTimeout(wordTimerRef.current);
      wordTimerRef.current = null;
    }

    if (redoStackRef.current.length === 0) return;

    const currentContent = contentRef.current;
    const textarea = textareaRef.current;
    const currentCaret = textarea ? textarea.selectionStart : currentContent.length;
    const currentScrollTop = textarea ? textarea.scrollTop : 0;

    undoStackRef.current.push({
      content: currentContent,
      caretPos: currentCaret,
      scrollTop: currentScrollTop,
    });
    if (undoStackRef.current.length > 100) {
      undoStackRef.current.shift();
    }

    const targetSnapshot = redoStackRef.current.pop()!;
    lastSnapshotRef.current = targetSnapshot;
    isTypingWordRef.current = false;

    onContentChange(targetSnapshot.content);

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = textareaRef.current;
      if (!el) return;
      const targetCaret = Math.min(targetSnapshot.caretPos, targetSnapshot.content.length);
      el.setSelectionRange(targetCaret, targetCaret);
      if (targetSnapshot.scrollTop > 0) {
        el.scrollTop = targetSnapshot.scrollTop;
      }
      syncScrollPos();
      keepCaretCentered();
      setSelectionStart(targetCaret);
      setSelectionEnd(targetCaret);
    });
  }, [onContentChange, syncScrollPos, keepCaretCentered]);

  useEffect(() => {
    const handleShortcutsKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          (target.tagName === "TEXTAREA" && target !== textareaRef.current))
      ) {
        return;
      }

      const isCmdOrCtrl = e.ctrlKey || e.metaKey;
      if (!isCmdOrCtrl) return;

      if (e.key === "z" || e.key === "Z") {
        if (e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else {
          e.preventDefault();
          handleUndo();
        }
        return;
      }

      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
        return;
      }

      const isZoomIn = e.key === "+" || e.key === "=" || e.code === "Equal" || e.code === "NumpadAdd";
      const isZoomOut = e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract";

      if (isZoomIn) {
        e.preventDefault();
        const currentSizeNum = parseInt(fontSize, 10) || 18;
        const newSize = `${Math.min(48, currentSizeNum + 2)}px`;
        setFontSizeOverride(newSize);
        setItem("font-size", newSize);
      } else if (isZoomOut) {
        e.preventDefault();
        const currentSizeNum = parseInt(fontSize, 10) || 18;
        const newSize = `${Math.max(12, currentSizeNum - 2)}px`;
        setFontSizeOverride(newSize);
        setItem("font-size", newSize);
      }
    };

    window.addEventListener("keydown", handleShortcutsKeyDown);
    return () => {
      window.removeEventListener("keydown", handleShortcutsKeyDown);
    };
  }, [fontSize, setItem, handleUndo, handleRedo]);

  useEffect(() => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (!textareaRef.current) {
        onWordCountChange(0);
        return;
      }

      const normalizedText: string = textareaRef.current.value.trim();
      if (normalizedText.length === 0) {
        onWordCountChange(0);
        return;
      }

      const words: string[] = normalizedText.split(/\s+/);
      onWordCountChange(words.length);
    }, WORD_COUNT_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [content, onWordCountChange]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>): void => {
      const newVal = e.target.value;
      const textarea = e.target;
      const caretPos = textarea.selectionStart || 0;
      const scrollTop = textarea.scrollTop || 0;
      const oldVal = content;

      if (newVal === oldVal) return;

      const lenDiff = Math.abs(newVal.length - oldVal.length);
      const isBulkEdit = lenDiff > 2;
      const lastCharTyped =
        newVal.length > oldVal.length && caretPos > 0
          ? newVal[caretPos - 1]
          : "";
      const isSpaceOrNewline =
        lastCharTyped === " " ||
        lastCharTyped === "\n" ||
        lastCharTyped === "\t";

      if (isBulkEdit) {
        if (wordTimerRef.current) {
          clearTimeout(wordTimerRef.current);
          wordTimerRef.current = null;
        }
        undoStackRef.current.push(lastSnapshotRef.current);
        if (undoStackRef.current.length > 100) undoStackRef.current.shift();
        redoStackRef.current = [];
        lastSnapshotRef.current = { content: newVal, caretPos, scrollTop };
        isTypingWordRef.current = false;
      } else if (isSpaceOrNewline) {
        if (wordTimerRef.current) {
          clearTimeout(wordTimerRef.current);
          wordTimerRef.current = null;
        }
        lastSnapshotRef.current = { content: newVal, caretPos, scrollTop };
        redoStackRef.current = [];
        isTypingWordRef.current = false;
      } else {
        if (!isTypingWordRef.current) {
          undoStackRef.current.push(lastSnapshotRef.current);
          if (undoStackRef.current.length > 100) undoStackRef.current.shift();
          isTypingWordRef.current = true;
        }

        redoStackRef.current = [];

        if (wordTimerRef.current) {
          clearTimeout(wordTimerRef.current);
        }

        wordTimerRef.current = setTimeout(() => {
          isTypingWordRef.current = false;
          lastSnapshotRef.current = { content: newVal, caretPos, scrollTop };
          wordTimerRef.current = null;
        }, 800);
      }

      onContentChange(newVal);
      markTyping();
      updateCaretState();
      keepCaretCentered();
    },
    [content, onContentChange, updateCaretState, keepCaretCentered]
  );

  const isSearchActive = searchState !== null && searchState.query.trim().length > 0;
  const needsDisplayLayer = isParagraphFocus || isSearchActive;

  return (
    <div className={twMerge("relative w-full h-screen overflow-hidden", fontClass)}>
      <style>{`
        .editor-display-layer {
          overflow-y: scroll !important;
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        .editor-display-layer::-webkit-scrollbar {
          width: 8px !important;
          display: block !important;
          background: transparent !important;
        }
        .editor-display-layer::-webkit-scrollbar-thumb {
          background: transparent !important;
        }

        .editor-textarea {
          overflow-y: scroll !important;
          scrollbar-width: thin !important;
          scrollbar-color: rgba(156, 163, 175, 0.5) transparent;
          -webkit-appearance: none !important;
          appearance: none !important;
          caret-color: #00a8ff !important;
        }
        .editor-textarea::-webkit-scrollbar {
          width: 8px !important;
          display: block !important;
          background: transparent !important;
        }
        .editor-textarea::-webkit-scrollbar-track {
          background: transparent !important;
        }
        .editor-textarea::-webkit-scrollbar-thumb {
          background-color: ${isDay ? "rgba(156, 163, 175, 0.5)" : "rgba(113, 113, 122, 0.45)"} !important;
          border-radius: 9999px !important;
          transition: background-color 300ms ease-in-out !important;
        }
        .editor-textarea::-webkit-scrollbar-thumb:hover {
          background-color: ${isDay ? "rgba(107, 114, 128, 0.8)" : "rgba(161, 161, 170, 0.7)"} !important;
        }

        .editor-textarea.is-typing-editor,
        body.is-typing .editor-textarea,
        html.is-typing .editor-textarea {
          scrollbar-color: transparent transparent !important;
        }
        .editor-textarea.is-typing-editor::-webkit-scrollbar-thumb,
        body.is-typing .editor-textarea::-webkit-scrollbar-thumb,
        html.is-typing .editor-textarea::-webkit-scrollbar-thumb {
          background-color: transparent !important;
        }

        .editor-textarea::selection {
          background: ${isDay ? "rgba(59, 130, 246, 0.3)" : "rgba(56, 189, 248, 0.3)"} !important;
          color: transparent !important;
          -webkit-text-fill-color: transparent !important;
        }
        .editor-textarea::-moz-selection {
          background: ${isDay ? "rgba(59, 130, 246, 0.3)" : "rgba(56, 189, 248, 0.3)"} !important;
          color: transparent !important;
          -webkit-text-fill-color: transparent !important;
        }
      `}</style>

      <SearchReplaceModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        content={content}
        onContentChange={onContentChange}
        textareaRef={textareaRef}
        onSearchStateChange={setSearchState}
      />

      {/* Capa de fondo para el modo foco por párrafo o búsqueda */}
      <div
        ref={displayRef}
        aria-hidden="true"
        className={twMerge(
          "editor-display-layer pointer-events-none absolute left-0 right-0 top-0 z-0 no-print select-none",
          fontClass
        )}
        style={{
          boxSizing: "border-box",
          fontSize,
          textAlign: textAlign as CSSProperties["textAlign"],
          letterSpacing: letterSpacing === 0 ? "normal" : `${letterSpacing}px`,
          color: isDay ? "#1f2937" : "#e5e7eb",
          paddingTop: "70px",
          paddingBottom: "70px",
          paddingLeft: "clamp(1.5rem, calc(50% - 374px), 50%)",
          paddingRight: "clamp(1.5rem, calc(50% - 374px), 50%)",
          width: "100%",
          maxWidth: "100%",
          margin: "0",
          fontFamily: "inherit",
          lineHeight: 1.9,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "break-word",
          willChange: "transform",
          opacity: needsDisplayLayer ? 1 : 0,
          visibility: needsDisplayLayer ? "visible" : "hidden",
        }}
      >
        {paragraphs.map((p, i) => {
          const isActive = isSearchActive ? true : (isParagraphFocus ? (i >= startIdx && i <= endIdx) : true);
          const renderedContent = renderParagraphContent(p, paragraphStartIndices[i] || 0);
          return (
            <div
              key={i}
              style={{
                opacity: isActive ? 1 : 0.6,
                minHeight: "1.9em",
              }}
            >
              {p.length === 0 ? <br /> : renderedContent}
            </div>
          );
        })}
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onInput={markTyping}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleInteraction}
        onSelect={handleInteraction}
        onFocus={handleInteraction}
        onScroll={syncScrollPos}
        placeholder="..."
        spellCheck
        className={twMerge(
          "editor-textarea block h-screen w-full resize-none bg-transparent focus:outline-none overflow-x-hidden overflow-y-scroll relative z-10",
          fontClass
        )}
        style={{
          boxSizing: "border-box",
          height: "100vh",
          maxHeight: "100vh",
          fontSize,
          textAlign: textAlign as CSSProperties["textAlign"],
          letterSpacing: letterSpacing === 0 ? "normal" : `${letterSpacing}px`,
          backgroundColor: "transparent",
          color: needsDisplayLayer ? "transparent" : (isDay ? "#1f2937" : "#e5e7eb"),
          WebkitTextFillColor: needsDisplayLayer ? "transparent" : (isDay ? "#1f2937" : "#e5e7eb"),
          caretColor: "#00a8ff",
          paddingTop: "70px",
          paddingBottom: "70px",
          paddingLeft: "clamp(1.5rem, calc(50% - 374px), 50%)",
          paddingRight: "clamp(1.5rem, calc(50% - 374px), 50%)",
          width: "100%",
          maxWidth: "100%",
          margin: "0",
          fontFamily: "inherit",
          outline: "none",
          border: "none",
          lineHeight: 1.9,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "break-word",
          overflowX: "hidden",
          overflowY: "scroll",
        }}
      />
    </div>
  );
}

export default TinyEditor;
