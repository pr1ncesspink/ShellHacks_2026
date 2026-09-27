"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { collisionFocus } from "@/lib/map-focus";
import { nearbyRecordIds } from "@/lib/project-proximity";
import type { MapBounds, MapLayers, MapPoint } from "@/lib/upload-summary";

// Type-only: the 150 KB reference JSON is loaded lazily (reference mode only),
// so the upload-mode map on /budget never downloads it once layers arrive.
type DefaultLocations = typeof import("@/data/project-locations.json");
type ProjectLocation = DefaultLocations[number] & { source_document?: string; user_supplied?: boolean };

let defaultLocationsPromise: Promise<ProjectLocation[]> | null = null;
function loadDefaultLocations(): Promise<ProjectLocation[]> {
  defaultLocationsPromise ??= import("@/data/project-locations.json").then((m) => m.default as ProjectLocation[]);
  // Let a failed chunk load be retried on the next mount.
  defaultLocationsPromise.catch(() => { defaultLocationsPromise = null; });
  return defaultLocationsPromise;
}

const EMPTY_LOCATIONS: ProjectLocation[] = [];

export type ProjectMapProps = {
  /** Reference-locations mode: record to centre on and outline. */
  focusedRecordId?: string;
  /** Reference-locations mode: markers open /budget?project=… instead of a popup. */
  navigateToBudget?: boolean;
  /** Reference-locations mode: points to plot (defaults to src/data/project-locations.json). */
  locations?: ProjectLocation[];
  /**
   * Upload mode (from buildMapLayers): uploaded points as violet rings,
   * reference points muted, dashed collision links with a distance tooltip,
   * zoomed to the collisions (collisionFocus) whenever that set changes, plus
   * a table fallback. Replaces `locations` when set.
   */
  layers?: MapLayers;
  title?: string;
};

// Colours come from theme tokens via Tailwind classes on the SVG paths (CSS
// beats Leaflet's presentation attributes), so no raw colours live here.
const MARKER_CLASS = {
  plain: "fill-chart-1 stroke-foreground",
  nearby: "fill-chart-3 stroke-foreground",
  userSupplied: "fill-card stroke-chart-3",
  plainSelected: "fill-chart-1 stroke-accent",
  nearbySelected: "fill-chart-3 stroke-accent",
  userSuppliedSelected: "fill-card stroke-accent",
  uploaded: "fill-card stroke-chart-3",
  reference: "fill-muted-foreground stroke-card",
  link: "stroke-chart-3",
} as const;

const US_VIEW: [number, number] = [38, -98];
/** Upload-mode fit: room around the collisions, never closer than street level. */
const FOCUS_FIT = { padding: [48, 48] as [number, number], maxZoom: 13 };

function textBlock(className: string, title: string, lines: string[]): HTMLDivElement {
  const root = document.createElement("div");
  root.className = className;
  const heading = document.createElement("strong");
  heading.textContent = title;
  root.append(heading);
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    root.append(row);
  }
  return root;
}

function pointLines(p: MapPoint): string[] {
  const when = p.in_service_date ?? (p.estimated_in_service_year ? String(p.estimated_in_service_year) : "Not provided");
  return [
    `${p.owner || "Owner unspecified"} · ${p.status || "Status unspecified"}`,
    `In service: ${when}`,
    `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`,
  ];
}

