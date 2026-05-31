import useStorage from "./useStorage";
import { BASE_DIRECTORY, MAIN_FOLDER, PAGES } from "../utils/consts";
import { fileStore } from "../store/fileStore";
import { join } from "@tauri-apps/api/path";
import {
  getCompatibleStorageKeys,
  navigation,
  normalizeStoredFileNames,
  resolveDisplayFileName,
} from "../utils/helpers";
import {
  exists,
  FileEntry,
  readDir,
  readTextFile,
  removeFile as remove,
  renameFile as rename,
  writeTextFile,
} from "@tauri-apps/api/fs";

const DRAFT_STORAGE_PREFIX = "lyra-draft";

function useFile(): Files {
  const { goTo } = navigation();
  const { getItem, removeItem, setItem } = useStorage();
  const editedFile = fileStore(state => state.editedFile);
  const files = fileStore(state => state.files);

  function resolveDisplayName(fileName: string, currentName?: string): string {
    return resolveDisplayFileName(fileName, currentName);
  }

  function resolveFileName(fileName: string): string {
    return resolveDisplayName(fileName);
  }

  async function getFilePath(fileName: string): Promise<{ pathFile: string }> {
    if (!fileName) throw new Error("File name is required");
    const pathFile: string = await join(MAIN_FOLDER, resolveFileName(fileName));
    return { pathFile };
  }

  async function getRenamedFilePath(oldName: string, newName: string): Promise<string> {
    const nextName: string = resolveDisplayName(newName, oldName);

    return join(MAIN_FOLDER, nextName);
  }

  async function renameFile(oldName: string, newName: string): Promise<string> {
    if (!oldName || !newName) throw new Error("Both old and new names are required");
    const { pathFile: oldPath } = await getFilePath(oldName);
    const nextDisplayName: string = resolveDisplayName(newName, oldName);
    const newPath: string = await getRenamedFilePath(oldName, newName);
    await rename(oldPath, newPath, BASE_DIRECTORY);

    moveCompatibleValue(oldName, nextDisplayName, "", DRAFT_STORAGE_PREFIX);
    moveCompatibleValue(oldName, nextDisplayName, "-modified");
    moveCompatibleValue(oldName, nextDisplayName, "-scroll");
    syncPaperState(oldName, nextDisplayName);

    editedFile();
    return nextDisplayName;
  }

  async function deleteFile(name: string): Promise<void> {
    if (!name) throw new Error("File name is required");
    const { pathFile } = await getFilePath(name);
    removeCompatibleKeys(name, "", DRAFT_STORAGE_PREFIX);
    removeCompatibleKeys(name, "-modified");
    removeCompatibleKeys(name, "-scroll");
    syncPaperState(name);
    await remove(pathFile, BASE_DIRECTORY);
  }

  async function createFile(name: string, content: string = ""): Promise<string> {
    if (!name) throw new Error("File name is required");
    await writeFile(name, content);
    return resolveDisplayName(name);
  }

  async function getFiles(): Promise<string[]> {
    let dir: any[] = await readDir(MAIN_FOLDER, BASE_DIRECTORY);
    dir = dir
      .map((f: FileEntry) => f.name)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          [".txt", ".md"].some(extension => name.endsWith(extension))
      )
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

  function getFirstCompatibleValue(fileName: string, suffix: string = "", prefix: string = ""): string | null {
    const storageKeys: string[] = getCompatibleStorageKeys(fileName, suffix, prefix);
    for (const key of storageKeys) {
      const value: string | null = window.localStorage.getItem(key);
      if (value !== null) return value;
    }

    return null;
  }

  function removeCompatibleKeys(fileName: string, suffix: string = "", prefix: string = ""): void {
    getCompatibleStorageKeys(fileName, suffix, prefix).forEach(key => removeItem(key));
  }

  function moveCompatibleValue(oldName: string, newName: string, suffix: string = "", prefix: string = ""): void {
    const value: string | null = getFirstCompatibleValue(oldName, suffix, prefix);
    removeCompatibleKeys(oldName, suffix, prefix);
    removeCompatibleKeys(newName, suffix, prefix);

    if (value !== null) {
      const [targetKey] = getCompatibleStorageKeys(newName, suffix, prefix);
      setItem(targetKey, value);
    }
  }

  function syncPaperState(oldName: string, nextName?: string): void {
    const rawPaper: string[] = JSON.parse(getItem("paper", "[]")) as string[];
    const normalizedPaper: string[] = normalizeStoredFileNames(rawPaper, files);
    const updatedPaper: string[] = normalizedPaper
      .map(fileName => (fileName === oldName && nextName ? nextName : fileName))
      .filter(fileName => fileName !== oldName || Boolean(nextName));

    setItem("paper", JSON.stringify(Array.from(new Set(updatedPaper))));
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
    resolveDisplayName,
    writeFile,
  };
}

export default useFile;

interface Files {
  renameFile: (oldName: string, newName: string) => Promise<string>;
  deleteFile: (name: string) => Promise<void>;
  createFile: (name: string, content?: string) => Promise<string>;
  getFiles: () => Promise<string[]>;
  fileExists: (name: string) => Promise<boolean>;
  saveFileContent: (name: string, content: string) => Promise<void>;
  getFilePath: (fileName: string) => Promise<{ pathFile: string }>;
  readFile: (name: string) => Promise<string>;
  resolveDisplayName: (fileName: string, currentName?: string) => string;
  writeFile: (name: string, text: string) => Promise<void>;
}
