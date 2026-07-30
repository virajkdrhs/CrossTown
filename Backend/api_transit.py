"""Transit and commute-gap endpoints (the /api/v2 surface).

Where /api/v1 answers "what does the county look like", these answer "does this
person's commute actually work" - the question that decides whether somebody
needs a carpool.

Roster analysis takes employee *zone ids*, never addresses. The whole roster is
evaluated from a single backward scan of the transit network, because every
employee shares one worksite and one shift deadline.
"""

from __future__ import annotations

import csv
from datetime import date, datetime, timedelta
from functools import lru_cache

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from . import commute, config, gtfs, transit_router

router = APIRouter(prefix="/api/v2", tags=["transit"])

MAX_ROSTER_SIZE = 500


# ---------------------------------------------------------------- request models


class Place(BaseModel):
    """Either an address to geocode or an explicit coordinate pair."""

    address: str | None = Field(default=None, max_length=200)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    name: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def require_one(self):
        has_coords = self.lat is not None and self.lon is not None
        if not has_coords and not (self.address and self.address.strip()):
            raise ValueError("Provide either an address or both lat and lon.")
        return self


class CommuteRequest(BaseModel):
    origin: Place
    destination: Place
    shift_start: str = Field(default="09:00", pattern=r"^\d{1,2}:\d{2}$")
    shift_end: str | None = Field(default="17:00", pattern=r"^\d{1,2}:\d{2}$")
    day: str | None = Field(default=None, description="ISO date; defaults to the next weekday")
    max_walk_m: float = Field(default=transit_router.DEFAULT_MAX_WALK_M, ge=100, le=3000)


class RosterEmployee(BaseModel):
    employee_ref: str = Field(max_length=64)
    origin_zone_id: int | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    shift_start: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    shift_end: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    has_vehicle: bool | None = None


class RosterRequest(BaseModel):
    worksite: Place
    shift_start: str = Field(default="09:00", pattern=r"^\d{1,2}:\d{2}$")
    shift_end: str | None = Field(default="17:00", pattern=r"^\d{1,2}:\d{2}$")
    day: str | None = None
    employees: list[RosterEmployee] = Field(min_length=1, max_length=MAX_ROSTER_SIZE)
    max_walk_m: float = Field(default=transit_router.DEFAULT_MAX_WALK_M, ge=100, le=3000)


# ---------------------------------------------------------------------- helpers


def parse_clock(value: str) -> int:
    hours, minutes = (int(part) for part in value.split(":"))
    if not (0 <= hours <= 47 and 0 <= minutes < 60):
        raise HTTPException(status_code=422, detail=f"Invalid time '{value}'.")
    return hours * 3600 + minutes * 60


def resolve_day(value: str | None, feed: gtfs.Feed) -> date:
    """Pick a service date, defaulting to the next weekday inside the feed window."""
    if value:
        try:
            day = date.fromisoformat(value)
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail=f"Invalid day '{value}'; use YYYY-MM-DD."
            ) from exc
        if not feed.covers(day):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"The GTFS feed only covers {feed.feed_start}-{feed.feed_end}. "
                    f"Pick a date in that range or refresh the feed."
                ),
            )
        return day

    start = datetime.strptime(feed.feed_start, "%Y%m%d").date() if feed.feed_start else date.today()
    end = datetime.strptime(feed.feed_end, "%Y%m%d").date() if feed.feed_end else start
    candidate = max(start, min(date.today(), end))
    for _ in range(14):
        if candidate.weekday() < 5 and feed.covers(candidate):
            return candidate
        candidate += timedelta(days=1)
        if candidate > end:
            candidate = start
    return candidate


@lru_cache(maxsize=256)
def _geocode_cached(address: str):
    from geopy.exc import GeocoderServiceError, GeocoderTimedOut
    from geopy.geocoders import Nominatim

    geolocator = Nominatim(user_agent="crosstown-henrico-accessibility/1.1", timeout=10)
    query = address if "va" in address.lower() or "virginia" in address.lower() else f"{address}, Henrico County, VA"
    try:
        return geolocator.geocode(query, country_codes="us")
    except (GeocoderTimedOut, GeocoderServiceError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Geocoding service unavailable ({type(exc).__name__}). Try again shortly.",
        ) from exc


def resolve_place(place: Place, label: str) -> tuple[tuple[float, float], str]:
    if place.lat is not None and place.lon is not None:
        return (place.lon, place.lat), place.name or label

    located = _geocode_cached(place.address.strip())
    if not located:
        raise HTTPException(status_code=404, detail=f"Could not find '{place.address}'.")

    west, south, east, north = (-77.90, 37.20, -76.95, 37.95)
    if not (west <= located.longitude <= east and south <= located.latitude <= north):
        raise HTTPException(
            status_code=404,
            detail=(
                f"'{located.address}' is outside the Richmond region served by GRTC. "
                "Add a street number or ZIP code."
            ),
        )
    return (located.longitude, located.latitude), place.name or located.address


