import { invoke } from "@tauri-apps/api/core";
import { configStore } from "../store/configStore.ts";
import { fileStore } from "../store/fileStore.ts";
import { removeVisibleNamesForPath } from "./visibleNames.ts";

const PENDING_KEY = "lyra_pending_deleted_cleanup_v1";

interface PendingCleanup {
  folders: string[];
  files: string[];
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(v => typeof v === "string" && v.length > 0))).sort();
}

function readPending(): PendingCleanup {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return { folders: [], files: [] };
    const parsed = JSON.parse(raw) as Partial<PendingCleanup>;
    return {
      folders: unique(Array.isArray(parsed.folders) ? parsed.folders : []),
      files: unique(Array.isArray(parsed.files) ? parsed.files : []),
    };
  } catch {
    return { folders: [], files: [] };
  }
}

function writePending(pending: PendingCleanup): void {
  const folders = unique(pending.folders);
  const files = unique(pending.files);
  if (folders.length === 0 && files.length === 0) {
    window.localStorage.removeItem(PENDING_KEY);
    return;
  }
  window.localStorage.setItem(PENDING_KEY, JSON.stringify({ folders, files }));
}

export function markPendingDeletedCleanup(deletedFolders: readonly string[], deletedFiles: readonly string[]): void {
  const current = readPending();
  writePending({
    folders: unique([...current.folders, ...deletedFolders]),
    files: unique([...current.files, ...deletedFiles]),
  });
}

function isUnder(path: string, roots: readonly string[]): boolean {
  return roots.some(root => path === root || path.startsWith(`${root}/`));
}

function pruneRecordKeys(map: Record<string, unknown>, roots: readonly string[]): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!isUnder(key, roots)) next[key] = value;
  }
  return next;
}

function readJsonRecord(key: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJsonRecord(key: string, value: Record<string, unknown>): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function cleanupInMemoryAndPrefs(deletedFolders: readonly string[], deletedFiles: readonly string[]): void {
  const folderRoots = unique(deletedFolders);
  const fileRoots = unique(deletedFiles);
  if (folderRoots.length === 0 && fileRoots.length === 0) return;

  for (const folder of folderRoots) {
    try { removeVisibleNamesForPath(folder, "folder", true); } catch { /* ignore */ }
  }
  for (const file of fileRoots) {
    try { removeVisibleNamesForPath(file, "file", false); } catch { /* ignore */ }
  }

  for (const key of ["folderExpanded", "folderOrder", "fileOrder", "folderColors", "folderTextColors", "folderIconColors", "folderIcons", "noteVisibleNames", "folderVisibleNames"]) {
    const rec = readJsonRecord(key);
    if (!rec) continue;
    let next: Record<string, unknown>;
    if (key === "folderOrder" || key === "fileOrder") {
      next = {};
      for (const [parent, entries] of Object.entries(rec)) {
        if (isUnder(parent, folderRoots)) continue;
        if (Array.isArray(entries)) {
          next[parent] = entries.filter((entry): entry is string => typeof entry === "string" && !isUnder(entry, folderRoots) && !fileRoots.includes(entry));
        } else {
          next[parent] = entries;
        }
      }
    } else {
      next = pruneRecordKeys(rec, [...folderRoots, ...fileRoots]);
    }
    if (JSON.stringify(next) !== JSON.stringify(rec)) writeJsonRecord(key, next);
  }

  try {
    const paperRaw = window.localStorage.getItem("paper");
    if (paperRaw) {
      const parsed = JSON.parse(paperRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((name): name is string => typeof name === "string" && !fileRoots.includes(name) && !isUnder(name, folderRoots));
        window.localStorage.setItem("paper", JSON.stringify(next));
      }
    }
  } catch { /* ignore */ }

  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      for (const file of fileRoots) {
        if (key.includes(file)) { keysToRemove.push(key); break; }
      }
      if (!keysToRemove.includes(key)) {
        for (const folder of folderRoots) {
          if (key.includes(`${folder}/`)) { keysToRemove.push(key); break; }
        }
      }
    }
    for (const key of Array.from(new Set(keysToRemove))) window.localStorage.removeItem(key);
  } catch { /* best effort */ }

  fileStore.setState(state => {
    const deletedFileSet = new Set(fileRoots);
    const nextStats = { ...state.statsMap };
    for (const file of Object.keys(nextStats)) {
      if (deletedFileSet.has(file) || isUnder(file, folderRoots)) delete nextStats[file];
    }
    const selectedInsideDeleted = state.selectedFile.name && (deletedFileSet.has(state.selectedFile.name) || isUnder(state.selectedFile.name, folderRoots));
    return {
      files: state.files.filter(f => !deletedFileSet.has(f) && !isUnder(f, folderRoots)),
      folders: state.folders.filter(f => !isUnder(f, folderRoots)),
      archivedFolders: state.archivedFolders.filter(f => !isUnder(f, folderRoots)),
      statsMap: nextStats,
      selectedFile: selectedInsideDeleted ? { name: "", content: "" } : state.selectedFile,
      listingGeneration: state.listingGeneration + 1,
      fileIsEdited: !state.fileIsEdited,
    };
  });

  configStore.getState().bumpPrefTick();
}

export function cleanupAfterDeletedPaths(deletedFolders: readonly string[], deletedFiles: readonly string[]): void {
  const folders = unique(deletedFolders);
  const files = unique(deletedFiles);
  // Persist pending cleanup so a restart before prefs cleanup can reconcile safely.
  markPendingDeletedCleanup(folders, files);
  cleanupInMemoryAndPrefs(folders, files);
  // Clear only processed paths from pending queue.
  const pending = readPending();
  writePending({
    folders: pending.folders.filter(p => !folders.includes(p)),
    files: pending.files.filter(p => !files.includes(p)),
  });
}

export async function reconcilePendingDeletedCleanup(): Promise<void> {
  const pending = readPending();
  if (pending.folders.length === 0 && pending.files.length === 0) return;

  let existingSet: Set<string>;
  try {
    const existing = await invoke<string[]>("filter_existing_relative_paths", {
      paths: [...pending.folders, ...pending.files],
    });
    existingSet = new Set(existing);
  } catch {
    // Cannot determine safely now; keep pending for a later startup.
    return;
  }

  // Paths that exist now may be reused by new elements: never clean their prefs.
  const reusableFolders = pending.folders.filter(p => existingSet.has(p));
  const reusableFiles = pending.files.filter(p => existingSet.has(p));
  const safeFolders = pending.folders.filter(p => !existingSet.has(p));
  const safeFiles = pending.files.filter(p => !existingSet.has(p));

  if (safeFolders.length > 0 || safeFiles.length > 0) {
    cleanupInMemoryAndPrefs(safeFolders, safeFiles);
  }

  // Drop pending entries that are either cleaned (deleted) or now reused by existing items.
  const remaining = readPending();
  const done = new Set([...safeFolders, ...safeFiles, ...reusableFolders, ...reusableFiles]);
  writePending({
    folders: remaining.folders.filter(p => !done.has(p)),
    files: remaining.files.filter(p => !done.has(p)),
  });
}
