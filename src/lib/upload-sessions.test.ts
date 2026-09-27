import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_API_ERROR,
  MAX_API_ERROR_CHARS,
  MAX_TRANSIENT_POLL_FAILURES,
  MAX_UPLOAD_BYTES,
  POLL_GAVE_UP_MESSAGE,
  SESSION_STATUS_LABELS,
  SIGN_IN_API_ERROR,
  UploadApiError,
  apiErrorMessage,
  callUploadApi,
  pollFailureAction,
  SESSION_ID,
  parseCreatedSession,
  parseProcessResult,
  parseSessionState,
  putToSignedUrl,
  runUploadSession,
  validatePdf,
} from "./upload-sessions.ts";

const ID = `SES_${"a1".repeat(16)}`;
const created = {
  session_id: ID,
  upload_url: "https://storage.googleapis.com/bucket/uploads/x.pdf?X-Goog-Signature=abc",
  method: "PUT",
  required_headers: { "Content-Type": "application/pdf", "x-goog-content-length-range": `1,${MAX_UPLOAD_BYTES}` },
  expires_at: "2026-09-27T12:15:00Z",
};
const state = { session_id: ID, status: "succeeded", upload_id: "UPL_abc123", error_code: null, updated_at: "2026-09-27T12:20:00Z" };

test("session id regex", () => {
  assert.ok(SESSION_ID.test(ID));
  for (const bad of ["SES_abc", `SES_${"A".repeat(32)}`, `ses_${"a".repeat(32)}`, `SES_${"a".repeat(32)}/x`, `x${ID}`]) {
    assert.equal(SESSION_ID.test(bad), false, bad);
  }
});

test("validatePdf checks size and magic bytes", async () => {
  assert.deepEqual(await validatePdf(new Blob(["%PDF-1.7\n"])), { ok: true });
  assert.equal((await validatePdf(new Blob([]))).ok, false);
  assert.equal((await validatePdf(new Blob(["hello world"]))).ok, false);
  assert.equal((await validatePdf(new Blob(["%PD"]))).ok, false);
  const big = { size: MAX_UPLOAD_BYTES + 1, slice: () => new Blob(["%PDF-"]) } as unknown as Blob;
  assert.equal((await validatePdf(big)).ok, false);
});

test("parseCreatedSession accepts a good response and allow-lists fields", () => {
  const parsed = parseCreatedSession({ ...created, extra: "ignored" });
  assert.equal(parsed.session_id, ID);
  assert.equal("extra" in parsed, false);
  assert.deepEqual(parsed.required_headers, created.required_headers);
});

test("parseCreatedSession rejects malformed responses", () => {
  const bad: unknown[] = [
    null, [], "x",
    { ...created, session_id: "SES_nope" },
    { ...created, method: "POST" },
    { ...created, upload_url: "http://storage.googleapis.com/b/o" },
    { ...created, upload_url: "https://evil.example/b/o" },
    { ...created, required_headers: { "Content-Type": "text/plain", "x-goog-content-length-range": "1,10" } },
    { ...created, required_headers: { ...created.required_headers, Authorization: "x" } },
    { ...created, required_headers: { "Content-Type": "application/pdf", "x-goog-content-length-range": `1,${MAX_UPLOAD_BYTES + 1}` } },
    { ...created, expires_at: "soon" },
  ];
  for (const value of bad) assert.throws(() => parseCreatedSession(value), JSON.stringify(value));
});

test("parseProcessResult and parseSessionState", () => {
  assert.deepEqual(parseProcessResult({ status: "queued" }), { status: "queued" });
  assert.throws(() => parseProcessResult({ status: "done" }));
  assert.deepEqual(parseSessionState({ ...state, secret: 1 }), state);
  assert.deepEqual(
    parseSessionState({ ...state, status: "failed", upload_id: null, error_code: "snowflake_failed" }).error_code,
    "snowflake_failed",
  );
  for (const value of [
    { ...state, status: "cancelled" },
    { ...state, status: "succeeded", upload_id: null },
    { ...state, upload_id: 42 },
    { ...state, error_code: "Traceback: boom" },
    { ...state, session_id: "SES_1" },
    { ...state, updated_at: "" },
  ]) assert.throws(() => parseSessionState(value), JSON.stringify(value));
});

