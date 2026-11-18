import { getFileBaseName, getFileDirectory, hasSupportedNoteExtension, SUPPORTED_NOTE_EXTENSIONS } from "./noteName.ts";
import { displayFolderName, displayNoteName, getVisibleSegment, physicalPathFrom, resolvePhysicalSegment, setVisibleNameForPath } from "./visibleNames.ts";
import { fileStore } from "../store/fileStore.ts";
import { configStore } from "../store/configStore.ts";
import { scheduleSavePersistentPreferences } from "./persistentPreferences.ts";
import { bindMetadataWithFeedback, prepareMetadataWrite } from "./metadataIdentity.ts";

export interface VisibleNameValidation {
  ok: boolean;
  reason?: string;
}

export function validateVisibleEntryName(name: string, kind: "file" | "folder"): VisibleNameValidation {
  if (name.length === 0) {
    return { ok: false, reason: kind === "file" ? "El nombre no puede estar vacío." : "El nombre de la carpeta no puede estar vacío." };
  }
  if (name.trim().length === 0) {
    return { ok: false, reason: kind === "file" ? "El nombre no puede estar vacío." : "El nombre de la carpeta no puede estar vacío." };
  }
  // control chars (except common whitespace? allow spaces/tabs in middle? tabs unlikely but preserve exactly is requested; disallow other controls)
  if ([...name].some(c => {
    const code = c.charCodeAt(0);
    return code < 32 && c !== "\t";
  })) {
    return { ok: false, reason: "El nombre contiene caracteres de control no permitidos." };
  }
  // keep it reasonable length for visible label
  if (name.length > 200) {
    return { ok: false, reason: "El nombre es demasiado largo." };
  }
  return { ok: true };
}

function ensureFileVisibleHasExt(visibleInput: string, physicalSegment: string): string {
  // preserve exactly as entered; if missing supported ext, append physical ext
  if (hasSupportedNoteExtension(visibleInput)) return visibleInput;
  const lowerPhys = physicalSegment.toLowerCase();
  const ext = [...SUPPORTED_NOTE_EXTENSIONS].sort((a,b)=>b.length-a.length).find(e => lowerPhys.endsWith(e));
  return ext ? `${visibleInput}${ext}` : `${visibleInput}.txt`;
}

function getSegmentExtension(segment: string): string {
  const lower = segment.toLowerCase();
  const ext = [...SUPPORTED_NOTE_EXTENSIONS].sort((a, b) => b.length - a.length).find(e => lower.endsWith(e));
  if (ext) return segment.slice(segment.length - ext.length);
  const dot = segment.lastIndexOf(".");
  return dot > 0 ? segment.slice(dot) : "";
}

function withPreservedExtension(visibleInput: string, requiredExt: string): string {
  if (!requiredExt) return visibleInput;
  const lowerIn = visibleInput.toLowerCase();
  const lowerExt = requiredExt.toLowerCase();
  // Preserve exact visible input when it already ends with the required physical extension (any case).
  if (lowerIn.endsWith(lowerExt)) return visibleInput;
  // Visible name changed extension or omitted it: keep visible stem but force preserved physical extension.
  if (hasSupportedNoteExtension(visibleInput)) {
    const inExt = getSegmentExtension(visibleInput);
    if (inExt) return `${visibleInput.slice(0, visibleInput.length - inExt.length)}${requiredExt}`;
  }
  return `${visibleInput}${requiredExt}`;
}

