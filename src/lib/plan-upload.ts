// Pure helpers for the dashboard upload control: which picked files to accept,
// why the rest were rejected, and the upload list state. No React, no I/O.
import { MAX_BYTES_BY_KIND, uploadKindOf, type UploadKind } from "./upload-sessions.ts";
import type { UploadProgress } from "./upload-progress.ts";
import { parseIdList, summaryHref } from "./upload-summary.ts";

/** For <input type="file" accept>; extensions first because CSV MIME types vary by OS. */
export const UPLOAD_ACCEPT = ".pdf,.csv,application/pdf,text/csv";
export const MAX_UPLOAD_FILES = 5;

export type FileLike = { name: string; size: number; lastModified: number; type?: string };
export type RejectionReason = "type" | "empty" | "size" | "duplicate" | "limit";
export type Rejection<F extends FileLike = FileLike> = { file: F; reason: RejectionReason; kind: UploadKind | null };
export type Accepted<F extends FileLike = FileLike> = { file: F; kind: UploadKind };
export type Classification<F extends FileLike = FileLike> = { accepted: Accepted<F>[]; rejected: Rejection<F>[] };

export const sameFile = (a: FileLike, b: FileLike): boolean =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/**
 * Split a picked/dropped batch. Each file is judged on its own (type, empty,
 * per-kind size); duplicates of existing or earlier files are removed before
 * the cap, so only genuinely new files count toward `maxFiles`.
 */
export function classifyFiles<F extends FileLike>(
  existing: readonly FileLike[],
  incoming: readonly F[],
  options: { maxFiles?: number } = {},
): Classification<F> {
  const maxFiles = options.maxFiles ?? MAX_UPLOAD_FILES;
  const accepted: Accepted<F>[] = [];
  const rejected: Rejection<F>[] = [];
  for (const file of incoming) {
    const kind = uploadKindOf(file);
    if (!kind) { rejected.push({ file, reason: "type", kind }); continue; }
    if (file.size <= 0) { rejected.push({ file, reason: "empty", kind }); continue; }
    if (file.size > MAX_BYTES_BY_KIND[kind]) { rejected.push({ file, reason: "size", kind }); continue; }
    if (existing.some((other) => sameFile(other, file)) || accepted.some((other) => sameFile(other.file, file))) {
      rejected.push({ file, reason: "duplicate", kind });
      continue;
    }
    if (existing.length + accepted.length >= maxFiles) { rejected.push({ file, reason: "limit", kind }); continue; }
    accepted.push({ file, kind });
  }
  return { accepted, rejected };
}

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** 0 B, 512 B, 1.5 KB, 12 MB (binary units, one decimal under 10). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  if (unit === 0) return `${Math.round(value)} B`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${UNITS[unit]}`;
}

/** Inline reason shown next to a rejected file name. */
export function rejectionMessage(rejection: Rejection, maxFiles: number = MAX_UPLOAD_FILES): string {
  const name = rejection.file.name || "This file";
  switch (rejection.reason) {
    case "type":
      return `${name}: only PDF or CSV files are supported.`;
    case "empty":
      return `${name}: the file is empty.`;
    case "size":
      return rejection.kind === "csv"
        ? `${name}: CSV files must be 10 MB or smaller (this one is ${formatBytes(rejection.file.size)}).`
        : `${name}: PDFs must be 50 MB or smaller (this one is ${formatBytes(rejection.file.size)}).`;
    case "duplicate":
      return `${name}: already in the list.`;
    case "limit":
      return `${name}: you can add up to ${maxFiles} files. Remove one to add more.`;
  }
}

// ---- Upload list state ----------------------------------------------------

export type UploadItem<F extends FileLike = FileLike> = {
  id: string;
  file: F;
  kind: UploadKind;
  progress: UploadProgress;
  /** Message from a thrown error (network, validation); null when none. */
  error: string | null;
  sessionId: string | null;
  uploadId: string | null;
  /** Bumped on retry so stale async callbacks can be ignored. */
  attempt: number;
};

export type UploadListAction<F extends FileLike = FileLike> =
  | { type: "add"; items: Array<{ id: string; file: F; kind: UploadKind }> }
  | { type: "progress"; id: string; attempt: number; progress: UploadProgress }
  | { type: "queued"; id: string; attempt: number; sessionId: string }
  | { type: "error"; id: string; attempt: number; message: string }
  | { type: "retry"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear-finished" };

const initialProgress = (kind: UploadKind): UploadProgress => ({ kind, phase: "checking" });

export function newUploadItem<F extends FileLike>(id: string, file: F, kind: UploadKind): UploadItem<F> {
  return { id, file, kind, progress: initialProgress(kind), error: null, sessionId: null, uploadId: null, attempt: 0 };
}

export const isFinished = (item: UploadItem): boolean =>
  item.progress.phase === "succeeded" || item.progress.phase === "failed";

/**
 * Reducer for the upload rows. Updates carry the attempt they belong to, so
 * callbacks from a retried or removed run are ignored.
 */
export function uploadListReducer<F extends FileLike>(state: UploadItem<F>[], action: UploadListAction<F>): UploadItem<F>[] {
  const update = (id: string, attempt: number | null, change: (item: UploadItem<F>) => UploadItem<F>) => {
    let changed = false;
    const next = state.map((item) => {
      if (item.id !== id || (attempt !== null && item.attempt !== attempt)) return item;
      changed = true;
      return change(item);
    });
    return changed ? next : state;
  };
  switch (action.type) {
    case "add": {
      const fresh = action.items.filter((item) => !state.some((existing) => existing.id === item.id));
      return fresh.length ? [...state, ...fresh.map((item) => newUploadItem(item.id, item.file, item.kind))] : state;
    }
    case "progress":
      return update(action.id, action.attempt, (item) => ({
        ...item,
        progress: action.progress,
        uploadId: action.progress.uploadId ?? item.uploadId,
      }));
    case "queued":
      return update(action.id, action.attempt, (item) => ({ ...item, sessionId: action.sessionId }));
    case "error":
      return update(action.id, action.attempt, (item) => ({
        ...item,
        error: action.message,
        progress: item.progress.phase === "failed" ? item.progress : { kind: item.kind, phase: "failed", errorCode: null },
      }));
    case "retry":
      return update(action.id, null, (item) => ({
        ...newUploadItem(item.id, item.file, item.kind),
        attempt: item.attempt + 1,
      }));
    case "remove": {
      const next = state.filter((item) => item.id !== action.id);
      return next.length === state.length ? state : next;
    }
    case "clear-finished": {
      const next = state.filter((item) => !isFinished(item));
      return next.length === state.length ? state : next;
    }
  }
}

/**
 * Where to go once a batch is handed to the backend: the /summary link for
 * the rows' sessions when every row has fired onQueued, otherwise null (keep
 * waiting). A row that failed before queueing blocks navigation until it is
 * retried or removed, so no accepted file is silently left behind.
 */
export function batchSummaryHref(items: readonly Pick<UploadItem, "sessionId">[]): string | null {
  if (!items.length || items.some((item) => !item.sessionId)) return null;
  const ids = parseIdList(items.map((item) => item.sessionId as string), "SES_");
  return ids.length === items.length ? summaryHref("sessions", ids) : null;
}
