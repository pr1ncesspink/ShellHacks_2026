"use client";
import {
  createContext,
  use,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, FileSpreadsheet, FileText, Info, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { UploadStepper } from "@/components/upload-stepper";
import { isUploadCancelled, runUploadSession, type UploadKind } from "@/lib/upload-sessions";
import { uploadFailureMessage, uploadStepAnnouncement } from "@/lib/upload-progress";
import {
  UPLOAD_ACCEPT,
  batchSummaryHref,
  classifyFiles,
  formatBytes,
  isFinished,
  rejectionMessage,
  uploadListReducer,
  type Rejection,
  type UploadItem,
} from "@/lib/plan-upload";
import "./plan-upload.css";

type Item = UploadItem<File>;

type PlanUploadContextValue = {
  state: { items: Item[]; rejections: Rejection<File>[]; dragging: boolean };
  actions: {
    addFiles: (files: FileList | readonly File[] | null) => void;
    retry: (id: string) => void;
    remove: (id: string) => void;
    setDragging: (dragging: boolean) => void;
  };
  meta: { constraintsId: string };
};

const PlanUploadContext = createContext<PlanUploadContextValue | null>(null);

function usePlanUpload(): PlanUploadContextValue {
  const context = use(PlanUploadContext);
  if (!context) throw new Error("PlanUpload parts must be rendered inside <PlanUploadProvider>.");
  return context;
}

/** Specific text from a thrown error; parser failures ("Invalid ...") stay internal. */
function errorDetail(reason: unknown): string {
  return reason instanceof Error && reason.message && !reason.message.startsWith("Invalid ")
    ? reason.message
    : "";
}

/**
 * Upload state and actions. Each accepted file runs its own upload session;
 * once every row has been queued for processing the page moves to /summary
 * and dashboard polling is aborted (the summary page resumes it).
 */
export function PlanUploadProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const constraintsId = useId();
  const [items, dispatch] = useReducer(uploadListReducer<File>, []);
  const [rejections, setRejections] = useState<Rejection<File>[]>([]);
  const [dragging, setDragging] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const navigated = useRef(false);

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  useEffect(() => {
    if (navigated.current) return;
    const href = batchSummaryHref(items);
    if (!href) return;
    navigated.current = true;
    // Aborts surface as UploadCancelledError, which the rows ignore.
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    router.push(href);
  }, [items, router]);

  async function start(id: string, file: File, kind: UploadKind, attempt: number) {
    controllers.current.get(id)?.abort();
    const controller = new AbortController();
    controllers.current.set(id, controller);
    try {
      await runUploadSession(file, {
        kind,
        signal: controller.signal,
        onProgress: (progress) => dispatch({ type: "progress", id, attempt, progress }),
        onQueued: (sessionId) => dispatch({ type: "queued", id, attempt, sessionId }),
      });
    } catch (reason) {
      if (isUploadCancelled(reason, controller.signal)) return;
      dispatch({ type: "error", id, attempt, message: errorDetail(reason) });
    } finally {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    }
  }

  function addFiles(incoming: FileList | readonly File[] | null) {
    if (!incoming || navigated.current) return;
    const { accepted, rejected } = classifyFiles(items.map((item) => item.file), Array.from(incoming));
    setRejections(rejected);
    if (!accepted.length) return;
    const added = accepted.map(({ file, kind }) => ({ id: crypto.randomUUID(), file, kind }));
    dispatch({ type: "add", items: added });
    for (const entry of added) void start(entry.id, entry.file, entry.kind, 0);
  }

  function retry(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    dispatch({ type: "retry", id });
    void start(id, item.file, item.kind, item.attempt + 1);
  }

  function remove(id: string) {
    const controller = controllers.current.get(id);
    controllers.current.delete(id);
    controller?.abort();
    dispatch({ type: "remove", id });
  }

  const value: PlanUploadContextValue = {
    state: { items, rejections, dragging },
    actions: { addFiles, retry, remove, setDragging },
    meta: { constraintsId },
  };
  return <PlanUploadContext value={value}>{children}</PlanUploadContext>;
}

/** Heading and one-line explanation. */
export function PlanUploadHeader() {
  return (
    <div data-slot="plan-upload-header" className="plan-upload-header">
      <h2>Add construction plans</h2>
      <p>Each file is checked, uploaded and processed. Once every file is queued, you go to its summary.</p>
    </div>
  );
}

/**
 * The whole zone is one <label>: clicking or pressing Enter/Space on the
 * focused (visually hidden) input opens the picker; files can also be dropped.
 */
