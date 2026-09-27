"use client";

import type { ComponentProps } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "firebase/auth";
import { Button } from "@/components/ui/button";
import {
  beginExplicitAuthAction,
  cancelAuthSyncRequests,
} from "@/lib/auth-sync";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { deleteSession } from "@/lib/firebase/session-client";
import { clearVerificationEmailPending } from "@/lib/firebase/verification-state";

export function SignOutButton({
  children,
  ...props
}: ComponentProps<typeof Button>) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function handleSignOut() {
    if (busy) return;
    setBusy(true);
    const finish = beginExplicitAuthAction();
    cancelAuthSyncRequests();
    try {
      const auth = await getFirebaseAuth();
      await signOut(auth);
    } catch {
      // The server session is still cleared if the client SDK is unavailable.
    }
    try {
      await deleteSession();
    } catch {
      // The session cookie is httpOnly, so let the server re-evaluate it:
      // protected routes redirect to sign-in if the cookie is still invalid.
      finish();
      window.location.replace("/");
      return;
    }
    clearVerificationEmailPending();
    finish();
    router.replace("/");
    router.refresh();
  }

  return (
    <Button {...props} type="button" onClick={handleSignOut} disabled={busy}>
      {children ?? (
        <>
          <LogOut size={16} aria-hidden="true" />
          {busy ? "Signing out…" : "Sign out"}
        </>
      )}
    </Button>
  );
}
