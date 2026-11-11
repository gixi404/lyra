let tail: Promise<void> = Promise.resolve();

export async function runPathOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release: (() => void) | undefined;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); }
  finally { release?.(); }
}
