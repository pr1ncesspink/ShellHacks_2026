"use client";
import { useEffect, useMemo, useState } from "react";
import baseline from "@/data/project-locations.json";
import { ProjectMap } from "@/components/project-map";
import { PdfProjectUpload } from "@/components/pdf-project-upload";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { type MapProject } from "@/lib/project-data";

type Preferences = { unit: "years" | "days"; window: number; earlier: number; later: number };
type Analysis = { pairs: { a_id: string; b_id: string; miles: number; timing: string }[]; unknown_timing_pairs: number };
type Plan = Analysis & {
  preferences?: Preferences;
  proposal?: {
    projects: MapProject[]; analysis: Analysis;
    changes: { record_id: string; project_name: string; before: string; after: string; shift: number }[];
    moved_projects: number; resolved_pairs: number; method: string;
  };
};

export function DashboardWorkspace() {
  const [projects, setProjects] = useState<MapProject[]>(baseline);
  const [source, setSource] = useState("");
  const [uploadRevision, setUploadRevision] = useState(0);
  const [result, setResult] = useState<{ projects: MapProject[]; request: Preferences | null; analysis?: Plan; error?: string } | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({ unit: "years", window: 0, earlier: 1, later: 1 });
  const [request, setRequest] = useState<Preferences | null>(null);
  const [view, setView] = useState<"current" | "proposed">("current");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/map-analysis", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ projects, ...(request ? { preferences: request } : {}) }),
    }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Map analysis failed");
      if (!controller.signal.aborted) setResult({ projects, request, analysis: payload });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ projects, request, error: error.message });
    });
    return () => controller.abort();
  }, [projects, request, attempt]);
  const current = result?.projects === projects && result?.request === request ? result : null;
  const proposal = current?.analysis?.proposal;
  const proposed = view === "proposed" && !!proposal;
  const displayedProjects = useMemo(() => {
    if (!proposed || !proposal) return projects;
    const updated = new Map(proposal.projects.map(p => [p.record_id, p]));
    return projects.map(p => ({ ...p, ...updated.get(p.record_id) }));
  }, [projects, proposed, proposal]);
  const analysis = proposed ? proposal?.analysis : current?.analysis;
  const pairs = useMemo(() => {
    const byId = new Map(displayedProjects.map(project => [project.record_id, project]));
    return (analysis?.pairs ?? []).flatMap(pair => {
      const a = byId.get(pair.a_id), b = byId.get(pair.b_id);
      return a && b ? [{ ...pair, a, b }] : [];
    });
  }, [displayedProjects, analysis]);
  const matchedIds = useMemo(() => pairs.flatMap(pair => [pair.a_id, pair.b_id]), [pairs]);
  function replaceProjects(rows: MapProject[], name: string) {
    setProjects(rows); setSource(name); setRequest(null); setView("current"); setResult(null);
  }
  return <>
    <section className="dashboard-attachments" aria-label="Attach construction plans">
      <PdfProjectUpload key={uploadRevision} onApply={replaceProjects} />
    </section>
    {source && <div className="mb-5"><Button variant="outline" onClick={() => {
      replaceProjects(baseline, ""); setUploadRevision(x => x + 1);
    }}>Restore CSV projects</Button></div>}

    <Card className="schedule-planner">
      <h2>Explore a schedule change</h2>
      <p>Choose what counts as a timing overlap and how far each project may move. Locations stay fixed.</p>
      <form onSubmit={event => {
        event.preventDefault(); setRequest({ ...preferences }); setView("proposed"); setResult(null);
      }}>
        <label>Time unit
          <select value={preferences.unit} onChange={event => setPreferences({
            unit: event.target.value as Preferences["unit"], window: 0, earlier: 0, later: 0,
          })}>
            <option value="years">Calendar years</option>
            <option value="days">Days (exact dates required)</option>
          </select>
        </label>
        {([
          ["window", "Overlap window", "0 means the same year or day."],
          ["earlier", "May start earlier by", "Use 0 to disallow earlier dates."],
          ["later", "May postpone by", "Use 0 to disallow postponement."],
        ] as const).map(([key, label, hint]) => <label key={key}>{label}
          <div className="schedule-number"><input type="number" required min="0" max={preferences.unit === "years" ? 10 : 3650} step="1"
            value={Number.isNaN(preferences[key]) ? "" : preferences[key]} onChange={event => setPreferences({ ...preferences, [key]: event.target.value === "" ? NaN : Number(event.target.value) })} />
            <span>{preferences.unit}</span></div><small>{hint}</small>
        </label>)}
        <Button type="submit" disabled={!current}>Generate proposal</Button>
      </form>
      <p>{preferences.unit === "years"
        ? "Year-based comparisons use published calendar years. For example, 0 matches projects in the same year; 1 also includes adjacent years."
        : "Year-only and unrecognized dates cannot be assessed in day mode; those projects remain unchanged."}</p>
    </Card>

    <div className="mb-5" role="status">
      {!current ? "Analyzing map locations with the backend…" : current.error ? <>{current.error} <Button variant="outline" onClick={() => { setResult(null); setAttempt(value => value + 1); }}>Retry</Button></> :
        <p>25-mile radius · {request ? `Overlap window: ${request.window} ${request.unit}` : "Within 365 days, or the same year for year-only dates"} · {analysis?.unknown_timing_pairs} nearby pairs have unknown timing.</p>}
    </div>

    <div className="dashboard-map-layout">
      <section className="map-comparison" aria-label="Compare schedule maps">
        <div className="map-view-switch" role="group" aria-label="Map view">
          <Button variant={view === "current" ? "secondary" : "outline"} aria-pressed={view === "current"} onClick={() => setView("current")}>Current plan</Button>
          <Button variant={proposed ? "secondary" : "outline"} aria-pressed={proposed} disabled={!proposal} onClick={() => setView("proposed")}>Proposed plan</Button>
        </div>
        <ProjectMap locations={displayedProjects} matchedIds={matchedIds} analysisReady={!!analysis}
          sourceLabel={`${proposed ? "Proposed" : "Current"} · ${source || "CSV project locations"}`} />

      </section>
      <section className="map-statistics-row" aria-label="Project overlap statistics">
        <Card className="metric-card panel">
          <div className="metric-top"><span>Locations in view</span></div>
          <strong>{displayedProjects.length}</strong><p>Records plotted on the map</p>
        </Card>
      <Card className="distribution-card panel"><div className="panel-heading"><h2>Matching projects</h2></div>
        <div className="nearby-projects">{!analysis ? <p>Waiting for backend results.</p> : pairs.length === 0 ? <p>No pairs meet both distance and timing criteria.</p> : pairs.slice(0, 20).map(pair => <div key={`${pair.a.record_id}/${pair.b.record_id}`}><strong>{pair.a.project_name}</strong><span>{pair.b.project_name}</span><small>{pair.miles.toFixed(2)} miles apart · {pair.timing}</small></div>)}</div>
        {pairs.length > 20 && <p className="metric-note">Showing the 20 closest of {pairs.length} pairs.</p>}
      </Card>
        <Card className="metric-card panel">
          <div className="metric-top"><span>Matching pairs</span></div>
          <strong>{analysis ? pairs.length : "—"}</strong>
          <p>{proposed ? "Remaining in proposed plan" : "In the current plan"}</p>
        </Card>
      </section>
        {proposal && <div className="proposal-summary">
          <h2>{proposal.resolved_pairs > 0 ? `${proposal.resolved_pairs} fewer matching pairs` : "No improvement found within these limits"}</h2>
          <p>{current?.analysis?.pairs.length} → {proposal.analysis.pairs.length} matching pairs · {proposal.moved_projects} projects shifted.</p>
          <p>Planning suggestion only. Other construction constraints have not been evaluated; this search does not guarantee the best schedule. Nothing has been saved or applied.</p>
          {proposal.changes.length > 0 && <details><summary>Review proposed changes ({proposal.changes.length} locations)</summary>
            <div className="backend-pairs-scroll"><table><thead><tr><th>Project</th><th>Current</th><th>Proposed</th></tr></thead>
              <tbody>{proposal.changes.map(change => <tr key={change.record_id}><td>{change.project_name}</td><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody>
            </table></div>
          </details>}
        </div>}

    </div>
  </>;
}
