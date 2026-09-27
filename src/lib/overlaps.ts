export type Overlap = {
  overlap_id: string;
  project_id_a: string;
  project_id_b: string;
  project_name_a: string;
  project_name_b: string;
  utility_a: string;
  utility_b: string;
  distance_mi: number;
  time_gap_days: number;
  name_similarity: number;
};

export function parseOverlaps(value: unknown): Overlap[] {
  if (!Array.isArray(value)) throw new Error("Expected overlap list");
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error("Invalid overlap");
    const r = row as Record<string, unknown>;
    const text = (key: string) => {
      if (typeof r[key] !== "string" || !r[key])
        throw new Error(`Invalid ${key}`);
      return r[key] as string;
    };
    const number = (key: string) => {
      if (typeof r[key] !== "number" || !Number.isFinite(r[key]))
        throw new Error(`Invalid ${key}`);
      return r[key] as number;
    };
    const score = number("name_similarity");
    const distance = number("distance_mi");
    const gap = r.time_gap_days ?? r["time_gap (day)"];
    if (
      score < -1 ||
      score > 1 ||
      distance < 0 ||
      typeof gap !== "number" ||
      !Number.isFinite(gap)
    )
      throw new Error("Invalid metrics");
    return {
      overlap_id: text("overlap_id"),
      project_id_a: text("project_id_a"),
      project_id_b: text("project_id_b"),
      project_name_a: text("project_name_a"),
      project_name_b: text("project_name_b"),
      utility_a: text("utility_a"),
      utility_b: text("utility_b"),
      distance_mi: distance,
      time_gap_days: gap,
      name_similarity: score,
    };
  });
}

export function summarize(rows: Overlap[]) {
  return {
    projects: new Set(rows.flatMap((r) => [r.project_id_a, r.project_id_b]))
      .size,
    pairs: rows.length,
    highSimilarity: rows.filter((r) => r.name_similarity >= 0.5).length,
    average: rows.length
      ? rows.reduce((sum, r) => sum + r.name_similarity, 0) / rows.length
      : null,
    bands: [
      rows.filter((r) => r.name_similarity >= 0.75).length,
      rows.filter((r) => r.name_similarity >= 0.5 && r.name_similarity < 0.75)
        .length,
      rows.filter((r) => r.name_similarity < 0.5).length,
    ],
  };
}

// Illustrative preview data, never substituted for a failed live response.
export const exampleOverlaps: Overlap[] = [
  {
    overlap_id: "EX-01",
    project_id_a: "A",
    project_id_b: "B",
    project_name_a: "North corridor renewal",
    project_name_b: "North corridor water main",
    utility_a: "Transport",
    utility_b: "Water",
    distance_mi: 0.12,
    time_gap_days: 14,
    name_similarity: 0.89,
  },
  {
    overlap_id: "EX-02",
    project_id_a: "C",
    project_id_b: "D",
    project_name_a: "Riverside utility upgrade",
    project_name_b: "Riverside power extension",
    utility_a: "Water",
    utility_b: "Power",
    distance_mi: 0.23,
    time_gap_days: 21,
    name_similarity: 0.78,
  },
  {
    overlap_id: "EX-03",
    project_id_a: "E",
    project_id_b: "F",
    project_name_a: "East district resurfacing",
    project_name_b: "East district drainage",
    utility_a: "Transport",
    utility_b: "Water",
    distance_mi: 0.41,
    time_gap_days: 30,
    name_similarity: 0.62,
  },
  {
    overlap_id: "EX-04",
    project_id_a: "A",
    project_id_b: "G",
    project_name_a: "North corridor renewal",
    project_name_b: "Central fiber installation",
    utility_a: "Transport",
    utility_b: "Telecom",
    distance_mi: 1.3,
    time_gap_days: 45,
    name_similarity: 0.31,
  },
];
