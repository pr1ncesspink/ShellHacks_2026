import assert from "node:assert/strict";
import test from "node:test";
import { runSignUpFlow } from "./signup-flow.ts";

test("a profile update failure preserves the created user and still sends verification", async () => {
  const user = { uid: "created-user" };
  let verificationUser: typeof user | undefined;
  const result = await runSignUpFlow({
    createUser: async () => user,
    updateUserProfile: async () => {
      throw new Error("profile unavailable");
    },
    sendVerification: async (created) => {
      verificationUser = created;
    },
  });
  assert.equal(result.user, user);
  assert.equal(result.profileUpdated, false);
  assert.equal(result.verificationSent, true);
  assert.equal(verificationUser, user);
});

test("a verification send failure preserves the created user for resend recovery", async () => {
  const user = { uid: "created-user" };
  const result = await runSignUpFlow({
    createUser: async () => user,
    updateUserProfile: async () => undefined,
    sendVerification: async () => {
      throw new Error("email unavailable");
    },
  });
  assert.equal(result.user, user);
  assert.equal(result.profileUpdated, true);
  assert.equal(result.verificationSent, false);
  assert.match(String(result.verificationError), /email unavailable/);
});
