import Link from "next/link";
import { ArrowUpRight, Layers3, MapPinned } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export function WorkspaceFooter() {
  return (
    <footer className="workspace-footer">
      <span>
        GridLens <span className="footer-dot">/</span> A clearer perspective on
        every project.
      </span>
      <span>
        Built for better coordination
        <span className="tiny-dot" />
      </span>
    </footer>
  );
}
export function MapPlaceholder({ budget = false }: { budget?: boolean }) {
  return (
    <Card className="map-card panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SPATIAL CONTEXT</span>
          <h2>{budget ? "The bigger picture" : "Project landscape"}</h2>
        </div>
        <span className="icon-tile">
          <Layers3 size={19} aria-hidden="true" />
        </span>
      </div>
      <div className="map-placeholder">
        <div className="map-reticle" aria-hidden="true">
          <span />
          <span />
          <MapPinned size={33} strokeWidth={1.3} />
        </div>
        <Badge variant="outline" className="muted-badge">
          MAP PLACEHOLDER
        </Badge>
        <h3>Make room for perspective.</h3>
        <p>
          {budget
            ? "Project locations and budget context will come together here."
            : "Your project locations and overlapping areas will come together here."}
        </p>
        <div className="coordinate-label" aria-hidden="true">
          GRIDLENS / SPATIAL VIEW
        </div>
      </div>
      <div className="map-footer">
        <span>
          <span className="tiny-dot gray" />
          Map integration planned
        </span>
        <span>Location layer</span>
      </div>
    </Card>
  );
}
export function PageHeading({ budget = false }: { budget?: boolean }) {
  return (
    <div className="page-heading">
      <div>
        <div className="breadcrumb">
          WORKSPACE <span>/</span> {budget ? "BUDGET SUMMARY" : "DASHBOARD"}
        </div>
        <h1>
          {budget
            ? "Plan with the full picture."
            : "Every overlap. One clear view."}
        </h1>
        <p>
          {budget
            ? "A dedicated space to turn project context into budget clarity."
            : "Understand where your projects connect, and where to look next."}
        </p>
      </div>
      {!budget && (
        <Link href="/budget" className="subtle-link">
          Explore budget summary
          <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}
