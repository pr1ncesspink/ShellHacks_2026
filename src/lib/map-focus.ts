// Where the /budget map should zoom for a set of upload layers: the bounds of
// every collision link (both endpoints), else the uploaded points, else
// nothing (the map keeps its default view). `key` changes only when the set of
// focused items changes, so ProjectMap refits on new collisions without
// fighting the user's pan/zoom on unrelated re-renders.
import type { MapBounds, MapLayers } from "./upload-summary.ts";

export type CollisionFocusKind = "collisions" | "uploaded" | "none";
export type CollisionFocus = {
  bounds: MapBounds | null;
  kind: CollisionFocusKind;
  count: number;
  key: string;
  label: string;
};

function boundsOf(points: readonly (readonly [number, number])[]): MapBounds | null {
  let bounds: MapBounds | null = null;
  for (const [lat, lon] of points) {
    if (!bounds) { bounds = [[lat, lon], [lat, lon]]; continue; }
    bounds = [
      [Math.min(bounds[0][0], lat), Math.min(bounds[0][1], lon)],
      [Math.max(bounds[1][0], lat), Math.max(bounds[1][1], lon)],
    ];
  }
  return bounds;
}

const stableKey = (prefix: string, ids: readonly string[]) => `${prefix}:${[...new Set(ids)].sort().join(",")}`;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function collisionFocus(layers: MapLayers): CollisionFocus {
  if (layers.links.length) {
    const count = layers.links.length;
    return {
      bounds: boundsOf(layers.links.flatMap((link) => [link.from, link.to])),
      kind: "collisions",
      count,
      key: stableKey("collisions", layers.links.map((link) => link.id)),
      label: `Zoomed to ${plural(count, "nearby collision", "nearby collisions")}`,
    };
  }
  if (layers.uploaded.length) {
    const count = layers.uploaded.length;
    return {
      bounds: boundsOf(layers.uploaded.map((point) => [point.lat, point.lon] as const)),
      kind: "uploaded",
      count,
      key: stableKey("uploaded", layers.uploaded.map((point) => point.key)),
      label: `No collisions found; showing your ${plural(count, "uploaded location", "uploaded locations")}`,
    };
  }
  return {
    bounds: null,
    kind: "none",
    count: 0,
    key: "none",
    label: "No mapped locations in this upload; showing the default view",
  };
}
