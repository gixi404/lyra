import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { INTRO_ES, PAGES } from "../utils/consts";
import { getCompatibleStorageKeys, getDate, navigation, notification } from "../utils/helpers";
import type { Component } from "../utils/types";

const AUTOSAVE_DEBOUNCE_MS = 400;
const DRAFT_DEBOUNCE_MS = 250;
const DRAFT_STORAGE_PREFIX = "lyra-draft";
const TinyEditor = lazy(() => import("../components/TinyEditor"));

interface DraftPayload {
  content: string;
  updatedAt: number;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

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

    if (
      parsed.content.includes("<p>") &&
      (parsed.content.includes("&oacute;") ||
        parsed.content.includes("espacio ideal") ||
        parsed.content.includes("&ntilde;") ||
        fileName.toLowerCase().includes("bienvenido"))
    ) {
      clearDraft(fileName);
      return null;
    }

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

function FileContent(): Component {
  const { goTo } = navigation(),
    selectedFile = fileStore(state => state.selectedFile),
    { saveFileContent, getFileMtime } = useFile(),
    diskContent = selectedFile.content ?? "",
    initialDraft = readDraft(selectedFile.name),
    hasRealDraft = Boolean(
      initialDraft &&
      normalizeText(initialDraft.content) !== normalizeText(diskContent)
    ),
    rawInitial = hasRealDraft && initialDraft ? initialDraft.content : diskContent,
    isWelcomeLegacy =
      selectedFile.name.toLowerCase().includes("bienvenido") &&
      rawInitial.includes("<p>"),
    initialStartingContent = isWelcomeLegacy ? INTRO_ES : rawInitial,
    [content, setContent] = useState<string>(initialStartingContent),
    autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null),
    isDirtyRef = useRef<boolean>(hasRealDraft),
    saveQueueRef = useRef<Promise<void>>(Promise.resolve()),
    saveSeqRef = useRef<number>(0),
    inFlightSeqRef = useRef<number>(0),
    latestPersistedContentRef = useRef<string>(diskContent),
    latestContentRef = useRef<string>(initialStartingContent),
    latestFileNameRef = useRef<string>(selectedFile.name),
    initialContentRef = useRef<string>(diskContent),
    loadedFileNameRef = useRef<string>("");

  useEffect(() => {
    if (initialDraft && !hasRealDraft && selectedFile.name) {
      clearDraft(selectedFile.name);
    }
  }, [initialDraft, hasRealDraft, selectedFile.name]);

  useEffect(() => {
    if (!selectedFile.name) {
      goTo(PAGES.list);
    }
  }, [selectedFile.name, goTo]);

