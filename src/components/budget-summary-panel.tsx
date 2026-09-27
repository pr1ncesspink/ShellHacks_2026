"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CircleAlert, Clock, FileSearch, RotateCw, Sparkles } from "lucide-react";
import { UploadStepper } from "@/components/upload-stepper";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { UploadProgress } from "@/lib/upload-progress";
import { cn } from "@/lib/utils";
import {
  parseUploadMap,
  parseUploadSummary,
  uploadApiPath,
  type UploadMap,
  type UploadSummary,
} from "@/lib/upload-summary";

const SUMMARY_POLL_MS = 5_000;
const SUMMARY_WAIT_MS = 10 * 60 * 1000;
const MAX_TRANSIENT_FAILURES = 3;
const SUMMARIZING: UploadProgress = { phase: "processing", stage: "summarizing" };

// ---- fetch helpers (shared with recent-uploads) ------------------------------

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function errorMessage(status: number, body: unknown): string {
  if (status === 401) return "Your session has expired. Sign in again to view summaries.";
  if (status === 404) return "We couldn’t find this upload for your account.";
  if (status === 422) return "This upload link isn’t valid.";
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.length <= 200 ? error : "The summary service is unavailable. Try again shortly.";
}

export async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new HttpError(response.status, errorMessage(response.status, body));
  return body;
}

const transient = (reason: unknown) => !(reason instanceof HttpError) || reason.status >= 500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const describeError = (reason: unknown) =>
  reason instanceof HttpError ? reason.message : "Something went wrong loading this summary. Try again.";

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

// ---- shared pieces -------------------------------------------------------------

/** Text that must wrap inside its box however long the unbroken run (ids, "A/B 115kV"). */
export const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";

/**
 * `.panel` (globals.css, unlayered) zeroes padding and gap on the Card, which
 * beats Tailwind utilities; so padding and rhythm live on this inner body.
 */
export function PanelBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={cn("@container grid min-w-0 gap-5 p-5 sm:p-6", className)}>{children}</div>;
}

export function SummaryStatusBadge({ status }: { status: UploadSummary["status"] | null }) {
  if (status === "rule_only") return <Badge variant="warning">Basic summary — AI unavailable</Badge>;
  if (status === "model") return <Badge variant="info"><Sparkles aria-hidden="true" />AI summary</Badge>;
  if (status === "pending") return <Badge variant="outline"><Clock aria-hidden="true" />Generating</Badge>;
  return null;
}

const COUNT_LABELS: Record<string, string> = {
  projects: "Projects",
  points: "Locations",
  located_points: "Located",
  collisions: "Nearby pairs",
};

