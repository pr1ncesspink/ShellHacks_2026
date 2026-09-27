import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MAP_COLLISIONS,
  MAX_SUMMARY_IDS,
  UPLOAD_ID,
  buildMapLayers,
  parseIdList,
  parseMapPoint,
  parseRecentUploads,
  parseUploadMap,
  parseUploadSummary,
  budgetHref,
  uploadApiPath,
  uploadBackendPath,
  type UploadMap,
} from "./upload-summary.ts";

const ses = (n: number) => `SES_${n.toString(16).padStart(32, "0")}`;
const upl = (n: number) => `UPL_${n.toString(16).padStart(32, "0")}`;

test("parseIdList validates, dedupes and caps", () => {
  assert.deepEqual(parseIdList(`${ses(1)}, ${ses(2)},${ses(1)}`, "SES_"), [ses(1), ses(2)]);
  assert.deepEqual(parseIdList([`${upl(1)},${upl(2)}`, upl(3)], "UPL_"), [upl(1), upl(2), upl(3)]);
  const many = Array.from({ length: 8 }, (_, i) => ses(i + 1)).join(",");
  assert.equal(parseIdList(many, "SES_").length, MAX_SUMMARY_IDS);
  // Wrong prefix, bad shape, injection attempts are dropped.
  assert.deepEqual(parseIdList(`${upl(1)},SES_abc,${ses(0xabc).toUpperCase()},../${ses(2)},${ses(3)}?x=1`, "SES_"), []);
  assert.deepEqual(parseIdList(ses(1), "UPL_"), []);
  assert.deepEqual(parseIdList(null, "UPL_"), []);
  assert.deepEqual(parseIdList(undefined, "SES_"), []);
  assert.deepEqual(parseIdList("", "SES_"), []);
});

test("budgetHref and paths only use valid ids", () => {
  assert.equal(budgetHref("sessions", [ses(1), "bad", ses(2)]), `/budget?sessions=${ses(1)},${ses(2)}`);
  assert.equal(budgetHref("uploads", [upl(1), ses(2), upl(2)]), `/budget?uploads=${upl(1)},${upl(2)}`);
  assert.equal(budgetHref("uploads", ["bad"]), "/budget");
  assert.equal(budgetHref("sessions", []), "/budget");
  assert.equal(budgetHref("uploads", Array.from({ length: 7 }, (_, i) => upl(i + 1))).split(",").length, MAX_SUMMARY_IDS);
  assert.equal(uploadBackendPath(upl(1), "summary"), `projects/uploads/${upl(1)}/summary`);
  assert.equal(uploadBackendPath("UPL_../../x", "map"), null);
  assert.equal(uploadApiPath(upl(1), "map"), `/api/uploads/${upl(1)}/map`);
  assert.equal(uploadApiPath(ses(1), "map"), null);
  assert.ok(UPLOAD_ID.test(upl(9)));
});

test("parseRecentUploads keeps valid rows only", () => {
  const parsed = parseRecentUploads({
    uploads: [
      { upload_id: upl(2), created_at: "2026-09-27T12:00:00Z", status: "model", headline: "Two lines\ncollide", owner_uid: "secret",
        counts: { projects: 3, points: 6, located_points: 5, collisions: 2 } },
      { upload_id: upl(2), created_at: "2026-09-27T11:00:00Z" },
      { upload_id: "UPL_bad" },
      "junk",
      { upload_id: upl(1), created_at: "nope", status: "weird" },
    ],
    next: "x",
  });
  assert.deepEqual(parsed, {
    uploads: [
      { upload_id: upl(2), created_at: "2026-09-27T12:00:00Z", status: "model", headline: "Two lines collide",
        counts: { projects: 3, points: 6, located_points: 5, collisions: 2 } },
      { upload_id: upl(1), created_at: null, status: null, headline: null, counts: {} },
    ],
  });
  assert.deepEqual(parseRecentUploads([]), { uploads: [] });
  assert.equal(parseRecentUploads(Array.from({ length: 30 }, (_, i) => ({ upload_id: upl(i + 1) }))).uploads.length, 20);
  for (const bad of [null, "x", {}, { uploads: "x" }]) assert.throws(() => parseRecentUploads(bad), JSON.stringify(bad));
});

