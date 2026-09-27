import { NextRequest, NextResponse } from "next/server";
import { parseUploadMap, uploadBackendPath } from "@/lib/upload-summary";
import { UPLOAD_ROUTE_MESSAGES } from "@/lib/upload-proxy";
import { forward, guard } from "../../../upload-sessions/guard";

/** Uploaded points plus nearest reference collisions for one upload, allow-listed. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ uploadId: string }> },
) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  const path = uploadBackendPath((await params).uploadId, "map");
  if (!path) return NextResponse.json({ error: UPLOAD_ROUTE_MESSAGES[422] }, { status: 422 });
  return forward(context, { path, init: { method: "GET" }, parse: parseUploadMap, messages: UPLOAD_ROUTE_MESSAGES });
}
