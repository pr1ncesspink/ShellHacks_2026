"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Progress as ProgressPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/*
 * Radix Progress renders role="progressbar" with aria-valuemin/max/now and
 * data-state ("loading" | "complete" | "indeterminate"). Always give it an
 * accessible name (aria-label or aria-labelledby) and show the percentage as
 * text nearby: the bar colour is never the only state signal.
 */
const progressIndicatorVariants = cva(
  "h-full w-full flex-1 transition-transform duration-300 ease-out motion-reduce:transition-none",
  {
    variants: {
      tone: {
        primary: "bg-primary",
        success: "bg-success",
        info: "bg-info",
        destructive: "bg-destructive",
      },
    },
    defaultVariants: {
      tone: "primary",
    },
  },
);

function Progress({
  className,
  value,
  max = 100,
  tone = "primary",
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> &
  VariantProps<typeof progressIndicatorVariants>) {
  const percent =
    typeof value === "number" && max > 0
      ? Math.min(100, Math.max(0, (value / max) * 100))
      : 0;

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-tone={tone}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      value={value}
      max={max}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={progressIndicatorVariants({ tone })}
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress, progressIndicatorVariants };
