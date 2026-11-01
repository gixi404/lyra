/** Persist the outgoing editor before allowing Rust to change the active id. */
export async function runPreparedWorkspaceSwitch<T>(steps: {
  flushVisualCommits: () => void;
  prepareEditors: () => Promise<boolean>;
  persistPreferences: () => Promise<void>;
  select: () => Promise<T>;
}): Promise<T> {
  steps.flushVisualCommits();
  if (!(await steps.prepareEditors())) {
    throw new Error("Hay cambios sin guardar. Reintenta el cambio de espacio después de guardarlos");
  }
  await steps.persistPreferences();
  if (!(await steps.prepareEditors())) {
    throw new Error("Hay cambios sin guardar. El espacio actual permanece abierto");
  }
  return steps.select();
}
