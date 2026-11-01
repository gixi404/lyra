export interface BatchDeletionResult {
  deleted: string[];
  failed: { name: string; error: unknown }[];
}

export async function deleteArchivedBatch(
  names: string[],
  deleteNote: (name: string) => Promise<void>,
  retain: (name: string) => void,
  release: (name: string) => void,
): Promise<BatchDeletionResult> {
  const result: BatchDeletionResult = { deleted: [], failed: [] };
  for (const name of names) {
    retain(name);
    try {
      await deleteNote(name);
      result.deleted.push(name);
    } catch (error) {
      release(name);
      result.failed.push({ name, error });
    }
  }
  return result;
}
