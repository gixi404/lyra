import test from "node:test";
import assert from "node:assert/strict";
import { acceptsSyncStart, acceptsSyncCompletion, isVisibleSyncReason, shouldAcceptSyncStart, shouldShowSyncStart } from "../src/utils/syncEventPolicy.ts";

test("FIX-003 accepts initial sync during login and automatic sync after connection", () => {
  assert.equal(acceptsSyncStart(false, true), true);
  assert.equal(acceptsSyncStart(true, false), true);
  assert.equal(acceptsSyncStart(false, false), false);
});

test("FIX-003 ignores stale and post-logout completion events", () => {
  assert.equal(acceptsSyncCompletion("current", "old", true, false), false);
  assert.equal(acceptsSyncCompletion("current", "current", true, false), true);
  assert.equal(acceptsSyncCompletion("current", "current", false, false), false);
  assert.equal(acceptsSyncCompletion(null, "first", false, true), false);
});

test("only initial connection and successful authorization request a loading toast", () => {
  assert.equal(isVisibleSyncReason("initial_connection"), true);
  assert.equal(isVisibleSyncReason("authorization"), true);
  assert.equal(isVisibleSyncReason("background"), false);
});

test("visible sync events require a matching live request across overlap and account changes", () => {
  const requests = new Set(["login-current", "authorization-current"]);
  assert.equal(shouldShowSyncStart("background", null, requests), false);
  assert.equal(shouldShowSyncStart("background", "login-current", requests), false);
  assert.equal(shouldShowSyncStart("initial_connection", "login-current", requests), true);
  assert.equal(shouldShowSyncStart("authorization", "authorization-current", requests), true);
  assert.equal(shouldShowSyncStart("initial_connection", "login-old-account", requests), false);
  assert.equal(shouldShowSyncStart("authorization", "authorization-old-account", requests), false);
  assert.equal(shouldAcceptSyncStart(true, false, "authorization", "authorization-old-account", requests), false);
  assert.equal(shouldAcceptSyncStart(true, false, "background", null, requests), true);
  requests.clear();
  assert.equal(shouldShowSyncStart("initial_connection", "login-current", requests), false);
  assert.equal(shouldAcceptSyncStart(true, false, "initial_connection", "login-current", requests), false);
});
