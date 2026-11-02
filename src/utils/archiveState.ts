import { invoke } from "@tauri-apps/api/core";
import { configStore } from "../store/configStore.ts";
import { fileStore } from "../store/fileStore.ts";
import { savePersistentPreferencesNow } from "./persistentPreferences.ts";

export interface ArchiveProjection {
  archivedNames: string[];
  conflictNames: string[];
  revision: number;
}

let appliedRevision = -1;
let nextRequest = 0;
let lastAppliedRequest = -1;
let lastProjection: ArchiveProjection | null = null;

async function applyProjection(projection: ArchiveProjection, request: number): Promise<ArchiveProjection> {
  if (projection.revision < appliedRevision ||
      (projection.revision === appliedRevision && request < lastAppliedRequest)) return lastProjection ?? projection;
  appliedRevision = projection.revision;
  lastAppliedRequest = request;
  lastProjection = projection;
  const next = JSON.stringify(projection.archivedNames);
  if (window.localStorage.getItem("paper") !== next) {
    window.localStorage.setItem("paper", next);
    configStore.getState().bumpPrefTick();
    fileStore.getState().editedFile();
    try {
      await savePersistentPreferencesNow();
    } catch (error) {
      console.warn("Could not update the legacy archive projection", error);
    }
  }
  return projection;
}

export async function initializeArchiveState(): Promise<ArchiveProjection> {
  const request = ++nextRequest;
  let archivedNames: string[] = [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem("paper") ?? "[]");
    if (Array.isArray(parsed)) archivedNames = parsed.filter((name): name is string => typeof name === "string");
  } catch { /* Legacy preferences remain untouched if parsing fails. */ }
  return applyProjection(await invoke<ArchiveProjection>("archive_initialize", { archivedNames }), request);
}

export async function setArchiveState(fileName: string, archived: boolean): Promise<ArchiveProjection> {
  const request = ++nextRequest;
  return applyProjection(await invoke<ArchiveProjection>("archive_set", { fileName, archived }), request);
}

export async function refreshArchiveState(): Promise<ArchiveProjection> {
  const request = ++nextRequest;
  return applyProjection(await invoke<ArchiveProjection>("archive_get_projection"), request);
}