@lru_cache(maxsize=1)
def grid_zones() -> dict[int, tuple[float, float]]:
    """Grid node id -> (lon, lat). Zones are how the roster refers to homes."""
    from . import datasource

    zones: dict[int, tuple[float, float]] = {}
    try:
        rows = datasource.GeoJSONSource().grid_rows()
    except Exception:  # noqa: BLE001
        return zones
    for row in rows:
        try:
            zones[int(float(row["id"]))] = (float(row["longitude"]), float(row["latitude"]))
        except (KeyError, TypeError, ValueError):
            continue
    return zones


def get_feed_or_503() -> gtfs.Feed:
    try:
        return gtfs.get_feed()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


# -------------------------------------------------------------------- endpoints


@router.get("/transit/health")
def transit_health():
    """Feed metadata, so the UI can show what schedule it is reasoning about."""
    try:
        feed = gtfs.get_feed()
    except FileNotFoundError as exc:
        return {"available": False, "detail": str(exc)}

    today = date.today()
    return {
        "available": True,
        "agency": "GRTC",
        "feed_start": feed.feed_start,
        "feed_end": feed.feed_end,
        "covers_today": feed.covers(today),
        "stops": len(feed.stops),
        "routes": len(feed.routes),
        "connections": len(feed.connections),
        "default_day": resolve_day(None, feed).isoformat(),
        "assumptions": {
            "walk_speed_kmh": round(gtfs.WALK_SPEED_MPS * 3.6, 1),
            "walk_detour_factor": gtfs.WALK_DETOUR_FACTOR,
            "max_walk_metres": transit_router.DEFAULT_MAX_WALK_M,
            "min_transfer_seconds": transit_router.MIN_TRANSFER_S,
            "note": "Published schedule only; no real-time delays or street-level walking network.",
        },
    }


@router.get("/transit/stops")
def transit_stops():
    """All bus stops, for the map layer."""
    feed = get_feed_or_503()
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [stop.lon, stop.lat]},
                "properties": {"id": stop.id, "name": stop.name},
            }
            for stop in feed.stops.values()
        ],
    }


@router.post("/commute")
def evaluate_commute(payload: CommuteRequest):
    """Is this specific commute viable on transit? If not, exactly why not."""
    feed = get_feed_or_503()
    day = resolve_day(payload.day, feed)

    origin, origin_name = resolve_place(payload.origin, "Home")
    destination, destination_name = resolve_place(payload.destination, "Workplace")

    shift_start = parse_clock(payload.shift_start)
    shift_end = parse_clock(payload.shift_end) if payload.shift_end else None
    # An overnight shift ends the following morning.
    if shift_end is not None and shift_end <= shift_start:
        shift_end += 86400

    result = commute.evaluate(
        feed,
        origin,
        destination,
        shift_start,
        shift_end,
        day,
        payload.max_walk_m,
        origin_name,
        destination_name,
    )
    result["origin"] = {"name": origin_name, "lon": origin[0], "lat": origin[1]}
    result["destination"] = {
        "name": destination_name,
        "lon": destination[0],
        "lat": destination[1],
    }
    return result


