import assert from "node:assert/strict";
import test from "node:test";
import {
  clearVerificationEmailPending,
  establishVerificationRecovery,
  markVerificationEmailPending,
  shouldStayForEmailVerification,
  verificationCompletionAction,
} from "./verification-state.ts";

test("sign-up dispatch is held only until the recovery panel is established", () => {
  clearVerificationEmailPending();
  markVerificationEmailPending();
  assert.equal(shouldStayForEmailVerification("/signup"), true);

  const removeRecovery = establishVerificationRecovery();
  assert.equal(shouldStayForEmailVerification("/signup"), true);

  removeRecovery();
  assert.equal(shouldStayForEmailVerification("/signup"), false);
});

test("abandoned in-flight sign-up no longer suppresses the verification redirect", () => {
  markVerificationEmailPending();
  assert.equal(shouldStayForEmailVerification("/signup"), true);
  clearVerificationEmailPending();
  assert.equal(shouldStayForEmailVerification("/signup"), false);
  assert.equal(shouldStayForEmailVerification("/"), false);
  assert.equal(verificationCompletionAction(false), "redirect");
  assert.equal(verificationCompletionAction(true), "show-recovery");
});

test("soft navigation away from verification requires the unverified gate again", () => {
  clearVerificationEmailPending();
  assert.equal(shouldStayForEmailVerification("/verify-email"), true);
  assert.equal(shouldStayForEmailVerification("/"), false);
  assert.equal(shouldStayForEmailVerification("/dashboard"), false);
});
