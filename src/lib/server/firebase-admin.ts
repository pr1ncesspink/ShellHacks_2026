import "server-only";

import { OAuth2Client } from "google-auth-library";
import {
  assertFirebaseTokenHeader,
  sessionUserFromClaims,
} from "../firebase-token-claims";
import type { SessionUser } from "../session-exchange";

// Verifies Firebase ID tokens against Google's published signing certificates.
// firebase-admin is deliberately not used: its jwks-rsa -> jose chain require()s
// an ES module and crashes on Vercel's Node runtime (ERR_REQUIRE_ESM).
const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

type Certs = Record<string, string>;
let cachedCerts: { certs: Certs; expiresAt: number } | null = null;
const client = new OAuth2Client();

async function signingCerts(now: number): Promise<Certs> {
  if (cachedCerts && cachedCerts.expiresAt > now) return cachedCerts.certs;
  const response = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Unable to fetch Firebase signing certificates");
  const certs = (await response.json()) as Certs;
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
  cachedCerts = { certs, expiresAt: now + (maxAge ? Number(maxAge[1]) : 3600) };
  return certs;
}

export async function verifyUser(idToken: string): Promise<SessionUser> {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) throw new Error("Missing FIREBASE_PROJECT_ID");
  assertFirebaseTokenHeader(idToken);
  const now = Math.floor(Date.now() / 1000);
  const certs = await signingCerts(now);
  let claims;
  try {
    const ticket = await client.verifySignedJwtWithCertsAsync(
      idToken,
      certs,
      projectId,
      [`https://securetoken.google.com/${projectId}`],
    );
    claims = ticket.getPayload();
  } catch {
    // The library's messages embed the raw token; never let them propagate.
    throw new Error("Invalid Firebase ID token");
  }
  if (!claims) throw new Error("Firebase ID token has no payload");
  return sessionUserFromClaims(claims as unknown as Record<string, unknown>, now);
}