test("putToSignedUrl sends required headers verbatim without credentials", async () => {
  const sent: Record<string, string> = {};
  const progress: number[] = [];
  const fake = {
    withCredentials: true, status: 200, upload: { onprogress: null as ((e: ProgressEvent) => void) | null },
    onload: null as (() => void) | null, onerror: null, onabort: null,
    method: "", url: "",
    open(method: string, url: string) { fake.method = method; fake.url = url; },
    setRequestHeader(name: string, value: string) { sent[name] = value; },
    abort() {},
    send() {
      fake.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
      fake.onload?.();
    },
  };
  await putToSignedUrl(parseCreatedSession(created), new Blob(["%PDF-"]), (p) => progress.push(p), undefined, () => fake as never);
  assert.equal(fake.method, "PUT");
  assert.equal(fake.withCredentials, false);
  assert.deepEqual(sent, created.required_headers);
  assert.deepEqual(progress, [50]);
  fake.status = 403;
  await assert.rejects(putToSignedUrl(created as never, new Blob(["%PDF-"]), undefined, undefined, () => fake as never));
});

test("apiErrorMessage shows only the proxy error string, capped", () => {
  assert.equal(apiErrorMessage(404, { error: "Upload session not found." }), "Upload session not found.");
  assert.equal(apiErrorMessage(401, { error: "anything" }), SIGN_IN_API_ERROR);
  for (const body of [null, undefined, "raw text", [], {}, { error: 42 }, { error: "   " }, { detail: "Traceback" }]) {
    assert.equal(apiErrorMessage(502, body), GENERIC_API_ERROR, JSON.stringify(body));
  }
  assert.equal(apiErrorMessage(422, { error: "bad\n\u0007thing" }), "bad thing");
  const long = apiErrorMessage(503, { error: "x".repeat(1000) });
  assert.equal(long.length, MAX_API_ERROR_CHARS);
  assert.ok(long.endsWith("..."));
});

test("pollFailureAction retries transient failures up to the limit", () => {
  const network = new UploadApiError(null, GENERIC_API_ERROR);
  assert.deepEqual(pollFailureAction(0, network), { action: "retry", consecutive: 1 });
  assert.deepEqual(pollFailureAction(1, new UploadApiError(502, "x")), { action: "retry", consecutive: 2 });
  assert.deepEqual(pollFailureAction(MAX_TRANSIENT_POLL_FAILURES - 1, new UploadApiError(503, "x")), { action: "give-up" });
  for (const reason of [new UploadApiError(404, "x"), new UploadApiError(422, "x"), new UploadApiError(401, "x"), new Error("Invalid status"), new TypeError("x")]) {
    assert.deepEqual(pollFailureAction(0, reason), { action: "fatal" }, String(reason));
  }
});

type Reply = unknown | Error;
function fakeDeps(statusReplies: Reply[], processStatus = "queued") {
  const calls: string[] = [];
  const deps = {
    calls,
    callApi: async (path: string, init?: { method: "POST"; body?: unknown }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/upload-sessions") return created;
      if (path.endsWith("/process")) return { status: processStatus };
      const next = statusReplies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    put: (async (_s: unknown, _f: Blob, onProgress?: (p: number) => void) => { onProgress?.(100); }) as typeof putToSignedUrl,
    sleep: async () => {},
    now: () => 0,
  };
  return deps;
}
const pdf = () => new Blob(["%PDF-1.7\n"]);

test("runUploadSession happy path returns upload_id and emits status labels", async () => {
  const deps = fakeDeps([{ ...state, status: "processing", upload_id: null }, state]);
  const labels: string[] = [];
  const result = await runUploadSession(pdf(), { onStatus: (l) => labels.push(l) }, deps);
  assert.equal(result.status, "succeeded");
  assert.equal(result.upload_id, "UPL_abc123");
  assert.deepEqual(labels, [
    "Checking PDF...", "Preparing upload...", "Uploading 0%", "Uploading 100%",
    SESSION_STATUS_LABELS.queued, SESSION_STATUS_LABELS.processing, SESSION_STATUS_LABELS.succeeded,
  ]);
  assert.deepEqual(deps.calls, ["POST /api/upload-sessions", `POST /api/upload-sessions/${ID}/process`, `GET /api/upload-sessions/${ID}`, `GET /api/upload-sessions/${ID}`]);
});

test("runUploadSession fetches full state when process reports a terminal status", async () => {
  const deps = fakeDeps([{ ...state, status: "failed", upload_id: null, error_code: "snowflake_failed" }], "failed");
  const result = await runUploadSession(pdf(), {}, deps);
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "snowflake_failed");
});

