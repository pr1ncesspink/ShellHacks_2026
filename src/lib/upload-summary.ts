// Client-safe parsers and helpers for the /budget upload flow: id lists in the URL,
// the owner-scoped upload list, per-upload Gemini/rule-based summaries, and the
// map payload (uploaded points plus nearby reference collisions). The API
// routes re-serialize backend JSON through these parsers, so only allow-listed
// fields ever reach the browser.
import { SESSION_ID } from "./upload-sessions.ts";

export const UPLOAD_ID = /^UPL_[a-f0-9]{32}$/;
export const MAX_SUMMARY_IDS = 5;
export const MAX_RECENT_UPLOADS = 20;
export const MAX_MAP_POINTS = 2_000;
export const MAX_MAP_COLLISIONS = 200;

// ---- URL id lists ---------------------------------------------------------

export type IdPrefix = "SES_" | "UPL_";

/**
 * Parse `?sessions=` / `?uploads=` values: comma-separated, trimmed, only ids
 * matching the prefix's full pattern, deduplicated, capped at 5.
 */
export function parseIdList(param: string | readonly string[] | null | undefined, prefix: IdPrefix): string[] {
  const pattern = prefix === "SES_" ? SESSION_ID : UPLOAD_ID;
  const raw = param === null || param === undefined ? [] : typeof param === "string" ? [param] : param;
  const ids: string[] = [];
  for (const chunk of raw) {
    if (typeof chunk !== "string") continue;
    for (const part of chunk.split(",")) {
      const id = part.trim();
      if (!pattern.test(id) || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length === MAX_SUMMARY_IDS) return ids;
    }
  }
  return ids;
}

/** /budget link for session ids (right after upload) or upload ids (durable). */
export function budgetHref(key: "sessions" | "uploads", ids: readonly string[]): string {
  const valid = parseIdList(ids, key === "sessions" ? "SES_" : "UPL_");
  return valid.length ? `/budget?${key}=${valid.join(",")}` : "/budget";
}

/** Backend path (relative to BACKEND_URL) for an upload resource, or null for a bad id. */
export function uploadBackendPath(id: string, resource: "summary" | "map"): string | null {
  return UPLOAD_ID.test(id) ? `projects/uploads/${id}/${resource}` : null;
}
export const UPLOADS_BACKEND_PATH = "projects/uploads";

/** Same-origin API path for the browser, or null for a bad id. */
export function uploadApiPath(id: string, resource: "summary" | "map"): string | null {
  return UPLOAD_ID.test(id) ? `/api/uploads/${id}/${resource}` : null;
}
export const UPLOADS_API_PATH = "/api/uploads";

// ---- small validators ------------------------------------------------------

type Json = Record<string, unknown>;

