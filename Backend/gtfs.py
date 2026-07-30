"""Load a GTFS feed into the compact in-memory structures the router needs.

Reads straight from the zip with the standard library only - no pandas, no JVM,
no OpenStreetMap extract. The GRTC feed is ~4 MB zipped and indexes in about a
second, which is what makes it practical to answer live commute queries.
"""

from __future__ import annotations

import csv
import io
import math
import zipfile
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache

from . import config

# Straight-line distance is scaled by this to approximate real walking routes,
# since we have no pedestrian street network. Deliberately conservative.
WALK_DETOUR_FACTOR = 1.35
WALK_SPEED_MPS = 1.33  # ~4.8 km/h, an unhurried adult pace

# Two stops closer than this are treated as walkable for a transfer.
TRANSFER_WALK_RADIUS_M = 250.0


def parse_gtfs_time(value: str) -> int | None:
    """GTFS times are seconds since noon-minus-12h and may exceed 24:00:00."""
    if not value:
        return None
    parts = value.strip().split(":")
    if len(parts) != 3:
        return None
    try:
        hours, minutes, seconds = (int(part) for part in parts)
    except ValueError:
        return None
    return hours * 3600 + minutes * 60 + seconds


def format_seconds(total: int | None) -> str | None:
    """Render seconds-since-midnight as HH:MM, wrapping past-midnight times."""
    if total is None:
        return None
    total = int(total) % 86400
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}"


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6_371_008.8
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def walk_seconds(distance_m: float) -> int:
    return int(round(distance_m * WALK_DETOUR_FACTOR / WALK_SPEED_MPS))


@dataclass(frozen=True)
class Stop:
    id: str
    name: str
    lat: float
    lon: float


@dataclass(frozen=True)
class Connection:
    """One vehicle hop between two consecutive stops."""

    dep_stop: str
    arr_stop: str
    dep_time: int
    arr_time: int
    trip_id: str
    route_short: str
    headsign: str


@dataclass
class Feed:
    stops: dict[str, Stop]
    # Connections sorted by departure time, plus the same list sorted by arrival.
    connections: list[Connection]
    by_departure: list[int] = field(default_factory=list)
    by_arrival: list[int] = field(default_factory=list)
    # trip_id -> service_id, and service calendars for date resolution.
    trip_service: dict[str, str] = field(default_factory=dict)
    calendar: dict[str, dict] = field(default_factory=dict)
    calendar_dates: dict[tuple[str, str], int] = field(default_factory=dict)
    footpaths: dict[str, list[tuple[str, int]]] = field(default_factory=dict)
    feed_start: str = ""
    feed_end: str = ""
    routes: dict[str, str] = field(default_factory=dict)

    def services_on(self, day: date) -> set[str]:
        """Which service_ids run on a given calendar date."""
        weekday = (
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        )[day.weekday()]
        stamp = day.strftime("%Y%m%d")

        active: set[str] = set()
        for service_id, row in self.calendar.items():
            if not (row["start_date"] <= stamp <= row["end_date"]):
                continue
            if row[weekday] == "1":
                active.add(service_id)

        for (service_id, exception_date), exception_type in self.calendar_dates.items():
            if exception_date != stamp:
                continue
            if exception_type == 1:
                active.add(service_id)
            elif exception_type == 2:
                active.discard(service_id)
        return active

    def covers(self, day: date) -> bool:
        stamp = day.strftime("%Y%m%d")
        return bool(self.feed_start) and self.feed_start <= stamp <= self.feed_end

    def stops_near(self, lon: float, lat: float, radius_m: float) -> list[tuple[Stop, float]]:
        """Every stop within `radius_m` straight-line metres, nearest first."""
        found = []
        for stop in self.stops.values():
            distance = haversine_m(lon, lat, stop.lon, stop.lat)
            if distance <= radius_m:
                found.append((stop, distance))
        found.sort(key=lambda pair: pair[1])
        return found


def _read_csv(archive: zipfile.ZipFile, name: str) -> list[dict]:
    try:
        raw = archive.read(name)
    except KeyError:
        return []
    text = raw.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def _build_footpaths(stops: dict[str, Stop]) -> dict[str, list[tuple[str, int]]]:
    """Walking transfers between nearby stops, via a coarse spatial grid.

    transfers.txt is empty in the GRTC feed, so without this every trip would be
    a single-vehicle ride and most cross-town journeys would look impossible.
    """
    cell = TRANSFER_WALK_RADIUS_M / 111_320  # rough degrees per metre of latitude
    buckets: dict[tuple[int, int], list[Stop]] = {}
    for stop in stops.values():
        key = (int(stop.lat / cell), int(stop.lon / cell))
        buckets.setdefault(key, []).append(stop)

    footpaths: dict[str, list[tuple[str, int]]] = {}
    for stop in stops.values():
        key_lat, key_lon = int(stop.lat / cell), int(stop.lon / cell)
        neighbours: list[tuple[str, int]] = []
        for d_lat in (-1, 0, 1):
            for d_lon in (-1, 0, 1):
                for other in buckets.get((key_lat + d_lat, key_lon + d_lon), ()):
                    if other.id == stop.id:
                        continue
                    distance = haversine_m(stop.lon, stop.lat, other.lon, other.lat)
                    if distance <= TRANSFER_WALK_RADIUS_M:
                        neighbours.append((other.id, walk_seconds(distance)))
        if neighbours:
            footpaths[stop.id] = neighbours
    return footpaths


