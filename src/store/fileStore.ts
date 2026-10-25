import { create } from "zustand";
import type { File } from "../utils/types";

export interface FileItemStats {
  mtime: number;
  birthtime: number;
}

export interface FileStoreState {
  files: string[];
  statsMap: Record<string, FileItemStats>;
  isInitialized: boolean;
  updateListFiles: (name: string) => void;
  setFiles: (names: string[]) => void;
  setFilesWithStats: (files: string[], statsMap: Record<string, FileItemStats>) => void;
  removeFileFromList: (name: string) => void;
  selectedFile: File;
  setSelectedFile: (file: File) => void;
  fileIsEdited: boolean;
  editedFile: () => void;
}

export const fileStore = create<FileStoreState>(set => ({
  files: [],
  statsMap: {},
  isInitialized: false,
  updateListFiles: (name: string) =>
    set(state => ({
      files: [...state.files, name],
      statsMap: {
        ...state.statsMap,
        [name]: { mtime: Date.now(), birthtime: Date.now() },
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
  setSelectedFile: (file: File) => set({ selectedFile: file }),
  fileIsEdited: false,
  editedFile: () =>
    set(state => ({ fileIsEdited: !state.fileIsEdited })),
}));
