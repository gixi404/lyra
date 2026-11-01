/** Browser drafts cannot be moved by Rust; require them to be resolved first. */
export function workspaceHasPendingDrafts(
  keys: Iterable<string>, workspaceId: string, legacyWorkspaceId: string | null,
): boolean {
  const scopedPrefix = `lyra-workspace:${workspaceId}:lyra-draft:`;
  for (const key of keys) {
    if (key.startsWith(scopedPrefix) ||
        (workspaceId === legacyWorkspaceId && key.startsWith("lyra-draft:"))) {
      return true;
    }
  }
  return false;
}
