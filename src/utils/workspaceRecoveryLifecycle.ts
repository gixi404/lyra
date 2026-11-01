import { isGateOpen, type WorkspaceSnapshot } from "./workspaceState.ts";

/** Start recovery only for the workspace whose path the gate installed. */
export function createWorkspaceRecoveryLifecycle(
  currentDirectory: () => string | null,
  initialize: (directory: string) => Promise<void>,
) {
  let confirmedDirectory: string | null = null;

  return {
    onReady(snapshot: WorkspaceSnapshot): Promise<void> {
      const directory = snapshot.workspace?.directory;
      if (!isGateOpen(snapshot) || !directory || currentDirectory() !== directory) {
        throw new Error("El espacio de trabajo no está listo para revisar recuperaciones");
      }
      confirmedDirectory = directory;
      return initialize(directory);
    },
    onFocus(): Promise<void> {
      if (!confirmedDirectory || currentDirectory() !== confirmedDirectory) {
        return Promise.resolve();
      }
      return initialize(confirmedDirectory);
    },
  };
}
