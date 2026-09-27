import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main-content" className="error-page">
      <span className="eyebrow">404 / OUTSIDE THE GRID</span>
      <h1>This page isn’t in the plan.</h1>
      <Link href="/dashboard" className="subtle-link">
        Return to the dashboard →
      </Link>
    </main>
  );
}
