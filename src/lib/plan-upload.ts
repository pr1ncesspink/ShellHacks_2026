// Pure helpers for the /budget upload control: which picked files to accept,
// why the rest were rejected, and the upload list state. No React, no I/O.
import { MAX_BYTES_BY_KIND, SESSION_ID, uploadKindOf, type UploadKind } from "./upload-sessions.ts";
import { TERMINAL_PHASES, cancelledProgress, uploadStepAnnouncement, type UploadProgress } from "./upload-progress.ts";

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
  /** Null for a row resumed from the URL: the browser no longer has the file. */
  file: F | null;
  /** File name, or a placeholder for resumed rows. */
  name: string;
  kind: UploadKind;
  progress: UploadProgress;
  /** Message from a thrown error (network, validation); null when none. */
  error: string | null;
  sessionId: string | null;
  uploadId: string | null;
  /** Bumped on retry so stale async callbacks can be ignored. */
  attempt: number;
  /** A server-side cancel is in flight. */
  cancelling: boolean;
  /** Why the last cancel request failed; null when none. */
  cancelError: string | null;
};

export type UploadListAction<F extends FileLike = FileLike> =
  | { type: "add"; items: Array<{ id: string; file: F; kind: UploadKind }> }
  | { type: "progress"; id: string; attempt: number; progress: UploadProgress }
  | { type: "queued"; id: string; attempt: number; sessionId: string }
  | { type: "error"; id: string; attempt: number; message: string }
  | { type: "cancelling"; id: string; attempt: number }
  | { type: "cancelled"; id: string; attempt: number }
  | { type: "cancel-failed"; id: string; attempt: number; message: string }
  | { type: "retry"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear-finished" };

const initialProgress = (kind: UploadKind): UploadProgress => ({ kind, phase: "checking" });

export function newUploadItem<F extends FileLike>(id: string, file: F, kind: UploadKind): UploadItem<F> {
  return {
    id, file, name: file.name, kind, progress: initialProgress(kind), error: null,
    sessionId: null, uploadId: null, attempt: 0, cancelling: false, cancelError: null,
  };
}

/**
 * Rows for sessions resumed from the URL (valid, de-duplicated ids only, at
 * most MAX_UPLOAD_FILES). They start at Queued; polling fills in the real
 * state and kind.
 */
export function resumedUploadItems<F extends FileLike = FileLike>(sessionIds: readonly string[]): UploadItem<F>[] {
  const ids = [...new Set(sessionIds.filter((id) => SESSION_ID.test(id)))].slice(0, MAX_UPLOAD_FILES);
  return ids.map((sessionId, index) => ({
    id: `resume-${sessionId}`,
    file: null,
    name: ids.length > 1 ? `Earlier upload ${index + 1}` : "Earlier upload",
    kind: "pdf",
    progress: { phase: "queued" },
    error: null,
    sessionId,
    uploadId: null,
    attempt: 0,
    cancelling: false,
    cancelError: null,
  }));
}

export const isFinished = (item: Pick<UploadItem, "progress">): boolean => TERMINAL_PHASES.has(item.progress.phase);
export const isCancelled = (item: Pick<UploadItem, "progress">): boolean => item.progress.phase === "cancelled";

/**
 * Files already in the list, for classifyFiles. Resumed rows (no File) still
 * count toward the limit but never match a picked file.
 */
export function listedFiles(items: readonly Pick<UploadItem, "file">[]): FileLike[] {
  return items.map((item) => item.file ?? { name: "", size: -1, lastModified: -1 });
}

/**
 * Reducer for the upload rows. Updates carry the attempt they belong to, so
 * callbacks from a retried or removed run are ignored. A cancelled row keeps
 * its state until it is retried or removed.
 */
export function uploadListReducer<F extends FileLike>(state: UploadItem<F>[], action: UploadListAction<F>): UploadItem<F>[] {
  const update = (id: string, attempt: number | null, change: (item: UploadItem<F>) => UploadItem<F>) => {
    let changed = false;
    const next = state.map((item) => {
      if (item.id !== id || (attempt !== null && item.attempt !== attempt)) return item;
      const updated = change(item);
      if (updated !== item) changed = true;
      return updated;
    });
    return changed ? next : state;
  };
  switch (action.type) {
    case "add": {
      const fresh = action.items.filter((item) => !state.some((existing) => existing.id === item.id));
      return fresh.length ? [...state, ...fresh.map((item) => newUploadItem(item.id, item.file, item.kind))] : state;
    }
    case "progress":
      return update(action.id, action.attempt, (item) => isCancelled(item) ? item : ({
        ...item,
        kind: action.progress.kind ?? item.kind,
        progress: action.progress,
        uploadId: action.progress.uploadId ?? item.uploadId,
        cancelling: TERMINAL_PHASES.has(action.progress.phase) ? false : item.cancelling,
      }));
    case "queued":
      return update(action.id, action.attempt, (item) => ({ ...item, sessionId: action.sessionId }));
    case "error":
      return update(action.id, action.attempt, (item) => isCancelled(item) ? item : ({
        ...item,
        error: action.message,
        cancelling: false,
        progress: item.progress.phase === "failed" ? item.progress : { kind: item.kind, phase: "failed", errorCode: null },
      }));
    case "cancelling":
      return update(action.id, action.attempt, (item) =>
        isFinished(item) ? item : ({ ...item, cancelling: true, cancelError: null }));
    case "cancelled":
      return update(action.id, action.attempt, (item) => ({
        ...item,
        progress: cancelledProgress(item.progress),
        cancelling: false,
        cancelError: null,
      }));
    case "cancel-failed":
      return update(action.id, action.attempt, (item) => ({ ...item, cancelling: false, cancelError: action.message }));
    case "retry":
      // Resumed rows have no File to send again.
      return update(action.id, null, (item) => item.file ? ({
        ...newUploadItem(item.id, item.file, item.kind),
        attempt: item.attempt + 1,
      }) : item);
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
 * Session ids for the URL once a batch is handed to the backend, in row
 * order, or null while any row is still on its way to the queue. Cancelled
 * rows and rows that failed before queueing are left out and never block.
 */
export function queuedSessionIds(items: readonly Pick<UploadItem, "sessionId" | "progress">[]): string[] | null {
  const ids: string[] = [];
  for (const item of items) {
    if (isCancelled(item)) continue;
    if (!item.sessionId) {
      if (isFinished(item)) continue;
      return null;
    }
    if (SESSION_ID.test(item.sessionId) && !ids.includes(item.sessionId)) ids.push(item.sessionId);
  }
  return ids;
}

/** Upload ids of the rows that succeeded, in row order. */
export function succeededUploadIds(items: readonly Pick<UploadItem, "uploadId" | "progress">[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.progress.phase === "succeeded" && item.uploadId && !ids.includes(item.uploadId)) ids.push(item.uploadId);
  }
  return ids;
}

/**
 * Text for a row's live region: cancel states first, then the current step.
 * It changes only when the step or the cancel state changes.
 */
export function uploadItemAnnouncement(item: Pick<UploadItem, "progress" | "cancelling" | "cancelError">): string {
  if (item.cancelling) return "Cancelling...";
  if (!isFinished(item) && item.cancelError) return `Could not cancel. ${item.cancelError}`;
  return uploadStepAnnouncement(item.progress);
}

// ---- /budget workspace state ---------------------------------------------

/** Row counts the uploader reports to its parent: all rows, and rows not yet terminal. */
export type UploadActivity = { rows: number; active: number };

export function uploadActivity(items: readonly Pick<UploadItem, "progress">[]): UploadActivity {
  let active = 0;
  for (const item of items) if (!isFinished(item)) active += 1;
  return { rows: items.length, active };
}

/**
 * Unique ids from both lists, earlier first and newest last; over `max`, the
 * oldest are dropped.
 */
export function mergeUploadIds(earlier: readonly string[], later: readonly string[], max: number = MAX_UPLOAD_FILES): string[] {
  const ids = [...new Set([...earlier, ...later])];
  return ids.length > max ? ids.slice(ids.length - max) : ids;
}

export type BudgetWorkspaceInput = {
  activity: UploadActivity;
  initialSessionIds: readonly string[];
  initialUploadIds: readonly string[];
  /** Latest queued session ids reported by the uploader. */
  sessionIds: readonly string[];
  /** Latest succeeded upload ids reported by the uploader. */
  uploaderUploadIds: readonly string[];
};

export type BudgetWorkspaceState = {
  /**
   * The page holds uploads (rows, or ids from the URL): same-page navigation
   * (map markers, recent-upload links) must stay off so nothing remounts.
   */
  busy: boolean;
  /** Some row is still being checked, uploaded or processed. */
  waiting: boolean;
  /** Summaries to show: URL uploads plus the uploader's successes. */
  uploadIds: string[];
  /** What the URL should name, or null to leave it as it is. */
  url: { key: "sessions" | "uploads"; ids: string[] } | null;
};

/**
 * Derived /budget workspace state. While any row is active the URL names the
 * queued sessions (so a reload resumes them); once none is, it names every
 * summary shown. Failed-only batches keep their sessions.
 */
export function budgetWorkspaceState(input: BudgetWorkspaceInput): BudgetWorkspaceState {
  const { activity, initialSessionIds, initialUploadIds, sessionIds, uploaderUploadIds } = input;
  const uploadIds = mergeUploadIds(initialUploadIds, uploaderUploadIds);
  const waiting = activity.active > 0;
  let url: BudgetWorkspaceState["url"] = null;
  if (waiting && sessionIds.length) url = { key: "sessions", ids: [...sessionIds] };
  else if (uploadIds.length) url = { key: "uploads", ids: uploadIds };
  else if (sessionIds.length) url = { key: "sessions", ids: [...sessionIds] };
  return {
    busy: activity.rows > 0 || initialSessionIds.length > 0 || initialUploadIds.length > 0,
    waiting,
    uploadIds,
    url,
  };
}
