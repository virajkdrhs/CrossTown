"""Central configuration and filesystem paths for CrossTown.

Every path is derived from the repository root so scripts behave the same no
matter which directory you launch them from, and credentials come from the
environment (or a local .env file) instead of being hard-coded in source.
"""

import os
from pathlib import Path

try:  # optional convenience: load a local .env if python-dotenv is installed
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

# Backend/config.py -> Backend/ -> repository root
ROOT_DIR = Path(__file__).resolve().parent.parent

if load_dotenv is not None:
    load_dotenv(ROOT_DIR / ".env")

DATA_DIR = ROOT_DIR / "Data"
RAW_DIR = DATA_DIR / "Raw"
PROCESSED_DIR = DATA_DIR / "Processed"

ACCESS_GRID_GEOJSON = PROCESSED_DIR / "access_grid_final.geojson"
CENSUS_GEOJSON = PROCESSED_DIR / "census_carfree.geojson"
DESTINATIONS_CSV = PROCESSED_DIR / "destinations.csv"
ORIGINS_CSV = PROCESSED_DIR / "origins_grid.csv"
TRAVEL_TIME_MATRIX_CSV = PROCESSED_DIR / "travel_time_matrix.csv"

OSM_PBF = RAW_DIR / "virginia-latest.osm.pbf"
GTFS_ZIP = RAW_DIR / "gtfs.zip"
ASSETS_DIR = RAW_DIR / "Assets"
CENSUS_RAW_DIR = RAW_DIR / "Census"
CENSUS_B25044_JSON = CENSUS_RAW_DIR / "B25044_henrico_blockgroups.json"

# Henrico County, VA
COUNTY_NAME = "Henrico County"
STATE_FIPS = "51"
COUNTY_FIPS = "087"
MAP_CENTER = (-77.48, 37.58)

# Travel-time budget used when building the access grid (minutes).
TRAVEL_TIME_BUDGET_MIN = int(os.getenv("CROSSTOWN_TRAVEL_TIME_BUDGET", "45"))


def database_url() -> str | None:
    """Return a SQLAlchemy URL for PostGIS, or None when no DB is configured.

    Set CROSSTOWN_DATABASE_URL for a full URL, or the individual
    CROSSTOWN_DB_* variables. When nothing is configured the API falls back to
    reading the processed GeoJSON files directly, so the app still runs.
    """
    explicit = os.getenv("CROSSTOWN_DATABASE_URL")
    if explicit:
        return explicit

    password = os.getenv("CROSSTOWN_DB_PASSWORD")
    if password is None:
        return None

    user = os.getenv("CROSSTOWN_DB_USER", "postgres")
    host = os.getenv("CROSSTOWN_DB_HOST", "localhost")
    port = os.getenv("CROSSTOWN_DB_PORT", "5432")
    name = os.getenv("CROSSTOWN_DB_NAME", "crosstown")
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


def allowed_origins() -> list[str]:
    """CORS allow-list. Defaults to the usual local static-server ports."""
    raw = os.getenv("CROSSTOWN_ALLOWED_ORIGINS")
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return [
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:5501",
        "http://127.0.0.1:5501",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]
