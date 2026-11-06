import { create } from "zustand";
import type { File } from "../utils/types";
import { getAnimationDuration } from "../utils/motion.ts";
import { flushEditorDrafts } from "../utils/editorPersistence.ts";
import { logger } from "../utils/logger.ts";

export interface FileItemStats {
  mtime: number;
  birthtime: number;
}

interface PendingExit {
  names: string[];
  commit: () => void;
  timerId: ReturnType<typeof setTimeout>;
}

let pendingExits: PendingExit[] = [];

export interface FileStoreState {
  files: string[];
  retainedExits: { name: string; view: "active" | "paper"; index: number }[];
  renderedOrder: { active: string[]; paper: string[] };
  deletingFiles: string[];
  setDeletingFile: (name: string, busy: boolean) => void;
  isEmptyingArchived: boolean;
  setEmptyingArchived: (busy: boolean) => void;
  statsMap: Record<string, FileItemStats>;
  isInitialized: boolean;
  exitingFiles: string[];
  addExitingFile: (name: string) => void;
  addExitingFiles: (names: string[]) => void;
  removeExitingFile: (name: string) => void;
  removeExitingFiles: (names: string[]) => void;
  clearExitingFiles: () => void;
  scheduleExitAnimation: (
    names: string | string[],
    commit: () => void,
    duration?: number
  ) => void;
  flushPendingExits: () => void;
  retainForExit: (name: string, view: "active" | "paper") => void;
  releaseRetainedExit: (name: string) => void;
  setRenderedOrder: (view: "active" | "paper", names: string[]) => void;
  updateListFiles: (name: string) => void;
  setFiles: (names: string[]) => void;
  setFilesWithStats: (files: string[], statsMap: Record<string, FileItemStats>) => void;
  removeFileFromList: (name: string) => void;
  selectedFile: File;
  selectionGeneration: number;
  setSelectedFile: (file: File) => void;
  fileIsEdited: boolean;
  editedFile: () => void;
}

export const fileStore = create<FileStoreState>(set => ({
  files: [],
  retainedExits: [],
  renderedOrder: { active: [], paper: [] },
  deletingFiles: [],
  isEmptyingArchived: false,
  setEmptyingArchived: busy => set({ isEmptyingArchived: busy }),
  setDeletingFile: (name, busy) => set(state => ({
    deletingFiles: busy
      ? Array.from(new Set([...state.deletingFiles, name]))
      : state.deletingFiles.filter(item => item !== name),
  })),
  statsMap: {},
  isInitialized: false,
  exitingFiles: [],
  addExitingFile: (name: string) =>
    set(state => ({
      exitingFiles: state.exitingFiles.includes(name)
        ? state.exitingFiles
        : [...state.exitingFiles, name],
    })),
  addExitingFiles: (names: string[]) =>
    set(state => ({
      exitingFiles: Array.from(new Set([...state.exitingFiles, ...names])),
    })),
  removeExitingFile: (name: string) =>
    set(state => ({
      exitingFiles: state.exitingFiles.filter(f => f !== name),
    })),
  removeExitingFiles: (names: string[]) =>
    set(state => ({
      exitingFiles: state.exitingFiles.filter(f => !names.includes(f)),
    })),
  clearExitingFiles: () => {
    for (const pending of pendingExits) {
      clearTimeout(pending.timerId);
    }
    pendingExits = [];
    set({ exitingFiles: [], retainedExits: [] });
  },
  retainForExit: (name, view) => set(state => ({
    retainedExits: state.retainedExits.some(item => item.name === name)
      ? state.retainedExits
      : [...state.retainedExits, { name, view,
        index: Math.max(0, state.renderedOrder[view].indexOf(name)),
      }],
  })),
  releaseRetainedExit: name => set(state => ({
    retainedExits: state.retainedExits.filter(item => item.name !== name),
  })),
  setRenderedOrder: (view, names) => set(state => ({
    renderedOrder: { ...state.renderedOrder, [view]: names },
  })),
  scheduleExitAnimation: (
    namesInput: string | string[],
    commit: () => void,
    duration?: number
  ) => {
    const names = Array.isArray(namesInput) ? namesInput : [namesInput];
    if (names.length === 0) {
      commit();
      return;
    }

    const animDuration = duration !== undefined ? duration : getAnimationDuration();

    if (animDuration <= 0) {
      try { commit(); } finally {
        set(state => ({ retainedExits: state.retainedExits.filter(item => !names.includes(item.name)) }));
      }
      return;
    }

    set(state => ({
      exitingFiles: Array.from(new Set([...state.exitingFiles, ...names])),
    }));

    const timerId = setTimeout(() => {
      pendingExits = pendingExits.filter(p => p.timerId !== timerId);
      try { commit(); } finally {
        set(state => ({
          exitingFiles: state.exitingFiles.filter(f => !names.includes(f)),
          retainedExits: state.retainedExits.filter(item => !names.includes(item.name)),
        }));
      }
    }, animDuration);

    pendingExits.push({ names, commit, timerId });
  },
  flushPendingExits: () => {
    if (pendingExits.length === 0) {
      set({ exitingFiles: [] });
      return;
    }
    const currentPending = [...pendingExits];
    pendingExits = [];
    for (const pending of currentPending) {
      clearTimeout(pending.timerId);
      try {
        pending.commit();
      } catch (err) {
        logger.error("Error al confirmar salida pendiente:", err);
      }
    }
    set(state => ({
      exitingFiles: [],
      retainedExits: state.retainedExits.filter(item =>
        !currentPending.some(pending => pending.names.includes(item.name))
      ),
    }));
  },
  updateListFiles: (name: string) =>
    set(state => ({
      files: state.files.includes(name) ? state.files : [...state.files, name],
      statsMap: {
        ...state.statsMap,
        [name]: {
          mtime: Date.now(),
          birthtime: state.statsMap[name]?.birthtime || Date.now(),
        },
      },
    })),
  setFiles: (names: string[]) => set({ files: names, isInitialized: true }),
  setFilesWithStats: (files: string[], statsMap: Record<string, FileItemStats>) =>
    set({ files, statsMap, isInitialized: true }),
  removeFileFromList: (name: string) =>
    set(state => {
      const nextStats = { ...state.statsMap };
      delete nextStats[name];
      return {
        files: state.files.filter((f: string) => f !== name),
        statsMap: nextStats,
      };
    }),
  selectedFile: { name: "", content: "" },
  selectionGeneration: 0,
  setSelectedFile: (file: File) => {
    flushEditorDrafts();
    set(state => ({
      selectedFile: file,
      selectionGeneration: state.selectionGeneration + 1,
    }));
  },
  fileIsEdited: false,
  editedFile: () =>
    set(state => ({ fileIsEdited: !state.fileIsEdited })),
}));
