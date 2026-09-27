import { NextRequest, NextResponse } from "next/server";
import { parseSessionState } from "@/lib/upload-sessions";
import { sessionPath } from "@/lib/upload-proxy";
import { forward, guard } from "../guard";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  const path = sessionPath((await params).sessionId);
  if (!path) return NextResponse.json({ error: "Invalid session id" }, { status: 422 });
  return forward(context, { path, init: { method: "GET" }, parse: parseSessionState });
}