test("runUploadSession rejects an invalid PDF before any API call", async () => {
  const deps = fakeDeps([]);
  await assert.rejects(runUploadSession(new Blob(["hello"]), {}, deps), { message: "This file is not a PDF." });
  assert.deepEqual(deps.calls, []);
});

test("runUploadSession retries transient poll failures then gives up", async () => {
  const flaky = new UploadApiError(503, "x");
  const deps = fakeDeps([flaky, flaky, flaky, state]);
  await assert.rejects(runUploadSession(pdf(), {}, deps), { message: POLL_GAVE_UP_MESSAGE });
  assert.equal(deps.calls.filter((c) => c.startsWith("GET")).length, MAX_TRANSIENT_POLL_FAILURES);
});

test("runUploadSession recovers after a transient failure", async () => {
  const deps = fakeDeps([new UploadApiError(502, "x"), state]);
  assert.equal((await runUploadSession(pdf(), {}, deps)).upload_id, "UPL_abc123");
});

test("runUploadSession rethrows fatal poll errors", async () => {
  const notFound = new UploadApiError(404, "Upload session not found.");
  await assert.rejects(runUploadSession(pdf(), {}, fakeDeps([notFound])), (e) => e === notFound);
});

test("runUploadSession stops with Upload cancelled when aborted", async () => {
  const controller = new AbortController();
  const deps = fakeDeps([{ ...state, status: "processing", upload_id: null }, state]);
  deps.sleep = async () => { controller.abort(); };
  await assert.rejects(runUploadSession(pdf(), { signal: controller.signal }, deps), { message: "Upload cancelled" });
  assert.equal(deps.calls.filter((c) => c.startsWith("GET")).length, 0);
});

test("runUploadSession gives up at the deadline", async () => {
  const deps = fakeDeps([{ ...state, status: "processing", upload_id: null }]);
  let t = 0;
  deps.now = () => (t += 1_000);
  await assert.rejects(runUploadSession(pdf(), {}, { ...deps, pollLimitMs: 1_500 }), /taking longer than expected/);
});

test("callUploadApi maps failures to safe messages", async () => {
  let seen: RequestInit | undefined;
  const ok = (async (_p: string, init?: RequestInit) => { seen = init; return Response.json({ status: "queued" }); }) as typeof fetch;
  assert.deepEqual(await callUploadApi("/api/x", { method: "POST", body: { a: 1 } }, ok), { status: "queued" });
  assert.equal(seen?.cache, "no-store");
  assert.equal(seen?.body, JSON.stringify({ a: 1 }));
  const notFound = (async () => Response.json({ error: "Upload session not found." }, { status: 404 })) as typeof fetch;
  await assert.rejects(callUploadApi("/api/x", undefined, notFound), (e) => e instanceof UploadApiError && e.status === 404 && e.message === "Upload session not found.");
  const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  await assert.rejects(callUploadApi("/api/x", undefined, down), (e) => e instanceof UploadApiError && e.status === null && e.message === GENERIC_API_ERROR);
  const garbage = (async () => new Response("<html>secret</html>", { status: 200 })) as typeof fetch;
  await assert.rejects(callUploadApi("/api/x", undefined, garbage), { message: GENERIC_API_ERROR });
});
