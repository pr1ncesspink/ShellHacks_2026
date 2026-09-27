import { CircleAlert, Database, FlaskConical, RotateCw } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { PageHeading } from "@/components/workspace";
import { FileUpload } from "@/components/file-upload";
import { ProjectMap } from "@/components/project-map";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { getDashboardData } from "@/lib/backend";
import { summarize } from "@/lib/overlaps";
import { requireUser } from "@/lib/server/session";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const BANDS = [
  { label: "High similarity", range: "0.75 – 1.00", bar: "bg-chart-1" },
  { label: "Moderate similarity", range: "0.50 – < 0.75", bar: "bg-chart-2" },
  { label: "Lower similarity", range: "−1.00 – < 0.50", bar: "bg-chart-3" },
] as const;

function DataStatus({ mode }: { mode: "example" | "error" | "live" }) {
  if (mode === "error") {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Project data unavailable</AlertTitle>
        <AlertDescription>
          <p>We couldn’t load project data. Check your backend connection and try again.</p>
          <a href="/dashboard" className="inline-flex items-center gap-1 font-medium text-primary-text underline-offset-4 hover:underline">
            <RotateCw size={16} aria-hidden="true" />
            Try again
          </a>
        </AlertDescription>
      </Alert>
    );
  }
  const example = mode === "example";
  return (
    <Alert variant={example ? "info" : "success"}>
      {example ? <FlaskConical aria-hidden="true" /> : <Database aria-hidden="true" />}
      <AlertTitle className="flex items-center gap-2">
        Data source
        <Badge variant={example ? "info" : "success"}>{example ? "Example data" : "Live data"}</Badge>
      </AlertTitle>
      <AlertDescription>
        <p>
          {example
            ? "Overlap statistics use example data. The map shows locations from your project CSV."
            : "Live project data from your connected backend."}
        </p>
      </AlertDescription>
    </Alert>
  );
}

export default async function DashboardPage() {
  const user = await requireUser("/dashboard");
  const data = await getDashboardData(user);
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
      <SiteHeader active="dashboard" user={user} />
      <main id="main-content" className="workspace">
        <PageHeading
          section="Dashboard"
          title="Every overlap. One clear view."
          description="Understand where your projects connect, and where to look next."
        />
        <section className="upload-section upload-section-first" aria-label="Construction plans">
          <FileUpload />
        </section>
        <div className="dashboard-grid">
          <section
            aria-label="Project overlap statistics"
            className="stats-column"
          >
            <DataStatus mode={data.mode} />
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
                  <span className="eyebrow">Connection strength</span>
                  <h2>Similarity at a glance</h2>
                </div>
              </div>
              <div className="band-list">
                {BANDS.map((band, i) => (
                  <div className="band" key={band.label}>
                    <div className="band-label">
                      <span>
                        {band.label}
                        <small>{band.range}</small>
                      </span>
                      <strong>
                        {failed ? "—" : stats.bands[i]} <small>{stats.bands[i] === 1 ? "pair" : "pairs"}</small>
                      </strong>
                    </div>
                    <div className="band-track" aria-hidden="true">
                      <div
                        className={band.bar}
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
      </main>
    </>
  );
}
