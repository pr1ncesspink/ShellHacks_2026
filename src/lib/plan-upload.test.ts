import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_UPLOAD_FILES,
  UPLOAD_ACCEPT,
  budgetWorkspaceState,
  classifyFiles,
  formatBytes,
  isFinished,
  listedFiles,
  mergeUploadIds,
  newUploadItem,
  queuedSessionIds,
  rejectionMessage,
  resumedUploadItems,
  succeededUploadIds,
  uploadActivity,
  uploadItemAnnouncement,
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

const ses = (n: number) => `SES_${n.toString(16).padStart(32, "0")}`;
const add = (ids: string[]) =>
  uploadListReducer<FileLike>([], { type: "add", items: ids.map((id) => ({ id, file: f(`${id}.pdf`), kind: "pdf" as const })) });

test("queuedSessionIds waits for every accepted row to be queued, then lists sessions in row order", () => {
  assert.deepEqual(queuedSessionIds([]), []);
  let state = add(["a", "b"]);
  assert.equal(queuedSessionIds(state), null);
  state = uploadListReducer(state, { type: "queued", id: "a", attempt: 0, sessionId: ses(1) });
  assert.equal(queuedSessionIds(state), null);
  state = uploadListReducer(state, { type: "queued", id: "b", attempt: 0, sessionId: ses(2) });
  assert.deepEqual(queuedSessionIds(state), [ses(1), ses(2)]);
  // Malformed ids are dropped rather than put in the URL.
  assert.deepEqual(queuedSessionIds([{ sessionId: "SES_bad", progress: { phase: "queued" } }]), []);
  // Retry clears the session until the row is queued again.
  state = uploadListReducer(state, { type: "retry", id: "a" });
  assert.equal(queuedSessionIds(state), null);
});

test("queuedSessionIds leaves out cancelled rows and rows that failed before queueing", () => {
  let state = add(["a", "b", "c"]);
  state = uploadListReducer(state, { type: "queued", id: "a", attempt: 0, sessionId: ses(1) });
  state = uploadListReducer(state, { type: "error", id: "b", attempt: 0, message: "Network down" });
  assert.equal(queuedSessionIds(state), null);
  state = uploadListReducer(state, { type: "cancelled", id: "c", attempt: 0 });
  assert.deepEqual(queuedSessionIds(state), [ses(1)]);
  state = uploadListReducer(state, { type: "cancelled", id: "a", attempt: 0 });
  assert.deepEqual(queuedSessionIds(state), []);
});

test("succeededUploadIds lists successful uploads only", () => {
  let state = add(["a", "b", "c"]);
  assert.deepEqual(succeededUploadIds(state), []);
  state = uploadListReducer(state, { type: "progress", id: "b", attempt: 0, progress: { kind: "pdf", phase: "succeeded", uploadId: "UPL_2" } });
  state = uploadListReducer(state, { type: "progress", id: "a", attempt: 0, progress: { kind: "pdf", phase: "failed", errorCode: "timeout" } });
  state = uploadListReducer(state, { type: "cancelled", id: "c", attempt: 0 });
  assert.deepEqual(succeededUploadIds(state), ["UPL_2"]);
});

test("cancel actions: Cancelling..., Cancelled, and a failed cancel", () => {
  let state = add(["a"]);
  state = uploadListReducer(state, { type: "progress", id: "a", attempt: 0, progress: { kind: "pdf", phase: "processing", stage: "locating" } });
  state = uploadListReducer(state, { type: "cancelling", id: "a", attempt: 0 });
  assert.equal(state[0].cancelling, true);
  assert.equal(uploadItemAnnouncement(state[0]), "Cancelling...");
  assert.equal(isFinished(state[0]), false);

  const failed = uploadListReducer(state, { type: "cancel-failed", id: "a", attempt: 0, message: "Upload backend unavailable." });
  assert.equal(failed[0].cancelling, false);
  assert.equal(uploadItemAnnouncement(failed[0]), "Could not cancel. Upload backend unavailable.");

  state = uploadListReducer(state, { type: "cancelled", id: "a", attempt: 0 });
  assert.deepEqual(state[0].progress, { kind: "pdf", phase: "cancelled", step: "locating", stage: "locating" });
  assert.equal(state[0].cancelling, false);
  assert.equal(isFinished(state[0]), true);
  assert.equal(uploadItemAnnouncement(state[0]), "Cancelled");

  // Late progress or errors from the aborted run never revive a cancelled row.
  const before = state;
  state = uploadListReducer(state, { type: "progress", id: "a", attempt: 0, progress: { kind: "pdf", phase: "processing", stage: "saving" } });
  state = uploadListReducer(state, { type: "error", id: "a", attempt: 0, message: "Upload cancelled" });
  state = uploadListReducer(state, { type: "cancelling", id: "a", attempt: 0 });
  assert.equal(state, before);
  // Retry starts the row again; clear-finished drops it.
  assert.equal(uploadListReducer(state, { type: "retry", id: "a" })[0].progress.phase, "checking");
  assert.deepEqual(uploadListReducer(state, { type: "clear-finished" }), []);
});

test("a terminal poll result during Cancelling... ends the cancel", () => {
  let state = add(["a"]);
  state = uploadListReducer(state, { type: "cancelling", id: "a", attempt: 0 });
  state = uploadListReducer(state, { type: "progress", id: "a", attempt: 0, progress: { kind: "pdf", phase: "succeeded", uploadId: "UPL_1" } });
  assert.equal(state[0].cancelling, false);
  assert.equal(state[0].uploadId, "UPL_1");
});

