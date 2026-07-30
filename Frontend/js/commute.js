/** Commute Check: is one person's trip to one workplace actually viable? */

import { getJSON, postJSON } from "./api.js";
import { map, setMarker, clearMarker, fitToPoints, setVisibility, emptyCollection } from "./map.js";

const VERDICT_STYLE = {
  viable: { label: "Transit works", chip: "bg-emerald-500 text-gray-900", text: "text-emerald-400" },
  marginal: { label: "Difficult", chip: "bg-amber-500 text-gray-900", text: "text-amber-400" },
  gap: { label: "Transit gap", chip: "bg-red-500 text-gray-900", text: "text-red-400" },
  no_service: { label: "No service", chip: "bg-red-600 text-white", text: "text-red-400" },
};

// Real Henrico-area employment sites, chosen because they demonstrate different
// failure modes: Innsbrook has no stop within a mile, Short Pump has stops but
// no early service, downtown works.
const WORKSITE_PRESETS = [
  { label: "Innsbrook office park", lat: 37.658, lon: -77.57 },
  { label: "Short Pump retail corridor", lat: 37.65, lon: -77.61 },
  { label: "Downtown Richmond", lat: 37.5407, lon: -77.436 },
  { label: "VCU Medical Center", lat: 37.5407, lon: -77.4291 },
  { label: "Richmond International Airport", lat: 37.5052, lon: -77.3197 },
  { label: "White Oak Village", lat: 37.4936, lon: -77.3742 },
];

let feedInfo = null;

export async function init() {
  const select = document.getElementById("commute-worksite-preset");
  WORKSITE_PRESETS.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = preset.label;
    select.appendChild(option);
  });
  select.addEventListener("change", () => {
    const preset = WORKSITE_PRESETS[Number(select.value)];
    if (preset) document.getElementById("commute-destination").value = preset.label;
  });
  // Start on a real preset so the text box and the dropdown agree. Otherwise the
  // default state geocodes a preset *label*, which Nominatim cannot resolve.
  select.value = "0";
  document.getElementById("commute-destination").value = WORKSITE_PRESETS[0].label;

  try {
    feedInfo = await getJSON("/api/v2/transit/health");
    const note = document.getElementById("commute-feed-note");
    if (feedInfo.available) {
      note.textContent =
        `GRTC schedule ${formatFeedDate(feedInfo.feed_start)}–${formatFeedDate(feedInfo.feed_end)} · ` +
        `${feedInfo.stops.toLocaleString()} stops, ${feedInfo.routes} routes`;
      document.getElementById("commute-day").value = feedInfo.default_day;
      document.getElementById("commute-day").min = isoFromStamp(feedInfo.feed_start);
      document.getElementById("commute-day").max = isoFromStamp(feedInfo.feed_end);
    } else {
      note.textContent = feedInfo.detail || "Transit feed unavailable.";
      note.classList.add("text-amber-400");
    }
  } catch (err) {
    console.warn("Transit health unavailable:", err);
  }

  addRouteLayers();
  document.getElementById("commute-check-btn").addEventListener("click", runCheck);
  document.querySelectorAll(".commute-shift-preset").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("commute-shift-start").value = button.dataset.start;
      document.getElementById("commute-shift-end").value = button.dataset.end;
    });
  });
}

function formatFeedDate(stamp) {
  if (!stamp || stamp.length !== 8) return stamp || "?";
  return `${stamp.slice(4, 6)}/${stamp.slice(6, 8)}/${stamp.slice(0, 4)}`;
}

function isoFromStamp(stamp) {
  if (!stamp || stamp.length !== 8) return undefined;
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

function addRouteLayers() {
  map.addSource("commute-route-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "commute-route-walk",
    type: "line",
    source: "commute-route-source",
    filter: ["==", ["get", "mode"], "walk"],
    layout: { visibility: "none", "line-cap": "round" },
    paint: {
      "line-color": "#94a3b8",
      "line-width": 3,
      "line-dasharray": [1.5, 1.5],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "commute-route-bus",
    type: "line",
    source: "commute-route-source",
    filter: ["==", ["get", "mode"], "bus"],
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#38bdf8", "line-width": 5, "line-opacity": 0.9 },
  });

  map.addSource("commute-stops-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "commute-stops-layer",
    type: "circle",
    source: "commute-stops-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 5,
      "circle-color": "#0ea5e9",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#f8fafc",
    },
  });
}

export const layers = ["commute-route-walk", "commute-route-bus", "commute-stops-layer"];

export function focus() {
  setVisibility(layers, true);
}

