const API_BASE_URL = "http://127.0.0.1:8000/api/v1";

const CATEGORY_COLORS = {
  Food: "#34d399",
  Health: "#fb7185",
  Education: "#fbbf24",
  Civic: "#a78bfa",
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [-77.48, 37.58], // Henrico County, VA
  zoom: 10.5,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

// Tailwind's CDN build injects its stylesheet asynchronously, so MapLibre often
// measures the container before the flex layout has settled and the canvas ends
// up a fraction of the viewport. Watching the container keeps the canvas in
// sync with whatever size it actually ends up at (including sidebar toggles and
// window resizes).
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
} else {
  window.addEventListener("resize", () => map.resize());
}

let selectedMarker = null;
let selectedNodeId = null;
let hoverPopup = null;

/* ------------------------------------------------------------------ helpers */

async function getJSON(path, options) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && body.detail) detail = body.detail;
    } catch (_) {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return response.json();
}

function setApiStatus(text, ok) {
  const el = document.getElementById("api-status");
  el.textContent = text;
  el.className = ok
    ? "text-xs px-2 py-1 rounded-full border border-emerald-600 text-emerald-400"
    : "text-xs px-2 py-1 rounded-full border border-red-600 text-red-400";
}

/* -------------------------------------------------------------- map layers */

map.on("load", async () => {
  // Health check first, so a dead backend produces one clear message instead of
  // three silent console errors.
  try {
    const health = await getJSON("/health");
    setApiStatus(`API ok · ${health.data_source}`, true);
    document.getElementById("budget-label").textContent =
      health.travel_time_budget_minutes ?? 45;
  } catch (err) {
    setApiStatus("API offline", false);
    document.getElementById("offline-banner").classList.remove("hidden");
    return;
  }

  await Promise.all([loadAccessGrid(), loadCensusLayer(), loadDestinations()]);
  loadStats();
  fitToGrid();
});

/** Frame the county from the data instead of trusting a hard-coded zoom. */
function fitToGrid() {
  const source = map.getSource("access-grid-source");
  if (!source || !source._data) return;
  const bounds = new maplibregl.LngLatBounds();
  source._data.features.forEach((feature) => bounds.extend(feature.geometry.coordinates));
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, duration: 0 });
}

async function loadAccessGrid() {
  try {
    const gridData = await getJSON("/grid");

    map.addSource("access-grid-source", { type: "geojson", data: gridData });

    map.addLayer({
      id: "access-grid-layer",
      type: "circle",
      source: "access-grid-source",
      paint: {
        // The grid is a ~800 m lattice; radii are tuned so neighbouring cells
        // touch without stacking into a solid wash of colour.
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          9, 6,
          11, 13,
          13, 26,
          16, 70,
        ],
        "circle-color": [
          "interpolate", ["linear"], ["get", "access_score_100"],
          0, "#ef4444",
          50, "#f59e0b",
          100, "#10b981",
        ],
        "circle-opacity": 0.55,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#0f172a",
        "circle-stroke-opacity": 0.7,
      },
    });

    // Ring drawn around whichever node is currently selected.
    map.addLayer({
      id: "access-grid-selected",
      type: "circle",
      source: "access-grid-source",
      filter: ["==", ["get", "id"], -1],
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          9, 9,
          11, 17,
          13, 30,
          16, 76,
        ],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.on("click", "access-grid-layer", (event) => {
      const feature = event.features && event.features[0];
      if (feature) selectNode(feature);
    });

    map.on("mouseenter", "access-grid-layer", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "access-grid-layer", () => {
      map.getCanvas().style.cursor = "";
    });
  } catch (err) {
    console.error("Failed to load access grid:", err);
    showSearchError(`Access grid unavailable: ${err.message}`);
  }
}

async function loadCensusLayer() {
  try {
    const censusData = await getJSON("/demographics");

    const percentages = censusData.features
      .map((f) => Number(f.properties.pct_carfree) || 0)
      .sort((a, b) => a - b);
    // Ramp to the 95th percentile so a couple of extreme block groups do not
    // flatten everything else into the same dark blue.
    const rampMax = Math.max(
      5,
      Math.ceil(percentages[Math.floor(percentages.length * 0.95)] || 20)
    );
    document.getElementById("legend-census-max").textContent = `${rampMax}%+`;

    map.addSource("census-carfree-source", { type: "geojson", data: censusData });

    map.addLayer(
      {
        id: "census-carfree-layer",
        type: "fill",
        source: "census-carfree-source",
        layout: { visibility: "none" },
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["get", "pct_carfree"],
            0, "#1e293b",
            rampMax / 2, "#6366f1",
            rampMax, "#a855f7",
          ],
          "fill-opacity": 0.55,
        },
      },
      "access-grid-layer" // keep the polygons underneath the score circles
    );

    map.addLayer(
      {
        id: "census-carfree-outline",
        type: "line",
        source: "census-carfree-source",
        layout: { visibility: "none" },
        paint: { "line-color": "#6366f1", "line-width": 0.5, "line-opacity": 0.5 },
      },
      "access-grid-layer"
    );

    map.on("mousemove", "census-carfree-layer", (event) => {
      const props = event.features[0].properties;
      if (hoverPopup) hoverPopup.remove();
      hoverPopup = new maplibregl.Popup({ closeButton: false, className: "ct-popup" })
        .setLngLat(event.lngLat)
        .setHTML(
          `<strong>Block group ${props.GEOID}</strong><br>` +
            `${Number(props.pct_carfree).toFixed(1)}% car-free<br>` +
            `<span class="text-gray-400">${props.carfree_units} of ${props.total_units} households</span>`
        )
        .addTo(map);
    });
    map.on("mouseleave", "census-carfree-layer", () => {
      if (hoverPopup) {
        hoverPopup.remove();
        hoverPopup = null;
      }
    });
  } catch (err) {
    console.warn("Census layer unavailable:", err);
  }
}

