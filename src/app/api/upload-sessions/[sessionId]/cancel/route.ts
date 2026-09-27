import { NextRequest, NextResponse } from "next/server";
import { parseSessionState } from "@/lib/upload-sessions";
import { sessionPath } from "@/lib/upload-proxy";
import { forward, guard, readSmallJson } from "../../guard";

/**
 * Stop a session everywhere. The backend always answers 200 with the session
 * view (status "cancelled", or the unchanged terminal status).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  const path = sessionPath((await params).sessionId, "cancel");
  if (!path) return NextResponse.json({ error: "Invalid session id" }, { status: 422 });
  const body = await readSmallJson(request);
  if (body instanceof NextResponse) return body;
  return forward(context, { path, init: { method: "POST" }, parse: parseSessionState });
}
