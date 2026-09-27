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
const noStage = { stage: null, stage_detail: null, stage_started_at: null, kind: null };

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
  assert.deepEqual(parseSessionState({ ...state, secret: 1 }), { ...state, ...noStage });
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

// ---- Stage fields, CSV kind, onProgress/onQueued (HARNESS-FRONTEND-REVAMP-001) ----
import {
  MAX_CSV_BYTES,
  UploadCancelledError,
  isSessionNotFoundError,
  isUploadCancelled,
  kindFromContentType,
  pollUploadSession,
  sessionProgress,
  splitCsvLine,
  uploadKindOf,
  validateCsv,
} from "./upload-sessions.ts";
import type { UploadProgress } from "./upload-progress.ts";

const processing = { ...state, status: "processing", upload_id: null };

test("parseSessionState accepts valid stage fields", () => {
  const parsed = parseSessionState({
    ...processing, stage: "extracting", stage_detail: { done: 3, total: 9, extra: 1 },
    stage_started_at: "2026-09-27T12:19:00Z", kind: "csv",
  });
  assert.equal(parsed.stage, "extracting");
  assert.deepEqual(parsed.stage_detail, { done: 3, total: 9 });
  assert.equal(parsed.stage_started_at, "2026-09-27T12:19:00Z");
  assert.equal(parsed.kind, "csv");
  assert.equal(parseSessionState({ ...processing, stage: "summarizing" }).stage, "summarizing");
});

test("parseSessionState nulls unknown stage and malformed progress fields", () => {
  for (const bad of [
    { stage: "exploding" }, { stage: 3 }, { stage_detail: { done: 5, total: 4 } },
    { stage_detail: { done: -1, total: 4 } }, { stage_detail: { done: 1.5, total: 4 } },
    { stage_detail: { done: 1, total: 100_001 } }, { stage_detail: [1, 2] }, { stage_detail: "1/2" },
    { stage_started_at: "yesterday" }, { stage_started_at: 5 }, { kind: "png" },
  ]) {
    const parsed = parseSessionState({ ...processing, ...bad });
    assert.equal(parsed.status, "processing", JSON.stringify(bad));
    assert.deepEqual(
      { stage: parsed.stage, stage_detail: parsed.stage_detail, stage_started_at: parsed.stage_started_at, kind: parsed.kind },
      noStage, JSON.stringify(bad),
    );
  }
  assert.deepEqual(parseSessionState({ ...processing, stage_detail: { done: 100_000, total: 100_000 } }).stage_detail, { done: 100_000, total: 100_000 });
});

test("parseCreatedSession accepts a CSV session within the CSV cap", () => {
  const csv = { ...created, required_headers: { "Content-Type": "text/csv", "x-goog-content-length-range": `1,${MAX_CSV_BYTES}` } };
  assert.equal(parseCreatedSession(csv).required_headers["Content-Type"], "text/csv");
  assert.throws(() => parseCreatedSession({ ...csv, required_headers: { ...csv.required_headers, "x-goog-content-length-range": `1,${MAX_CSV_BYTES + 1}` } }));
  assert.throws(() => parseCreatedSession({ ...csv, required_headers: { ...csv.required_headers, "Content-Type": "text/csv; charset=utf-8" } }));
});

test("uploadKindOf and kindFromContentType", () => {
  assert.equal(uploadKindOf({ name: "Plan.PDF", type: "" }), "pdf");
  assert.equal(uploadKindOf({ name: "projects.csv", type: "application/vnd.ms-excel" }), "csv");
  assert.equal(uploadKindOf({ name: "photo.png", type: "application/pdf" }), null);
  assert.equal(uploadKindOf({ name: "noext", type: "text/csv" }), "csv");
  assert.equal(uploadKindOf({}), null);
  assert.equal(kindFromContentType("application/pdf"), "pdf");
  assert.equal(kindFromContentType("image/png"), null);
});

test("splitCsvLine handles quotes", () => {
  const line = ["project_id", "\"project_name\"", "\"a \"\"q\"\", b\"", "utility"].join(",");
  assert.deepEqual(splitCsvLine(line), ["project_id", "project_name", "a \"q\", b", "utility"]);
});

test("validateCsv checks size, UTF-8 and the required header", async () => {
  assert.deepEqual(await validateCsv(new Blob(["project_id,project_name,utility\r\nP1,A,U\n"])), { ok: true });
  assert.deepEqual(await validateCsv(new Blob(["﻿utility,\"project_name\",project_id,state"])), { ok: true });
  assert.equal((await validateCsv(new Blob([]))).ok, false);
  assert.match((await validateCsv(new Blob(["project_id,utility\nP1,U"])) as { error: string }).error, /project_name/);
  assert.match((await validateCsv(new Blob([new Uint8Array([0x70, 0xff, 0xfe, 0x0a])])) as { error: string }).error, /UTF-8/);
  const big = { size: MAX_CSV_BYTES + 1, slice: () => new Blob(["project_id,project_name,utility\n"]) } as unknown as Blob;
  assert.equal((await validateCsv(big)).ok, false);
});

