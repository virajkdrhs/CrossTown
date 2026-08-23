"""Real road distances and driving routes, via OSRM.

Why this exists
---------------
The carpool matcher used straight-line distance scaled by a flat 1.25. Around
Richmond that is not a rounding error, it is a wrong answer: the James River
splits the county and you can only cross it at a bridge. Two points 9.8 km apart
as the crow flies are 21.1 km apart by road - the flat model underestimated that
detour by 1.73x, so the matcher would happily seat a rider "on the way" when the
driver would in fact cross the river twice.

Road distances are also *asymmetric* (21,137 m out, 21,527 m back on that same
pair, because of one-way streets and ramp geometry). A symmetric straight-line
model cannot express that at all.

How it works
------------
One OSRM ``/table`` request returns the full N x N distance and duration matrix
for a whole carpool plan, so matching costs a single network call rather than one
per candidate pair. Points are deduplicated first - employees share grid zones,
so a 60-person roster collapses to about 25 distinct pickup points.

Degrading safely matters more than precision here: if OSRM is unreachable, rate
limited, or the point count is too large for one request, everything falls back
to the old haversine model and says so in ``provider``. A demo must never fail
because a public server is busy.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from . import config
from .gtfs import haversine_m

# The public demo server is fine for a project of this size, but it is a shared
# courtesy resource. Point CROSSTOWN_OSRM_URL at your own instance for real use.
OSRM_BASE = os.getenv("CROSSTOWN_OSRM_URL", "https://router.project-osrm.org").rstrip("/")
OSRM_ENABLED = os.getenv("CROSSTOWN_OSRM_DISABLED", "").lower() not in ("1", "true", "yes")

# OSRM's default max-table-size is 100 coordinates. Stay under it.
MAX_TABLE_COORDS = 90
REQUEST_TIMEOUT_S = 20

# Fallback model, kept identical to the previous behaviour so the degraded path
# is a known quantity rather than a second untested code path.
ROAD_DETOUR_FACTOR = 1.25
FALLBACK_SPEED_MPS = 12.5

CACHE_DIR = config.DATA_DIR / "Cache" / "osrm"


def _key(point: tuple[float, float]) -> tuple[float, float]:
    """Round to ~1 m so trivially different coordinates share a matrix slot."""
    return (round(point[0], 5), round(point[1], 5))


def _cache_path(kind: str, points: list[tuple[float, float]]) -> "object":
    digest = hashlib.sha1(
        f"{kind}:{OSRM_BASE}:{json.dumps([list(_key(p)) for p in points])}".encode()
    ).hexdigest()
    return CACHE_DIR / f"{kind}-{digest}.json"


def _read_cache(path):
    try:
        if path.exists():
            with path.open(encoding="utf-8") as handle:
                return json.load(handle)
    except (OSError, ValueError):
        pass
    return None


def _write_cache(path, payload) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except OSError:
        pass  # a cold cache is not an error


def _fetch(url: str, timeout: int):
    request = urllib.request.Request(url, headers={"User-Agent": "crosstown/2.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


@dataclass
class RoadMatrix:
    """Pairwise driving distance and duration between a set of points."""

    points: list[tuple[float, float]]
    distances: list[list[float]]
    durations: list[list[float]]
    provider: str
    note: str
    index: dict = field(default_factory=dict)

    def _slot(self, point: tuple[float, float]) -> int | None:
        return self.index.get(_key(point))

    def distance(self, a: tuple[float, float], b: tuple[float, float]) -> float:
        """Metres by road, falling back to the scaled straight line."""
        i, j = self._slot(a), self._slot(b)
        if i is not None and j is not None:
            value = self.distances[i][j]
            if value is not None:
                return float(value)
        return haversine_m(a[0], a[1], b[0], b[1]) * ROAD_DETOUR_FACTOR

    def duration(self, a: tuple[float, float], b: tuple[float, float]) -> float:
        """Seconds by road, falling back to a flat speed over the fallback distance."""
        i, j = self._slot(a), self._slot(b)
        if i is not None and j is not None:
            value = self.durations[i][j]
            if value is not None:
                return float(value)
        return self.distance(a, b) / FALLBACK_SPEED_MPS

    @property
    def is_real_roads(self) -> bool:
        return self.provider == "osrm"

    def as_dict(self) -> dict:
        return {"provider": self.provider, "note": self.note, "points": len(self.points)}


def _haversine_matrix(unique: list[tuple[float, float]], note: str) -> RoadMatrix:
    size = len(unique)
    distances = [[0.0] * size for _ in range(size)]
    durations = [[0.0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i == j:
                continue
            metres = haversine_m(*unique[i], *unique[j]) * ROAD_DETOUR_FACTOR
            distances[i][j] = metres
            durations[i][j] = metres / FALLBACK_SPEED_MPS
    return RoadMatrix(
        points=unique,
        distances=distances,
        durations=durations,
        provider="haversine",
        note=note,
        index={_key(point): position for position, point in enumerate(unique)},
    )


def build_matrix(points: list[tuple[float, float]], timeout: int = REQUEST_TIMEOUT_S) -> RoadMatrix:
    """Distance/duration matrix for `points`, by road where possible."""
    unique: list[tuple[float, float]] = []
    index: dict = {}
    for point in points:
        key = _key(point)
        if key not in index:
            index[key] = len(unique)
            unique.append(point)

    if not unique:
        return RoadMatrix([], [], [], "haversine", "No points to route.", {})

    if not OSRM_ENABLED:
        return _haversine_matrix(unique, "Road routing disabled; straight-line estimate.")
    if len(unique) > MAX_TABLE_COORDS:
        return _haversine_matrix(
            unique,
            f"{len(unique)} distinct pickup points exceeds the {MAX_TABLE_COORDS}-point "
            "routing limit; straight-line estimate used.",
        )

    cache_path = _cache_path("table", unique)
    cached = _read_cache(cache_path)
    if cached:
        return RoadMatrix(
            points=unique,
            distances=cached["distances"],
            durations=cached["durations"],
            provider="osrm",
            note="Road distances from OSRM (cached).",
            index=index,
        )

    coordinates = ";".join(f"{point[0]:.5f},{point[1]:.5f}" for point in unique)
    url = f"{OSRM_BASE}/table/v1/driving/{coordinates}?annotations=distance,duration"
    try:
        payload = _fetch(url, timeout)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return _haversine_matrix(
            unique, f"Road routing unavailable ({type(exc).__name__}); straight-line estimate."
        )

    if payload.get("code") != "Ok" or not payload.get("distances"):
        return _haversine_matrix(
            unique,
            f"Road routing returned {payload.get('code', 'no data')}; straight-line estimate.",
        )

    distances = payload["distances"]
    durations = payload.get("durations") or [[None] * len(unique) for _ in unique]
    _write_cache(cache_path, {"distances": distances, "durations": durations})
    return RoadMatrix(
        points=unique,
        distances=distances,
        durations=durations,
        provider="osrm",
        note="Road distances and drive times from OSRM.",
        index=index,
    )


def route_geometry(
    points: list[tuple[float, float]], timeout: int = REQUEST_TIMEOUT_S
) -> list[list[float]] | None:
    """The actual road polyline through `points`, for drawing.

    Returns None when routing is unavailable, in which case callers should fall
    back to drawing straight lines between stops.
    """
    if not OSRM_ENABLED or len(points) < 2 or len(points) > MAX_TABLE_COORDS:
        return None

    cache_path = _cache_path("route", points)
    cached = _read_cache(cache_path)
    if cached is not None:
        return cached.get("geometry")

    coordinates = ";".join(f"{point[0]:.5f},{point[1]:.5f}" for point in points)
    url = f"{OSRM_BASE}/route/v1/driving/{coordinates}?overview=full&geometries=geojson"
    try:
        payload = _fetch(url, timeout)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None

    if payload.get("code") != "Ok" or not payload.get("routes"):
        return None

    geometry = payload["routes"][0].get("geometry", {}).get("coordinates")
    if not geometry:
        return None
    _write_cache(cache_path, {"geometry": geometry})
    return geometry


def drive_estimate(
    origin: tuple[float, float], destination: tuple[float, float], timeout: int = 10
) -> dict:
    """Single-pair driving distance and time, used by the commute comparison."""
    matrix = build_matrix([origin, destination], timeout=timeout)
    return {
        "distance_m": matrix.distance(origin, destination),
        "duration_s": matrix.duration(origin, destination),
        "provider": matrix.provider,
    }
