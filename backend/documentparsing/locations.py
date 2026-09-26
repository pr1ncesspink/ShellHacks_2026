from __future__ import annotations

import hashlib
import json
import math
import re
import time
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

from .records import DESC, endpoint_key

THRESHOLD = .90
BBOX = (30.3, -85.7, 35.3, -78.3)  # Georgia and South Carolina; south, west, north, east


def haversine(a_lat, a_lon, b_lat, b_lon):
    dlat, dlon = math.radians(b_lat - a_lat), math.radians(b_lon - a_lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(dlon / 2) ** 2
    return 3958.7613 * 2 * math.asin(math.sqrt(min(1., max(0., h))))


def valid_point(lat, lon):
    return isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def center(p):
    pts = [(p.get(f"lat_{s}"), p.get(f"lon_{s}")) for s in ("a", "b")
           if p.get(f"confidence_{s}", 0) >= THRESHOLD and valid_point(p.get(f"lat_{s}"), p.get(f"lon_{s}"))]
    return (sum(x[0] for x in pts) / len(pts), sum(x[1] for x in pts) / len(pts)) if pts else (None, None)


class Resolver:
    def __init__(self, cache_dir, seeds, network=False, user_agent="", snapshot=None):
        if snapshot and not Path(snapshot).is_file():
            raise ValueError(f"OSM snapshot must exist as a file: {snapshot}")
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.network, self.user_agent = network, user_agent
        if network and not user_agent:
            raise ValueError("Network lookups require --user-agent with application name and contact information")
        self.stats = {"cache_hits": 0, "cache_misses": 0, "requests": 0, "errors": [], "seed_matches": 0,
                      "accepted_osm_matches": 0, "snapshot_sha256": None}
        self.last_request = 0.
        self.used_cache = {}
        self.seeds = seeds
        self.features = []
        self.snapshot = Path(snapshot) if snapshot else self.cache / "overpass.json"
        self.load_snapshot()

    def fetch(self, url, path, data=None):
        if path.exists():
            payload = path.read_bytes()
            self.used_cache[path.name] = hashlib.sha256(payload).hexdigest()
            self.stats["cache_hits"] += 1
            return json.loads(payload)
        self.stats["cache_misses"] += 1
        if not self.network:
            return None
        time.sleep(max(0., 1.1 - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        self.stats["requests"] += 1
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": self.user_agent, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=35) as response:
                payload = response.read()
            result = json.loads(payload)
            if isinstance(result, dict) and result.get("remark") and not result.get("elements"):
                raise ValueError(f'Overpass returned an error: {result["remark"]}')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
            self.used_cache[path.name] = hashlib.sha256(payload).hexdigest()
            return result
        except (OSError, ValueError) as exc:
            self.stats["errors"].append({"cache_key": path.name, "error": str(exc)})
            return None

    def load_snapshot(self):
        box = ",".join(map(str, BBOX))
        query = f'[out:json][timeout:25];nwr["power"~"^(substation|plant|line)$"]({box});out center tags;'
        raw = self.fetch("https://overpass-api.de/api/interpreter", self.snapshot,
                         urllib.parse.urlencode({"data": query}).encode())
        if not raw:
            return
        self.stats["snapshot_sha256"] = hashlib.sha256(self.snapshot.read_bytes()).hexdigest()
        if "elements" not in raw:
            raise ValueError("OSM snapshot must be Overpass JSON with an elements array")
        for f in raw["elements"]:
            tags = f.get("tags", {})
            pt = f.get("center", f)
            lat, lon = pt.get("lat"), pt.get("lon")
            if not valid_point(lat, lon):
                continue
            self.features.append({"id": f'{f.get("type", "node")}/{f.get("id")}', "lat": lat, "lon": lon, "tags": tags})

    def rank(self, p, name, features):
        result = []
        target = endpoint_key(name)
        for f in features:
            tags = f["tags"]
            south, west, north, east = BBOX
            if not (south <= f["lat"] <= north and west <= f["lon"] <= east):
                continue
            aliases = [x for field in ("name", "alt_name", "official_name", "short_name", "ref")
                       for x in tags.get(field, "").split(";") if x]
            similarity = max((SequenceMatcher(None, target, endpoint_key(x)).ratio() for x in aliases), default=0.)
            if similarity < .65:
                continue
            operator = (tags.get("operator", "") + " " + tags.get("owner", "")).lower()
            expected = ("dominion", "sce&g", "south carolina electric") if p["utility"] == DESC else ("georgia power", "southern company")
            operator_match = any(x in operator for x in expected)
            power = tags.get("power", "")
            asset_match = power in ("substation", "plant")
            state_tag = tags.get("addr:state", "").upper()
            state_match = state_tag in (("SC", "SOUTH CAROLINA") if p["state"] == "SC" else ("GA", "GEORGIA"))
            state_conflict = bool(state_tag) and not state_match
            voltage_values = {float(x) / 1000 for x in re.findall(r"\d+(?:\.\d+)?", tags.get("voltage", ""))}
            voltage_match = bool(voltage_values.intersection(p.get("voltages_kv", [])))
            context = ((p.get("description") or "") + " " + (p.get("need") or "")).lower()
            context_match = any(tags.get(k, "") and tags[k].lower() in context for k in ("addr:city", "addr:county"))
            score = .70 * similarity + .12 * asset_match + .10 * operator_match + .04 * voltage_match + .02 * state_match + .02 * context_match
            if state_conflict:
                score = min(score, .5)
            if power == "line":
                score = min(score, .75)  # A line center is not a named endpoint.
            result.append({**f, "score": round(score, 4), "name_similarity": round(similarity, 4),
                           "operator_match": operator_match, "voltage_match": voltage_match,
                           "state_match": state_match, "context_match": context_match})
        return sorted(result, key=lambda f: (-f["score"], f["id"]))

    def nominatim(self, p, name):
        query = f'{name} substation, {p["state"]}, USA'
        key = hashlib.sha256(query.encode()).hexdigest()[:20]
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
            "q": query, "format": "jsonv2", "limit": 5, "countrycodes": "us", "addressdetails": 1,
            "extratags": 1, "namedetails": 1})
        results = self.fetch(url, self.cache / f"nominatim_{key}.json") or []
        features = []
        for item in results:
            tags = dict(item.get("extratags") or {})
            tags.update(item.get("namedetails") or {})
            tags.setdefault("name", item.get("name", ""))
            if item.get("class", item.get("category")) == "power":
                tags.setdefault("power", item.get("type", ""))
            tags["addr:state"] = item.get("address", {}).get("state", "")
            try:
                lat, lon = float(item["lat"]), float(item["lon"])
            except (KeyError, ValueError, TypeError):
                continue
            if valid_point(lat, lon):
                features.append({"id": f'{item.get("osm_type")}/{item.get("osm_id")}', "lat": lat, "lon": lon, "tags": tags})
        return features

    def seed_candidates(self, p, name):
        found = []
        for seed in self.seeds:
            if seed["utility"] != p["utility"]:
                continue
            for side in ("a", "b"):
                if endpoint_key(seed.get(f"name_{side}")) == endpoint_key(name) and seed.get(f"confidence_{side}") == 1.:
                    found.append((seed[f"lat_{side}"], seed[f"lon_{side}"]))
        return sorted(set(found))

    def resolve(self, projects):
        review = []
        for p in projects:
            for side in ("a", "b"):
                name = p.get(f"name_{side}") or ""
                if p.get(f"confidence_{side}", 0) == 1.:
                    continue
                if not name and side == "b":
                    continue
                candidates, reason = [], "missing_endpoint_name"
                if name:
                    seed_pts = self.seed_candidates(p, name)
                    if len(seed_pts) == 1:
                        p[f"lat_{side}"], p[f"lon_{side}"] = seed_pts[0]
                        p[f"confidence_{side}"] = 1.
                        p["location_evidence"][side] = {"method": "seed_endpoint_reuse", "name": name}
                        self.stats["seed_matches"] += 1
                        continue
                    if len(seed_pts) > 1:
                        reason = "conflicting_seed_coordinates"
                        candidates = [{"lat": pt[0], "lon": pt[1], "source": "sponsor_workbook"} for pt in seed_pts]
                    else:
                        candidates = self.rank(p, name, self.features)
                        if not candidates:
                            candidates = self.rank(p, name, self.nominatim(p, name))
                        reason = "no_candidate" if not candidates else "low_confidence"
                        # Nearby duplicate representations of a substation are one candidate site.
                        rivals = [c for c in candidates[1:] if haversine(candidates[0]["lat"], candidates[0]["lon"], c["lat"], c["lon"]) > .2] if candidates else []
                        ambiguous = bool(rivals and candidates[0]["score"] - rivals[0]["score"] < .08)
                        if ambiguous:
                            reason = "ambiguous_candidates"
                        if candidates and candidates[0]["score"] >= THRESHOLD and not ambiguous:
                            best = candidates[0]
                            p[f"lat_{side}"], p[f"lon_{side}"] = best["lat"], best["lon"]
                            p[f"confidence_{side}"] = best["score"]
                            p["location_evidence"][side] = {"method": "osm_match", **best}
                            self.stats["accepted_osm_matches"] += 1
                            continue
                review.append({"project_id": p["project_id"], "project_name": p["project_name"],
                               "endpoint": side, "query_name": name, "reason": reason,
                               "candidates": json.dumps(candidates[:5], sort_keys=True, ensure_ascii=False)})
            p["lat_center"], p["lon_center"] = center(p)
        self.stats["used_cache_hashes"] = self.used_cache
        return review
