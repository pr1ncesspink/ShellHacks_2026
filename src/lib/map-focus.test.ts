import assert from "node:assert/strict";
import test from "node:test";
import { collisionFocus } from "./map-focus.ts";
import type { CollisionLink, MapLayers, UploadedMapPoint } from "./upload-summary.ts";

function point(key: string, lat: number, lon: number): UploadedMapPoint {
  return {
    key, upload_id: null, record_id: key, project_id: key, name: key, owner: null, lat, lon,
    coordinate_method: null, status: null, in_service_date: null, estimated_in_service_year: null,
  };
}

function link(id: string, from: [number, number], to: [number, number]): CollisionLink {
  return {
    id, upload_id: null, uploaded_key: `u|${id}`, reference_key: `ref|${id}`, from, to,
    distance_mi: 1, time_gap_days: null, timing_basis: null,
  };
}

const layers = (partial: Partial<MapLayers>): MapLayers => ({ uploaded: [], reference: [], links: [], bounds: null, ...partial });

test("empty layers have no focus", () => {
  const focus = collisionFocus(layers({}));
  assert.deepEqual(focus, {
    bounds: null, kind: "none", count: 0, key: "none",
    label: "No mapped locations in this upload; showing the default view",
  });
});

test("links focus on both endpoints of every link, ignoring other points", () => {
  const focus = collisionFocus(layers({
    uploaded: [point("far", 60, -150), point("a", 27, -82)],
    links: [link("L1", [27, -82], [27.5, -82.5]), link("L2", [28, -81], [26, -80])],
    bounds: [[26, -150], [60, -80]],
  }));
  assert.equal(focus.kind, "collisions");
  assert.equal(focus.count, 2);
  assert.deepEqual(focus.bounds, [[26, -82.5], [28, -80]]);
  assert.equal(focus.label, "Zoomed to 2 nearby collisions");
  assert.equal(collisionFocus(layers({ links: [link("L1", [1, 2], [3, 4])] })).label, "Zoomed to 1 nearby collision");
});

test("without links, focus falls back to uploaded points", () => {
  const uploaded = Array.from({ length: 12 }, (_, i) => point(`p${i}`, 25 + i, -80 - i));
  const focus = collisionFocus(layers({ uploaded }));
  assert.equal(focus.kind, "uploaded");
  assert.equal(focus.count, 12);
  assert.deepEqual(focus.bounds, [[25, -91], [36, -80]]);
  assert.equal(focus.label, "No collisions found; showing your 12 uploaded locations");
  assert.equal(collisionFocus(layers({ uploaded: [point("one", 1, 1)] })).label, "No collisions found; showing your 1 uploaded location");
});

test("key is stable under reorder and changes with the set", () => {
  const a = link("A", [1, 1], [2, 2]);
  const b = link("B", [3, 3], [4, 4]);
  const c = link("C", [5, 5], [6, 6]);
  const first = collisionFocus(layers({ links: [a, b] }));
  const reordered = collisionFocus(layers({ links: [b, a] }));
  assert.equal(first.key, reordered.key);
  assert.deepEqual(first.bounds, reordered.bounds);
  assert.notEqual(collisionFocus(layers({ links: [a, b, c] })).key, first.key);
  const up = collisionFocus(layers({ uploaded: [point("x", 1, 1), point("y", 2, 2)] }));
  assert.equal(up.key, collisionFocus(layers({ uploaded: [point("y", 2, 2), point("x", 1, 1)] })).key);
  assert.notEqual(up.key, first.key);
});

test("a single point yields zero-area bounds", () => {
  assert.deepEqual(collisionFocus(layers({ uploaded: [point("solo", 27.9, -82.4)] })).bounds, [[27.9, -82.4], [27.9, -82.4]]);
  assert.deepEqual(collisionFocus(layers({ links: [link("S", [27.9, -82.4], [27.9, -82.4])] })).bounds, [[27.9, -82.4], [27.9, -82.4]]);
});
