"""Build the car-free household layer for Henrico County block groups.

Vehicle availability comes from ACS table B25044:
    B25044_001E  total occupied housing units
    B25044_003E  owner occupied, no vehicle available
    B25044_010E  renter occupied, no vehicle available

Two sources, in priority order:

1. ``Data/Raw/Census/B25044_henrico_blockgroups.json`` - the Census API response
   already committed to the repo. Requires no network and no API key.
2. A live ``censusdata`` download, if the committed file is missing.

The previous version only tried the live download and, when it failed, silently
wrote a constant ``pct_carfree = 12.5`` for every block group. That is what is
currently in ``census_carfree.geojson``: 243 block groups all with the identical
placeholder value, which made the map overlay a flat single colour and any
equity statistic meaningless.
"""

from __future__ import annotations

import json
import sys

from . import config

CARFREE_FIELDS = ("B25044_003E", "B25044_010E")
TOTAL_FIELD = "B25044_001E"


def _to_int(value) -> int:
    """Census API uses negative sentinels (-666666666) for suppressed values."""
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return 0
    return number if number >= 0 else 0


def load_committed_acs() -> dict[str, dict[str, int]]:
    """Parse the committed Census API JSON into {GEOID: metrics}."""
    with config.CENSUS_B25044_JSON.open(encoding="utf-8") as handle:
        payload = json.load(handle)

    header, *rows = payload
    index = {name: position for position, name in enumerate(header)}
    geo_col = index.get("GEO_ID")
    if geo_col is None:
        raise ValueError("Census JSON is missing a GEO_ID column.")

    metrics: dict[str, dict[str, int]] = {}
    for row in rows:
        # GEO_ID looks like '1500000US510872001061'; the GEOID is the tail.
        geoid = str(row[geo_col]).split("US")[-1]
        total = _to_int(row[index[TOTAL_FIELD]])
        carfree = sum(_to_int(row[index[field]]) for field in CARFREE_FIELDS)
        metrics[geoid] = {
            "total_units": total,
            "carfree_units": carfree,
            "pct_carfree": round(100 * carfree / total, 2) if total else 0.0,
        }
    return metrics


def load_live_acs() -> dict[str, dict[str, int]]:
    """Fall back to a live ACS download via the censusdata package."""
    import censusdata  # noqa: PLC0415

    frame = censusdata.download(
        "acs5",
        2021,
        censusdata.censusgeo(
            [("state", config.STATE_FIPS), ("county", config.COUNTY_FIPS), ("block group", "*")]
        ),
        [TOTAL_FIELD, *CARFREE_FIELDS],
    )

    metrics: dict[str, dict[str, int]] = {}
    for geo, row in frame.iterrows():
        params = dict(geo.params())
        geoid = (
            f"{config.STATE_FIPS}{config.COUNTY_FIPS}"
            f"{params['tract']}{params['block group']}"
        )
        total = _to_int(row[TOTAL_FIELD])
        carfree = sum(_to_int(row[field]) for field in CARFREE_FIELDS)
        metrics[geoid] = {
            "total_units": total,
            "carfree_units": carfree,
            "pct_carfree": round(100 * carfree / total, 2) if total else 0.0,
        }
    return metrics


def load_geometries() -> dict:
    """Reuse the committed block group geometries, or download them via pygris."""
    if config.CENSUS_GEOJSON.exists():
        with config.CENSUS_GEOJSON.open(encoding="utf-8") as handle:
            return json.load(handle)

    import pygris  # noqa: PLC0415

    gdf = pygris.block_groups(state="VA", county="Henrico", cb=True, year=2021)
    gdf["GEOID"] = gdf["GEOID"].astype(str)
    return json.loads(gdf.to_crs("EPSG:4326")[["GEOID", "geometry"]].to_json())


def main() -> int:
    print("--- Building Census car-free demographics layer ---")

    if config.CENSUS_B25044_JSON.exists():
        print(f"[1/3] Reading committed ACS data: {config.CENSUS_B25044_JSON.name}")
        metrics = load_committed_acs()
    else:
        print("[1/3] Committed ACS file missing; attempting live Census download...")
        metrics = load_live_acs()
    print(f"      {len(metrics)} block groups of vehicle-availability data")

    print("[2/3] Joining metrics to block group geometries...")
    collection = load_geometries()
    matched = 0
    features = []
    for feature in collection.get("features", []):
        props = dict(feature.get("properties") or {})
        geoid = str(props.get("GEOID", ""))
        stats = metrics.get(geoid)
        if stats:
            matched += 1
        else:
            stats = {"total_units": 0, "carfree_units": 0, "pct_carfree": 0.0}
        features.append(
            {
                "type": "Feature",
                "geometry": feature.get("geometry"),
                "properties": {"GEOID": geoid, **stats},
            }
        )

    total = len(features)
    print(f"      matched {matched}/{total} block groups")
    if total and matched / total < 0.5:
        print("      ERROR: fewer than half the block groups matched - refusing to write.")
        return 1

    print(f"[3/3] Writing {config.CENSUS_GEOJSON.relative_to(config.ROOT_DIR)}...")
    config.CENSUS_GEOJSON.parent.mkdir(parents=True, exist_ok=True)
    with config.CENSUS_GEOJSON.open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": features}, handle)

    percentages = sorted(f["properties"]["pct_carfree"] for f in features)
    carfree_total = sum(f["properties"]["carfree_units"] for f in features)
    units_total = sum(f["properties"]["total_units"] for f in features)
    print(
        f"--- Done. pct_carfree ranges {percentages[0]:.1f}% to {percentages[-1]:.1f}% "
        f"(county-wide {100 * carfree_total / units_total:.1f}% of "
        f"{units_total:,} households) ---"
        if units_total
        else "--- Done. ---"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