export function formatMiles(miles: number): string {
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toLocaleString()} mi`;
}

export function formatTimeGap(days: number | null): string {
  if (days === null) return "Unknown";
  if (days === 0) return "Same time";
  if (days < 365) return `${days.toLocaleString()} ${days === 1 ? "day" : "days"}`;
  return `${(days / 365).toFixed(1)} years`;
}

function drawLayers(L: typeof Leaflet, map: Leaflet.LayerGroup, layers: MapLayers) {
  for (const link of layers.links) {
    const gap = link.time_gap_days === null ? "" : ` · time gap ${formatTimeGap(link.time_gap_days)}`;
    L.polyline([link.from, link.to], { className: MARKER_CLASS.link, weight: 2, opacity: 0.85, dashArray: "6 6" })
      .bindTooltip(`${formatMiles(link.distance_mi)} apart${gap}`, { sticky: true, className: "project-location-tooltip" })
      .addTo(map);
  }
  for (const p of layers.reference) {
    L.circleMarker([p.lat, p.lon], { className: MARKER_CLASS.reference, radius: 4, weight: 1, fillOpacity: 1 })
      .bindTooltip(textBlock("project-map-tooltip-content", `Reference: ${p.name}`, pointLines(p)), { direction: "top", className: "project-location-tooltip" })
      .addTo(map);
  }
  for (const p of layers.uploaded) {
    L.circleMarker([p.lat, p.lon], { className: MARKER_CLASS.uploaded, radius: 7, weight: 3, fillOpacity: 1 })
      .bindTooltip(textBlock("project-map-tooltip-content", `Uploaded: ${p.name}`, pointLines(p)), { direction: "top", className: "project-location-tooltip" })
      .addTo(map);
  }
}

function drawLocations(
  L: typeof Leaflet,
  map: Leaflet.LayerGroup,
  points: ProjectLocation[],
  nearby: Set<string>,
  focusedRecordId: string | undefined,
  openProject: ((recordId: string) => void) | null,
) {
  // Group coincident coordinates so every record remains accessible in its popup.
  const groups = new Map<string, ProjectLocation[]>();
  for (const point of points) {
    const key = `${point.latitude},${point.longitude}`;
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const isNearby = group.some((p) => nearby.has(p.record_id));
    const isUserSupplied = group.some(p => p.user_supplied || p.source_document || p.coordinate_method === "user_reviewed_pdf");
    const selected = group.some(p => p.record_id === focusedRecordId);
    const tooltip = textBlock(
      "project-map-tooltip-content",
      [...new Set(group.map((p) => p.project_name))].join(" · "),
      [
        `Latitude: ${first.latitude} · Longitude: ${first.longitude}`,
        ...group.map(p => `${group.length > 1 ? `${p.project_name}: ` : ""}Estimated in-service year: ${p.estimated_in_service_year || "Not provided"}`),
      ],
    );
    const className = isUserSupplied
      ? (selected ? MARKER_CLASS.userSuppliedSelected : MARKER_CLASS.userSupplied)
      : isNearby
        ? (selected ? MARKER_CLASS.nearbySelected : MARKER_CLASS.nearby)
        : (selected ? MARKER_CLASS.plainSelected : MARKER_CLASS.plain);
    const marker = L.circleMarker([first.latitude, first.longitude], {
      className, radius: selected ? 9 : isUserSupplied ? 6 : 5, weight: selected || isUserSupplied ? 3 : 1.5, fillOpacity: 1,
    }).bindTooltip(tooltip, { direction: "top", className: "project-location-tooltip" }).addTo(map);
    if (openProject) {
      const open = () => openProject(first.record_id);
      marker.on("click", open);
      const element = marker.getElement();
      element?.setAttribute("tabindex", "0");
      element?.setAttribute("role", "link");
      element?.setAttribute("aria-label", `Open project area: ${group.map(p => p.project_name).join(", ")}`);
      element?.addEventListener("keydown", event => {
        if (event instanceof KeyboardEvent && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); }
      });
    } else {
      const popup = document.createElement("div");
      popup.className = "project-map-popup";
      for (const p of group) {
        const section = document.createElement("section");
        const title = document.createElement("strong");
        title.textContent = p.project_name;
        const lines = [
          `${p.owner || "Owner unspecified"} · ${p.states} · ${p.status || "Status unspecified"}`,
          `Estimated in-service year: ${p.estimated_in_service_year || "Not provided"}`,
          `${p.record_id} / ${p.project_id} · ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} · ${p.coordinate_method.replaceAll("_", " ")}`,
          nearby.has(p.record_id) ? "Another project is within 25 miles." : "No other project within 25 miles.",
        ];
        section.append(title, ...lines.map(line => { const el = document.createElement("p"); el.textContent = line; return el; }));
        const link = document.createElement("a");
        link.href = `/budget?project=${encodeURIComponent(p.record_id)}`;
        link.textContent = "View this project";
        section.append(link);
        popup.append(section);
      }
      marker.bindPopup(popup, { maxWidth: 300, maxHeight: 240 });
    }
  }
}

function LegendItem({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden="true" className={swatch} />
      {children}
    </li>
  );
}

function MapLegend({ upload }: { upload: boolean }) {
  return (
    <ul aria-label="Map legend" className="flex flex-wrap gap-x-4 gap-y-2 px-5 pt-3 text-xs text-muted-foreground">
      {upload ? <>
        <LegendItem swatch="inline-block size-3 rounded-full border-[3px] border-chart-3 bg-card">Uploaded project</LegendItem>
        <LegendItem swatch="inline-block size-2 rounded-full bg-muted-foreground">Reference project</LegendItem>
        <LegendItem swatch="inline-block w-5 border-t-2 border-dashed border-chart-3">Nearby pair (hover for distance)</LegendItem>
      </> : <>
        <LegendItem swatch="inline-block size-2.5 rounded-full border border-foreground bg-chart-1">No other project within 25 miles</LegendItem>
        <LegendItem swatch="inline-block size-2.5 rounded-full border border-foreground bg-chart-3">Another project within 25 miles</LegendItem>
        <LegendItem swatch="inline-block size-3 rounded-full border-[3px] border-chart-3 bg-card">User-supplied location</LegendItem>
      </>}
    </ul>
  );
}

function NearestTable({ layers }: { layers: MapLayers }) {
  const rows = useMemo(() => {
    const reference = new Map(layers.reference.map(p => [p.key, p]));
    const nearest = new Map<string, MapLayers["links"][number]>();
    for (const link of layers.links) {
      const best = nearest.get(link.uploaded_key);
      if (!best || link.distance_mi < best.distance_mi) nearest.set(link.uploaded_key, link);
    }
    return layers.uploaded
      .map(p => {
        const link = nearest.get(p.key);
        return { point: p, link, reference: link ? reference.get(link.reference_key) : undefined };
      })
      .sort((a, b) => (a.link?.distance_mi ?? Infinity) - (b.link?.distance_mi ?? Infinity));
  }, [layers]);
  if (!rows.length) return null;
  return (
    <div className="max-h-80 overflow-auto border-t border-border" tabIndex={0} role="region" aria-labelledby="nearest-table-caption">
      <table className="w-full border-collapse text-left text-xs">
        <caption id="nearest-table-caption" className="px-5 py-3 text-left text-sm font-medium text-foreground">
          Uploaded projects and their nearest reference project
        </caption>
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="px-5 py-2 font-medium">Uploaded project</th>
            <th scope="col" className="px-3 py-2 font-medium">Nearest reference</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Miles</th>
            <th scope="col" className="px-5 py-2 text-right font-medium">Time gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ point, link, reference }) => (
            <tr key={point.key} className="border-t border-border">
              <th scope="row" className="px-5 py-2 font-normal">{point.name}</th>
              <td className="px-3 py-2">{reference?.name ?? "None nearby"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{link ? formatMiles(link.distance_mi) : "—"}</td>
              <td className="px-5 py-2 text-right tabular-nums">{link ? formatTimeGap(link.time_gap_days) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type MapHandle = { L: typeof Leaflet; map: Leaflet.Map; group: Leaflet.LayerGroup; reduced: boolean };

export function ProjectMap({ focusedRecordId, navigateToBudget = true, locations, layers, title }: ProjectMapProps) {
  const [loadedDefaults, setLoadedDefaults] = useState<ProjectLocation[] | null>(null);
  const needsDefaults = !layers && !locations;
  // Upload mode never plots reference locations, so skip them entirely.
  const points = layers ? EMPTY_LOCATIONS : locations ?? loadedDefaults ?? EMPTY_LOCATIONS;
  const pointsReady = Boolean(layers || locations || loadedDefaults);
  const nearby = useMemo(() => (layers ? new Set<string>() : nearbyRecordIds(points)), [layers, points]);
  const router = useRouter();
  const focused = layers ? undefined : points.find(point => point.record_id === focusedRecordId);
  const container = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<MapHandle | null>(null);
  /** collisionFocus key last fitted in upload mode; refit only when it changes. */
  const fittedKeyRef = useRef<string | null>(null);
  const focus = useMemo(() => (layers ? collisionFocus(layers) : null), [layers]);
  const [message, setMessage] = useState("Loading project map…");
  const projectCount = useMemo(() => new Set(points.map((p) => p.project_id)).size, [points]);

  useEffect(() => {
    if (!needsDefaults || loadedDefaults) return;
    let disposed = false;
    loadDefaultLocations()
      .then((data) => { if (!disposed) setLoadedDefaults(data); })
      .catch(() => { if (!disposed) setMessage("Project locations could not load. Refresh to try again."); });
    return () => { disposed = true; };
  }, [needsDefaults, loadedDefaults]);

  // Create the Leaflet map once; data changes only redraw its layer group.
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let created: Leaflet.Map | undefined;
    import("leaflet").then((L) => {
      if (disposed || !container.current) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const map = L.map(container.current, {
        scrollWheelZoom: true, touchZoom: true, zoomSnap: 0.25,
        zoomAnimation: !reduced, fadeAnimation: !reduced,
      });
      created = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).on("tileerror", () => {
        if (!disposed) setMessage("Basemap unavailable. Project markers are still shown; check your connection.");
      }).addTo(map);
      map.setView(US_VIEW, 3, { animate: false });
      const group = L.layerGroup().addTo(map);
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(container.current);
      setHandle({ L, map, group, reduced });
      setMessage("");
    }).catch(() => { if (!disposed) setMessage("The map could not load. Refresh to try again."); });
    return () => {
      disposed = true;
      observer?.disconnect();
      created?.remove();
      fittedKeyRef.current = null;
      setHandle(null);
    };
  }, []);

  useEffect(() => {
    if (!handle) return;
    const { L, map, group, reduced } = handle;
    group.clearLayers();
    if (layers && focus) {
      // Zoom to the collisions when the set of collisions (or the fallback
      // uploaded points) changes; otherwise leave the user's view alone.
      if (fittedKeyRef.current !== focus.key) {
        fittedKeyRef.current = focus.key;
        if (focus.bounds) map.fitBounds(L.latLngBounds(focus.bounds), { ...FOCUS_FIT, animate: !reduced });
        else map.setView(US_VIEW, 3, { animate: !reduced });
      }
      drawLayers(L, group, layers);
      return;
    }
    if (!pointsReady) return;
    fittedKeyRef.current = null;
    if (focused) map.setView([focused.latitude, focused.longitude], 11, { animate: !reduced });
    else if (points.length) map.fitBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]), { padding: [24, 24], animate: !reduced });
    else map.setView(US_VIEW, 3, { animate: !reduced });
    const openProject = navigateToBudget ? (recordId: string) => router.push(`/budget?project=${encodeURIComponent(recordId)}`) : null;
    drawLocations(L, group, points, nearby, focusedRecordId, openProject);
  }, [handle, layers, focus, pointsReady, focused, focusedRecordId, navigateToBudget, router, points, nearby]);

  function fitTo(bounds: MapBounds | null) {
    if (!handle || !bounds) return;
    handle.map.fitBounds(bounds, { ...FOCUS_FIT, animate: !handle.reduced });
  }

  function resetView() {
    if (!handle) return;
    const { map, reduced } = handle;
    const animate = !reduced;
    if (layers) { fitTo(layers.bounds); return; }
    if (focused) { map.setView([focused.latitude, focused.longitude], 11, { animate }); return; }
    if (points.length) map.fitBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]), { padding: [24, 24], animate });
  }

  // Keep focus-mode copy stable while the reference locations load.
  const showFocused = Boolean(focused) || (!pointsReady && Boolean(focusedRecordId));
  const pointCount = layers ? layers.uploaded.length + layers.reference.length : points.length;
  const heading = title ?? (layers ? "Uploaded projects and nearby references" : showFocused ? "Selected project area" : "Project landscape");
  const focusLabel = focus ? `${focus.label}.` : "";
  return (
    <Card className="map-card panel project-map-card">
      <div className="panel-heading flex-wrap">
        <div className="min-w-0"><span className="eyebrow">Spatial context</span><h2>{heading}</h2></div>
        {layers && focus
          ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="touch" disabled={focus.kind !== "collisions"} onClick={() => fitTo(focus.bounds)}>
                Zoom to collisions
              </Button>
              <Button type="button" variant="outline" size="touch" onClick={resetView}>Show all</Button>
            </div>
          )
          : <Button type="button" variant="outline" size="touch" onClick={resetView}>{showFocused ? "Recenter" : "Show all"}</Button>}
      </div>
      <div
        ref={container}
        className="project-map-canvas"
        role="region"
        aria-label={`Project location map: ${pointCount} points. ${focusLabel ? `${focusLabel} ` : ""}Use arrow keys to pan and plus or minus to zoom.`}
      />
      {focus && <p className="project-map-note" role="status">{focusLabel}</p>}
      {message && <p className="project-map-message" role="status">{message}</p>}
      <MapLegend upload={Boolean(layers)} />
      <div className="map-footer">
        {layers
          ? <><span>{layers.uploaded.length} uploaded · {layers.reference.length} reference</span><span>{layers.links.length} nearby {layers.links.length === 1 ? "pair" : "pairs"}</span></>
          : pointsReady
            ? <><span>{points.length} locations · {projectCount} projects</span><span>CSV location data</span></>
            : <span>Loading locations…</span>}
      </div>
      {focused && <p className="project-map-note"><strong>{focused.project_name}</strong> · {focused.latitude}, {focused.longitude}</p>}
      {layers
        ? <>
          <p className="project-map-note">Lines join each uploaded project to nearby reference projects. Proximity does not confirm construction or schedule overlap.</p>
          <NearestTable layers={layers} />
        </>
        : <p className="project-map-note">{navigateToBudget ? "Select a point to focus the map on its project area." : "The outlined marker is your selected location. Click nearby points for details."} Proximity does not confirm construction or schedule overlap.</p>}
    </Card>
  );
}
