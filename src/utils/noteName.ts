export const SUPPORTED_NOTE_EXTENSIONS = [".txt", ".md"] as const;

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
