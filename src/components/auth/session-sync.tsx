"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { onIdTokenChanged } from "firebase/auth";
import {
  beginAuthSyncRequest,
  cancelAuthSyncRequests,
  isExplicitAuthActionActive,
} from "@/lib/auth-sync";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { deleteSession, postSession } from "@/lib/firebase/session-client";
import { shouldStayForEmailVerification } from "@/lib/firebase/verification-state";
import { isProtectedPath, safeNext } from "@/lib/session";
import { syncSessionIdentity } from "@/lib/session-transition";

function currentDestination(): string {
  const url = new URL(window.location.href);
  if (url.pathname === "/") return safeNext(url.searchParams.get("next"));
  if (isProtectedPath(url.pathname)) return `${url.pathname}${url.search}`;
  return safeNext(url.searchParams.get("next"));
}

export function SessionSync() {
  const routePathname = usePathname();
  const router = useRouter();
  const pathnameRef = useRef(routePathname);
  const routerRef = useRef(router);
  const observedUid = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    pathnameRef.current = routePathname;
    // The token listener no longer re-runs on navigation, so re-apply the
    // unverified gate here without touching the session.
    let disposed = false;
    void getFirebaseAuth()
      .then((auth) => {
        const user = auth.currentUser;
        if (disposed || !user || user.emailVerified) return;
        if (isExplicitAuthActionActive()) return;
        if (shouldStayForEmailVerification(routePathname)) return;
        const next = encodeURIComponent(currentDestination());
        window.location.replace(`/verify-email?next=${next}`);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [routePathname]);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // Subscribe once per mount; soft navigations must not re-post the session.
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void getFirebaseAuth()
      .then((auth) => {
        if (disposed) return;
        unsubscribe = onIdTokenChanged(auth, async (user) => {
          if (isExplicitAuthActionActive()) return;
          const request = beginAuthSyncRequest();
          const pathname = pathnameRef.current;
          const protectedPath = isProtectedPath(pathname);
          const previousUid = observedUid.current;
          try {
            if (!user) {
              observedUid.current = await syncSessionIdentity({
                previousUid,
                currentUid: null,
                protectedPath,
                clearSession: () => deleteSession(request.signal),
                writeSession: async () => undefined,
                onSignedOut: () => {
                  if (!request.isCurrent()) return;
                  const next = encodeURIComponent(currentDestination());
                  window.location.replace(`/?next=${next}`);
                },
                onIdentityChanged: () => undefined,
                onInitialProtectedIdentity: () => undefined,
              });
              if (request.isCurrent() && pathname === "/verify-email") {
                window.location.replace("/");
              }
              return;
            }

            if (!user.emailVerified) {
              await deleteSession(request.signal);
              if (!request.isCurrent()) return;
              observedUid.current = user.uid;
              if (shouldStayForEmailVerification(pathname)) {
                return;
              }
              const next = encodeURIComponent(currentDestination());
              window.location.replace(`/verify-email?next=${next}`);
              return;
            }

            observedUid.current = await syncSessionIdentity({
              previousUid,
              currentUid: user.uid,
              protectedPath,
              clearSession: async () => undefined,
              writeSession: async () => {
                const token = await user.getIdToken();
                if (!request.isCurrent()) {
                  throw new DOMException("Stale auth sync", "AbortError");
                }
                await postSession(token, request.signal);
              },
              onSignedOut: () => undefined,
              onIdentityChanged: () => {
                if (!request.isCurrent()) return;
                window.location.replace(
                  `${window.location.pathname}${window.location.search}`,
                );
              },
              onInitialProtectedIdentity: () => {
                if (!request.isCurrent()) return;
                routerRef.current.refresh();
              },
            });
            if (!request.isCurrent()) return;
            if (["/", "/signup", "/verify-email"].includes(pathname)) {
              window.location.replace(currentDestination());
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            // The visible auth form handles interactive errors. A future token
            // refresh will retry this background synchronization.
          }
        });
      })
      .catch(() => {
        // Missing public Firebase configuration is reported by the auth forms.
      });

    return () => {
      disposed = true;
      unsubscribe?.();
      cancelAuthSyncRequests();
    };
  }, []);

  return null;
}
