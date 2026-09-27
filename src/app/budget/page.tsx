import { SiteHeader } from "@/components/site-header";
import { PageHeading } from "@/components/workspace";
import { BudgetWorkspace } from "@/components/budget-workspace";
import { requireUser } from "@/lib/server/session";
import { budgetHref, parseIdList } from "@/lib/upload-summary";
import points from "@/data/project-locations.json";

export const metadata = { title: "Budget" };

type SearchParams = Promise<{
  project?: string | string[];
  sessions?: string | string[];
  uploads?: string | string[];
}>;

export default async function BudgetPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // Durable upload ids win over session ids when both are present.
  const uploadIds = parseIdList(params.uploads, "UPL_");
  const sessionIds = uploadIds.length ? [] : parseIdList(params.sessions, "SES_");
  const requested = params.uploads !== undefined || params.sessions !== undefined;
  const invalidLink = requested && !uploadIds.length && !sessionIds.length;
  const project = typeof params.project === "string" ? points.find((p) => p.record_id === params.project) : undefined;
  const user = await requireUser(
    uploadIds.length
      ? budgetHref("uploads", uploadIds)
      : sessionIds.length
        ? budgetHref("sessions", sessionIds)
        : project
          ? `/budget?project=${encodeURIComponent(project.record_id)}`
          : "/budget",
  );
  const description = uploadIds.length
    ? "What we found in your upload, and where it collides with known projects."
    : sessionIds.length
      ? "Your files are being processed. Summaries appear here as each one finishes."
      : project
        ? `Upload construction plans to see where they collide with ${project.project_name} and other known projects.`
        : "Upload construction plans to see where they collide with known projects, with a Gemini summary of what we found.";
  return (
    <>
      <SiteHeader active="budget" user={user} />
      <main id="main-content" className="workspace">
        <PageHeading section="Budget" title="Plan with the full picture." description={description} />
        {/* Not keyed by ids: URL updates must never remount in-flight uploads. */}
        <BudgetWorkspace
          initialSessionIds={sessionIds}
          initialUploadIds={uploadIds}
          focusedRecordId={project?.record_id}
          invalidLink={invalidLink}
        />
      </main>
    </>
  );
}
