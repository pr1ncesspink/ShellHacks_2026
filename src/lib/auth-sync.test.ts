import assert from "node:assert/strict";
import test from "node:test";
import {
  beginExplicitAuthAction,
  beginAuthSyncRequest,
  cancelAuthSyncRequests,
  isExplicitAuthActionActive,
} from "./auth-sync.ts";

test("a newer auth sync invalidates and aborts stale requests", () => {
  const first = beginAuthSyncRequest();
  assert.equal(first.isCurrent(), true);
  const second = beginAuthSyncRequest();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  cancelAuthSyncRequests();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
});

test("explicit auth actions suppress background synchronization", () => {
  const request = beginAuthSyncRequest();
  const finish = beginExplicitAuthAction();
  assert.equal(request.signal.aborted, true);
  assert.equal(isExplicitAuthActionActive(), true);
  finish();
  finish();
  assert.equal(isExplicitAuthActionActive(), false);
});
