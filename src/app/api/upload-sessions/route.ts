import { NextRequest, NextResponse } from "next/server";
import { MAX_UPLOAD_BYTES, parseCreatedSession } from "@/lib/upload-sessions";
import { forward, guard, readSmallJson } from "./guard";

export async function POST(request: NextRequest) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  const body = await readSmallJson(request);
  if (body instanceof NextResponse) return body;
  const size = (body.value as { size_bytes?: unknown } | null)?.size_bytes;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "PDFs must be between 1 byte and 50 MB." }, { status: 422 });
  }
  return forward(context, {
    path: "projects/upload-sessions",
    init: { method: "POST", body: { size_bytes: size } },
    parse: parseCreatedSession,
  });
}
