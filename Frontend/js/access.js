/** County access map view: score grid, Census overlay, amenities, statistics. */

import { getJSON, postJSON } from "./api.js";
import { map, setVisibility, fitToPoints, setMarker, clearMarker } from "./map.js";
import { escapeHTML, toast, skeleton, emptyState, withBusy, money } from "./ui.js";

const CATEGORY_COLORS = {
  Food: "#34d399",
  Health: "#fb7185",
  Education: "#fbbf24",
  Civic: "#a78bfa",
};

let hoverPopup = null;
let gridBounds = [];

export async function init() {
  await Promise.all([loadAccessGrid(), loadCensusLayer(), loadDestinations()]);
  loadStats();
  wireControls();
}

export function focus() {
  if (gridBounds.length) fitToPoints(gridBounds, { padding: 60, duration: 0 });
}

async function loadAccessGrid() {
  try {
    const gridData = await getJSON("/api/v1/grid");
    gridBounds = gridData.features.map((feature) => feature.geometry.coordinates);

    map.addSource("access-grid-source", { type: "geojson", data: gridData });

    map.addLayer({
      id: "access-grid-layer",
      type: "circle",
      source: "access-grid-source",
      paint: {
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
    const censusData = await getJSON("/api/v1/demographics");

    const percentages = censusData.features
      .map((feature) => Number(feature.properties.pct_carfree) || 0)
      .sort((a, b) => a - b);
    // Ramp to the 95th percentile so a couple of extreme block groups do not
    // flatten everything else into one shade.
    const rampMax = Math.max(
      5,
      Math.ceil(percentages[Math.floor(percentages.length * 0.95)] || 20)
    );
    const legendMax = document.getElementById("legend-census-max");
    if (legendMax) legendMax.textContent = `${rampMax}%+`;

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
      "access-grid-layer"
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
            `<span class="ct-muted">${props.carfree_units} of ${props.total_units} households</span>`
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
    const destinations = await getJSON("/api/v1/destinations");
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
        .setHTML(`<strong>${props.name}</strong><br><span class="ct-muted">${props.category}</span>`)
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
  panel.innerHTML = skeleton(6);
  try {
    const { summary, equity } = await getJSON("/api/v1/stats");

    const rows = [
      ["Grid nodes analysed", summary.nodes],
      ["Median access score", summary.median_score],
      ["High access nodes", `${summary.bands.high} (${pct(summary.bands.high, summary.nodes)})`],
      ["Low access nodes", `${summary.bands.low} (${pct(summary.bands.low, summary.nodes)})`],
      [
        "No clinic reachable",
        `${summary.nodes_with_zero_access.health} (${pct(
          summary.nodes_with_zero_access.health,
          summary.nodes
        )})`,
      ],
      [
        "No library reachable",
        `${summary.nodes_with_zero_access.civic} (${pct(
          summary.nodes_with_zero_access.civic,
          summary.nodes
        )})`,
      ],
    ];

    let html = rows.map(([label, value]) => statRow(label, value)).join("");

    if (equity.available) {
      html +=
        `<div class="mt-3 pt-3 border-t border-gray-700">` +
        `<p class="text-[11px] uppercase font-bold tracking-wider text-gray-500 mb-2">Car-free equity</p>` +
        statRow("Car-free households", equity.carfree_households.toLocaleString()) +
        statRow("Share of all households", `${equity.pct_carfree_countywide}%`) +
        `<div class="flex justify-between gap-3 mt-1"><span class="text-amber-400">In low-access areas</span>` +
        `<span class="text-amber-400 font-bold">${equity.pct_carfree_in_low_access}%</span></div>` +
        `</div>`;
    } else {
      html += `<p class="mt-3 pt-3 border-t border-gray-700 text-amber-400/80 text-[11px]">${equity.reason}</p>`;
    }
    panel.innerHTML = html;
  } catch (err) {
    panel.innerHTML = emptyState("📊", "Statistics unavailable", err.message);
  }
}

function statRow(label, value) {
  return (
    `<div class="flex justify-between gap-3"><span>${label}</span>` +
    `<span class="text-gray-200 font-semibold whitespace-nowrap">${value}</span></div>`
  );
}

function pct(part, whole) {
  if (!whole) return "0%";
  return `${Math.round((100 * part) / whole)}%`;
}

function selectNode(feature) {
  const props = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;

  // Every score here is computed server-side so map clicks and address searches
  // cannot disagree.
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

  if (map.getLayer("access-grid-selected")) {
    map.setFilter("access-grid-selected", ["==", ["get", "id"], props.id]);
  }
  setMarker("access-selection", [lon, lat]);
}

function showSearchError(message) {
  const errorEl = document.getElementById("search-error");
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

async function executeAddressLookup() {
  const button = document.getElementById("search-btn");
  const address = document.getElementById("address-input").value.trim();
  document.getElementById("search-error").classList.add("hidden");

  if (address.length < 3) {
    showSearchError("Enter at least 3 characters of an address.");
    return;
  }

  try {
    await withBusy(button, "Locating…", async () => {
    const data = await postJSON("/api/v1/reachability", { address });
    const { longitude, latitude } = data.coordinates;
    map.flyTo({ center: [longitude, latitude], zoom: 13.5, speed: 1.2 });
    setMarker("access-selection", [longitude, latitude]);

    const node = data.nearest_node;
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
    });
  } catch (err) {
    showSearchError(err.message);
    toast(err.message, "error");
  }
}

function renderResults({ overall, subtitle, scores, counts, warning }) {
  const overallScore = Number(overall) || 0;
  const overallEl = document.getElementById("score-overall");
  overallEl.textContent = overallScore;
  overallEl.className = `text-4xl font-extrabold my-1 ${
    overallScore >= 70 ? "text-emerald-400" : overallScore >= 35 ? "text-amber-400" : "text-red-400"
  }`;

  document.getElementById("score-subtitle").textContent = subtitle || "Calculated Zone";

  const warningEl = document.getElementById("score-warning");
  if (warning) {
    warningEl.textContent = warning;
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }

  document.querySelectorAll("#access-view .category-row").forEach((row) => {
    const key = row.dataset.cat;
    // `?? 0` not `|| 0`: a genuine score of zero is real data.
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

function wireControls() {
  document.getElementById("search-btn").addEventListener("click", executeAddressLookup);
  document.getElementById("address-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") executeAddressLookup();
  });

  document.getElementById("toggle-grid").addEventListener("change", (event) => {
    setVisibility(["access-grid-layer", "access-grid-selected"], event.target.checked);
  });

  document.getElementById("toggle-census").addEventListener("change", (event) => {
    setVisibility(["census-carfree-layer", "census-carfree-outline"], event.target.checked);
    document.getElementById("legend-census").classList.toggle("hidden", !event.target.checked);
  });

  document.getElementById("toggle-destinations").addEventListener("change", (event) => {
    setVisibility(["destinations-layer"], event.target.checked);
    document.getElementById("destination-filters").classList.toggle("hidden", !event.target.checked);
    document.getElementById("legend-destinations").classList.toggle("hidden", !event.target.checked);
    if (event.target.checked) applyDestinationFilter();
  });

  document.querySelectorAll(".dest-cat").forEach((box) => {
    box.addEventListener("change", applyDestinationFilter);
  });
}

function applyDestinationFilter() {
  const active = Array.from(document.querySelectorAll(".dest-cat"))
    .filter((box) => box.checked)
    .map((box) => box.value);
  if (!map.getLayer("destinations-layer")) return;
  map.setFilter("destinations-layer", ["in", ["get", "category"], ["literal", active]]);
}

/** Layers this view owns, so the view switcher can hide them. */
export const layers = [
  "access-grid-layer",
  "access-grid-selected",
  "census-carfree-layer",
  "census-carfree-outline",
  "destinations-layer",
];

export function clear() {
  clearMarker("access-selection");
}

export function restoreLayerVisibility() {
  setVisibility(["access-grid-layer", "access-grid-selected"], document.getElementById("toggle-grid").checked);
  setVisibility(
    ["census-carfree-layer", "census-carfree-outline"],
    document.getElementById("toggle-census").checked
  );
  setVisibility(["destinations-layer"], document.getElementById("toggle-destinations").checked);
}
