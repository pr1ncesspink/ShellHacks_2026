import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  cookieOptions,
  isSameOrigin,
  isSecureRequest,
} from "@/lib/session";
import { exchangeSession } from "@/lib/session-exchange";
import { verifyUser } from "@/lib/server/verify-firebase-token";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let idToken: unknown;
  try {
    const body = (await request.json()) as { idToken?: unknown };
    idToken = body.idToken;
  } catch {
    idToken = undefined;
  }

  const result = await exchangeSession({
    origin: request.headers.get("origin"),
    requestUrl: request.url,
    requestHost: request.headers.get("host"),
    idToken,
    now: Math.floor(Date.now() / 1000),
    secure: isSecureRequest(request.url),
    verifyUser,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 403 ? "Forbidden" : "Unauthorized" },
      { status: result.status },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, result.cookie.value, result.cookie.options);
  return response;
}

export function DELETE(request: NextRequest) {
  if (
    !isSameOrigin(
      request.headers.get("origin"),
      request.url,
      request.headers.get("host"),
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    "",
    cookieOptions(0, 0, isSecureRequest(request.url)),
  );
  return response;
}
