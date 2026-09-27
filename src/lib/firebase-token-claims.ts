import type { SessionUser } from "./session-exchange.ts";

/** Firebase ID tokens are always RS256 with a key id; reject anything else before verifying. */
export function assertFirebaseTokenHeader(idToken: string): void {
  const [encodedHeader] = idToken.split(".");
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(
      Buffer.from(encodedHeader ?? "", "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("Firebase ID token has an invalid header");
  }
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new Error("Firebase ID token has an invalid header");
  }
}

/** Checks Firebase-specific ID-token claims after the signature, aud, iss, and exp are verified. */
export function sessionUserFromClaims(
  claims: Record<string, unknown>,
  now: number,
): SessionUser {
  const { sub, exp, auth_time: authTime } = claims;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) {
    throw new Error("Firebase ID token has an invalid subject");
  }
  if (typeof exp !== "number" || exp <= now) {
    throw new Error("Firebase ID token has expired");
  }
  if (typeof authTime !== "number" || authTime > now + 300) {
    throw new Error("Firebase ID token has an invalid auth_time");
  }
  return {
    uid: sub,
    email: typeof claims.email === "string" ? claims.email : null,
    name: typeof claims.name === "string" ? claims.name : null,
    emailVerified: claims.email_verified === true,
    exp,
  };
}
