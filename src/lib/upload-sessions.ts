// Client-safe helpers for the large-upload session flow (PDF and CSV). The
// browser only talks to /api/upload-sessions/* and to the signed GCS URL.
import type { UploadProgress } from "./upload-progress.ts";

/** PDF size cap (50 MB); kept under its historical name. */
export const MAX_UPLOAD_BYTES = 52_428_800;
export const MAX_CSV_BYTES = 10_485_760;
export const SESSION_ID = /^SES_[a-f0-9]{32}$/;
export const SESSION_STATUSES = ["created", "queued", "processing", "succeeded", "failed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const SESSION_STAGES = [
  "validating", "staging", "parsing", "extracting", "locating", "matching", "saving", "summarizing",
] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];
export const UPLOAD_KINDS = ["pdf", "csv"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export const UPLOAD_CONTENT_TYPES = { pdf: "application/pdf", csv: "text/csv" } as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[UploadKind];
export const MAX_BYTES_BY_KIND: Record<UploadKind, number> = { pdf: MAX_UPLOAD_BYTES, csv: MAX_CSV_BYTES };
export const CSV_REQUIRED_COLUMNS = ["project_id", "project_name", "utility"] as const;
const MAX_STAGE_TOTAL = 100_000;

/** Kind for an allow-listed content type, else null. */
export function kindFromContentType(value: unknown): UploadKind | null {
  if (value === UPLOAD_CONTENT_TYPES.pdf) return "pdf";
  if (value === UPLOAD_CONTENT_TYPES.csv) return "csv";
  return null;
}

/**
 * Kind of a picked file: extension first (Windows often labels CSV as
 * application/vnd.ms-excel), then MIME type. Null means unsupported.
 */
export function uploadKindOf(file: { name?: string; type?: string }): UploadKind | null {
  const name = (file.name ?? "").toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".csv")) return "csv";
  if (/\.[a-z0-9]{1,8}$/.test(name)) return null;
  return kindFromContentType(file.type);
}

export type CreatedSession = {
  session_id: string;
  upload_url: string;
  method: "PUT";
  required_headers: { "Content-Type": UploadContentType; "x-goog-content-length-range": string };
  expires_at: string;
};

export type ProcessResult = { status: SessionStatus };

export type StageDetail = { done: number; total: number };

export type SessionState = {
  session_id: string;
  status: SessionStatus;
  upload_id: string | null;
  error_code: string | null;
  updated_at: string;
  /** Optional backend progress fields; null when absent or unrecognised. */
  stage: SessionStage | null;
  stage_detail: StageDetail | null;
  stage_started_at: string | null;
  kind: UploadKind | null;
};

