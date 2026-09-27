export type MapProject = {
  record_id: string;
  project_id?: string;
  project_name: string;
  segment: string;
  owner: string;
  status: string;
  states: string;
  latitude: number;
  longitude: number;
  coordinate_method: string;
  project_source_url: string;
  estimated_in_service_year: string;
  schedule?: string;
  source_document?: string;
  source_page?: number;
};

export type ProjectDraft = {
  id: string; name: string; latitude: string; longitude: string;
  schedule: string; owner: string; source: string; page: number;
};

export function validateDraft(row: ProjectDraft): string | null {
  if (!row.name.trim()) return "Enter a project name.";
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  if (!decimal.test(row.latitude.trim()) || !decimal.test(row.longitude.trim())) return "Enter latitude and longitude in decimal degrees.";
  const lat = Number(row.latitude), lon = Number(row.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return "Latitude must be -90 to 90; longitude -180 to 180.";
  return null;
}

export function toMapProject(row: ProjectDraft): MapProject {
  const error = validateDraft(row);
  if (error) throw new Error(error);
  return { record_id: row.id, project_id: row.id, project_name: row.name.trim(),
    latitude: Number(row.latitude), longitude: Number(row.longitude),
    segment: "", owner: row.owner.trim(), status: "", states: "",
    coordinate_method: "user_reviewed_pdf", project_source_url: "",
    estimated_in_service_year: /^\d{4}$/.test(row.schedule.trim()) ? row.schedule.trim() : "",
    schedule: row.schedule.trim(), source_document: row.source, source_page: row.page };
}

// Great-circle distance, because lat/lon are angles rather than mile coordinates.
export function milesBetween(a: MapProject, b: MapProject): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function proximityPairs(projects: MapProject[], radius = 25) {
  const pairs: { a: MapProject; b: MapProject; miles: number }[] = [];
  for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) {
    const a = projects[i], b = projects[j];
    if (a.project_id && a.project_id === b.project_id) continue;
    const miles = milesBetween(a, b);
    if (miles <= radius) pairs.push({ a, b, miles });
  }
  return pairs.sort((a, b) => a.miles - b.miles);
}

const fieldLabels = "project(?: name)?|latitude|lat|longitude|lon|lng|in[- ]service(?: date| year)?|estimated[_ ]in[_ ]service[_ ]year|date|time|schedule|owner|utility";
function field(text: string, label: string): string {
  return text.match(new RegExp(`(?:^|[\\n|;]|\\s)(?:${label})\\s*:\\s*(.*?)(?=\\s+(?:${fieldLabels})\\s*:|[\\n|;]|$)`, "im"))?.[1]?.trim() ?? "";
}

function coordinate(value: string, latitude: boolean) {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*([NSEW])?$/i);
  if (!match) return value.trim(); // Preserve unsupported formats for review.
  const direction = match[2]?.toUpperCase();
  if (direction && !(latitude ? ["N", "S"] : ["E", "W"]).includes(direction)) return value.trim();
  const number = Number(match[1]);
  if (direction && number < 0) return value.trim(); // Ambiguous signed hemisphere.
  return String(direction === "S" || direction === "W" ? -number : number);
}

// Deliberately conservative: labeled project blocks, not arbitrary prose or maps.
export function parseProjectPage(text: string, source: string, page: number): ProjectDraft[] {
  const blocks = text.split(/(?=\bProject(?: name)?\s*:)/i).filter(block => /\bProject(?: name)?\s*:/i.test(block));
  if (!blocks.length && /\b(?:latitude|longitude)\s*:/i.test(text)) blocks.push(text);
  return blocks.map((block, i) => ({
    id: `${source}:${page}:${i}`, name: field(block, "project(?: name)?"),
    latitude: coordinate(field(block, "latitude|lat"), true),
    longitude: coordinate(field(block, "longitude|lon|lng"), false),
    schedule: field(block, "in[- ]service(?: date| year)?|estimated[_ ]in[_ ]service[_ ]year|date|time|schedule"),
    owner: field(block, "owner|utility"), source, page,
  }));
}
