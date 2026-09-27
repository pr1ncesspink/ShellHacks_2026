import { strict as assert } from "node:assert";
import { test } from "node:test";
import { distanceMiles, nearbyRecordIds } from "./project-proximity.ts";

const point = (id: string, latitude: number, longitude = 0, project = id) =>
  ({ record_id: id, project_id: project, latitude, longitude });

test("inclusive 25-mile boundary flags both distinct projects, excluding outside points", () => {
  const degrees = 25 / 3958.7613 * 180 / Math.PI;
  const a = point("a", 0);
  const b = point("b", degrees);
  assert.ok(Math.abs(distanceMiles(a, b) - 25) < 1e-8);
  assert.deepEqual([...nearbyRecordIds([a, b])].sort(), ["a", "b"]);
  assert.equal(nearbyRecordIds([a, point("outside", degrees + 0.00001)]).size, 0);
});
test("same-project records do not flag each other, different colocated projects do", () => {
  const a = point("a", 33, -81, "shared");
  assert.equal(nearbyRecordIds([a, point("b", 33, -81, "shared")]).size, 0);
  assert.equal(nearbyRecordIds([a, point("c", 33, -81)]).size, 2);
});
test("distance wraps correctly across the date line", () => {
  assert.ok(distanceMiles(point("a", 0, 179.9), point("b", 0, -179.9)) < 25);
});
