"""Bounded, deterministic schedule suggestions; never changes stored projects."""
from datetime import date


def propose_schedule(projects, collisions, schedules, preferences):
    by_id = {p.record_id: p for p in projects}
    group = {p.record_id: p.project_id or p.record_id for p in projects}
    values = {identity: (day.toordinal() if day else None) if preferences.unit == "days" else year
              for identity, (day, year) in schedules.items()}
    edges = [row for row in collisions
             if row["uploaded_project"]["record_id"] < row["reference_project"]["record_id"]
             and row["uploaded_project"]["project_id"] != row["reference_project"]["project_id"]]
    members = {}
    for identity, key in group.items():
        members.setdefault(key, []).append(identity)
    shifts = {key: 0 for key in members}
    # Freeze a whole multi-point project if any of its schedules is unknown.
    movable = {key for key, ids in members.items() if all(values[i] is not None for i in ids)}
    links = [(row["uploaded_project"]["record_id"], row["reference_project"]["record_id"], row["distance_mi"]) for row in edges]
    known = [(a, b, miles) for a, b, miles in links if values[a] is not None and values[b] is not None]

    def analysis(offsets):
        pairs = []
        for a, b, miles in known:
            gap = abs(values[a] + offsets[group[a]] - values[b] - offsets[group[b]])
            if gap <= preferences.window:
                pairs.append({"a_id": a, "b_id": b, "miles": miles,
                              "timing": f"{gap} {preferences.unit} apart", "gap_days": gap if preferences.unit == "days" else None})
        pairs.sort(key=lambda p: (p["miles"], p["a_id"], p["b_id"]))
        return {"pairs": pairs, "location_count": len(projects), "geographic_pair_count": len(links),
                "unknown_timing_pairs": len(links) - len(known), "radius_miles": 25}

    before = analysis(shifts)
    # Coordinate descent considers conflict boundaries rather than every date.
    # Every accepted move strictly decreases the total matching-pair count.
    for _ in range(5):
        improved = False
        for key in sorted(movable):
            related = [(a, b) for a, b, _ in known if group[a] == key or group[b] == key]
            if not related:
                continue
            candidates = {0, shifts[key], -preferences.earlier, preferences.later}
            for a, b in related:
                own, other = (a, b) if group[a] == key else (b, a)
                center = values[other] + shifts[group[other]] - values[own]
                candidates.update((center - preferences.window - 1, center + preferences.window + 1))

            def count(shift):
                return sum(abs(values[a] + (shift if group[a] == key else shifts[group[a]]) -
                               values[b] - (shift if group[b] == key else shifts[group[b]])) <= preferences.window
                           for a, b in related)

            def valid(shift):
                if not -preferences.earlier <= shift <= preferences.later:
                    return False
                for identity in members[key]:
                    day, year = schedules[identity]
                    if preferences.unit == "years":
                        if not 1900 <= year + shift <= 2199:
                            return False
                        if day:
                            try:
                                day.replace(year=day.year + shift)
                            except ValueError:
                                return False
                    elif not date(1900, 1, 1).toordinal() <= values[identity] + shift <= date(2199, 12, 31).toordinal():
                        return False
                return True

            best = min((s for s in candidates if valid(s)), key=lambda s: (count(s), abs(s), s), default=shifts[key])
            if count(best) < count(shifts[key]):
                shifts[key] = best
                improved = True
        if not improved:
            break

    proposed, changes = [], []
    for p in projects:
        row = p.model_dump()
        shift = shifts[group[p.record_id]]
        if shift:
            day, year = schedules[p.record_id]
            if preferences.unit == "days":
                new_date = date.fromordinal(day.toordinal() + shift)
                new_schedule = new_date.isoformat()
                new_year = new_date.year
            else:
                new_year = year + shift
                new_schedule = day.replace(year=new_year).isoformat() if day else str(new_year)
            changes.append({"record_id": p.record_id, "project_name": p.project_name,
                            "before": p.schedule or p.estimated_in_service_year,
                            "after": new_schedule, "shift": shift})
            row.update(schedule=new_schedule, estimated_in_service_year=str(new_year))
        proposed.append(row)
    after = analysis(shifts)
    return {**before, "preferences": preferences.model_dump(),
            "proposal": {"projects": proposed, "analysis": after, "changes": changes,
                         "moved_projects": sum(s != 0 for s in shifts.values()),
                         "resolved_pairs": len(before["pairs"]) - len(after["pairs"]),
                         "method": "Bounded heuristic; not a guaranteed optimal or approved construction schedule."}}
