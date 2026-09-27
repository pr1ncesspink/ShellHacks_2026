export type BackendEnvironment = Record<string, string | undefined>;

export type GoogleOidcBackendConfig = {
  mode: "live";
  url: string;
  auth: "google-oidc";
  projectNumber: string;
  workloadIdentityPoolId: string;
  workloadIdentityPoolProviderId: string;
  serviceAccountEmail: string;
};

export type BackendConfig =
  | { mode: "example" }
  | { mode: "live"; url: string; auth: "none" }
  | GoogleOidcBackendConfig
  | { mode: "invalid"; missing: string[] };

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function value(env: BackendEnvironment, name: string): string {
  return env[name]?.trim() ?? "";
}

export function readBackendConfig(env: BackendEnvironment): BackendConfig {
  const rawUrl = value(env, "BACKEND_URL");
  if (!rawUrl) return { mode: "example" };

  let url: URL;
  try {
    url = new URL(rawUrl);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
      return { mode: "invalid", missing: ["BACKEND_URL"] };
    }
    if (url.username || url.password) {
      return { mode: "invalid", missing: ["BACKEND_URL"] };
    }
    // Relative endpoint paths resolve under the base, so keep any path prefix.
    if (!url.pathname.endsWith("/")) url.pathname += "/";
  } catch {
    return { mode: "invalid", missing: ["BACKEND_URL"] };
  }

  const auth = value(env, "BACKEND_AUTH");
  if (auth === "none") {
    return { mode: "live", url: url.href, auth };
  }
  if (auth !== "google-oidc") {
    return { mode: "invalid", missing: ["BACKEND_AUTH"] };
  }
  // Google ID tokens are bearer credentials; never send them over plain http.
  if (url.protocol !== "https:") {
    return { mode: "invalid", missing: ["BACKEND_URL"] };
  }

  const required = [
    "GCP_PROJECT_NUMBER",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
    "GCP_SERVICE_ACCOUNT_EMAIL",
  ] as const;
  const missing = required.filter((name) => !value(env, name));
  if (missing.length) return { mode: "invalid", missing: [...missing] };

  return {
    mode: "live",
    url: url.href,
    auth,
    projectNumber: value(env, "GCP_PROJECT_NUMBER"),
    workloadIdentityPoolId: value(env, "GCP_WORKLOAD_IDENTITY_POOL_ID"),
    workloadIdentityPoolProviderId: value(
      env,
      "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
    ),
    serviceAccountEmail: value(env, "GCP_SERVICE_ACCOUNT_EMAIL"),
  };
}

export function buildBackendHeaders(
  uid: string,
  idToken?: string,
): Record<string, string> {
  if (!UID_PATTERN.test(uid)) throw new Error("Invalid authenticated user id");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Authenticated-User": uid,
  };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return headers;
}
