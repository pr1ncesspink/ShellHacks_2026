import "server-only";

import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { SessionUser } from "../session-exchange";

function adminAuth() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) throw new Error("Missing FIREBASE_PROJECT_ID");
  const app = getApps().length ? getApp() : initializeApp({ projectId });
  return getAuth(app);
}

export async function verifyUser(idToken: string): Promise<SessionUser> {
  const token = await adminAuth().verifyIdToken(idToken);
  return {
    uid: token.uid,
    email: token.email ?? null,
    name: typeof token.name === "string" ? token.name : null,
    emailVerified: token.email_verified === true,
    exp: token.exp,
  };
}
