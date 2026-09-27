"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main-content" className="error-page">
      <h1>Something interrupted the view.</h1>
      <p>Please try loading the workspace again.</p>
      <Button onClick={reset}>Try again</Button>
      <Link href="/">Back to login preview</Link>
    </main>
  );
}
