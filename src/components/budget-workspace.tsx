"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Sparkles } from "lucide-react";
import { BudgetSummaryPanel, PanelBody } from "@/components/budget-summary-panel";
import { FileUpload } from "@/components/file-upload";
import { ProjectMap } from "@/components/project-map";
import { RecentUploads } from "@/components/recent-uploads";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { budgetWorkspaceState, type UploadActivity } from "@/lib/plan-upload";
import { budgetHref, buildMapLayers, type UploadMap } from "@/lib/upload-summary";

export type BudgetWorkspaceProps = {
  /** Validated `?sessions=` ids: the uploader resumes polling them. */
  initialSessionIds: string[];
  /** Validated `?uploads=` ids (win over sessions): summaries shown straight away. */
  initialUploadIds: string[];
  /** Validated `?project=` record id for the reference map (empty state only). */
  focusedRecordId?: string;
  /** The URL asked for sessions/uploads but none of the ids were valid. */
  invalidLink?: boolean;
};

const EMPTY_IDS: readonly string[] = [];

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Keep the previous array when ids are unchanged so effects keyed on it stay
 * quiet. Seeded with what the uploader already knows (e.g. resumed sessions),
 * so a later report of [] is a real change.
 */
function useIdList(initial: readonly string[]): [string[], (ids: string[]) => void] {
  const [ids, setIds] = useState<string[]>(() => [...initial]);
  const update = useCallback((next: string[]) => setIds((prev) => (sameIds(prev, next) ? prev : [...next])), []);
  return [ids, update];
}

// Desktop (>800px): uploader, summary, recent stacked on the left; the map is
// a sticky right column spanning all rows. <=800px: one column in DOM order,
// uploader -> map -> summary -> recent.
// Class names are written out in full so Tailwind's scanner sees them.
const LAYOUT = {
  grid: "grid gap-6 min-[801px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] min-[801px]:grid-rows-[auto_auto_1fr] min-[801px]:items-start",
  uploader: "min-w-0 min-[801px]:col-start-1 min-[801px]:row-start-1",
  map: "min-w-0 min-[801px]:sticky min-[801px]:top-6 min-[801px]:col-start-2 min-[801px]:row-[1/span_3] min-[801px]:max-h-[calc(100dvh-3rem)] min-[801px]:overflow-y-auto min-[801px]:overscroll-contain",
  summary: "grid min-w-0 gap-6 min-[801px]:col-start-1 min-[801px]:row-start-2",
  recent: "min-w-0 min-[801px]:col-start-1 min-[801px]:row-start-3",
} as const;

/**
 * The /budget workspace: uploader, one Gemini summary per successful upload,
 * recent uploads (when the URL names no ids), and a map zoomed to where the
 * uploads collide with reference projects.
 *
 * URL state is written with window.history.replaceState (never router.*), so
 * in-flight uploads are not remounted: `?sessions=` while rows are active,
 * then `?uploads=` (the ids from the URL plus new successes, at most 5) once
 * none is.
 * Reloading either URL resumes (sessions) or refetches (uploads).
 */
export function BudgetWorkspace({ initialSessionIds, initialUploadIds, focusedRecordId, invalidLink = false }: BudgetWorkspaceProps) {
  const [sessionIds, onSessionsChange] = useIdList(initialSessionIds);
  const [uploaderUploadIds, onUploadsChange] = useIdList(EMPTY_IDS);
  // Resumed sessions start as active rows; the uploader reports real counts on mount.
  const [activity, setActivity] = useState<UploadActivity>(() => ({ rows: initialSessionIds.length, active: initialSessionIds.length }));
  const onActivityChange = useCallback((next: UploadActivity) => {
    setActivity((prev) => (prev.rows === next.rows && prev.active === next.active ? prev : next));
  }, []);
  const [maps, setMaps] = useState<Record<string, UploadMap>>({});

  const { busy, waiting, uploadIds, url } = useMemo(
    () => budgetWorkspaceState({ activity, initialSessionIds, initialUploadIds, sessionIds, uploaderUploadIds }),
    [activity, initialSessionIds, initialUploadIds, sessionIds, uploaderUploadIds],
  );
  const href = url ? budgetHref(url.key, url.ids) : null;

  // Leave the URL alone (e.g. ?project=) until the uploader has had rows.
  const wasTouched = useRef(initialSessionIds.length > 0);
  const hasRows = activity.rows > 0;
  useEffect(() => {
    if (hasRows) wasTouched.current = true;
    const next = href ?? (wasTouched.current ? "/budget" : null); // "/budget": every row was cancelled or removed
    if (!next || `${window.location.pathname}${window.location.search}` === next) return;
    window.history.replaceState(null, "", next);
  }, [href, hasRows]);

  const onMap = useCallback((uploadId: string, map: UploadMap) => {
    setMaps((prev) => (prev[uploadId] === map ? prev : { ...prev, [uploadId]: map }));
  }, []);
  const layers = useMemo(() => {
    const payloads = uploadIds.flatMap((id) => (maps[id] ? [maps[id]] : []));
    return payloads.length ? buildMapLayers(payloads) : undefined;
  }, [maps, uploadIds]);

  return (
    <div className={LAYOUT.grid}>
      <section className={LAYOUT.uploader} aria-label="Upload construction plans">
        <FileUpload
          initialSessionIds={initialSessionIds}
          onSessionsChange={onSessionsChange}
          onUploadsChange={onUploadsChange}
          onActivityChange={onActivityChange}
        />
      </section>

      <div className={LAYOUT.map}>
        {/* One ProjectMap instance throughout: reference view until upload layers arrive. */}
        <ProjectMap
          layers={layers}
          focusedRecordId={layers ? undefined : focusedRecordId}
          // Never navigate while uploads are on the page: a route change remounts
          // the workspace and aborts in-flight uploads. Markers show popups instead.
          navigateToBudget={!busy && !focusedRecordId}
        />
      </div>

      <section className={LAYOUT.summary} aria-label="Upload summaries">
        {invalidLink && activity.rows === 0 && (
          <Alert variant="info">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>This link isn’t valid</AlertTitle>
            <AlertDescription>
              <p>Upload links come from this page after an upload. Upload a file above or open one of your recent uploads.</p>
            </AlertDescription>
          </Alert>
        )}
        {uploadIds.map((id, index) => (
          <BudgetSummaryPanel key={id} uploadId={id} index={index} total={uploadIds.length} onMap={onMap} />
        ))}
        {!uploadIds.length && (
          <Card className="panel min-w-0 overflow-hidden">
            <PanelBody className="flex items-start gap-3">
              <Sparkles size={20} className="mt-0.5 text-muted-foreground" aria-hidden="true" />
              <p className="min-w-0 text-sm">
                {waiting
                  ? "Your Gemini summary appears here as soon as each upload finishes processing."
                  : "Your Gemini summary appears here after your first upload."}
              </p>
            </PanelBody>
          </Card>
        )}
        {uploadIds.length > 0 && waiting && (
          <p className="text-sm text-muted-foreground">More summaries appear here as the remaining uploads finish.</p>
        )}
      </section>

      {/* Hidden while the page holds uploads: its links would navigate away and abort them. */}
      {!busy && (
        <section className={LAYOUT.recent} aria-label="Recent uploads">
          <RecentUploads />
        </section>
      )}
    </div>
  );
}
