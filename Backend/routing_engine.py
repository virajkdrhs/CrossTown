"""Compute the origin-to-destination travel-time matrix with r5py.

Requires the large raw inputs that are not committed to the repository:
  Data/Raw/virginia-latest.osm.pbf   (OpenStreetMap extract)
  Data/Raw/gtfs.zip                  (GRTC transit feed)
"""

from __future__ import annotations

import datetime
import os
import sys

from . import config

# Show progress immediately rather than buffering behind r5py's JVM output.
sys.stdout.reconfigure(line_buffering=True)

# Departure is configurable so the matrix can be rebuilt for off-peak or weekend
# service without editing source. Default: a weekday morning peak.
DEPARTURE = os.getenv("CROSSTOWN_DEPARTURE", "2026-09-15T08:30")


def main() -> int:
    print("--- Starting CrossTown Routing Engine ---")

    missing = [
        path
        for path in (config.OSM_PBF, config.GTFS_ZIP, config.ORIGINS_CSV, config.DESTINATIONS_CSV)
        if not path.exists()
    ]
    if missing:
        print("ERROR: missing required inputs:")
        for path in missing:
            print(f"  - {path.relative_to(config.ROOT_DIR)}")
        print("       The .osm.pbf and gtfs.zip files are gitignored; see the README.")
        return 1

    import geopandas as gpd  # noqa: PLC0415
    import pandas as pd  # noqa: PLC0415
    import r5py  # noqa: PLC0415

    print("[1/5] Loading origins grid...")
    origins_df = pd.read_csv(config.ORIGINS_CSV)
    origins_gdf = gpd.GeoDataFrame(
        origins_df,
        geometry=gpd.points_from_xy(origins_df.longitude, origins_df.latitude),
        crs="EPSG:4326",
    )

    print("[2/5] Loading destinations...")
    dest_df = pd.read_csv(config.DESTINATIONS_CSV)
    dest_gdf = gpd.GeoDataFrame(
        dest_df,
        geometry=gpd.points_from_xy(dest_df.longitude, dest_df.latitude),
        crs="EPSG:4326",
    )
    print(f"      {len(origins_gdf)} origins x {len(dest_gdf)} destinations")

    print("[3/5] Initializing transport network...")
    transport_network = r5py.TransportNetwork(str(config.OSM_PBF), [str(config.GTFS_ZIP)])

    budget = config.TRAVEL_TIME_BUDGET_MIN
    departure_time = datetime.datetime.fromisoformat(DEPARTURE)
    print(f"[4/5] Computing travel times (departure {departure_time}, max {budget} min)...")
    travel_time_matrix = r5py.TravelTimeMatrix(
        transport_network,
        origins=origins_gdf,
        destinations=dest_gdf,
        departure=departure_time,
        transport_modes=[r5py.TransportMode.WALK, r5py.TransportMode.TRANSIT],
        max_time=datetime.timedelta(minutes=budget),
    )

    print(f"[5/5] Saving {config.TRAVEL_TIME_MATRIX_CSV.relative_to(config.ROOT_DIR)}...")
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    travel_time_matrix.to_csv(config.TRAVEL_TIME_MATRIX_CSV, index=False)
    print("--- Matrix Computation Complete ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
