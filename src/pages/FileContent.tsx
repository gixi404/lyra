import commands from "mousetrap";
import listenCommands from "bind-mousetrap-global";
import MainContainer from "../components/MainContainer";
import ModifiedFile from "../components/ModifiedFile";
import TinyEditor from "../components/TinyEditor";
import useFile from "../hooks/useFile";
import useStorage from "../hooks/useStorage";
import WordsFile from "../components/WordsFile";
import { fileStore } from "../store/fileStore";
import { useEffect, useState } from "react";
import { getDate } from "../utils/helpers";
import type { Component } from "../utils/types";

listenCommands(commands);

function FileContent(): Component {
  const { setItem } = useStorage(),
    { selectedFile } = fileStore(),
    { saveFileContent } = useFile(),
    { bindGlobal: listen }: any = commands,
    oldContent: string = selectedFile.content ?? "",
    [content, setContent] = useState<string>(() => selectedFile.content ?? ""),
    [wordCounts, setWordCounts] = useState<number>(0);

  useEffect(() => {
    saveFileContent(selectedFile.name, content ?? "");
    saveLastModified();
  }, [content]);

  listen("ctrl+j", (e: Event) => e.preventDefault());
  listen("ctrl+g", (e: Event) => e.preventDefault());

  function handleContentChange(newContent: string): void {
    setContent(newContent);
  }

  function handleWordCountChange(count: number): void {
    setWordCounts(count);
  }

  function saveLastModified(): void {
    if (oldContent !== content) {
      const date: string = getDate();
      setItem(`${selectedFile.name}-modified`, date);
    }
  }

  return (
    <MainContainer>
      <WordsFile wordCounts={wordCounts} />
      <ModifiedFile />
      <TinyEditor
        content={content}
        onContentChange={handleContentChange}
        onWordCountChange={handleWordCountChange}
      />
    </MainContainer>
  );
}
export default FileContent;
