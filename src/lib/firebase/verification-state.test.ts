import assert from "node:assert/strict";
import test from "node:test";
import {
  clearVerificationEmailPending,
  establishVerificationRecovery,
  isVerificationEmailPending,
  isVerificationRecoveryVisible,
  markVerificationEmailPending,
  shouldHoldVerificationRedirect,
  shouldStayForEmailVerification,
  verificationCompletionAction,
} from "./verification-state.ts";

test("sign-up dispatch is held only until the recovery panel is established", () => {
  clearVerificationEmailPending();
  markVerificationEmailPending();
  assert.equal(isVerificationEmailPending(), true);
  assert.equal(isVerificationRecoveryVisible(), false);
  assert.equal(shouldHoldVerificationRedirect("/signup"), true);

  const removeRecovery = establishVerificationRecovery();
  assert.equal(isVerificationEmailPending(), false);
  assert.equal(isVerificationRecoveryVisible(), true);
  assert.equal(shouldHoldVerificationRedirect("/signup"), true);

  removeRecovery();
  assert.equal(isVerificationEmailPending(), false);
  assert.equal(isVerificationRecoveryVisible(), false);
  assert.equal(shouldHoldVerificationRedirect("/signup"), false);
});

test("abandoned in-flight sign-up no longer suppresses the verification redirect", () => {
  markVerificationEmailPending();
  assert.equal(shouldHoldVerificationRedirect("/signup"), true);
  clearVerificationEmailPending();
  assert.equal(isVerificationEmailPending(), false);
  assert.equal(shouldHoldVerificationRedirect("/signup"), false);
  assert.equal(shouldHoldVerificationRedirect("/"), false);
  assert.equal(verificationCompletionAction(false), "redirect");
  assert.equal(verificationCompletionAction(true), "show-recovery");
});

test("soft navigation away from verification requires the unverified gate again", () => {
  clearVerificationEmailPending();
  assert.equal(shouldStayForEmailVerification("/verify-email"), true);
  assert.equal(shouldStayForEmailVerification("/"), false);
  assert.equal(shouldStayForEmailVerification("/dashboard"), false);
});
