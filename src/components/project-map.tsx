"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import points from "@/data/project-locations.json";
import { Card } from "@/components/ui/card";
import { nearbyRecordIds } from "@/lib/project-proximity";

const nearby = nearbyRecordIds(points);

export function ProjectMap() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [message, setMessage] = useState("Loading project map…");
  const projectCount = new Set(points.map((p) => p.project_id)).size;

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    import("leaflet").then((L) => {
      if (disposed || !container.current) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const map = L.map(container.current, {
        scrollWheelZoom: false, zoomAnimation: !reduced, fadeAnimation: !reduced,
      });
      mapRef.current = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).on("tileerror", () => {
        if (!disposed) setMessage("Basemap unavailable. Project markers are still shown; check your connection.");
      }).addTo(map);
      // Group coincident coordinates so every record remains accessible in its popup.
      const groups = new Map<string, typeof points>();
      for (const point of points) {
        const key = `${point.latitude},${point.longitude}`;
        groups.set(key, [...(groups.get(key) ?? []), point]);
      }
      for (const group of groups.values()) {
        const first = group[0];
        const isNearby = group.some((p) => nearby.has(p.record_id));
        const tooltip = document.createElement("div");
        tooltip.className = "project-map-tooltip-content";
        const names = document.createElement("strong");
        names.textContent = [...new Set(group.map((p) => p.project_name))].join(" · ");
        const coordinates = document.createElement("div");
        coordinates.textContent = `Latitude: ${first.latitude} · Longitude: ${first.longitude}`;
        tooltip.append(names, coordinates);
        for (const p of group) {
          const date = document.createElement("div");
          date.textContent = `${group.length > 1 ? `${p.project_name}: ` : ""}Estimated in-service year: ${p.estimated_in_service_year || "Not provided"}`;
          tooltip.append(date);
        }
        const popup = document.createElement("div");
        popup.className = "project-map-popup";
        for (const p of group) {
          const section = document.createElement("section");
          const title = document.createElement("strong");
          title.textContent = p.project_name;
          const detail = document.createElement("p");
          detail.textContent = `${p.owner || "Owner unspecified"} · ${p.states} · ${p.status || "Status unspecified"}`;
          const location = document.createElement("p");
          location.textContent = `${p.record_id} / ${p.project_id} · ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} · ${p.coordinate_method.replaceAll("_", " ")}`;
          const year = document.createElement("p");
          year.textContent = `Estimated in-service year: ${p.estimated_in_service_year || "Not provided"}`;
          const proximity = document.createElement("p");
          proximity.textContent = nearby.has(p.record_id) ? "Another project is within 25 miles." : "No other project within 25 miles.";
          section.append(title, detail, year, location, proximity);
          popup.append(section);
        }
        L.circleMarker([first.latitude, first.longitude], {
          radius: 5, color: "#ffffff", weight: 1.5,
          fillColor: isNearby ? "#f59a45" : "#1d84f5", fillOpacity: 0.9,
        }).bindTooltip(tooltip, { direction: "top", className: "project-location-tooltip" })
          .bindPopup(popup, { maxWidth: 300, maxHeight: 240 }).addTo(map);
      }
      map.fitBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]), { padding: [24, 24] });
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(container.current);
      setMessage("");
    }).catch(() => { if (!disposed) setMessage("The map could not load. Refresh to try again."); });
    return () => {
      disposed = true;
      observer?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  function resetView() {
    mapRef.current?.fitBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]), { padding: [24, 24] });
  }

  return (
    <Card className="map-card panel project-map-card">
      <div className="panel-heading">
        <div><span className="eyebrow">SPATIAL CONTEXT</span><h2>Project landscape</h2></div>
        <button type="button" className="map-reset" onClick={resetView}>Show all</button>
      </div>
      <div ref={container} className="project-map-canvas" role="region" aria-label={`Project location map: ${points.length} points. Use arrow keys to pan and plus or minus to zoom.`} />
      {message && <p className="project-map-message" role="status">{message}</p>}
      <div className="map-footer"><span>{points.length} locations · {projectCount} projects</span><span>Static reference dataset</span></div>
      <p className="project-map-note">Orange: another project within 25 miles (inclusive). Blue: no other project within 25 miles. Hover or click for the year and details. Proximity does not confirm construction or schedule overlap.</p>
    </Card>
  );
}
