import os
import pandas as pd
import geopandas as gpd

def main():
    print("--- Starting Access Score Calculation ---")
    
    # Paths
    PROCESSED_DIR = os.path.abspath("data/processed")
    matrix_path = os.path.join(PROCESSED_DIR, "travel_time_matrix.csv")
    dest_path = os.path.join(PROCESSED_DIR, "destinations.csv")
    grid_path = os.path.join(PROCESSED_DIR, "origins_grid.csv")
    output_geojson = os.path.join(PROCESSED_DIR, "access_grid_final.geojson")

    # 1. Load Data
    print("[1/4] Loading matrix, destinations, and origin grid...")
    matrix_df = pd.read_csv(matrix_path)
    dest_df = pd.read_csv(dest_path)
    grid_df = pd.read_csv(grid_path)

    # 2. Filter matrix for trips <= 45 minutes
    print("[2/4] Filtering for reachable destinations within 45 minutes...")
    # r5py outputs 'from_id', 'to_id', and 'travel_time'
    reachable = matrix_df[matrix_df['travel_time'] <= 45].copy()

    # Join with destination categories
    reachable = reachable.merge(
        dest_df[['id', 'category']], 
        left_on='to_id', 
        right_on='id', 
        how='inner'
    )

    # 3. Pivot & Tally Categories per Origin Node
    print("[3/4] Aggregating category counts per grid point...")
    category_counts = (
        reachable.groupby(['from_id', 'category'])
        .size()
        .unstack(fill_value=0)
        .reset_index()
    )

    # Ensure all expected category columns exist
    for cat in ['Food', 'Health', 'Education', 'Civic']:
        if cat not in category_counts.columns:
            category_counts[cat] = 0

    # Calculate aggregate score (simple sum of reachable amenities)
    category_counts['access_score'] = (
        category_counts['Food'] + 
        category_counts['Health'] + 
        category_counts['Education'] + 
        category_counts['Civic']
    )

    # Merge back with original origins grid to keep points even if 0 destinations were reached
    final_grid = grid_df.merge(
        category_counts, 
        left_on='id', 
        right_on='from_id', 
        how='left'
    ).fillna(0)

    # 4. Convert to GeoDataFrame & Export GeoJSON
    print(f"[4/4] Writing GeoJSON to {output_geojson}...")
    final_gdf = gpd.GeoDataFrame(
        final_grid,
        geometry=gpd.points_from_xy(final_grid.longitude, final_grid.latitude),
        crs="EPSG:4326"
    )
    
    final_gdf.to_file(output_geojson, driver="GeoJSON")
    print("--- Access Scores Generated Successfully! ---")

if __name__ == "__main__":
    main()