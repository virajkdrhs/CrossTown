"""GRTC LINK on-demand microtransit zones.

Why this module exists
----------------------
LINK is real, fare-free, GRTC-operated transit, and it is **not in the GTFS
feed** — the feed carries fixed routes only. Without this layer the trip planner
confidently reports "no service" for places like Elko and Varina that GRTC
actually serves on demand. That is the worst kind of wrong answer for this
project: it tells the exact population the app exists for that they have no
option, when they do.

What LINK is: you book in the GRTC On the Go app or by phone, a van arrives in
about 20 minutes (60 in Powhatan), and it carries you anywhere inside the zone —
including to a connecting fixed-route bus stop. No fare.

Zone boundaries here are approximate; GRTC publishes zone maps as images rather
than open data. Everything downstream labels them as such.
"""

from __future__ import annotations

import json
from datetime import date
from functools import lru_cache

from . import config

BOOKING_PHONE = "(804) 358-4782"
BOOKING_APP = "GRTC On the Go"
MAX_PASSENGERS = 4

ZONES_PATH = config.RAW_DIR / "Transit" / "link_zones.geojson"


def _point_in_ring(lon: float, lat: float, ring: list) -> bool:
    """Standard ray-casting test."""
    inside = False
    count = len(ring)
    for i in range(count):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % count][0], ring[(i + 1) % count][1]
        if (y1 > lat) != (y2 > lat):
            x_at = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < x_at:
                inside = not inside
    return inside


def _point_in_geometry(lon: float, lat: float, geometry: dict) -> bool:
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    polygons = coordinates if kind == "MultiPolygon" else [coordinates]
    for polygon in polygons:
        if not polygon:
            continue
        if _point_in_ring(lon, lat, polygon[0]):
            # Subtract any holes.
            if not any(_point_in_ring(lon, lat, hole) for hole in polygon[1:]):
                return True
    return False


@lru_cache(maxsize=1)
def load_zones() -> list[dict]:
    if not ZONES_PATH.exists():
        return []
    with ZONES_PATH.open(encoding="utf-8") as handle:
        collection = json.load(handle)
    zones = []
    for feature in collection.get("features", []):
        props = dict(feature.get("properties") or {})
        props["geometry"] = feature.get("geometry")
        zones.append(props)
    return zones


@lru_cache(maxsize=1)
def zones_geojson() -> dict:
    if not ZONES_PATH.exists():
        return {"type": "FeatureCollection", "features": [], "metadata": {}}
    with ZONES_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _day_key(day: date) -> str:
    weekday = day.weekday()
    if weekday < 5:
        return "weekday"
    return "saturday" if weekday == 5 else "sunday"


def _clock_to_seconds(value: str) -> int:
    hours, minutes = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60


def zone_at(lon: float, lat: float) -> dict | None:
    """The LINK zone containing a point, if any."""
    for zone in load_zones():
        if _point_in_geometry(lon, lat, zone.get("geometry") or {}):
            return zone
    return None


def service_window(zone: dict, day: date) -> tuple[int, int] | None:
    """Seconds-since-midnight window the zone runs on this date, or None."""
    window = (zone.get("hours") or {}).get(_day_key(day))
    if not window:
        return None
    return _clock_to_seconds(window[0]), _clock_to_seconds(window[1])


def covers(zone: dict, day: date, time_s: int) -> bool:
    window = service_window(zone, day)
    if window is None:
        return False
    # A trip that needs a pickup before opening cannot use LINK.
    return window[0] <= (time_s % 86400) <= window[1]


def describe(zone: dict, day: date) -> dict:
    window = service_window(zone, day)
    return {
        "zone_id": zone.get("zone_id"),
        "name": zone.get("name"),
        "locality": zone.get("locality"),
        "wait_minutes": zone.get("wait_minutes"),
        "connects_routes": zone.get("connects_routes") or [],
        "key_destinations": zone.get("key_destinations") or [],
        "prebook_hours": zone.get("prebook_hours") or 0,
        "runs_today": window is not None,
        "hours_today": (zone.get("hours") or {}).get(_day_key(day)),
        "fare": "Free",
        "booking": {"app": BOOKING_APP, "phone": BOOKING_PHONE, "max_passengers": MAX_PASSENGERS},
    }


def evaluate_options(
    origin: tuple[float, float],
    destination: tuple[float, float],
    day: date,
    depart_s: int,
    arrive_s: int,
) -> list[dict]:
    """LINK options for a trip, best first.

    Three shapes, in descending usefulness:

    * both ends in the same zone  -> LINK covers the whole trip
    * origin in a zone            -> LINK to a connecting bus stop
    * destination in a zone       -> bus to the zone edge, LINK the last leg
    """
    origin_zone = zone_at(*origin)
    destination_zone = zone_at(*destination)
    options: list[dict] = []

    if origin_zone and destination_zone and origin_zone["zone_id"] == destination_zone["zone_id"]:
        available = covers(origin_zone, day, depart_s) and covers(origin_zone, day, arrive_s)
        options.append(
            {
                "kind": "door_to_door",
                "zone": describe(origin_zone, day),
                "available": available,
                "headline": f"LINK covers this whole trip inside the {origin_zone['name']} zone",
                "detail": (
                    f"Book in the {BOOKING_APP} app or call {BOOKING_PHONE}. A van arrives in about "
                    f"{origin_zone['wait_minutes']} minutes and takes you anywhere in the zone. No fare."
                )
                if available
                else (
                    f"The {origin_zone['name']} zone does not run at this hour "
                    f"({_hours_text(origin_zone, day)})."
                ),
            }
        )
        return options

    if origin_zone:
        available = covers(origin_zone, day, depart_s)
        options.append(
            {
                "kind": "first_mile",
                "zone": describe(origin_zone, day),
                "available": available,
                "headline": f"LINK can carry you from home to a bus connection ({origin_zone['name']} zone)",
                "detail": (
                    "Connects to "
                    + ", ".join(f"Route {route}" for route in (origin_zone.get("connects_routes") or [])[:4])
                    + f". About a {origin_zone['wait_minutes']}-minute wait, no fare."
                )
                if available
                else f"The {origin_zone['name']} zone does not run at this hour ({_hours_text(origin_zone, day)}).",
            }
        )

    if destination_zone:
        available = covers(destination_zone, day, arrive_s)
        options.append(
            {
                "kind": "last_mile",
                "zone": describe(destination_zone, day),
                "available": available,
                "headline": f"LINK can cover the last leg to work ({destination_zone['name']} zone)",
                "detail": (
                    "Take a connecting bus into the zone, then book LINK for the final stretch. "
                    f"About a {destination_zone['wait_minutes']}-minute wait, no fare."
                )
                if available
                else f"The {destination_zone['name']} zone does not run at this hour ({_hours_text(destination_zone, day)}).",
            }
        )

    return options


def _hours_text(zone: dict, day: date) -> str:
    window = service_window(zone, day)
    if not window:
        return "closed today"
    hours = (zone.get("hours") or {}).get(_day_key(day))
    return f"{hours[0]}–{hours[1]}"