test("resumed rows: valid unique ids, no File, retry is a no-op, count toward the limit", () => {
  const rows = resumedUploadItems([ses(1), "SES_bad", ses(1), ses(2)]);
  assert.deepEqual(rows.map((row) => [row.id, row.sessionId, row.file, row.name, row.progress.phase]), [
    [`resume-${ses(1)}`, ses(1), null, "Earlier upload 1", "queued"],
    [`resume-${ses(2)}`, ses(2), null, "Earlier upload 2", "queued"],
  ]);
  assert.equal(resumedUploadItems([ses(3)])[0].name, "Earlier upload");
  assert.equal(resumedUploadItems(Array.from({ length: 7 }, (_, i) => ses(i + 1))).length, MAX_UPLOAD_FILES);
  assert.deepEqual(queuedSessionIds(rows), [ses(1), ses(2)]);
  assert.equal(uploadListReducer(rows, { type: "retry", id: rows[0].id }), rows);

  // Progress fills in the kind reported by the backend.
  const csv = uploadListReducer(rows, { type: "progress", id: rows[0].id, attempt: 0, progress: { kind: "csv", phase: "processing", stage: "matching" } });
  assert.equal(csv[0].kind, "csv");

  const listed = listedFiles(rows);
  const picked = [f("a.pdf"), f("b.pdf"), f("c.pdf"), f("d.pdf")];
  const { accepted, rejected } = classifyFiles(listed, picked);
  assert.equal(accepted.length, 3);
  assert.deepEqual(rejected.map((r) => r.reason), ["limit"]);
});

test("uploadActivity counts every row and the non-terminal ones", () => {
  const rows = [
    { progress: { phase: "checking" } },
    { progress: { phase: "queued" } },
    { progress: { phase: "succeeded" } },
    { progress: { phase: "failed" } },
    { progress: { phase: "cancelled" } },
  ] as Pick<UploadItem, "progress">[];
  assert.deepEqual(uploadActivity(rows), { rows: 5, active: 2 });
  assert.deepEqual(uploadActivity([]), { rows: 0, active: 0 });
});

test("mergeUploadIds keeps unique ids, newest last, dropping the oldest over the cap", () => {
  assert.deepEqual(mergeUploadIds(["A"], ["B", "A", "C"]), ["A", "B", "C"]);
  assert.deepEqual(mergeUploadIds([], []), []);
  assert.deepEqual(mergeUploadIds(["A", "B", "C"], ["D", "E", "F"]), ["B", "C", "D", "E", "F"]);
  assert.deepEqual(mergeUploadIds(["A", "B"], ["C"], 2), ["B", "C"]);
});

const idle = { rows: 0, active: 0 };
const base = { activity: idle, initialSessionIds: [], initialUploadIds: [], sessionIds: [], uploaderUploadIds: [] };

test("budgetWorkspaceState: empty page is not busy and leaves the URL alone", () => {
  assert.deepEqual(budgetWorkspaceState(base), { busy: false, waiting: false, uploadIds: [], url: null });
});

test("budgetWorkspaceState: any row or URL id makes the page busy", () => {
  assert.equal(budgetWorkspaceState({ ...base, activity: { rows: 1, active: 1 } }).busy, true);
  assert.equal(budgetWorkspaceState({ ...base, activity: { rows: 1, active: 0 } }).busy, true);
  assert.equal(budgetWorkspaceState({ ...base, initialSessionIds: ["SES_1"] }).busy, true);
  assert.equal(budgetWorkspaceState({ ...base, initialUploadIds: ["UPL_1"] }).busy, true);
});

test("budgetWorkspaceState: waiting follows active rows, not session/upload counts", () => {
  // A row failed after queueing: more sessions than uploads, but nothing active.
  const failed = budgetWorkspaceState({ ...base, activity: { rows: 2, active: 0 }, sessionIds: ["SES_1", "SES_2"], uploaderUploadIds: ["UPL_1"] });
  assert.equal(failed.waiting, false);
  assert.deepEqual(failed.url, { key: "uploads", ids: ["UPL_1"] });
  assert.equal(budgetWorkspaceState({ ...base, activity: { rows: 1, active: 1 } }).waiting, true);
});

test("budgetWorkspaceState: sessions while rows are active, then the union of uploads", () => {
  const active = budgetWorkspaceState({ ...base, activity: { rows: 1, active: 1 }, initialUploadIds: ["UPL_A"], sessionIds: ["SES_1"] });
  assert.deepEqual(active.uploadIds, ["UPL_A"]);
  assert.deepEqual(active.url, { key: "sessions", ids: ["SES_1"] });
  // Not queued yet: keep naming the uploads already shown.
  const checking = budgetWorkspaceState({ ...base, activity: { rows: 1, active: 1 }, initialUploadIds: ["UPL_A"] });
  assert.deepEqual(checking.url, { key: "uploads", ids: ["UPL_A"] });
  const done = budgetWorkspaceState({ ...base, activity: { rows: 1, active: 0 }, initialUploadIds: ["UPL_A"], sessionIds: ["SES_1"], uploaderUploadIds: ["UPL_B"] });
  assert.deepEqual(done.uploadIds, ["UPL_A", "UPL_B"]);
  assert.deepEqual(done.url, { key: "uploads", ids: ["UPL_A", "UPL_B"] });
});

test("budgetWorkspaceState: failed-only batches keep sessions; cancelled-only clears the URL", () => {
  const failed = budgetWorkspaceState({ ...base, activity: { rows: 1, active: 0 }, sessionIds: ["SES_1"] });
  assert.deepEqual(failed.url, { key: "sessions", ids: ["SES_1"] });
  const cancelled = budgetWorkspaceState({ ...base, activity: { rows: 1, active: 0 }, initialSessionIds: ["SES_1"] });
  assert.equal(cancelled.url, null);
  assert.equal(cancelled.waiting, false);
});