  function persistLatestToDisk(): Promise<void> {
    const targetFileName: string = latestFileNameRef.current;
    if (!targetFileName) return Promise.resolve();

    // Si el usuario no ha modificado el documento, jamás guardar en disco
    if (!isDirtyRef.current) {
      return Promise.resolve();
    }

    const snapshotToPersist: string = latestContentRef.current ?? "";
    if (normalizeText(snapshotToPersist) === normalizeText(latestPersistedContentRef.current)) {
      isDirtyRef.current = false;
      clearDraft(targetFileName);
      return Promise.resolve();
    }

    const currentSeq = ++saveSeqRef.current;

    // Encolamiento FIFO estricto mediante cadena de promesas
    // Evita carreras entre escrituras concurrentes o ráfagas de pulsaciones
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      if (currentSeq < inFlightSeqRef.current) return;
      inFlightSeqRef.current = currentSeq;

      try {
        await saveFileContent(targetFileName, snapshotToPersist);
        saveLastModified(targetFileName, initialContentRef.current, snapshotToPersist);
        initialContentRef.current = snapshotToPersist;

        if (latestFileNameRef.current === targetFileName) {
          latestPersistedContentRef.current = snapshotToPersist;
          if (latestContentRef.current === snapshotToPersist) {
            isDirtyRef.current = false;
            clearDraft(targetFileName);
          }
        }
      } catch {
        writeDraft(targetFileName, snapshotToPersist);
        notification("error", "Error al guardar el archivo en disco. Se ha preservado en borrador local.");
      }
    });

    return saveQueueRef.current;
  }

  function flushAutosave(): void {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    if (!isDirtyRef.current) return;

    void persistLatestToDisk();
  }

  function scheduleDraftPersist(nextContent: string): void {
    if (!isDirtyRef.current) return;

    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
    }

    const targetFileName = latestFileNameRef.current;
    if (!targetFileName) return;

    draftTimerRef.current = setTimeout(() => {
      if (isDirtyRef.current) {
        writeDraft(targetFileName, nextContent);
      }
      draftTimerRef.current = null;
    }, DRAFT_DEBOUNCE_MS);
  }

  function flushDraftPersist(): void {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }

    // Solo guardar borrador si el documento ha sido editado
    if (!isDirtyRef.current) return;

    const targetFileName = latestFileNameRef.current;
    if (targetFileName) {
      writeDraft(targetFileName, latestContentRef.current ?? "");
    }
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
    if (!selectedFile.name) return;
    if (loadedFileNameRef.current === selectedFile.name) return;
    loadedFileNameRef.current = selectedFile.name;

    let isCancelled = false;
    const currentDiskContent: string = selectedFile.content ?? "";
    const draft: DraftPayload | null = readDraft(selectedFile.name);

    initialContentRef.current = currentDiskContent;
    latestFileNameRef.current = selectedFile.name;

    const initContent = async () => {
      let startingContent = currentDiskContent;
      let shouldClearDraft = false;

      if (
        selectedFile.name.toLowerCase().includes("bienvenido") &&
        (currentDiskContent.includes("<p>") || currentDiskContent.includes("espacio ideal"))
      ) {
        startingContent = INTRO_ES;
        shouldClearDraft = true;
      } else if (draft) {
        if (normalizeText(currentDiskContent) === normalizeText(draft.content)) {
          startingContent = currentDiskContent;
          shouldClearDraft = true;
        } else {
          const diskMtime = await getFileMtime(selectedFile.name);
          if (diskMtime !== null && diskMtime > draft.updatedAt + 1000) {
            // El archivo en disco fue modificado externamente después de la última edición del borrador
            startingContent = currentDiskContent;
            shouldClearDraft = true;
          } else {
            // El borrador es más reciente y tiene contenido diferente
            startingContent = draft.content;
          }
        }
      }

      if (isCancelled) return;

      if (shouldClearDraft) {
        clearDraft(selectedFile.name);
      }

      // Si el usuario ya comenzó a escribir en este archivo, no sobreescribir su contenido en vivo
      if (!isDirtyRef.current) {
        setContent(startingContent);
        latestContentRef.current = startingContent;
        latestPersistedContentRef.current = currentDiskContent;
        isDirtyRef.current = normalizeText(startingContent) !== normalizeText(currentDiskContent);
      }
    };

    void initContent();

    return () => {
      isCancelled = true;
    };
  }, [selectedFile.name]);


  function handleContentChange(newContent: string): void {
    isDirtyRef.current = true;
    latestContentRef.current = newContent;
    scheduleDraftPersist(newContent);
    setContent(newContent);
  }

  function saveLastModified(fileName: string, previousContent: string, currentContent: string): void {
    if (fileName && normalizeText(previousContent) !== normalizeText(currentContent)) {
      const date: string = getDate();
      const [modifiedKey] = getCompatibleStorageKeys(fileName, "-modified");
      window.localStorage.setItem(modifiedKey, date);
    }
  }

  if (!selectedFile.name) {
    return (
      <MainContainer>
        <div className="w-full flex-1" />
      </MainContainer>
    );
  }

  return (
    <MainContainer>
      <Suspense fallback={<div className="w-full flex-1" />}>
        <TinyEditor
          key={selectedFile.name}
          content={content}
          onContentChange={handleContentChange}
          initialCaretPos={selectedFile.initialCaretPos}
        />
      </Suspense>
    </MainContainer>
  );
}
export default FileContent;
