import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOverlaps, summarize, exampleOverlaps } from "./overlaps.ts";

test("accepts FastAPI's aliased time gap and preserves negative cosine scores", () => {
  const { time_gap_days, ...row } = exampleOverlaps[0];
  assert.equal(
    parseOverlaps([
      { ...row, "time_gap (day)": time_gap_days, name_similarity: -0.4 },
    ])[0].name_similarity,
    -0.4,
  );
});
test("rejects invalid responses rather than silently showing misleading stats", () => {
  for (const invalid of [
    null,
    {},
    [{ ...exampleOverlaps[0], name_similarity: 2 }],
    [{ ...exampleOverlaps[0], distance_mi: -1 }],
    [{ ...exampleOverlaps[0], project_id_a: null }],
  ])
    assert.throws(() => parseOverlaps(invalid));
});
test("deduplicates projects and assigns boundary scores to exactly one band", () => {
  const rows = [0.75, 0.5, -0.1].map((name_similarity, i) => ({
    ...exampleOverlaps[i],
    name_similarity,
    project_id_a: "A",
    project_id_b: "B",
  }));
  const stats = summarize(rows);
  assert.equal(stats.projects, 2);
  assert.equal(stats.highSimilarity, 2);
  assert.deepEqual(stats.bands, [1, 1, 1]);
});
test("empty results have no invented average", () => {
  assert.deepEqual(summarize([]), {
    projects: 0,
    pairs: 0,
    highSimilarity: 0,
    average: null,
    bands: [0, 0, 0],
  });
});
