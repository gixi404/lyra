/** Keep note-specific browser state separate even when workspaces share names. */
export function workspaceNoteKeys(
  names: string[], suffix: string, prefix: string, workspaceId: string | null,
  legacyWorkspaceId: string | null,
): string[] {
  const legacy = names.map(name => `${prefix ? `${prefix}:` : ""}${name}${suffix}`);
  if (!workspaceId) return legacy;
  const scoped = legacy.map(key => `lyra-workspace:${workspaceId}:${key}`);
  // F1 drafts and scroll state belonged to the first migrated workspace.
  return workspaceId === legacyWorkspaceId ? [...scoped, ...legacy] : scoped;
}
