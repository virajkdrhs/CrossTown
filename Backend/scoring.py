"""Single source of truth for turning raw amenity counts into 0-100 scores.

Previously this logic lived in Backend/main.py *and* was duplicated with
different constants in Frontend/app.js, so the same grid point could show two
different scores depending on whether you searched an address or clicked the
map. Everything now goes through this module and the frontend only renders what
the API returns.

Normalisation is data-driven: rather than hard-coded denominators, the ramp for
each category is calibrated from the 95th percentile of the grid itself. That
keeps the scale meaningful when the grid is rebuilt with different data.
"""

from __future__ import annotations

CATEGORIES = ("Food", "Health", "Education", "Civic")

# Fallback denominators used only if calibration has not run yet.
_DEFAULT_CAPS: dict[str, float] = {
    "Food": 15.0,
    "Health": 6.0,
    "Education": 4.0,
    "Civic": 2.0,
    "access_score": 20.0,
}

_caps: dict[str, float] = dict(_DEFAULT_CAPS)


def _percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, max(0, round(fraction * (len(sorted_values) - 1))))
    return float(sorted_values[index])


def calibrate(rows: list[dict]) -> dict[str, float]:
    """Derive per-category normalisation caps from the access grid.

    Uses the 95th percentile so a single outlier node does not flatten the rest
    of the county, with a floor of 1 to avoid divide-by-zero.
    """
    global _caps
    if not rows:
        return dict(_caps)

    new_caps: dict[str, float] = {}
    for key in (*CATEGORIES, "access_score"):
        values = sorted(float(row.get(key) or 0) for row in rows)
        new_caps[key] = max(1.0, _percentile(values, 0.95))
    _caps = new_caps
    return dict(_caps)


def caps() -> dict[str, float]:
    return dict(_caps)


def scale_to_100(value, cap: float) -> int:
    """Normalise a raw count to 0-100 against `cap`, clamped at both ends."""
    if value is None:
        return 0
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0
    if numeric <= 0 or cap <= 0:
        return 0
    return min(100, round((numeric / cap) * 100))


def score_row(row: dict) -> dict:
    """Score one grid node.

    A genuine zero stays zero. The old implementation substituted 75% of the
    overall score whenever a category count was 0 or missing, which meant the
    71 grid nodes with no reachable clinic still displayed a healthy Health
    score - exactly backwards for an equity tool.
    """
    raw_counts = {key: int(float(row.get(key) or 0)) for key in CATEGORIES}
    overall_raw = row.get("access_score")
    if overall_raw is None:
        overall_raw = sum(raw_counts.values())

    scores = {
        "overall_score": scale_to_100(overall_raw, _caps["access_score"]),
        "food": scale_to_100(raw_counts["Food"], _caps["Food"]),
        "health": scale_to_100(raw_counts["Health"], _caps["Health"]),
        "education": scale_to_100(raw_counts["Education"], _caps["Education"]),
        "civic": scale_to_100(raw_counts["Civic"], _caps["Civic"]),
    }
    return {
        "scores": scores,
        "counts": {
            "food": raw_counts["Food"],
            "health": raw_counts["Health"],
            "education": raw_counts["Education"],
            "civic": raw_counts["Civic"],
            "total": int(float(overall_raw)),
        },
    }


def access_band(score_100: int) -> str:
    """Human-readable band used for the map legend and summary statistics."""
    if score_100 >= 70:
        return "high"
    if score_100 >= 35:
        return "moderate"
    if score_100 > 0:
        return "low"
    return "none"
