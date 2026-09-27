import { SiteHeader } from "@/components/site-header";
import { PageHeading } from "@/components/workspace";
import { UploadSummaryView } from "@/components/upload-summary";
import { requireUser } from "@/lib/server/session";
import { parseIdList, summaryHref } from "@/lib/upload-summary";

export const metadata = { title: "Upload summary" };

type SearchParams = Promise<{ sessions?: string | string[]; uploads?: string | string[] }>;

export default async function SummaryPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // Durable upload ids win over session ids when both are present.
  const uploadIds = parseIdList(params.uploads, "UPL_");
  const sessionIds = uploadIds.length ? [] : parseIdList(params.sessions, "SES_");
  const requested = params.uploads !== undefined || params.sessions !== undefined;
  const invalid = requested && !uploadIds.length && !sessionIds.length;
  const user = await requireUser(
    uploadIds.length ? summaryHref("uploads", uploadIds) : sessionIds.length ? summaryHref("sessions", sessionIds) : "/summary",
  );
  const description = uploadIds.length
    ? "What we found in your upload, and where it sits next to known projects."
    : sessionIds.length
      ? "Your files are being processed. The summary opens here when they finish."
      : "Summaries of your recent uploads, generated automatically after processing.";
  return (
    <>
      <SiteHeader active="summary" user={user} />
      <main id="main-content" className="workspace">
        <PageHeading section="Summary" title="Upload summary" description={description} />
        <UploadSummaryView
          key={uploadIds.length ? `u:${uploadIds.join(",")}` : `s:${sessionIds.join(",")}`}
          uploadIds={uploadIds}
          sessionIds={sessionIds}
          invalid={invalid}
        />
      </main>
    </>
  );
}
