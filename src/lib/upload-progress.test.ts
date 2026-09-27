import assert from "node:assert/strict";
import test from "node:test";
import {
  UPLOAD_STEP_LABELS,
  describeElapsed,
  formatElapsed,
  uploadFailureMessage,
  uploadStepAnnouncement,
  uploadStepIds,
  uploadSteps,
  type UploadProgress,
  type UploadStep,
} from "./upload-progress.ts";
import { SESSION_STAGES } from "./upload-sessions.ts";

const states = (steps: UploadStep[]) => steps.map((s) => `${s.id}:${s.state}`).join(" ");
const active = (steps: UploadStep[]) => steps.filter((s) => s.state === "current" || s.state === "failed");

test("step order for PDF and CSV", () => {
  assert.deepEqual(uploadStepIds("pdf"), [
    "checking", "preparing", "uploading", "queued", "staging", "parsing", "extracting",
    "locating", "matching", "saving", "summarizing", "done",
  ]);
  assert.deepEqual(uploadStepIds("csv"), [
    "checking", "preparing", "uploading", "queued", "locating", "matching", "saving", "summarizing", "done",
  ]);
  for (const id of uploadStepIds("pdf")) assert.ok(UPLOAD_STEP_LABELS[id]);
});

test("browser phases mark exactly one current step", () => {
  for (const phase of ["checking", "preparing", "uploading", "queued"] as const) {
    const steps = uploadSteps({ phase });
    assert.deepEqual(active(steps).map((s) => s.id), [phase]);
    const index = steps.findIndex((s) => s.id === phase);
    assert.ok(steps.slice(0, index).every((s) => s.state === "done"));
    assert.ok(steps.slice(index + 1).every((s) => s.state === "pending"));
  }
  assert.equal(uploadSteps({ phase: "uploading", percent: 42.4 }).find((s) => s.id === "uploading")?.detail, "42%");
  assert.equal(uploadSteps({ phase: "uploading", percent: 400 }).find((s) => s.id === "uploading")?.detail, "100%");
  assert.equal(uploadSteps({ phase: "uploading" }).find((s) => s.id === "uploading")?.detail, "0%");
});

test("every backend stage maps to a step", () => {
  for (const stage of SESSION_STAGES) {
    const steps = uploadSteps({ phase: "processing", stage });
    const current = active(steps);
    assert.equal(current.length, 1, stage);
    assert.equal(current[0].id, stage === "validating" ? "queued" : stage);
  }
  const validating = uploadSteps({ phase: "processing", stage: "validating" }).find((s) => s.id === "queued");
  assert.equal(validating?.detail, "Validating file");
  const unknown = uploadSteps({ phase: "processing", stage: null }).find((s) => s.id === "queued");
  assert.deepEqual(unknown, { id: "queued", label: "Queued", state: "current", detail: "Processing" });
});

test("extracting shows done/total", () => {
  const step = uploadSteps({ phase: "processing", stage: "extracting", detail: { done: 3, total: 12 } })
    .find((s) => s.id === "extracting");
  assert.deepEqual(step, { id: "extracting", label: "Extracting", state: "current", detail: "3 of 12" });
});

test("CSV rows hide document-only steps", () => {
  const steps = uploadSteps({ kind: "csv", phase: "processing", stage: "matching" });
  assert.equal(steps.some((s) => ["staging", "parsing", "extracting"].includes(s.id)), false);
  assert.equal(states(steps), "checking:done preparing:done uploading:done queued:done locating:done matching:current saving:pending summarizing:pending done:pending");
  // A document stage reported for a CSV (should not happen) falls back to Queued.
  assert.equal(active(uploadSteps({ kind: "csv", phase: "processing", stage: "parsing" }))[0].id, "queued");
});

test("succeeded marks every step done", () => {
  for (const kind of ["pdf", "csv"] as const) {
    const steps = uploadSteps({ kind, phase: "succeeded", uploadId: "UPL_x" });
    assert.ok(steps.every((s) => s.state === "done"));
    assert.equal(steps.at(-1)?.id, "done");
  }
  assert.equal(uploadStepAnnouncement({ phase: "succeeded" }), "Done");
});

