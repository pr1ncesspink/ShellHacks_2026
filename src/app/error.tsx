"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main-content" className="error-page">
      <h1>Something went wrong.</h1>
      <p className="text-muted-foreground">
        This page didn’t load properly. Try again, or head back to sign in.
      </p>
      <Button size="touch" onClick={reset}>
        Try again
      </Button>
      <Link href="/" className="subtle-link">
        Back to sign in
      </Link>
    </main>
  );
}