@router.post("/roster/gaps")
def roster_gaps(payload: RosterRequest):
    """Which of an employer's staff cannot reach this worksite on transit.

    One backward network scan per distinct shift covers the whole roster, so a
    200-person analysis costs about the same as two individual lookups.
    """
    feed = get_feed_or_503()
    day = resolve_day(payload.day, feed)
    worksite, worksite_name = resolve_place(payload.worksite, "Worksite")
    zones = grid_zones()

    default_start = parse_clock(payload.shift_start)
    default_end = parse_clock(payload.shift_end) if payload.shift_end else None

    # Group employees by shift so each distinct shift start needs only one scan.
    grouped: dict[tuple[int, int | None], list[RosterEmployee]] = {}
    unresolved: list[str] = []
    for employee in payload.employees:
        if employee.lat is not None and employee.lon is not None:
            pass
        elif employee.origin_zone_id is not None and employee.origin_zone_id in zones:
            pass
        else:
            unresolved.append(employee.employee_ref)
            continue

        start = parse_clock(employee.shift_start) if employee.shift_start else default_start
        end = parse_clock(employee.shift_end) if employee.shift_end else default_end
        if end is not None and end <= start:
            end += 86400
        grouped.setdefault((start, end), []).append(employee)

    results = []
    for (start, end), members in sorted(grouped.items()):
        scan = transit_router.scan_backward(
            feed, worksite[0], worksite[1], start, day, payload.max_walk_m
        )
        # The trip home is identical for everyone on this shift only in its
        # departure time, so it still needs a per-employee forward search.
        for employee in members:
            if employee.lat is not None and employee.lon is not None:
                origin = (employee.lon, employee.lat)
                zone_id = employee.origin_zone_id
            else:
                origin = zones[employee.origin_zone_id]
                zone_id = employee.origin_zone_id

            assessment = commute.evaluate(
                feed,
                origin,
                worksite,
                start,
                end,
                day,
                payload.max_walk_m,
                origin_name=f"Zone {zone_id}" if zone_id is not None else "Home",
                destination_name=worksite_name,
                scan=scan,
            )
            results.append(
                {
                    "employee_ref": employee.employee_ref,
                    "origin_zone_id": zone_id,
                    "origin": {"lon": origin[0], "lat": origin[1]},
                    "shift_start": gtfs.format_seconds(start),
                    "shift_end": gtfs.format_seconds(end) if end is not None else None,
                    "has_vehicle": employee.has_vehicle,
                    "verdict": assessment["verdict"],
                    "reasons": assessment["reasons"],
                    "codes": assessment["codes"],
                    "transit_minutes": assessment["comparison"]["transit_minutes"],
                    "depart_by": (assessment["outbound"] or {}).get("depart"),
                    "transfers": (assessment["outbound"] or {}).get("transfers"),
                    "carpool_recommended": assessment["carpool_recommended"],
                }
            )

    counts: dict[str, int] = {"viable": 0, "marginal": 0, "gap": 0, "no_service": 0}
    for item in results:
        counts[item["verdict"]] = counts.get(item["verdict"], 0) + 1

    needs_help = [item for item in results if item["carpool_recommended"]]
    without_vehicle_in_gap = [
        item for item in needs_help if item["has_vehicle"] is False
    ]

    # Zones with more than one stranded employee are the natural carpool seeds.
    zone_clusters: dict[int, list[str]] = {}
    for item in needs_help:
        if item["origin_zone_id"] is not None:
            zone_clusters.setdefault(item["origin_zone_id"], []).append(item["employee_ref"])
    carpool_candidates = sorted(
        (
            {
                "origin_zone_id": zone,
                "employee_count": len(refs),
                "employees": refs,
                "lon": zones.get(zone, (None, None))[0],
                "lat": zones.get(zone, (None, None))[1],
            }
            for zone, refs in zone_clusters.items()
            if len(refs) >= 2
        ),
        key=lambda item: -item["employee_count"],
    )

    reason_tally: dict[str, int] = {}
    for item in results:
        for code in item["codes"]:
            if code in ("ok", "return_info"):
                continue
            reason_tally[code] = reason_tally.get(code, 0) + 1

    return {
        "worksite": {"name": worksite_name, "lon": worksite[0], "lat": worksite[1]},
        "day": day.isoformat(),
        "day_name": day.strftime("%A"),
        "summary": {
            "employees_analysed": len(results),
            "verdicts": counts,
            "in_gap": len(needs_help),
            "pct_in_gap": round(100 * len(needs_help) / len(results), 1) if results else 0,
            "in_gap_without_vehicle": len(without_vehicle_in_gap),
            "top_reasons": dict(
                sorted(reason_tally.items(), key=lambda pair: -pair[1])[:5]
            ),
            "unresolved_employees": unresolved,
        },
        "carpool_candidates": carpool_candidates,
        "employees": results,
    }


@router.get("/demo/roster")
def demo_roster():
    """The synthetic roster used by the employer dashboard demo."""
    path = config.DATA_DIR / "Demo" / "roster_synthetic.csv"
    if not path.exists():
        raise HTTPException(
            status_code=503,
            detail="No demo roster. Run 'python -m Backend.make_demo_roster'.",
        )
    with path.open(encoding="utf-8") as handle:
        lines = [line for line in handle if not line.lstrip().startswith("#")]
    rows = list(csv.DictReader(lines))
    return {
        "synthetic": True,
        "note": "Fabricated demo data. Origins are grid zone ids, never addresses.",
        "employees": [
            {
                "employee_ref": row["employee_ref"],
                "origin_zone_id": int(row["origin_zone_id"]),
                "shift_label": row["shift_label"],
                "shift_start": row["shift_start"],
                "shift_end": row["shift_end"],
                "has_vehicle": row["has_vehicle"] == "yes",
            }
            for row in rows
        ],
    }