async function loadDestinations() {
  try {
    const destinations = await getJSON("/destinations");

    map.addSource("destinations-source", { type: "geojson", data: destinations });

    map.addLayer({
      id: "destinations-layer",
      type: "circle",
      source: "destinations-source",
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 14, 5, 17, 8],
        "circle-color": [
          "match", ["get", "category"],
          "Food", CATEGORY_COLORS.Food,
          "Health", CATEGORY_COLORS.Health,
          "Education", CATEGORY_COLORS.Education,
          "Civic", CATEGORY_COLORS.Civic,
          "#94a3b8",
        ],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#0f172a",
      },
    });

    map.on("click", "destinations-layer", (event) => {
      const props = event.features[0].properties;
      new maplibregl.Popup({ className: "ct-popup" })
        .setLngLat(event.features[0].geometry.coordinates)
        .setHTML(
          `<strong>${props.name}</strong><br><span class="text-gray-400">${props.category}</span>`
        )
        .addTo(map);
    });
    map.on("mouseenter", "destinations-layer", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "destinations-layer", () => {
      map.getCanvas().style.cursor = "";
    });
  } catch (err) {
    console.warn("Destination layer unavailable:", err);
  }
}

async function loadStats() {
  const panel = document.getElementById("stats-panel");
  try {
    const { summary, equity } = await getJSON("/stats");

    const rows = [
      ["Grid nodes analysed", summary.nodes],
      ["Median access score", summary.median_score],
      ["High access nodes", `${summary.bands.high} (${pct(summary.bands.high, summary.nodes)})`],
      ["Low access nodes", `${summary.bands.low} (${pct(summary.bands.low, summary.nodes)})`],
      [
        "Nodes with no clinic reachable",
        `${summary.nodes_with_zero_access.health} (${pct(
          summary.nodes_with_zero_access.health,
          summary.nodes
        )})`,
      ],
      [
        "Nodes with no library reachable",
        `${summary.nodes_with_zero_access.civic} (${pct(
          summary.nodes_with_zero_access.civic,
          summary.nodes
        )})`,
      ],
    ];

    let html = rows
      .map(
        ([label, value]) =>
          `<div class="flex justify-between gap-3"><span>${label}</span><span class="text-gray-200 font-semibold whitespace-nowrap">${value}</span></div>`
      )
      .join("");

    if (equity.available) {
      html +=
        `<div class="mt-3 pt-3 border-t border-gray-700">` +
        `<p class="text-[11px] uppercase font-bold tracking-wider text-gray-500 mb-2">Car-free equity</p>` +
        `<div class="flex justify-between gap-3"><span>Car-free households</span><span class="text-gray-200 font-semibold">${equity.carfree_households.toLocaleString()}</span></div>` +
        `<div class="flex justify-between gap-3"><span>Share of all households</span><span class="text-gray-200 font-semibold">${equity.pct_carfree_countywide}%</span></div>` +
        `<div class="flex justify-between gap-3 mt-1"><span class="text-amber-400">In low-access areas</span><span class="text-amber-400 font-bold">${equity.pct_carfree_in_low_access}%</span></div>` +
        `</div>`;
    } else {
      html += `<p class="mt-3 pt-3 border-t border-gray-700 text-amber-400/80 text-[11px]">${equity.reason}</p>`;
    }

    panel.innerHTML = html;
  } catch (err) {
    panel.innerHTML = `<p class="text-red-400">Statistics unavailable: ${err.message}</p>`;
  }
}

function pct(part, whole) {
  if (!whole) return "0%";
  return `${Math.round((100 * part) / whole)}%`;
}

/* ------------------------------------------------------------ interactions */

