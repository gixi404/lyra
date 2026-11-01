import { isContentEquivalent, writeUniqueRecoveryFile } from "./draftRecovery.ts";
import { noteTitle } from "./noteName.ts";

export interface DraftRescueStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export interface DraftRescueFiles {
  createExclusive(name: string, content: string): Promise<void>;
  read(name: string): Promise<string>;
  exists(name: string): Promise<boolean>;
}

/** Rescue old name-based drafts before a conflicting destination can be edited. */
export async function rescueMigratedDrafts(
  conflictNames: string[],
  storage: DraftRescueStorage,
  files: DraftRescueFiles,
): Promise<string[]> {
  const rescued: string[] = [];
  for (const name of new Set(conflictNames)) {
    for (const key of new Set([`lyra-draft:${name}`, `lyra-draft:${noteTitle(name)}`])) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      let content: string;
      try {
        const payload: unknown = JSON.parse(raw);
        if (!payload || typeof payload !== "object" ||
            typeof (payload as { content?: unknown }).content !== "string") {
          throw new Error("Invalid draft payload");
        }
        content = (payload as { content: string }).content;
      } catch {
        throw new Error(`No se pudo leer el borrador pendiente de «${name}»`);
      }

      const recovered = await writeUniqueRecoveryFile(
        name,
        content,
        files.createExclusive,
        files.exists,
      );
      if (!isContentEquivalent(await files.read(recovered), content)) {
        throw new Error(`No se pudo verificar el rescate del borrador de «${name}»`);
      }
      storage.removeItem(key);
      rescued.push(recovered);
    }
  }
  return rescued;
}