export function resolveNewNotePhysicalPath(
  visibleInput: string,
  folderPath: string,
  excludePhysicalPath?: string,
  options?: { preserveExtensionFromPhysical?: string }
): { physicalPath: string; visibleSegment: string } {
  const existing = fileStore.getState().files.filter(p => getFileDirectory(p) === folderPath).map(p => getFileBaseName(p));
  const excludeSeg = excludePhysicalPath ? getFileBaseName(excludePhysicalPath) : undefined;
  const requiredExt = options?.preserveExtensionFromPhysical ? getSegmentExtension(options.preserveExtensionFromPhysical) : "";
  const inputForResolution = requiredExt ? withPreservedExtension(visibleInput, requiredExt) : visibleInput;
  // ensure visible has extension for file logic; if user omitted, we'll append default .txt in physical resolution context
  const { physical, visible } = resolvePhysicalSegment({
    visibleSegment: inputForResolution,
    kind: "file",
    parentDir: folderPath,
    existingPhysicalSegments: existing,
    excludePhysicalSegment: excludeSeg,
  });
  let visibleSeg = ensureFileVisibleHasExt(visible, physical);
  if (requiredExt) {
    // Physical extension must match the preserved type; keep visible aligned to that extension.
    const physExt = getSegmentExtension(physical);
    if (physExt && !visibleSeg.toLowerCase().endsWith(physExt.toLowerCase())) {
      visibleSeg = withPreservedExtension(visibleSeg, physExt);
    }
  }
  return { physicalPath: physicalPathFrom(folderPath, physical), visibleSegment: visibleSeg };
}

export function resolveRenamedNotePhysicalPath(visibleInput: string, currentPhysicalPath: string): { physicalPath: string; visibleSegment: string } {
  const folderPath = getFileDirectory(currentPhysicalPath);
  const currentSeg = getFileBaseName(currentPhysicalPath);
  return resolveNewNotePhysicalPath(visibleInput, folderPath, currentPhysicalPath, { preserveExtensionFromPhysical: currentSeg });
}

export function resolveNewFolderPhysicalPath(visibleInput: string, parentPath: string, excludePhysicalPath?: string): { physicalPath: string; visibleSegment: string } {
  const existing = fileStore.getState().folders.filter(p => getFileDirectory(p) === parentPath).map(p => getFileBaseName(p));
  const excludeSeg = excludePhysicalPath ? getFileBaseName(excludePhysicalPath) : undefined;
  const { physical, visible } = resolvePhysicalSegment({
    visibleSegment: visibleInput,
    kind: "folder",
    parentDir: parentPath,
    existingPhysicalSegments: existing,
    excludePhysicalSegment: excludeSeg,
  });
  return { physicalPath: physicalPathFrom(parentPath, physical), visibleSegment: visible };
}

export function resolveRenamedFolderPhysicalPath(visibleInput: string, currentPhysicalPath: string): { physicalPath: string; visibleSegment: string } {
  const parentPath = getFileDirectory(currentPhysicalPath);
  return resolveNewFolderPhysicalPath(visibleInput, parentPath, currentPhysicalPath);
}

export function commitVisibleName(physicalPath: string, kind: "file" | "folder", visibleSegment: string): void {
  prepareMetadataWrite(kind, physicalPath);
  const physicalSeg = getFileBaseName(physicalPath);
  if (visibleSegment === physicalSeg) {
    // drop override if any
    const key = kind === "file" ? "noteVisibleNames" : "folderVisibleNames";
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const map = JSON.parse(raw) as Record<string, string>;
        if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, physicalPath)) {
          delete map[physicalPath];
          window.localStorage.setItem(key, JSON.stringify(map));
        }
      }
    } catch { /* ignore */ }
  } else {
    setVisibleNameForPath(physicalPath, kind, visibleSegment);
    bindMetadataWithFeedback(kind, physicalPath);
  }
  configStore.getState().bumpPrefTick();
  scheduleSavePersistentPreferences();
}

export function clearVisibleName(physicalPath: string, kind: "file" | "folder"): void {
  const key = kind === "file" ? "noteVisibleNames" : "folderVisibleNames";
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, string>;
    if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, physicalPath)) {
      delete map[physicalPath];
      window.localStorage.setItem(key, JSON.stringify(map));
      configStore.getState().bumpPrefTick();
      scheduleSavePersistentPreferences();
    }
  } catch { /* ignore */ }
}

export { displayFolderName, displayNoteName, getVisibleSegment };
