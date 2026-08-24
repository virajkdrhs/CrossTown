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
import re
from datetime import date, datetime, timedelta
from functools import lru_cache

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from . import carpool, commute, config, gazetteer, gtfs, microtransit, roadnetwork, transit_router

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
        if has_coords:
            return self
        text = (self.address or "").strip()
        if not text:
            raise ValueError("Provide either an address or both lat and lon.")
        # A one- or two-character query is not an address. Nominatim will still
        # happily return *something* for it, and the planner would then report a
        # confident verdict for a trip nobody asked about.
        if len(text) < 3:
            raise ValueError("An address needs at least 3 characters.")
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


class CarpoolRequest(RosterRequest):
    seats_per_driver: int = Field(default=carpool.DEFAULT_SEATS, ge=1, le=7)
    max_detour_minutes: int = Field(default=carpool.DEFAULT_MAX_DETOUR_MIN, ge=5, le=60)


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


# The GRTC service area, used to bias and bound geocoding.
# geopy takes viewbox corners as (latitude, longitude) - the opposite order to
# the (lon, lat) convention used everywhere else in this codebase.
REGION_VIEWBOX = [(37.20, -77.90), (37.95, -76.95)]


@lru_cache(maxsize=256)
def _geocode_cached(address: str):
    """Geocode within the Richmond region.

    Biasing to a bounding box beats appending a county name. The old approach
    forced ", Henrico County, VA" onto every query, so anything in the City of
    Richmond - "Downtown Richmond", say - became unresolvable, even though GRTC
    serves it and the rest of the app handles it fine.
    """
    # Shipped gazetteer first: instant, and it works where Nominatim is blocked
    # (most cloud hosts), which is exactly where this runs when deployed.
    known = gazetteer.lookup(address)
    if known is not None:
        return known

    from geopy.exc import GeocoderServiceError, GeocoderTimedOut
    from geopy.geocoders import Nominatim

    geolocator = Nominatim(user_agent="crosstown-henrico-accessibility/1.1", timeout=10)
    already_qualified = bool(re.search(r"\b(va|virginia)\b", address.lower()))
    attempts = [address if already_qualified else f"{address}, Virginia"]
    if not already_qualified:
        # Fall back to naming the county explicitly for bare street addresses,
        # which are ambiguous without it.
        attempts.append(f"{address}, Henrico County, VA")

    try:
        for query in attempts:
            located = geolocator.geocode(
                query, country_codes="us", viewbox=REGION_VIEWBOX, bounded=True
            )
            if located:
                return located
        return None
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


@router.get("/microtransit/zones")
def microtransit_zones(day: str | None = None):
    """GRTC LINK on-demand zones, with today's hours resolved.

    LINK is absent from the GTFS feed, so this is the only place the app learns
    that large parts of eastern Henrico have fare-free on-demand service.
    """
    collection = microtransit.zones_geojson()
    try:
        feed = gtfs.get_feed()
        service_day = resolve_day(day, feed)
    except (FileNotFoundError, HTTPException):
        service_day = date.today()

    features = []
    for feature in collection.get("features", []):
        props = dict(feature.get("properties") or {})
        zone = dict(props)
        zone["geometry"] = feature.get("geometry")
        described = microtransit.describe(zone, service_day)
        features.append({**feature, "properties": {**props, **described}})

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": collection.get("metadata", {}),
        "day": service_day.isoformat(),
        "day_name": service_day.strftime("%A"),
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


