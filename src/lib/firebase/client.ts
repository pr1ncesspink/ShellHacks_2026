"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

let authPromise: Promise<Auth> | null = null;

function firebaseConfig() {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim(),
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim(),
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim(),
  };
  const missing = Object.entries(config)
    .filter(([, configValue]) => !configValue)
    .map(([name]) => `NEXT_PUBLIC_FIREBASE_${name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}`);
  return config as Record<keyof typeof config, string>;
}

export function getFirebaseAuth(): Promise<Auth> {
  if (!authPromise) {
    authPromise = (async () => {
      const app = getApps().length ? getApp() : initializeApp(firebaseConfig());
      const auth = getAuth(app);
      await setPersistence(auth, browserLocalPersistence);
      return auth;
    })();
  }
  return authPromise;
}
