"use client";
import {
  createContext,
  use,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ActionDispatch,
  type DragEvent,
  type ReactNode,
} from "react";
import { CircleAlert, FileSpreadsheet, FileText, Info, LoaderCircle, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { UploadStepper } from "@/components/upload-stepper";
import {
  GENERIC_API_ERROR,
  cancelUploadSession,
  isSessionNotFoundError,
  isTerminalStatus,
  isUploadCancelled,
  pollUploadSession,
  runUploadSession,
  sessionProgress,
  type UploadKind,
} from "@/lib/upload-sessions";
import { uploadFailureMessage } from "@/lib/upload-progress";
import {
  UPLOAD_ACCEPT,
  classifyFiles,
  formatBytes,
  isFinished,
  listedFiles,
  queuedSessionIds,
  rejectionMessage,
  resumedUploadItems,
  succeededUploadIds,
  uploadActivity,
  uploadItemAnnouncement,
  type UploadActivity,
  uploadListReducer,
  type Rejection,
  type UploadItem,
  type UploadListAction,
} from "@/lib/plan-upload";
import "./plan-upload.css";

type Item = UploadItem<File>;
type Dispatch = ActionDispatch<[action: UploadListAction<File>]>;

type PlanUploadContextValue = {
  state: { items: Item[]; rejections: Rejection<File>[]; dragging: boolean; expiredLinks: number };
  actions: {
    addFiles: (files: FileList | readonly File[] | null) => void;
    retry: (id: string) => void;
    cancel: (id: string) => void;
    remove: (id: string) => void;
    setDragging: (dragging: boolean) => void;
  };
  meta: { constraintsId: string; inputId: string };
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

/** Poll a session resumed from the URL until it is terminal (or the row is aborted). */
async function followSession(
  id: string,
  sessionId: string,
  attempt: number,
  controllers: Map<string, AbortController>,
  cancels: Map<string, AbortController>,
  dispatch: Dispatch,
  onExpired: () => void,
) {
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    await pollUploadSession(sessionId, {
      signal: controller.signal,
      onProgress: (progress) => dispatch({ type: "progress", id, attempt, progress }),
    });
    // Terminal on its own: a cancel still retrying is no longer needed.
    cancels.get(id)?.abort();
  } catch (reason) {
    if (isUploadCancelled(reason, controller.signal)) return;
    if (isSessionNotFoundError(reason)) {
      // An old in-progress link: drop the row quietly instead of showing a failure.
      dispatch({ type: "remove", id });
      onExpired();
      return;
    }
    dispatch({ type: "error", id, attempt, message: errorDetail(reason) });
  } finally {
    if (controllers.get(id) === controller) controllers.delete(id);
  }
}

export type PlanUploadProviderProps = {
  children: ReactNode;
  /** Sessions to resume on mount (e.g. from /budget?sessions=...); read once. */
  initialSessionIds?: string[];
  /**
   * Session ids of every row handed to the backend, once no accepted row is
   * still on its way to the queue. Cancelled rows and rows that failed before
   * queueing are left out. Fires only when the list changes.
   */
  onSessionsChange?: (ids: string[]) => void;
  /** Upload ids of the rows that succeeded so far; fires only when the list changes. */
  onUploadsChange?: (uploadIds: string[]) => void;
  /**
   * Row counts: `rows` is every row, `active` the rows not yet terminal
   * (checking, preparing, uploading, queued, processing). Fires on mount and
   * whenever either count changes.
   */
  onActivityChange?: (activity: UploadActivity) => void;
};

/**
 * Upload state and actions. Each accepted file runs its own upload session and
 * stays on this page; the parent owns the URL and is told about queued
 * sessions and finished uploads through the callbacks.
 */
export function PlanUploadProvider({
  children,
  initialSessionIds,
  onSessionsChange,
  onUploadsChange,
  onActivityChange,
}: PlanUploadProviderProps) {
  const constraintsId = useId();
  const inputId = useId();
  const [initialItems] = useState(() => resumedUploadItems<File>(initialSessionIds ?? []));
  const [items, dispatch] = useReducer(uploadListReducer<File>, initialItems);
  const [rejections, setRejections] = useState<Rejection<File>[]>([]);
  const [dragging, setDragging] = useState(false);
  const [expiredLinks, setExpiredLinks] = useState(0);
  /** Upload or polling run per row. */
  const controllers = useRef(new Map<string, AbortController>());
  /** In-flight server cancel per row. */
  const cancels = useRef(new Map<string, AbortController>());
  /** Session created for a row that is not queued yet, so a cancel can reach the backend. */
  const created = useRef(new Map<string, string>());
  const callbacks = useRef({ onSessionsChange, onUploadsChange, onActivityChange });
  const sessionsKey = useRef(initialItems.map((item) => item.sessionId).join(","));
  const uploadsKey = useRef("");
  const activityKey = useRef("");

  useEffect(() => {
    callbacks.current = { onSessionsChange, onUploadsChange, onActivityChange };
  });

  useEffect(() => {
    const runs = controllers.current;
    const pending = cancels.current;
    for (const item of initialItems) {
      if (item.sessionId) {
        void followSession(item.id, item.sessionId, item.attempt, runs, pending, dispatch,
          () => setExpiredLinks((count) => count + 1));
      }
    }
    return () => {
      for (const controller of [...runs.values(), ...pending.values()]) controller.abort();
      runs.clear();
      pending.clear();
    };
  }, [initialItems]);

  useEffect(() => {
    const sessions = queuedSessionIds(items);
    if (sessions !== null && sessions.join(",") !== sessionsKey.current) {
      sessionsKey.current = sessions.join(",");
      callbacks.current.onSessionsChange?.(sessions);
    }
    const uploads = succeededUploadIds(items);
    if (uploads.join(",") !== uploadsKey.current) {
      uploadsKey.current = uploads.join(",");
      callbacks.current.onUploadsChange?.(uploads);
    }
    const activity = uploadActivity(items);
    const key = `${activity.rows}:${activity.active}`;
    if (key !== activityKey.current) {
      activityKey.current = key;
      callbacks.current.onActivityChange?.(activity);
    }
  }, [items]);

  function stopRun(id: string) {
    const controller = controllers.current.get(id);
    controllers.current.delete(id);
    // Aborts surface as UploadCancelledError, which the rows ignore.
    controller?.abort();
  }

  async function start(id: string, file: File, kind: UploadKind, attempt: number) {
    controllers.current.get(id)?.abort();
    created.current.delete(id);
    const controller = new AbortController();
    controllers.current.set(id, controller);
    try {
      await runUploadSession(file, {
        kind,
        signal: controller.signal,
        onProgress: (progress) => dispatch({ type: "progress", id, attempt, progress }),
        onCreated: (sessionId) => created.current.set(id, sessionId),
        onQueued: (sessionId) => dispatch({ type: "queued", id, attempt, sessionId }),
      });
      // Terminal on its own: a cancel still retrying is no longer needed.
      cancels.current.get(id)?.abort();
    } catch (reason) {
      if (isUploadCancelled(reason, controller.signal)) return;
      dispatch({ type: "error", id, attempt, message: errorDetail(reason) });
    } finally {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    }
  }

  function addFiles(incoming: FileList | readonly File[] | null) {
    if (!incoming) return;
    const { accepted, rejected } = classifyFiles(listedFiles(items), Array.from(incoming));
    setRejections(rejected);
    if (!accepted.length) return;
    const added = accepted.map(({ file, kind }) => ({ id: crypto.randomUUID(), file, kind }));
    dispatch({ type: "add", items: added });
    for (const entry of added) void start(entry.id, entry.file, entry.kind, 0);
  }

  function retry(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    if (!item.file) {
      // A resumed row has no File to send again: let the user pick one.
      document.getElementById(inputId)?.click();
      return;
    }
    dispatch({ type: "retry", id });
    void start(id, item.file, item.kind, item.attempt + 1);
  }

  function cancel(id: string) {
    const item = items.find((entry) => entry.id === id);
    if (!item || isFinished(item) || item.cancelling) return;
    const { attempt, kind, sessionId } = item;
    if (!sessionId) {
      // Not queued yet: stop the browser side now. A session that already
      // exists is cancelled in the background so it never starts processing.
      const createdId = created.current.get(id);
      created.current.delete(id);
      stopRun(id);
      dispatch({ type: "cancelled", id, attempt });
      if (createdId) void cancelUploadSession(createdId).catch(() => undefined);
      return;
    }
    // Polling keeps running until the cancel is confirmed, so a terminal state
    // reached meanwhile still shows (and ends Cancelling...).
    dispatch({ type: "cancelling", id, attempt });
    const controller = new AbortController();
    cancels.current.set(id, controller);
    cancelUploadSession(sessionId, { signal: controller.signal })
      .then((state) => {
        if (state.status === "cancelled") {
          stopRun(id);
          dispatch({ type: "cancelled", id, attempt });
        } else if (isTerminalStatus(state.status)) {
          // It finished before the cancel landed: show how it ended.
          stopRun(id);
          dispatch({ type: "progress", id, attempt, progress: sessionProgress(state.status, state, kind) });
        } else {
          dispatch({ type: "cancel-failed", id, attempt, message: GENERIC_API_ERROR });
        }
      }, (reason: unknown) => {
        if (isUploadCancelled(reason, controller.signal)) return;
        dispatch({ type: "cancel-failed", id, attempt, message: errorDetail(reason) || GENERIC_API_ERROR });
      })
      .finally(() => {
        if (cancels.current.get(id) === controller) cancels.current.delete(id);
      });
  }

  function remove(id: string) {
    stopRun(id);
    cancels.current.get(id)?.abort();
    cancels.current.delete(id);
    created.current.delete(id);
    dispatch({ type: "remove", id });
  }

  const value: PlanUploadContextValue = {
    state: { items, rejections, dragging, expiredLinks },
    actions: { addFiles, retry, cancel, remove, setDragging },
    meta: { constraintsId, inputId },
  };
  return <PlanUploadContext value={value}>{children}</PlanUploadContext>;
}

/** Heading and one-line explanation. */
export function PlanUploadHeader() {
  return (
    <div data-slot="plan-upload-header" className="plan-upload-header">
      <h2>Upload a project to check for collisions</h2>
      <p>Each file is checked, uploaded and processed. Its summary and collisions appear on this page when it finishes.</p>
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
        id={meta.inputId}
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

/**
 * Cancel for a running row, Remove for a finished one. One Button element in
 * both states, so keyboard focus stays put as the row moves from Cancel to
 * Cancelling... to Remove. While cancelling it is aria-disabled (not
 * disabled) for the same reason.
 */
function PlanUploadItemAction({ item }: { item: Item }) {
  const { actions } = usePlanUpload();
  const { name } = item;
  if (isFinished(item)) {
    return (
      <Button variant="ghost" size="icon-touch" aria-label={`Remove ${name}`} onClick={() => actions.remove(item.id)}>
        <X size={20} aria-hidden="true" />
      </Button>
    );
  }
  if (item.cancelling) {
    return (
      <Button
        variant="ghost"
        size="touch"
        aria-disabled="true"
        aria-busy="true"
        aria-label={`Cancelling upload of ${name}`}
        className="plan-upload-cancelling"
        onClick={(event) => event.preventDefault()}
      >
        <LoaderCircle size={16} aria-hidden="true" className="upload-stepper-spin" />
        Cancelling...
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="touch" aria-label={`Cancel upload of ${name}`} onClick={() => actions.cancel(item.id)}>
      Cancel
    </Button>
  );
}

/** One upload: name, size, spoken step status, upload bar, stepper, actions. */
export function PlanUploadItem({ item }: { item: Item }) {
  const { actions } = usePlanUpload();
  const { file, name, progress } = item;
  const FileIcon = item.kind === "csv" ? FileSpreadsheet : FileText;
  const detail = item.error && item.error !== uploadFailureMessage(progress.errorCode, item.kind) ? item.error : "";
  const resumed = file === null;

  return (
    <li
      data-slot="plan-upload-item"
      data-state={progress.phase}
      data-cancelling={item.cancelling || undefined}
      className="plan-upload-item"
    >
      <div className="plan-upload-item-head">
        <FileIcon size={20} aria-hidden="true" />
        <div className="plan-upload-item-meta">
          <span className="plan-upload-item-name">{name}</span>
          <span className="plan-upload-item-info">
            {resumed ? "Resumed from this page's link" : <>{item.kind.toUpperCase()} · {formatBytes(file.size)}</>}
          </span>
          {/* Announces step and cancel changes only; upload % and chunk counts are not live. */}
          <p role="status" aria-live="polite" aria-atomic="true" className="plan-upload-item-status">
            <span className="sr-only">{name}: </span>
            {uploadItemAnnouncement(item)}
          </p>
          {progress.phase === "cancelled" && <span className="plan-upload-item-note">Stopped by you</span>}
        </div>
        <div className="plan-upload-item-actions">
          <PlanUploadItemAction item={item} />
        </div>
      </div>
      {progress.phase === "uploading" && (
        <Progress value={progress.percent ?? 0} tone="info" aria-label={`Upload progress for ${name}`} />
      )}
      <UploadStepper
        key={item.attempt}
        progress={progress}
        label={`Steps for ${name}`}
        onRetry={() => actions.retry(item.id)}
        retryText={resumed ? "Upload again" : "Retry"}
        retryLabel={resumed ? `Upload again: choose a file to replace ${name}` : `Retry ${name}`}
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
  const { state } = usePlanUpload();
  return (
    <>
      {state.expiredLinks > 0 && (
        <p data-slot="plan-upload-note" className="plan-upload-note" role="status">
          <Info size={16} aria-hidden="true" />
          {state.expiredLinks === 1
            ? "That earlier upload link has expired. Choose the file again to check it."
            : "Those earlier upload links have expired. Choose the files again to check them."}
        </p>
      )}
      <p data-slot="plan-upload-note" className="plan-upload-note">
        <Info size={16} aria-hidden="true" />
        Files are stored temporarily for processing, then deleted.
      </p>
    </>
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

export type FileUploadProps = Omit<PlanUploadProviderProps, "children">;

/**
 * /budget uploader: PDFs and CSVs, up to 5 files. Never navigates or touches
 * the URL; the parent listens through onSessionsChange / onUploadsChange /
 * onActivityChange.
 */
export function FileUpload(props: FileUploadProps) {
  return (
    <PlanUploadProvider {...props}>
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
