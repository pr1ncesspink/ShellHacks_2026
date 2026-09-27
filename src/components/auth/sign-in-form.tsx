"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { beginExplicitAuthAction } from "@/lib/auth-sync";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { authErrorMessage } from "@/lib/firebase/errors";
import { deleteSession, postSession } from "@/lib/firebase/session-client";

const RESET_CONFIRMATION =
  "If an account exists for that email, a password reset link is on its way.";

export function SignInForm({ nextPath }: { nextPath: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError("");
    setNotice("");
    const finish = beginExplicitAuthAction();
    try {
      const auth = await getFirebaseAuth();
      const credential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );
      if (!credential.user.emailVerified) {
        await deleteSession().catch(() => undefined);
        window.location.replace(
          `/verify-email?next=${encodeURIComponent(nextPath)}`,
        );
        return;
      }
      const token = await credential.user.getIdToken(true);
      try {
        await postSession(token);
      } catch (sessionError) {
        // Do not leave the client signed in without a server session.
        await signOut(auth).catch(() => undefined);
        throw sessionError;
      }
      window.location.replace(nextPath);
    } catch (caught) {
      setError(authErrorMessage(caught, "sign-in"));
      setBusy(false);
    } finally {
      finish();
    }
  }

  async function handlePasswordReset() {
    if (resetBusy) return;
    setNotice("");
    if (!email.trim()) {
      setError("Enter your email to reset your password.");
      document.getElementById("email")?.focus();
      return;
    }
    setResetBusy(true);
    setError("");
    try {
      const auth = await getFirebaseAuth();
      await sendPasswordResetEmail(auth, email.trim());
    } catch {
      // Always use the same response so account existence is never disclosed.
    } finally {
      setNotice(RESET_CONFIRMATION);
      setResetBusy(false);
    }
  }

  return (
    <Card className="login-card panel">
      <div className="login-card-top">
        <Badge variant="outline" className="muted-badge">
          Secure sign-in
        </Badge>
      </div>
      <h2>Your workspace awaits.</h2>
      <p>Sign in, then confirm your verified email.</p>
      <form onSubmit={handleSubmit}>
        <div className="auth-step">
          <span className="step-number">01</span>
          <div>
            <h3>Sign in to GridLens</h3>
            <p>Your email and password.</p>
          </div>
          <LockKeyhole size={16} aria-hidden="true" />
        </div>
        <div className="auth-fields">
          <label htmlFor="email">Email</label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com…"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sign-in-error" : undefined}
            required
          />
          <div className="auth-label-row">
            <label htmlFor="password">Password</label>
            <button
              type="button"
              className="auth-inline-button"
              onClick={handlePasswordReset}
              disabled={resetBusy}
            >
              {resetBusy ? "Sending…" : "Forgot password?"}
            </button>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your password…"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sign-in-error" : undefined}
            required
          />
        </div>
        <div className="auth-step second-step">
          <span className="step-number">02</span>
          <div>
            <h3>Verify your email</h3>
            <p>Workspace access begins after you use Firebase’s email link.</p>
          </div>
          <ShieldCheck size={16} aria-hidden="true" />
        </div>
        <div className="auth-notice">
          <LockKeyhole size={16} aria-hidden="true" />
          <span>Your workspace stays locked until your email is verified.</span>
        </div>
        {error ? (
          <p id="sign-in-error" className="auth-feedback error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="auth-feedback" role="status">
            {notice}
          </p>
        ) : null}
        <Button type="submit" className="preview-button" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </form>
      <p className="account-switch">
        New to GridLens?{" "}
        <Link href="/signup">
          Create an account <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </p>
    </Card>
  );
}
