import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_UPLOAD_FILES,
  UPLOAD_ACCEPT,
  batchSummaryHref,
  classifyFiles,
  formatBytes,
  newUploadItem,
  rejectionMessage,
  uploadListReducer,
  type FileLike,
  type UploadItem,
} from "./plan-upload.ts";
import { MAX_CSV_BYTES, MAX_UPLOAD_BYTES } from "./upload-sessions.ts";

const f = (name: string, size = 100, lastModified = 1, type = ""): FileLike => ({ name, size, lastModified, type });

test("accept string lists PDF and CSV only", () => {
  assert.equal(UPLOAD_ACCEPT, ".pdf,.csv,application/pdf,text/csv");
  assert.equal(MAX_UPLOAD_FILES, 5);
});

test("classifyFiles judges type, emptiness and per-kind size individually", () => {
  const files = [
    f("plan.pdf"), f("photo.png"), f("scan.jpg", 10, 1, "image/jpeg"), f("empty.pdf", 0),
    f("huge.pdf", MAX_UPLOAD_BYTES + 1), f("max.pdf", MAX_UPLOAD_BYTES), f("big.csv", MAX_CSV_BYTES + 1),
    f("rows.csv", MAX_CSV_BYTES), f("noext", 5, 1, "text/csv"),
  ];
  const { accepted, rejected } = classifyFiles([], files, { maxFiles: 10 });
  assert.deepEqual(accepted.map((a) => `${a.file.name}:${a.kind}`), ["plan.pdf:pdf", "max.pdf:pdf", "rows.csv:csv", "noext:csv"]);
  assert.deepEqual(rejected.map((r) => `${r.file.name}:${r.reason}`), [
    "photo.png:type", "scan.jpg:type", "empty.pdf:empty", "huge.pdf:size", "big.csv:size",
  ]);
});

test("duplicates are removed before the cap", () => {
  const existing = [f("a.pdf"), f("b.pdf"), f("c.pdf"), f("d.pdf")];
  const { accepted, rejected } = classifyFiles(existing, [f("a.pdf"), f("a.pdf"), f("e.pdf"), f("e.pdf"), f("g.pdf")]);
  assert.deepEqual(accepted.map((a) => a.file.name), ["e.pdf"]);
  assert.deepEqual(rejected.map((r) => `${r.file.name}:${r.reason}`), [
    "a.pdf:duplicate", "a.pdf:duplicate", "e.pdf:duplicate", "g.pdf:limit",
  ]);
  // Same name but a different file is not a duplicate.
  assert.equal(classifyFiles([f("a.pdf")], [f("a.pdf", 200)]).accepted.length, 1);
});

test("partial acceptance up to the cap", () => {
  const incoming = Array.from({ length: 7 }, (_, i) => f(`p${i}.pdf`));
  const { accepted, rejected } = classifyFiles([], incoming);
  assert.equal(accepted.length, 5);
  assert.deepEqual(rejected.map((r) => r.reason), ["limit", "limit"]);
  assert.equal(classifyFiles([], incoming, { maxFiles: 2 }).accepted.length, 2);
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(MAX_CSV_BYTES), "10 MB");
  assert.equal(formatBytes(MAX_UPLOAD_BYTES), "50 MB");
  assert.equal(formatBytes(12.4 * 1024 * 1024), "12 MB");
  assert.equal(formatBytes(3 * 1024 ** 4), "3072 GB");
});

test("rejectionMessage names the file and the reason", () => {
  assert.match(rejectionMessage({ file: f("x.png"), reason: "type", kind: null }), /^x\.png: only PDF or CSV/);
  assert.match(rejectionMessage({ file: f("x.pdf", MAX_UPLOAD_BYTES + 1), reason: "size", kind: "pdf" }), /50 MB or smaller \(this one is 50 MB\)/);
  assert.match(rejectionMessage({ file: f("x.csv", 11 * 1024 * 1024), reason: "size", kind: "csv" }), /10 MB or smaller \(this one is 11 MB\)/);
  assert.match(rejectionMessage({ file: f("x.pdf"), reason: "duplicate", kind: "pdf" }), /already in the list/);
  assert.match(rejectionMessage({ file: f("x.pdf"), reason: "limit", kind: "pdf" }), /up to 5 files/);
  assert.match(rejectionMessage({ file: f("x.pdf", 0), reason: "empty", kind: "pdf" }), /empty/);
  assert.match(rejectionMessage({ file: f(""), reason: "type", kind: null }), /^This file:/);
});

