"""Data access for the CrossTown API.

Two interchangeable backends:

* ``PostGISSource``  - queries the PostgreSQL/PostGIS tables created by
  ``load_to_postgis.py``. Used when a database is configured *and* reachable.
* ``GeoJSONSource``  - reads the processed GeoJSON/CSV files committed under
  ``Data/Processed`` using only the standard library.

The file backend exists so a teammate can clone the repo and run the app
immediately. Previously ``main.py`` imported geopandas and opened a PostGIS
connection at module scope, so the API could not even start without a database,
a PostGIS extension and a hand-edited password.
"""

from __future__ import annotations

import csv
import json
import math
from typing import Any

from . import config, scoring


class DataSourceError(RuntimeError):
    """Raised when the requested layer is unavailable."""


def _haversine_meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6_371_008.8  # mean Earth radius, metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


class GeoJSONSource:
    """File-backed data source - no database required."""

    name = "geojson-files"

    def __init__(self) -> None:
        self._grid: dict[str, Any] | None = None
        self._census: dict[str, Any] | None = None
        self._destinations: list[dict[str, Any]] | None = None

    # -- loading -----------------------------------------------------------
    def _load_json(self, path) -> dict[str, Any]:
        if not path.exists():
            raise DataSourceError(
                f"Missing data file {path.relative_to(config.ROOT_DIR)}. "
                "Run the Backend pipeline scripts or restore the processed data."
            )
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)

    def grid(self) -> dict[str, Any]:
        if self._grid is None:
            self._grid = self._load_json(config.ACCESS_GRID_GEOJSON)
        return self._grid

    def demographics(self) -> dict[str, Any]:
        if self._census is None:
            self._census = self._load_json(config.CENSUS_GEOJSON)
        return self._census

    def destinations(self) -> list[dict[str, Any]]:
        if self._destinations is None:
            if not config.DESTINATIONS_CSV.exists():
                raise DataSourceError("Missing Data/Processed/destinations.csv")
            with config.DESTINATIONS_CSV.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
            parsed: list[dict[str, Any]] = []
            for row in rows:
                try:
                    lat = float(row["latitude"])
                    lon = float(row["longitude"])
                except (KeyError, TypeError, ValueError):
                    continue
                parsed.append(
                    {
                        "id": row.get("id"),
                        "name": (row.get("name") or "").strip() or "Unnamed",
                        "category": row.get("category") or "Other",
                        "latitude": lat,
                        "longitude": lon,
                    }
                )
            self._destinations = parsed
        return self._destinations

    # -- queries -----------------------------------------------------------
    def grid_rows(self) -> list[dict[str, Any]]:
        rows = []
        for feature in self.grid().get("features", []):
            props = dict(feature.get("properties") or {})
            geometry = feature.get("geometry") or {}
            coords = geometry.get("coordinates") or [None, None]
            props.setdefault("longitude", coords[0])
            props.setdefault("latitude", coords[1])
            rows.append(props)
        return rows

    def nearest_node(self, lon: float, lat: float) -> dict[str, Any]:
        best: dict[str, Any] | None = None
        best_distance = float("inf")
        for row in self.grid_rows():
            try:
                node_lon = float(row["longitude"])
                node_lat = float(row["latitude"])
            except (KeyError, TypeError, ValueError):
                continue
            distance = _haversine_meters(lon, lat, node_lon, node_lat)
            if distance < best_distance:
                best_distance, best = distance, row
        if best is None:
            raise DataSourceError("Access grid contains no usable nodes.")
        return {**best, "dist_meters": best_distance}


class PostGISSource:
    """PostGIS-backed data source."""

    name = "postgis"

    def __init__(self, database_url: str) -> None:
        # Imported lazily so the file backend has no geopandas/SQLAlchemy dependency.
        import geopandas as gpd  # noqa: PLC0415
        from sqlalchemy import create_engine, text  # noqa: PLC0415

        self._gpd = gpd
        self._text = text
        self._engine = create_engine(database_url, pool_pre_ping=True)
        # Fail fast so the caller can fall back to files.
        with self._engine.connect() as conn:
            conn.execute(text("SELECT 1"))

    def _read_postgis(self, table: str) -> dict[str, Any]:
        gdf = self._gpd.read_postgis(
            f'SELECT * FROM "{table}";', con=self._engine, geom_col="geometry"
        )
        return json.loads(gdf.to_json())

    def grid(self) -> dict[str, Any]:
        return self._read_postgis("access_grid")

    def demographics(self) -> dict[str, Any]:
        return self._read_postgis("census_carfree")

    def destinations(self) -> list[dict[str, Any]]:
        # Destinations are not ingested into PostGIS; read the CSV.
        return GeoJSONSource().destinations()

    def grid_rows(self) -> list[dict[str, Any]]:
        rows = []
        for feature in self.grid().get("features", []):
            props = dict(feature.get("properties") or {})
            coords = (feature.get("geometry") or {}).get("coordinates") or [None, None]
            props.setdefault("longitude", coords[0])
            props.setdefault("latitude", coords[1])
            rows.append(props)
        return rows

    def nearest_node(self, lon: float, lat: float) -> dict[str, Any]:
        query = self._text(
            """
            SELECT *,
                   ST_X(geometry) AS longitude,
                   ST_Y(geometry) AS latitude,
                   ST_Distance(
                       geometry::geography,
                       ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
                   ) AS dist_meters
            FROM access_grid
            ORDER BY geometry <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
            LIMIT 1;
            """
        )
        with self._engine.connect() as conn:
            result = conn.execute(query, {"lon": lon, "lat": lat}).mappings().fetchone()
        if result is None:
            raise DataSourceError("Access grid contains no usable nodes.")
        row = dict(result)
        row.pop("geometry", None)
        return row


def build_source() -> tuple[Any, str]:
    """Pick the best available data source.

    Returns the source plus a short human-readable note for ``/api/v1/health``.
    """
    url = config.database_url()
    if url:
        try:
            source = PostGISSource(url)
            return source, "Connected to PostGIS."
        except Exception as exc:  # noqa: BLE001 - any failure means fall back
            note = f"PostGIS unavailable ({type(exc).__name__}); serving processed files."
            return GeoJSONSource(), note
    return GeoJSONSource(), "No database configured; serving processed files."


def calibrate_scoring(source: Any) -> dict[str, float]:
    """Calibrate the score ramps from whichever grid the source exposes."""
    try:
        return scoring.calibrate(source.grid_rows())
    except Exception:  # noqa: BLE001 - keep defaults if the grid cannot be read
        return scoring.caps()
