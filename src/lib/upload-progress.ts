// Pure mapping from an upload's progress to the ordered stepper rows shown in
// on /budget. No React, no I/O: safe for node tests.
import type { SessionStage, UploadKind } from "./upload-sessions.ts";

export type UploadPhase =
  | "checking" | "preparing" | "uploading" | "queued" | "processing" | "succeeded" | "failed" | "cancelled";

/** Phases that never change again. */
export const TERMINAL_PHASES: ReadonlySet<UploadPhase> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Frozen contract (HARNESS-FRONTEND-REVAMP-001); `kind` and `step` are
 * additive optional fields.
 */
export type UploadProgress = {
  phase: UploadPhase;
  stage?: SessionStage | null;
  percent?: number;
  detail?: { done: number; total: number } | null;
  errorCode?: string | null;
  uploadId?: string;
  kind?: UploadKind;
  /** For phase "cancelled": the step that was running when the user stopped it. */
  step?: UploadStepId;
};

export type UploadStepId =
  | "checking" | "preparing" | "uploading" | "queued"
  | "staging" | "parsing" | "extracting" | "locating" | "matching" | "saving" | "summarizing"
  | "done";
export type UploadStepState = "done" | "current" | "pending" | "failed" | "cancelled";
export type UploadStep = { id: UploadStepId; label: string; state: UploadStepState; detail?: string };

const PDF_STEPS: readonly UploadStepId[] = [
  "checking", "preparing", "uploading", "queued",
  "staging", "parsing", "extracting", "locating", "matching", "saving", "summarizing", "done",
];
const DOCUMENT_ONLY = new Set<UploadStepId>(["staging", "parsing", "extracting"]);
const CSV_STEPS: readonly UploadStepId[] = PDF_STEPS.filter((id) => !DOCUMENT_ONLY.has(id));

export const UPLOAD_STEP_LABELS: Record<UploadStepId, string> = {
  checking: "Checking",
  preparing: "Preparing",
  uploading: "Uploading",
  queued: "Queued",
  staging: "Staging",
  parsing: "Parsing",
  extracting: "Extracting",
  locating: "Locating",
  matching: "Matching",
  saving: "Saving",
  summarizing: "Summarizing",
  done: "Done",
};

/**
 * Error codes set by runUploadSession for failures in the browser; the rest
 * come from the backend session (error_code).
 */
export const CLIENT_ERROR_CODES = ["invalid_file", "session_failed", "upload_failed", "process_failed", "poll_failed", "poll_timeout", "session_not_found"] as const;

const CLIENT_FAILURE_STEP: Record<string, UploadStepId> = {
  invalid_file: "checking",
  session_failed: "preparing",
  upload_failed: "uploading",
  process_failed: "queued",
  poll_failed: "queued",
  poll_timeout: "queued",
  session_not_found: "queued",
  too_large: "queued",
  invalid_pdf: "queued",
  invalid_csv: "queued",
  reference_unavailable: "matching",
};

const FAILURE_COPY: Record<string, string> = {
  invalid_file: "This file did not pass the checks. Choose a PDF or CSV and try again.",
  session_failed: "The upload could not be started. Try again.",
  upload_failed: "The upload to storage did not finish. Check your connection and retry.",
  process_failed: "The file uploaded, but processing could not be started. Retry.",
  poll_failed: "Lost contact with the upload service. Processing may still be running.",
  poll_timeout: "Processing is taking longer than expected. Check again later.",
  session_not_found: "We couldn’t find this upload. It may have expired or belong to another account.",
  invalid_pdf: "This file is not a readable PDF.",
  invalid_csv: "The CSV must be UTF-8 and include project_id, project_name, and utility columns.",
  snowflake_failed: "Document processing failed. Retry in a few minutes.",
  reference_unavailable: "Reference project data is unavailable right now. Retry later.",
  timeout: "Processing timed out. Retry, or split a large PDF into smaller files.",
};
const DEFAULT_FAILURE = "Processing failed unexpectedly. Retry.";

/** User-facing copy for an error code; unknown or missing codes get a generic line. */
export function uploadFailureMessage(errorCode: string | null | undefined, kind: UploadKind = "pdf"): string {
  if (errorCode === "too_large") {
    return kind === "csv" ? "This CSV is larger than 10 MB." : "This PDF is larger than 50 MB.";
  }
  return (errorCode && Object.hasOwn(FAILURE_COPY, errorCode) ? FAILURE_COPY[errorCode] : undefined) ?? DEFAULT_FAILURE;
}

/** Ordered step ids for a kind; CSV skips the document-only stages. */
export function uploadStepIds(kind: UploadKind = "pdf"): readonly UploadStepId[] {
  return kind === "csv" ? CSV_STEPS : PDF_STEPS;
}

