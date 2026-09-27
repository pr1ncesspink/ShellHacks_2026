import type { ReactNode } from "react";

/** Page title block shared by the workspace pages (dashboard, summary, budget). */
export function PageHeading({
  section,
  title,
  description,
  children,
}: {
  section: string;
  title: string;
  description?: string;
  /** Optional trailing content, e.g. a badge or action. */
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="breadcrumb">
          Workspace <span aria-hidden="true">/</span> {section}
        </p>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
