let verificationEmailPending = false;
let verificationRecoveryVisible = false;

export function markVerificationEmailPending(): void {
  verificationEmailPending = true;
}

export function clearVerificationEmailPending(): void {
  verificationEmailPending = false;
}

export function establishVerificationRecovery(): () => void {
  verificationEmailPending = false;
  verificationRecoveryVisible = true;
  return () => {
    verificationRecoveryVisible = false;
  };
}

function shouldHoldVerificationRedirect(pathname: string): boolean {
  return (
    pathname === "/signup" &&
    (verificationEmailPending || verificationRecoveryVisible)
  );
}

export function shouldStayForEmailVerification(pathname: string): boolean {
  return pathname === "/verify-email" || shouldHoldVerificationRedirect(pathname);
}

export function verificationCompletionAction(
  formMounted: boolean,
): "show-recovery" | "redirect" {
  return formMounted ? "show-recovery" : "redirect";
}
