import assert from "node:assert/strict";
import test from "node:test";
import { sameSyncContext } from "../src/utils/syncEventPolicy.ts";
import { currentSyncRequest, resetNotesDir, setNotesDir, setWorkspaceEpoch } from "../src/utils/workspacePaths.ts";

test("F3 rejects late progress, result and error events after a workspace switch", () => {
  resetNotesDir();
  assert.equal(setNotesDir("lyra/workspaces/ws_001"), true);
  setWorkspaceEpoch(4);
  const old = { workspace_id: "ws_001", epoch: 4 };
  assert.equal(sameSyncContext(old, currentSyncRequest()), true);

  resetNotesDir();
  assert.equal(sameSyncContext(old, currentSyncRequest()), false);
  assert.equal(setNotesDir("lyra/workspaces/ws_002"), true);
  setWorkspaceEpoch(5);
  assert.equal(sameSyncContext(old, currentSyncRequest()), false);
  assert.equal(sameSyncContext({ workspace_id: "ws_002", epoch: 5 }, currentSyncRequest()), true);
  resetNotesDir();
});

test("F3 rejects obsolete epochs, absent context and unscoped legacy events", () => {
  const active = { workspaceId: "ws_002", epoch: 8 };
  assert.equal(sameSyncContext({ workspace_id: "ws_002", epoch: 7 }, active), false);
  assert.equal(sameSyncContext({ workspace_id: "ws_001", epoch: 8 }, active), false);
  assert.equal(sameSyncContext(undefined, active), false);
  assert.equal(sameSyncContext({ workspace_id: "ws_002", epoch: 8 }, null), false);
});
