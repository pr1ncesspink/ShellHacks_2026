import "server-only";
import { isLocalPreview } from "./server/local-preview";
import { buildBackendHeaders, readBackendConfig } from "./backend-config";
import { exampleOverlaps, parseOverlaps, type Overlap } from "./overlaps";
import {
  getGoogleIdToken,
  invalidateGoogleIdToken,
} from "./server/google-id-token";
import type { SessionUser } from "./session-exchange";

type DashboardData = { mode: "example" | "live" | "error"; rows: Overlap[] };
export async function getDashboardData(
  user: Pick<SessionUser, "uid">,
): Promise<DashboardData> {
  const preview = await isLocalPreview();
  const config = readBackendConfig(process.env);
  // A preview identity may only read an unauthenticated local development API.
  if (preview && config.mode === "live" &&
      (config.auth !== "none" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.url).hostname))) {
    return { mode: "error", rows: [] };
  }
  if (config.mode === "example") {
    return { mode: "example", rows: exampleOverlaps };
  }
  if (config.mode === "invalid") {
    console.error(
      `[backend] Invalid configuration; check ${config.missing.join(", ")}`,
    );
    return { mode: "error", rows: [] };
  }
  try {
    const googleIdToken =
      config.auth === "google-oidc"
        ? await getGoogleIdToken(config)
        : undefined;
    const response = await fetch(
      new URL("overlaps/similarity", config.url),
      {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: preview ? { Accept: "application/json" } : buildBackendHeaders(user.uid, googleIdToken),
      },
    );
    if (
      config.auth === "google-oidc" &&
      (response.status === 401 || response.status === 403)
    ) {
      invalidateGoogleIdToken();
    }
    if (!response.ok) throw new Error("Backend unavailable");
    return { mode: "live", rows: parseOverlaps(await response.json()) };
  } catch {
    console.error("[backend] Dashboard request failed");
    return { mode: "error", rows: [] };
  }
}
