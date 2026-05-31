import commands from "mousetrap";
import listenCommands from "bind-mousetrap-global";
import MainContainer from "../components/MainContainer";
import ModifiedFile from "../components/ModifiedFile";
import useFile from "../hooks/useFile";
import useStorage from "../hooks/useStorage";
import WordsFile from "../components/WordsFile";
import { fileStore } from "../store/fileStore";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getCompatibleStorageKeys, getDate } from "../utils/helpers";
import type { Component } from "../utils/types";

listenCommands(commands);

const AUTOSAVE_DEBOUNCE_MS = 400;
const DRAFT_DEBOUNCE_MS = 250;
const DRAFT_STORAGE_PREFIX = "lyra-draft";
const TinyEditor = lazy(() => import("../components/TinyEditor"));

interface DraftPayload {
  content: string;
  updatedAt: number;
}

function FileContent(): Component {
  const { setItem } = useStorage(),
    { selectedFile } = fileStore(),
    { saveFileContent } = useFile(),
    { bindGlobal: listen }: any = commands,
    [content, setContent] = useState<string>(() => selectedFile.content ?? ""),
    [wordCounts, setWordCounts] = useState<number>(0),
    autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    isDirtyRef = useRef<boolean>(false),
    isSavingRef = useRef<boolean>(false),
    latestPersistedContentRef = useRef<string>(selectedFile.content ?? ""),
    latestContentRef = useRef<string>(content),
    latestFileNameRef = useRef<string>(selectedFile.name),
    initialContentRef = useRef<string>(selectedFile.content ?? "");

  function getDraftKey(fileName: string): string {
    return `${DRAFT_STORAGE_PREFIX}:${fileName}`;
  }

  function readDraft(fileName: string): DraftPayload | null {
    if (!fileName) return null;

    const draftKeys: string[] = getCompatibleStorageKeys(fileName, "", DRAFT_STORAGE_PREFIX);
    const rawDraft: string | null = draftKeys.reduce<string | null>((draft, key) => {
      if (draft !== null) return draft;
      return window.localStorage.getItem(key);
    }, null);
    if (!rawDraft) return null;

    try {
      const parsed: DraftPayload = JSON.parse(rawDraft);
      if (typeof parsed.content !== "string" || typeof parsed.updatedAt !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeDraft(fileName: string, draftContent: string): void {
    if (!fileName) return;

    const payload: DraftPayload = {
      content: draftContent,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(getDraftKey(fileName), JSON.stringify(payload));
  }

  function clearDraft(fileName: string): void {
    if (!fileName) return;
    getCompatibleStorageKeys(fileName, "", DRAFT_STORAGE_PREFIX).forEach(key => {
      window.localStorage.removeItem(key);
    });
  }

  async function persistLatestToDisk(): Promise<void> {
    if (isSavingRef.current) return;

    const fileName: string = latestFileNameRef.current;
    if (!fileName) return;

    const snapshotToPersist: string = latestContentRef.current ?? "";
    if (!isDirtyRef.current && snapshotToPersist === latestPersistedContentRef.current) return;

    isSavingRef.current = true;
    try {
      await saveFileContent(fileName, snapshotToPersist);
      saveLastModified(initialContentRef.current, snapshotToPersist);
      latestPersistedContentRef.current = snapshotToPersist;

      if (latestContentRef.current === snapshotToPersist) {
        isDirtyRef.current = false;
        clearDraft(fileName);
      }
    } catch {
      writeDraft(fileName, latestContentRef.current ?? snapshotToPersist);
    } finally {
      isSavingRef.current = false;

      if (isDirtyRef.current && latestContentRef.current !== latestPersistedContentRef.current) {
        void persistLatestToDisk();
      }
    }
  }

  function flushAutosave(): void {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    void persistLatestToDisk();
  }

  function scheduleDraftPersist(nextContent: string): void {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
    }

    draftTimerRef.current = setTimeout(() => {
      writeDraft(latestFileNameRef.current, nextContent);
      draftTimerRef.current = null;
    }, DRAFT_DEBOUNCE_MS);
  }

  function flushDraftPersist(): void {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    writeDraft(latestFileNameRef.current, latestContentRef.current ?? "");
  }

  useEffect(() => {
    latestContentRef.current = content;
    latestFileNameRef.current = selectedFile.name;
  }, [content, selectedFile.name]);

  useEffect(() => {
    if (!isDirtyRef.current) return;

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = setTimeout(() => {
      flushAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [content]);

  useEffect(() => {
    return () => {
      flushDraftPersist();
      flushAutosave();
    };
  }, []);

  useEffect(() => {
    const flushOnLifecycleChange = (): void => {
      flushDraftPersist();
      flushAutosave();
    };

    window.addEventListener("beforeunload", flushOnLifecycleChange);
    window.addEventListener("pagehide", flushOnLifecycleChange);

    return () => {
      window.removeEventListener("beforeunload", flushOnLifecycleChange);
      window.removeEventListener("pagehide", flushOnLifecycleChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      flushDraftPersist();
      flushAutosave();
    };
  }, [selectedFile.name]);

  useEffect(() => {
    const diskContent: string = selectedFile.content ?? "";
    const draft: DraftPayload | null = readDraft(selectedFile.name);
    const startingContent: string = draft?.content ?? diskContent;

    setContent(startingContent);
    latestContentRef.current = startingContent;
    latestFileNameRef.current = selectedFile.name;
    initialContentRef.current = diskContent;
    latestPersistedContentRef.current = diskContent;
    isDirtyRef.current = startingContent !== diskContent;
  }, [selectedFile.name, selectedFile.content]);

  useEffect(() => {
    const preventCtrlJ = (e: Event): void => e.preventDefault();
    const preventCtrlG = (e: Event): void => e.preventDefault();

    listen("ctrl+j", preventCtrlJ);
    listen("ctrl+g", preventCtrlG);

    return () => {
      const globalCommands: any = commands;

      if (typeof globalCommands.unbindGlobal === "function") {
        globalCommands.unbindGlobal("ctrl+j");
        globalCommands.unbindGlobal("ctrl+g");
        return;
      }

      commands.unbind("ctrl+j");
      commands.unbind("ctrl+g");
    };
  }, []);

  function handleContentChange(newContent: string): void {
    isDirtyRef.current = true;
    latestContentRef.current = newContent;
    scheduleDraftPersist(newContent);
    setContent(newContent);
  }

  function handleWordCountChange(count: number): void {
    setWordCounts(count);
  }

  function saveLastModified(previousContent: string, currentContent: string): void {
    if (previousContent !== currentContent) {
      const date: string = getDate();
      const [modifiedKey] = getCompatibleStorageKeys(latestFileNameRef.current, "-modified");
      setItem(modifiedKey, date);
    }
  }

  return (
    <MainContainer>
      <WordsFile wordCounts={wordCounts} />
      <ModifiedFile />
      <Suspense fallback={<div className="w-full flex-1" />}>
        <TinyEditor
          content={content}
          onContentChange={handleContentChange}
          onWordCountChange={handleWordCountChange}
        />
      </Suspense>
    </MainContainer>
  );
}
export default FileContent;
