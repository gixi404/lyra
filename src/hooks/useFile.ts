import { useCallback } from "react";
import useStorage from "./useStorage";
import { BASE_DIRECTORY, INTRO_ES, MAIN_FOLDER, PAGES } from "../utils/consts";
import { fileStore, type FileItemStats } from "../store/fileStore";
import { clearDetachedSaveFailure, moveDetachedSaveFailure } from "../utils/editorPersistence";
import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import {
  getCompatibleStorageKeys,
  navigation,
  normalizeStoredFileNames,
  resolveDisplayFileName,
} from "../utils/helpers";
import { handleWelcomeFileDeleted, isWelcomeFileName } from "../utils/welcome";
import { ensureNoteExtension, getFileBaseName, getFileDirectory, hasSupportedNoteExtension } from "../utils/noteName";
import {
  DirEntry,
  exists,
  readDir,
  readTextFile,
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

  async function renameFile(oldName: string, newName: string): Promise<string> {
    if (!oldName || !newName) throw new Error("Both old and new names are required");
    const oldDir = getFileDirectory(oldName);
    const resolvedBase = resolveDisplayName(getFileBaseName(newName), getFileBaseName(oldName));
    const nextDisplayName: string = newName.includes("/")
      ? newName
      : (oldDir ? `${oldDir}/${resolvedBase}` : resolvedBase);

    if (oldName !== nextDisplayName) {
      const existsAlready = await fileExists(nextDisplayName);
      if (existsAlready) {
        throw new Error(`File "${nextDisplayName}" already exists`);
      }
    }
    await invoke("gdrive_note_renamed", { oldName, newName: nextDisplayName });

    moveCompatibleValue(oldName, nextDisplayName, "", DRAFT_STORAGE_PREFIX);
    moveCompatibleValue(oldName, nextDisplayName, "-modified");
    moveCompatibleValue(oldName, nextDisplayName, "-scroll");
    syncPaperState(oldName, nextDisplayName);
    moveDetachedSaveFailure(oldName, nextDisplayName);

    editedFile();
    return nextDisplayName;
  }

  async function deleteFile(name: string): Promise<void> {
    if (!name) throw new Error("File name is required");
    if (isWelcomeFileName(name)) {
      handleWelcomeFileDeleted(name);
    }
    // Eliminación autoritativa e íntegra vía gdrive_delete_file (registra tombstone antes del borrado físico).
    // No se utiliza fallback que omita el tombstone, garantizando que no haya desincronizaciones ni resurrecciones.
    await invoke("gdrive_delete_file", { fileName: name });
    removeCompatibleKeys(name, "", DRAFT_STORAGE_PREFIX);
    removeCompatibleKeys(name, "-modified");
    removeCompatibleKeys(name, "-scroll");
    syncPaperState(name);
    clearDetachedSaveFailure(name);
  }

  const createFile = useCallback(async (name: string, content: string = ""): Promise<string> => {
    if (!name) throw new Error("File name is required");
    const displayName: string = ensureNoteExtension(name);
    const isTauri = typeof window !== "undefined" &&
      Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
    if (isTauri) {
      await invoke("create_note", { fileName: displayName, content });
    } else {
      const { pathFile } = await getFilePath(displayName);
      await writeTextFile(pathFile, content, { createNew: true, baseDir: BASE_DIRECTORY.baseDir });
    }

    return displayName;
  }, [getFilePath]);

  const getFiles = useCallback(async (): Promise<string[]> => {
    const isTauri = typeof window !== "undefined" &&
      Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
    if (isTauri) {
      const listing = await invoke<{ files: string[]; stats: Record<string, FileItemStats> }>("list_note_files_with_stats");
      return listing.files;
    }
    const readSubdir = async (folder: string, prefix = ""): Promise<string[]> => {
      const dir: DirEntry[] = await readDir(folder, BASE_DIRECTORY);
      const res: string[] = [];
      for (const f of dir) {
        if (f.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.isFile && hasSupportedNoteExtension(f.name)) {
          res.push(rel);
        } else if (f.isDirectory) {
          try {
            const sub = await readSubdir(`${folder}/${f.name}`, rel);
            res.push(...sub);
          } catch {}
        }
      }
      return res;
    };
    const files = await readSubdir(MAIN_FOLDER);
    return files.sort((a, b) => a.localeCompare(b));
  }, []);

  const getFilesWithStats = useCallback(async (): Promise<{ files: string[]; stats: Record<string, FileItemStats> }> => {
    const isTauri = typeof window !== "undefined" &&
      Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
    if (isTauri) {
      return invoke<{ files: string[]; stats: Record<string, FileItemStats> }>("list_note_files_with_stats");
    }
    const readSubdir = async (
      folder: string,
      prefix = ""
    ): Promise<Array<{ rel: string; mtime: number; birthtime: number }>> => {
      const dir: DirEntry[] = await readDir(folder, BASE_DIRECTORY);
      const res: Array<{ rel: string; mtime: number; birthtime: number }> = [];
      for (const f of dir) {
        if (f.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.isFile && hasSupportedNoteExtension(f.name)) {
          let mtime = 0;
          let birthtime = 0;
          try {
            const { pathFile } = await getFilePath(rel);
            const st = await stat(pathFile, BASE_DIRECTORY);
            mtime = st.mtime ? new Date(st.mtime).getTime() : 0;
            birthtime = st.birthtime ? new Date(st.birthtime).getTime() : mtime;
          } catch {}
          res.push({ rel, mtime, birthtime });
        } else if (f.isDirectory) {
          try {
            const sub = await readSubdir(`${folder}/${f.name}`, rel);
            res.push(...sub);
          } catch {}
        }
      }
      return res;
    };

    const items = await readSubdir(MAIN_FOLDER);
    const validNames = items.map(i => i.rel).sort((a, b) => a.localeCompare(b));
    const stats: Record<string, FileItemStats> = {};
    for (const item of items) {
      stats[item.rel] = { mtime: item.mtime, birthtime: item.birthtime };
    }

    return { files: validNames, stats };
  }, [getFilePath]);

  const fileExists = useCallback(async (name: string): Promise<boolean> => {
    const { pathFile } = await getFilePath(name);
    const file: boolean = await exists(pathFile, BASE_DIRECTORY);
    return file;
  }, [getFilePath]);

  const writeFile = useCallback(async (name: string, text: string): Promise<void> => {
    const isTauri =
      typeof window !== "undefined" &&
      Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

    if (isTauri) {
      // En entorno de producción de Tauri, se invoca save_note_atomic directamente sin capturar ni enmascarar errores.
      // Si falla (I/O, disco lleno, ruta insegura o symlink), el error debe propagarse directamente a
      // EditorSyncCoordinator para retener el borrador en localStorage y disparar onSaveError sin degradar a escrituras no atómicas.
      await invoke("save_note_atomic", { fileName: name, content: text });
      return;
    }

    // En entornos fuera de Tauri (ej. pruebas unitarias en Node/jsdom sin IPC nativo), usar writeTextFile
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
    let content: string = await readTextFile(pathFile, BASE_DIRECTORY);
    if (
      isWelcomeFileName(name) &&
      (content.includes("<p>") || (content.includes("&oacute;") && content.includes("&ntilde;")))
    ) {
      content = INTRO_ES;
      try {
        await writeTextFile(pathFile, INTRO_ES, BASE_DIRECTORY);
      } catch (err) {
        console.warn("Could not overwrite legacy welcome file on disk:", err);
      }
    }
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

  const getFileStats = useCallback(async (fileName: string): Promise<FileStats> => {
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
  }, [getFilePath, getItem, readFile]);

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
    getFilesWithStats,
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
  getFilesWithStats: () => Promise<{ files: string[]; stats: Record<string, FileItemStats> }>;
  fileExists: (name: string) => Promise<boolean>;
  saveFileContent: (name: string, content: string) => Promise<void>;
  getFilePath: (fileName: string) => Promise<{ pathFile: string }>;
  readFile: (name: string) => Promise<string>;
  resolveDisplayName: (fileName: string, currentName?: string) => string;
  writeFile: (name: string, text: string) => Promise<void>;
  getFileStats: (fileName: string) => Promise<FileStats>;
  getFileMtime: (fileName: string) => Promise<number | null>;
}