def load_feed(path=None) -> Feed:
    """Parse the GTFS zip into a Feed. Raises FileNotFoundError if absent."""
    gtfs_path = path or config.GTFS_ZIP
    if not gtfs_path.exists():
        raise FileNotFoundError(
            f"No GTFS feed at {gtfs_path}. Run 'python -m Backend.fetch_gtfs' to download it."
        )

    with zipfile.ZipFile(gtfs_path) as archive:
        stop_rows = _read_csv(archive, "stops.txt")
        trip_rows = _read_csv(archive, "trips.txt")
        route_rows = _read_csv(archive, "routes.txt")
        calendar_rows = _read_csv(archive, "calendar.txt")
        exception_rows = _read_csv(archive, "calendar_dates.txt")
        info_rows = _read_csv(archive, "feed_info.txt")
        stop_time_rows = _read_csv(archive, "stop_times.txt")

    stops: dict[str, Stop] = {}
    for row in stop_rows:
        # location_type 1 is a station container, not a boarding point.
        if (row.get("location_type") or "0").strip() not in ("", "0"):
            continue
        try:
            stops[row["stop_id"]] = Stop(
                id=row["stop_id"],
                name=(row.get("stop_name") or "").strip().title(),
                lat=float(row["stop_lat"]),
                lon=float(row["stop_lon"]),
            )
        except (KeyError, TypeError, ValueError):
            continue

    routes = {
        row["route_id"]: (row.get("route_short_name") or row.get("route_long_name") or "").strip()
        for row in route_rows
    }
    trip_service = {row["trip_id"]: row.get("service_id", "") for row in trip_rows}
    trip_route = {row["trip_id"]: row.get("route_id", "") for row in trip_rows}
    trip_headsign = {row["trip_id"]: (row.get("trip_headsign") or "").strip() for row in trip_rows}

    # Group stop_times by trip, then chain consecutive stops into connections.
    per_trip: dict[str, list[tuple[int, str, int, int]]] = {}
    for row in stop_time_rows:
        trip_id = row.get("trip_id")
        stop_id = row.get("stop_id")
        if trip_id is None or stop_id not in stops:
            continue
        arrival = parse_gtfs_time(row.get("arrival_time", ""))
        departure = parse_gtfs_time(row.get("departure_time", ""))
        if arrival is None and departure is None:
            continue
        arrival = arrival if arrival is not None else departure
        departure = departure if departure is not None else arrival
        try:
            sequence = int(row.get("stop_sequence") or 0)
        except ValueError:
            continue
        per_trip.setdefault(trip_id, []).append((sequence, stop_id, arrival, departure))

    connections: list[Connection] = []
    for trip_id, entries in per_trip.items():
        entries.sort()
        route_short = routes.get(trip_route.get(trip_id, ""), "")
        headsign = trip_headsign.get(trip_id, "")
        for (_, from_stop, _, dep_time), (_, to_stop, arr_time, _) in zip(entries, entries[1:]):
            if arr_time < dep_time:  # malformed row; skip rather than trust it
                continue
            connections.append(
                Connection(
                    dep_stop=from_stop,
                    arr_stop=to_stop,
                    dep_time=dep_time,
                    arr_time=arr_time,
                    trip_id=trip_id,
                    route_short=route_short,
                    headsign=headsign,
                )
            )

    by_departure = sorted(range(len(connections)), key=lambda i: connections[i].dep_time)
    by_arrival = sorted(range(len(connections)), key=lambda i: connections[i].arr_time)

    calendar = {
        row["service_id"]: row for row in calendar_rows if row.get("service_id")
    }
    calendar_dates = {}
    for row in exception_rows:
        try:
            calendar_dates[(row["service_id"], row["date"])] = int(row["exception_type"])
        except (KeyError, ValueError):
            continue

    info = info_rows[0] if info_rows else {}

    return Feed(
        stops=stops,
        connections=connections,
        by_departure=by_departure,
        by_arrival=by_arrival,
        trip_service=trip_service,
        calendar=calendar,
        calendar_dates=calendar_dates,
        footpaths=_build_footpaths(stops),
        feed_start=(info.get("feed_start_date") or "").strip(),
        feed_end=(info.get("feed_end_date") or "").strip(),
        routes=routes,
    )


@lru_cache(maxsize=1)
def get_feed() -> Feed:
    """Process-wide cached feed. First call costs ~1s, later calls are free."""
    return load_feed()
