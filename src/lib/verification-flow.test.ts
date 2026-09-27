import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmVerifiedEmail,
  resendVerificationWithProfileRecovery,
} from "./verification-flow.ts";

test("pending-name failure does not prevent verification email resend", async () => {
  let sent = false;
  const result = await resendVerificationWithProfileRecovery({
    syncProfile: async () => {
      throw new Error("profile unavailable");
    },
    sendVerification: async () => {
      sent = true;
    },
  });
  assert.equal(result.profileSynced, false);
  assert.equal(result.verificationSent, true);
  assert.equal(sent, true);
});

test("verified email creates a session and navigates despite pending-name failure", async () => {
  let posted = false;
  let navigated = false;
  let warned = false;
  const result = await confirmVerifiedEmail({
    reload: async () => undefined,
    isVerified: () => true,
    syncProfile: async () => {
      throw new Error("profile unavailable");
    },
    createSession: async () => {
      posted = true;
    },
    onProfileFailure: () => {
      warned = true;
    },
    onVerified: () => {
      navigated = true;
    },
  });
  assert.equal(result, "verified");
  assert.equal(warned, true);
  assert.equal(posted, true);
  assert.equal(navigated, true);
});
