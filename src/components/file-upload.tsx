"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, FileText, X, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MAX_UPLOAD_BYTES, runUploadSession } from "@/lib/upload-sessions";

const maxImageSize = 20 * 1024 * 1024;
const maxFiles = 5;

type Entry = {
  id: string;
  file: File;
  kind: "pdf" | "image";
  phase: "running" | "succeeded" | "failed" | "local";
  label: string;
  uploadId?: string;
  error?: string;
};

const isPdf = (file: File) => /\.pdf$/i.test(file.name);
const sameFile = (a: File, b: File) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

function failureMessage(reason: unknown): string {
  // Parser failures ("Invalid ...") are internal; show a generic message instead.
  return reason instanceof Error && reason.message && !reason.message.startsWith("Invalid ")
    ? reason.message
    : "Could not process this PDF.";
}

export function FileUpload() {
  const input = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const [files, setFiles] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  function patch(id: string, controller: AbortController, update: Partial<Entry>) {
    // Skip updates for rows that were removed, retried, or unmounted.
    if (controllers.current.get(id) !== controller) return;
    setFiles((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...update } : entry)),
    );
  }

  async function startUpload(id: string, file: File) {
    controllers.current.get(id)?.abort();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    patch(id, controller, {
      phase: "running",
      label: "Starting upload...",
      uploadId: undefined,
      error: undefined,
    });
    try {
      const result = await runUploadSession(file, {
        signal: controller.signal,
        onStatus: (label) => patch(id, controller, { label }),
      });
      if (result.status === "succeeded" && result.upload_id) {
        patch(id, controller, { phase: "succeeded", uploadId: result.upload_id });
      } else {
        patch(id, controller, {
          phase: "failed",
          error: `Processing failed${result.error_code ? ` (${result.error_code})` : ""}.`,
        });
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      patch(id, controller, { phase: "failed", error: failureMessage(reason) });
    } finally {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    }
  }

  function removeFile(id: string) {
    const controller = controllers.current.get(id);
    controllers.current.delete(id);
    controller?.abort();
    setFiles((current) => current.filter((entry) => entry.id !== id));
  }

  function selectFiles(incoming: FileList | null) {
    if (!incoming) return;
    const selected = Array.from(incoming);
    if (
      selected.some(
        (file) =>
          !/\.(pdf|png|jpe?g)$/i.test(file.name) ||
          file.size > (isPdf(file) ? MAX_UPLOAD_BYTES : maxImageSize),
      )
    ) {
      setError("Choose PDFs up to 50 MB, or PNG and JPG files up to 20 MB each.");
      return;
    }
    if (selected.length + files.length > maxFiles) {
      setError("You can attach up to 5 files. Remove one before adding more.");
      return;
    }
    const added: Entry[] = [];
    for (const file of selected) {
      if (files.some((entry) => sameFile(entry.file, file))) continue;
      if (added.some((entry) => sameFile(entry.file, file))) continue;
      const pdf = isPdf(file);
      added.push({
        id: crypto.randomUUID(),
        file,
        kind: pdf ? "pdf" : "image",
        phase: pdf ? "running" : "local",
        label: pdf ? "Starting upload..." : "",
      });
    }
    setFiles((previous) => [...previous, ...added]);
    setError("");
    for (const entry of added) {
      if (entry.kind === "pdf") void startUpload(entry.id, entry.file);
    }
  }

  return (
    <Card
      className={`upload-card panel ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        selectFiles(event.dataTransfer.files);
      }}
    >
      <div className="upload-main">
        <span className="upload-icon">
          <Upload size={25} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <div className="upload-copy">
          <span className="eyebrow">START WITH YOUR PLANS</span>
          <h2>Bring your next project into view.</h2>
          <p>Drop construction plans here, or browse your files.</p>
          <span className="file-types">
            PDF up to 50 MB <span>·</span> PNG, JPG up to 20 MB <span>·</span> 5
            files maximum
          </span>
        </div>
        <Button
          onClick={() => input.current?.click()}
          className="upload-button"
        >
          Choose files
          <ArrowUpRight size={16} aria-hidden="true" />
        </Button>
        <input
          ref={input}
          type="file"
          name="plans"
          aria-label="Attach construction plans"
          className="sr-only"
          tabIndex={-1}
          accept=".pdf,.png,.jpg,.jpeg"
          multiple
          onChange={(event) => {
            selectFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <div aria-live="polite">
        {error && (
          <p className="upload-error" role="alert">
            {error}
          </p>
        )}
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((entry) => {
              const size = `${(entry.file.size / 1024 / 1024).toFixed(2)} MB`;
              return (
                <li key={entry.id}>
                  <FileText size={17} aria-hidden="true" />
                  <span>
                    {entry.file.name}
                    {entry.phase === "failed" ? (
                      <small role="alert">
                        {size} · {entry.error}
                      </small>
                    ) : (
                      <small>
                        {size} ·{" "}
                        {entry.phase === "local" ? (
                          "Selected locally · images aren’t processed yet"
                        ) : entry.phase === "succeeded" ? (
                          <>
                            Processed · upload id <code>{entry.uploadId}</code>
                          </>
                        ) : (
                          entry.label
                        )}
                      </small>
                    )}
                  </span>
                  {entry.phase === "failed" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Retry ${entry.file.name}`}
                      onClick={() => void startUpload(entry.id, entry.file)}
                    >
                      Retry
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${entry.file.name}`}
                    onClick={() => removeFile(entry.id)}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="upload-note">
        <span className="tiny-dot pink" />
        PDFs are uploaded to temporary storage for processing and deleted
        afterwards. Images stay in this tab and aren’t uploaded.
      </div>
    </Card>
  );
}
