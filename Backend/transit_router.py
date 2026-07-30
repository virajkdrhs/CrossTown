"""Transit journey planning over a GTFS feed (Connection Scan Algorithm).

Two scans, both a single pass over the connection list:

* ``scan_backward`` - "to arrive by 08:00, how late can I leave each stop?"
  One scan answers that for *every* stop at once, which is what makes the
  employer roster dashboard cheap: one scan plus a lookup per employee, rather
  than one full routing query per person.
* ``scan_forward``  - "leaving at 06:42, when do I arrive?" Used to reconstruct
  the actual leg-by-leg itinerary once the departure time is known.

Approximations, stated plainly because they matter when reading the output:

* Walking uses straight-line distance x 1.35 at 4.8 km/h. There is no pedestrian
  street network here, so a walk crossing a highway or river is underestimated.
* Bus-to-bus transfers at the same stop need 3 minutes. A transfer that involves
  walking uses the walk time instead, which already provides slack.
* Real-time delays are not modelled; this is the published schedule.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from datetime import date

from .gtfs import Connection, Feed, format_seconds, haversine_m, walk_seconds

MIN_TRANSFER_S = 180
DEFAULT_MAX_WALK_M = 800.0
# How far back a backward scan looks for a departure. Anything longer than this
# before the deadline is not a commute anybody makes.
MAX_JOURNEY_S = 4 * 3600

INF = float("inf")
NEG_INF = float("-inf")


@dataclass
class Leg:
    mode: str  # "walk" | "bus"
    from_name: str
    to_name: str
    depart_s: int
    arrive_s: int
    route: str | None = None
    headsign: str | None = None
    distance_m: float | None = None
    stops: int = 0
    # Endpoint coordinates so the map can draw the itinerary.
    from_lonlat: tuple[float, float] | None = None
    to_lonlat: tuple[float, float] | None = None
    # Intermediate stop coordinates for bus legs, so the drawn line follows the route.
    shape: list[tuple[float, float]] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "mode": self.mode,
            "from": self.from_name,
            "to": self.to_name,
            "depart": format_seconds(self.depart_s),
            "arrive": format_seconds(self.arrive_s),
            "duration_minutes": round((self.arrive_s - self.depart_s) / 60),
            "route": self.route,
            "headsign": self.headsign or None,
            "distance_m": round(self.distance_m) if self.distance_m is not None else None,
            "stops": self.stops or None,
            "from_lonlat": list(self.from_lonlat) if self.from_lonlat else None,
            "to_lonlat": list(self.to_lonlat) if self.to_lonlat else None,
            "shape": [list(point) for point in self.shape] or None,
        }


@dataclass
class Journey:
    legs: list[Leg]
    depart_s: int
    arrive_s: int

    @property
    def duration_s(self) -> int:
        return self.arrive_s - self.depart_s

    @property
    def transfers(self) -> int:
        return max(0, sum(1 for leg in self.legs if leg.mode == "bus") - 1)

    @property
    def walk_m(self) -> float:
        return sum(leg.distance_m or 0 for leg in self.legs if leg.mode == "walk")

    @property
    def routes(self) -> list[str]:
        return [leg.route for leg in self.legs if leg.mode == "bus" and leg.route]

    def as_dict(self) -> dict:
        return {
            "depart": format_seconds(self.depart_s),
            "arrive": format_seconds(self.arrive_s),
            "duration_minutes": round(self.duration_s / 60),
            "transfers": self.transfers,
            "walk_minutes": round(
                sum(
                    leg.arrive_s - leg.depart_s for leg in self.legs if leg.mode == "walk"
                )
                / 60
            ),
            "walk_metres": round(self.walk_m),
            "routes": self.routes,
            "legs": [leg.as_dict() for leg in self.legs],
        }


@dataclass
class BackwardScan:
    """Result of one backward pass: latest usable departure from every stop."""

    latest_dep: dict[str, int]
    arrive_by_s: int
    destination: tuple[float, float]
    egress: dict[str, int] = field(default_factory=dict)

    def latest_departure_from(
        self, feed: Feed, lon: float, lat: float, max_walk_m: float
    ) -> tuple[int, str | None]:
        """Latest time somebody at (lon, lat) can leave and still arrive in time."""
        best_time = NEG_INF
        best_stop = None
        for stop, distance in feed.stops_near(lon, lat, max_walk_m):
            stop_departure = self.latest_dep.get(stop.id)
            if stop_departure is None:
                continue
            candidate = stop_departure - walk_seconds(distance)
            if candidate > best_time:
                best_time, best_stop = candidate, stop.id

        # Walking the whole way is sometimes the answer for short trips.
        direct = haversine_m(lon, lat, self.destination[0], self.destination[1])
        if direct <= max_walk_m:
            candidate = self.arrive_by_s - walk_seconds(direct)
            if candidate > best_time:
                best_time, best_stop = candidate, None
        return best_time, best_stop


def _service_trips(feed: Feed, day: date) -> set[str]:
    services = feed.services_on(day)
    return {trip for trip, service in feed.trip_service.items() if service in services}


def _window(sorted_indices: list[int], keys: list[int], low: int, high: int) -> range:
    """Index range of connections whose sort key falls inside [low, high]."""
    start = bisect.bisect_left(keys, low)
    end = bisect.bisect_right(keys, high)
    return range(start, end)


def scan_backward(
    feed: Feed,
    dest_lon: float,
    dest_lat: float,
    arrive_by_s: int,
    day: date,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
) -> BackwardScan:
    """Latest feasible departure from every stop, to reach the destination in time."""
    active_trips = _service_trips(feed, day)
    connections = feed.connections

    # Deadline for arriving at each stop that is within walking range of the target.
    arrive_ok: dict[str, int] = {}
    egress: dict[str, int] = {}
    for stop, distance in feed.stops_near(dest_lon, dest_lat, max_walk_m):
        deadline = arrive_by_s - walk_seconds(distance)
        arrive_ok[stop.id] = deadline
        egress[stop.id] = walk_seconds(distance)

    latest_dep: dict[str, int] = {}
    trip_usable: set[str] = set()

    arrival_keys = [connections[i].arr_time for i in feed.by_arrival]
    window = _window(feed.by_arrival, arrival_keys, arrive_by_s - MAX_JOURNEY_S, arrive_by_s)

    # Walk connections latest-arrival-first so a trip is known to be useful before
    # we consider boarding it further upstream.
    for position in reversed(window):
        connection = connections[feed.by_arrival[position]]
        if connection.trip_id not in active_trips:
            continue

        usable = connection.trip_id in trip_usable
        if not usable:
            deadline = arrive_ok.get(connection.arr_stop)
            if deadline is not None and connection.arr_time <= deadline:
                usable = True
        if not usable:
            continue

        trip_usable.add(connection.trip_id)
        dep_stop = connection.dep_stop
        if connection.dep_time > latest_dep.get(dep_stop, NEG_INF):
            latest_dep[dep_stop] = connection.dep_time

        # Boarding here means you must already be at the stop: arriving by another
        # bus needs transfer slack, arriving on foot from a nearby stop needs the
        # walk itself.
        same_stop = connection.dep_time - MIN_TRANSFER_S
        if same_stop > arrive_ok.get(dep_stop, NEG_INF):
            arrive_ok[dep_stop] = same_stop
        for neighbour, walk_time in feed.footpaths.get(dep_stop, ()):
            on_foot = connection.dep_time - walk_time
            if on_foot > arrive_ok.get(neighbour, NEG_INF):
                arrive_ok[neighbour] = on_foot
            if on_foot > latest_dep.get(neighbour, NEG_INF):
                latest_dep[neighbour] = on_foot

    return BackwardScan(
        latest_dep=latest_dep,
        arrive_by_s=arrive_by_s,
        destination=(dest_lon, dest_lat),
        egress=egress,
    )


def scan_forward(
    feed: Feed,
    origin: tuple[float, float],
    destination: tuple[float, float],
    depart_after_s: int,
    day: date,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
    origin_name: str = "Origin",
    destination_name: str = "Destination",
) -> Journey | None:
    """Earliest arrival itinerary leaving at or after ``depart_after_s``."""
    active_trips = _service_trips(feed, day)
    connections = feed.connections
    origin_lon, origin_lat = origin
    dest_lon, dest_lat = destination

    # ready[stop] = earliest time you can board there; arrival[stop] = earliest
    # time you can be there. They differ by transfer slack.
    ready: dict[str, int] = {}
    arrival: dict[str, int] = {}
    parent: dict[str, tuple] = {}

    for stop, distance in feed.stops_near(origin_lon, origin_lat, max_walk_m):
        board_at = depart_after_s + walk_seconds(distance)
        ready[stop.id] = board_at
        arrival[stop.id] = board_at
        parent[stop.id] = ("access", distance, depart_after_s, board_at)

    best_arrival = INF
    best_stop: str | None = None

    direct_distance = haversine_m(origin_lon, origin_lat, dest_lon, dest_lat)
    if direct_distance <= max_walk_m:
        best_arrival = depart_after_s + walk_seconds(direct_distance)
        best_stop = None

    trip_boarded: set[str] = set()
    departure_keys = [connections[i].dep_time for i in feed.by_departure]
    window = _window(
        feed.by_departure, departure_keys, depart_after_s, depart_after_s + MAX_JOURNEY_S
    )

    for position in window:
        connection = connections[feed.by_departure[position]]
        if connection.trip_id not in active_trips:
            continue
        if connection.dep_time >= best_arrival:
            break  # nothing departing this late can improve on what we have

        on_board = connection.trip_id in trip_boarded
        if not on_board:
            board_time = ready.get(connection.dep_stop)
            if board_time is None or board_time > connection.dep_time:
                continue
            trip_boarded.add(connection.trip_id)

        arr_stop = connection.arr_stop
        if connection.arr_time >= arrival.get(arr_stop, INF):
            continue

        arrival[arr_stop] = connection.arr_time
        parent[arr_stop] = ("bus", connection)
        transfer_ready = connection.arr_time + MIN_TRANSFER_S
        if transfer_ready < ready.get(arr_stop, INF):
            ready[arr_stop] = transfer_ready

        for neighbour, walk_time in feed.footpaths.get(arr_stop, ()):
            on_foot = connection.arr_time + walk_time
            if on_foot < arrival.get(neighbour, INF):
                arrival[neighbour] = on_foot
                parent[neighbour] = ("walk", arr_stop, walk_time, connection.arr_time)
            if on_foot < ready.get(neighbour, INF):
                ready[neighbour] = on_foot

        stop = feed.stops.get(arr_stop)
        if stop is not None:
            egress_distance = haversine_m(stop.lon, stop.lat, dest_lon, dest_lat)
            if egress_distance <= max_walk_m:
                total = connection.arr_time + walk_seconds(egress_distance)
                if total < best_arrival:
                    best_arrival = total
                    best_stop = arr_stop

    if best_arrival == INF:
        return None

    legs = _reconstruct(
        feed,
        parent,
        best_stop,
        origin_name,
        destination_name,
        origin,
        destination,
        best_arrival,
    )
    if legs is None:
        return None
    return Journey(legs=legs, depart_s=legs[0].depart_s, arrive_s=best_arrival)


def _lonlat(feed: Feed, stop_id: str) -> tuple[float, float] | None:
    stop = feed.stops.get(stop_id)
    return (stop.lon, stop.lat) if stop else None


def _reconstruct(
    feed: Feed,
    parent: dict[str, tuple],
    final_stop: str | None,
    origin_name: str,
    destination_name: str,
    origin: tuple[float, float],
    destination: tuple[float, float],
    best_arrival: int,
) -> list[Leg] | None:
    """Walk the parent chain back to the origin and emit legs in travel order."""
    if final_stop is None:
        # Walking the whole way was the best option.
        distance = haversine_m(origin[0], origin[1], destination[0], destination[1])
        depart = best_arrival - walk_seconds(distance)
        return [
            Leg(
                mode="walk",
                from_name=origin_name,
                to_name=destination_name,
                depart_s=depart,
                arrive_s=best_arrival,
                distance_m=distance,
                from_lonlat=origin,
                to_lonlat=destination,
            )
        ]

    # Collect the chain from the last stop back to the access walk.
    chain: list[tuple] = []
    cursor: str | None = final_stop
    guard = 0
    while cursor is not None and guard < 500:
        guard += 1
        entry = parent.get(cursor)
        if entry is None:
            return None
        chain.append((cursor, entry))
        if entry[0] == "access":
            break
        if entry[0] == "bus":
            cursor = entry[1].dep_stop
        elif entry[0] == "walk":
            cursor = entry[1]
        else:
            return None
    chain.reverse()

    legs: list[Leg] = []
    for stop_id, entry in chain:
        if entry[0] == "access":
            distance, depart_s, arrive_s = entry[1], entry[2], entry[3]
            stop = feed.stops.get(stop_id)
            if distance < 30:
                continue  # already at the stop; no walk leg worth showing
            legs.append(
                Leg(
                    mode="walk",
                    from_name=origin_name,
                    to_name=stop.name if stop else stop_id,
                    depart_s=depart_s,
                    arrive_s=arrive_s,
                    distance_m=distance,
                    from_lonlat=origin,
                    to_lonlat=_lonlat(feed, stop_id),
                )
            )
        elif entry[0] == "walk":
            from_stop = feed.stops.get(entry[1])
            to_stop = feed.stops.get(stop_id)
            legs.append(
                Leg(
                    mode="walk",
                    from_name=from_stop.name if from_stop else entry[1],
                    to_name=to_stop.name if to_stop else stop_id,
                    depart_s=entry[3],
                    arrive_s=entry[3] + entry[2],
                    distance_m=entry[2] * 1.33 / 1.35,
                    from_lonlat=_lonlat(feed, entry[1]),
                    to_lonlat=_lonlat(feed, stop_id),
                )
            )
        else:
            connection: Connection = entry[1]
            from_stop = feed.stops.get(connection.dep_stop)
            to_stop = feed.stops.get(connection.arr_stop)
            from_point = _lonlat(feed, connection.dep_stop)
            to_point = _lonlat(feed, connection.arr_stop)
            legs.append(
                Leg(
                    mode="bus",
                    from_name=from_stop.name if from_stop else connection.dep_stop,
                    to_name=to_stop.name if to_stop else connection.arr_stop,
                    depart_s=connection.dep_time,
                    arrive_s=connection.arr_time,
                    route=connection.route_short,
                    headsign=connection.headsign,
                    stops=1,
                    from_lonlat=from_point,
                    to_lonlat=to_point,
                    shape=[point for point in (from_point, to_point) if point],
                )
            )

    legs = _merge_bus_legs(legs)

    # Final walk from the last stop to the destination.
    last_stop = feed.stops.get(final_stop)
    if last_stop is not None:
        egress_distance = haversine_m(
            last_stop.lon, last_stop.lat, destination[0], destination[1]
        )
        if egress_distance >= 30:
            legs.append(
                Leg(
                    mode="walk",
                    from_name=last_stop.name,
                    to_name=destination_name,
                    depart_s=best_arrival - walk_seconds(egress_distance),
                    arrive_s=best_arrival,
                    distance_m=egress_distance,
                    from_lonlat=(last_stop.lon, last_stop.lat),
                    to_lonlat=destination,
                )
            )
    return legs or None


def _merge_bus_legs(legs: list[Leg]) -> list[Leg]:
    """Collapse consecutive hops on the same route into one ride."""
    merged: list[Leg] = []
    for leg in legs:
        if (
            merged
            and leg.mode == "bus"
            and merged[-1].mode == "bus"
            and merged[-1].route == leg.route
            and merged[-1].arrive_s == leg.depart_s
        ):
            previous = merged[-1]
            previous.to_name = leg.to_name
            previous.arrive_s = leg.arrive_s
            previous.stops += leg.stops
            previous.to_lonlat = leg.to_lonlat
            for point in leg.shape:
                if not previous.shape or previous.shape[-1] != point:
                    previous.shape.append(point)
        else:
            merged.append(leg)
    return merged


def plan_arrive_by(
    feed: Feed,
    origin: tuple[float, float],
    destination: tuple[float, float],
    arrive_by_s: int,
    day: date,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
    origin_name: str = "Origin",
    destination_name: str = "Destination",
    scan: BackwardScan | None = None,
) -> Journey | None:
    """Itinerary that departs as late as possible and still arrives in time."""
    if scan is None:
        scan = scan_backward(
            feed, destination[0], destination[1], arrive_by_s, day, max_walk_m
        )
    latest_departure, _ = scan.latest_departure_from(
        feed, origin[0], origin[1], max_walk_m
    )
    if latest_departure == NEG_INF:
        return None
    return scan_forward(
        feed,
        origin,
        destination,
        int(latest_departure),
        day,
        max_walk_m,
        origin_name,
        destination_name,
    )


def plan_depart_after(
    feed: Feed,
    origin: tuple[float, float],
    destination: tuple[float, float],
    depart_after_s: int,
    day: date,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
    origin_name: str = "Origin",
    destination_name: str = "Destination",
) -> Journey | None:
    return scan_forward(
        feed,
        origin,
        destination,
        depart_after_s,
        day,
        max_walk_m,
        origin_name,
        destination_name,
    )