const fullSummary = {
  upload_id: upl(1),
  status: "model",
  headline: "3 projects overlap reference lines near Tampa",
  overview: "Overview line one.\r\nLine two.\u0007",
  key_projects: [
    { project_id: "P1", name: "Line A", why: "Closest collision", source: "secret" },
    { project_id: "", name: "No id", why: "x" },
    { project_id: "P2", name: "", why: "Unnamed" },
    ...Array.from({ length: 6 }, (_, i) => ({ project_id: `K${i}`, name: `K${i}`, why: "" })),
  ],
  hotspots: [
    { overlap_ids: ["COL_aaa", "COL_aaa", "bad id!"], label: "Tampa cluster", nearest_mi: 1.2, lat: 27.9, lon: -82.4 },
    { overlap_ids: ["COL_bbb"], label: "Bad coords", nearest_mi: -1, lat: 91, lon: -82 },
    { overlap_ids: [], label: "No ids" },
  ],
  timing_notes: ["a", 3, "b", "c", "d"],
  data_gaps: { unresolved_locations: 2, missing_dates: 1, truncated: true, extra: 1 },
  counts: { projects: 3, collisions: 7, "Bad Key": 1, negative: -1, frac: 1.5 },
  generated_by: { model: "gemini-3.1-flash-lite", prompt_version: "summary.v1", input_hash: "sha256:abc", api_key: "x" },
  semantic_text: "never",
};

test("parseUploadSummary allow-lists the output schema", () => {
  const parsed = parseUploadSummary(fullSummary);
  assert.equal(parsed.status, "model");
  assert.equal(parsed.overview, "Overview line one.\nLine two.");
  assert.deepEqual(parsed.key_projects[0], { project_id: "P1", name: "Line A", why: "Closest collision" });
  assert.deepEqual(parsed.key_projects[1], { project_id: "P2", name: "P2", why: "Unnamed" });
  assert.equal(parsed.created_at, null);
  assert.equal(parseUploadSummary({ ...fullSummary, created_at: "2026-09-27T12:00:00Z" }).created_at, "2026-09-27T12:00:00Z");
  assert.equal(parsed.key_projects.length, 5);
  assert.deepEqual(parsed.hotspots, [
    { overlap_ids: ["COL_aaa"], label: "Tampa cluster", nearest_mi: 1.2, lat: 27.9, lon: -82.4 },
    { overlap_ids: ["COL_bbb"], label: "Bad coords", nearest_mi: null, lat: null, lon: null },
  ]);
  assert.deepEqual(parsed.timing_notes, ["a", "b", "c"]);
  assert.deepEqual(parsed.data_gaps, { unresolved_locations: 2, missing_dates: 1, truncated: true });
  assert.deepEqual(parsed.counts, { projects: 3, collisions: 7 });
  assert.deepEqual(parsed.generated_by, { model: "gemini-3.1-flash-lite", prompt_version: "summary.v1", input_hash: "sha256:abc" });
  assert.equal("semantic_text" in parsed, false);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.ok(parseUploadSummary({ ...fullSummary, headline: "x".repeat(500) }).headline.length <= 120);
});

test("parseUploadSummary handles pending and rule_only, rejects bad status", () => {
  const pending = parseUploadSummary({ status: "pending", upload_id: upl(1), headline: "Summary in progress", data_gaps: null, counts: null });
  assert.deepEqual(pending, {
    upload_id: upl(1), created_at: null, status: "pending", headline: "Summary in progress", overview: "", key_projects: [], hotspots: [], timing_notes: [],
    data_gaps: { unresolved_locations: 0, missing_dates: 0, truncated: false }, counts: {}, generated_by: null,
  });
  assert.equal(parseUploadSummary({ ...fullSummary, status: "rule_only" }).status, "rule_only");
  for (const bad of [null, [], { status: "done" }, { headline: "x" }]) assert.throws(() => parseUploadSummary(bad));
});

const point = (id: string, lat: number, lon: number, extra: Record<string, unknown> = {}) => ({
  record_id: id, project_id: id.split(":")[0], name: `Project ${id}`, owner: "FPL", lat, lon,
  coordinate_method: "structured_input", status: "planned", in_service_date: "2027-06-01",
  estimated_in_service_year: 2027, source: { secret: true }, semantic_text: "hidden", ...extra,
});

test("parseMapPoint allow-lists fields and rejects bad coordinates", () => {
  const parsed = parseMapPoint(point("P1:a", 27.9, -82.4));
  assert.deepEqual(parsed, {
    record_id: "P1:a", project_id: "P1", name: "Project P1:a", owner: "FPL", lat: 27.9, lon: -82.4,
    coordinate_method: "structured_input", status: "planned", in_service_date: "2027-06-01", estimated_in_service_year: 2027,
  });
  // Backend ProjectPoint spellings are accepted.
  assert.equal(parseMapPoint({ record_id: "R", project_id: "R", project_name: "N", latitude: 1, longitude: 2 })?.name, "N");
  for (const [lat, lon] of [[91, 0], [0, 181], [-91, 0], [Number.NaN, 0], [null, 0], ["27", "-82"]] as const) {
    assert.equal(parseMapPoint(point("P", lat as never, lon as never)), null, `${lat},${lon}`);
  }
  assert.equal(parseMapPoint({ ...point("P", 1, 1), record_id: "" }), null);
  assert.equal(parseMapPoint({ ...point("P", 1, 1), record_id: "x".repeat(257) }), null);
  assert.equal(parseMapPoint({ ...point("P", 1, 1), lat: null, lon: null }), null);
  const odd = parseMapPoint(point("P", 1, 1, { coordinate_method: "<script>", in_service_date: "June", estimated_in_service_year: 3000 }));
  assert.equal(odd?.coordinate_method, null);
  assert.equal(odd?.in_service_date, null);
  assert.equal(odd?.estimated_in_service_year, null);
});

