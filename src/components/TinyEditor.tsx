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
        boxSizing: "border-box",
        minHeight: "100vh",
        fontSize,
        textAlign: textAlign as CSSProperties["textAlign"],
        opacity: opacity / 10,
        letterSpacing: `${letterSpacing}px`,
        backgroundColor: "transparent",
        color: isDay ? "#1f2937" : "#e5e7eb",
        paddingTop: "70px",
        paddingBottom: "70px",
        paddingLeft: "clamp(1.5rem, calc(50% - 374px), 50%)",
        paddingRight: "clamp(1.5rem, calc(50% - 374px), 50%)",
        width: "100%",
        maxWidth: "100%",
        margin: "0",
        fontFamily: '"SFMono-Regular", "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        outline: "none",
        border: "none",
        lineHeight: 1.9,
      }}
    />
  );
}

export default TinyEditor;
