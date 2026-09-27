import assert from "node:assert/strict";
import test from "node:test";
import { syncSessionIdentity } from "./session-transition.ts";

function run(
  previousUid: string | null | undefined,
  currentUid: string | null,
  protectedPath = true,
) {
  const events: string[] = [];
  return syncSessionIdentity({
    previousUid,
    currentUid,
    protectedPath,
    clearSession: async () => {
      events.push("delete");
    },
    writeSession: async () => {
      events.push("post");
    },
    onSignedOut: () => events.push("redirect"),
    onIdentityChanged: () => events.push("reload"),
    onInitialProtectedIdentity: () => events.push("refresh"),
  }).then((uid) => ({ uid, events }));
}

test("protected A to signed-out clears the cookie before redirecting", async () => {
  assert.deepEqual(await run("A", null), {
    uid: null,
    events: ["delete", "redirect"],
  });
});

test("protected A to B posts B's cookie before reloading protected content", async () => {
  assert.deepEqual(await run("A", "B"), {
    uid: "B",
    events: ["post", "reload"],
  });
});

test("same-uid hourly refresh updates the cookie without reloading", async () => {
  assert.deepEqual(await run("A", "A"), {
    uid: "A",
    events: ["post"],
  });
});

test("initial protected callback posts then refreshes server-rendered identity", async () => {
  assert.deepEqual(await run(undefined, "A"), {
    uid: "A",
    events: ["post", "refresh"],
  });
});

test("initial public callback posts without an unnecessary refresh", async () => {
  assert.deepEqual(await run(undefined, "A", false), {
    uid: "A",
    events: ["post"],
  });
});
