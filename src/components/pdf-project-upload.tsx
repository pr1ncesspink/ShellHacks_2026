"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { readProjectPdf } from "@/lib/pdf-reader";
import { toMapProject, validateDraft, type MapProject, type ProjectDraft } from "@/lib/project-data";
import { GENERIC_API_ERROR, POLL_GAVE_UP_MESSAGE, UploadApiError, apiErrorMessage, parseCreatedSession, parseProcessResult, parseSessionState, pollFailureAction, putToSignedUrl, validatePdf, type SessionStatus } from "@/lib/upload-sessions";

const POLL_MS = 5_000;
const POLL_LIMIT_MS = 70 * 60 * 1000;
const REMOTE_LABELS: Record<SessionStatus, string> = {
  created: "Waiting for upload...",
  queued: "Queued for Snowflake processing...",
  processing: "Processing in Snowflake. Large plans can take a while...",
  succeeded: "Processing finished.",
  failed: "Processing failed.",
};

async function callApi(path: string, init?: { method: "POST"; body?: unknown }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      cache: "no-store",
      headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new UploadApiError(null, GENERIC_API_ERROR);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new UploadApiError(response.status, apiErrorMessage(response.status, body));
  }
  try {
    return await response.json();
  } catch {
    // Never surface a JSON parser message: it can quote the response body.
    throw new UploadApiError(response.status, GENERIC_API_ERROR);
  }
}

