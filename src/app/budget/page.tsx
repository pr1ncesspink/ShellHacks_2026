import { SiteHeader } from "@/components/site-header";
import { PageHeading } from "@/components/workspace";
import { BudgetScheduleWorkspace } from "@/components/budget-schedule-workspace";
import { ProjectMap } from "@/components/project-map";
import { requireUser } from "@/lib/server/session";
import points from "@/data/project-locations.json";
import "@/components/budget-planner.css";

export const metadata = { title: "Budget" };

export default async function BudgetPage({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const params = await searchParams;
  const project = typeof params.project === "string" ? points.find(p => p.record_id === params.project) : undefined;
  const user = await requireUser(project ? `/budget?project=${encodeURIComponent(project.record_id)}` : "/budget");
  return (
    <>
      <SiteHeader active="budget" user={user} />
      <main id="main-content" className="workspace">
        <PageHeading
          section="Budget"
          title="Plan with the full picture."
          description={project
            ? `Schedule options with ${project.project_name} highlighted on the map.`
            : "Explore schedule changes across reference projects. Select a point on the map to focus on one project."}
        />
        <div className="budget-grid">
          <section className="budget-column" aria-label="Schedule planning">
            <BudgetScheduleWorkspace />
          </section>
          <div className="budget-map-frame">
            <ProjectMap focusedRecordId={project?.record_id} navigateToBudget={!project} />
          </div>
        </div>
      </main>
    </>
  );
}
