import { useRef, useEffect, useCallback } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import usePreferences from "../hooks/usePreferences";
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
    { isDay } = themes(),
    { myFontSize, myAlign, myOpacity, mySpacing } = usePreferences(),
    fontSize: string = myFontSize(),
    textAlign: string = myAlign(),
    opacity: number = myOpacity(),
    letterSpacing: number = mySpacing();

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
      onContentChange(e.target.value);
    },
    [onContentChange],
  );

  return (
    <textarea
      ref={textareaRef}
      value={content}
      onChange={handleChange}
      placeholder="..."
      spellCheck
      className="block h-full w-full flex-1 resize-none border border-transparent bg-transparent leading-relaxed transition-shadow focus:outline-none"
      style={{
        minHeight: "100%",
        height: "100%",
        fontSize,
        textAlign: textAlign as CSSProperties["textAlign"],
        opacity: opacity / 10,
        letterSpacing: `${letterSpacing}px`,
        backgroundColor: isDay ? "rgba(245, 245, 244, 0.82)" : "rgba(15, 15, 15, 0.92)",
        color: isDay ? "#1f2937" : "#e5e7eb",
        padding: "80px 140px",
        width: "100%",
        maxWidth: "1200px",
        margin: "0 auto",
        fontFamily: '"SFMono-Regular", "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        outline: "none",
        borderColor: isDay ? "rgba(120, 113, 108, 0.14)" : "rgba(245, 245, 244, 0.08)",
        lineHeight: 1.9,
      }}
    />
  );
}

export default TinyEditor;
