export function startListInitialization<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  onError: (error: unknown) => void,
  getGeneration?: () => number,
): () => void {
  let active = true;
  const gen = getGeneration?.();
  void load().then(value => {
    if (active && (gen === undefined || getGeneration?.() === gen)) apply(value);
  }).catch(error => {
    if (active) onError(error);
  });
  return () => { active = false; };
}

export function startLocalFirstListInitialization<T>(
  loadLocal: () => Promise<T>,
  prepareWelcome: () => Promise<void>,
  apply: (value: T) => void,
  onError: (error: unknown) => void,
  getGeneration?: () => number,
): () => void {
  let active = true;
  const isStale = (gen: number | undefined) => gen !== undefined && getGeneration?.() !== gen;
  void (async () => {
    try {
      const gen = getGeneration?.();
      const local = await loadLocal();
      if (active && !isStale(gen)) apply(local);
    } catch (error) {
      if (active) onError(error);
    }
    if (!active) return;
    try {
      await prepareWelcome();
      const gen = getGeneration?.();
      const refreshed = await loadLocal();
      if (active && !isStale(gen)) apply(refreshed);
    } catch (error) {
      if (active) onError(error);
    }
  })();
  return () => { active = false; };
}

export function shouldPreserveExplorerDataOnInit(state: {
  isInitialized: boolean;
  files: readonly string[];
  folders: readonly string[];
}): boolean {
  return state.isInitialized && (state.files.length > 0 || state.folders.length > 0);
}
