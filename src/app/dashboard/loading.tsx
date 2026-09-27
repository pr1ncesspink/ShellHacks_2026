import { SiteHeader } from "@/components/site-header";
import { PageHeading } from "@/components/workspace";
export default function Loading() {
  return (
    <>
      <SiteHeader active="dashboard" />
      <main id="main-content" className="workspace">
        <PageHeading />
        <div className="loading-panel" role="status">
          Loading project insights…
        </div>
      </main>
    </>
  );
}
