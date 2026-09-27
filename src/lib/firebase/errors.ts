export type AuthOperation = "sign-in" | "sign-up" | "verification";

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "");
}

export function authErrorMessage(
  error: unknown,
  operation: AuthOperation,
): string {
  const code = errorCode(error);
  if (operation === "sign-in") {
    if (
      [
        "auth/invalid-credential",
        "auth/user-not-found",
        "auth/wrong-password",
        "auth/invalid-email",
        "auth/user-disabled",
      ].includes(code)
    ) {
      return "We couldn’t sign you in with that email and password.";
    }
  }
  if (code === "auth/email-already-in-use") {
    return "An account already uses that email. Try signing in instead.";
  }
  if (code === "auth/weak-password") {
    return "Choose a stronger password with at least six characters.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Wait a moment, then try again.";
  }
  if (code === "auth/network-request-failed") {
    return "We couldn’t reach Firebase. Check your connection and try again.";
  }
  if (operation === "verification") {
    return "We couldn’t complete verification. Try again in a moment.";
  }
  if (operation === "sign-up") {
    return "We couldn’t create your account. Check the details and try again.";
  }
  return "We couldn’t sign you in. Try again.";
}