def evaluate_roster(payload: RosterRequest, feed, day, worksite, worksite_name, road_matrix=None):
    """Transit verdict for every employee against one worksite.

    One backward network scan per distinct shift covers the whole roster, so a
    200-person analysis costs about the same as two individual lookups. Shared by
    the gap report and the carpool planner.
    """
    zones = grid_zones()
    default_start = parse_clock(payload.shift_start)
    default_end = parse_clock(payload.shift_end) if payload.shift_end else None

    # Group employees by shift so each distinct shift start needs only one scan.
    grouped: dict[tuple[int, int | None], list[RosterEmployee]] = {}
    unresolved: list[str] = []
    for employee in payload.employees:
        has_coords = employee.lat is not None and employee.lon is not None
        has_zone = employee.origin_zone_id is not None and employee.origin_zone_id in zones
        if not has_coords and not has_zone:
            unresolved.append(employee.employee_ref)
            continue

        start = parse_clock(employee.shift_start) if employee.shift_start else default_start
        end = parse_clock(employee.shift_end) if employee.shift_end else default_end
        if end is not None and end <= start:
            end += 86400
        grouped.setdefault((start, end), []).append(employee)

    # Build the road matrix once for the whole roster. Per-employee routing calls
    # turned a 60-person analysis into a minute of sequential network waiting.
    if road_matrix is None:
        origins = []
        for members in grouped.values():
            for employee in members:
                if employee.lat is not None and employee.lon is not None:
                    origins.append((employee.lon, employee.lat))
                else:
                    origins.append(zones[employee.origin_zone_id])
        road_matrix = roadnetwork.build_matrix(origins + [worksite])

    results = []
    for (start, end), members in sorted(grouped.items()):
        scan = transit_router.scan_backward(
            feed, worksite[0], worksite[1], start, day, payload.max_walk_m
        )
        # The trip home shares only its departure time across the shift, so it
        # still needs a per-employee forward search.
        for employee in members:
            if employee.lat is not None and employee.lon is not None:
                origin = (employee.lon, employee.lat)
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
                road_matrix=road_matrix,
            )
            results.append(
                {
                    "employee_ref": employee.employee_ref,
                    "origin_zone_id": zone_id,
                    "origin": {"lon": origin[0], "lat": origin[1]},
                    "shift_start": gtfs.format_seconds(start),
                    "shift_start_s": start,
                    "shift_end": gtfs.format_seconds(end) if end is not None else None,
                    "shift_end_s": end,
                    "has_vehicle": employee.has_vehicle,
                    "verdict": assessment["verdict"],
                    "reasons": assessment["reasons"],
                    "codes": assessment["codes"],
                    "transit_minutes": assessment["comparison"]["transit_minutes"],
                    "depart_by": (assessment["outbound"] or {}).get("depart"),
                    "transfers": (assessment["outbound"] or {}).get("transfers"),
                    "carpool_recommended": assessment["carpool_recommended"],
                    "has_microtransit_option": assessment["has_microtransit_option"],
                    "drive_cost_per_year_usd": assessment["cost"]["drive_cost_per_year_usd"],
                }
            )

    return results, unresolved


@router.post("/roster/gaps")
def roster_gaps(payload: RosterRequest):
    """Which of an employer's staff cannot reach this worksite on transit."""
    feed = get_feed_or_503()
    day = resolve_day(payload.day, feed)
    worksite, worksite_name = resolve_place(payload.worksite, "Worksite")
    zones = grid_zones()

    results, unresolved = evaluate_roster(payload, feed, day, worksite, worksite_name)

    counts: dict[str, int] = {
        "viable": 0,
        "marginal": 0,
        "microtransit": 0,
        "gap": 0,
        "no_service": 0,
    }
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


@router.post("/carpool/plan")
def carpool_plan(payload: CarpoolRequest):
    """Form carpools between staff who cannot reach the worksite and staff who drive.

    Riders are people with no vehicle whose transit commute is a gap. Drivers are
    colleagues on the same shift who are already making the trip by car, so a
    seat costs them a detour rather than a journey.

    Pickups happen at access grid zone points - public locations on a ~800 m
    lattice - never at a home address, which is the same rule the rest of the
    roster pipeline follows.
    """
    feed = get_feed_or_503()
    day = resolve_day(payload.day, feed)
    worksite, worksite_name = resolve_place(payload.worksite, "Worksite")

    # One matrix serves both the transit evaluation and the carpool matching.
    zones = grid_zones()
    origins = [
        (employee.lon, employee.lat)
        if employee.lat is not None and employee.lon is not None
        else zones.get(employee.origin_zone_id, worksite)
        for employee in payload.employees
    ]
    road_matrix = roadnetwork.build_matrix(origins + [worksite])

    results, unresolved = evaluate_roster(
        payload, feed, day, worksite, worksite_name, road_matrix=road_matrix
    )

    people = [
        carpool.Person(
            ref=row["employee_ref"],
            lon=row["origin"]["lon"],
            lat=row["origin"]["lat"],
            zone_id=row["origin_zone_id"],
            has_vehicle=bool(row["has_vehicle"]),
            verdict=row["verdict"],
            shift_start_s=row["shift_start_s"],
            shift_end_s=row["shift_end_s"],
        )
        for row in results
    ]

    plan = carpool.plan(
        people,
        worksite,
        seats_per_driver=payload.seats_per_driver,
        max_detour_min=payload.max_detour_minutes,
        matrix=road_matrix,
    )

    drivers_available = sum(1 for person in people if person.has_vehicle)
    plan["summary"]["drivers_available"] = drivers_available
    plan["summary"]["employees_analysed"] = len(results)
    plan["summary"]["unresolved_employees"] = unresolved
    plan["worksite"] = {"name": worksite_name, "lon": worksite[0], "lat": worksite[1]}
    plan["day"] = day.isoformat()
    plan["day_name"] = day.strftime("%A")
    plan["note"] = (
        "Proposals only. In the live product both parties opt in inside a verified "
        "organisation before any contact details are exchanged."
    )
    return plan


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
