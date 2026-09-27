import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { isLocalPreview } from "@/lib/server/local-preview";
import { getUser } from "@/lib/server/session";
import { isSameOrigin } from "@/lib/session";
import { readBackendConfig } from "@/lib/backend-config";
import { getGoogleIdToken, invalidateGoogleIdToken } from "@/lib/server/google-id-token";
import { proxyBackend, type LiveBackendConfig, type ProxyOptions } from "@/lib/upload-proxy";

export const MAX_JSON_BODY = 1024;

type Context = { config: LiveBackendConfig; uid: string | null };

/**
 * Same guards as /api/map-analysis. Same-origin GETs may omit Origin, so a GET
 * without one is accepted only when the browser marks it same-origin.
 */
export async function guard(request: NextRequest): Promise<Context | NextResponse> {
  const origin = request.headers.get("origin");
  const sameOrigin = origin === null && request.method === "GET"
    ? request.headers.get("sec-fetch-site") === "same-origin"
    : isSameOrigin(origin, request.url, request.headers.get("host"));
  if (!sameOrigin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const preview = await isLocalPreview();
  const user = preview ? null : await getUser();
  if (!preview && !user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const config = readBackendConfig(process.env);
  if (config.mode !== "live" || (preview && (config.auth !== "none" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.url).hostname)))) {
    return NextResponse.json({ error: "Upload backend is not configured for this session." }, { status: 503 });
  }
  return { config, uid: user ? user.uid : null };
}

/** Read a small JSON body; null means empty. Returns a response on rejection. */
export async function readSmallJson(request: NextRequest): Promise<{ value: unknown } | NextResponse> {
  const raw = await request.text();
  if (raw.length > MAX_JSON_BODY) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  if (!raw.trim()) return { value: null };
  try { return { value: JSON.parse(raw) }; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
}

export async function forward(
  context: Context,
  options: Pick<ProxyOptions, "path" | "init" | "parse" | "messages">,
): Promise<NextResponse> {
  try {
    const token = context.config.auth === "google-oidc" ? await getGoogleIdToken(context.config) : undefined;
    const result = await proxyBackend({
      ...options, config: context.config, uid: context.uid, token, timeoutMs: 30_000,
      onAuthReject: invalidateGoogleIdToken,
    });
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Upload backend unavailable. Try again shortly." }, { status: 502 });
  }
}