test("uploadListReducer add, progress, queued, error, retry, remove, clear", () => {
  let state: UploadItem[] = [];
  state = uploadListReducer(state, { type: "add", items: [{ id: "1", file: f("a.pdf"), kind: "pdf" }, { id: "2", file: f("b.csv"), kind: "csv" }] });
  assert.deepEqual(state.map((i) => [i.id, i.progress]), [["1", { kind: "pdf", phase: "checking" }], ["2", { kind: "csv", phase: "checking" }]]);
  assert.equal(uploadListReducer(state, { type: "add", items: [{ id: "1", file: f("a.pdf"), kind: "pdf" }] }), state);

  state = uploadListReducer(state, { type: "progress", id: "1", attempt: 0, progress: { kind: "pdf", phase: "uploading", percent: 40 } });
  assert.equal(state[0].progress.percent, 40);
  state = uploadListReducer(state, { type: "queued", id: "1", attempt: 0, sessionId: "SES_x" });
  assert.equal(state[0].sessionId, "SES_x");
  state = uploadListReducer(state, { type: "progress", id: "1", attempt: 0, progress: { kind: "pdf", phase: "succeeded", uploadId: "UPL_1" } });
  assert.equal(state[0].uploadId, "UPL_1");

  state = uploadListReducer(state, { type: "error", id: "2", attempt: 0, message: "Network down" });
  assert.equal(state[1].error, "Network down");
  assert.equal(state[1].progress.phase, "failed");

  const failedProgress = { kind: "csv" as const, phase: "failed" as const, errorCode: "upload_failed" };
  state = uploadListReducer(state, { type: "progress", id: "2", attempt: 0, progress: failedProgress });
  state = uploadListReducer(state, { type: "error", id: "2", attempt: 0, message: "Upload to storage failed" });
  assert.deepEqual(state[1].progress, failedProgress);

  state = uploadListReducer(state, { type: "retry", id: "2" });
  assert.deepEqual(state[1], { ...newUploadItem("2", f("b.csv"), "csv"), attempt: 1 });
  // A late callback from the old attempt is ignored (same reference returned).
  const before = state;
  state = uploadListReducer(state, { type: "progress", id: "2", attempt: 0, progress: { phase: "queued" } });
  assert.equal(state, before);
  assert.equal(uploadListReducer(state, { type: "progress", id: "missing", attempt: 0, progress: { phase: "queued" } }), state);

  state = uploadListReducer(state, { type: "clear-finished" });
  assert.deepEqual(state.map((i) => i.id), ["2"]);
  assert.equal(uploadListReducer(state, { type: "clear-finished" }), state);
  state = uploadListReducer(state, { type: "remove", id: "2" });
  assert.deepEqual(state, []);
  assert.equal(uploadListReducer(state, { type: "remove", id: "2" }), state);
});

test("batchSummaryHref waits for every row to be queued, then links all sessions", () => {
  const ses = (n: number) => `SES_${n.toString(16).padStart(32, "0")}`;
  assert.equal(batchSummaryHref([]), null);
  assert.equal(batchSummaryHref([{ sessionId: ses(1) }, { sessionId: null }]), null);
  assert.equal(batchSummaryHref([{ sessionId: ses(1) }]), `/summary?sessions=${ses(1)}`);
  assert.equal(
    batchSummaryHref([{ sessionId: ses(1) }, { sessionId: ses(2) }]),
    `/summary?sessions=${ses(1)},${ses(2)}`,
  );
  // A malformed id never produces a partial link.
  assert.equal(batchSummaryHref([{ sessionId: ses(1) }, { sessionId: "SES_bad" }]), null);
});

test("batchSummaryHref follows the list reducer: retry clears the session until requeued", () => {
  const ses = `SES_${"a".repeat(32)}`;
  const file = { name: "a.pdf", size: 10, lastModified: 1 };
  let state = uploadListReducer([], { type: "add", items: [{ id: "a", file, kind: "pdf" }] });
  state = uploadListReducer(state, { type: "queued", id: "a", attempt: 0, sessionId: ses });
  assert.equal(batchSummaryHref(state), `/summary?sessions=${ses}`);
  state = uploadListReducer(state, { type: "retry", id: "a" });
  assert.equal(batchSummaryHref(state), null);
});
