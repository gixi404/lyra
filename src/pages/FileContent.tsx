import MainContainer from "../components/MainContainer";
import useFile from "../hooks/useFile";
import { fileStore } from "../store/fileStore";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { INTRO_ES, PAGES } from "../utils/consts";
import { isWelcomeFileName } from "../utils/welcome";
import { getCompatibleStorageKeys, getDate, navigation, notification } from "../utils/helpers";
import type { Component, File } from "../utils/types";
import { useSyncStore, registerPreSyncHandler, type SyncResultPayload } from "../store/syncStore";
import { listen } from "@tauri-apps/api/event";
import {
  EditorSyncCoordinator,
  normalizeText,
} from "../utils/editorSyncCoordinator";
import { reconcileDraftState } from "../utils/draftRecovery";
import { noteLabel } from "../utils/noteName";
import {
  clearDetachedSaveFailure,
  getUpdateInstallInProgress,
  markDetachedSaveFailure,
  registerEditorSession,
  subscribeUpdateInstall,
} from "../utils/editorPersistence";

const DRAFT_STORAGE_PREFIX = "lyra-draft";
const TinyEditor = lazy(() => import("../components/TinyEditor"));

interface DraftPayload {
  content: string;
  updatedAt: number;
}

let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
const CLOUD_SYNC_DEBOUNCE_MS = 15_000; // 15 segundos de inactividad de escritura para sincronizar con Google Drive

function scheduleCloudSync(onSyncStart?: () => void): void {
  const syncState = useSyncStore.getState();
  if (!syncState.isConnected) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    onSyncStart?.();
    void useSyncStore.getState().syncNow(true);
  }, CLOUD_SYNC_DEBOUNCE_MS);
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
        isWelcomeFileName(fileName))
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

function saveLastModified(fileName: string, previousContent: string, currentContent: string): void {
  if (fileName && normalizeText(previousContent) !== normalizeText(currentContent)) {
    const date: string = getDate();
    const [modifiedKey] = getCompatibleStorageKeys(fileName, "-modified");
    window.localStorage.setItem(modifiedKey, date);
  }
}

