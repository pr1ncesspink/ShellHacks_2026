import {
  LockKeyhole,
} from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import {
  MapPlaceholder,
  PageHeading,
  WorkspaceFooter,
} from "@/components/workspace";
import { requireUser } from "@/lib/server/session";
import { BudgetConversation } from "@/components/budget-conversation";
import { ProjectMap } from "@/components/project-map";
import points from "@/data/project-locations.json";
import "@/components/budget-planner.css";

export const metadata = { title: "Budget Summary" };
export default async function BudgetPage({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const params = await searchParams;
  const project = typeof params.project === "string" ? points.find(p => p.record_id === params.project) : undefined;
  const user = await requireUser(project ? `/budget?project=${encodeURIComponent(project.record_id)}` : "/budget");
  return (
    <>
      <SiteHeader active="budget" user={user} />
      <main id="main-content" className="workspace">
        <PageHeading budget />
        <div className="budget-grid">
          <section
            className="budget-column"
            aria-label="Budget planning and responses"
          >
            <BudgetConversation key={project?.record_id ?? "all"} projectId={project?.record_id} />
          </section>
          <div className="budget-map-frame">
            {project ? <ProjectMap focusedRecordId={project.record_id} navigateToBudget={false} /> : <MapPlaceholder budget />}
          </div>
        </div>
        <p className="budget-disclaimer">
          <LockKeyhole size={14} aria-hidden="true" />
          AI responses are planning suggestions. Verify project constraints and cost inputs before making decisions.
        </p>
        <WorkspaceFooter />
      </main>
    </>
  );
}
