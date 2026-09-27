import { NextRequest, NextResponse } from "next/server";
import { isLocalPreview } from "@/lib/server/local-preview";
import { getUser } from "@/lib/server/session";
import { isSameOrigin } from "@/lib/session";
import { readBackendConfig, buildBackendHeaders } from "@/lib/backend-config";
import { getGoogleIdToken } from "@/lib/server/google-id-token";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request.headers.get("origin"), request.url, request.headers.get("host"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const preview = await isLocalPreview();
  const user = preview ? null : await getUser();
  if (!preview && !user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const config = readBackendConfig(process.env);
  if (config.mode !== "live" || (preview && (config.auth !== "none" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.url).hostname)))) {
    return NextResponse.json({ error: "Map backend is not configured for this session." }, { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > 2_000_000) return NextResponse.json({ error: "Too many project details" }, { status: 413 });
  let body: { projects?: unknown[] };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || !Array.isArray(body.projects) || !body.projects.length || body.projects.length > 500) {
    return NextResponse.json({ error: "Provide 1–500 project locations." }, { status: 422 });
  }
  try {
    const token = config.auth === "google-oidc" ? await getGoogleIdToken(config) : undefined;
    const response = await fetch(new URL("projects/map-analysis", config.url), {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(30000),
      headers: { ...(user ? buildBackendHeaders(user.uid, token) : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return NextResponse.json({ error: "Backend could not analyze these locations." }, { status: response.status === 422 ? 422 : 502 });
    return NextResponse.json(await response.json());
  } catch {
    return NextResponse.json({ error: "Map backend unavailable. Check that it is running, then retry." }, { status: 502 });
  }
}
