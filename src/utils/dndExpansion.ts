/**
 * Devuelve la carpeta de destino y todos sus ancestros (rutas de carpeta) que deben
 * permanecer desplegados tras un movimiento exitoso. La raíz Lyra ("") no tiene entrada
 * en folderExpanded, por lo que se excluye.
 */
export function ancestorsOf(path: string): string[] {
  if (!path) return [];
  const parts = path.split("/");
  const res: string[] = [];
  for (let i = 1; i <= parts.length; i++) res.push(parts.slice(0, i).join("/"));
  return res;
}

/**
 * Rutas de carpeta a mantener desplegadas (y persistir) tras un drop exitoso sobre un
 * contenedor/carpeta destino. Excluye raíz vacía.
 */
export function keepExpandedPathsForContainer(containerKey: string): string[] {
  return ancestorsOf(containerKey);
}