test("failures mark the failed step with per-error_code copy", () => {
  const cases: Array<[UploadProgress, string]> = [
    [{ phase: "failed", errorCode: "invalid_file" }, "checking"],
    [{ phase: "failed", errorCode: "session_failed" }, "preparing"],
    [{ phase: "failed", errorCode: "upload_failed" }, "uploading"],
    [{ phase: "failed", errorCode: "process_failed" }, "queued"],
    [{ phase: "failed", errorCode: "invalid_pdf" }, "queued"],
    [{ phase: "failed", errorCode: "too_large", stage: "validating" }, "queued"],
    [{ phase: "failed", errorCode: "snowflake_failed", stage: "extracting" }, "extracting"],
    [{ phase: "failed", errorCode: "snowflake_failed" }, "staging"],
    [{ kind: "csv", phase: "failed", errorCode: "snowflake_failed" }, "locating"],
    [{ phase: "failed", errorCode: "reference_unavailable" }, "matching"],
    [{ phase: "failed", errorCode: "timeout", stage: "summarizing" }, "summarizing"],
    [{ phase: "failed", errorCode: "session_not_found" }, "queued"],
    [{ phase: "failed", errorCode: "internal" }, "queued"],
    [{ phase: "failed", errorCode: null }, "queued"],
  ];
  for (const [progress, id] of cases) {
    const steps = uploadSteps(progress);
    const failed = steps.filter((s) => s.state === "failed");
    assert.equal(failed.length, 1, JSON.stringify(progress));
    assert.equal(failed[0].id, id, JSON.stringify(progress));
    assert.equal(failed[0].detail, uploadFailureMessage(progress.errorCode, progress.kind));
    assert.equal(steps.some((s) => s.state === "current"), false);
    const index = steps.indexOf(failed[0]);
    assert.ok(steps.slice(index + 1).every((s) => s.state === "pending"));
  }
  assert.equal(uploadStepAnnouncement({ phase: "failed", errorCode: "upload_failed" }), "Failed at uploading");
});

test("failure copy is specific per code and generic otherwise", () => {
  const codes = ["invalid_file", "session_failed", "upload_failed", "process_failed", "poll_failed", "poll_timeout", "session_not_found",
    "invalid_pdf", "invalid_csv", "snowflake_failed", "reference_unavailable", "timeout"];
  const messages = new Set(codes.map((code) => uploadFailureMessage(code)));
  assert.equal(messages.size, codes.length);
  assert.match(uploadFailureMessage("too_large", "pdf"), /50 MB/);
  assert.match(uploadFailureMessage("too_large", "csv"), /10 MB/);
  assert.equal(uploadFailureMessage("internal"), uploadFailureMessage("constructor"));
  assert.equal(uploadFailureMessage(undefined), uploadFailureMessage("__proto__"));
});

test("announcement only depends on the step, not the percent", () => {
  assert.equal(uploadStepAnnouncement({ phase: "uploading", percent: 10 }), uploadStepAnnouncement({ phase: "uploading", percent: 90 }));
  assert.equal(uploadStepAnnouncement({ phase: "processing", stage: "extracting", detail: { done: 1, total: 4 } }), "Extracting");
});

test("formatElapsed renders m:ss and h:mm:ss, clamping bad input to 0:00", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(999), "0:00");
  assert.equal(formatElapsed(5_400), "0:05");
  assert.equal(formatElapsed(754_000), "12:34");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
  assert.equal(formatElapsed(-50), "0:00");
  assert.equal(formatElapsed(Number.NaN), "0:00");
});

test("describeElapsed spells out units for screen readers", () => {
  assert.equal(describeElapsed(0), "0 seconds");
  assert.equal(describeElapsed(1_000), "1 second");
  assert.equal(describeElapsed(123_000), "2 minutes 3 seconds");
  assert.equal(describeElapsed(3_600_000), "1 hour");
  assert.equal(describeElapsed(3_661_000), "1 hour 1 minute 1 second");
});

test("session_not_found copy explains expiry and is distinct from poll_failed", () => {
  assert.match(uploadFailureMessage("session_not_found"), /couldn.t find this upload.*expired or belong to another account/);
  assert.notEqual(uploadFailureMessage("session_not_found"), uploadFailureMessage("poll_failed"));
});
