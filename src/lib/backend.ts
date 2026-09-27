import "server-only";
import { exampleOverlaps, parseOverlaps, type Overlap } from "./overlaps";

type DashboardData = { mode: "example" | "live" | "error"; rows: Overlap[] };
export async function getDashboardData(): Promise<DashboardData> {
  const base = process.env.BACKEND_URL?.trim();
  if (!base) return { mode: "example", rows: exampleOverlaps };
  try {
    const url = new URL(base.endsWith("/") ? base : `${base}/`);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("Invalid backend protocol");
    const response = await fetch(new URL("overlaps/similarity", url), {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Backend unavailable");
    return { mode: "live", rows: parseOverlaps(await response.json()) };
  } catch {
    return { mode: "error", rows: [] };
  }
}
