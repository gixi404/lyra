export interface RetainedExit {
  name: string;
  view: "active" | "paper";
  index: number;
}

export function includeRetainedExits(
  current: string[],
  retained: RetainedExit[],
  view: "active" | "paper",
): string[] {
  const output = [...current];
  const missing = retained.filter(item => item.view === view && !output.includes(item.name))
    .sort((a, b) => a.index - b.index);
  for (const item of missing) {
    output.splice(Math.min(item.index, output.length), 0, item.name);
  }
  return output;
}

