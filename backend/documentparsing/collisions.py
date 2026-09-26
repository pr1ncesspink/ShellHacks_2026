"""Shared geographic candidate calculation and legacy CSV serialization."""

import csv
from datetime import date
import json
from pathlib import Path

from .locations import center, haversine
from .records import DESC


def collisions(projects, *, distance_fn=haversine):
    rows, excluded, eligible = [], [], []
    for project in projects:
        lat, lon = center(project)
        reason = "unresolved_location" if lat is None else "missing_or_multiphase_date" if not project.get("in_service_date") else ""
        if reason:
            excluded.append({"project_id": project["project_id"], "reason": reason})
        else:
            eligible.append((project, lat, lon))
    for i, (a, alat, alon) in enumerate(eligible):
        for b, blat, blon in eligible[i + 1:]:
            if a["utility"] == b["utility"]:
                continue
            distance = distance_fn(alat, alon, blat, blon)
            if distance >= 25:
                continue
            first, second = sorted((a, b), key=lambda p: (p["utility"] != DESC, p["utility"], p["project_id"]))
            rows.append({"overlap_id": "", "distance_mi": f"{distance:.2f}",
                         "time_gap (day)": abs((date.fromisoformat(first["in_service_date"]) - date.fromisoformat(second["in_service_date"])).days),
                         "utility_a": first["utility"], "project_id_a": first["project_id"], "project_name_a": first["project_name"],
                         "utility_b": second["utility"], "project_id_b": second["project_id"], "project_name_b": second["project_name"]})
    rows.sort(key=lambda row: (row["project_id_a"], row["project_id_b"]))
    for i, row in enumerate(rows, 1):
        row["overlap_id"] = f"OVL_{i}"
    return rows, excluded


def write_csv(path, columns, rows):
    with Path(path).open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="raise", lineterminator="\r\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(row.get(key), ensure_ascii=False, sort_keys=True)
                             if isinstance(row.get(key), (dict, list)) else row.get(key) for key in columns})
