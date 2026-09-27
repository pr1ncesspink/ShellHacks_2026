export async function syncSessionIdentity({
  previousUid,
  currentUid,
  protectedPath,
  clearSession,
  writeSession,
  onSignedOut,
  onIdentityChanged,
  onInitialProtectedIdentity,
}: {
  previousUid: string | null | undefined;
  currentUid: string | null;
  protectedPath: boolean;
  clearSession: () => Promise<void>;
  writeSession: () => Promise<void>;
  onSignedOut: () => void;
  onIdentityChanged: () => void;
  onInitialProtectedIdentity: () => void;
}): Promise<string | null> {
  if (currentUid === null) {
    await clearSession();
    if (protectedPath) onSignedOut();
    return null;
  }

  await writeSession();
  if (protectedPath) {
    if (previousUid === undefined) {
      onInitialProtectedIdentity();
    } else if (previousUid !== currentUid) {
      onIdentityChanged();
    }
  }
  return currentUid;
}
