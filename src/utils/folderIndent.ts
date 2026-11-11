/**
 * Sangría visual del selector de carpetas. «Lyra» es la carpeta virtual de la raíz
 * (profundidad 0); las carpetas físicas de primer nivel están al mismo nivel
 * visual que ella. Solo las subcarpetas reales agregan sangría.
 */
export function folderListDepthPx(path: string, basePx = 12, stepPx = 14): number {
  const depth = path ? path.split("/").length : 1;
  return basePx + Math.max(0, depth - 1) * stepPx;
}
