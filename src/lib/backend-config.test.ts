import assert from "node:assert/strict";
import test from "node:test";
import { buildBackendHeaders, readBackendConfig } from "./backend-config.ts";

test("empty BACKEND_URL selects example mode", () => {
  assert.deepEqual(readBackendConfig({ BACKEND_URL: "" }), { mode: "example" });
});

test("http and https backend URLs are accepted", () => {
  assert.deepEqual(
    readBackendConfig({
      BACKEND_URL: "http://127.0.0.1:8000",
      BACKEND_AUTH: "none",
    }),
    { mode: "live", url: "http://127.0.0.1:8000/", auth: "none" },
  );
  const config = readBackendConfig({
    BACKEND_URL: "https://api.example.test",
    BACKEND_AUTH: "google-oidc",
    GCP_PROJECT_NUMBER: "123",
    GCP_WORKLOAD_IDENTITY_POOL_ID: "pool",
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "provider",
    GCP_SERVICE_ACCOUNT_EMAIL: "frontend@example.test",
  });
  assert.equal(config.mode, "live");
  if (config.mode === "live") assert.equal(config.auth, "google-oidc");
});

test("invalid URL and auth modes report variable names only", () => {
  assert.deepEqual(
    readBackendConfig({ BACKEND_URL: "ftp://api.example.test", BACKEND_AUTH: "none" }),
    { mode: "invalid", missing: ["BACKEND_URL"] },
  );
  assert.deepEqual(
    readBackendConfig({ BACKEND_URL: "https://api.example.test", BACKEND_AUTH: "wat" }),
    { mode: "invalid", missing: ["BACKEND_AUTH"] },
  );
  assert.deepEqual(
    readBackendConfig({
      BACKEND_URL: "https://api.example.test",
      BACKEND_AUTH: "google-oidc",
      GCP_PROJECT_NUMBER: "123",
      GCP_WORKLOAD_IDENTITY_POOL_ID: "pool",
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "provider",
      GCP_SERVICE_ACCOUNT_EMAIL: "",
    }),
    { mode: "invalid", missing: ["GCP_SERVICE_ACCOUNT_EMAIL"] },
  );
});

test("google-oidc requires an https backend URL", () => {
  assert.deepEqual(
    readBackendConfig({
      BACKEND_URL: "http://api.example.test",
      BACKEND_AUTH: "google-oidc",
      GCP_PROJECT_NUMBER: "123",
      GCP_WORKLOAD_IDENTITY_POOL_ID: "pool",
      GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "provider",
      GCP_SERVICE_ACCOUNT_EMAIL: "frontend@example.test",
    }),
    { mode: "invalid", missing: ["BACKEND_URL"] },
  );
});

test("a path-prefixed BACKEND_URL keeps its prefix for endpoint paths", () => {
  for (const rawUrl of ["https://api.example.test/v1", "https://api.example.test/v1/"]) {
    const config = readBackendConfig({ BACKEND_URL: rawUrl, BACKEND_AUTH: "none" });
    assert.equal(config.mode, "live");
    if (config.mode !== "live") continue;
    assert.equal(config.url, "https://api.example.test/v1/");
    assert.equal(
      new URL("overlaps/similarity", config.url).href,
      "https://api.example.test/v1/overlaps/similarity",
    );
  }
});

test("buildBackendHeaders forwards one validated uid and optional authorization", () => {
  assert.deepEqual(buildBackendHeaders("firebase_UID-123"), {
    Accept: "application/json",
    "X-Authenticated-User": "firebase_UID-123",
  });
  assert.deepEqual(buildBackendHeaders("firebase_UID-123", "google-token"), {
    Accept: "application/json",
    "X-Authenticated-User": "firebase_UID-123",
    Authorization: "Bearer google-token",
  });
  for (const uid of ["", "contains space", "bad:value", "x".repeat(129)]) {
    assert.throws(() => buildBackendHeaders(uid), /Invalid authenticated user id/);
  }
});
