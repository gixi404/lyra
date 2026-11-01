const activeDeletions = new Set<string>();

export function isDeletionInProgress(name: string): boolean {
  return activeDeletions.has(name);
}

export interface DeletionCallbacks {
  setBusy: (busy: boolean) => void;
  retain: (name: string) => void;
  release: (name: string) => void;
  deleteNote: (name: string) => Promise<void>;
  confirmed: (name: string) => void;
  failed: (error: unknown) => void;
}

export async function runExclusiveDeletion(
  name: string,
  callbacks: DeletionCallbacks,
): Promise<void> {
  if (activeDeletions.has(name)) return;
  activeDeletions.add(name);
  try {
    callbacks.setBusy(true);
    callbacks.retain(name);
    try {
      await callbacks.deleteNote(name);
    } catch (error) {
      callbacks.release(name);
      callbacks.failed(error);
      return;
    }
    callbacks.confirmed(name);
  } finally {
    activeDeletions.delete(name);
    callbacks.setBusy(false);
  }
}