function selectNode(feature) {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;

  // Every score below is computed server-side. The previous build recalculated
  // them in the browser with different constants, so clicking a point and
  // searching the same address disagreed.
  renderResults({
    overall: props.access_score_100,
    subtitle: `Grid node ${props.id} · ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    scores: {
      food: props.food_100,
      health: props.health_100,
      education: props.education_100,
      civic: props.civic_100,
    },
    counts: {
      food: props.Food,
      health: props.Health,
      education: props.Education,
      civic: props.Civic,
    },
  });

  selectedNodeId = props.id;
  if (map.getLayer("access-grid-selected")) {
    map.setFilter("access-grid-selected", ["==", ["get", "id"], props.id]);
  }
  placeMarker(lon, lat);
}

function placeMarker(lon, lat) {
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = new maplibregl.Marker({ color: "#10b981" })
    .setLngLat([lon, lat])
    .addTo(map);
}

function showSearchError(message) {
  const errorEl = document.getElementById("search-error");
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function clearSearchError() {
  document.getElementById("search-error").classList.add("hidden");
}

async function executeAddressLookup() {
  const button = document.getElementById("search-btn");
  const address = document.getElementById("address-input").value.trim();
  clearSearchError();

  if (address.length < 3) {
    showSearchError("Enter at least 3 characters of an address.");
    return;
  }

  button.disabled = true;
  button.textContent = "Locating…";

  try {
    const data = await getJSON("/reachability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });

    const { longitude, latitude } = data.coordinates;
    map.flyTo({ center: [longitude, latitude], zoom: 13.5, speed: 1.2 });
    placeMarker(longitude, latitude);

    const node = data.nearest_node;
    selectedNodeId = node.id;
    if (map.getLayer("access-grid-selected")) {
      map.setFilter("access-grid-selected", ["==", ["get", "id"], node.id]);
    }

    renderResults({
      overall: data.scores.overall_score,
      subtitle: data.query_address,
      scores: data.scores,
      counts: data.counts,
      warning: node.is_far
        ? `Nearest grid node is ${Math.round(node.distance_meters)} m away, ` +
          "so these scores are only an approximation for this address."
        : null,
    });
  } catch (err) {
    showSearchError(err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Calculate Reachability";
  }
}

function renderResults({ overall, subtitle, scores, counts, warning }) {
  const overallScore = Number(overall) || 0;
  const overallEl = document.getElementById("score-overall");
  overallEl.textContent = overallScore;
  overallEl.className = `text-4xl font-extrabold my-1 ${
    overallScore >= 70
      ? "text-emerald-400"
      : overallScore >= 35
      ? "text-amber-400"
      : "text-red-400"
  }`;

  document.getElementById("score-subtitle").textContent = subtitle || "Calculated Zone";

  const warningEl = document.getElementById("score-warning");
  if (warning) {
    warningEl.textContent = warning;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }

  document.querySelectorAll(".category-row").forEach((row) => {
    const key = row.dataset.cat;
    // `?? 0` rather than `|| 0`: a genuine score of 0 is meaningful data here,
    // and the old code silently replaced it with an invented estimate.
    const value = Number(scores?.[key] ?? 0);
    const count = counts?.[key];

    row.querySelector(".score-value").textContent = value;
    row.querySelector(".count-value").textContent =
      count === undefined || count === null ? "" : `(${count})`;

    const bar = row.querySelector(".score-bar");
    bar.style.width = `${Math.min(100, Math.max(0, value))}%`;
    bar.className = `score-bar h-full rounded-full transition-all duration-500 ${
      value >= 70 ? "bg-emerald-500" : value >= 35 ? "bg-amber-500" : "bg-red-500"
    }`;
  });
}

/* ------------------------------------------------------------------ controls */

document.getElementById("search-btn").addEventListener("click", executeAddressLookup);
document.getElementById("address-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") executeAddressLookup();
});

function setLayerVisibility(layerIds, visible) {
  layerIds.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  });
}

document.getElementById("toggle-grid").addEventListener("change", (event) => {
  setLayerVisibility(["access-grid-layer", "access-grid-selected"], event.target.checked);
});

document.getElementById("toggle-census").addEventListener("change", (event) => {
  setLayerVisibility(
    ["census-carfree-layer", "census-carfree-outline"],
    event.target.checked
  );
  document
    .getElementById("legend-census")
    .classList.toggle("hidden", !event.target.checked);
});

document.getElementById("toggle-destinations").addEventListener("change", (event) => {
  setLayerVisibility(["destinations-layer"], event.target.checked);
  document
    .getElementById("destination-filters")
    .classList.toggle("hidden", !event.target.checked);
  document
    .getElementById("legend-destinations")
    .classList.toggle("hidden", !event.target.checked);
  if (event.target.checked) applyDestinationFilter();
});

function applyDestinationFilter() {
  const active = Array.from(document.querySelectorAll(".dest-cat"))
    .filter((box) => box.checked)
    .map((box) => box.value);
  if (!map.getLayer("destinations-layer")) return;
  map.setFilter("destinations-layer", ["in", ["get", "category"], ["literal", active]]);
}

document.querySelectorAll(".dest-cat").forEach((box) => {
  box.addEventListener("change", applyDestinationFilter);
});

document.getElementById("toggle-sidebar").addEventListener("click", (event) => {
  const sidebar = document.getElementById("sidebar");
  const hidden = sidebar.classList.toggle("hidden");
  event.target.textContent = hidden ? "Show panel" : "Hide panel";
  map.resize();
});
