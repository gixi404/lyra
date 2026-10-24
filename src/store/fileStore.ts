import { create } from "zustand";
import type { File } from "../utils/types";

export interface FileStoreState {
  files: string[];
  updateListFiles: (name: string) => void;
  setFiles: (names: string[]) => void;
  removeFileFromList: (name: string) => void;
  selectedFile: File;
  setSelectedFile: (file: File) => void;
  fileIsEdited: boolean;
  editedFile: () => void;
}

export const fileStore = create<FileStoreState>(set => ({
  files: [],
  updateListFiles: (name: string) =>
    set(state => ({ files: [...state.files, name] })),
  setFiles: (names: string[]) => set({ files: names }),
  removeFileFromList: (name: string) =>
    set(state => ({
      files: state.files.filter((f: string) => f !== name),
    })),
  selectedFile: { name: "", content: "" },
  setSelectedFile: (file: File) => set({ selectedFile: file }),
  fileIsEdited: false,
  editedFile: () =>
    set(state => ({ fileIsEdited: !state.fileIsEdited })),
}));
