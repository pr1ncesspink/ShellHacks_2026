import "server-only";

import { getVercelOidcToken } from "@vercel/oidc";
import { ExternalAccountClient, Impersonated } from "google-auth-library";
import type { GoogleOidcBackendConfig } from "../backend-config";
import { createIdTokenCache } from "../id-token-cache";

// Refresh five minutes before the token expires.
const tokenCache = createIdTokenCache((token) => tokenExpiry(token) - 300);

/**
 * Drop the cached token after Cloud Run rejects it (401/403) so the next
 * request mints a fresh one. A new token does not fix missing invoker IAM.
 */
export function invalidateGoogleIdToken(): void {
  tokenCache.invalidate();
}

function tokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Google ID token has no payload");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    exp?: unknown;
  };
  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) {
    throw new Error("Google ID token has no expiry");
  }
  return value.exp;
}

async function mintToken(config: GoogleOidcBackendConfig): Promise<string> {
  const workloadAudience =
    `//iam.googleapis.com/projects/${config.projectNumber}` +
    `/locations/global/workloadIdentityPools/${config.workloadIdentityPoolId}` +
    `/providers/${config.workloadIdentityPoolProviderId}`;
  const sourceClient = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: workloadAudience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    subject_token_supplier: {
      getSubjectToken: async () => getVercelOidcToken(),
    },
  });
  if (!sourceClient) throw new Error("Unable to create external account client");

  const impersonated = new Impersonated({
    sourceClient,
    targetPrincipal: config.serviceAccountEmail,
    targetScopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return impersonated.fetchIdToken(new URL(config.url).origin, {
    includeEmail: true,
  });
}

export async function getGoogleIdToken(
  config: GoogleOidcBackendConfig,
): Promise<string> {
  const key = [
    new URL(config.url).origin,
    config.projectNumber,
    config.workloadIdentityPoolId,
    config.workloadIdentityPoolProviderId,
    config.serviceAccountEmail,
  ].join("|");
  const now = Math.floor(Date.now() / 1000);
  return tokenCache.get(key, now, () => mintToken(config));
}
