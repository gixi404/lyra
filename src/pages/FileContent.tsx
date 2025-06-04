import commands from "mousetrap";
import listenCommands from "bind-mousetrap-global";
import MainContainer from "../components/MainContainer";
import ModifiedFile from "../components/ModifiedFile";
import useFile from "../hooks/useFile";
import usePreferences from "../hooks/usePreferences";
import useStorage from "../hooks/useStorage";
import WordsFile from "../components/WordsFile";
import { configStore } from "../store/configStore";
import { copyText, getDate, len } from "../utils/helpers";
import { fileStore } from "../store/fileStore";
import { useEffect, useState } from "react";
import {
  increaseText,
  reduceText,
  toggleSpellchecker,
} from "../utils/commands";
import type { Component, stylesText } from "../utils/types";

listenCommands(commands);

function FileContent(): Component {
  const { setItem } = useStorage(),
    { selectedFile } = fileStore(),
    { saveFileContent } = useFile(),
    { bindGlobal: listen }: any = commands,
    { spellCheck, setSpellCheck } = configStore(),
    oldContent: string = selectedFile.content ?? "",
    [content, setContent] = useState<string>(() => selectedFile.content ?? ""),
    { myLastModified, myFontSize, myAlign, myOpacity, mySpacing } =
      usePreferences(),
    [wordCounts, setWordCounts] = useState<number>(0),
    [styles, setStyles] = useState<stylesText>({
      fontSize: myFontSize(),
      alignText: myAlign(),
      opacity: String(myOpacity()),
      letterSpacing: String(mySpacing()),
    });

  useEffect(() => {
    saveFileContent(selectedFile.name, content ?? "");
    calculateWordCount(content);
    saveLastModified();
  }, [content]);

  listen("ctrl+j", (e: Event) => e.preventDefault());
  listen("ctrl+g", (e: Event) => e.preventDefault());
  listen("ctrl+m", () => toggleSpellchecker(spellCheck, setSpellCheck));
  listen("ctrl+a", () => copyText(content));
  listen("ctrl+b", () => reduceText(styles, setStyles));
  listen("ctrl+n", () => increaseText(styles, setStyles));

  function calculateWordCount(text: string): void {
    const spaces: RegExp = /\s+/;
    const count: number = len(
      text
        .trim()
        .split(spaces)
        .filter((w: string) => len(w) > 0)
    );
    setWordCounts(count);
  }

  function saveLastModified(): void {
    if (myLastModified() && oldContent != content) {
      const date: string = getDate();
      setItem(`${selectedFile.name}-modified`, date);
    }
  }

  return (
    <MainContainer>
      <WordsFile wordCounts={wordCounts} />
      <ModifiedFile />
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={spellCheck}
        autoFocus
        placeholder="..."
        style={{
          opacity: String(Number(styles.opacity) / 10),
          letterSpacing: String(styles.letterSpacing) + "px",
          fontSize: String(styles.fontSize),
          textAlign: String(styles.alignText) as CanvasTextAlign,
        }}
        className="text-2xl sm:min-w-[600px] w-full min-h-screen py-6 sm:py-20 px-10 lg:px-44 xl:px-64 resize-none border-none focus:ring-0 focus:outline-none bg-transparent placeholder:text-gray-100/50 text-pretty cursor-text"
      />
    </MainContainer>
  );
}
export default FileContent;
