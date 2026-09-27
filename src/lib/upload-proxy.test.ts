import assert from "node:assert/strict";
import test from "node:test";
import { UPLOAD_ROUTE_MESSAGES, proxyBackend, sessionPath, type LiveBackendConfig, type ProxyOptions } from "./upload-proxy.ts";
import { parseProcessResult, parseSessionState } from "./upload-sessions.ts";

const ID = `SES_${"0f".repeat(16)}`;
const oidc: LiveBackendConfig = {
  mode: "live", url: "https://api.example.test/prefix/", auth: "google-oidc",
  projectNumber: "1", workloadIdentityPoolId: "p", workloadIdentityPoolProviderId: "v", serviceAccountEmail: "s@x.test",
};
const local: LiveBackendConfig = { mode: "live", url: "http://127.0.0.1:8000/", auth: "none" };

function fakeFetch(status: number, body: unknown | (() => never) = { status: "queued" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: url.href, init });
    return {
      ok: status >= 200 && status < 300, status,
      json: async () => (typeof body === "function" ? (body as () => never)() : body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function run(fetchImpl: typeof fetch, extra: Partial<ProxyOptions> = {}) {
  return proxyBackend({
    config: oidc, uid: "user_1", token: "tok", path: sessionPath(ID, "process")!,
    init: { method: "POST" }, fetchImpl, parse: parseProcessResult, ...extra,
  });
}

test("joins paths under a BACKEND_URL prefix and sends auth headers for google-oidc", async () => {
  const { impl, calls } = fakeFetch(202);
  const result = await run(impl);
  assert.deepEqual(result, { status: 202, body: { status: "queued" } });
  assert.equal(calls[0].url, `https://api.example.test/prefix/projects/upload-sessions/${ID}/process`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["X-Authenticated-User"], "user_1");
  assert.equal(calls[0].init.method, "POST");
});

test("preview sends no auth headers", async () => {
  const { impl, calls } = fakeFetch(200);
  await run(impl, { config: local, uid: null, token: undefined });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-Authenticated-User"], undefined);
  assert.equal(calls[0].url, `http://127.0.0.1:8000/projects/upload-sessions/${ID}/process`);
});

test("google-oidc without a token or user never fetches", async () => {
  const { impl, calls } = fakeFetch(200);
  await assert.rejects(run(impl, { token: undefined }));
  await assert.rejects(run(impl, { uid: null }));
  assert.equal(calls.length, 0);
});

test("JSON bodies are forwarded", async () => {
  const { impl, calls } = fakeFetch(201, {});
  await run(impl, { path: "projects/upload-sessions", init: { method: "POST", body: { size_bytes: 10 } }, parse: (v) => v });
  assert.equal(calls[0].init.body, JSON.stringify({ size_bytes: 10 }));
  assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("status mapping passes 404/409/422/503 through and maps the rest to 502", async () => {
  for (const [backend, expected] of [[404, 404], [409, 409], [422, 422], [503, 503], [500, 502], [400, 502], [401, 502], [403, 502]]) {
    const result = await run(fakeFetch(backend, { detail: "secret internals" }).impl);
    assert.equal(result.status, expected, String(backend));
    assert.equal(JSON.stringify(result.body).includes("secret"), false);
  }
});

test("onAuthReject fires only on 401/403", async () => {
  for (const [backend, fired] of [[401, 1], [403, 1], [404, 0], [500, 0]] as const) {
    let count = 0;
    await run(fakeFetch(backend).impl, { onAuthReject: () => { count++; } });
    assert.equal(count, fired, String(backend));
  }
});

test("malformed or invalid JSON and network errors map to 502", async () => {
  assert.equal((await run(fakeFetch(200, () => { throw new SyntaxError("bad"); }).impl)).status, 502);
  assert.equal((await run(fakeFetch(200, { status: "exploded" }).impl)).status, 502);
  assert.equal((await run(fakeFetch(200, { ...{ session_id: ID } }).impl, { parse: parseSessionState })).status, 502);
  const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  assert.equal((await run(failing)).status, 502);
});

test("invalid session ids never build a path or fetch", async () => {
  for (const bad of ["SES_x", "../admin", `${ID}/../x`, `SES_${"A".repeat(32)}`, ""]) {
    assert.equal(sessionPath(bad), null);
    assert.equal(sessionPath(bad, "process"), null);
  }
  assert.equal(sessionPath(ID), `projects/upload-sessions/${ID}`);
  const { impl, calls } = fakeFetch(200);
  for (const path of ["/projects/x", "projects/../x", "projects//x", "projects/x?y=1"]) {
    await assert.rejects(run(impl, { path }));
  }
  assert.equal(calls.length, 0);
});

test("upload-session routes keep the default pass-through copy", async () => {
  const notFound = await run(fakeFetch(404).impl);
  assert.deepEqual(notFound.body, { error: "Upload session not found." });
  const invalid = await run(fakeFetch(422).impl);
  assert.deepEqual(invalid.body, { error: "The upload request or PDF was rejected." });
});

test("per-route messages override pass-through copy without changing statuses", async () => {
  const opts = { path: "projects/uploads", init: { method: "GET" as const }, parse: (v: unknown) => v, messages: UPLOAD_ROUTE_MESSAGES };
  const notFound = await run(fakeFetch(404).impl, opts);
  assert.deepEqual(notFound, { status: 404, body: { error: "Upload not found." } });
  const invalid = await run(fakeFetch(422).impl, opts);
  assert.deepEqual(invalid, { status: 422, body: { error: "Invalid upload id." } });
  // Statuses without an override fall back to the default copy; others still map to 502.
  const conflict = await run(fakeFetch(409).impl, opts);
  assert.deepEqual(conflict, { status: 409, body: { error: "The PDF has not finished uploading." } });
  const server = await run(fakeFetch(500).impl, { ...opts, messages: { 404: "x" } });
  assert.deepEqual(server, { status: 502, body: { error: "Upload backend unavailable. Try again shortly." } });
});

test("sessionPath builds the cancel path and rejects bad ids for it", async () => {
  assert.equal(sessionPath(ID, "cancel"), `projects/upload-sessions/${ID}/cancel`);
  assert.equal(sessionPath(ID, "process"), `projects/upload-sessions/${ID}/process`);
  for (const bad of ["SES_x", "../admin", `${ID}/../x`, ""]) assert.equal(sessionPath(bad, "cancel"), null);
  const view = { session_id: ID, status: "cancelled", upload_id: null, error_code: null, updated_at: "2026-09-27T12:21:00Z" };
  const { impl, calls } = fakeFetch(200, view);
  const result = await run(impl, { path: sessionPath(ID, "cancel")!, parse: parseSessionState });
  assert.equal(result.status, 200);
  assert.equal((result.body as { status: string }).status, "cancelled");
  assert.equal(calls[0].url, `https://api.example.test/prefix/projects/upload-sessions/${ID}/cancel`);
  assert.equal(calls[0].init.method, "POST");
  // Proxy copy for the cancel route: unknown/foreign -> 404 text, bad id -> 422, GcsError -> 502.
  assert.deepEqual(await run(fakeFetch(404).impl, { path: sessionPath(ID, "cancel")!, parse: parseSessionState }),
    { status: 404, body: { error: "Upload session not found." } });
  assert.equal((await run(fakeFetch(422).impl, { path: sessionPath(ID, "cancel")!, parse: parseSessionState })).status, 422);
  assert.equal((await run(fakeFetch(502).impl, { path: sessionPath(ID, "cancel")!, parse: parseSessionState })).status, 502);
});
