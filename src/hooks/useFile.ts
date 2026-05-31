import useStorage from "./useStorage";
import { BASE_DIRECTORY, MAIN_FOLDER, PAGES } from "../utils/consts";
import { fileStore } from "../store/fileStore";
import { join } from "@tauri-apps/api/path";
import { navigation } from "../utils/helpers";
import {
  exists,
  FileEntry,
  readDir,
  readTextFile,
  removeFile as remove,
  renameFile as rename,
  writeTextFile,
} from "@tauri-apps/api/fs";

function useFile(): Files {
  const { goTo } = navigation();
  const editedFile = fileStore(state => state.editedFile);
  const DRAFT_STORAGE_PREFIX = "lyra-draft";

  function getDraftKey(name: string): string {
    return `${DRAFT_STORAGE_PREFIX}:${name}`;
  }

  async function getFilePath(fileName: string): Promise<{ pathFile: string }> {
    if (!fileName) throw new Error("File name is required");
    const pathFile: string = await join(MAIN_FOLDER, `${fileName}.txt`);
    return { pathFile };
  }

  async function renameFile(oldName: string, newName: string): Promise<void> {
    if (!oldName || !newName) throw new Error("Both old and new names are required");
    const { pathFile: oldPath } = await getFilePath(oldName);
    const { pathFile: newPath } = await getFilePath(newName);
    await rename(oldPath, newPath, BASE_DIRECTORY);

    const oldDraftKey: string = getDraftKey(oldName);
    const newDraftKey: string = getDraftKey(newName);
    const draftValue: string | null = window.localStorage.getItem(oldDraftKey);
    if (draftValue !== null) {
      window.localStorage.setItem(newDraftKey, draftValue);
      window.localStorage.removeItem(oldDraftKey);
    }

    editedFile();
  }

  async function deleteFile(name: string): Promise<void> {
    if (!name) throw new Error("File name is required");
    const { removeItem } = useStorage();
    const { pathFile } = await getFilePath(name);
    removeItem(name);
    removeItem(getDraftKey(name));
    await remove(pathFile, BASE_DIRECTORY);
  }

  async function createFile(name: string, content: string = ""): Promise<void> {
    if (!name) throw new Error("File name is required");
    await writeFile(name, content);
  }

  async function getFiles(): Promise<string[]> {
    let dir: any[] = await readDir(MAIN_FOLDER, BASE_DIRECTORY);
    dir = dir.map((f: FileEntry) => f.name?.split(".txt")[0]);
    dir = dir.sort((a: string, b: string) => a.localeCompare(b));
    return dir;
  }

  async function fileExists(name: string): Promise<boolean> {
    const { pathFile } = await getFilePath(name);
    const file: boolean = await exists(pathFile, BASE_DIRECTORY);
    return file;
  }

  async function saveFileContent(name: string, content: string): Promise<void> {
    if (!name) {
      goTo(PAGES.list);
      return;
    }

    await writeFile(name, content);
  }

  async function readFile(name: string): Promise<string> {
    const { pathFile } = await getFilePath(name);
    const content: string = await readTextFile(pathFile, BASE_DIRECTORY);
    return content;
  }

  async function writeFile(name: string, text: string): Promise<void> {
    const { pathFile } = await getFilePath(name);
    await writeTextFile(pathFile, text, BASE_DIRECTORY);
  }

  return {
    readFile,
    renameFile,
    deleteFile,
    createFile,
    getFiles,
    saveFileContent,
    fileExists,
    getFilePath,
    writeFile,
  };
}

export default useFile;

interface Files {
  renameFile: (oldName: string, newName: string) => Promise<void>;
  deleteFile: (name: string) => Promise<void>;
  createFile: (name: string, content?: string) => Promise<void>;
  getFiles: () => Promise<string[]>;
  fileExists: (name: string) => Promise<boolean>;
  saveFileContent: (name: string, content: string) => Promise<void>;
  getFilePath: (fileName: string) => Promise<{ pathFile: string }>;
  readFile: (name: string) => Promise<string>;
  writeFile: (name: string, text: string) => Promise<void>;
}