function stageStep(stage: SessionStage | null | undefined, ids: readonly UploadStepId[]): UploadStepId | null {
  if (!stage) return null;
  // Validation happens right after the job picks the file up; show it under Queued.
  if (stage === "validating") return "queued";
  return ids.includes(stage) ? stage : null;
}

function failedStep(progress: UploadProgress, ids: readonly UploadStepId[]): UploadStepId {
  const fromStage = stageStep(progress.stage, ids);
  if (fromStage) return fromStage;
  const code = progress.errorCode ?? "";
  const mapped = Object.hasOwn(CLIENT_FAILURE_STEP, code) ? CLIENT_FAILURE_STEP[code] : undefined;
  if (mapped && ids.includes(mapped)) return mapped;
  // Backend failure with no stage recorded (older backend): first processing step.
  return code === "snowflake_failed" ? ids[ids.indexOf("queued") + 1] : "queued";
}

function currentStep(progress: UploadProgress, ids: readonly UploadStepId[]): UploadStepId {
  switch (progress.phase) {
    case "checking":
    case "preparing":
    case "uploading":
    case "queued":
      return progress.phase;
    case "processing":
      return stageStep(progress.stage, ids) ?? "queued";
    case "succeeded":
      return "done";
    case "failed":
      return failedStep(progress, ids);
    case "cancelled":
      if (progress.step && progress.step !== "done" && ids.includes(progress.step)) return progress.step;
      return stageStep(progress.stage, ids) ?? "queued";
  }
}

/**
 * Progress for a row the user just stopped: the step that was running is kept
 * so the stepper shows where it stopped. Terminal progress is returned as is.
 */
export function cancelledProgress(progress: UploadProgress): UploadProgress {
  if (TERMINAL_PHASES.has(progress.phase)) return progress;
  const step = currentStep(progress, uploadStepIds(progress.kind));
  const cancelled: UploadProgress = { phase: "cancelled", step };
  if (progress.kind) cancelled.kind = progress.kind;
  if (progress.stage) cancelled.stage = progress.stage;
  return cancelled;
}

function clampPercent(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

function currentDetail(id: UploadStepId, progress: UploadProgress): string | undefined {
  if (id === "uploading") return `${clampPercent(progress.percent)}%`;
  if (id === "queued" && progress.phase === "processing") {
    return progress.stage === "validating" ? "Validating file" : "Processing";
  }
  const detail = progress.detail;
  if (detail && detail.total > 0 && id !== "done") return `${detail.done} of ${detail.total}`;
  return undefined;
}

/**
 * Stepper rows for an upload. Exactly one row is current (or failed, or
 * cancelled) until the upload succeeds, when every row is done. A cancelled
 * row has no detail and no failure copy.
 */
export function uploadSteps(progress: UploadProgress): UploadStep[] {
  const kind = progress.kind ?? "pdf";
  const ids = uploadStepIds(kind);
  if (progress.phase === "succeeded") {
    return ids.map((id) => ({ id, label: UPLOAD_STEP_LABELS[id], state: "done" }));
  }
  const active = currentStep(progress, ids);
  const activeIndex = ids.indexOf(active);
  const failed = progress.phase === "failed";
  return ids.map((id, index): UploadStep => {
    const label = UPLOAD_STEP_LABELS[id];
    if (index < activeIndex) return { id, label, state: "done" };
    if (index > activeIndex) return { id, label, state: "pending" };
    if (failed) return { id, label, state: "failed", detail: uploadFailureMessage(progress.errorCode, kind) };
    if (progress.phase === "cancelled") return { id, label, state: "cancelled" };
    const detail = currentDetail(id, progress);
    return detail === undefined ? { id, label, state: "current" } : { id, label, state: "current", detail };
  });
}

/**
 * Short text for the row's aria-live region. It changes only when the step
 * changes (not on every upload percent or extraction chunk).
 */
export function uploadStepAnnouncement(progress: UploadProgress): string {
  const steps = uploadSteps(progress);
  if (progress.phase === "succeeded") return "Done";
  if (progress.phase === "cancelled") return "Cancelled";
  const active = steps.find((step) => step.state === "current" || step.state === "failed");
  if (!active) return "";
  return active.state === "failed" ? `Failed at ${active.label.toLowerCase()}` : active.label;
}

/**
 * Elapsed time for the stepper: "0:05", "12:34", "1:02:03". Negative or
 * non-finite input (clock glitches) shows "0:00".
 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Screen-reader wording for elapsed time: "5 seconds", "2 minutes 3 seconds". */
export function describeElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const parts = [
    hours ? part(hours, "hour") : "",
    minutes ? part(minutes, "minute") : "",
    seconds || (!hours && !minutes) ? part(seconds, "second") : "",
  ].filter(Boolean);
  return parts.join(" ");
}
