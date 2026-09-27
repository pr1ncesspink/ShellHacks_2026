"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import defaultLocations from "@/data/project-locations.json";
import { type MapProject } from "@/lib/project-data";
import { Card } from "@/components/ui/card";

const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
const style = key
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${encodeURIComponent(key)}`
  : "https://tiles.openfreemap.org/styles/liberty";

export function ProjectMap({ locations = defaultLocations, sourceLabel = "CSV project locations", matchedIds, analysisReady }: { locations?: MapProject[]; sourceLabel?: string; matchedIds: string[]; analysisReady: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("Loading map…");
  const [attempt, setAttempt] = useState(0);

  const nearbyIds = useMemo(() => new Set(matchedIds), [matchedIds]);

  useEffect(() => {
    if (!container.current) return;
    let instance: maplibregl.Map;
    let loaded = false;
    const timer = window.setTimeout(() => {
      if (!loaded) setStatus("Map is taking longer to load. Check your connection or retry.");
    }, 20000);
    try {
      maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      instance = new maplibregl.Map({
        container: container.current,
        style,
        center: [-98, 38],
        zoom: 3,
        attributionControl: { compact: true },
      });
    } catch {
      window.clearTimeout(timer);
      // Report an external WebGL initialization failure.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus("The map could not start. Your browser needs WebGL enabled.");
      return;
    }
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl(), "top-right");
    instance.addControl(new maplibregl.FullscreenControl(), "top-right");
    instance.on("error", () => setStatus("Some map tiles could not load. Check your connection or retry."));
    instance.on("load", () => {
      loaded = true;
      window.clearTimeout(timer);
      setStatus("");
    });
    const bounds = new maplibregl.LngLatBounds();
    let activePopup: maplibregl.Popup | undefined;
    for (const project of locations) {
      bounds.extend([project.longitude, project.latitude]);
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = nearbyIds.has(project.record_id) ? "project-map-pin is-nearby" : "project-map-pin";
      pin.setAttribute("aria-label", `View ${project.project_name}${nearbyIds.has(project.record_id) ? ", matches distance and timing criteria" : ""}`);


      const content = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = project.project_name;
      content.append(heading);
      for (const text of [`Latitude: ${project.latitude.toFixed(6)}`, `Longitude: ${project.longitude.toFixed(6)}`, `Published date/year: ${project.schedule || project.estimated_in_service_year || "Not available"}`, ...(project.source_document ? [`Source: ${project.source_document}${project.source_page ? `, page ${project.source_page}` : " (manual entry)"}`] : ["Year only; exact date unavailable"]), project.owner, project.status || "Status unavailable"]) {
        const line = document.createElement("p");
        line.textContent = text;
        content.append(line);
      }
      let popup: maplibregl.Popup | undefined;
      const showPopup = () => {
        activePopup?.remove();
        popup = new maplibregl.Popup({ offset: 12, maxWidth: "300px", focusAfterOpen: false, closeOnClick: false, closeButton: false })
          .setLngLat([project.longitude, project.latitude]).setDOMContent(content).addTo(instance);
        activePopup = popup;
      };
      const hidePopup = () => popup?.remove();
      pin.addEventListener("mouseenter", showPopup);
      pin.addEventListener("mouseleave", hidePopup);
      pin.addEventListener("focus", showPopup);
      pin.addEventListener("blur", hidePopup);
      pin.addEventListener("keydown", (event) => { if (event.key === "Escape") hidePopup(); });
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        setSelected(project.record_id);
        showPopup();
      });
      new maplibregl.Marker({ element: pin })
        .setLngLat([project.longitude, project.latitude])
        .addTo(instance);
    }
    if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 45, maxZoom: 7, duration: 0 });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      instance.remove();
      map.current = null;
    };
  }, [attempt, locations, nearbyIds]);

  const project = locations.find((item) => item.record_id === selected);
  return (
    <Card className="map-card panel">
      <div className="panel-heading">
        <h2>Map Overview</h2>
        <span className="project-map-count">{locations.length} locations</span>
      </div>
      <div className="project-map-toolbar">
        <label htmlFor="project-location">Find a project</label>
        <select id="project-location" value={selected} onChange={(event) => {
          setSelected(event.target.value);
          const item = locations.find((row) => row.record_id === event.target.value);
          if (item) map.current?.flyTo({ center: [item.longitude, item.latitude], zoom: 9, duration: 800 });
        }}>
          <option value="">Select a project location…</option>
          {locations.map((item) => <option key={item.record_id} value={item.record_id}>{item.project_name}{item.segment ? ` — ${item.segment}` : ""} ({item.record_id})</option>)}
        </select>
        <div className="project-map-legend" aria-label="Map marker colors"><span><i className="nearby-swatch" />Distance + timing match</span><span><i />No confirmed match</span></div>
        <p className="project-map-line-note">{analysisReady ? "Backend matches use distance and published timing; they do not confirm physical overlap." : "Backend analysis pending or unavailable. No matches are highlighted."}</p>
        <button className="project-map-reset" type="button" onClick={() => {
          const bounds = new maplibregl.LngLatBounds();
          locations.forEach(p => bounds.extend([p.longitude, p.latitude]));
          if (!bounds.isEmpty()) map.current?.fitBounds(bounds, { padding: 45, maxZoom: 7, duration: 500 });
        }}>Show all locations</button>
      </div>
      <div className="project-map-stage">
        <div ref={container} className="project-map-canvas" role="region" aria-label="Interactive map of project locations" />
        {status && <div className="project-map-status" role="status">{status} <button type="button" onClick={() => { setStatus("Loading map…"); setAttempt((value) => value + 1); }}>Retry</button></div>}
      </div>
      {project && <div className="project-map-details" aria-live="polite">
        <strong>{project.project_name}</strong>
        <span>Latitude: {project.latitude.toFixed(6)} | Longitude: {project.longitude.toFixed(6)}</span>
        <span>Published date/year: {project.schedule || project.estimated_in_service_year || "Not available"}</span>
        <span>{project.owner} · {project.status || "Status unavailable"}</span>
        <span>{project.states} · {project.coordinate_method.replaceAll("_", " ")}</span>
        {/^https?:\/\//.test(project.project_source_url) && <a href={project.project_source_url} target="_blank" rel="noopener noreferrer">Project source ↗</a>}
      </div>}
      <div className="map-footer"><span>{sourceLabel}</span><span>Approximate points, not project boundaries</span></div>
    </Card>
  );
}
