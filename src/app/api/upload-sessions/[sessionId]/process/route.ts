import { NextRequest, NextResponse } from "next/server";
import { parseProcessResult } from "@/lib/upload-sessions";
import { sessionPath } from "@/lib/upload-proxy";
import { forward, guard, readSmallJson } from "../../guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  const path = sessionPath((await params).sessionId, "process");
  if (!path) return NextResponse.json({ error: "Invalid session id" }, { status: 422 });
  const body = await readSmallJson(request);
  if (body instanceof NextResponse) return body;
  return forward(context, { path, init: { method: "POST" }, parse: parseProcessResult });
}
