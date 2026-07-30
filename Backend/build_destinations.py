"""Rebuild Data/Processed/destinations.csv from the raw asset layers.

Why this exists
---------------
The committed ``destinations.csv`` has 302 of its 437 rows in the ``Food``
category, and a large share of them are not food retail at all. The Overpass
extract in ``Data/Raw/Assets/Grocery_stores.geojson`` matched anything whose
name contains "Market", so 54 features are tagged ``highway=residential`` -
"New Market Road" appears 39 times, plus a hairdresser, a florist, an optician
and a money lender. Because Food is the largest category it dominates
``access_score``, so those road segments inflate every score in the county.

This script applies explicit per-category filters, drops duplicates, and reports
what it removed. Run it before ``routing_engine.py`` so the travel-time matrix
is built against real destinations.

    python -m Backend.build_destinations --dry-run   # report only
    python -m Backend.build_destinations            # write destinations.csv

Note: ``access_grid_final.geojson`` in the repository was produced from the
unfiltered list. After writing a new destinations.csv you need to re-run
``routing_engine.py`` and ``calculate_scores.py`` for the grid to match.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys

from . import config

# OSM shop/amenity values that genuinely sell food.
FOOD_SHOP_TAGS = {
    "supermarket",
    "convenience",
    "grocery",
    "greengrocer",
    "general",
    "deli",
    "butcher",
    "seafood",
    "bakery",
    "farm",
    "food",
    "health_food",
    "frozen_food",
    "wholesale",
}
FOOD_AMENITY_TAGS = {"marketplace"}

HEALTH_AMENITY_TAGS = {"clinic", "doctors", "hospital", "pharmacy", "dentist"}


def _centroid(geometry: dict | None) -> tuple[float, float] | None:
    """Representative point for any geometry type in the raw asset files."""
    if not geometry:
        return None
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    if kind == "Point":
        return float(coords[0]), float(coords[1])

    points: list[tuple[float, float]] = []

    def walk(node):
        if isinstance(node, (int, float)):
            return
        if (
            isinstance(node, list)
            and len(node) >= 2
            and all(isinstance(value, (int, float)) for value in node[:2])
        ):
            points.append((float(node[0]), float(node[1])))
            return
        if isinstance(node, list):
            for child in node:
                walk(child)

    walk(coords)
    if not points:
        return None
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def _load(filename: str) -> list[dict]:
    path = config.ASSETS_DIR / filename
    if not path.exists():
        print(f"  WARNING: missing {path.relative_to(config.ROOT_DIR)}")
        return []
    with path.open(encoding="utf-8") as handle:
        return json.load(handle).get("features", [])


def collect_food() -> tuple[list[dict], dict[str, int]]:
    rejected = {"road_segment": 0, "untagged": 0, "non_food_shop": 0}
    rows = []
    for feature in _load("Grocery_stores.geojson"):
        props = feature.get("properties") or {}
        shop = (props.get("shop") or "").lower()
        amenity = (props.get("amenity") or "").lower()

        if props.get("highway") and not shop and amenity not in FOOD_AMENITY_TAGS:
            rejected["road_segment"] += 1
            continue
        if not shop and not amenity:
            rejected["untagged"] += 1
            continue
        if shop and shop not in FOOD_SHOP_TAGS and amenity not in FOOD_AMENITY_TAGS:
            rejected["non_food_shop"] += 1
            continue
        if not shop and amenity not in FOOD_AMENITY_TAGS:
            # amenity-only features such as restaurants/fuel are not groceries
            rejected["non_food_shop"] += 1
            continue

        point = _centroid(feature.get("geometry"))
        if point is None:
            continue
        rows.append(
            {
                "name": props.get("name") or f"{shop or amenity}".title(),
                "category": "Food",
                "longitude": point[0],
                "latitude": point[1],
            }
        )
    return rows, rejected


def collect_health() -> tuple[list[dict], dict[str, int]]:
    rejected = {"non_health": 0}
    rows = []
    for feature in _load("Clinics.geojson"):
        props = feature.get("properties") or {}
        amenity = (props.get("amenity") or "").lower()
        healthcare = (props.get("healthcare") or "").lower()
        if not healthcare and amenity not in HEALTH_AMENITY_TAGS:
            rejected["non_health"] += 1
            continue
        point = _centroid(feature.get("geometry"))
        if point is None:
            continue
        rows.append(
            {
                "name": props.get("name") or (healthcare or amenity).title(),
                "category": "Health",
                "longitude": point[0],
                "latitude": point[1],
            }
        )
    return rows, rejected


def collect_education() -> tuple[list[dict], dict[str, int]]:
    rows = []
    for feature in _load("Schools.geojson"):
        props = feature.get("properties") or {}
        point = _centroid(feature.get("geometry"))
        if point is None:
            continue
        rows.append(
            {
                "name": props.get("NAME_") or props.get("LABEL") or "School",
                "category": "Education",
                "longitude": point[0],
                "latitude": point[1],
            }
        )
    return rows, {}


def collect_civic() -> tuple[list[dict], dict[str, int]]:
    rows = []
    for feature in _load("Libraries.geojson"):
        props = feature.get("properties") or {}
        point = _centroid(feature.get("geometry"))
        if point is None:
            continue
        rows.append(
            {
                "name": props.get("BRANCH") or "Library",
                "category": "Civic",
                "longitude": point[0],
                "latitude": point[1],
            }
        )
    return rows, {}


def collect_recreation() -> tuple[list[dict], dict[str, int]]:
    """Athletic courts, grouped by parent facility.

    These 65 polygons were downloaded but never used by the pipeline. Several
    courts share one park, so they are collapsed to one destination per facility
    to avoid a single park counting as a dozen reachable amenities.
    """
    grouped: dict[str, list[tuple[float, float]]] = {}
    names: dict[str, str] = {}
    for feature in _load("Athletic_Courts.geojson"):
        props = feature.get("properties") or {}
        point = _centroid(feature.get("geometry"))
        if point is None:
            continue
        key = str(
            props.get("Parent_Asset_ID")
            or props.get("Location_Description")
            or props.get("Asset_Name")
            or props.get("OBJECTID")
        )
        grouped.setdefault(key, []).append(point)
        names.setdefault(
            key, props.get("Location_Description") or props.get("Asset_Name") or "Athletic Courts"
        )

    rows = []
    for key, points in grouped.items():
        rows.append(
            {
                "name": names[key],
                "category": "Recreation",
                "longitude": sum(p[0] for p in points) / len(points),
                "latitude": sum(p[1] for p in points) / len(points),
            }
        )
    return rows, {"collapsed_courts": 65 - len(rows)}


def deduplicate(rows: list[dict]) -> tuple[list[dict], int]:
    """Drop rows that repeat the same name at effectively the same spot."""
    seen: set[tuple] = set()
    unique = []
    for row in rows:
        key = (
            row["category"],
            row["name"].strip().lower(),
            round(row["longitude"], 4),
            round(row["latitude"], 4),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)
    return unique, len(rows) - len(unique)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report the filtered counts without writing destinations.csv",
    )
    parser.add_argument(
        "--include-recreation",
        action="store_true",
        help="add athletic courts as a Recreation category (requires a matrix rebuild)",
    )
    args = parser.parse_args(argv)

    print("--- Building destination list from raw asset layers ---")
    collectors = [collect_food, collect_health, collect_education, collect_civic]
    if args.include_recreation:
        collectors.append(collect_recreation)

    rows: list[dict] = []
    for collector in collectors:
        collected, rejected = collector()
        label = collector.__name__.replace("collect_", "").title()
        detail = ", ".join(f"{k}={v}" for k, v in rejected.items() if v) or "none"
        print(f"  {label:<11} kept {len(collected):>3}   dropped: {detail}")
        rows.extend(collected)

    rows, duplicates = deduplicate(rows)
    print(f"  Removed {duplicates} duplicate destination(s)")

    for index, row in enumerate(rows, start=1):
        row["id"] = index

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["category"]] = counts.get(row["category"], 0) + 1
    print(f"  Total {len(rows)} destinations: {counts}")

    if args.dry_run:
        print("--- Dry run: destinations.csv left unchanged ---")
        return 0

    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    with config.DESTINATIONS_CSV.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=["id", "name", "category", "latitude", "longitude"]
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "category": row["category"],
                    "latitude": round(row["latitude"], 7),
                    "longitude": round(row["longitude"], 7),
                }
            )

    print(f"--- Wrote {config.DESTINATIONS_CSV.relative_to(config.ROOT_DIR)} ---")
    print("    Re-run routing_engine.py then calculate_scores.py to refresh the grid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
