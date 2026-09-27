// Server-side proxy helper for /api/upload-sessions/*. Deliberately free of
// next/server and server-only imports so node tests can exercise it directly.
import { buildBackendHeaders, type BackendConfig } from "./backend-config.ts";
import { SESSION_ID } from "./upload-sessions.ts";

export type LiveBackendConfig = Extract<BackendConfig, { mode: "live" }>;
export type ProxyResult = { status: number; body: unknown };

export type ProxyOptions = {
  config: LiveBackendConfig;
  /** Authenticated user id; null only in local preview, where no auth headers are sent. */
  uid: string | null;
  /** Google ID token when config.auth is google-oidc. */
  token?: string;
  /** Path relative to BACKEND_URL, e.g. "projects/upload-sessions". */
  path: string;
  init?: { method: "GET" | "POST"; body?: unknown };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  parse: (value: unknown) => unknown;
  onAuthReject?: () => void;
};

const PASS_THROUGH: Record<number, string> = {
  404: "Upload session not found.",
  409: "The PDF has not finished uploading.",
  422: "The upload request or PDF was rejected.",
  503: "Upload processing is not configured.",
};
const UNAVAILABLE = "Upload backend unavailable. Try again shortly.";

/** Backend path for a session, or null when the id is not a valid session id. */
export function sessionPath(id: string, action?: "process"): string | null {
  if (!SESSION_ID.test(id)) return null;
  return `projects/upload-sessions/${id}${action ? `/${action}` : ""}`;
}

export async function proxyBackend(options: ProxyOptions): Promise<ProxyResult> {
  const { config, uid, token, path, init = { method: "GET" }, timeoutMs = 30_000, parse, onAuthReject } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (path.startsWith("/") || path.includes("..") || path.includes("//") || /[?#\\]/.test(path)) {
    throw new Error("Invalid backend path");
  }
  if (config.auth === "google-oidc" && (!uid || !token)) throw new Error("Missing backend credentials");
  const headers: Record<string, string> = uid ? buildBackendHeaders(uid, token) : { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetchImpl(new URL(path, config.url), {
      method: init.method,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { status: 502, body: { error: UNAVAILABLE } };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) onAuthReject?.();
    const message = PASS_THROUGH[response.status];
    return message
      ? { status: response.status, body: { error: message } }
      : { status: 502, body: { error: UNAVAILABLE } };
  }
  try {
    return { status: response.status, body: parse(await response.json()) };
  } catch {
    return { status: 502, body: { error: UNAVAILABLE } };
  }
}
