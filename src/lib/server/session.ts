import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, safeNext } from "../session";
import { verifyUser } from "./firebase-admin";
import type { SessionUser } from "../session-exchange";

export async function getUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  if (!process.env.FIREBASE_PROJECT_ID?.trim()) {
    console.error("[auth] FIREBASE_PROJECT_ID is not configured");
    return null;
  }
  try {
    const user = await verifyUser(token);
    if (!user.emailVerified || user.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

export async function requireUser(nextPath: string): Promise<SessionUser> {
  const user = await getUser();
  if (!user) {
    redirect(`/?next=${encodeURIComponent(safeNext(nextPath))}`);
  }
  return user;
}
