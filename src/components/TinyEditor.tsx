import { useRef, useEffect, useCallback, useState, useMemo, memo } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import { twMerge } from "tailwind-merge";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import SearchReplaceModal, { type SearchState } from "./SearchReplaceModal";
// Descomentar para activar el HUD de debug en pantalla:
// import EditorDebugHUD from "./EditorDebugHUD";
import { editorDebug } from "../utils/editorDebug";
import { themes } from "../utils/helpers";
import type { Component } from "../utils/types";

interface TinyEditorProps {
  content: string;
  onContentChange: (content: string) => void;
}

function getParagraphRange(
  text: string,
  selStart: number,
  selEnd: number
): { startIdx: number; endIdx: number } {
  if (!text) return { startIdx: 0, endIdx: 0 };

  const selMin = Math.min(selStart, selEnd);
  const selMax = Math.max(selStart, selEnd);
  const selEndChar = selMax > selMin ? selMax - 1 : selMin;

  let sIdx = 0;
  let eIdx = 0;
  let charCounter = 0;

  const paras = text.split("\n");
  const lastParaIdx = paras.length - 1;

  for (let i = 0; i < paras.length; i++) {
    const isLast = i === lastParaIdx;
    const paraLen = paras[i].length;
    const lenWithNewline = isLast ? paraLen : paraLen + 1;

    if (
      selMin >= charCounter &&
      (isLast ? selMin <= charCounter + paraLen : selMin < charCounter + lenWithNewline)
    ) {
      sIdx = i;
    }
    if (
      selEndChar >= charCounter &&
      (isLast ? selEndChar <= charCounter + paraLen : selEndChar < charCounter + lenWithNewline)
    ) {
      eIdx = i;
    }

    charCounter += lenWithNewline;
  }

  return {
    startIdx: Math.max(0, Math.min(sIdx, lastParaIdx)),
    endIdx: Math.max(0, Math.min(eIdx, lastParaIdx)),
  };
}

