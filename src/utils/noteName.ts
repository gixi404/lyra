export const HIDDEN_NOTE_EXTENSIONS = [".txt", ".md"] as const;

export const SUPPORTED_NOTE_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".log",
  ".html",
  ".htm",
  ".xml",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rs",
  ".sh",
  ".sql",
] as const;

export type SupportedNoteExtension = (typeof SUPPORTED_NOTE_EXTENSIONS)[number];

export function hasSupportedNoteExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_NOTE_EXTENSIONS.some(extension => lower.endsWith(extension));
}

export function ensureNoteExtension(fileName: string, currentName?: string): string {
  if (hasSupportedNoteExtension(fileName)) return fileName;
  if (currentName) {
    const lowerCurrent = currentName.toLowerCase();
    const existingExt = SUPPORTED_NOTE_EXTENSIONS.find(ext => lowerCurrent.endsWith(ext));
    if (existingExt) {
      const originalExt = currentName.slice(-existingExt.length);
      return `${fileName}${originalExt}`;
    }
  }
  return `${fileName}.txt`;
}

export function getFileDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash !== -1 ? normalized.slice(0, lastSlash) : "";
}

export function getFileBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash !== -1 ? normalized.slice(lastSlash + 1) : normalized;
}

export function noteTitle(fileName: string): string {
  const baseName = getFileBaseName(fileName);
  const lower = baseName.toLowerCase();
  const extension = HIDDEN_NOTE_EXTENSIONS.find(value => lower.endsWith(value));
  return extension && baseName.length > extension.length
    ? baseName.slice(0, -extension.length)
    : baseName;
}

export function getLegacyFileName(fileName: string): string {
  const dir = getFileDirectory(fileName);
  const baseTitle = noteTitle(getFileBaseName(fileName));
  return dir ? `${dir}/${baseTitle}` : baseTitle;
}

export function resolveStoredFileName(fileName: string, files: string[]): string | null {
  if (files.includes(fileName)) return fileName;
  if (hasSupportedNoteExtension(fileName)) return null;

  for (const ext of SUPPORTED_NOTE_EXTENSIONS) {
    const candidate = `${fileName}${ext}`;
    if (files.includes(candidate)) return candidate;
  }

  return null;
}

export function normalizeStoredFileNames(fileNames: string[], files: string[]): string[] {
  const normalizedNames = fileNames
    .map(fileName => resolveStoredFileName(fileName, files))
    .filter((fileName): fileName is string => Boolean(fileName));

  return Array.from(new Set(normalizedNames));
}

export const RESERVED_WINDOWS_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function isReservedWindowsFileName(name: string): boolean {
  const stem = (name.split(".")[0] ?? "").trim().toUpperCase();
  return RESERVED_WINDOWS_NAMES.has(stem);
}

export function noteLabel(fileName: string): string {
  return `«${noteTitle(fileName)}»`;
}

export type NoteSuccessAction = "archived" | "recovered" | "deleted" | "renamed";

export function noteSuccessMessage(fileName: string, action: NoteSuccessAction): string {
  const verbs: Record<NoteSuccessAction, string> = {
    archived: "archivó",
    recovered: "recuperó",
    deleted: "eliminó",
    renamed: "renombró",
  };
  return `${noteLabel(fileName)} se ${verbs[action]}`;
}
