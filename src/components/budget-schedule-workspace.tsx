"use client";
import { useEffect, useState } from "react";
import baseline from "@/data/project-locations.json";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { type MapProject } from "@/lib/project-data";

type Preferences = { unit: "years" | "days"; window: number; earlier: number; later: number };
type Analysis = { pairs: { a_id: string; b_id: string; miles: number; timing: string }[]; unknown_timing_pairs: number };
export type Plan = Analysis & {
  preferences?: Preferences;
  proposal?: {
    projects: MapProject[]; analysis: Analysis;
    changes: { record_id: string; project_name: string; before: string; after: string; shift: number }[];
    moved_projects: number; resolved_pairs: number; method: string;
  };
};

const projects: MapProject[] = baseline;

export function BudgetScheduleWorkspace() {
  const [result, setResult] = useState<{ request: Preferences | null; analysis?: Plan; error?: string } | null>(null);
  const [preferences, setPreferences] = useState<Preferences>({ unit: "years", window: 0, earlier: 1, later: 1 });
  const [request, setRequest] = useState<Preferences | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/map-analysis", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ projects, ...(request ? { preferences: request } : {}) }),
    }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Map analysis failed");
      if (!controller.signal.aborted) setResult({ request, analysis: payload });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ request, error: error instanceof Error ? error.message : "Map analysis failed" });
    });
    return () => controller.abort();
  }, [request, attempt]);
  const current = result?.request === request ? result : null;
  return <div className="budget-schedule-workspace">
    <Card className="schedule-planner">
      <h2>Explore a schedule change</h2>
      <p>Choose what counts as a timing overlap and how far each project may move. Locations stay fixed.</p>
      <form onSubmit={event => {
        event.preventDefault(); setRequest({ ...preferences }); setResult(null);
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
        <Button type="submit" size="touch" disabled={!current}>Generate proposal</Button>
      </form>
      <p>{preferences.unit === "years"
        ? "Year-based comparisons use published calendar years. For example, 0 matches projects in the same year; 1 also includes adjacent years."
        : "Year-only and unrecognized dates cannot be assessed in day mode; those projects remain unchanged."}</p>
    </Card>

    <div role="status" aria-live="polite" className="schedule-status">
      {!current ? "Analyzing map locations with the backend…" : current.error ? <>
        {current.error}{" "}
        <Button variant="outline" size="sm" onClick={() => { setResult(null); setAttempt(value => value + 1); }}>Retry</Button>
      </> : null}
    </div>

    {current?.analysis?.proposal && <Card className="schedule-planner" aria-label="Schedule proposal">
      <ScheduleProposalSummary plan={current.analysis} />
    </Card>}
  </div>;
}

export function ScheduleProposalSummary({ plan }: { plan: Plan }) {
  const proposal = plan.proposal;
  if (!proposal) return null;
  return <div className="proposal-summary">
    <h2>{proposal.resolved_pairs > 0 ? `${proposal.resolved_pairs} fewer matching pairs` : "No improvement found within these limits"}</h2>
    <p>{plan.pairs.length} → {proposal.analysis.pairs.length} matching pairs · {proposal.moved_projects} projects shifted.</p>
    <p>Planning suggestion only. Other construction constraints have not been evaluated; this search does not guarantee the best schedule. Nothing has been saved or applied.</p>
    {proposal.changes.length > 0 && <details><summary>Review proposed changes ({proposal.changes.length} locations)</summary>
      <div className="backend-pairs-scroll"><table><thead><tr><th scope="col">Project</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead>
        <tbody>{proposal.changes.map(change => <tr key={change.record_id}><td>{change.project_name}</td><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody>
      </table></div>
    </details>}
  </div>;
}