async function runCheck() {
  const button = document.getElementById("commute-check-btn");
  const errorEl = document.getElementById("commute-error");
  const resultEl = document.getElementById("commute-result");
  errorEl.classList.add("hidden");

  const originText = document.getElementById("commute-origin").value.trim();
  const destinationText = document.getElementById("commute-destination").value.trim();
  if (originText.length < 3 || destinationText.length < 3) {
    errorEl.textContent = "Enter both a home and a workplace.";
    errorEl.classList.remove("hidden");
    return;
  }

  const presetIndex = Number(document.getElementById("commute-worksite-preset").value);
  const preset = WORKSITE_PRESETS[presetIndex];
  // If the workplace box still matches the chosen preset, send its coordinates
  // rather than round-tripping a label through the geocoder.
  const destination =
    preset && destinationText === preset.label
      ? { lat: preset.lat, lon: preset.lon, name: preset.label }
      : { address: destinationText };

  const payload = {
    origin: { address: originText },
    destination,
    shift_start: document.getElementById("commute-shift-start").value || "09:00",
    shift_end: document.getElementById("commute-shift-end").value || null,
    day: document.getElementById("commute-day").value || null,
  };

  button.disabled = true;
  button.textContent = "Checking…";
  resultEl.classList.add("opacity-40");
  try {
    const data = await postJSON("/api/v2/commute", payload);
    render(data);
    drawJourney(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Check this commute";
    resultEl.classList.remove("opacity-40");
  }
}

function render(data) {
  const style = VERDICT_STYLE[data.verdict] || VERDICT_STYLE.gap;
  const comparison = data.comparison;
  const result = document.getElementById("commute-result");

  const metrics = [];
  if (comparison.transit_minutes != null) {
    metrics.push(metric("By transit", `${comparison.transit_minutes} min`, style.text));
  }
  metrics.push(metric("Driving (est.)", `${comparison.drive_estimate_minutes} min`, "text-gray-300"));
  if (comparison.transit_penalty != null) {
    metrics.push(
      metric("Transit penalty", `${comparison.transit_penalty}×`, "text-amber-400")
    );
  }
  metrics.push(metric("Distance", `${comparison.straight_line_km} km`, "text-gray-300"));

  const reasons = data.reasons
    .map(
      (reason) =>
        `<li class="flex gap-2"><span class="text-gray-600 mt-[3px]">▸</span><span>${escapeHTML(
          reason
        )}</span></li>`
    )
    .join("");

  const carpoolCta = data.carpool_recommended
    ? `<div class="mt-4 rounded-lg border border-emerald-600/50 bg-emerald-950/40 p-3">
         <p class="text-emerald-300 font-semibold text-xs mb-1">Carpool recommended</p>
         <p class="text-[11px] text-gray-300 leading-relaxed">
           Transit cannot cover this trip. In the full product this is where the rider
           joins their employer's verified carpool pool for this shift.
         </p>
         <button id="commute-carpool-btn" class="mt-2 w-full bg-emerald-500 hover:bg-emerald-600 text-gray-900 text-xs font-bold py-2 rounded-md transition">
           See who else is stranded on this shift
         </button>
       </div>`
    : "";

  result.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-1 rounded ${style.chip}">${style.label}</span>
      <span class="text-[11px] text-gray-500">${escapeHTML(data.shift.day_name)} ${escapeHTML(
        data.shift.day
      )}</span>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-3">${metrics.join("")}</div>
    <ul class="text-[11px] text-gray-300 space-y-1 mb-1">${reasons}</ul>
    ${stopAccessNote(data.stop_access)}
    ${itinerary("Trip to work", data.outbound)}
    ${itinerary("Trip home", data.inbound)}
    ${carpoolCta}
  `;

  const carpoolButton = document.getElementById("commute-carpool-btn");
  if (carpoolButton) {
    carpoolButton.addEventListener("click", () => {
      // Hand the workplace to the employer view so the two halves connect.
      window.dispatchEvent(
        new CustomEvent("crosstown:show-employer", {
          detail: {
            worksite: data.destination,
            shift_start: data.shift.start,
            shift_end: data.shift.end,
          },
        })
      );
    });
  }
}

function stopAccessNote(access) {
  if (!access) return "";
  const parts = [];
  if (access.destination_nearest_stop_m != null) {
    parts.push(
      `nearest stop to work: <span class="text-gray-300">${escapeHTML(
        access.destination_nearest_stop || "?"
      )}</span>, ${access.destination_nearest_stop_m.toLocaleString()} m`
    );
  }
  if (access.origin_nearest_stop_m != null) {
    parts.push(
      `nearest stop to home: ${access.origin_nearest_stop_m.toLocaleString()} m`
    );
  }
  if (!parts.length) return "";
  return `<p class="text-[10px] text-gray-500 mb-3 leading-relaxed">${parts.join(" · ")}</p>`;
}

function metric(label, value, colorClass) {
  return `<div class="bg-gray-900/70 border border-gray-700/60 rounded-lg px-2.5 py-2">
    <p class="text-[10px] uppercase tracking-wider text-gray-500">${label}</p>
    <p class="text-sm font-bold ${colorClass}">${value}</p>
  </div>`;
}

function itinerary(title, journey) {
  if (!journey) {
    return `<div class="mt-3">
      <p class="text-[11px] uppercase font-bold tracking-wider text-gray-500 mb-1">${title}</p>
      <p class="text-[11px] text-red-400">No service.</p>
    </div>`;
  }

  const legs = journey.legs
    .map((leg) => {
      const icon = leg.mode === "bus" ? "🚌" : "🚶";
      const badge =
        leg.mode === "bus"
          ? `<span class="inline-block bg-sky-500/20 text-sky-300 text-[10px] font-bold px-1.5 py-0.5 rounded">${escapeHTML(
              leg.route || "bus"
            )}</span>`
          : `<span class="text-[10px] text-gray-500">${leg.distance_m ?? "?"} m</span>`;
      return `<li class="flex gap-2 items-start">
        <span class="w-4 shrink-0 text-center">${icon}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${badge}
            <span class="text-[11px] text-gray-400">${leg.duration_minutes} min</span>
          </div>
          <p class="text-[11px] text-gray-300 truncate" title="${escapeHTML(leg.from)} → ${escapeHTML(
            leg.to
          )}">${escapeHTML(leg.from)} → ${escapeHTML(leg.to)}</p>
        </div>
        <span class="text-[10px] text-gray-500 shrink-0">${leg.depart}</span>
      </li>`;
    })
    .join("");

  return `<div class="mt-3">
    <div class="flex justify-between items-baseline mb-1.5">
      <p class="text-[11px] uppercase font-bold tracking-wider text-gray-500">${title}</p>
      <p class="text-[11px] text-gray-400">${journey.depart} → ${journey.arrive}
        <span class="text-gray-600">·</span> ${journey.transfers} transfer${
          journey.transfers === 1 ? "" : "s"
        }</p>
    </div>
    <ul class="space-y-1.5 bg-gray-900/50 rounded-lg p-2.5 border border-gray-700/50">${legs}</ul>
  </div>`;
}

function drawJourney(data) {
  const journey = data.outbound;
  setMarker("commute-origin", [data.origin.lon, data.origin.lat], {
    color: "#38bdf8",
    label: `<strong>Home</strong><br>${escapeHTML(data.origin.name)}`,
  });
  setMarker("commute-destination", [data.destination.lon, data.destination.lat], {
    color: "#f59e0b",
    label: `<strong>Workplace</strong><br>${escapeHTML(data.destination.name)}`,
  });

  const routeFeatures = [];
  const stopFeatures = [];
  const points = [
    [data.origin.lon, data.origin.lat],
    [data.destination.lon, data.destination.lat],
  ];

  if (journey) {
    journey.legs.forEach((leg) => {
      const coordinates =
        leg.shape && leg.shape.length >= 2
          ? leg.shape
          : [leg.from_lonlat, leg.to_lonlat].filter(Boolean);
      if (coordinates.length >= 2) {
        routeFeatures.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: { mode: leg.mode, route: leg.route || "" },
        });
        coordinates.forEach((point) => points.push(point));
      }
      if (leg.mode === "bus" && leg.from_lonlat) {
        stopFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: leg.from_lonlat },
          properties: { name: leg.from, route: leg.route || "" },
        });
      }
      if (leg.mode === "bus" && leg.to_lonlat) {
        stopFeatures.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: leg.to_lonlat },
          properties: { name: leg.to, route: leg.route || "" },
        });
      }
    });
  }

  map.getSource("commute-route-source").setData({
    type: "FeatureCollection",
    features: routeFeatures,
  });
  map.getSource("commute-stops-source").setData({
    type: "FeatureCollection",
    features: stopFeatures,
  });
  setVisibility(layers, true);
  fitToPoints(points, { padding: 80 });
}

export function clear() {
  clearMarker("commute-origin");
  clearMarker("commute-destination");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])
  );
}
