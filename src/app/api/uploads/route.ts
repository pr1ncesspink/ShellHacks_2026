import { NextRequest, NextResponse } from "next/server";
import { UPLOADS_BACKEND_PATH, parseRecentUploads } from "@/lib/upload-summary";
import { UPLOAD_ROUTE_MESSAGES } from "@/lib/upload-proxy";
import { forward, guard } from "../upload-sessions/guard";

/** The signed-in user's recent uploads (owner-scoped by the backend). */
export async function GET(request: NextRequest) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  return forward(context, { path: UPLOADS_BACKEND_PATH, init: { method: "GET" }, parse: parseRecentUploads, messages: UPLOAD_ROUTE_MESSAGES });
}