const collision = (id: string, up: ReturnType<typeof point>, ref: ReturnType<typeof point>, extra: Record<string, unknown> = {}) => ({
  overlap_id: id, distance_mi: 3.5, time_gap_days: 120, timing_basis: "in_service_date_proxy", classification: "x",
  uploaded_project: up, reference_project: ref, ...extra,
});

test("parseUploadMap drops unknown fields, bad points and bad collisions", () => {
  const parsed = parseUploadMap({
    upload_id: upl(1),
    points: [point("P1:a", 27.9, -82.4), point("P2:a", 200, 0)],
    collisions: [
      collision("COL_1", point("P1:a", 27.9, -82.4), point("R1:a", 28, -82.5)),
      collision("COL_2", point("P1:a", 27.9, -82.4), point("R2:a", 95, 0)),
      collision("COL_3", point("P1:a", 27.9, -82.4), point("R3:a", 28, -82), { distance_mi: -2 }),
      collision("bad id!", point("P1:a", 27.9, -82.4), point("R4:a", 28, -82)),
      collision("COL_5", point("P1:a", 27.9, -82.4), point("R5:a", 28, -82), { time_gap_days: -3, timing_basis: "DROP TABLE" }),
    ],
    source: "secret",
  });
  assert.equal(parsed.upload_id, upl(1));
  assert.deepEqual(parsed.points.map((p) => p.record_id), ["P1:a"]);
  assert.deepEqual(parsed.collisions.map((c) => c.overlap_id), ["COL_1", "COL_5"]);
  assert.deepEqual(Object.keys(parsed.collisions[0]).sort(), ["distance_mi", "overlap_id", "reference", "time_gap_days", "timing_basis", "uploaded"]);
  assert.equal(parsed.collisions[1].time_gap_days, null);
  assert.equal(parsed.collisions[1].timing_basis, null);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.equal(JSON.stringify(parsed).includes("hidden"), false);
  const many = Array.from({ length: 250 }, (_, i) => collision(`COL_${i}`, point("P", 1, 1), point(`R${i}`, 1, 1)));
  assert.equal(parseUploadMap({ points: [], collisions: many }).collisions.length, MAX_MAP_COLLISIONS);
  for (const bad of [null, {}, { points: [] }, { points: "x", collisions: [] }]) assert.throws(() => parseUploadMap(bad));
});

test("buildMapLayers splits, dedupes, links and bounds both sets", () => {
  const a: UploadMap = parseUploadMap({
    upload_id: upl(1),
    points: [point("P1:a", 27, -82), point("P2:a", 26, -81)],
    collisions: [
      collision("COL_1", point("P1:a", 27, -82), point("R1:a", 30, -85)),
      collision("COL_2", point("P2:a", 26, -81), point("R1:a", 30, -85)),
    ],
  });
  const b: UploadMap = parseUploadMap({
    upload_id: upl(2),
    points: [point("P1:a", 25, -80)],
    collisions: [
      collision("COL_1", point("P1:a", 27, -82), point("R1:a", 30, -85)),
      collision("COL_3", point("P3:a", 24, -79), point("R2:a", 24.5, -79.5)),
    ],
  });
  const layers = buildMapLayers([a, b]);
  assert.deepEqual(layers.uploaded.map((p) => p.key), [
    `${upl(1)}|P1:a`, `${upl(1)}|P2:a`, `${upl(2)}|P1:a`, `${upl(2)}|P3:a`,
  ]);
  assert.deepEqual(layers.reference.map((p) => p.key), ["ref|R1:a", "ref|R2:a"]);
  assert.deepEqual(layers.links.map((l) => l.id), ["COL_1", "COL_2", "COL_3"]);
  assert.deepEqual(layers.links[0].from, [27, -82]);
  assert.deepEqual(layers.links[0].to, [30, -85]);
  assert.equal(layers.links[0].reference_key, "ref|R1:a");
  assert.deepEqual(layers.bounds, [[24, -85], [30, -79]]);
  assert.deepEqual(buildMapLayers([]), { uploaded: [], reference: [], links: [], bounds: null });
  assert.deepEqual(buildMapLayers([{ upload_id: null, points: [], collisions: [] }]).bounds, null);
});
