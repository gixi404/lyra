import { normalize } from "./helpers.ts";

export interface HighlightSegment {
  text: string;
  highlight: boolean;
}

interface NormalizedChar {
  ch: string;
  originalIndex: number;
}

function buildNormalizedIndex(text: string): { normalized: string; map: number[] } {
  const chars: NormalizedChar[] = [];
  for (let i = 0; i < text.length; i++) {
    const decomposed = text[i].normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const lowered = decomposed.toLowerCase();
    for (let j = 0; j < lowered.length; j++) {
      chars.push({ ch: lowered[j], originalIndex: i });
    }
  }
  return {
    normalized: chars.map(c => c.ch).join(""),
    map: chars.map(c => c.originalIndex),
  };
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push([curr[0], curr[1]]);
    }
  }
  return merged;
}

/**
 * Devuelve los segmentos del texto original con las coincidencias del buscador resaltables.
 * Usa la misma normalización que el filtrado (sin distinción de mayúsculas/acentos).
 * Si la consulta normalizada está vacía o no hay coincidencias, devuelve un único segmento sin resaltar.
 */
export function getHighlightSegments(text: string, query: string): HighlightSegment[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return [{ text, highlight: false }];
  }

  const { normalized, map } = buildNormalizedIndex(text);
  if (normalizedQuery.length === 0 || normalized.length === 0) {
    return [{ text, highlight: false }];
  }

  const ranges: Array<[number, number]> = [];
  let fromIndex = 0;
  while (fromIndex <= normalized.length - normalizedQuery.length) {
    const idx = normalized.indexOf(normalizedQuery, fromIndex);
    if (idx === -1) break;
    const startOriginal = map[idx];
    const endOriginal = map[idx + normalizedQuery.length - 1] + 1;
    if (startOriginal !== undefined && endOriginal !== undefined) {
      ranges.push([startOriginal, endOriginal]);
    }
    fromIndex = idx + Math.max(1, normalizedQuery.length);
  }

  const merged = mergeRanges(ranges);
  if (merged.length === 0) {
    return [{ text, highlight: false }];
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (cursor < start) {
      segments.push({ text: text.slice(cursor, start), highlight: false });
    }
    segments.push({ text: text.slice(start, end), highlight: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlight: false });
  }
  return segments.filter(segment => segment.text.length > 0);
}

export function hasNormalizedMatch(text: string, query: string): boolean {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return false;
  return normalize(text).includes(normalizedQuery);
}
