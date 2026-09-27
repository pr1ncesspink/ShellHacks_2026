"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { authErrorMessage } from "@/lib/firebase/errors";
import {
  clearVerificationEmailPending,
  establishVerificationRecovery,
  markVerificationEmailPending,
  verificationCompletionAction,
} from "@/lib/firebase/verification-state";
import { runSignUpFlow } from "@/lib/signup-flow";
import { VerifyEmailPanel } from "./verify-email-panel";

type VerificationRecovery = {
  email: string;
  name?: string;
  cooldown: number;
  notice?: string;
};

export function SignUpForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<VerificationRecovery | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearVerificationEmailPending();
    };
  }, []);

  useEffect(() => {
    if (!recovery) return;
    return establishVerificationRecovery();
  }, [recovery]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!name) {
      setError("Enter your full name.");
      return;
    }
    setBusy(true);
    setError("");
    markVerificationEmailPending();
    try {
      const auth = await getFirebaseAuth();
      const result = await runSignUpFlow<User>({
        createUser: async () =>
          (await createUserWithEmailAndPassword(auth, email, password)).user,
        updateUserProfile: (user) => updateProfile(user, { displayName: name }),
        sendVerification: (user) => sendEmailVerification(user),
      });
      const issues = [];
      if (!result.profileUpdated) {
        issues.push(
          "Your account was created, but your display name still needs to sync.",
        );
      }
      if (!result.verificationSent) {
        issues.push(
          "The first verification email was not sent. Use Resend email below.",
        );
      }
      if (verificationCompletionAction(mounted.current) === "redirect") {
        window.location.replace("/verify-email?next=%2Fdashboard");
        return;
      }
      setRecovery({
        email,
        name: result.profileUpdated ? undefined : name,
        cooldown: result.verificationSent ? 60 : 0,
        notice: issues.join(" ") || undefined,
      });
    } catch (caught) {
      clearVerificationEmailPending();
      if (mounted.current) {
        setError(authErrorMessage(caught, "sign-up"));
        setBusy(false);
      }
    }
  }

  if (recovery) {
    return (
      <VerifyEmailPanel
        email={recovery.email}
        nextPath="/dashboard"
        initialCooldownSeconds={recovery.cooldown}
        initialNotice={recovery.notice}
        pendingDisplayName={recovery.name}
      />
    );
  }

  return (
    <Card className="login-card panel">
      <div className="login-card-top">
        <span className="icon-tile violet">
          <UserPlus size={23} aria-hidden="true" />
        </span>
        <Badge variant="outline" className="muted-badge">
          OPEN SIGN-UP
        </Badge>
      </div>
      <h2>Create your account.</h2>
      <p>Your home for connected project planning.</p>
      <form onSubmit={handleSubmit}>
        <div className="auth-fields">
          <label htmlFor="signup-name">Full name</label>
          <Input
            id="signup-name"
            name="name"
            autoComplete="name"
            placeholder="Your full name…"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sign-up-error" : undefined}
            required
          />
          <label htmlFor="signup-email">Email</label>
          <Input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com…"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sign-up-error" : undefined}
            required
          />
          <label htmlFor="signup-password">Password</label>
          <Input
            id="signup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder="At least six characters…"
            minLength={6}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "sign-up-error password-help" : "password-help"}
            required
          />
          <p id="password-help" className="auth-field-help">
            Use at least six characters.
          </p>
        </div>
        <div className="auth-step second-step">
          <div>
            <h3>Next: verify your email</h3>
            <p>We’ll send Firebase’s verification link after sign-up.</p>
          </div>
          <ShieldCheck size={17} aria-hidden="true" />
        </div>
        <div className="auth-notice">
          <LockKeyhole size={14} aria-hidden="true" />
          <span>No workspace session is created before email verification.</span>
        </div>
        {error ? (
          <p id="sign-up-error" className="auth-feedback error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="preview-button" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </form>
      <p className="account-switch">
        Already have an account? <Link href="/">Sign in</Link>
      </p>
    </Card>
  );
}