function record(value: unknown, what: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${what}`);
  return value as Json;
}

const asRecord = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;

/** Printable text: control characters dropped (newlines kept when asked), trimmed, capped. */
function cleanText(value: unknown, max: number, keepNewlines = false): string | null {
  if (typeof value !== "string") return null;
  const stripped = keepNewlines
    ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    : value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const text = stripped.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Identifier text (record_id, project_id): never truncated, since ids key the map layers. */
function idText(value: unknown): string | null {
  const text = cleanText(value, 257);
  return text && text.length <= 256 ? text : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function isoDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---- recent uploads --------------------------------------------------------

export const SUMMARY_STATUSES = ["model", "rule_only", "pending"] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

const summaryStatus = (value: unknown): SummaryStatus | null =>
  typeof value === "string" && (SUMMARY_STATUSES as readonly string[]).includes(value) ? value as SummaryStatus : null;

export type RecentUpload = {
  upload_id: string;
  created_at: string | null;
  status: SummaryStatus | null;
  headline: string | null;
  /** Backend SummaryCounts: projects, points, located_points, collisions (when present). */
  counts: Record<string, number>;
};
export type RecentUploads = { uploads: RecentUpload[] };

/** Accepts `{uploads: [...]}` or a bare array; invalid rows are dropped, newest first as sent. */
export function parseRecentUploads(value: unknown): RecentUploads {
  const rows = Array.isArray(value) ? value : record(value, "upload list").uploads;
  if (!Array.isArray(rows)) throw new Error("Invalid upload list");
  const uploads: RecentUpload[] = [];
  for (const row of rows) {
    const r = asRecord(row);
    if (!r || typeof r.upload_id !== "string" || !UPLOAD_ID.test(r.upload_id)) continue;
    if (uploads.some((u) => u.upload_id === r.upload_id)) continue;
    uploads.push({
      upload_id: r.upload_id,
      created_at: timestamp(r.created_at),
      status: summaryStatus(r.status),
      headline: cleanText(r.headline, 120),
      counts: counts(r.counts),
    });
    if (uploads.length === MAX_RECENT_UPLOADS) break;
  }
  return { uploads };
}

// ---- summary ---------------------------------------------------------------

export type KeyProject = { project_id: string; name: string; why: string };
export type Hotspot = { overlap_ids: string[]; label: string; nearest_mi: number | null; lat: number | null; lon: number | null };
export type DataGaps = { unresolved_locations: number; missing_dates: number; truncated: boolean };
export type GeneratedBy = { model: string | null; prompt_version: string | null; input_hash: string | null };
export type UploadSummary = {
  upload_id: string | null;
  created_at: string | null;
  status: SummaryStatus;
  headline: string;
  overview: string;
  key_projects: KeyProject[];
  hotspots: Hotspot[];
  timing_notes: string[];
  data_gaps: DataGaps;
  counts: Record<string, number>;
  generated_by: GeneratedBy | null;
};

const OVERLAP_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const COUNT_KEY = /^[a-z][a-z0-9_]{0,47}$/;

function keyProjects(value: unknown): KeyProject[] {
  const out: KeyProject[] = [];
  for (const row of list(value)) {
    const r = asRecord(row);
    const projectId = r && idText(r.project_id);
    if (!r || !projectId) continue;
    // The model may leave name empty; fall back to the id.
    out.push({ project_id: projectId, name: cleanText(r.name, 300) ?? projectId, why: cleanText(r.why, 240) ?? "" });
    if (out.length === 5) break;
  }
  return out;
}

function hotspots(value: unknown): Hotspot[] {
  const out: Hotspot[] = [];
  for (const row of list(value)) {
    const r = asRecord(row);
    if (!r) continue;
    const ids = list(r.overlap_ids).filter((id): id is string => typeof id === "string" && OVERLAP_ID.test(id)).slice(0, 20);
    const label = cleanText(r.label, 200);
    if (!label || !ids.length) continue;
    const lat = finite(r.lat, -90, 90);
    const lon = finite(r.lon, -180, 180);
    const paired = lat !== null && lon !== null;
    out.push({
      overlap_ids: [...new Set(ids)],
      label,
      nearest_mi: finite(r.nearest_mi, 0, 25_000),
      lat: paired ? lat : null,
      lon: paired ? lon : null,
    });
    if (out.length === 5) break;
  }
  return out;
}

function counts(value: unknown): Record<string, number> {
  const r = asRecord(value);
  const out: Record<string, number> = {};
  if (!r) return out;
  for (const [key, raw] of Object.entries(r)) {
    const n = count(raw);
    if (!COUNT_KEY.test(key) || n === null) continue;
    out[key] = n;
    if (Object.keys(out).length === 24) break;
  }
  return out;
}

function generatedBy(value: unknown): GeneratedBy | null {
  const r = asRecord(value);
  if (!r) return null;
  return {
    model: cleanText(r.model, 80),
    prompt_version: cleanText(r.prompt_version, 40),
    input_hash: typeof r.input_hash === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(r.input_hash) ? r.input_hash : null,
  };
}

/** Allow-listed UploadSummary; `status` is required, everything else defaults when absent. */
export function parseUploadSummary(value: unknown): UploadSummary {
  const r = record(value, "upload summary");
  const status = summaryStatus(r.status);
  if (!status) throw new Error("Invalid status");
  const gaps = asRecord(r.data_gaps);
  return {
    upload_id: typeof r.upload_id === "string" && UPLOAD_ID.test(r.upload_id) ? r.upload_id : null,
    created_at: timestamp(r.created_at),
    status,
    headline: cleanText(r.headline, 120) ?? "",
    overview: cleanText(r.overview, 1_200, true) ?? "",
    key_projects: keyProjects(r.key_projects),
    hotspots: hotspots(r.hotspots),
    timing_notes: list(r.timing_notes).map((note) => cleanText(note, 300)).filter((n): n is string => n !== null).slice(0, 3),
    data_gaps: {
      unresolved_locations: count(gaps?.unresolved_locations) ?? 0,
      missing_dates: count(gaps?.missing_dates) ?? 0,
      truncated: gaps?.truncated === true,
    },
    counts: counts(r.counts),
    generated_by: generatedBy(r.generated_by),
  };
}

// ---- map payload -----------------------------------------------------------

export type MapPoint = {
  record_id: string;
  project_id: string;
  name: string;
  owner: string | null;
  lat: number;
  lon: number;
  coordinate_method: string | null;
  status: string | null;
  in_service_date: string | null;
  estimated_in_service_year: number | null;
};
export type MapCollision = {
  overlap_id: string;
  distance_mi: number;
  time_gap_days: number | null;
  timing_basis: string | null;
  uploaded: MapPoint;
  reference: MapPoint;
};
export type UploadMap = { upload_id: string | null; points: MapPoint[]; collisions: MapCollision[] };

/** Short machine codes (coordinate_method, timing_basis); backend caps them at 64 chars. */
const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * One allow-listed point, or null when ids/name are missing or the
 * coordinates are absent or out of range (the point cannot be plotted).
 * Accepts the backend ProjectPoint spellings (project_name, latitude, longitude).
 */
export function parseMapPoint(value: unknown): MapPoint | null {
  const r = asRecord(value);
  if (!r) return null;
  const recordId = idText(r.record_id);
  const projectId = idText(r.project_id);
  const name = cleanText(r.name ?? r.project_name, 300);
  const lat = finite(r.lat ?? r.latitude, -90, 90);
  const lon = finite(r.lon ?? r.longitude, -180, 180);
  if (!recordId || !projectId || !name || lat === null || lon === null) return null;
  const method = r.coordinate_method;
  const status = r.status;
  const year = r.estimated_in_service_year;
  return {
    record_id: recordId,
    project_id: projectId,
    name,
    owner: cleanText(r.owner, 200),
    lat,
    lon,
    coordinate_method: typeof method === "string" && LABEL.test(method) ? method : null,
    status: cleanText(status, 120),
    in_service_date: isoDate(r.in_service_date),
    estimated_in_service_year: typeof year === "number" && Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null,
  };
}

function parseCollision(value: unknown): MapCollision | null {
  const r = asRecord(value);
  if (!r || typeof r.overlap_id !== "string" || !OVERLAP_ID.test(r.overlap_id)) return null;
  const distance = finite(r.distance_mi, 0, 25_000);
  const uploaded = parseMapPoint(r.uploaded ?? r.uploaded_project);
  const reference = parseMapPoint(r.reference ?? r.reference_project);
  if (distance === null || !uploaded || !reference) return null;
  const gap = r.time_gap_days;
  const basis = r.timing_basis;
  return {
    overlap_id: r.overlap_id,
    distance_mi: distance,
    time_gap_days: typeof gap === "number" && Number.isInteger(gap) && gap >= 0 && gap <= 1_000_000 ? gap : null,
    timing_basis: typeof basis === "string" && LABEL.test(basis) ? basis : null,
    uploaded,
    reference,
  };
}

/**
 * Allow-listed map payload. Points without coordinates (backend lat/lon null
 * for unresolved locations) cannot be plotted and are dropped, as are
 * malformed collisions; the summary's data_gaps carries the unresolved count.
 */
export function parseUploadMap(value: unknown): UploadMap {
  const r = record(value, "upload map");
  const pointsRaw = r.points ?? r.uploaded;
  if (!Array.isArray(pointsRaw) || !Array.isArray(r.collisions)) throw new Error("Invalid upload map");
  const points: MapPoint[] = [];
  for (const row of pointsRaw) {
    if (points.length === MAX_MAP_POINTS) break;
    const point = parseMapPoint(row);
    if (point) points.push(point);
  }
  const collisions: MapCollision[] = [];
  for (const row of r.collisions) {
    if (collisions.length === MAX_MAP_COLLISIONS) break;
    const collision = parseCollision(row);
    if (collision) collisions.push(collision);
  }
  return {
    upload_id: typeof r.upload_id === "string" && UPLOAD_ID.test(r.upload_id) ? r.upload_id : null,
    points,
    collisions,
  };
}

// ---- map layers ------------------------------------------------------------

export type UploadedMapPoint = MapPoint & { key: string; upload_id: string | null };
export type ReferenceMapPoint = MapPoint & { key: string };
export type CollisionLink = {
  id: string;
  upload_id: string | null;
  uploaded_key: string;
  reference_key: string;
  from: [number, number];
  to: [number, number];
  distance_mi: number;
  time_gap_days: number | null;
  timing_basis: string | null;
};
export type MapBounds = [[number, number], [number, number]];
export type MapLayers = {
  uploaded: UploadedMapPoint[];
  reference: ReferenceMapPoint[];
  links: CollisionLink[];
  /** [[south, west], [north, east]] over both point sets; null when empty. */
  bounds: MapBounds | null;
};

/**
 * Split one or more upload map payloads into layers for ProjectMap. Uploaded
 * points are keyed per upload (the same record id can appear in two uploads);
 * reference points and links are deduplicated across payloads.
 */
export function buildMapLayers(payloads: readonly UploadMap[]): MapLayers {
  const uploaded = new Map<string, UploadedMapPoint>();
  const reference = new Map<string, ReferenceMapPoint>();
  const links = new Map<string, CollisionLink>();
  const addUploaded = (uploadId: string | null, point: MapPoint) => {
    const key = `${uploadId ?? "upload"}|${point.record_id}`;
    if (!uploaded.has(key)) uploaded.set(key, { ...point, key, upload_id: uploadId });
    return key;
  };
  for (const payload of payloads) {
    for (const point of payload.points) addUploaded(payload.upload_id, point);
    for (const collision of payload.collisions) {
      const uploadedKey = addUploaded(payload.upload_id, collision.uploaded);
      const referenceKey = `ref|${collision.reference.record_id}`;
      if (!reference.has(referenceKey)) reference.set(referenceKey, { ...collision.reference, key: referenceKey });
      if (links.has(collision.overlap_id)) continue;
      links.set(collision.overlap_id, {
        id: collision.overlap_id,
        upload_id: payload.upload_id,
        uploaded_key: uploadedKey,
        reference_key: referenceKey,
        from: [collision.uploaded.lat, collision.uploaded.lon],
        to: [collision.reference.lat, collision.reference.lon],
        distance_mi: collision.distance_mi,
        time_gap_days: collision.time_gap_days,
        timing_basis: collision.timing_basis,
      });
    }
  }
  let bounds: MapBounds | null = null;
  for (const point of [...uploaded.values(), ...reference.values()]) {
    if (!bounds) { bounds = [[point.lat, point.lon], [point.lat, point.lon]]; continue; }
    bounds = [
      [Math.min(bounds[0][0], point.lat), Math.min(bounds[0][1], point.lon)],
      [Math.max(bounds[1][0], point.lat), Math.max(bounds[1][1], point.lon)],
    ];
  }
  return { uploaded: [...uploaded.values()], reference: [...reference.values()], links: [...links.values()], bounds };
}
