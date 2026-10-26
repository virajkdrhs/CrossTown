/** County access map view: score grid, Census overlay, amenities, statistics. */

import { getJSON, postJSON } from "./api.js";
import { map, dark, THEME, setVisibility, fitToPoints, setMarker, showMarkersWithPrefix } from "./map.js";
import { escapeHTML, toast, skeleton, emptyState, withBusy } from "./ui.js";

const CATEGORY_COLORS = {
  Food: "#4E9A63",
  Health: "#B4453C",
  Education: "#C7843F",
  Civic: "#8A6CC0",
};

// Muted red → amber → green, matching the panel's score ring and legend.
const SCORE_RAMP = ["#B4453C", "#C7843F", "#4E9A63"];
const RING_CIRCUMFERENCE = 257.6;

let hoverPopup = null;
let gridBounds = [];
let framed = false;

export async function init() {
  await Promise.all([loadAccessGrid(), loadCensusLayer(), loadDestinations()]);
  loadStats();
  wireControls();
}

export function focus() {
  showMarkersWithPrefix("access-", true);
  // Frame the county once. Re-framing on every return threw away whatever the
  // visitor had zoomed into, including a searched address.
  if (!framed && gridBounds.length) {
    fitToPoints(gridBounds, { padding: 40, duration: 0 });
    framed = true;
  }
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
          0, SCORE_RAMP[0],
          50, SCORE_RAMP[1],
          100, SCORE_RAMP[2],
        ],
        "circle-opacity": dark ? 0.6 : 0.5,
        "circle-stroke-width": 1,
        "circle-stroke-color": THEME.stroke,
        "circle-stroke-opacity": 0.9,
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
        "circle-stroke-color": "#5A78E0",
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
    const ramp = dark ? ["#1c1c1e", "#5e5ce6", "#bf5af2"] : ["#f2f2f7", "#5856d6", "#af52de"];
    const legendRamp = document.getElementById("legend-census-ramp");
    if (legendRamp) legendRamp.style.background = `linear-gradient(90deg, ${ramp.join(", ")})`;

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
            0, ramp[0],
            rampMax / 2, ramp[1],
            rampMax, ramp[2],
          ],
          "fill-opacity": dark ? 0.55 : 0.5,
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
        paint: { "line-color": ramp[1], "line-width": 0.5, "line-opacity": 0.4 },
      },
      "access-grid-layer"
    );

    map.on("mousemove", "census-carfree-layer", (event) => {
      const props = event.features[0].properties;
      if (hoverPopup) hoverPopup.remove();
      hoverPopup = new maplibregl.Popup({ closeButton: false, className: "ct-popup" })
        .setLngLat(event.lngLat)
        .setHTML(
          `<strong>${Number(props.pct_carfree).toFixed(1)}% car-free</strong><br>` +
            `<span class="ct-muted">${escapeHTML(props.carfree_units)} of ${escapeHTML(
              props.total_units
            )} households · block group ${escapeHTML(props.GEOID)}</span>`
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
        "circle-stroke-color": THEME.stroke,
      },
    });

    map.on("click", "destinations-layer", (event) => {
      const props = event.features[0].properties;
      new maplibregl.Popup({ className: "ct-popup" })
        .setLngLat(event.features[0].geometry.coordinates)
        .setHTML(
          `<strong>${escapeHTML(props.name)}</strong><br><span class="ct-muted">${escapeHTML(
            props.category
          )}</span>`
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
  panel.innerHTML = skeleton(5);
  try {
    const { summary, equity } = await getJSON("/api/v1/stats");
    const nodes = summary.nodes;

    let html = `<div class="tile-grid">
      ${statTile("Median score", summary.median_score, `across ${nodes} neighbourhoods`)}
      ${statTile("Low access", pct(summary.bands.low, nodes), `${summary.bands.low} neighbourhoods`, "var(--red)")}
      ${statTile("No clinic", pct(summary.nodes_with_zero_access.health, nodes), "reachable in time", "var(--orange)")}
      ${statTile("No library", pct(summary.nodes_with_zero_access.civic, nodes), "reachable in time", "var(--orange)")}
    </div>`;

    if (equity.available) {
      html += `<div class="group mt-2">
        ${statRow("Car-free households", equity.carfree_households.toLocaleString())}
        ${statRow("Share of all households", `${equity.pct_carfree_countywide}%`)}
        ${statRow("Living in low-access areas", `<span class="strong" style="color:var(--orange)">${equity.pct_carfree_in_low_access}%</span>`)}
        ${statRow("High-access neighbourhoods", `${summary.bands.high} (${pct(summary.bands.high, nodes)})`)}
      </div>`;
    } else {
      html += `<p class="group-note">${escapeHTML(equity.reason)}</p>`;
    }
    panel.innerHTML = html;
  } catch (err) {
    panel.innerHTML = emptyState("chart", "Statistics unavailable", err.message);
  }
}

function statTile(label, value, sub, accent = "") {
  return `<div class="ct-tile">
    <p class="ct-tile-label">${escapeHTML(label)}</p>
    <p class="ct-tile-value" ${accent ? `style="color:${accent}"` : ""}>${escapeHTML(value)}</p>
    <p class="ct-tile-sub">${escapeHTML(sub)}</p>
  </div>`;
}

/** `value` may be trusted markup built here from numbers. */
function statRow(label, value) {
  return `<div class="row"><span>${escapeHTML(label)}</span><span class="value">${value}</span></div>`;
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
    subtitle: `Neighbourhood ${props.id} · ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
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
  document.getElementById("search-error").classList.add("hidden");
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

function scoreColor(value) {
  return value >= 70 ? "var(--green-fill)" : value >= 35 ? "var(--orange-fill)" : "var(--red-fill)";
}

function renderResults({ overall, subtitle, scores, counts, warning }) {
  const overallScore = Math.round(Number(overall) || 0);
  document.getElementById("score-overall").textContent = overallScore;
  const ring = document.getElementById("score-ring");
  ring.style.stroke = scoreColor(overallScore);
  ring.style.strokeDashoffset = String(
    RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, overallScore)) / 100)
  );

  document.getElementById("score-subtitle").textContent = subtitle || "Selected area";

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
      count === undefined || count === null ? "" : `${count} places`;

    const bar = row.querySelector(".score-bar");
    bar.style.width = `${Math.min(100, Math.max(0, value))}%`;
    bar.style.background = scoreColor(value);
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
  showMarkersWithPrefix("access-", false);
}

export function restoreLayerVisibility() {
  setVisibility(["access-grid-layer", "access-grid-selected"], document.getElementById("toggle-grid").checked);
  setVisibility(
    ["census-carfree-layer", "census-carfree-outline"],
    document.getElementById("toggle-census").checked
  );
  setVisibility(["destinations-layer"], document.getElementById("toggle-destinations").checked);
}
