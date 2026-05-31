import { useRef, useEffect } from "react";
import { Editor } from "@tinymce/tinymce-react";
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
  const editorRef = useRef<any>(null),
    { isDay } = themes(),
    { myFontSize, myAlign, myOpacity, mySpacing } = usePreferences(),
    fontSize: string = myFontSize(),
    textAlign: string = myAlign(),
    opacity: number = myOpacity(),
    letterSpacing: number = mySpacing();

  useEffect(() => {
    if (editorRef.current) {
      const currentContent: string = editorRef.current.getContent();
      if (currentContent !== content) {
        editorRef.current.setContent(content);
      }
    }
  }, [content]);

  useEffect(() => {
    const wordCountTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (!editorRef.current) {
        onWordCountChange(0);
        return;
      }

      const editorText: string = editorRef.current.getContent({ format: "text" }) ?? "";
      const normalizedText: string = editorText.trim();
      if (normalizedText.length === 0) {
        onWordCountChange(0);
        return;
      }

      const words: string[] = normalizedText.split(/\s+/);
      onWordCountChange(words.length);
    }, WORD_COUNT_DEBOUNCE_MS);

    return () => {
      clearTimeout(wordCountTimer);
    };
  }, [content, onWordCountChange]);

  const handleEditorChange = (newContent: string): void => {
    onContentChange(newContent);
  };

  const contentStyle: string = `
    body {
      font-family: inherit;
      font-size: ${fontSize};
      text-align: ${textAlign};
      opacity: ${opacity / 10};
      letter-spacing: ${letterSpacing}px;
      background-color: ${isDay ? "#f3f4f6" : "#0f0f0f"};
      color: ${isDay ? "#1f2937" : "#e5e7eb"};
      padding: 1.5rem 3rem;
      line-height: 1.75;
      min-height: 100vh;
    }
    body:focus {
      outline: none !important;
      border: none !important;
      box-shadow: none !important;
    }
    html {
      background-color: ${isDay ? "#f3f4f6" : "#0f0f0f"};
    }
    ::-webkit-scrollbar {
      width: 0;
      background: transparent;
    }
    * {
      outline: none !important;
    }
  `;

  return (
    <div className="w-full h-full min-h-screen tinymce-container">
      <Editor
        tinymceScriptSrc="/tinymce/tinymce.min.js"
        licenseKey="gpl"
        onInit={(_evt: unknown, editor: any) => {
          editorRef.current = editor;
          if (content) {
            editor.setContent(content);
          }
        }}
        value={content}
        init={{
          height: "calc(100vh - 39px)",
          menubar: false,
          statusbar: true,
          toolbar:
            "undo redo | blocks fontsize | bold italic underline strikethrough | forecolor backcolor | alignleft aligncenter alignright alignjustify | numlist bullist | image link | removeformat",
          plugins: [
            "wordcount",
            "lists",
            "image",
            "link",
          ],
          content_style: contentStyle,
          skin: isDay ? "oxide" : "oxide-dark",
          skin_url: "/tinymce/skins/ui/" + (isDay ? "oxide" : "oxide-dark"),
          content_css: false,
          placeholder: "...",
          browser_spellcheck: true,
          contextmenu: false,
          resize: false,
          branding: false,
          elementpath: false,
          promotion: false,
          body_class: isDay ? "day-theme" : "dark-theme",
          toolbar_mode: "wrap",
          toolbar_sticky: true,
          font_size_formats: "8pt 10pt 12pt 14pt 16pt 18pt 20pt 24pt 28pt 32pt 36pt",
          image_advtab: true,
          file_picker_types: "image",
          automatic_uploads: true,
          images_upload_handler: (blobInfo: any) => {
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                resolve(reader.result as string);
              };
              reader.readAsDataURL(blobInfo.blob());
            });
          },
        }}
        onEditorChange={handleEditorChange}
      />
    </div>
  );
}

export default TinyEditor;
