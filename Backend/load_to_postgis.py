"""Ingest the processed spatial layers into PostgreSQL/PostGIS.

Credentials come from the environment (see .env.example) - the previous version
had a working password committed in source, which is both a leak and a guarantee
that it breaks on every other machine.
"""

from __future__ import annotations

import sys

from . import config


def main() -> int:
    print("--- Starting PostGIS Data Ingestion ---")

    database_url = config.database_url()
    if not database_url:
        print(
            "ERROR: no database configured.\n"
            "       Set CROSSTOWN_DB_PASSWORD (and optionally CROSSTOWN_DB_USER/HOST/PORT/NAME)\n"
            "       or CROSSTOWN_DATABASE_URL. Copy .env.example to .env to get started.\n"
            "       The API itself does not need this - it falls back to the processed\n"
            "       GeoJSON files in Data/Processed."
        )
        return 1

    import geopandas as gpd  # noqa: PLC0415 - heavy import, only needed here
    from sqlalchemy import create_engine  # noqa: PLC0415

    engine = create_engine(database_url)

    layers = [
        ("access_grid", config.ACCESS_GRID_GEOJSON),
        ("census_carfree", config.CENSUS_GEOJSON),
    ]

    failures = 0
    for step, (table, path) in enumerate(layers, start=1):
        prefix = f"[{step}/{len(layers)}]"
        if not path.exists():
            print(f"{prefix} ERROR: missing {path.relative_to(config.ROOT_DIR)} - skipping {table}")
            failures += 1
            continue

        print(f"{prefix} Ingesting {path.name} into '{table}'...")
        gdf = gpd.read_file(path)
        if gdf.crs is None:
            gdf = gdf.set_crs("EPSG:4326")
        else:
            gdf = gdf.to_crs("EPSG:4326")
        gdf.to_postgis(name=table, con=engine, if_exists="replace", index=False)
        print(f" -> Table '{table}' created with {len(gdf)} rows")

    print("--- PostGIS Ingestion Complete ---")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
