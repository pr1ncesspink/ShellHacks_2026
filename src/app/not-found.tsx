import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default function NotFound() {
  return (
    <main id="main-content" className="error-page">
      <p className="eyebrow">Page not found</p>
      <h1>We couldn’t find that page.</h1>
      <p className="text-muted-foreground">
        The link may be out of date, or the page may have moved.
      </p>
      <Link href="/dashboard" className="subtle-link">
        Go to the dashboard <ArrowRight size={16} aria-hidden="true" />
      </Link>
    </main>
  );
}
