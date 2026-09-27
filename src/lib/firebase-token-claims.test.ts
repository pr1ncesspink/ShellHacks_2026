import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFirebaseTokenHeader,
  sessionUserFromClaims,
} from "./firebase-token-claims.ts";

const jwtWithHeader = (header: object) =>
  `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.sig`;

test("accepts only RS256 headers with a key id", () => {
  assert.doesNotThrow(() =>
    assertFirebaseTokenHeader(jwtWithHeader({ alg: "RS256", kid: "k1" })),
  );
  for (const token of [
    jwtWithHeader({ alg: "none", kid: "k1" }),
    jwtWithHeader({ alg: "HS256", kid: "k1" }),
    jwtWithHeader({ alg: "RS256" }),
    jwtWithHeader({ alg: "RS256", kid: "" }),
    "not-a-jwt",
    "",
  ]) {
    assert.throws(() => assertFirebaseTokenHeader(token));
  }
});

const now = 1_800_000_000;
const valid = {
  sub: "abc_123",
  exp: now + 600,
  auth_time: now - 60,
  email: "user@example.com",
  name: "Ada",
  email_verified: true,
};

test("maps verified Firebase claims to a session user", () => {
  assert.deepEqual(sessionUserFromClaims(valid, now), {
    uid: "abc_123",
    email: "user@example.com",
    name: "Ada",
    emailVerified: true,
    exp: now + 600,
  });
});

test("unverified email and missing profile fields are preserved as such", () => {
  const user = sessionUserFromClaims(
    { sub: "u", exp: now + 1, auth_time: now, email_verified: false },
    now,
  );
  assert.equal(user.emailVerified, false);
  assert.equal(user.email, null);
  assert.equal(user.name, null);
});

test("rejects bad subject, expiry, and auth_time", () => {
  for (const claims of [
    { ...valid, sub: "" },
    { ...valid, sub: "x".repeat(129) },
    { ...valid, sub: 42 },
    { ...valid, exp: now },
    { ...valid, exp: "soon" },
    { ...valid, auth_time: now + 3600 },
    { ...valid, auth_time: undefined },
  ]) {
    assert.throws(() => sessionUserFromClaims(claims, now));
  }
});