const csvCreated = { ...created, required_headers: { "Content-Type": "text/csv", "x-goog-content-length-range": `1,${MAX_CSV_BYTES}` } };

test("runUploadSession emits onProgress in order and fires onQueued once before polling", async () => {
  const deps = fakeDeps([
    { ...processing, stage: "extracting", stage_detail: { done: 1, total: 2 } },
    { ...processing, stage: "extracting", stage_detail: { done: 1, total: 2 } },
    { ...processing, stage: "saving" },
    state,
  ]);
  const events: string[] = [];
  const progress: UploadProgress[] = [];
  const result = await runUploadSession(pdf(), {
    onProgress: (p) => { progress.push(p); events.push(`progress:${p.phase}`); },
    onQueued: (id) => events.push(`queued:${id}:${deps.calls.length}`),
  }, deps);
  assert.equal(result.upload_id, "UPL_abc123");
  assert.deepEqual(progress, [
    { kind: "pdf", phase: "checking" },
    { kind: "pdf", phase: "preparing" },
    { kind: "pdf", phase: "uploading", percent: 0 },
    { kind: "pdf", phase: "uploading", percent: 100 },
    { kind: "pdf", phase: "queued" },
    { kind: "pdf", phase: "processing", stage: "extracting", detail: { done: 1, total: 2 } },
    { kind: "pdf", phase: "processing", stage: "saving", detail: null },
    { kind: "pdf", phase: "succeeded", uploadId: "UPL_abc123" },
  ]);
  // onQueued fires after POST create + POST process (2 calls) and before the first GET.
  assert.deepEqual(events.filter((e) => e.startsWith("queued:")), [`queued:${ID}:2`]);
  assert.ok(events.indexOf(`queued:${ID}:2`) < events.indexOf("progress:queued"));
});

test("runUploadSession sends content_type by kind and validates CSV", async () => {
  const bodies: unknown[] = [];
  const deps = fakeDeps([state]);
  const inner = deps.callApi;
  deps.callApi = async (path, init) => {
    if (path === "/api/upload-sessions") { bodies.push(init?.body); return csvCreated; }
    return inner(path, init);
  };
  const csv = new File(["project_id,project_name,utility\nP,A,U\n"], "projects.csv", { type: "text/csv" });
  const progress: UploadProgress[] = [];
  const labels: string[] = [];
  await runUploadSession(csv, { onProgress: (p) => progress.push(p), onStatus: (l) => labels.push(l) }, deps);
  assert.deepEqual(bodies, [{ size_bytes: csv.size, content_type: "text/csv" }]);
  assert.equal(progress[0].kind, "csv");
  assert.equal(labels[0], "Checking CSV...");
  const bad = fakeDeps([]);
  await assert.rejects(runUploadSession(new File(["a,b\n"], "x.csv"), {}, bad), /project_id/);
  assert.deepEqual(bad.calls, []);
});

test("runUploadSession pdf create body includes application/pdf", async () => {
  const deps = fakeDeps([state]);
  let body: unknown;
  const inner = deps.callApi;
  deps.callApi = async (path, init) => { if (path === "/api/upload-sessions") body = init?.body; return inner(path, init); };
  await runUploadSession(pdf(), {}, deps);
  assert.deepEqual(body, { size_bytes: pdf().size, content_type: "application/pdf" });
});

test("runUploadSession rejects a session signed for the other kind", async () => {
  const deps = fakeDeps([state]);
  const inner = deps.callApi;
  deps.callApi = async (path, init) => (path === "/api/upload-sessions" ? csvCreated : inner(path, init));
  await assert.rejects(runUploadSession(pdf(), {}, deps), { message: "Invalid required_headers" });
});

test("runUploadSession emits failure progress with client and backend error codes", async () => {
  const seen: UploadProgress[] = [];
  await assert.rejects(runUploadSession(new Blob(["hello"]), { onProgress: (p) => seen.push(p) }, fakeDeps([])));
  assert.deepEqual(seen.at(-1), { kind: "pdf", phase: "failed", stage: null, errorCode: "invalid_file" });

  const putFails = fakeDeps([]);
  putFails.put = (async () => { throw new Error("Upload to storage failed"); }) as typeof putToSignedUrl;
  seen.length = 0;
  await assert.rejects(runUploadSession(pdf(), { onProgress: (p) => seen.push(p) }, putFails));
  assert.equal(seen.at(-1)?.errorCode, "upload_failed");

  const notFound = new UploadApiError(404, "Upload session not found.");
  seen.length = 0;
  await assert.rejects(runUploadSession(pdf(), { onProgress: (p) => seen.push(p) },
    fakeDeps([{ ...processing, stage: "parsing" }, notFound])));
  assert.deepEqual(seen.at(-1), { kind: "pdf", phase: "failed", stage: "parsing", errorCode: "session_not_found" });

  seen.length = 0;
  const serverError = new UploadApiError(500, "x");
  await assert.rejects(runUploadSession(pdf(), { onProgress: (p) => seen.push(p) },
    fakeDeps([{ ...processing, stage: "parsing" }, serverError])));
  assert.equal(seen.at(-1)?.errorCode, "poll_failed");

  seen.length = 0;
  const failed = await runUploadSession(pdf(), { onProgress: (p) => seen.push(p) },
    fakeDeps([{ ...processing, status: "failed", stage: "extracting", error_code: "snowflake_failed" }]));
  assert.equal(failed.status, "failed");
  assert.deepEqual(seen.at(-1), { kind: "pdf", phase: "failed", stage: "extracting", errorCode: "snowflake_failed" });
});

