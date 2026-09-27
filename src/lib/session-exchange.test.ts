import assert from "node:assert/strict";
import test from "node:test";
import { exchangeSession, type SessionUser } from "./session-exchange.ts";

const verifiedUser: SessionUser = {
  uid: "uid_123",
  email: "person@example.test",
  name: "Person",
  emailVerified: true,
  exp: 1_100,
};

function exchange(
  overrides: Partial<Parameters<typeof exchangeSession>[0]> = {},
) {
  return exchangeSession({
    origin: "https://gridlens.example",
    requestUrl: "https://gridlens.example/api/session",
    requestHost: "gridlens.example",
    idToken: "firebase-token",
    now: 1_000,
    secure: true,
    verifyUser: async () => verifiedUser,
    ...overrides,
  });
}

test("a verified token creates the expected session cookie", async () => {
  const result = await exchange();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.cookie.value, "firebase-token");
    assert.equal(result.cookie.options.maxAge, 100);
    assert.equal(result.cookie.options.httpOnly, true);
    assert.equal(result.cookie.options.secure, true);
  }
});

test("foreign and missing origins are rejected without a cookie", async () => {
  for (const origin of [null, "null", "https://evil.example", "http://gridlens.example"]) {
    const result = await exchange({ origin });
    assert.deepEqual(result, { ok: false, status: 403 });
    assert.equal("cookie" in result, false);
  }
});

test("bad, unverified, and expired tokens are rejected without a cookie", async () => {
  const results = await Promise.all([
    exchange({ verifyUser: async () => { throw new Error("bad token"); } }),
    exchange({ verifyUser: async () => ({ ...verifiedUser, emailVerified: false }) }),
    exchange({ verifyUser: async () => ({ ...verifiedUser, exp: 1_000 }) }),
    exchange({ idToken: "" }),
  ]);
  for (const result of results) {
    assert.deepEqual(result, { ok: false, status: 401 });
    assert.equal("cookie" in result, false);
  }
});
