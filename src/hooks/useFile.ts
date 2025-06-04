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
  const { editedFile } = fileStore();

  async function getFilePath(fileName: string): Promise<{ pathFile: string }> {
    if (!fileName) Promise.reject();
    const pathFile: string = await join(MAIN_FOLDER, `${fileName}.txt`);
    return { pathFile };
  }

  async function renameFile(oldName: string, newName: string): Promise<void> {
    if (!oldName || !newName) Promise.reject();
    const { pathFile: oldPath } = await getFilePath(oldName);
    const { pathFile: newPath } = await getFilePath(newName);
    rename(oldPath, newPath, BASE_DIRECTORY);
    editedFile();
  }

  async function deleteFile(name: string): Promise<void> {
    if (!name) Promise.reject();
    const { removeItem } = useStorage();
    const { pathFile } = await getFilePath(name);
    removeItem(name);
    remove(pathFile, BASE_DIRECTORY);
  }

  function createFile(name: string): void {
    if (!name) Promise.reject();
    else writeFile(name, "");
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

  function saveFileContent(name: string, content: string): void {
    if (!name) Promise.resolve(goTo(PAGES.list));
    else writeFile(name, content);
  }

  async function readFile(name: string): Promise<string> {
    const { pathFile } = await getFilePath(name);
    const content: string = await readTextFile(pathFile, BASE_DIRECTORY);
    return content;
  }

  async function writeFile(name: string, text: string): Promise<void> {
    const { pathFile } = await getFilePath(name);
    writeTextFile(pathFile, text, BASE_DIRECTORY);
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
  createFile: (name: string) => void;
  getFiles: () => Promise<string[]>;
  fileExists: (name: string) => Promise<boolean>;
  saveFileContent: (name: string, content: string) => void;
  getFilePath: (fileName: string) => Promise<{ pathFile: string }>;
  readFile: (name: string) => Promise<string>;
  writeFile: (name: string, text: string) => Promise<void>;
}
