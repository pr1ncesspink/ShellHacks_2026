import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, safeNext } from "../session";
import { verifyUser } from "./verify-firebase-token";
import type { SessionUser } from "../session-exchange";
import { isLocalPreview } from "./local-preview";

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
  if (await isLocalPreview()) {
    return { uid: "local-design-preview", name: "Design preview", email: "preview@example.test", emailVerified: true, exp: Math.floor(Date.now() / 1000) + 3600 };
  }
  const user = await getUser();
  if (!user) {
    redirect(`/?next=${encodeURIComponent(safeNext(nextPath))}`);
  }
  return user;
}
