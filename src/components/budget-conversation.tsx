"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BudgetScheduleWorkspace, ScheduleProposalSummary, type Plan } from "@/components/budget-schedule-workspace";

export function BudgetConversation({ projectId }: { projectId?: string }) {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const generate = useCallback(async (kind: "summary" | "proposal", question: string, context?: string) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError(""); setResponse("");
    if (kind === "summary") setPlan(null);
    try {
      const result = await fetch("/api/budget-response", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ kind, prompt: question, projectId, context }),
      });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "Could not generate a response.");
      if (!controller.signal.aborted) setResponse(data.text);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not generate a response.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [projectId]);
  const explainProposal = useCallback((context: string, analysis: Plan) => {
    setPlan(analysis);
    void generate("proposal", "Explain this schedule proposal, its tradeoffs, and the next steps to review it.", context);
  }, [generate]);
  return <>
    <Card className="budget-input panel">
      <div className="panel-heading"><h2>Start with the context</h2></div>
      <form onSubmit={event => { event.preventDefault(); void generate("summary", prompt.trim()); }}>
        <label htmlFor="budget-prompt">What would you like to understand?</label>
        <textarea id="budget-prompt" name="budget-prompt" required maxLength={4000} value={prompt}
          onChange={event => setPrompt(event.target.value)} rows={4}
          placeholder="For example, where could coordinating these projects reduce duplicate work?" />
        <div className="budget-action"><span>Powered by Gemini</span><Button disabled={busy || !prompt.trim()} type="submit">Generate summary</Button></div>
      </form>
    </Card>
    <BudgetScheduleWorkspace onProposalReady={explainProposal} responseBusy={busy}
      onProposalStart={() => { setPlan(null); setResponse(""); setError(""); }} />
    <Card className="budget-response panel" aria-label="Planning response" aria-busy={busy}>
      {plan && <div className="budget-schedule-workspace"><ScheduleProposalSummary plan={plan} /></div>}
      <div className="budget-generated-response" role="status" aria-live="polite">
        {busy ? "Gemini is preparing your response…" : error || response || "Generate a summary or proposal to see a response here."}
      </div>
    </Card>
  </>;
}
