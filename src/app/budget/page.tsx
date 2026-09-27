import {
  LockKeyhole,
} from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import {
  MapPlaceholder,
  PageHeading,
  WorkspaceFooter,
} from "@/components/workspace";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/server/session";

export const metadata = { title: "Budget Summary" };
export default async function BudgetPage() {
  const user = await requireUser("/budget");
  return (
    <>
      <SiteHeader active="budget" user={user} />
      <main id="main-content" className="workspace">
        <PageHeading budget />
        <div className="budget-intro">
          <div>
            <strong>A space for better-informed budgets.</strong>
            <p>Connect your project context to future cost insights.</p>
          </div>
          <Badge variant="outline" className="muted-badge">
            DESIGN PREVIEW
          </Badge>
        </div>
        <div className="budget-grid">
          <section
            className="budget-column"
            aria-label="Budget input and response placeholders"
          >
            <Card className="budget-input panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">01 / YOUR QUESTION</span>
                  <h2>Start with the context</h2>
                </div>
              </div>
              <label htmlFor="budget-prompt">
                What would you like to understand?
              </label>
              <textarea
                id="budget-prompt"
                name="budget-prompt"
                disabled
                placeholder="For example, where could coordinating these projects reduce duplicate work?…"
                rows={4}
              />
              <div className="budget-action">
                <span>
                  Input placeholder
                </span>
                <Button disabled>
                  Generate summary
                </Button>
              </div>
            </Card>
            <Card className="budget-response panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">02 / THE PERSPECTIVE</span>
                  <h2>Your budget summary</h2>
                </div>
              </div>
              <div className="response-empty">
                <div className="response-lines" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <h3>A little context. A clearer outlook.</h3>
                <p>
                  Your future response will appear here, with room for cost
                  insights and coordination opportunities.
                </p>
                <Badge variant="outline" className="muted-badge">
                  RESPONSE PLACEHOLDER
                </Badge>
              </div>
            </Card>
          </section>
          <MapPlaceholder budget />
        </div>
        <p className="budget-disclaimer">
          <LockKeyhole size={14} aria-hidden="true" />
          Budget input, analysis, and maps are visual placeholders. No estimates
          are generated.
        </p>
        <WorkspaceFooter />
      </main>
    </>
  );
}
