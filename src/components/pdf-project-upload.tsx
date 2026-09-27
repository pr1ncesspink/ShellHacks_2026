"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { readProjectPdf } from "@/lib/pdf-reader";
import { toMapProject, validateDraft, type MapProject, type ProjectDraft } from "@/lib/project-data";

export function PdfProjectUpload({ onApply }: { onApply: (rows: MapProject[], source: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [rows, setRows] = useState<ProjectDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [excerpts, setExcerpts] = useState<{ page: number; text: string }[]>([]);
  useEffect(() => () => { generation.current++; }, []);

  async function extract(file: File) {
    const run = ++generation.current;
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
    <div className="upload-note">PDF text is read in your browser. When you replace the map, reviewed project names, coordinates, and schedules are sent to the backend for matching, without being saved. The PDF file itself is not uploaded. Basemap tiles load from the map provider.</div>
  </Card>}
  </>;
}
