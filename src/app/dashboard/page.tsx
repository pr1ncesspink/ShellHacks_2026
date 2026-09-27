import {
  ArrowUpRight,
  Info,
} from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import {
  PageHeading,
  WorkspaceFooter,
} from "@/components/workspace";
import { FileUpload } from "@/components/file-upload";
import { ProjectMap } from "@/components/project-map";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getDashboardData } from "@/lib/backend";
import { summarize } from "@/lib/overlaps";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const data = await getDashboardData();
  const stats = summarize(data.rows);
  const failed = data.mode === "error";
  const metrics = [
    {
      label: "Projects in view",
      value: stats.projects,
      caption: "Unique projects in overlap pairs",
    },
    {
      label: "Overlap pairs",
      value: stats.pairs,
      caption: "Candidate connections to explore",
    },
  ];
  return (
    <>
      <SiteHeader active="dashboard" />
      <main id="main-content" className="workspace">
        <PageHeading />
        <section className="upload-section upload-section-first" aria-label="Construction plans">
          <FileUpload />
        </section>
        <div className={`data-banner ${failed ? "error-banner" : ""}`}>
          <span>
            <Info size={15} aria-hidden="true" />
            {data.mode === "example"
              ? "Overlap statistics use example data. The map shows locations from your project CSV."
              : failed
                ? "We couldn’t load project data. Check your backend connection and try again."
                : "Live project data from your connected backend."}
          </span>
          {failed ? (
            <a href="/dashboard" className="retry-link">
              Try again <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          ) : (
            <Badge
              variant="outline"
              className={
                data.mode === "example" ? "example-badge" : "live-badge"
              }
            >
              <span className="tiny-dot" />
              {data.mode === "example" ? "EXAMPLE DATA" : "LIVE DATA"}
            </Badge>
          )}
        </div>
        <div className="dashboard-grid">
          <section
            aria-label="Project overlap statistics"
            className="stats-column"
          >
            <div className="metrics-grid">
              {metrics.map(({ label, value, caption }) => (
                <Card key={label} className="metric-card panel">
                  <div className="metric-top">
                    <span>{label}</span>
                  </div>
                  <strong>{failed ? "—" : value}</strong>
                  <p>{caption}</p>
                </Card>
              ))}
            </div>
            <Card className="distribution-card panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">CONNECTION STRENGTH</span>
                  <h2>Similarity at a glance</h2>
                </div>
              </div>
              <div className="band-list">
                {[
                  {
                    label: "High similarity",
                    range: "0.75 – 1.00",
                    tone: "blue",
                  },
                  {
                    label: "Moderate similarity",
                    range: "0.50 – < 0.75",
                    tone: "teal",
                  },
                  {
                    label: "Lower similarity",
                    range: "−1.00 – < 0.50",
                    tone: "violet",
                  },
                ].map((band, i) => (
                  <div className="band" key={band.label}>
                    <div className="band-label">
                      <span>
                        <i className={`legend-dot bg-${band.tone}`} />
                        {band.label}
                        <small>{band.range}</small>
                      </span>
                      <strong>
                        {failed ? "—" : stats.bands[i]} <small>{stats.bands[i] === 1 ? "pair" : "pairs"}</small>
                      </strong>
                    </div>
                    <div className="band-track" aria-hidden="true">
                      <div
                        className={`bg-${band.tone}`}
                        style={{
                          width: `${stats.pairs ? (stats.bands[i] / stats.pairs) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="metric-note">
                Name similarity suggests connections; it does not confirm a
                physical overlap.
              </p>
            </Card>
          </section>
          <ProjectMap />
        </div>
        <WorkspaceFooter />
      </main>
    </>
  );
}
