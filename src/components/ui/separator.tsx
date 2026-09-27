import * as React from "react";
import { cn } from "@/lib/utils";

type SeparatorProps = React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical";
  /** Purely visual rule (role="none"). Set false for a semantic separator. */
  decorative?: boolean;
};

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: SeparatorProps) {
  const semantics = decorative
    ? { role: "none" as const }
    : {
        role: "separator" as const,
        // separator defaults to horizontal; only vertical needs stating.
        "aria-orientation":
          orientation === "vertical" ? ("vertical" as const) : undefined,
      };

  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      {...semantics}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
