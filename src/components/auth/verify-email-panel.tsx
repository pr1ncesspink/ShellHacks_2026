"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, MailCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { sendEmailVerification, updateProfile } from "firebase/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { beginExplicitAuthAction } from "@/lib/auth-sync";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { authErrorMessage } from "@/lib/firebase/errors";
import { postSession } from "@/lib/firebase/session-client";
import { clearVerificationEmailPending } from "@/lib/firebase/verification-state";
import {
  confirmVerifiedEmail,
  resendVerificationWithProfileRecovery,
} from "@/lib/verification-flow";

const SENDER_DOMAIN = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim();

export function VerifyEmailPanel({
  email,
  nextPath,
  initialCooldownSeconds = 0,
  initialNotice = "",
  pendingDisplayName,
}: {
  email?: string;
  nextPath: string;
  initialCooldownSeconds?: number;
  initialNotice?: string;
  pendingDisplayName?: string;
}) {
  const [cooldown, setCooldown] = useState(initialCooldownSeconds);
  const [busy, setBusy] = useState<"resend" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(initialNotice);
  const [profileName, setProfileName] = useState(pendingDisplayName);
  const [profileWarning, setProfileWarning] = useState("");
  const [currentEmail, setCurrentEmail] = useState<string>();
  const knownEmail = email || currentEmail;
  // Once a full-page navigation starts, keep the buttons disabled.
  const navigating = useRef(false);

  useEffect(() => {
    if (email) return;
    let disposed = false;
    void getFirebaseAuth()
      .then(async (auth) => {
        await auth.authStateReady();
        if (!disposed && auth.currentUser?.email) {
          setCurrentEmail(auth.currentUser.email);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [email]);

  function navigate(path: string) {
    navigating.current = true;
    window.location.replace(path);
  }

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(
      () => setCooldown((seconds) => Math.max(0, seconds - 1)),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function handleResend() {
    if (busy || cooldown > 0) return;
    setBusy("resend");
    setError("");
    setNotice("");
    try {
      const auth = await getFirebaseAuth();
      if (!auth.currentUser) {
        navigate("/");
        return;
      }
      const user = auth.currentUser;
      const result = await resendVerificationWithProfileRecovery({
        syncProfile: profileName
          ? () => updateProfile(user, { displayName: profileName })
          : undefined,
        sendVerification: () => sendEmailVerification(user),
      });
      if (result.profileSynced) {
        setProfileName(undefined);
        setProfileWarning("");
      } else {
        setProfileWarning(
          result.verificationSent
            ? "Your verification email was sent, but your display name still needs to sync."
            : "Your display name also still needs to sync.",
        );
      }
      if (!result.verificationSent) {
        setError(authErrorMessage(result.verificationError, "verification"));
        return;
      }
      setCooldown(60);
      setNotice("A new verification link is on its way.");
    } catch (caught) {
      setError(authErrorMessage(caught, "verification"));
    } finally {
      if (!navigating.current) setBusy(null);
    }
  }

  async function handleVerified() {
    if (busy) return;
    setBusy("verify");
    setError("");
    setNotice("");
    const finish = beginExplicitAuthAction();
    try {
      const auth = await getFirebaseAuth();
      const user = auth.currentUser;
      if (!user) {
        navigate("/");
        return;
      }
      const result = await confirmVerifiedEmail({
        reload: () => user.reload(),
        isVerified: () => user.emailVerified,
        syncProfile: profileName
          ? async () => {
              await updateProfile(user, { displayName: profileName });
              setProfileName(undefined);
              setProfileWarning("");
            }
          : undefined,
        createSession: async () => {
          const token = await user.getIdToken(true);
          await postSession(token);
        },
        onProfileFailure: () =>
          setProfileWarning(
            "Your email is verified. Your display name can be synced later.",
          ),
        onVerified: () => {
          clearVerificationEmailPending();
          navigate(nextPath);
        },
      });
      if (result === "unverified") {
        setNotice("That email is not verified yet. Use the link, then try again.");
        return;
      }
    } catch (caught) {
      setError(authErrorMessage(caught, "verification"));
    } finally {
      finish();
      if (!navigating.current) setBusy(null);
    }
  }

  return (
    <Card className="login-card panel">
      <div className="login-card-top">
        <span className="icon-tile blue">
          <MailCheck size={24} aria-hidden="true" />
        </span>
        <Badge variant="outline" className="muted-badge">
          EMAIL VERIFICATION
        </Badge>
      </div>
      <h2>Check your inbox.</h2>
      <p>
        We sent Firebase’s verification link
        {knownEmail ? ` to ${knownEmail}` : " to your email address"}.
      </p>
      <div className="auth-step">
        <span className="step-number">01</span>
        <div>
          <h3>Open the verification email</h3>
          <p>Use the link in the message to confirm your address.</p>
          <p>
            Don’t see it? Check your spam or junk folder
            {SENDER_DOMAIN
              ? ` — it comes from noreply@${SENDER_DOMAIN}.`
              : "."}
          </p>
        </div>
        <MailCheck size={17} aria-hidden="true" />
      </div>
      <div className="auth-step second-step">
        <span className="step-number">02</span>
        <div>
          <h3>Return here</h3>
          <p>Then ask GridLens to check your verified status.</p>
        </div>
        <ShieldCheck size={17} aria-hidden="true" />
      </div>
      {error ? (
        <p className="auth-feedback error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="auth-feedback" role="status">
          {notice}
        </p>
      ) : null}
      {profileWarning ? (
        <p className="auth-feedback" role="status">
          {profileWarning}
        </p>
      ) : null}
      <div className="verification-actions">
        <Button onClick={handleVerified} disabled={Boolean(busy)}>
          {busy === "verify" ? "Checking…" : "I’ve verified"}
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleResend}
          disabled={Boolean(busy) || cooldown > 0}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {busy === "resend"
            ? "Sending…"
            : cooldown > 0
              ? `Resend in ${cooldown}s`
              : "Resend email"}
        </Button>
      </div>
      <p className="account-switch">
        Need a different account?{" "}
        <SignOutButton variant="link" className="auth-switch-account">
          Use another account
        </SignOutButton>
      </p>
    </Card>
  );
}
