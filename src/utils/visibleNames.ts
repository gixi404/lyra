import { getFileBaseName, HIDDEN_NOTE_EXTENSIONS, SUPPORTED_NOTE_EXTENSIONS, hasSupportedNoteExtension } from "./noteName.ts";
import { archiveMetadataForReplacement, metadataMatches } from "./metadataIdentity.ts";

export type VisibleNameKind = "file" | "folder";

type VisibleNameMap = Record<string, string>;

const NOTE_KEY = "noteVisibleNames";
const FOLDER_KEY = "folderVisibleNames";

function keyFor(kind: VisibleNameKind): string {
  return kind === "file" ? NOTE_KEY : FOLDER_KEY;
}

function readMap(kind: VisibleNameKind): VisibleNameMap {
  try {
    const raw = window.localStorage.getItem(keyFor(kind));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: VisibleNameMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(kind: VisibleNameKind, map: VisibleNameMap): void {
  window.localStorage.setItem(keyFor(kind), JSON.stringify(map));
}

export function getVisibleNameMap(kind: VisibleNameKind): VisibleNameMap {
  return Object.fromEntries(Object.entries(readMap(kind)).filter(([path]) => metadataMatches(kind, path)));
}

export function getVisibleSegment(physicalPath: string, kind: VisibleNameKind): string | undefined {
  if (!metadataMatches(kind, physicalPath)) return undefined;
  const v = readMap(kind)[physicalPath];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function setVisibleSegment(physicalPath: string, kind: VisibleNameKind, visibleSegment: string | undefined): void {
  const map = readMap(kind);
  if (!visibleSegment) {
    if (Object.prototype.hasOwnProperty.call(map, physicalPath)) {
      delete map[physicalPath];
      writeMap(kind, map);
    }
    return;
  }
  map[physicalPath] = visibleSegment;
  writeMap(kind, map);
}

export function clearVisibleSegment(physicalPath: string, kind: VisibleNameKind): void {
  const map = readMap(kind);
  if (Object.prototype.hasOwnProperty.call(map, physicalPath)) {
    delete map[physicalPath];
    writeMap(kind, map);
  }
}

export function clearVisibleName(physicalPath: string, kind: VisibleNameKind): void {
  archiveMetadataForReplacement(kind, physicalPath);
  clearVisibleSegment(physicalPath, kind);
}

export function setVisibleNameForPath(physicalPath: string, kind: VisibleNameKind, visibleSegment: string): void {
  const physicalSeg = getFileBaseName(physicalPath);
  const map = readMap(kind);
  // Store only when different from physical segment to avoid mass metadata; but "conservar exactamente..."
  // is satisfied if we can recover. If same, no override needed.
  if (visibleSegment === physicalSeg) {
    if (Object.prototype.hasOwnProperty.call(map, physicalPath)) {
      delete map[physicalPath];
      writeMap(kind, map);
    }
    return;
  }
  map[physicalPath] = visibleSegment;
  writeMap(kind, map);
}

/** Remap visible name metadata when a path (file or folder) moves/renames. */
export function remapVisibleNames(changes: ReadonlyArray<{ oldPath: string; newPath: string }>, folderMove?: { oldPath: string; newPath: string }): void {
  for (const kind of ["file", "folder"] as const) {
    const map = readMap(kind);
    let changed = false;
    const next: VisibleNameMap = {};

    const renamePath = (p: string): string => {
      if (folderMove) {
        if (p === folderMove.oldPath) return folderMove.newPath;
        const prefix = `${folderMove.oldPath}/`;
        if (p.startsWith(prefix)) return `${folderMove.newPath}${p.slice(folderMove.oldPath.length)}`;
      }
      const direct = changes.find(c => c.oldPath === p);
      if (direct) return direct.newPath;
      return p;
    };

    for (const [p, v] of Object.entries(map)) {
      const rp = renamePath(p);
      if (rp !== p) changed = true;
      // if physical segment now equals visible, drop override
      const physSeg = getFileBaseName(rp);
      if (v === physSeg) {
        changed = true;
        continue;
      }
      next[rp] = v;
    }
    if (changed) writeMap(kind, next);
  }
}

/** Remove visible name metadata for deleted paths (and descendants for folders). */
export function removeVisibleNamesForPath(physicalPath: string, kind: VisibleNameKind, recursive = false): void {
  const map = readMap(kind);
  let changed = false;
  for (const p of Object.keys(map)) {
    if (p === physicalPath || (recursive && p.startsWith(`${physicalPath}/`))) {
      delete map[p];
      changed = true;
    }
  }
  if (changed) writeMap(kind, map);
}

export function removeVisibleNamesForPaths(physicalPaths: string[], kind: VisibleNameKind): void {
  const map = readMap(kind);
  let changed = false;
  for (const p of physicalPaths) {
    if (Object.prototype.hasOwnProperty.call(map, p)) {
      delete map[p];
      changed = true;
    }
  }
  if (changed) writeMap(kind, map);
}

/**
 * Prune stale visible-name metadata for paths that no longer exist.
 * Prevents accidental association on physical-path reuse after external changes/deletions.
 */
export function pruneVisibleNameMetadata(existingFiles: readonly string[], existingFolders: readonly string[]): boolean {
  let changed = false;
  const fileSet = new Set(existingFiles);
  const folderSet = new Set(existingFolders);
  folderSet.add(""); // root sentinel safety
  for (const kind of ["file", "folder"] as const) {
    const map = readMap(kind);
    const next: VisibleNameMap = {};
    const keepSet = kind === "file" ? fileSet : folderSet;
    for (const [p, v] of Object.entries(map)) {
      if (!keepSet.has(p)) { next[p] = v; continue; }
      const physSeg = getFileBaseName(p);
      if (v === physSeg) {
        changed = true;
        continue;
      }
      next[p] = v;
    }
    if (Object.keys(next).length !== Object.keys(map).length) changed = true;
    // write only if different
    if (JSON.stringify(next) !== JSON.stringify(map)) {
      writeMap(kind, next);
      changed = true;
    }
  }
  return changed;
}

/** Visible segment (full, including extension for files) for a physical path. */
export function getDisplaySegment(physicalPath: string, kind: VisibleNameKind): string {
  return getVisibleSegment(physicalPath, kind) ?? getFileBaseName(physicalPath);
}

/** Display name for explorer/listing: hides .txt/.md for files, shows technical extensions. */
export function displayNoteName(physicalPath: string): string {
  const seg = getDisplaySegment(physicalPath, "file");
  const lower = seg.toLowerCase();
  const ext = HIDDEN_NOTE_EXTENSIONS.find(e => lower.endsWith(e));
  return ext && seg.length > ext.length ? seg.slice(0, -ext.length) : seg;
}

export function displayFolderName(physicalPath: string): string {
  if (physicalPath === "") return getVisibleSegment("", "folder") ?? "Lyra";
  return getDisplaySegment(physicalPath, "folder");
}

/** Label for messages: «name» using visible display name. */
export function displayNoteLabel(physicalPath: string): string {
  return `«${displayNoteName(physicalPath)}»`;
}

/** Editable base name shown in rename dialogs (without hidden .txt/.md extension, preserving visible stem). */
export function editableNoteBaseName(physicalPath: string): string {
  const seg = getDisplaySegment(physicalPath, "file");
  const lower = seg.toLowerCase();
  const ext = HIDDEN_NOTE_EXTENSIONS.find(e => lower.endsWith(e));
  return ext && seg.length > ext.length ? seg.slice(0, -ext.length) : seg;
}

// --- Physical name generation / safety ---

const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// eslint-disable-next-line no-control-regex -- ASCII control chars are intentionally forbidden in physical file names.
const FORBIDDEN_PHYSICAL_CHARS_RE = /[\\/:*?"<>|\x00-\x1f]/g;

function trimUnsafeEdges(name: string): string {
  // remove leading/trailing spaces and dots (Windows-incompatible), keep internal
  return name.replace(/^[ .]+|[ .]+$/g, "");
}

function splitFileSegment(segment: string): { stem: string; ext: string } {
  const lower = segment.toLowerCase();
  // prefer known supported extension match
  for (const ext of [...SUPPORTED_NOTE_EXTENSIONS].sort((a,b)=>b.length-a.length)) {
    if (lower.endsWith(ext)) {
      return { stem: segment.slice(0, segment.length - ext.length), ext: segment.slice(segment.length - ext.length) };
    }
  }
  const dot = segment.lastIndexOf(".");
  if (dot > 0) return { stem: segment.slice(0, dot), ext: segment.slice(dot) };
  return { stem: segment, ext: "" };
}

function normalizeForCompare(name: string): string {
  return name.normalize("NFC").toLocaleLowerCase();
}

function isReservedWindowsStem(stem: string): boolean {
  const base = stem.split(".")[0] ?? "";
  return WINDOWS_RESERVED.has(base.trim().toUpperCase());
}

function sanitizeStem(visibleStem: string): string {
  let s = visibleStem.normalize("NFC");
  s = s.replace(FORBIDDEN_PHYSICAL_CHARS_RE, "_");
  s = trimUnsafeEdges(s);
  if (s.length === 0) s = "sin-nombre";
  // avoid reserved windows device names by suffixing underscore
  if (isReservedWindowsStem(s)) s = `${s}_`;
  // length limit (bytes-ish safety): keep reasonable segment length
  if (s.length > 120) s = s.slice(0, 120).replace(/[ .]+$/g, "") || "sin-nombre";
  return s;
}

export function isPhysicallySafeSegment(segment: string, kind: VisibleNameKind): boolean {
  if (!segment || segment !== segment.trim()) return false;
  if (/^[ .]|[ .]$/.test(segment)) return false;
  if (FORBIDDEN_PHYSICAL_CHARS_RE.test(segment)) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if ([...segment].some(c => c.charCodeAt(0) <= 31)) return false;
  if (segment === "." || segment === "..") return false;
  if (kind === "file") {
    const { stem, ext } = splitFileSegment(segment);
    if (!stem || !ext) return false;
    if (!hasSupportedNoteExtension(segment)) return false;
    if (isReservedWindowsStem(stem)) return false;
  } else {
    if (isReservedWindowsStem(segment)) return false;
  }
  if (segment.length > 150) return false;
  return true;
}

export interface ResolvePhysicalOptions {
  visibleSegment: string;
  kind: VisibleNameKind;
  parentDir: string; // "" for root
  existingPhysicalSegments: string[]; // sibling physical base names in target dir
  excludePhysicalSegment?: string; // current physical segment when renaming in place
}

/** Returns physical segment to use (safe, unique) and whether it differs from visible. */
export function resolvePhysicalSegment(opts: ResolvePhysicalOptions): { physical: string; visible: string; differs: boolean } {
  const { visibleSegment, kind, existingPhysicalSegments, excludePhysicalSegment } = opts;
  const visible = visibleSegment; // preserve exact
  const excludeCmp = excludePhysicalSegment ? normalizeForCompare(excludePhysicalSegment) : null;
  const taken = new Set(existingPhysicalSegments.map(s => normalizeForCompare(s)).filter(s => s !== excludeCmp));

  let candidate: string;
  if (kind === "file") {
    const { stem: vStem, ext: vExt } = splitFileSegment(visibleSegment);
    let ext = vExt;
    if (!ext || !hasSupportedNoteExtension(`x${ext}`)) {
      // default .txt if no supported ext (creation flow may also ensure)
      ext = ".txt";
    }
    // normalize ext to lowercase form for physical safety consistency? keep as-is in visible; physical ext should be supported
    // but preserve extension characters physically if safe; easier to use lowercased supported ext when needed
    const safeExt = ext; // ext comes from segment
    let safeStem = sanitizeStem(vStem || "nota");
    // ensure stem not empty
    if (!safeStem) safeStem = "nota";
    candidate = `${safeStem}${safeExt}`;
    // if visible is fully safe and available, prefer it (aligned)
    if (isPhysicallySafeSegment(visibleSegment, "file") && !taken.has(normalizeForCompare(visibleSegment))) {
      return { physical: visibleSegment, visible, differs: false };
    }
    // try sanitized base
    if (!taken.has(normalizeForCompare(candidate))) {
      return { physical: candidate, visible, differs: candidate !== visible };
    }
    // collision: add suffix
    const baseStem = safeStem;
    for (let i = 2; i < 10000; i++) {
      const suffixed = `${baseStem} (${i})${safeExt}`;
      if (!taken.has(normalizeForCompare(suffixed))) {
        return { physical: suffixed, visible, differs: suffixed !== visible };
      }
    }
    // fallback
    const fb = `${baseStem}-${Date.now()}${safeExt}`;
    return { physical: fb, visible, differs: fb !== visible };
  } else {
    if (isPhysicallySafeSegment(visibleSegment, "folder") && !taken.has(normalizeForCompare(visibleSegment))) {
      return { physical: visibleSegment, visible, differs: false };
    }
    const safe = sanitizeStem(visibleSegment);
    if (!taken.has(normalizeForCompare(safe))) {
      return { physical: safe, visible, differs: safe !== visible };
    }
    for (let i = 2; i < 10000; i++) {
      const suffixed = `${safe} (${i})`;
      if (!taken.has(normalizeForCompare(suffixed))) {
        return { physical: suffixed, visible, differs: suffixed !== visible };
      }
    }
    const fb = `${safe}-${Date.now()}`;
    return { physical: fb, visible, differs: fb !== visible };
  }
}

export function physicalPathFrom(parentDir: string, physicalSegment: string): string {
  return parentDir ? `${parentDir}/${physicalSegment}` : physicalSegment;
}

/** Visible segment to store for a file, ensuring extension is present as in physical/visible intent. */
export function normalizeVisibleFileSegment(visibleInput: string, physicalSegment: string): string {
  // preserve exactly what user entered, but ensure it has the same extension as physical for consistency
  // if user omitted extension, append physical extension
  if (hasSupportedNoteExtension(visibleInput)) return visibleInput;
  const { ext } = splitFileSegment(physicalSegment);
  return ext ? `${visibleInput}${ext}` : visibleInput;
}


export type NoteSuccessAction = "archived" | "recovered" | "deleted" | "renamed";

export function displayNoteSuccessMessage(fileName: string, action: NoteSuccessAction): string {
  const verbs: Record<NoteSuccessAction, string> = {
    archived: "archivó",
    recovered: "recuperó",
    deleted: "eliminó",
    renamed: "renombró",
  };
  return `${displayNoteLabel(fileName)} se ${verbs[action]}`;
}
