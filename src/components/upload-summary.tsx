"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, Clock, FileSearch, RotateCw, Sparkles } from "lucide-react";
import { ProjectMap } from "@/components/project-map";
import { UploadStepper } from "@/components/upload-stepper";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { uploadFailureMessage, uploadStepAnnouncement, type UploadProgress } from "@/lib/upload-progress";
import { isUploadCancelled, pollUploadSession } from "@/lib/upload-sessions";
import {
  UPLOADS_API_PATH,
  buildMapLayers,
  parseRecentUploads,
  parseUploadMap,
  parseUploadSummary,
  summaryHref,
  uploadApiPath,
  type RecentUpload,
  type UploadMap,
  type UploadSummary,
} from "@/lib/upload-summary";

const SUMMARY_POLL_MS = 5_000;
const SUMMARY_WAIT_MS = 10 * 60 * 1000;
const MAX_TRANSIENT_FAILURES = 3;
const SUMMARIZING: UploadProgress = { phase: "processing", stage: "summarizing" };

// ---- fetch helpers -----------------------------------------------------------

class HttpError extends Error {
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

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
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

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

// ---- shared pieces -----------------------------------------------------------

function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="panel items-start gap-3 p-6">
      <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="grid gap-4 text-sm text-muted-foreground">{children}</div>
    </Card>
  );
}

