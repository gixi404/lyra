import { remapNoteEOL } from "./eol.ts";

interface OpenedIdentity { id: string; firstSeen: boolean; pathReused: boolean }
const openedIdentities = new Map<string, OpenedIdentity>();
const pendingDraftConflicts = new Set<string>();

export function rememberNoteIdentity(path: string, identity: string, firstSeen = false, pathReused = false): void {
  openedIdentities.set(path, { id: identity, firstSeen, pathReused });
}

export function getOpenedNoteIdentity(path: string): string | undefined {
  return openedIdentities.get(path)?.id;
}

export function canAttachDraft(path: string, identity?: string): boolean {
  if (typeof window === "undefined" || !(window.__TAURI_INTERNALS__ || window.__TAURI__)) return true;
  const opened = openedIdentities.get(path);
  if (identity && opened?.id === identity) return true;
  if (identity || !opened) { pendingDraftConflicts.add(path); return false; }
  const key = `lyra-untrusted-legacy-draft:${path}`;
  if (opened.pathReused || opened.firstSeen || window.localStorage.getItem(key) === "1") {
    window.localStorage.setItem(key, "1");
    pendingDraftConflicts.add(path);
    return false;
  }
  return true;
}

export function takeDraftIdentityConflict(path: string): boolean {
  return pendingDraftConflicts.delete(path);
}

export function remapOpenedNoteIdentities(changes: ReadonlyArray<{ oldPath: string; newPath: string }>): void {
  for (const { oldPath, newPath } of changes) {
    const identity = openedIdentities.get(oldPath);
    if (identity) {
      openedIdentities.delete(oldPath);
      openedIdentities.set(newPath, { ...identity, firstSeen: false, pathReused: false });
      remapNoteEOL(oldPath, newPath, identity.id);
    } else {
      remapNoteEOL(oldPath, newPath);
    }
  }
}