function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-2 gap-3 @md:grid-cols-4">
      {entries.map(([key, value]) => (
        <div key={key} className="grid min-w-0 content-start gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <dt className={`text-xs text-muted-foreground ${WRAP}`}>{COUNT_LABELS[key] ?? key.replaceAll("_", " ")}</dt>
          <dd className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function SummaryContent({ summary }: { summary: UploadSummary }) {
  const gaps = summary.data_gaps;
  const hasGaps = gaps.unresolved_locations > 0 || gaps.missing_dates > 0 || gaps.truncated;
  return (
    <div className="grid min-w-0 gap-5">
      <Counts counts={summary.counts} />
      {summary.overview && <p className={`max-w-prose text-sm leading-relaxed whitespace-pre-line text-foreground ${WRAP}`}>{summary.overview}</p>}
      {summary.key_projects.length > 0 && (
        <Section title="Key projects">
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
            {summary.key_projects.map((p) => (
              <li key={p.project_id} className={WRAP}>
                <span className="font-medium">{p.name}</span>
                {p.why && <span className="text-muted-foreground"> — {p.why}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.hotspots.length > 0 && (
        <Section title="Hotspots">
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
            {summary.hotspots.map((h) => (
              <li key={h.overlap_ids.join(",")} className={WRAP}>
                <span className="font-medium">{h.label}</span>
                {h.nearest_mi !== null && <span className="text-muted-foreground"> — nearest {h.nearest_mi.toFixed(1)} mi apart</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.timing_notes.length > 0 && (
        <Section title="Timing notes">
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
            {summary.timing_notes.map((note) => <li key={note} className={WRAP}>{note}</li>)}
          </ul>
        </Section>
      )}
      {hasGaps && (
        <Alert>
          <FileSearch aria-hidden="true" />
          <AlertTitle>Data gaps</AlertTitle>
          <AlertDescription>
            <ul className={`list-disc space-y-2 pl-5 leading-relaxed ${WRAP}`}>
              {gaps.unresolved_locations > 0 && <li>{gaps.unresolved_locations.toLocaleString()} {gaps.unresolved_locations === 1 ? "location" : "locations"} could not be placed on the map.</li>}
              {gaps.missing_dates > 0 && <li>{gaps.missing_dates.toLocaleString()} {gaps.missing_dates === 1 ? "project has" : "projects have"} no in-service date.</li>}
              {gaps.truncated && <li>The upload was large, so the summary covers a sample of its projects.</li>}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---- one upload: summary (polled while pending), then map ---------------------

type UploadState =
  | { status: "loading" }
  | { status: "pending"; summary: UploadSummary | null }
  | { status: "timeout" }
  | { status: "error"; message: string }
  | { status: "ready"; summary: UploadSummary; mapError: string | null };

export type OnUploadMap = (uploadId: string, map: UploadMap) => void;

function useUploadResult(uploadId: string, onMap: OnUploadMap) {
  const [state, setState] = useState<UploadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const summaryPath = uploadApiPath(uploadId, "summary");
    const mapPath = uploadApiPath(uploadId, "map");
    if (!summaryPath || !mapPath) return;
    (async () => {
      const deadline = Date.now() + SUMMARY_WAIT_MS;
      let failures = 0;
      let summary: UploadSummary;
      for (;;) {
        try {
          summary = parseUploadSummary(await getJson(summaryPath, signal));
          failures = 0;
        } catch (reason) {
          if (signal.aborted) return;
          if (!transient(reason) || ++failures > MAX_TRANSIENT_FAILURES) throw reason;
          await sleep(SUMMARY_POLL_MS, signal);
          continue;
        }
        if (summary.status !== "pending") break;
        setState({ status: "pending", summary });
        if (Date.now() >= deadline) { setState({ status: "timeout" }); return; }
        await sleep(SUMMARY_POLL_MS, signal);
      }
      setState({ status: "ready", summary, mapError: null });
      // The map payload exists only once the summary row does.
      try {
        const map = parseUploadMap(await getJson(mapPath, signal));
        if (!signal.aborted) onMap(uploadId, map);
      } catch (reason) {
        if (!signal.aborted) setState({ status: "ready", summary, mapError: describeError(reason) });
      }
    })().catch((reason) => {
      if (!signal.aborted) setState({ status: "error", message: describeError(reason) });
    });
    return () => controller.abort();
  }, [uploadId, attempt, onMap]);
  const retry = useCallback(() => { setState({ status: "loading" }); setAttempt((n) => n + 1); }, []);
  return { state, retry };
}

/**
 * Gemini (or rule-based) summary for one successful upload. Polls every 5 s
 * while the summary is pending (gives up after 10 min), then fetches the map
 * payload and hands it to `onMap` so the workspace can combine map layers.
 * `onMap` must be stable (useCallback) or the fetch restarts.
 */
export function BudgetSummaryPanel({ uploadId, index, total, onMap }: {
  uploadId: string;
  index: number;
  total: number;
  onMap: OnUploadMap;
}) {
  const { state, retry } = useUploadResult(uploadId, onMap);
  const summary = state.status === "ready" ? state.summary : null;
  const fallbackTitle = total > 1 ? `Upload ${index + 1} of ${total}` : "Your upload";
  const created = formatDate(summary?.created_at ?? null);
  return (
    <Card className="panel min-w-0 overflow-hidden" aria-busy={state.status === "loading" || state.status === "pending"}>
      <PanelBody>
        <header className="grid min-w-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <span className="eyebrow">Gemini summary</span>
            <SummaryStatusBadge status={summary?.status ?? (state.status === "pending" ? "pending" : null)} />
            {created && <time dateTime={summary?.created_at ?? undefined} className={`text-xs text-muted-foreground ${WRAP}`}>{created}</time>}
          </div>
          <h2 className={`text-xl leading-snug font-semibold ${WRAP}`}>{summary?.headline || fallbackTitle}</h2>
        </header>
        {state.status === "loading" && <p role="status" className="text-sm text-muted-foreground">Loading summary…</p>}
        {state.status === "pending" && (
          <div className="grid gap-3">
            <p role="status" className="text-sm text-muted-foreground">Generating summary…</p>
            <UploadStepper progress={SUMMARIZING} label={`Steps for ${fallbackTitle.toLowerCase()}`} />
          </div>
        )}
        {state.status === "timeout" && (
          <Alert variant="info">
            <Clock aria-hidden="true" />
            <AlertTitle>The summary is taking longer than expected</AlertTitle>
            <AlertDescription>
              <p>Your projects are saved. Check again in a few minutes.</p>
              <Button variant="outline" size="touch" onClick={retry}><RotateCw aria-hidden="true" />Check again</Button>
            </AlertDescription>
          </Alert>
        )}
        {state.status === "error" && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Summary unavailable</AlertTitle>
            <AlertDescription>
              <p className={WRAP}>{state.message}</p>
              <Button variant="outline" size="touch" onClick={retry}><RotateCw aria-hidden="true" />Try again</Button>
            </AlertDescription>
          </Alert>
        )}
        {summary && <SummaryContent summary={summary} />}
        {state.status === "ready" && state.mapError && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Map data unavailable</AlertTitle>
            <AlertDescription>
              <p className={WRAP}>{state.mapError}</p>
              <Button variant="outline" size="touch" onClick={retry}><RotateCw aria-hidden="true" />Try again</Button>
            </AlertDescription>
          </Alert>
        )}
      </PanelBody>
    </Card>
  );
}
