import { SiteHeader } from "@/components/site-header";
import { WorkspaceFooter } from "@/components/workspace";
import { DashboardWorkspace } from "@/components/dashboard-workspace";
import { requireUser } from "@/lib/server/session";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser("/dashboard");
  return <>
    <SiteHeader active="dashboard" user={user} />
    <main id="main-content" className="workspace">
      <h1 className="sr-only">Dashboard</h1>
      <DashboardWorkspace />
      <WorkspaceFooter />
    </main>
  </>;
}