export function PlanUploadDropzone() {
  const { state, actions, meta } = usePlanUpload();
  const textId = useId();

  const onDragOver = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!state.dragging) actions.setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLLabelElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) actions.setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    actions.setDragging(false);
    actions.addFiles(event.dataTransfer.files);
  };

  return (
    <label
      data-slot="plan-upload-dropzone"
      data-state={state.dragging ? "drag-over" : "idle"}
      className="plan-upload-dropzone"
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        type="file"
        name="plans"
        className="sr-only"
        multiple
        accept={UPLOAD_ACCEPT}
        aria-labelledby={textId}
        aria-describedby={meta.constraintsId}
        onChange={(event) => {
          actions.addFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <Upload size={20} aria-hidden="true" className="plan-upload-dropzone-icon" />
      <span id={textId} className="plan-upload-dropzone-text">
        {state.dragging ? (
          "Drop to upload"
        ) : (
          <>
            Drag PDFs or CSVs here or <span className="plan-upload-choose">Choose files</span>
          </>
        )}
      </span>
      <span id={meta.constraintsId} className="plan-upload-constraints">
        PDF up to 50 MB or CSV up to 10 MB · up to 5 files
      </span>
    </label>
  );
}

/** Per-file reasons for the files left out of the last pick or drop. */
export function PlanUploadRejections() {
  const { state } = usePlanUpload();
  if (!state.rejections.length) return null;
  return (
    <div data-slot="plan-upload-rejections" role="alert" className="plan-upload-rejections">
      <p>Some files were not added:</p>
      <ul>
        {state.rejections.map((rejection, index) => (
          <li key={`${rejection.file.name}-${rejection.file.lastModified}-${index}`}>
            <CircleAlert size={16} aria-hidden="true" />
            <span>{rejectionMessage(rejection)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One upload: name, size, spoken step status, upload bar, stepper, actions. */
export function PlanUploadItem({ item }: { item: Item }) {
  const { actions } = usePlanUpload();
  const { file, progress } = item;
  const finished = isFinished(item);
  const FileIcon = item.kind === "csv" ? FileSpreadsheet : FileText;
  const detail = item.error && item.error !== uploadFailureMessage(progress.errorCode, item.kind) ? item.error : "";

  return (
    <li data-slot="plan-upload-item" data-state={progress.phase} className="plan-upload-item">
      <div className="plan-upload-item-head">
        <FileIcon size={20} aria-hidden="true" />
        <div className="plan-upload-item-meta">
          <span className="plan-upload-item-name">{file.name}</span>
          <span className="plan-upload-item-info">
            {item.kind.toUpperCase()} · {formatBytes(file.size)}
          </span>
          {/* Announces step changes only; upload % and chunk counts are not live. */}
          <p role="status" aria-live="polite" aria-atomic="true" className="plan-upload-item-status">
            <span className="sr-only">{file.name}: </span>
            {uploadStepAnnouncement(progress)}
          </p>
        </div>
        <div className="plan-upload-item-actions">
          {finished ? (
            <Button variant="ghost" size="icon-touch" aria-label={`Remove ${file.name}`} onClick={() => actions.remove(item.id)}>
              <X size={20} aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="ghost" size="touch" aria-label={`Cancel upload of ${file.name}`} onClick={() => actions.remove(item.id)}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      {progress.phase === "uploading" && (
        <Progress value={progress.percent ?? 0} tone="info" aria-label={`Upload progress for ${file.name}`} />
      )}
      <UploadStepper
        key={item.attempt}
        progress={progress}
        label={`Steps for ${file.name}`}
        onRetry={() => actions.retry(item.id)}
        retryLabel={`Retry ${file.name}`}
      />
      {detail && <p className="plan-upload-item-error">{detail}</p>}
    </li>
  );
}

export function PlanUploadList() {
  const { state } = usePlanUpload();
  if (!state.items.length) return null;
  return (
    <ul data-slot="plan-upload-list" aria-label="Selected files" className="plan-upload-list">
      {state.items.map((item) => (
        <PlanUploadItem key={item.id} item={item} />
      ))}
    </ul>
  );
}

export function PlanUploadNote() {
  return (
    <p data-slot="plan-upload-note" className="plan-upload-note">
      <Info size={16} aria-hidden="true" />
      Files are stored temporarily for processing, then deleted.
    </p>
  );
}

export const PlanUpload = {
  Provider: PlanUploadProvider,
  Header: PlanUploadHeader,
  Dropzone: PlanUploadDropzone,
  Rejections: PlanUploadRejections,
  List: PlanUploadList,
  Item: PlanUploadItem,
  Note: PlanUploadNote,
};

/** Dashboard uploader: PDFs and CSVs, up to 5 files, then on to /summary. */
export function FileUpload() {
  return (
    <PlanUploadProvider>
      <Card data-slot="plan-upload" className="plan-upload">
        <PlanUploadHeader />
        <PlanUploadDropzone />
        <PlanUploadRejections />
        <PlanUploadList />
        <PlanUploadNote />
      </Card>
    </PlanUploadProvider>
  );
}