function FileContentSession({ selectedFile }: { selectedFile: File }): Component {
  const updateInstallInProgress = useSyncExternalStore(subscribeUpdateInstall, getUpdateInstallInProgress);
  const { goTo } = navigation(),
    { saveFileContent, getFileMtime, readFile, fileExists, createFile } = useFile(),
    diskContent = selectedFile.content ?? "",
    initialDraft = readDraft(selectedFile.name),
    hasRealDraft = Boolean(
      initialDraft &&
      normalizeText(initialDraft.content) !== normalizeText(diskContent)
    ),
    rawInitial = hasRealDraft && initialDraft ? initialDraft.content : diskContent,
    isWelcomeLegacy =
      isWelcomeFileName(selectedFile.name) &&
      rawInitial.includes("<p>"),
    initialStartingContent = isWelcomeLegacy ? INTRO_ES : rawInitial,
    [content, setContent] = useState<string>(initialStartingContent),
    loadedFileNameRef = useRef<string>(""),
    mountedRef = useRef(false),
    coordinatorRef = useRef<EditorSyncCoordinator | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const scheduleDebouncedCloudSync = useCallback(() => {
    scheduleCloudSync(() => {
      coordinatorRef.current?.markSyncInFlight();
    });
  }, []);

  if (!coordinatorRef.current) {
    coordinatorRef.current = new EditorSyncCoordinator({
      fileName: selectedFile.name,
      initialContent: diskContent,
      saveFileContent: async (name, newContent) => {
        await saveFileContent(name, newContent);
      },
      readFileContent: readFile,
      writeDraft,
      clearDraft,
      scheduleCloudSync: scheduleDebouncedCloudSync,
      onSaveSuccess: (name, prev, current) => {
        saveLastModified(name, prev, current);
        clearDetachedSaveFailure(name);
      },
      onSaveError: (name, _content, _err) => {
        notification("error", `No se pudo guardar ${noteLabel(name)}. Tus cambios se conservaron en un borrador local`);
      },
      onContentReloaded: (newContent) => {
        if (mountedRef.current) setContent(newContent);
      },
      onConflictCreated: (conflictName) => {
        fileStore.getState().editedFile();
        notification(
          "error",
          `${noteLabel(selectedFile.name)} se actualizó desde Google Drive. Tus cambios se conservaron en ${noteLabel(conflictName)}`,
          undefined,
          8000
        );
      },
      onRemoteDeleted: (fileName, wasDirty) => {
        if (!wasDirty) {
          notification("info", `${noteLabel(fileName)} fue eliminado en Google Drive.`);
          goTo(PAGES.list);
        } else {
          notification(
            "info",
            `${noteLabel(fileName)} se eliminó de Google Drive, pero tus cambios se conservaron en Lyra`
          );
        }
      },
    });
    if (hasRealDraft) {
      coordinatorRef.current.handleUserContentChange(initialStartingContent);
    }
  }

  useEffect(() => {
    coordinatorRef.current?.updateOptions({
      saveFileContent: async (name, newContent) => {
        await saveFileContent(name, newContent);
      },
      readFileContent: readFile,
      writeDraft,
      clearDraft,
      scheduleCloudSync: scheduleDebouncedCloudSync,
      onSaveSuccess: (name, prev, current) => {
        saveLastModified(name, prev, current);
        clearDetachedSaveFailure(name);
      },
      onSaveError: (name, _content, _err) => {
        notification("error", `No se pudo guardar ${noteLabel(name)}. Tus cambios se conservaron en un borrador local`);
      },
      onContentReloaded: (newContent) => {
        if (mountedRef.current) setContent(newContent);
      },
      onConflictCreated: (conflictName) => {
        fileStore.getState().editedFile();
        notification(
          "error",
          `${noteLabel(selectedFile.name)} se actualizó desde Google Drive. Tus cambios se conservaron en ${noteLabel(conflictName)}`,
          undefined,
          8000
        );
      },
      onRemoteDeleted: (fileName, wasDirty) => {
        if (!wasDirty) {
          notification("info", `${noteLabel(fileName)} fue eliminado en Google Drive.`);
          goTo(PAGES.list);
        } else {
          notification(
            "info",
            `${noteLabel(fileName)} se eliminó de Google Drive, pero tus cambios se conservaron en Lyra`
          );
        }
      },
    });
  }, [selectedFile.name, saveFileContent, readFile, goTo, scheduleDebouncedCloudSync]);

  useEffect(() => {
    const unregister = registerPreSyncHandler(async () => {
      const coordinator = coordinatorRef.current;
      if (!coordinator) return true;

      // 1. Guardar los cambios pendientes en disco y esperar su conclusión antes de leer
      if (coordinator.getIsDirty()) {
        const saved = await coordinator.flushAutosave();
        if (!saved) {
          return false;
        }
      }

      // 2. Capturar la revisión persistida en disco para la subida
      coordinator.markSyncInFlight();
      return true;
    });

    return () => {
      unregister();
    };
  }, [selectedFile.name]);

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

  useEffect(() => {
    const flushOnLifecycleChange = (): void => {
      if (coordinatorRef.current) {
        coordinatorRef.current.flushDraft();
        void coordinatorRef.current.flushAutosave();
      }
    };

    window.addEventListener("beforeunload", flushOnLifecycleChange);
    window.addEventListener("pagehide", flushOnLifecycleChange);

    return () => {
      window.removeEventListener("beforeunload", flushOnLifecycleChange);
      window.removeEventListener("pagehide", flushOnLifecycleChange);
    };
  }, []);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    const release = registerEditorSession(coordinator);
    return () => {
      const hadUnsyncedChanges =
        Boolean(cloudSyncTimer) ||
        Boolean(coordinatorRef.current?.getHasUnsyncedChanges());

      if (cloudSyncTimer) {
        clearTimeout(cloudSyncTimer);
        cloudSyncTimer = null;
      }
      if (coordinator) {
        void coordinator.handleUnmount().then(savedSuccessfully => {
          if (!savedSuccessfully) markDetachedSaveFailure(coordinator.getFileName());
          const syncState = useSyncStore.getState();
          if (syncState.isConnected && hadUnsyncedChanges && savedSuccessfully) {
            coordinator.markSyncInFlight();
            void syncState.syncNow(true);
          }
        }).catch(error => {
          markDetachedSaveFailure(coordinator.getFileName());
          console.error("Could not finish editor save during unmount", error);
        }).finally(release);
      }
    };
  }, [selectedFile.name]);

  useEffect(() => {
    if (!selectedFile.name) return;
    if (loadedFileNameRef.current === selectedFile.name) return;
    loadedFileNameRef.current = selectedFile.name;

    let isCancelled = false;
    const currentDiskContent: string = selectedFile.content ?? "";
    const draft: DraftPayload | null = readDraft(selectedFile.name);

    const initContent = async () => {
      if (
        isWelcomeFileName(selectedFile.name) &&
        (currentDiskContent.includes("<p>") || currentDiskContent.includes("espacio ideal"))
      ) {
        if (isCancelled) return;
        clearDraft(selectedFile.name);
        if (!coordinatorRef.current?.getIsDirty()) {
          setContent(INTRO_ES);
          coordinatorRef.current?.setCleanContent(INTRO_ES, selectedFile.name);
        }
        return;
      }

      const diskMtime = await getFileMtime(selectedFile.name);
      if (isCancelled) return;

      const result = await reconcileDraftState({
        fileName: selectedFile.name,
        diskContent: currentDiskContent,
        draft,
        diskMtime,
        saveFile: async (name, newContent) => {
          await createFile(name, newContent);
        },
        readFile,
        fileExists,
        clearDraft,
        onConflictCreated: (conflictName) => {
          fileStore.getState().editedFile();
          notification(
            "info",
            `Se recuperaron tus modificaciones pendientes en ${noteLabel(conflictName)} debido a cambios más recientes en el archivo`,
            undefined,
            9000
          );
        },
        onConflictError: (err) => {
          notification(
            "error",
            `No se pudo crear la copia de rescate del borrador (${String(err)}). Tus cambios permanecen en el almacenamiento local.`
          );
        },
      });

      if (isCancelled) return;

      // Si el usuario ya comenzó a escribir en este archivo, no sobreescribir su contenido en vivo
      if (!coordinatorRef.current?.getIsDirty()) {
        setContent(result.contentToLoad);
        if (result.action === "use_draft") {
          coordinatorRef.current?.handleUserContentChange(result.contentToLoad);
        } else {
          coordinatorRef.current?.setCleanContent(result.contentToLoad, selectedFile.name);
        }
      }
    };

    void initContent();

    return () => {
      isCancelled = true;
      loadedFileNameRef.current = "";
    };
  }, [selectedFile.name, getFileMtime, saveFileContent, readFile, fileExists]);

  // GD-007: Prevención de carreras entre autosave, desmontaje y sincronización remota
  useEffect(() => {
    let unlistenFinished: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let isMounted = true;

    void listen<SyncResultPayload>("gdrive:sync_finished", async event => {
      if (!isMounted || !coordinatorRef.current) return;
      await coordinatorRef.current.handleSyncFinished(event.payload);
    }).then(unlistenFn => {
      if (isMounted) {
        unlistenFinished = unlistenFn;
      } else {
        unlistenFn();
      }
    });

    void listen<string>("gdrive:sync_error", () => {
      if (!isMounted || !coordinatorRef.current) return;
      coordinatorRef.current.handleSyncError();
    }).then(unlistenFn => {
      if (isMounted) {
        unlistenError = unlistenFn;
      } else {
        unlistenFn();
      }
    });

    return () => {
      isMounted = false;
      if (unlistenFinished) {
        unlistenFinished();
      }
      if (unlistenError) {
        unlistenError();
      }
    };
  }, []);

  function handleContentChange(newContent: string): void {
    if (getUpdateInstallInProgress()) return;
    coordinatorRef.current?.handleUserContentChange(newContent);
    setContent(newContent);
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
        <div className="w-full flex-1 flex flex-col items-center justify-start animate-editor-enter">
          <TinyEditor
            key={selectedFile.name}
            content={content}
            onContentChange={handleContentChange}
            readOnly={updateInstallInProgress}
            initialCaretPos={selectedFile.initialCaretPos}
          />
        </div>
      </Suspense>
    </MainContainer>
  );
}

function FileContent(): Component {
  const selectedFile = fileStore(state => state.selectedFile);
  const generation = fileStore(state => state.selectionGeneration);
  return <FileContentSession key={`${generation}:${selectedFile.name}`} selectedFile={selectedFile} />;
}
export default FileContent;
