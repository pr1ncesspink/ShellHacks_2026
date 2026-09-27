import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { allowLocalPreview } from "@/lib/local-preview";

export function proxy(request: NextRequest) {
  if (allowLocalPreview(process.env, request.headers.get("host"), request.headers.get("x-forwarded-host"))) {
    return NextResponse.next();
  }
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const signIn = new URL("/", request.url);
  signIn.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ["/dashboard/:path*", "/budget/:path*", "/profile/:path*"],
};
