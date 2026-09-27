import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_API_ERROR,
  MAX_API_ERROR_CHARS,
  MAX_TRANSIENT_POLL_FAILURES,
  MAX_UPLOAD_BYTES,
  SIGN_IN_API_ERROR,
  UploadApiError,
  apiErrorMessage,
  pollFailureAction,
  SESSION_ID,
  parseCreatedSession,
  parseProcessResult,
  parseSessionState,
  putToSignedUrl,
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
