// Client-safe helpers for the large-PDF upload session flow. The browser only
// talks to /api/upload-sessions/* and to the signed GCS URL returned by it.

export const MAX_UPLOAD_BYTES = 52_428_800;
export const SESSION_ID = /^SES_[a-f0-9]{32}$/;
export const SESSION_STATUSES = ["created", "queued", "processing", "succeeded", "failed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type CreatedSession = {
  session_id: string;
  upload_url: string;
  method: "PUT";
  required_headers: { "Content-Type": "application/pdf"; "x-goog-content-length-range": string };
  expires_at: string;
};

export type ProcessResult = { status: SessionStatus };

export type SessionState = {
  session_id: string;
  status: SessionStatus;
  upload_id: string | null;
  error_code: string | null;
  updated_at: string;
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
  if (headers["Content-Type"] !== "application/pdf") throw new Error("Invalid required_headers");
  const range = headers["x-goog-content-length-range"];
  const match = typeof range === "string" ? LENGTH_RANGE.exec(range) : null;
  if (!match || Number(match[1]) < 1 || Number(match[1]) > MAX_UPLOAD_BYTES) throw new Error("Invalid required_headers");
  const expiresAt = text(r, "expires_at", 64);
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error("Invalid expires_at");
  return {
    session_id: sessionId(r),
    upload_url: url.href,
    method: "PUT",
    required_headers: { "Content-Type": "application/pdf", "x-goog-content-length-range": range as string },
    expires_at: expiresAt,
  };
}

export function parseProcessResult(value: unknown): ProcessResult {
  return { status: status(record(value, "process result")) };
}

export function parseSessionState(value: unknown): SessionState {
  const r = record(value, "session status");
  const state: SessionState = {
    session_id: sessionId(r),
    status: status(r),
    upload_id: nullable(r, "upload_id", UPLOAD_ID),
    error_code: nullable(r, "error_code", ERROR_CODE),
    updated_at: text(r, "updated_at", 64),
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
    if (signal?.aborted) { reject(new Error("Upload cancelled")); return; }
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
    xhr.onabort = () => done(new Error("Upload cancelled"));
    xhr.send(file);
  });
}
