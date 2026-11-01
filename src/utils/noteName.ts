export const SUPPORTED_NOTE_EXTENSIONS = [".txt", ".md"] as const;

export function hasSupportedNoteExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_NOTE_EXTENSIONS.some(extension => lower.endsWith(extension));
}

export function ensureNoteExtension(fileName: string, currentName?: string): string {
  if (hasSupportedNoteExtension(fileName)) return fileName;
  if (currentName?.toLowerCase().endsWith(".md")) return `${fileName}.md`;
  return `${fileName}.txt`;
}

export function noteTitle(fileName: string): string {
  const lower = fileName.toLowerCase();
  const extension = SUPPORTED_NOTE_EXTENSIONS.find(value => lower.endsWith(value));
  return extension && fileName.length > extension.length
    ? fileName.slice(0, -extension.length)
    : fileName;
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