function LinkButton({ href, children, variant = "outline" }: { href: string; children: ReactNode; variant?: "default" | "outline" }) {
  return (
    <Button asChild variant={variant} size="touch">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

function StatusBadge({ status }: { status: UploadSummary["status"] | null }) {
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
    <dl className="flex flex-wrap gap-x-8 gap-y-3">
      {entries.map(([key, value]) => (
        <div key={key} className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">{COUNT_LABELS[key] ?? key.replaceAll("_", " ")}</dt>
          <dd className="text-xl font-semibold tabular-nums">{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

// ---- summary content ---------------------------------------------------------

function SummaryContent({ summary }: { summary: UploadSummary }) {
  const gaps = summary.data_gaps;
  const hasGaps = gaps.unresolved_locations > 0 || gaps.missing_dates > 0 || gaps.truncated;
  return (
    <div className="grid gap-5">
      <Counts counts={summary.counts} />
      {summary.overview && <p className="max-w-prose text-sm leading-relaxed whitespace-pre-line">{summary.overview}</p>}
      {summary.key_projects.length > 0 && (
        <Section title="Key projects">
          <ul className="grid gap-2 text-sm">
            {summary.key_projects.map((p) => (
              <li key={p.project_id}>
                <span className="font-medium">{p.name}</span>
                {p.why && <span className="text-muted-foreground"> — {p.why}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.hotspots.length > 0 && (
        <Section title="Hotspots">
          <ul className="grid gap-2 text-sm">
            {summary.hotspots.map((h) => (
              <li key={h.overlap_ids.join(",")}>
                <span className="font-medium">{h.label}</span>
                {h.nearest_mi !== null && <span className="text-muted-foreground"> — nearest {h.nearest_mi.toFixed(1)} mi apart</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.timing_notes.length > 0 && (
        <Section title="Timing notes">
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {summary.timing_notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </Section>
      )}
      {hasGaps && (
        <Alert>
          <FileSearch aria-hidden="true" />
          <AlertTitle>Data gaps</AlertTitle>
          <AlertDescription>
            <ul className="grid list-disc gap-1 pl-5">
              {gaps.unresolved_locations > 0 && <li>{gaps.unresolved_locations.toLocaleString()} locations could not be placed on the map.</li>}
              {gaps.missing_dates > 0 && <li>{gaps.missing_dates.toLocaleString()} projects have no in-service date.</li>}
              {gaps.truncated && <li>The upload was large, so the summary covers a sample of its projects.</li>}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---- one upload: summary (polled while pending), then map ------------------

type UploadState =
  | { status: "loading" }
  | { status: "pending"; summary: UploadSummary | null }
  | { status: "timeout" }
  | { status: "error"; message: string }
  | { status: "ready"; summary: UploadSummary; mapError: string | null };

function useUploadResult(uploadId: string, onMap: (uploadId: string, map: UploadMap) => void) {
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

function UploadResultCard({ uploadId, index, total, onMap }: {
  uploadId: string;
  index: number;
  total: number;
  onMap: (uploadId: string, map: UploadMap) => void;
}) {
  const { state, retry } = useUploadResult(uploadId, onMap);
  const summary = state.status === "ready" ? state.summary : null;
  const fallbackTitle = total > 1 ? `Upload ${index + 1} of ${total}` : "Your upload";
  const created = formatDate(summary?.created_at ?? null);
  return (
    <Card className="panel gap-5 p-6" aria-busy={state.status === "loading" || state.status === "pending"}>
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={summary?.status ?? (state.status === "pending" ? "pending" : null)} />
          {created && <span className="text-xs text-muted-foreground">{created}</span>}
        </div>
        <h2 className="text-xl font-semibold">{summary?.headline || fallbackTitle}</h2>
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
            <p>{state.message}</p>
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
            <p>{state.mapError}</p>
            <Button variant="outline" size="touch" onClick={retry}><RotateCw aria-hidden="true" />Try again</Button>
          </AlertDescription>
        </Alert>
      )}
    </Card>
  );
}

function UploadResults({ uploadIds }: { uploadIds: string[] }) {
  const [maps, setMaps] = useState<Record<string, UploadMap>>({});
  const onMap = useCallback((uploadId: string, map: UploadMap) => {
    setMaps((prev) => ({ ...prev, [uploadId]: map }));
  }, []);
  const layers = useMemo(() => {
    const payloads = uploadIds.flatMap((id) => (maps[id] ? [maps[id]] : []));
    return payloads.length ? buildMapLayers(payloads) : null;
  }, [maps, uploadIds]);
  return (
    <div className="grid gap-6">
      {uploadIds.map((id, index) => (
        <UploadResultCard key={id} uploadId={id} index={index} total={uploadIds.length} onMap={onMap} />
      ))}
      {layers
        ? <ProjectMap layers={layers} />
        : <p className="text-sm text-muted-foreground">The map appears here once a summary is ready.</p>}
    </div>
  );
}

// ---- sessions: pipeline progress, then durable upload link ---------------

type SessionRow = { progress: UploadProgress; uploadId: string | null; settled: boolean };

function SessionProgressList({ sessionIds }: { sessionIds: string[] }) {
  const router = useRouter();
  const idsKey = sessionIds.join(",");
  const [rows, setRows] = useState<Record<string, SessionRow>>(() =>
    Object.fromEntries(sessionIds.map((id) => [id, { progress: { phase: "queued" }, uploadId: null, settled: false }])));
  useEffect(() => {
    const ids = idsKey.split(",");
    const controller = new AbortController();
    const update = (id: string, patch: Partial<SessionRow>) =>
      setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    Promise.all(ids.map(async (id) => {
      try {
        const result = await pollUploadSession(id, { signal: controller.signal, onProgress: (progress) => update(id, { progress }) });
        const uploadId = result.status === "succeeded" ? result.upload_id : null;
        update(id, { uploadId, settled: true });
        return uploadId;
      } catch (reason) {
        if (isUploadCancelled(reason, controller.signal)) throw reason;
        // Failure progress was already emitted; the stepper shows the copy.
        update(id, { settled: true });
        return null;
      }
    })).then((uploadIds) => {
      if (controller.signal.aborted) return;
      const done = uploadIds.filter((id): id is string => id !== null);
      if (done.length === ids.length) router.replace(summaryHref("uploads", done));
    }).catch(() => { /* navigation or unmount aborted polling */ });
    return () => controller.abort();
  }, [idsKey, router]);

  const all = sessionIds.map((id) => rows[id]);
  const settled = all.every((row) => row?.settled);
  const completed = all.flatMap((row) => (row?.uploadId ? [row.uploadId] : []));
  // 401/403/404 while polling: expired session or another account's link.
  const notFound = all.some((row) => row?.progress.errorCode === "session_not_found");
  return (
    <div className="grid gap-6">
      {sessionIds.map((id, index) => {
        const row = rows[id];
        const name = sessionIds.length > 1 ? `Upload ${index + 1} of ${sessionIds.length}` : "Your upload";
        return (
          <Card key={id} className="panel gap-4 p-6">
            <h2 className="text-lg font-semibold">{name}</h2>
            <p className="sr-only" aria-live="polite">{`${name}: ${uploadStepAnnouncement(row.progress)}`}</p>
            <UploadStepper progress={row.progress} label={`Steps for ${name.toLowerCase()}`} />
          </Card>
        );
      })}
      {settled && completed.length < sessionIds.length && (
        <Alert variant={completed.length ? "info" : "destructive"}>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {completed.length ? "Some uploads didn’t finish" : notFound ? "Upload not found" : "These uploads didn’t finish"}
          </AlertTitle>
          <AlertDescription>
            <p>
              {completed.length
                ? "You can still view the summary for the uploads that finished."
                : notFound
                  ? uploadFailureMessage("session_not_found")
                  : "Check the steps above for what went wrong, then try the upload again from the dashboard."}
            </p>
            <div className="flex flex-wrap gap-2">
              {completed.length > 0 && <LinkButton href={summaryHref("uploads", completed)} variant="default">View summary</LinkButton>}
              <LinkButton href="/dashboard" variant={completed.length ? "outline" : "default"}>Back to dashboard</LinkButton>
              {notFound && !completed.length && <LinkButton href="/summary">View recent uploads</LinkButton>}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---- no params: recent uploads -------------------------------------------

type RecentState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; uploads: RecentUpload[] };

function RecentUploadList() {
  const [state, setState] = useState<RecentState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getJson(UPLOADS_API_PATH, controller.signal)
      .then((body) => { if (!controller.signal.aborted) setState({ status: "ready", uploads: parseRecentUploads(body).uploads }); })
      .catch((reason) => { if (!controller.signal.aborted) setState({ status: "error", message: reason instanceof HttpError ? reason.message : "We couldn’t load your uploads. Try again." }); });
    return () => controller.abort();
  }, [attempt]);

  if (state.status === "loading") return <p role="status" className="text-sm text-muted-foreground">Loading your recent uploads…</p>;
  if (state.status === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Uploads unavailable</AlertTitle>
        <AlertDescription>
          <p>{state.message}</p>
          <Button variant="outline" size="touch" onClick={() => { setState({ status: "loading" }); setAttempt((n) => n + 1); }}>
            <RotateCw aria-hidden="true" />Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!state.uploads.length) {
    return (
      <EmptyState icon={<FileSearch size={20} />} title="No uploads yet">
        <p>Upload a PDF or CSV of construction plans on the dashboard. A summary appears here when processing finishes.</p>
        <div><LinkButton href="/dashboard" variant="default">Go to dashboard</LinkButton></div>
      </EmptyState>
    );
  }
  return (
    <Card className="panel gap-0 p-0">
      <h2 className="px-6 pt-5 pb-3 text-lg font-semibold">Recent uploads</h2>
      <ul>
        {state.uploads.map((upload, index) => {
          const created = formatDate(upload.created_at);
          const projects = upload.counts.projects;
          return (
            <li key={upload.upload_id}>
              {index > 0 && <Separator />}
              <Link
                href={summaryHref("uploads", [upload.upload_id])}
                className="grid min-h-11 gap-1 px-6 py-4 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="font-medium text-primary-text">{upload.headline || (created ? `Upload from ${created}` : "Untitled upload")}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge status={upload.status} />
                  {created && <span>{created}</span>}
                  {projects !== undefined && <span>{projects.toLocaleString()} {projects === 1 ? "project" : "projects"}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---- entry ---------------------------------------------------------------

export function UploadSummaryView({ uploadIds, sessionIds, invalid }: {
  uploadIds: string[];
  sessionIds: string[];
  invalid: boolean;
}) {
  if (invalid) {
    return (
      <EmptyState icon={<FileSearch size={20} />} title="This summary link isn’t valid">
        <p>Summary links come from the dashboard after an upload finishes. Open one of your recent uploads instead.</p>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/summary" variant="default">View recent uploads</LinkButton>
          <LinkButton href="/dashboard">Go to dashboard</LinkButton>
        </div>
      </EmptyState>
    );
  }
  if (uploadIds.length) return <UploadResults uploadIds={uploadIds} />;
  if (sessionIds.length) return <SessionProgressList sessionIds={sessionIds} />;
  return <RecentUploadList />;
}
