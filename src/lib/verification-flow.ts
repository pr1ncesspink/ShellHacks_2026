export async function resendVerificationWithProfileRecovery({
  syncProfile,
  sendVerification,
}: {
  syncProfile?: () => Promise<void>;
  sendVerification: () => Promise<void>;
}): Promise<{
  profileSynced: boolean;
  verificationSent: boolean;
  verificationError?: unknown;
}> {
  let profileSynced = true;
  if (syncProfile) {
    try {
      await syncProfile();
    } catch {
      profileSynced = false;
    }
  }
  try {
    await sendVerification();
    return { profileSynced, verificationSent: true };
  } catch (verificationError) {
    return { profileSynced, verificationSent: false, verificationError };
  }
}

export async function confirmVerifiedEmail({
  reload,
  isVerified,
  syncProfile,
  createSession,
  onProfileFailure,
  onVerified,
}: {
  reload: () => Promise<void>;
  isVerified: () => boolean;
  syncProfile?: () => Promise<void>;
  createSession: () => Promise<void>;
  onProfileFailure: () => void;
  onVerified: () => void;
}): Promise<"unverified" | "verified"> {
  await reload();
  if (!isVerified()) return "unverified";
  if (syncProfile) {
    try {
      await syncProfile();
    } catch {
      onProfileFailure();
    }
  }
  await createSession();
  onVerified();
  return "verified";
}
