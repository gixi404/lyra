import { useCallback } from "react";
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
  DirEntry,
  exists,
  open,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const DRAFT_STORAGE_PREFIX = "lyra-draft";

function resolveDisplayName(fileName: string, currentName?: string): string {
  return resolveDisplayFileName(fileName, currentName);
}

function resolveFileName(fileName: string): string {
  return resolveDisplayName(fileName);
}

function useFile(): Files {
  const { goTo } = navigation();
  const { getItem, removeItem, setItem } = useStorage();
  const editedFile = fileStore(state => state.editedFile);
  const files = fileStore(state => state.files);

  const getFilePath = useCallback(async (fileName: string): Promise<{ pathFile: string }> => {
    if (!fileName) throw new Error("File name is required");
    const pathFile: string = await join(MAIN_FOLDER, resolveFileName(fileName));
    return { pathFile };
  }, []);

  const getRenamedFilePath = useCallback(async (oldName: string, newName: string): Promise<string> => {
    const nextName: string = resolveDisplayName(newName, oldName);
    return join(MAIN_FOLDER, nextName);
  }, []);

  async function renameFile(oldName: string, newName: string): Promise<string> {
    if (!oldName || !newName) throw new Error("Both old and new names are required");
    const nextDisplayName: string = resolveDisplayName(newName, oldName);
    if (oldName !== nextDisplayName) {
      const existsAlready = await fileExists(nextDisplayName);
      if (existsAlready) {
        throw new Error(`File "${nextDisplayName}" already exists`);
      }
    }
    const { pathFile: oldPath } = await getFilePath(oldName);
    const newPath: string = await getRenamedFilePath(oldName, newName);
    const baseDir = BASE_DIRECTORY.baseDir;
    await rename(oldPath, newPath, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });

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
    await remove(pathFile, BASE_DIRECTORY);
    removeCompatibleKeys(name, "", DRAFT_STORAGE_PREFIX);
    removeCompatibleKeys(name, "-modified");
    removeCompatibleKeys(name, "-scroll");
    syncPaperState(name);
  }

  const createFile = useCallback(async (name: string, content: string = ""): Promise<string> => {
    if (!name) throw new Error("File name is required");
    const { pathFile } = await getFilePath(name);

    // Creación atómica mediante O_CREAT | O_EXCL (createNew: true)
    // Evita condiciones de carrera TOCTOU entre comprobación y escritura
    const handle = await open(pathFile, {
      write: true,
      createNew: true,
      baseDir: BASE_DIRECTORY.baseDir,
    });

    try {
      if (content) {
        const encoder = new TextEncoder();
        await handle.write(encoder.encode(content));
      }
    } finally {
      await handle.close();
    }

    return resolveDisplayName(name);
  }, [getFilePath]);

  const getFiles = useCallback(async (): Promise<string[]> => {
    let dir: DirEntry[] = await readDir(MAIN_FOLDER, BASE_DIRECTORY);
    return dir
      .filter((f: DirEntry) => f.isFile && !f.name.startsWith("."))
      .map((f: DirEntry) => f.name)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          [".txt", ".md"].some(extension => name.endsWith(extension))
      )
      .sort((a: string, b: string) => a.localeCompare(b));
  }, []);

  const fileExists = useCallback(async (name: string): Promise<boolean> => {
    const { pathFile } = await getFilePath(name);
    const file: boolean = await exists(pathFile, BASE_DIRECTORY);
    return file;
  }, [getFilePath]);

  const writeFile = useCallback(async (name: string, text: string): Promise<void> => {
    const { pathFile } = await getFilePath(name);
    await writeTextFile(pathFile, text, BASE_DIRECTORY);
  }, [getFilePath]);

  const saveFileContent = useCallback(async (name: string, content: string): Promise<void> => {
    if (!name) {
      goTo(PAGES.list);
      return;
    }

    await writeFile(name, content);
  }, [goTo, writeFile]);

  const readFile = useCallback(async (name: string): Promise<string> => {
    const { pathFile } = await getFilePath(name);
    const content: string = await readTextFile(pathFile, BASE_DIRECTORY);
    return content;
  }, [getFilePath]);

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
    const normalizedPaper: string[] =
      files && files.length > 0
        ? normalizeStoredFileNames(rawPaper, files)
        : rawPaper;
    const updatedPaper: string[] = normalizedPaper
      .map(fileName => (fileName === oldName && nextName ? nextName : fileName))
      .filter(fileName => fileName !== oldName || Boolean(nextName));

    setItem("paper", JSON.stringify(Array.from(new Set(updatedPaper))));
  }

  async function getFileStats(fileName: string): Promise<FileStats> {
    const { pathFile } = await getFilePath(fileName);
    const content = await readFile(fileName);
    let fileStat: { size?: number; birthtime?: Date | number | null; mtime?: Date | number | null } = {};

    try {
      fileStat = await stat(pathFile, BASE_DIRECTORY);
    } catch (err) {
      console.warn("Could not get fs.stat, using content fallback:", err);
    }

    const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
    const extIndex = fileName.lastIndexOf(".");
    const extension = extIndex !== -1 ? fileName.slice(extIndex) : ".txt";

    const contentBytes = new TextEncoder().encode(content).length;
    const size = typeof fileStat.size === "number" ? fileStat.size : contentBytes;
    let sizeFormatted = `${size} B`;
    if (size >= 1024 * 1024) {
      sizeFormatted = `${(size / (1024 * 1024)).toFixed(2)} MB`;
    } else if (size >= 1024) {
      sizeFormatted = `${(size / 1024).toFixed(2)} KB`;
    }

    const formatDate = (dateInput: Date | number | null | undefined): string => {
      if (!dateInput) return "No disponible";
      const d = new Date(dateInput);
      if (isNaN(d.getTime())) return "No disponible";
      const day = d.getDate().toString().padStart(2, "0");
      const month = (d.getMonth() + 1).toString().padStart(2, "0");
      const year = d.getFullYear().toString().slice(-2);
      const hours = d.getHours().toString().padStart(2, "0");
      const minutes = d.getMinutes().toString().padStart(2, "0");
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    };

    const createdAt = formatDate(fileStat.birthtime || fileStat.mtime);
    const modifiedAt = formatDate(fileStat.mtime || fileStat.birthtime);

    const charCount = content.length;
    const paragraphCount = content.trim()
      ? content.split(/\n\s*\n/).filter(p => p.trim().length > 0).length
      : 0;

    const readMins = Math.ceil(wordCount / 200);
    const readingTime =
      wordCount === 0 ? "0 min" : readMins <= 1 ? "< 1 min" : `${readMins} min`;

    const rawPaper: string[] = JSON.parse(getItem("paper", "[]")) as string[];
    const isPaper = rawPaper.includes(fileName);
    const status = isPaper ? "Archivado" : "Activo";

    return {
      createdAt,
      modifiedAt,
      wordCount,
      charCount,
      paragraphCount,
      readingTime,
      sizeFormatted,
      extension,
      status,
    };
  }

  const getFileMtime = useCallback(async (fileName: string): Promise<number | null> => {
    try {
      const { pathFile } = await getFilePath(fileName);
      const fileStat = await stat(pathFile, BASE_DIRECTORY);
      if (fileStat.mtime) {
        return fileStat.mtime instanceof Date
          ? fileStat.mtime.getTime()
          : typeof fileStat.mtime === "number"
          ? fileStat.mtime
          : new Date(fileStat.mtime).getTime();
      }
    } catch {
      return null;
    }
    return null;
  }, [getFilePath]);

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
    getFileStats,
    getFileMtime,
  };
}

export default useFile;

export interface FileStats {
  createdAt: string;
  modifiedAt: string;
  wordCount: number;
  charCount: number;
  paragraphCount: number;
  readingTime: string;
  sizeFormatted: string;
  extension: string;
  status: string;
}

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
  getFileStats: (fileName: string) => Promise<FileStats>;
  getFileMtime: (fileName: string) => Promise<number | null>;
}
