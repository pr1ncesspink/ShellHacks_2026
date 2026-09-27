"use client";
import { useRef, useState } from "react";
import { Upload, FileText, X, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const maxSize = 20 * 1024 * 1024;
export function FileUpload() {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  function selectFiles(incoming: FileList | null) {
    if (!incoming) return;
    const selected = Array.from(incoming);
    if (
      selected.some(
        (file) => !/\.(pdf|png|jpe?g)$/i.test(file.name) || file.size > maxSize,
      )
    ) {
      setError("Choose PDF, PNG, or JPG files, each no larger than 20 MB.");
      return;
    }
    if (selected.length + files.length > 5) {
      setError("You can attach up to 5 files. Remove one before adding more.");
      return;
    }
    setFiles((previous) => [
      ...previous,
      ...selected.filter(
        (file) =>
          !previous.some(
            (p) =>
              p.name === file.name &&
              p.size === file.size &&
              p.lastModified === file.lastModified,
          ),
      ),
    ]);
    setError("");
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
            PDF, PNG, JPG <span>·</span> Up to 20 MB per file <span>·</span> 5
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
            {files.map((file, i) => (
              <li key={`${file.name}-${file.lastModified}-${file.size}`}>
                <FileText size={17} aria-hidden="true" />
                <span>
                  {file.name}
                  <small>
                    {(file.size / 1024 / 1024).toFixed(2)} MB · Selected locally
                  </small>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setFiles((current) =>
                      current.filter((_, index) => index !== i),
                    )
                  }
                >
                  <X size={16} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="upload-note">
        <span className="tiny-dot pink" />
        File selection preview. Files stay in this tab and aren’t uploaded or
        processed. Leaving this page clears the selection.
      </div>
    </Card>
  );
}
