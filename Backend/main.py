"""CrossTown API.

Serves the scored access grid, Census demographics, amenity destinations and
county-level equity statistics for the Henrico County accessibility map.

Run from the repository root:

    uvicorn Backend.main:app --reload
"""

from __future__ import annotations

import math
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, datasource, scoring

app = FastAPI(
    title="CrossTown API",
    version="1.1.0",
    description="Multi-modal spatial transit accessibility engine for Henrico County, VA.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.allowed_origins(),
    # allow_credentials with a wildcard origin is rejected by browsers, and the
    # API uses no cookies, so credentials stay off and the origin list is explicit.
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

SOURCE, SOURCE_NOTE = datasource.build_source()
SCORE_CAPS = datasource.calibrate_scoring(SOURCE)

# Generous bounding box around Henrico County, used to reject geocoder results
# that land in another state (Nominatim happily returns those).
HENRICO_BBOX = (-77.72, 37.31, -77.13, 37.82)  # west, south, east, north


class AddressQuery(BaseModel):
    address: str = Field(min_length=3, max_length=200)


def _score_feature_properties(props: dict) -> dict:
    scored = scoring.score_row(props)
    enriched = dict(props)
    enriched.update(
        {
            "access_score_100": scored["scores"]["overall_score"],
            "food_100": scored["scores"]["food"],
            "health_100": scored["scores"]["health"],
            "education_100": scored["scores"]["education"],
            "civic_100": scored["scores"]["civic"],
            "band": scoring.access_band(scored["scores"]["overall_score"]),
        }
    )
    return enriched


@app.get("/")
def read_root():
    return {
        "status": "online",
        "message": "CrossTown Spatial API is running",
        "docs": "/docs",
    }


@app.get("/api/v1/health")
def health():
    """Which data backend is live, and how the scores are calibrated."""
    return {
        "status": "ok",
        "data_source": SOURCE.name,
        "note": SOURCE_NOTE,
        "score_caps": SCORE_CAPS,
        "travel_time_budget_minutes": config.TRAVEL_TIME_BUDGET_MIN,
    }


@app.get("/api/v1/grid")
def get_access_grid():
    """Access grid as GeoJSON, with 0-100 scores injected per feature."""
    try:
        grid = SOURCE.grid()
    except datasource.DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Grid fetch error: {exc}") from exc

    features = []
    for feature in grid.get("features", []):
        props = dict(feature.get("properties") or {})
        features.append({**feature, "properties": _score_feature_properties(props)})

    return {"type": "FeatureCollection", "features": features}


@app.get("/api/v1/demographics")
def get_demographics():
    try:
        return SOURCE.demographics()
    except datasource.DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Demographics fetch error: {exc}") from exc


@app.get("/api/v1/destinations")
def get_destinations(
    category: str | None = Query(default=None, description="Food | Health | Education | Civic"),
):
    """Amenity destinations used to build the access grid.

    The pipeline computed these 437 points but nothing ever displayed them, so
    there was no way to see *why* a neighbourhood scored the way it did.
    """
    try:
        rows = SOURCE.destinations()
    except datasource.DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if category:
        wanted = category.strip().lower()
        rows = [row for row in rows if row["category"].lower() == wanted]

    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [row["longitude"], row["latitude"]]},
            "properties": {
                "id": row["id"],
                "name": row["name"],
                "category": row["category"],
            },
        }
        for row in rows
    ]
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/v1/stats")
def get_stats():
    """County-wide accessibility summary plus a car-free equity crosstab.

    The equity figure answers the question the project exists to ask: what share
    of households *without a car* live in the least reachable parts of the
    county? Each block group is matched to its nearest grid node and weighted by
    its car-free household count.
    """
    try:
        rows = SOURCE.grid_rows()
    except datasource.DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not rows:
        raise HTTPException(status_code=503, detail="Access grid is empty.")

    scored = [scoring.score_row(row) for row in rows]
    overall = [item["scores"]["overall_score"] for item in scored]
    bands: dict[str, int] = {"high": 0, "moderate": 0, "low": 0, "none": 0}
    for value in overall:
        bands[scoring.access_band(value)] += 1

    category_means = {
        key: round(sum(item["scores"][key] for item in scored) / len(scored), 1)
        for key in ("food", "health", "education", "civic")
    }
    zero_counts = {
        key: sum(1 for item in scored if item["counts"][key] == 0)
        for key in ("food", "health", "education", "civic")
    }

    ordered = sorted(overall)
    summary = {
        "nodes": len(rows),
        "mean_score": round(sum(overall) / len(overall), 1),
        "median_score": ordered[len(ordered) // 2],
        "min_score": ordered[0],
        "max_score": ordered[-1],
        "bands": bands,
        "category_means": category_means,
        "nodes_with_zero_access": zero_counts,
    }

    equity = _carfree_equity(rows, scored)
    return {"summary": summary, "equity": equity, "score_caps": SCORE_CAPS}


def _polygon_centroid(coordinates) -> tuple[float, float] | None:
    """Area-weighted centroid of a (Multi)Polygon coordinate array."""
    rings: list[list] = []

    def collect(node):
        if not isinstance(node, list) or not node:
            return
        first = node[0]
        if isinstance(first, (int, float)):
            return
        if isinstance(first, list) and first and isinstance(first[0], (int, float)):
            rings.append(node)
            return
        for child in node:
            collect(child)

    collect(coordinates)
    if not rings:
        return None

    total_area = 0.0
    cx = cy = 0.0
    for ring in rings:
        area = 0.0
        rx = ry = 0.0
        for i in range(len(ring) - 1):
            x0, y0 = ring[i][0], ring[i][1]
            x1, y1 = ring[i + 1][0], ring[i + 1][1]
            cross = x0 * y1 - x1 * y0
            area += cross
            rx += (x0 + x1) * cross
            ry += (y0 + y1) * cross
        if area == 0:
            continue
        total_area += area
        cx += rx
        cy += ry

    if total_area == 0:
        flat = [pt for ring in rings for pt in ring]
        if not flat:
            return None
        return (
            sum(pt[0] for pt in flat) / len(flat),
            sum(pt[1] for pt in flat) / len(flat),
        )
    return cx / (3 * total_area), cy / (3 * total_area)


def _carfree_equity(rows: list[dict], scored: list[dict]) -> dict:
    try:
        census = SOURCE.demographics()
    except Exception:  # noqa: BLE001
        return {"available": False, "reason": "Census layer unavailable."}

    nodes: list[tuple[float, float, int]] = []
    for row, item in zip(rows, scored):
        try:
            nodes.append(
                (float(row["longitude"]), float(row["latitude"]), item["scores"]["overall_score"])
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not nodes:
        return {"available": False, "reason": "No usable grid nodes."}

    weighted: dict[str, float] = {"high": 0.0, "moderate": 0.0, "low": 0.0, "none": 0.0}
    total_carfree = 0.0
    total_households = 0.0
    matched = 0
    score_sum = 0.0

    for feature in census.get("features", []):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        centroid = _polygon_centroid(geometry.get("coordinates"))
        if centroid is None:
            continue
        lon, lat = centroid

        best_score = None
        best_distance = math.inf
        for node_lon, node_lat, node_score in nodes:
            distance = (node_lon - lon) ** 2 + (node_lat - lat) ** 2
            if distance < best_distance:
                best_distance, best_score = distance, node_score
        if best_score is None:
            continue

        try:
            carfree = float(props.get("carfree_units") or 0)
            households = float(props.get("total_units") or 0)
        except (TypeError, ValueError):
            continue

        weighted[scoring.access_band(best_score)] += carfree
        total_carfree += carfree
        total_households += households
        score_sum += best_score * carfree
        matched += 1

    if total_carfree <= 0:
        return {
            "available": False,
            "reason": "Census layer has no car-free household counts. "
            "Re-run Backend/process_census.py to load real ACS values.",
        }

    low_or_none = weighted["low"] + weighted["none"]
    return {
        "available": True,
        "block_groups": matched,
        "carfree_households": int(total_carfree),
        "total_households": int(total_households),
        "pct_carfree_countywide": round(100 * total_carfree / total_households, 1)
        if total_households
        else None,
        "carfree_by_band": {key: int(value) for key, value in weighted.items()},
        "pct_carfree_in_low_access": round(100 * low_or_none / total_carfree, 1),
        "mean_score_weighted_by_carfree": round(score_sum / total_carfree, 1),
    }


@lru_cache(maxsize=256)
def _geocode(address: str):
    """Geocode an address, cached so repeat lookups skip the network call."""
    from geopy.exc import GeocoderServiceError, GeocoderTimedOut  # noqa: PLC0415
    from geopy.geocoders import Nominatim  # noqa: PLC0415

    geolocator = Nominatim(user_agent="crosstown-henrico-accessibility/1.1", timeout=10)
    query = address if "henrico" in address.lower() else f"{address}, Henrico County, VA"
    try:
        return geolocator.geocode(query, country_codes="us")
    except (GeocoderTimedOut, GeocoderServiceError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Geocoding service unavailable ({type(exc).__name__}). Try again shortly.",
        ) from exc


@app.post("/api/v1/reachability")
def query_reachability(payload: AddressQuery):
    address = payload.address.strip()
    if not address:
        raise HTTPException(status_code=422, detail="Address must not be empty.")

    location = _geocode(address)
    if not location:
        raise HTTPException(
            status_code=404,
            detail=f"No match for that address in {config.COUNTY_NAME}, VA.",
        )

    lon, lat = location.longitude, location.latitude
    west, south, east, north = HENRICO_BBOX
    if not (west <= lon <= east and south <= lat <= north):
        raise HTTPException(
            status_code=404,
            detail=(
                f"'{location.address}' resolved outside {config.COUNTY_NAME}. "
                "Add a street number or ZIP code to narrow the search."
            ),
        )

    try:
        node = SOURCE.nearest_node(lon, lat)
    except datasource.DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    scored = scoring.score_row(node)
    distance = float(node.get("dist_meters") or 0)

    return {
        "query_address": location.address,
        "coordinates": {"latitude": lat, "longitude": lon},
        "nearest_node": {
            "id": node.get("id"),
            "node_latitude": float(node["latitude"]),
            "node_longitude": float(node["longitude"]),
            "distance_meters": round(distance, 1),
            # The grid is a ~1km lattice; flag when the closest node is far
            # enough away that the scores are only a rough proxy.
            "is_far": distance > 1500,
        },
        "scores": scored["scores"],
        "counts": scored["counts"],
        "band": scoring.access_band(scored["scores"]["overall_score"]),
    }


@app.get("/api/v1/node/{node_id}")
def get_node(node_id: int):
    """Score a single grid node so map clicks and address searches agree."""
    try:
        rows = SOURCE.grid_rows()
    except datasource.DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    for row in rows:
        try:
            if int(float(row.get("id"))) == node_id:
                scored = scoring.score_row(row)
                return {
                    "id": node_id,
                    "coordinates": {
                        "latitude": float(row["latitude"]),
                        "longitude": float(row["longitude"]),
                    },
                    "scores": scored["scores"],
                    "counts": scored["counts"],
                    "band": scoring.access_band(scored["scores"]["overall_score"]),
                }
        except (TypeError, ValueError):
            continue

    raise HTTPException(status_code=404, detail=f"Grid node {node_id} not found.")
