"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CircleAlert, RotateCw } from "lucide-react";
import { HttpError, PanelBody, SummaryStatusBadge, WRAP, formatDate, getJson } from "@/components/budget-summary-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { UPLOADS_API_PATH, budgetHref, parseRecentUploads, type RecentUpload } from "@/lib/upload-summary";

type RecentState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; uploads: RecentUpload[] };

/**
 * The signed-in user's recent uploads, newest first; each opens
 * /budget?uploads=<id>. Renders nothing when there are none (the workspace's
 * empty-state card already explains what to do).
 */
export function RecentUploads() {
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
          <p className={WRAP}>{state.message}</p>
          <Button variant="outline" size="touch" onClick={() => { setState({ status: "loading" }); setAttempt((n) => n + 1); }}>
            <RotateCw aria-hidden="true" />Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!state.uploads.length) return null;
  return (
    <Card className="panel min-w-0 overflow-hidden">
      <PanelBody className="gap-0 px-0 pb-2 sm:px-0 sm:pb-2">
        <h2 className="px-5 pb-3 text-lg font-semibold sm:px-6">Recent uploads</h2>
        <ul className="min-w-0">
          {state.uploads.map((upload, index) => {
            const created = formatDate(upload.created_at);
            const projects = upload.counts.projects;
            return (
              <li key={upload.upload_id}>
                {index > 0 && <Separator />}
                <Link
                  href={budgetHref("uploads", [upload.upload_id])}
                  className="grid min-h-11 min-w-0 gap-1.5 px-5 py-4 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:px-6"
                >
                  <span className={`font-medium leading-snug text-primary-text ${WRAP}`}>
                    {upload.headline || (created ? `Upload from ${created}` : "Untitled upload")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                    <SummaryStatusBadge status={upload.status} />
                    {created && <time dateTime={upload.created_at ?? undefined} className={WRAP}>{created}</time>}
                    {projects !== undefined && <span>{projects.toLocaleString()} {projects === 1 ? "project" : "projects"}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </PanelBody>
    </Card>
  );
}
