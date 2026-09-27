"use client";
import { useMemo, useState } from "react";
import baseline from "@/data/project-locations.json";
import { ProjectMap } from "@/components/project-map";
import { PdfProjectUpload } from "@/components/pdf-project-upload";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { proximityPairs, type MapProject } from "@/lib/project-data";

export function DashboardWorkspace() {
  const [projects, setProjects] = useState<MapProject[]>(baseline);
  const [source, setSource] = useState("");
  const [revision, setRevision] = useState(0);
  const [uploadRevision, setUploadRevision] = useState(0);
  const pairs = useMemo(() => proximityPairs(projects), [projects]);
  const matched = new Set(pairs.flatMap(pair => [pair.a.record_id, pair.b.record_id])).size;
  return <>
    <div className="data-banner"><span>{source ? `Showing reviewed projects from ${source}` : "Showing project locations from the bundled CSV."}</span>
      {source && <Button variant="outline" onClick={() => { setProjects(baseline); setSource(""); setRevision(x=>x+1); setUploadRevision(x=>x+1); }}>Restore CSV projects</Button>}
    </div>
    <div className="dashboard-grid"><section className="stats-column" aria-label="Project overlap statistics">
      <div className="metrics-grid">{[{label:"Locations in view",value:projects.length,caption:"Records plotted on the map"},{label:"Overlap pairs",value:pairs.length,caption:"Project locations within 25 miles"}].map(metric => <Card className="metric-card panel" key={metric.label}><div className="metric-top"><span>{metric.label}</span></div><strong>{metric.value}</strong><p>{metric.caption}</p></Card>)}</div>
      <Card className="distribution-card panel"><div className="panel-heading"><div><span className="eyebrow">25-MILE PROXIMITY</span><h2>Nearby projects</h2></div></div>
        <p className="metric-note">{matched} locations have a neighboring project within 25 miles. This rule uses geographic distance, not schedule overlap or confirmed route intersections.</p>
        <div className="nearby-projects">{pairs.length === 0 ? <p>No project pairs within 25 miles.</p> : pairs.slice(0, 20).map(pair => <div key={`${pair.a.record_id}/${pair.b.record_id}`}><strong>{pair.a.project_name}</strong><span>{pair.b.project_name}</span><small>{pair.miles.toFixed(2)} miles apart</small></div>)}</div>
        {pairs.length > 20 && <p className="metric-note">Showing the 20 closest of {pairs.length} pairs.</p>}
      </Card>
    </section><ProjectMap key={revision} locations={projects} sourceLabel={source ? `PDF: ${source}` : "CSV project locations"} /></div>
    <section className="upload-section" aria-label="Construction plans"><PdfProjectUpload key={uploadRevision} onApply={(rows, name) => { setProjects(rows); setSource(name); setRevision(x=>x+1); }} /></section>
  </>;
}
