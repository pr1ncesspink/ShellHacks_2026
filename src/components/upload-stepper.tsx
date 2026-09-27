"use client";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Ban, Circle, CircleCheck, CircleX, LoaderCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  describeElapsed,
  formatElapsed,
  uploadFailureMessage,
  uploadSteps,
  type UploadProgress,
  type UploadStepState,
} from "@/lib/upload-progress";
import "./plan-upload.css";

const STATE_TEXT: Record<UploadStepState, string> = {
  done: "done",
  current: "in progress",
  pending: "not started",
  failed: "failed",
  cancelled: "cancelled",
};

const STATE_ICON = {
  done: CircleCheck,
  current: LoaderCircle,
  pending: Circle,
  failed: CircleX,
  cancelled: Ban,
} satisfies Record<UploadStepState, unknown>;

/**
 * Client-side elapsed time for the current step and the whole run, measured
 * with performance.now() so server clock skew never shows up. Ticks once a
 * second while running; the last tick on cleanup freezes the final total.
 */
function useStepClock(stepKey: string, running: boolean) {
  const origin = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState({ key: stepKey, step: 0, total: 0 });
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    origin.current ??= start;
    const first = origin.current;
    const tick = () => {
      const now = performance.now();
      setElapsed({ key: stepKey, step: now - start, total: now - first });
    };
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearInterval(timer);
      tick();
    };
  }, [stepKey, running]);
  return { step: elapsed.key === stepKey ? elapsed.step : 0, total: elapsed.total };
}

function Elapsed({ ms }: { ms: number }) {
  return (
    <>
      <span aria-hidden="true">{formatElapsed(ms)}</span>
      <span className="sr-only">{describeElapsed(ms)}</span>
    </>
  );
}

export type UploadStepperProps = Omit<ComponentProps<"div">, "children"> & {
  progress: UploadProgress;
  /** Accessible name for the step list, e.g. "Steps for plans.pdf". */
  label?: string;
  /** Shown as a Retry button under the failure copy when the upload failed. */
  onRetry?: () => void;
  /** Accessible name for the Retry button, e.g. "Retry plans.pdf". */
  retryLabel?: string;
  /** Visible text of the Retry button; defaults to "Retry". */
  retryText?: string;
};

/**
 * Ordered upload pipeline: Checking -> ... -> Done. The current step carries
 * aria-current="step"; each step's state is given by its icon and a visually
 * hidden word, never by colour alone.
 */
export function UploadStepper({
  progress,
  label = "Upload steps",
  onRetry,
  retryLabel = "Retry",
  retryText = "Retry",
  className,
  ...props
}: UploadStepperProps) {
  const steps = uploadSteps(progress);
  const active = steps.find((step) => step.state !== "done" && step.state !== "pending");
  const failed = progress.phase === "failed";
  const cancelled = progress.phase === "cancelled";
  const running = progress.phase !== "succeeded" && !failed && !cancelled;
  const clock = useStepClock(active?.id ?? "done", running);

  return (
    <div
      data-slot="upload-stepper"
      data-state={failed ? "failed" : cancelled ? "cancelled" : running ? "running" : "done"}
      className={cn("upload-stepper", className)}
      {...props}
    >
      <ol className="upload-stepper-list" aria-label={label}>
        {steps.map((step) => {
          const Icon = STATE_ICON[step.state];
          const isCurrent = step.state === "current";
          return (
            <li
              key={step.id}
              data-slot="upload-stepper-step"
              data-state={step.state}
              aria-current={step === active ? "step" : undefined}
              className="upload-stepper-step"
            >
              <Icon
                size={16}
                aria-hidden="true"
                className={isCurrent ? "upload-stepper-spin" : undefined}
              />
              <span>{step.label}</span>
              <span className="sr-only">, {STATE_TEXT[step.state]}</span>
              {isCurrent && (
                <span className="upload-stepper-detail">
                  {step.detail && <>{step.detail} · </>}
                  <Elapsed ms={clock.step} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {failed && (
        <div data-slot="upload-stepper-failure" className="upload-stepper-failure">
          <CircleX size={16} aria-hidden="true" />
          <p>{uploadFailureMessage(progress.errorCode, progress.kind)}</p>
          {onRetry && (
            <Button variant="outline" size="touch" onClick={onRetry} aria-label={retryLabel}>
              <RotateCw size={16} aria-hidden="true" />
              {retryText}
            </Button>
          )}
        </div>
      )}
      {(running || clock.total > 0) && (
        <p className="upload-stepper-total">
          {running ? "Elapsed " : failed || cancelled ? "Stopped after " : "Finished in "}
          <Elapsed ms={clock.total} />
        </p>
      )}
    </div>
  );
}