const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;
const LENGTH_RANGE = /^1,(\d{1,12})$/;

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${what}`);
  return value as Record<string, unknown>;
}

function text(r: Record<string, unknown>, key: string, max = 2048): string {
  const v = r[key];
  if (typeof v !== "string" || !v || v.length > max) throw new Error(`Invalid ${key}`);
  return v;
}

function sessionId(r: Record<string, unknown>): string {
  const v = text(r, "session_id", 64);
  if (!SESSION_ID.test(v)) throw new Error("Invalid session_id");
  return v;
}

function status(r: Record<string, unknown>): SessionStatus {
  const v = r.status;
  if (typeof v !== "string" || !(SESSION_STATUSES as readonly string[]).includes(v)) throw new Error("Invalid status");
  return v as SessionStatus;
}

function nullable(r: Record<string, unknown>, key: string, pattern: RegExp): string | null {
  const v = r[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !pattern.test(v)) throw new Error(`Invalid ${key}`);
  return v;
}

export function parseCreatedSession(value: unknown): CreatedSession {
  const r = record(value, "upload session");
  const uploadUrl = text(r, "upload_url", 8192);
  let url: URL;
  try { url = new URL(uploadUrl); } catch { throw new Error("Invalid upload_url"); }
  if (url.protocol !== "https:" || url.hostname !== "storage.googleapis.com" || url.username || url.password) {
    throw new Error("Invalid upload_url");
  }
  if (r.method !== "PUT") throw new Error("Invalid method");
  const headers = record(r.required_headers, "required_headers");
  const keys = Object.keys(headers).sort();
  if (keys.length !== 2 || keys[0] !== "Content-Type" || keys[1] !== "x-goog-content-length-range") {
    throw new Error("Invalid required_headers");
  }
  const contentType = headers["Content-Type"];
  const kind = kindFromContentType(contentType);
  if (!kind) throw new Error("Invalid required_headers");
  const range = headers["x-goog-content-length-range"];
  const match = typeof range === "string" ? LENGTH_RANGE.exec(range) : null;
  if (!match || Number(match[1]) < 1 || Number(match[1]) > MAX_BYTES_BY_KIND[kind]) throw new Error("Invalid required_headers");
  const expiresAt = text(r, "expires_at", 64);
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error("Invalid expires_at");
  return {
    session_id: sessionId(r),
    upload_url: url.href,
    method: "PUT",
    required_headers: { "Content-Type": UPLOAD_CONTENT_TYPES[kind], "x-goog-content-length-range": range as string },
    expires_at: expiresAt,
  };
}

export function parseProcessResult(value: unknown): ProcessResult {
  return { status: status(record(value, "process result")) };
}

function stage(value: unknown): SessionStage | null {
  return typeof value === "string" && (SESSION_STAGES as readonly string[]).includes(value) ? value as SessionStage : null;
}

function stageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_STAGE_TOTAL ? value : null;
}

function stageDetail(value: unknown): StageDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const done = stageCount(r.done);
  const total = stageCount(r.total);
  return done !== null && total !== null && done <= total ? { done, total } : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : null;
}

function kindValue(value: unknown): UploadKind | null {
  return value === "pdf" || value === "csv" ? value : null;
}

/**
 * Allow-lists the session view. Progress fields (stage, stage_detail,
 * stage_started_at, kind) are optional and never fail the parse: unknown or
 * malformed values become null so older and newer backends both work.
 */
export function parseSessionState(value: unknown): SessionState {
  const r = record(value, "session status");
  const state: SessionState = {
    session_id: sessionId(r),
    status: status(r),
    upload_id: nullable(r, "upload_id", UPLOAD_ID),
    error_code: nullable(r, "error_code", ERROR_CODE),
    updated_at: text(r, "updated_at", 64),
    stage: stage(r.stage),
    stage_detail: stageDetail(r.stage_detail),
    stage_started_at: timestamp(r.stage_started_at),
    kind: kindValue(r.kind),
  };
  if (state.status === "succeeded" && !state.upload_id) throw new Error("Invalid upload_id");
  return state;
}

export const GENERIC_API_ERROR = "Upload service is unavailable. Try again shortly.";
export const SIGN_IN_API_ERROR = "Sign in again to process PDFs.";
export const MAX_API_ERROR_CHARS = 200;
export const MAX_TRANSIENT_POLL_FAILURES = 3;
export const POLL_GAVE_UP_MESSAGE = "Could not reach the upload service. Processing may still be running; try again later.";

/** A failed call to /api/upload-sessions/*; status is null for network failures. */
export class UploadApiError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "UploadApiError";
    this.status = status;
  }
}

/**
 * User-facing message for a failed proxy response. Only the proxy's JSON
 * `error` string is shown (upload-proxy.ts emits fixed messages); anything
 * else falls back to the generic text.
 */
export function apiErrorMessage(status: number, body: unknown): string {
  if (status === 401) return SIGN_IN_API_ERROR;
  if (!body || typeof body !== "object" || Array.isArray(body)) return GENERIC_API_ERROR;
  const raw = (body as Record<string, unknown>).error;
  if (typeof raw !== "string") return GENERIC_API_ERROR;
  // Drop control characters and collapse whitespace before capping.
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return GENERIC_API_ERROR;
  return clean.length > MAX_API_ERROR_CHARS ? `${clean.slice(0, MAX_API_ERROR_CHARS - 3)}...` : clean;
}

/** Network failures and 502/503 are worth retrying while polling; everything else is final. */
export function isTransientPollError(reason: unknown): boolean {
  return reason instanceof UploadApiError && (reason.status === null || reason.status === 502 || reason.status === 503);
}

/** 401/403/404 while polling: the session expired or belongs to another account. */
export function isSessionNotFoundError(reason: unknown): boolean {
  return reason instanceof UploadApiError && (reason.status === 401 || reason.status === 403 || reason.status === 404);
}

export type PollFailureAction =
  | { action: "retry"; consecutive: number }
  | { action: "give-up" }
  | { action: "fatal" };

/**
 * Polling policy for a failed status poll. `consecutive` is the number of
 * transient failures seen since the last successful poll. Non-transient
 * errors (404, 422, parse failures, ...) are fatal; the
 * MAX_TRANSIENT_POLL_FAILURES-th consecutive transient failure gives up.
 */
export function pollFailureAction(consecutive: number, reason: unknown): PollFailureAction {
  if (!isTransientPollError(reason)) return { action: "fatal" };
  const next = consecutive + 1;
  return next >= MAX_TRANSIENT_POLL_FAILURES ? { action: "give-up" } : { action: "retry", consecutive: next };
}

export type PdfCheck ={ ok: true } | { ok: false; error: string };

/** Size limit plus the %PDF- magic bytes; the backend re-checks both. */
export async function validatePdf(file: Blob): Promise<PdfCheck> {
  if (file.size <= 0) return { ok: false, error: "This PDF is empty." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "PDFs sent for processing must be 50 MB or smaller." };
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const magic = String.fromCharCode(...head);
  if (magic !== "%PDF-") return { ok: false, error: "This file is not a PDF." };
  return { ok: true };
}

const CSV_HEADER_SCAN_BYTES = 65_536;

/** Split one CSV record (RFC 4180 quoting) into fields. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { fields.push(field); field = ""; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Size limit, strict UTF-8 on the header row, and the structured-import
 * columns (backend/documentparsing/pipeline.py structured_projects). The
 * backend re-checks all of this.
 */
export async function validateCsv(file: Blob): Promise<PdfCheck> {
  if (file.size <= 0) return { ok: false, error: "This CSV is empty." };
  if (file.size > MAX_CSV_BYTES) return { ok: false, error: "CSV files must be 10 MB or smaller." };
  const head = new Uint8Array(await file.slice(0, CSV_HEADER_SCAN_BYTES).arrayBuffer());
  let end = head.indexOf(0x0a);
  if (end < 0) {
    if (file.size > head.length) return { ok: false, error: "The CSV header row is too long." };
    end = head.length;
  }
  let line: string;
  try {
    // Default ignoreBOM=false strips a UTF-8 BOM, like Python's utf-8-sig.
    line = new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, end));
  } catch {
    return { ok: false, error: "This CSV is not UTF-8 text." };
  }
  const columns = new Set(splitCsvLine(line.replace(/\r$/, "")));
  if (!CSV_REQUIRED_COLUMNS.every((column) => columns.has(column))) {
    return { ok: false, error: "The CSV header must include project_id, project_name, and utility columns." };
  }
  return { ok: true };
}

/** Per-kind client validation before any API call. */
export function validateUploadFile(file: Blob, kind: UploadKind): Promise<PdfCheck> {
  return kind === "csv" ? validateCsv(file) : validatePdf(file);
}

/** Raised when the caller aborts (row removed, retried, or page navigated away). */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
  }
}

/** True for a caller-initiated abort; such rejections must not be shown as errors. */
export function isUploadCancelled(reason: unknown, signal?: AbortSignal): boolean {
  return reason instanceof UploadCancelledError || signal?.aborted === true;
}

type XhrLike = Pick<XMLHttpRequest, "open" | "setRequestHeader" | "send" | "abort" | "status"> & {
  withCredentials: boolean;
  upload: { onprogress: ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

/**
 * PUT the file straight to the signed storage URL. Sends required_headers
 * verbatim (they are part of the signature) and never attaches credentials.
 */
export function putToSignedUrl(
  session: Pick<CreatedSession, "upload_url" | "required_headers">,
  file: Blob,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  createXhr: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new UploadCancelledError()); return; }
    const xhr = createXhr();
    xhr.open("PUT", session.upload_url, true);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(session.required_headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.floor((event.loaded / event.total) * 100)));
      }
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (error?: Error) => {
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? done() : done(new Error("Upload to storage failed")));
    xhr.onerror = () => done(new Error("Upload to storage failed"));
    xhr.onabort = () => done(new UploadCancelledError());
    xhr.send(file);
  });
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  created: "Waiting for upload...",
  queued: "Queued for Snowflake processing...",
  processing: "Processing in Snowflake. Large plans can take a while...",
  succeeded: "Processing finished.",
  failed: "Processing failed.",
};

/** JSON call to /api/upload-sessions/*; failures become UploadApiError with a safe message. */
export async function callUploadApi(path: string, init?: { method: "POST"; body?: unknown }, fetchImpl?: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(path, {
      method: init?.method ?? "GET",
      cache: "no-store",
      headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new UploadApiError(null, GENERIC_API_ERROR);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new UploadApiError(response.status, apiErrorMessage(response.status, body));
  }
  try {
    return await response.json();
  } catch {
    // Never surface a JSON parser message: it can quote the response body.
    throw new UploadApiError(response.status, GENERIC_API_ERROR);
  }
}

export type UploadSessionDeps = {
  callApi?: (path: string, init?: { method: "POST"; body?: unknown }) => Promise<unknown>;
  put?: typeof putToSignedUrl;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;      // default 5_000
  pollLimitMs?: number; // default 70 * 60 * 1000
};
export type UploadSessionResult = SessionState & { status: "succeeded" | "failed" };

export type UploadSessionOptions = {
  /** Legacy plain-text status labels; prefer onProgress. */
  onStatus?: (label: string) => void;
  /** Structured progress for the stepper; emitted only when it changes. */
  onProgress?: (progress: UploadProgress) => void;
  /** Fires once, after /process succeeds and before polling starts. */
  onQueued?: (sessionId: string) => void;
  signal?: AbortSignal;
  /** Defaults to uploadKindOf(file), then "pdf". */
  kind?: UploadKind;
};

const terminal = (s: SessionStatus): s is "succeeded" | "failed" => s === "succeeded" || s === "failed";

/** UploadProgress for a session status plus its latest polled state (null before the first poll). */
export function sessionProgress(status: SessionStatus, state: SessionState | null, kind?: UploadKind): UploadProgress {
  const k = state?.kind ?? kind;
  const base: Pick<UploadProgress, "kind"> = k ? { kind: k } : {};
  switch (status) {
    case "created":
    case "queued":
      return { ...base, phase: "queued" };
    case "processing":
      return { ...base, phase: "processing", stage: state?.stage ?? null, detail: state?.stage_detail ?? null };
    case "succeeded":
      return state?.upload_id ? { ...base, phase: "succeeded", uploadId: state.upload_id } : { ...base, phase: "succeeded" };
    case "failed":
      return { ...base, phase: "failed", stage: state?.stage ?? null, errorCode: state?.error_code ?? null };
  }
}

type ClientStep = "checking" | "preparing" | "uploading" | "queued" | "processing";

type Runner = {
  onStatus?: (label: string) => void;
  emit: (progress: UploadProgress) => void;
  kind: UploadKind;
  callApi: NonNullable<UploadSessionDeps["callApi"]>;
  put: typeof putToSignedUrl;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  pollLimitMs: number;
  signal?: AbortSignal;
  guard: () => void;
  /** Last backend stage seen, kept for failure progress. */
  stage: SessionStage | null;
  step: ClientStep;
};

function runner(options: UploadSessionOptions, deps: UploadSessionDeps, kind: UploadKind): Runner {
  const { onStatus, onProgress, signal } = options;
  let last = "";
  return {
    onStatus, kind, signal,
    emit: (progress) => {
      if (!onProgress) return;
      const key = JSON.stringify(progress);
      if (key === last) return;
      last = key;
      onProgress(progress);
    },
    callApi: deps.callApi ?? ((path, init) => callUploadApi(path, init)),
    put: deps.put ?? putToSignedUrl,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms))),
    now: deps.now ?? Date.now,
    pollMs: deps.pollMs ?? 5_000,
    pollLimitMs: deps.pollLimitMs ?? 70 * 60 * 1000,
    guard: () => { if (signal?.aborted) throw new UploadCancelledError(); },
    stage: null,
    step: "checking",
  };
}

class PollTimeoutError extends Error {}

const CLIENT_ERROR_CODE: Record<ClientStep, string> = {
  checking: "invalid_file",
  preparing: "session_failed",
  uploading: "upload_failed",
  queued: "process_failed",
  processing: "poll_failed",
};

/** Run `body`; an abort becomes UploadCancelledError, anything else emits failure progress first. */
async function withFailureProgress<T>(r: Runner, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (reason) {
    if (isUploadCancelled(reason, r.signal)) {
      throw reason instanceof UploadCancelledError ? reason : new UploadCancelledError();
    }
    const errorCode = reason instanceof PollTimeoutError
      ? "poll_timeout"
      : r.step === "processing" && isSessionNotFoundError(reason) ? "session_not_found" : CLIENT_ERROR_CODE[r.step];
    r.emit({ kind: r.kind, phase: "failed", stage: r.stage, errorCode });
    throw reason;
  }
}

/** Poll until terminal. `initial` is the status reported by /process, or null to poll immediately. */
async function pollLoop(r: Runner, sessionId: string, initial: SessionStatus | null): Promise<UploadSessionResult> {
  const statusPath = `/api/upload-sessions/${sessionId}`;
  let current: SessionStatus | null = initial;
  let latest: SessionState | null = null;
  const deadline = r.now() + r.pollLimitMs;
  let failures = 0;
  for (;;) {
    if (current !== null) {
      r.onStatus?.(SESSION_STATUS_LABELS[current]);
      if (terminal(current)) {
        // The process call only reports a status; fetch the full state once.
        if (!latest) {
          latest = parseSessionState(await r.callApi(statusPath));
          r.guard();
          current = latest.status;
          if (!terminal(current)) continue;
        }
        r.emit(sessionProgress(current, latest, r.kind));
        return { ...latest, status: current };
      }
      r.emit(sessionProgress(current, latest, r.kind));
      if (r.now() >= deadline) throw new PollTimeoutError("Processing is taking longer than expected. Check again later.");
      await r.sleep(r.pollMs);
      r.guard();
    }
    let polled: unknown;
    try {
      polled = await r.callApi(statusPath);
    } catch (reason) {
      r.guard();
      const next = pollFailureAction(failures, reason);
      if (next.action === "fatal") throw reason;
      if (next.action === "give-up") throw new Error(POLL_GAVE_UP_MESSAGE);
      failures = next.consecutive;
      // Without a first successful poll, wait before retrying.
      current ??= "queued";
      continue;
    }
    r.guard();
    failures = 0;
    latest = parseSessionState(polled);
    current = latest.status;
    if (latest.stage) r.stage = latest.stage;
    if (latest.kind) r.kind = latest.kind;
  }
}

/**
 * Validate, create a session, PUT to the signed URL, start processing and poll
 * until a terminal state. Parser errors ("Invalid ...") propagate as-is. An
 * abort always rejects with UploadCancelledError (check isUploadCancelled) and
 * emits no failure progress; other errors emit a failed UploadProgress first.
 */
export async function runUploadSession(
  file: Blob,
  options: UploadSessionOptions,
  deps: UploadSessionDeps = {},
): Promise<UploadSessionResult> {
  const kind = options.kind ?? uploadKindOf(file as Blob & { name?: string }) ?? "pdf";
  const r = runner(options, deps, kind);
  return withFailureProgress(r, async () => {
    r.guard();
    r.onStatus?.(kind === "csv" ? "Checking CSV..." : "Checking PDF...");
    r.emit({ kind, phase: "checking" });
    const check = await validateUploadFile(file, kind);
    if (!check.ok) throw new Error(check.error);
    r.guard();
    r.step = "preparing";
    r.onStatus?.("Preparing upload...");
    r.emit({ kind, phase: "preparing" });
    const session = parseCreatedSession(await r.callApi("/api/upload-sessions", {
      method: "POST", body: { size_bytes: file.size, content_type: UPLOAD_CONTENT_TYPES[kind] },
    }));
    if (session.required_headers["Content-Type"] !== UPLOAD_CONTENT_TYPES[kind]) throw new Error("Invalid required_headers");
    r.guard();
    r.step = "uploading";
    r.onStatus?.("Uploading 0%");
    r.emit({ kind, phase: "uploading", percent: 0 });
    await r.put(session, file, (percent) => {
      r.onStatus?.(`Uploading ${percent}%`);
      r.emit({ kind, phase: "uploading", percent });
    }, r.signal);
    r.guard();
    r.step = "queued";
    const processed = parseProcessResult(
      await r.callApi(`/api/upload-sessions/${session.session_id}/process`, { method: "POST" }),
    ).status;
    r.guard();
    r.step = "processing";
    options.onQueued?.(session.session_id);
    r.guard();
    return pollLoop(r, session.session_id, processed);
  });
}

/**
 * Resume polling an existing session (the /summary page). Emits the same
 * progress as runUploadSession from the queued step on.
 */
export async function pollUploadSession(
  sessionId: string,
  options: Omit<UploadSessionOptions, "onQueued">,
  deps: UploadSessionDeps = {},
): Promise<UploadSessionResult> {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session_id");
  const r = runner(options, deps, options.kind ?? "pdf");
  r.step = "processing";
  return withFailureProgress(r, async () => {
    r.guard();
    return pollLoop(r, sessionId, null);
  });
}
