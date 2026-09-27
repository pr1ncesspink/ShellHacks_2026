type Point = { record_id: string; project_id: string; latitude: number; longitude: number };

export function distanceMiles(a: Point, b: Point): number {
  const radians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * radians) *
    Math.cos(b.latitude * radians) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function nearbyRecordIds(points: Point[], radius = 25): Set<string> {
  return new Set(nearbyConnections(points, radius).keys());
}

export function nearbyConnections(points: Point[], radius = 25): Map<string, Set<string>> {
  const nearby = new Map<string, Set<string>>();
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (points[i].project_id === points[j].project_id) continue;
      if (distanceMiles(points[i], points[j]) <= radius + 1e-8) {
        const a = points[i].record_id, b = points[j].record_id;
        if (!nearby.has(a)) nearby.set(a, new Set());
        if (!nearby.has(b)) nearby.set(b, new Set());
        nearby.get(a)!.add(b);
        nearby.get(b)!.add(a);
      }
    }
  }
  return nearby;
}
