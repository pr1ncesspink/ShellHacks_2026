import { NextRequest, NextResponse } from "next/server";
import {
  MAX_BYTES_BY_KIND,
  UPLOAD_CONTENT_TYPES,
  kindFromContentType,
  parseCreatedSession,
} from "@/lib/upload-sessions";
import { forward, guard, readSmallJson } from "./guard";

const SIZE_ERRORS = {
  pdf: "PDFs must be between 1 byte and 50 MB.",
  csv: "CSV files must be between 1 byte and 10 MB.",
} as const;

export async function POST(request: NextRequest) {
  const context = await guard(request);
  if (context instanceof NextResponse) return context;
  const body = await readSmallJson(request);
  if (body instanceof NextResponse) return body;
  const fields = (body.value && typeof body.value === "object" ? body.value : {}) as { size_bytes?: unknown; content_type?: unknown };
  // Older clients send no content_type; they only ever uploaded PDFs.
  const kind = fields.content_type === undefined ? "pdf" : kindFromContentType(fields.content_type);
  if (!kind) return NextResponse.json({ error: "Only PDF and CSV files are supported." }, { status: 422 });
  const size = fields.size_bytes;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_BYTES_BY_KIND[kind]) {
    return NextResponse.json({ error: SIZE_ERRORS[kind] }, { status: 422 });
  }
  return forward(context, {
    path: "projects/upload-sessions",
    init: { method: "POST", body: { size_bytes: size, content_type: UPLOAD_CONTENT_TYPES[kind] } },
    parse: (value) => {
      const session = parseCreatedSession(value);
      if (session.required_headers["Content-Type"] !== UPLOAD_CONTENT_TYPES[kind]) throw new Error("Invalid required_headers");
      return session;
    },
  });
}