test("a navigation abort after onQueued rejects quietly without failure progress", async () => {
  const controller = new AbortController();
  const deps = fakeDeps([{ ...processing }, state]);
  const seen: UploadProgress[] = [];
  let queued = 0;
  const run = runUploadSession(pdf(), {
    signal: controller.signal,
    onProgress: (p) => seen.push(p),
    onQueued: () => { queued += 1; controller.abort(); },
  }, deps);
  await assert.rejects(run, (e) => e instanceof UploadCancelledError && isUploadCancelled(e));
  assert.equal(queued, 1);
  assert.equal(seen.some((p) => p.phase === "failed"), false);
  assert.equal(deps.calls.filter((c) => c.startsWith("GET")).length, 0);
});

test("an abort that surfaces as a fetch error is still reported as cancelled", async () => {
  const controller = new AbortController();
  const deps = fakeDeps([]);
  const inner = deps.callApi;
  deps.callApi = async (path, init) => {
    if (path.endsWith("/process")) { controller.abort(); throw new UploadApiError(null, GENERIC_API_ERROR); }
    return inner(path, init);
  };
  const seen: UploadProgress[] = [];
  await assert.rejects(runUploadSession(pdf(), { signal: controller.signal, onProgress: (p) => seen.push(p) }, deps),
    (e) => e instanceof UploadCancelledError);
  assert.equal(seen.some((p) => p.phase === "failed"), false);
});

test("pollUploadSession resumes an existing session and polls immediately", async () => {
  const deps = fakeDeps([{ ...processing, stage: "matching", kind: "csv" }, state]);
  let sleeps = 0;
  deps.sleep = async () => { sleeps += 1; };
  const seen: UploadProgress[] = [];
  const result = await pollUploadSession(ID, { onProgress: (p) => seen.push(p) }, deps);
  assert.equal(result.upload_id, "UPL_abc123");
  assert.equal(sleeps, 1);
  assert.deepEqual(seen, [
    { kind: "csv", phase: "processing", stage: "matching", detail: null },
    { kind: "csv", phase: "succeeded", uploadId: "UPL_abc123" },
  ]);
  await assert.rejects(pollUploadSession("SES_bad", {}, deps), { message: "Invalid session_id" });
});

test("sessionProgress maps statuses", () => {
  const parsed = parseSessionState({ ...processing, status: "failed", error_code: "timeout", stage: "locating" });
  assert.deepEqual(sessionProgress("failed", parsed, "pdf"), { kind: "pdf", phase: "failed", stage: "locating", errorCode: "timeout" });
  assert.deepEqual(sessionProgress("created", null), { phase: "queued" });
});

test("isSessionNotFoundError matches only 401/403/404 upload API errors", () => {
  for (const status of [401, 403, 404]) assert.equal(isSessionNotFoundError(new UploadApiError(status, "x")), true, String(status));
  for (const reason of [new UploadApiError(null, "x"), new UploadApiError(422, "x"), new UploadApiError(503, "x"), new Error("404")]) {
    assert.equal(isSessionNotFoundError(reason), false, String(reason));
  }
});

test("pollUploadSession reports expired or foreign sessions as session_not_found", async () => {
  for (const status of [401, 403, 404]) {
    const seen: UploadProgress[] = [];
    const reason = new UploadApiError(status, "Upload session not found.");
    await assert.rejects(pollUploadSession(ID, { onProgress: (p) => seen.push(p) }, fakeDeps([reason])), (e) => e === reason);
    assert.deepEqual(seen, [{ kind: "pdf", phase: "failed", stage: null, errorCode: "session_not_found" }], String(status));
  }
});

test("pollUploadSession keeps poll_failed for exhausted transient failures", async () => {
  const flaky = new UploadApiError(503, "x");
  const seen: UploadProgress[] = [];
  await assert.rejects(pollUploadSession(ID, { onProgress: (p) => seen.push(p) }, fakeDeps([flaky, flaky, flaky])),
    { message: POLL_GAVE_UP_MESSAGE });
  assert.equal(seen.at(-1)?.errorCode, "poll_failed");
});
