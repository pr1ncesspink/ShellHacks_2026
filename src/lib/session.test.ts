import assert from "node:assert/strict";
import test from "node:test";
import {
  cookieOptions,
  isProtectedPath,
  isSameOrigin,
  isSecureRequest,
  safeNext,
} from "./session.ts";

test("isSecureRequest follows the request protocol", () => {
  assert.equal(isSecureRequest("http://127.0.0.1:4173/api/session"), false);
  assert.equal(isSecureRequest("https://gridlens.vercel.app/api/session"), true);
  assert.equal(isSecureRequest("not a url"), false);
});

test("safeNext accepts same-origin relative paths", () => {
  assert.equal(safeNext("/dashboard"), "/dashboard");
  assert.equal(safeNext("/profile?x=1"), "/profile?x=1");
  assert.equal(safeNext("/budget?uploads=UPL_0123456789abcdef0123456789abcdef"),
    "/budget?uploads=UPL_0123456789abcdef0123456789abcdef");
});

test("safeNext never resumes an in-progress upload link after sign-in", () => {
  assert.equal(safeNext("/budget?sessions=SES_0123456789abcdef0123456789abcdef"), "/dashboard");
  assert.equal(safeNext("/budget?project=R-0001&sessions=SES_x"), "/dashboard");
});

test("safeNext rejects external, encoded, malformed, and control-character targets", () => {
  for (const value of [
    "//evil.com",
    "https://evil.com",
    "/\\evil",
    "javascript:alert(1)",
    "/%2f%2fevil.com",
    "/%252f%252fevil.com",
    "/%2525252f%2525252fevil.com",
    "/%5cevil.com",
    "/dashboard%0d%0aLocation:%20https://evil.com",
    "/dashboard\u0000",
    " /dashboard",
    "/dashboard ",
    "/%zz",
    "",
  ]) {
    assert.equal(safeNext(value), "/dashboard", value);
  }
});

test("isProtectedPath matches protected route segments only", () => {
  for (const path of [
    "/dashboard",
    "/dashboard/x",
    "/budget",
    "/profile",
    "/profile/settings",
  ]) {
    assert.equal(isProtectedPath(path), true, path);
  }
  for (const path of [
    "/",
    "/signup",
    "/verify-email",
    "/api/session",
    "/dashboardish",
  ]) {
    assert.equal(isProtectedPath(path), false, path);
  }
});

test("cookieOptions uses the token lifetime and secure flag", () => {
  assert.deepEqual(cookieOptions(160, 100, true), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60,
  });
  assert.equal(cookieOptions(90, 100, false).maxAge, 0);
  assert.equal(cookieOptions(160, 100, false).secure, false);
});

test("isSameOrigin requires the exact scheme, host, and port", () => {
  assert.equal(
    isSameOrigin("https://gridlens.example", "https://gridlens.example/api/session"),
    true,
  );
  assert.equal(
    isSameOrigin("https://gridlens.example:444", "https://gridlens.example:444/api/session"),
    true,
  );
  assert.equal(
    isSameOrigin("http://gridlens.example", "https://gridlens.example/api/session"),
    false,
  );
  assert.equal(
    isSameOrigin("https://gridlens.example:444", "https://gridlens.example/api/session"),
    false,
  );
  assert.equal(
    isSameOrigin("https://evil.example", "https://gridlens.example/api/session"),
    false,
  );
  assert.equal(isSameOrigin(null, "https://gridlens.example/api/session"), false);
  assert.equal(isSameOrigin("null", "https://gridlens.example/api/session"), false);
  assert.equal(
    isSameOrigin(
      "http://127.0.0.1:5173",
      "http://localhost:5173/api/session",
      "127.0.0.1:5173",
    ),
    true,
  );
  assert.equal(
    isSameOrigin(
      "https://gridlens.example",
      "https://internal.invalid/api/session",
      "gridlens.example",
    ),
    true,
  );
  assert.equal(
    isSameOrigin(
      "http://gridlens.example",
      "https://internal.invalid/api/session",
      "gridlens.example",
    ),
    false,
  );
});