export function PdfProjectUpload({ onApply }: { onApply: (rows: MapProject[], source: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const lastFile = useRef<File | null>(null);
  const remoteGeneration = useRef(0);
  const remoteAbort = useRef<AbortController | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState("");
  const [remoteError, setRemoteError] = useState("");
  const [uploadId, setUploadId] = useState("");
  const [rows, setRows] = useState<ProjectDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [excerpts, setExcerpts] = useState<{ page: number; text: string }[]>([]);
  useEffect(() => () => { generation.current++; remoteGeneration.current++; remoteAbort.current?.abort(); }, []);

  function cancelRemote() {
    remoteGeneration.current++;
    remoteAbort.current?.abort();
    remoteAbort.current = null;
  }

  async function extract(file: File) {
    const run = ++generation.current;
    cancelRemote();
    lastFile.current = file;
    setRemoteBusy(false); setRemoteStatus(""); setRemoteError(""); setUploadId(""); setFileProblem(null);
    void validatePdf(file).then(
      check => { if (run === generation.current) setFileProblem(check.ok ? "" : check.error); },
      () => { if (run === generation.current) setFileProblem("Could not read this PDF."); },
    );
    setBusy(true); setError(""); setRows([]); setExcerpts([]); setSource(file.name);
    setStatus(`Opening ${file.name}...`);
    try {
      const result = await readProjectPdf(file, message => { if (run === generation.current) setStatus(message); });
      if (run !== generation.current) return;
      setRows(result.rows); setExcerpts(result.excerpts);
      setStatus(!result.hasText ? "No readable text found. Scanned PDFs need OCR; you can enter project details manually below." : result.rows.length ? `Found ${result.rows.length} candidate project records. Check every location before replacing the map.` : "No labeled project records found. Review the extracted text and add project rows manually.");
    } catch (reason) {
      if (run === generation.current) {
        setError(reason instanceof Error ? reason.message : "Could not read this PDF.");
        setStatus("The current map has not changed. Try an unlocked, text-based PDF.");
      }
    } finally { if (run === generation.current) setBusy(false); }
  }

  async function processRemote() {
    const file = lastFile.current;
    if (!file) return;
    cancelRemote();
    const run = remoteGeneration.current;
    const controller = new AbortController();
    remoteAbort.current = controller;
    const live = () => run === remoteGeneration.current;
    setRemoteBusy(true); setRemoteError(""); setUploadId(""); setRemoteStatus("Checking PDF...");
    try {
      const check = await validatePdf(file);
      if (!check.ok) throw new Error(check.error);
      if (!live()) return;
      setRemoteStatus("Preparing upload...");
      const session = parseCreatedSession(await callApi("/api/upload-sessions", { method: "POST", body: { size_bytes: file.size } }));
      if (!live()) return;
      setRemoteStatus("Uploading 0%");
      await putToSignedUrl(session, file, percent => { if (live()) setRemoteStatus(`Uploading ${percent}%`); }, controller.signal);
      if (!live()) return;
      const statusPath = `/api/upload-sessions/${session.session_id}`;
      let current = parseProcessResult(await callApi(`${statusPath}/process`, { method: "POST" })).status;
      const deadline = Date.now() + POLL_LIMIT_MS;
      let failures = 0;
      while (live()) {
        setRemoteStatus(REMOTE_LABELS[current]);
        if (current === "succeeded" || current === "failed") return;
        if (Date.now() >= deadline) throw new Error("Processing is taking longer than expected. Check again later.");
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        if (!live()) return;
        let polled: unknown;
        try {
          polled = await callApi(statusPath);
        } catch (reason) {
          const next = pollFailureAction(failures, reason);
          if (next.action === "fatal") throw reason;
          if (next.action === "give-up") throw new Error(POLL_GAVE_UP_MESSAGE);
          failures = next.consecutive;
          continue;
        }
        failures = 0;
        const state = parseSessionState(polled);
        if (!live()) return;
        current = state.status;
        if (state.status === "succeeded" && state.upload_id) setUploadId(state.upload_id);
        if (state.status === "failed") setRemoteError(`Processing failed${state.error_code ? ` (${state.error_code})` : ""}. The map has not changed.`);
      }
    } catch (reason) {
      if (live()) {
        setRemoteStatus("");
        // Parser failures ("Invalid ...") are internal; show a generic message instead.
        setRemoteError(reason instanceof Error && reason.message && !reason.message.startsWith("Invalid ") ? reason.message : "Could not process this PDF.");
      }
    } finally {
      if (live()) { setRemoteBusy(false); remoteAbort.current = null; }
    }
  }

  function update(id: string, key: keyof ProjectDraft, value: string) {
    setRows(previous => previous.map(row => row.id === id ? { ...row, [key]: value } : row));
  }
  const invalid = rows.filter(row => validateDraft(row)).length;
  return <>
    <Button size="lg" disabled={busy} onClick={() => input.current?.click()}>
      <Paperclip aria-hidden="true" />{busy ? "Reading PDF..." : "Attach PDF"}
    </Button>
    <input ref={input} type="file" accept=".pdf,application/pdf" aria-label="Attach project PDF" className="sr-only" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (file) void extract(file);
    }} />
    {source && <Card className="upload-card panel pdf-upload" onDragOver={event => event.preventDefault()} onDrop={event => {
    event.preventDefault();
    if (busy) return;
    if (event.dataTransfer.files.length !== 1) { setError("Choose one PDF at a time."); return; }
    void extract(event.dataTransfer.files[0]);
  }}>
    <div className="upload-main">
      <div className="upload-copy"><span className="eyebrow">YOUR PROJECT DATA</span><h2>Upload a PDF. Update your map.</h2>
        <p>Extract project details, review the coordinates, then replace the map and overlap results.</p>
        <span className="file-types">One PDF at a time · Up to 20 MB · Up to 100 pages</span>
      </div>
    </div>
    <p className="pdf-help">Automatic extraction recognizes labeled fields such as Project, Latitude, Longitude, and In-service date/year. Tables, addresses and scanned drawings may need manual entry. Coordinates must be decimal degrees.</p>
    <p role="status">{status}</p>
    {error && <p role="alert" className="upload-error">{error}</p>}
    <div className="pdf-review-actions">
      <p>Optional: send this PDF to Snowflake for full plan processing. The PDF is uploaded to storage temporarily for processing and deleted afterwards.</p>
      <Button variant="outline" disabled={busy || remoteBusy || fileProblem !== ""} onClick={() => void processRemote()}>
        {remoteBusy ? "Processing..." : "Process with Snowflake"}
      </Button>
    </div>
    {fileProblem && <p className="upload-error">{fileProblem}</p>}
    {remoteStatus && <p role="status">{remoteStatus}</p>}
    {uploadId && <p>Snowflake upload id: <code>{uploadId}</code></p>}
    {remoteError && <p role="alert" className="upload-error">{remoteError}</p>}
    {source && !busy && <>
      <div className="pdf-review-actions"><strong>Review: {source}</strong><Button variant="outline" disabled={rows.length >= 500} onClick={() => setRows(previous => [...previous, { id: crypto.randomUUID(), name: "", latitude: "", longitude: "", owner: "", schedule: "", source, page: 0 }])}>Add project row</Button></div>
      <div className="pdf-review-rows">{rows.map((row, index) => <fieldset key={row.id} className="pdf-review-row">
        <legend>Project {index + 1} {row.page ? `· PDF page ${row.page}` : "· Manual entry"}</legend>
        {([['name','Project name'],['latitude','Latitude'],['longitude','Longitude'],['schedule','Date / year as published'],['owner','Owner / utility']] as const).map(([key,label]) => <label key={key}>{label}<input aria-label={`${label} ${index + 1}`} value={row[key]} onChange={event => update(row.id,key,event.target.value)} /></label>)}
        {validateDraft(row) && <p className="upload-error">{validateDraft(row)}</p>}
        <Button variant="ghost" onClick={() => setRows(previous => previous.filter(item => item.id !== row.id))}>Remove project {index + 1}</Button>
      </fieldset>)}</div>
      {rows.length > 0 && <div className="pdf-review-actions"><p>{rows.length} projects · {invalid} need corrections. Dates are optional.</p><Button disabled={invalid > 0} onClick={() => {
        try { const projects = rows.map(toMapProject); onApply(projects, source); setStatus(`Map replaced with ${projects.length} projects from ${source}. Backend distance and timing analysis requested.`); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "Check the project details."); }
      }}>Replace map with {rows.length} projects</Button></div>}
      {excerpts.length > 0 && <details className="pdf-text"><summary>View extracted PDF text</summary>{excerpts.map(page => <section key={page.page}><h3>Page {page.page}</h3><pre>{page.text || "No text on this page."}</pre></section>)}</details>}
    </>}
    <div className="upload-note">PDF text is read in your browser. When you replace the map, reviewed project names, coordinates, and schedules are sent to the backend for matching, without being saved. The PDF file itself is not uploaded unless you choose Process with Snowflake, which stores it temporarily for processing. Basemap tiles load from the map provider.</div>
  </Card>}
  </>;
}
