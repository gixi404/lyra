export function startListInitialization<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  onError: (error: unknown) => void,
): () => void {
  let active = true;
  void load().then(value => {
    if (active) apply(value);
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
): () => void {
  let active = true;
  void (async () => {
    try {
      const local = await loadLocal();
      if (active) apply(local);
    } catch (error) {
      if (active) onError(error);
    }
    if (!active) return;
    try {
      await prepareWelcome();
      const refreshed = await loadLocal();
      if (active) apply(refreshed);
    } catch (error) {
      if (active) onError(error);
    }
  })();
  return () => { active = false; };
}