function TinyEditor({
  content,
  onContentChange,
}: TinyEditorProps): Component {
  const textareaRef = useRef<HTMLTextAreaElement>(null),
    displayRef = useRef<HTMLDivElement>(null),
    mirrorRef = useRef<HTMLDivElement | null>(null),
    contentRef = useRef<string>(content),
    rafIdRef = useRef<number | null>(null),
    caretRafRef = useRef<number | null>(null),
    scrollThumbRef = useRef<HTMLDivElement | null>(null),
    scrollTrackRef = useRef<HTMLDivElement | null>(null),
    targetScrollTopRef = useRef<number>(0),
    smoothScrollRafRef = useRef<number | null>(null),
    isDraggingThumbRef = useRef<boolean>(false),
    dragStartYRef = useRef<number>(0),
    dragStartScrollTopRef = useRef<number>(0),
    { isDay } = themes(),
    { myFontSize, myAlign, mySpacing, myParagraphFocus, myFontValue } = usePreferences(),
    [fontSizeOverride, setFontSizeOverride] = useState<string | null>(null),
    fontSize: string = fontSizeOverride ?? myFontSize(),
    fontClass: string = myFontValue(),
    textAlign: string = myAlign(),
    letterSpacing: number = mySpacing(),
    isParagraphFocus: boolean = myParagraphFocus(),
    [{ startIdx, endIdx }, setActiveParaRange] = useState<{
      startIdx: number;
      endIdx: number;
    }>({ startIdx: 0, endIdx: 0 }),
    [isSearchOpen, setIsSearchOpen] = useState<boolean>(false),
    [searchState, setSearchState] = useState<SearchState | null>(null);

  contentRef.current = content;

  const stopSmoothScroll = useCallback(() => {
    if (smoothScrollRafRef.current !== null) {
      cancelAnimationFrame(smoothScrollRafRef.current);
      smoothScrollRafRef.current = null;
    }
  }, []);

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
      if (smoothScrollRafRef.current !== null) {
        cancelAnimationFrame(smoothScrollRafRef.current);
        smoothScrollRafRef.current = null;
      }
      if (mirrorRef.current) {
        mirrorRef.current.remove();
        mirrorRef.current = null;
      }
      document.body.classList.remove("is-typing");
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

  const updateScrollThumb = useCallback(() => {
    const textarea = textareaRef.current;
    const thumb = scrollThumbRef.current;
    if (!textarea || !thumb) return;

    const clientH = textarea.clientHeight;
    const scrollH = textarea.scrollHeight;

    if (scrollH <= clientH + 2) {
      thumb.style.opacity = "0";
      thumb.style.pointerEvents = "none";
      return;
    }

    thumb.style.opacity = "";
    thumb.style.pointerEvents = "auto";
    const rawHeight = (clientH / scrollH) * clientH;
    const thumbHeight = Math.max(36, Math.min(clientH - 20, rawHeight));
    const maxScroll = scrollH - clientH;
    const ratio = maxScroll > 0 ? textarea.scrollTop / maxScroll : 0;
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const maxThumbTop = clientH - thumbHeight - 8;
    const thumbTop = 4 + clampedRatio * maxThumbTop;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translate3d(0, ${thumbTop}px, 0)`;
  }, []);

  const syncScrollPos = useCallback(() => {
    const textarea = textareaRef.current;
    const display = displayRef.current;
    if (!textarea || !display) return;
    if (textarea.scrollLeft !== 0) {
      textarea.scrollLeft = 0;
    }
    if (display.scrollTop !== textarea.scrollTop) {
      display.scrollTop = textarea.scrollTop;
    }
    updateScrollThumb();
  }, [updateScrollThumb]);

  useEffect(() => {
    updateScrollThumb();
    window.addEventListener("resize", updateScrollThumb);
    return () => window.removeEventListener("resize", updateScrollThumb);
  }, [updateScrollThumb, content]);

  const handleThumbPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    stopSmoothScroll();
    const textarea = textareaRef.current;
    if (!textarea) return;

    isDraggingThumbRef.current = true;
    dragStartYRef.current = e.clientY;
    dragStartScrollTopRef.current = textarea.scrollTop;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handleThumbPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingThumbRef.current) return;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const clientH = textarea.clientHeight;
    const scrollH = textarea.scrollHeight;
    const maxScroll = scrollH - clientH;
    if (maxScroll <= 0) return;

    const rawHeight = (clientH / scrollH) * clientH;
    const thumbHeight = Math.max(36, Math.min(clientH - 20, rawHeight));
    const maxThumbTop = clientH - thumbHeight - 8;
    if (maxThumbTop <= 0) return;

    const deltaY = e.clientY - dragStartYRef.current;
    const scrollDelta = deltaY * (maxScroll / maxThumbTop);
    textarea.scrollTop = Math.max(0, Math.min(maxScroll, dragStartScrollTopRef.current + scrollDelta));
    syncScrollPos();
  }, [syncScrollPos]);

  const handleThumbPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingThumbRef.current) {
      isDraggingThumbRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  }, []);

  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === scrollThumbRef.current) return;
    stopSmoothScroll();
    const textarea = textareaRef.current;
    const track = scrollTrackRef.current;
    if (!textarea || !track) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const clientH = textarea.clientHeight;
    const scrollH = textarea.scrollHeight;
    const maxScroll = scrollH - clientH;
    if (maxScroll <= 0) return;

    const rawHeight = (clientH / scrollH) * clientH;
    const thumbHeight = Math.max(36, Math.min(clientH - 20, rawHeight));
    const targetTop = clickY - thumbHeight / 2;
    const maxThumbTop = clientH - thumbHeight - 8;
    const ratio = Math.max(0, Math.min(1, targetTop / maxThumbTop));

    textarea.scrollTop = ratio * maxScroll;
    syncScrollPos();
  }, [syncScrollPos]);

  const updateCaretState = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const nextRange = getParagraphRange(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    );
    editorDebug.log("STATE", "updateCaretState", {
      selStart: textarea.selectionStart,
      selEnd: textarea.selectionEnd,
      nextRange,
    });
    setActiveParaRange((prev) =>
      prev.startIdx === nextRange.startIdx && prev.endIdx === nextRange.endIdx
        ? prev
        : nextRange
    );
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

      const position =
        textarea.selectionDirection === "backward"
          ? textarea.selectionStart
          : textarea.selectionEnd;
      const style = window.getComputedStyle(textarea);
      const lineHeight =
        parseFloat(style.lineHeight) ||
        parseFloat(style.fontSize) * 1.9;

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
      mirror.style.boxSizing = "border-box";
      // Use clientWidth so the mirror matches the textarea's actual content
      // area (excluding the scrollbar gutter) and wraps text identically.
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.fontFamily = style.fontFamily;
      mirror.style.fontSize = style.fontSize;
      mirror.style.lineHeight = style.lineHeight;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.textAlign = style.textAlign;
      mirror.style.paddingLeft = style.paddingLeft;
      mirror.style.paddingRight = style.paddingRight;
      mirror.style.paddingTop = style.paddingTop;

      const textBeforeCaret = textarea.value.substring(0, position);
      mirror.textContent = textBeforeCaret;

      const caretSpan = document.createElement("span");
      caretSpan.textContent = "|";
      mirror.appendChild(caretSpan);

      const caretTopInTextarea = caretSpan.offsetTop;
      const targetCenterY = (textarea.clientHeight - lineHeight) / 2;
      const targetScrollTop = Math.max(
        0,
        Math.round(caretTopInTextarea - targetCenterY)
      );

      if (Math.abs(textarea.scrollTop - targetScrollTop) > 1) {
        stopSmoothScroll();
        targetScrollTopRef.current = targetScrollTop;
        textarea.scrollTop = targetScrollTop;
      }

      syncScrollPos();
    });
  }, [syncScrollPos, stopSmoothScroll]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (displayRef.current && displayRef.current.scrollTop !== el.scrollTop) {
        displayRef.current.scrollTop = el.scrollTop;
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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    targetScrollTopRef.current = el.scrollTop;

    const handleWheel = (e: WheelEvent) => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 0) return;

      let delta = e.deltaY;
      if (e.deltaMode === 1) {
        delta *= 65; // Modo líneas: ~2 líneas de texto por muesca
      } else if (e.deltaMode === 2) {
        delta *= el.clientHeight * 0.8;
      } else {
        delta *= 2.0; // Modo píxeles: ritmo ágil y estándar de navegación
      }

      // Si ya está en los topes y se gira en esa dirección, permitir comportamiento nativo
      if ((el.scrollTop <= 0 && delta < 0) || (el.scrollTop >= maxScroll && delta > 0)) {
        return;
      }

      e.preventDefault();

      // Sincronizar si hubo saltos externos
      if (Math.abs(targetScrollTopRef.current - el.scrollTop) > 80) {
        targetScrollTopRef.current = el.scrollTop;
      }

      targetScrollTopRef.current = Math.max(0, Math.min(maxScroll, targetScrollTopRef.current + delta));

      if (smoothScrollRafRef.current === null) {
        const step = () => {
          const textarea = textareaRef.current;
          if (!textarea) {
            smoothScrollRafRef.current = null;
            return;
          }

          const diff = targetScrollTopRef.current - textarea.scrollTop;

          if (Math.abs(diff) < 0.5) {
            textarea.scrollTop = targetScrollTopRef.current;
            syncScrollPos();
            smoothScrollRafRef.current = null;
            return;
          }

          // Interpolación suave y más ágil (lerp factor 0.22)
          textarea.scrollTop += diff * 0.22;
          syncScrollPos();

          smoothScrollRafRef.current = requestAnimationFrame(step);
        };

        smoothScrollRafRef.current = requestAnimationFrame(step);
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", handleWheel);
      if (smoothScrollRafRef.current !== null) {
        cancelAnimationFrame(smoothScrollRafRef.current);
        smoothScrollRafRef.current = null;
      }
    };
  }, [syncScrollPos]);

  useEffect(() => {
    const display = displayRef.current;
    if (!display) return;

    const onTransRun = (e: TransitionEvent) => {
      editorDebug.log("TRANSITION", `run: ${(e.target as HTMLElement)?.className?.slice(0, 25)}`, {
        prop: e.propertyName,
        elapsed: e.elapsedTime,
      });
    };
    const onTransStart = (e: TransitionEvent) => {
      editorDebug.log("TRANSITION", `start: ${(e.target as HTMLElement)?.className?.slice(0, 25)}`, {
        prop: e.propertyName,
      });
    };
    const onTransCancel = (e: TransitionEvent) => {
      editorDebug.log("TRANSITION", `CANCEL: ${(e.target as HTMLElement)?.className?.slice(0, 25)}`, {
        prop: e.propertyName,
        elapsed: e.elapsedTime,
      });
    };
    const onTransEnd = (e: TransitionEvent) => {
      editorDebug.log("TRANSITION", `end: ${(e.target as HTMLElement)?.className?.slice(0, 25)}`, {
        prop: e.propertyName,
      });
    };

    display.addEventListener("transitionrun", onTransRun);
    display.addEventListener("transitionstart", onTransStart);
    display.addEventListener("transitioncancel", onTransCancel);
    display.addEventListener("transitionend", onTransEnd);

    return () => {
      display.removeEventListener("transitionrun", onTransRun);
      display.removeEventListener("transitionstart", onTransStart);
      display.removeEventListener("transitioncancel", onTransCancel);
      display.removeEventListener("transitionend", onTransEnd);
    };
  }, []);

  const handleInteraction = useCallback(() => {
    updateCaretState();
    if (!isTypingWordRef.current && textareaRef.current) {
      lastSnapshotRef.current.caretPos = textareaRef.current.selectionStart;
      lastSnapshotRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, [updateCaretState]);

  const handleInteractionWithDebug = useCallback(
    (e: React.SyntheticEvent) => {
      editorDebug.log("EVENT", e.type, {
        selStart: textareaRef.current?.selectionStart,
        selEnd: textareaRef.current?.selectionEnd,
      });
      handleInteraction();
    },
    [handleInteraction]
  );

  const markTyping = useCallback(() => {
    (window as any).__lastTypingTime = Date.now();
    if (!document.body.classList.contains("is-typing")) {
      document.body.classList.add("is-typing");
    }
  }, []);

  const handleKeyDown = useCallback(() => {
    markTyping();
  }, [markTyping]);

  const handleKeyUp = useCallback(() => {
    markTyping();
    updateCaretState();
    keepCaretCentered();
  }, [markTyping, updateCaretState, keepCaretCentered]);

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
        stopSmoothScroll();
        targetScrollTopRef.current = targetSnapshot.scrollTop;
        el.scrollTop = targetSnapshot.scrollTop;
      }
      syncScrollPos();
      keepCaretCentered();
      setActiveParaRange(getParagraphRange(targetSnapshot.content, targetCaret, targetCaret));
    });
  }, [onContentChange, syncScrollPos, keepCaretCentered, stopSmoothScroll]);

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
        stopSmoothScroll();
        targetScrollTopRef.current = targetSnapshot.scrollTop;
        el.scrollTop = targetSnapshot.scrollTop;
      }
      syncScrollPos();
      keepCaretCentered();
      setActiveParaRange(getParagraphRange(targetSnapshot.content, targetCaret, targetCaret));
    });
  }, [onContentChange, syncScrollPos, keepCaretCentered, stopSmoothScroll]);

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

  const editorStyles = useMemo(
    () => `
      .editor-display-layer,
      .editor-textarea,
      .editor-para {
        -webkit-font-smoothing: antialiased !important;
        -moz-osx-font-smoothing: grayscale !important;
      }

      .editor-display-layer,
      .editor-textarea {
        overflow-y: scroll !important;
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      .editor-display-layer::-webkit-scrollbar,
      .editor-textarea::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
        background: transparent !important;
      }
      .editor-display-layer::-webkit-scrollbar-track,
      .editor-textarea::-webkit-scrollbar-track {
        background: transparent !important;
        border: none !important;
      }
      .editor-display-layer::-webkit-scrollbar-thumb,
      .editor-textarea::-webkit-scrollbar-thumb {
        background-color: transparent !important;
        border: none !important;
      }

      .editor-para {
        transition: color 220ms ease-out;
      }
      .editor-para-active {
        color: ${isDay ? "rgba(31, 41, 55, 1) !important" : "rgba(229, 231, 235, 1) !important"};
      }
      .editor-para-inactive {
        color: ${isDay ? "rgba(31, 41, 55, 0.28) !important" : "rgba(229, 231, 235, 0.28) !important"};
      }

      .editor-textarea {
        -webkit-appearance: none !important;
        appearance: none !important;
        caret-color: #00a8ff !important;
        color: ${needsDisplayLayer ? "transparent !important" : isDay ? "#1f2937 !important" : "#e5e7eb !important"};
        -webkit-text-fill-color: ${needsDisplayLayer ? "transparent !important" : isDay ? "#1f2937 !important" : "#e5e7eb !important"};
      }

      .editor-textarea::selection {
        background: ${isDay ? "rgba(59, 130, 246, 0.3)" : "rgba(56, 189, 248, 0.3)"} !important;
        color: ${needsDisplayLayer ? "transparent" : isDay ? "#1f2937" : "#e5e7eb"} !important;
        -webkit-text-fill-color: ${needsDisplayLayer ? "transparent" : isDay ? "#1f2937" : "#e5e7eb"} !important;
      }
      .editor-textarea::-moz-selection {
        background: ${isDay ? "rgba(59, 130, 246, 0.3)" : "rgba(56, 189, 248, 0.3)"} !important;
        color: ${needsDisplayLayer ? "transparent" : isDay ? "#1f2937" : "#e5e7eb"} !important;
        -webkit-text-fill-color: ${needsDisplayLayer ? "transparent" : isDay ? "#1f2937" : "#e5e7eb"} !important;
      }
    `,
    [isDay, needsDisplayLayer]
  );

  const effectiveStart = Math.min(startIdx, Math.max(0, paragraphs.length - 1));
  const effectiveEnd = Math.min(endIdx, Math.max(0, paragraphs.length - 1));

  return (
    <div className={twMerge("relative w-full h-screen overflow-hidden", fontClass)}>
      <style>{editorStyles}</style>

      <SearchReplaceModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        content={content}
        onContentChange={onContentChange}
        textareaRef={textareaRef}
        onSearchStateChange={setSearchState}
      />

      {/* Capa de fondo para el modo foco por párrafo o búsqueda (Réplica continua 1:1) */}
      <div
        ref={displayRef}
        aria-hidden="true"
        className={twMerge(
          "editor-display-layer pointer-events-none absolute left-0 right-0 top-0 z-0 no-print select-none",
          fontClass
        )}
        style={{
          boxSizing: "border-box",
          height: "100vh",
          maxHeight: "100vh",
          fontSize,
          textAlign: textAlign as CSSProperties["textAlign"],
          letterSpacing: letterSpacing === 0 ? "normal" : `${letterSpacing}px`,
          paddingTop: "70px",
          paddingBottom: "50vh",
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
          overflowX: "hidden",
          overflowY: "scroll",
          fontVariantLigatures: "none",
          fontFeatureSettings: '"liga" 0, "clig" 0, "calt" 0',
          opacity: needsDisplayLayer ? 1 : 0,
          visibility: needsDisplayLayer ? "visible" : "hidden",
        }}
      >
        {paragraphs.map((p, i) => {
          const isActive = isSearchActive
            ? true
            : isParagraphFocus
            ? i >= effectiveStart && i <= effectiveEnd
            : true;
          const renderedContent = renderParagraphContent(p, paragraphStartIndices[i] || 0);
          const isLast = i === paragraphs.length - 1;

          // Si el párrafo está vacío o termina en espacios, usamos \u200B (espacio de ancho cero)
          // para garantizar que WebKit nunca colapse la altura de la línea (line-height)
          const safeContent =
            p.length === 0
              ? "\u200B"
              : p.endsWith(" ")
              ? (
                  <>
                    {renderedContent}
                    {"\u200B"}
                  </>
                )
              : renderedContent;

          const activeColor = isDay ? "rgba(31, 41, 55, 1)" : "rgba(229, 231, 235, 1)";
          const inactiveColor = isDay ? "rgba(31, 41, 55, 0.28)" : "rgba(229, 231, 235, 0.28)";

          return (
            <span
              key={i}
              className={`editor-para ${
                isActive ? "editor-para-active" : "editor-para-inactive"
              }`}
              style={{
                color: isActive ? activeColor : inactiveColor,
                transition: "color 220ms ease-out",
              }}
            >
              {safeContent}
              {!isLast && "\n"}
            </span>
          );
        })}
        {content.endsWith("\n") && <br aria-hidden="true" />}
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onInput={markTyping}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onMouseDown={(e) =>
          editorDebug.log("EVENT", "mousedown", {
            target: (e.target as HTMLElement)?.tagName,
            selStart: textareaRef.current?.selectionStart,
            selEnd: textareaRef.current?.selectionEnd,
          })
        }
        onMouseUp={(e) => {
          editorDebug.log("EVENT", "mouseup", {
            target: (e.target as HTMLElement)?.tagName,
            selStart: textareaRef.current?.selectionStart,
            selEnd: textareaRef.current?.selectionEnd,
          });
          handleInteraction();
        }}
        onClick={handleInteractionWithDebug}
        onSelect={handleInteractionWithDebug}
        onFocus={handleInteractionWithDebug}
        onScroll={syncScrollPos}
        placeholder="..."
        spellCheck
        className={twMerge(
          "editor-textarea block h-screen w-full resize-none bg-transparent focus:outline-none overflow-x-hidden overflow-y-scroll relative z-10",
          needsDisplayLayer && "editor-textarea-transparent",
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
          paddingBottom: "50vh",
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
          fontVariantLigatures: "none",
          fontFeatureSettings: '"liga" 0, "clig" 0, "calt" 0',
        }}
      />

      {/* Barra de desplazamiento con transición de opacidad sutil en modo Zen */}
      <EditorScrollbar
        isDay={isDay}
        scrollTrackRef={scrollTrackRef}
        scrollThumbRef={scrollThumbRef}
        onTrackClick={handleTrackClick}
        onThumbPointerDown={handleThumbPointerDown}
        onThumbPointerMove={handleThumbPointerMove}
        onThumbPointerUp={handleThumbPointerUp}
      />

      {/* Descomentar para activar el HUD visual de debug en pantalla: */}
      {/* <EditorDebugHUD
        startIdx={effectiveStart}
        endIdx={effectiveEnd}
        textareaRef={textareaRef}
      /> */}
    </div>
  );
}

interface EditorScrollbarProps {
  isDay: boolean;
  scrollTrackRef: React.RefObject<HTMLDivElement>;
  scrollThumbRef: React.RefObject<HTMLDivElement>;
  onTrackClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onThumbPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onThumbPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onThumbPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}

const EditorScrollbar = memo(function EditorScrollbar({
  isDay,
  scrollTrackRef,
  scrollThumbRef,
  onTrackClick,
  onThumbPointerDown,
  onThumbPointerMove,
  onThumbPointerUp,
}: EditorScrollbarProps) {
  return (
    <div
      ref={scrollTrackRef}
      onClick={onTrackClick}
      aria-hidden="true"
      className="auto-hide-ui absolute right-0 top-0 bottom-0 w-3 z-30 pointer-events-auto cursor-pointer select-none"
      style={{
        transform: "translateZ(0)",
        WebkitBackfaceVisibility: "hidden",
        backfaceVisibility: "hidden",
      }}
    >
      <div
        ref={scrollThumbRef}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
        className={twMerge(
          "absolute right-1 w-1.5 rounded-full touch-none select-none",
          isDay
            ? "bg-gray-400/60 hover:bg-gray-500/80 active:bg-gray-600/90"
            : "bg-zinc-500/50 hover:bg-zinc-400/80 active:bg-zinc-300/90"
        )}
        style={{
          top: 0,
          willChange: "transform",
          transform: "translateZ(0)",
          WebkitBackfaceVisibility: "hidden",
          backfaceVisibility: "hidden",
          transition: "background-color 150ms ease-out",
        }}
      />
    </div>
  );
});

export default TinyEditor;
