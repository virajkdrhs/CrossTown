import sys
import os
import datetime
import pandas as pd
import geopandas as gpd

# Force print statements to show up immediately in PowerShell
sys.stdout.reconfigure(line_buffering=True)

print("--- Starting CrossTown Routing Engine ---")

import r5py

def main():
    # Define paths
    DATA_DIR = os.path.abspath("data")
    RAW_DIR = os.path.join(DATA_DIR, "raw")
    PROCESSED_DIR = os.path.join(DATA_DIR, "processed")

    osm_path = os.path.join(RAW_DIR, "virginia-latest.osm.pbf")
    gtfs_path = os.path.join(RAW_DIR, "gtfs.zip") 
    origins_path = os.path.join(PROCESSED_DIR, "origins_grid.csv")
    destinations_path = os.path.join(PROCESSED_DIR, "destinations.csv")
    output_matrix_path = os.path.join(PROCESSED_DIR, "travel_time_matrix.csv")

    # 1. Load Origins Grid
    print("[1/5] Loading origins grid...")
    origins_df = pd.read_csv(origins_path)
    origins_gdf = gpd.GeoDataFrame(
        origins_df,
        geometry=gpd.points_from_xy(origins_df.longitude, origins_df.latitude),
        crs="EPSG:4326"
    )

    # 2. Load Destinations
    print("[2/5] Loading destinations...")
    dest_df = pd.read_csv(destinations_path)
    dest_gdf = gpd.GeoDataFrame(
        dest_df,
        geometry=gpd.points_from_xy(dest_df.longitude, dest_df.latitude),
        crs="EPSG:4326"
    )

    # 3. Build Transport Network
    print("[3/5] Initializing transport network...")
    transport_network = r5py.TransportNetwork(
        osm_path,
        [gtfs_path]
    )

    # 4. Configure & Compute Travel Times
    print("[4/5] Computing travel time matrix...")
    departure_time = datetime.datetime(2026, 9, 15, 8, 30) # Weekday morning peak
    
    # Notice: using r5py.TravelTimeMatrix directly here!
    travel_time_matrix = r5py.TravelTimeMatrix(
        transport_network,
        origins=origins_gdf,
        destinations=dest_gdf,
        departure=departure_time,
        transport_modes=[r5py.TransportMode.WALK, r5py.TransportMode.TRANSIT],
        max_time=datetime.timedelta(minutes=45)
    )

    # 5. Save Output Matrix
    print(f"[5/5] Saving travel time matrix to {output_matrix_path}...")
    travel_time_matrix.to_csv(output_matrix_path, index=False)
    print("--- Matrix Computation Complete! ---")

if __name__ == "__main__":
    main()