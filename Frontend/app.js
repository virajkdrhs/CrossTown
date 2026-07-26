const API_BASE_URL = "http://127.0.0.1:8000/api/v1";

// 1. Initialize MapLibre GL JS Map centered on Henrico County, VA
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [-77.48, 37.58], // Henrico County coordinates
  zoom: 11
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

let selectedMarker = null;

map.on('load', async () => {
  console.log("Map initialized. Fetching spatial layers from FastAPI...");

  // 2. Add Access Grid Source & Layer
  try {
    const gridResponse = await fetch(`${API_BASE_URL}/grid`);
    const gridData = await gridResponse.json();

    map.addSource('access-grid-source', {
      type: 'geojson',
      data: gridData
    });

    // Render Scored Circle Area Layer (Semi-transparent & Larger Radii)
    map.addLayer({
      id: 'access-grid-layer',
      type: 'circle',
      source: 'access-grid-source',
      paint: {
        // Larger radii so circles cover broader neighborhoods/grid zones
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          10, 10,   // At zoom 10, radius is 10px
          13, 22,   // At zoom 13, radius is 22px
          16, 45    // At zoom 16, radius is 45px
        ],
        // Color transition based on Access Score
        'circle-color': [
            'interpolate', ['linear'], ['get', 'access_score_100'],
            0, '#ef4444',    // Red (Low/Zero access, 0-30)
            35, '#f59e0b',   // Yellow (Moderate access, 30-60)
            70, '#10b981'    // Green (High access, 70-100)
        ],
        // Semi-transparency so overlapping coverage areas blend smoothly
        'circle-opacity': 0.35,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': [
          'interpolate', ['linear'], ['get', 'access_score'],
          0, '#dc2626',
          5, '#d97706',
          15, '#059669'
        ],
        'circle-stroke-opacity': 0.6
      }
    });

    console.log("Access grid layer rendered successfully.");
  } catch (err) {
    console.error("Failed to load access grid:", err);
  }

  // 3. Add Census Demographics Layer
  try {
    const censusResponse = await fetch(`${API_BASE_URL}/demographics`);
    const censusData = await censusResponse.json();

    map.addSource('census-carfree-source', {
      type: 'geojson',
      data: censusData
    });

    map.addLayer({
      id: 'census-carfree-layer',
      type: 'fill',
      source: 'census-carfree-source',
      layout: { 'visibility': 'none' }, // Hidden by default
      paint: {
        'fill-color': [
          'interpolate', ['linear'], ['get', 'pct_carfree'],
          0, '#1e293b',
          15, '#6366f1',
          30, '#a855f7'
        ],
        'fill-opacity': 0.45,
        'fill-outline-color': '#6366f1'
      }
    });
  } catch (err) {
    console.warn("Census layer unavailable or empty:", err);
  }

  // 4. Click Listener on Map Points (No Popup Textbox!)
  map.on('click', 'access-grid-layer', (e) => {
    const feature = e.features[0];
    const props = feature.properties;

    // Uses scaled scores if available, or calculates on the fly
    const rawScore = props.access_score_100 || Math.min(100, (props.access_score || 0) * 5);
    const baseEst = Math.max(5, Math.floor(rawScore * 0.75));

    updateUIResults({
        scores: {
        overall_score: rawScore,
        food: props.Food ? Math.min(100, props.Food * 20) : baseEst,
        health: props.Health ? Math.min(100, props.Health * 33) : baseEst,
        education: props.Education ? Math.min(100, props.Education * 25) : baseEst,
        civic: props.Civic ? Math.min(100, props.Civic * 25) : baseEst
        },
        query_address: "Selected Zone"
    });
});

  map.on('mouseenter', 'access-grid-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'access-grid-layer', () => { map.getCanvas().style.cursor = ''; });
});

// 5. Toggle Census Car-Free Overlay
document.getElementById('toggle-census').addEventListener('change', (e) => {
  const visibility = e.target.checked ? 'visible' : 'none';
  if (map.getLayer('census-carfree-layer')) {
    map.setLayoutProperty('census-carfree-layer', 'visibility', visibility);
  }
});

// 6. Handle Address Reachability Calculation
document.getElementById('search-btn').addEventListener('click', executeAddressLookup);
document.getElementById('address-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') executeAddressLookup();
});

async function executeAddressLookup() {
  const addressInput = document.getElementById('address-input').value.trim();
  const errorEl = document.getElementById('search-error');
  errorEl.classList.add('hidden');

  if (!addressInput) {
    errorEl.textContent = "Please enter a valid address.";
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/reachability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: addressInput })
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.detail || "Location search failed.");
    }

    const data = await response.json();

    // Fly Map to Location
    const { longitude, latitude } = data.coordinates;
    map.flyTo({ center: [longitude, latitude], zoom: 14, speed: 1.2 });

    // Update Marker
    if (selectedMarker) selectedMarker.remove();
    selectedMarker = new maplibregl.Marker({ color: '#10b981' })
      .setLngLat([longitude, latitude])
      .addTo(map);

    // Update Sidebar Cards
    updateUIResults(data);

  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

function updateUIResults(data) {
  document.getElementById('score-overall').textContent = data.scores.overall_score;
  document.getElementById('score-subtitle').textContent = data.query_address || "Calculated Zone";
  
  document.getElementById('score-food').textContent = data.scores.food;
  document.getElementById('score-health').textContent = data.scores.health;
  document.getElementById('score-education').textContent = data.scores.education;
  document.getElementById('score-civic').textContent = data.scores.civic;
}