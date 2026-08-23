/** Commute Check: is one person's trip to one workplace actually viable? */

import { getJSON, postJSON } from "./api.js";
import { map, setMarker, clearMarker, fitToPoints, setVisibility, emptyCollection } from "./map.js";
import {
  escapeHTML, statusPill, verdictMeta, verdictColor, tile, money,
  toast, skeleton, emptyState, withBusy,
} from "./ui.js";

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
  const chips = document.querySelectorAll(".commute-shift-preset");
  chips.forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("commute-shift-start").value = button.dataset.start;
      document.getElementById("commute-shift-end").value = button.dataset.end;
      chips.forEach((other) => other.setAttribute("aria-pressed", other === button ? "true" : "false"));
    });
  });

  // Enter anywhere in the form runs the check.
  ["commute-origin", "commute-destination"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") runCheck();
    });
  });

  document.getElementById("commute-result").innerHTML = emptyState(
    "🚌",
    "Check a commute",
    "Pick a home, a workplace and a shift. The planner routes it on the live GRTC schedule and says whether it actually works."
  );
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
    toast("Enter both a home and a workplace.", "warn");
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

  resultEl.innerHTML = skeleton(6, { heading: true });
  try {
    await withBusy(button, "Checking…", async () => {
      const data = await postJSON("/api/v2/commute", payload);
      render(data);
      drawJourney(data);
      const meta = verdictMeta(data.verdict);
      toast(
        `${meta.label}: ${originText.split(",")[0]} → ${destinationText}`,
        data.verdict === "viable" || data.verdict === "microtransit" ? "ok" : "warn"
      );
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    resultEl.innerHTML = emptyState("⚠️", "Could not check that commute", err.message);
    toast(err.message, "error");
  }
}

function render(data) {
  const meta = verdictMeta(data.verdict);
  const comparison = data.comparison;
  const cost = data.cost || {};
  const result = document.getElementById("commute-result");

  const metrics = [];
  if (comparison.transit_minutes != null) {
    metrics.push(tile("By transit", `${comparison.transit_minutes} min`, "each way", verdictColor(data.verdict)));
  }
  metrics.push(tile("Driving", `${comparison.drive_estimate_minutes} min`, "estimated"));
  if (comparison.transit_penalty != null) {
    metrics.push(tile("Transit penalty", `${comparison.transit_penalty}×`, "longer than driving", "var(--ct-warn)"));
  }
  metrics.push(tile("Distance", `${comparison.straight_line_km} km`, "straight line"));

  const reasons = data.reasons
    .map(
      (reason) =>
        `<li class="flex gap-2"><span class="mt-[3px]" style="color:var(--ct-text-dim)">▸</span><span>${escapeHTML(
          reason
        )}</span></li>`
    )
    .join("");

  const carpoolCta = data.carpool_recommended
    ? `<div class="mt-4 rounded-lg p-3" style="border:1px solid color-mix(in srgb, var(--ct-brand) 45%, transparent);background:color-mix(in srgb, var(--ct-brand) 9%, transparent)">
         <p class="font-semibold text-xs mb-1" style="color:var(--ct-ok)">Carpool recommended</p>
         <p class="text-[11px] leading-relaxed" style="color:var(--ct-text-muted)">
           Transit cannot cover this trip. Next step is the rider's employer pool for this shift.
         </p>
         <button id="commute-carpool-btn" class="mt-2 w-full text-xs font-bold py-2 rounded-md transition"
                 style="background:var(--ct-brand);color:var(--ct-bg)">
           See who else is stranded on this shift
         </button>
       </div>`
    : "";

  result.innerHTML = `
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      ${statusPill(data.verdict, { size: "lg" })}
      <span class="text-[11px]" style="color:var(--ct-text-dim)">${escapeHTML(data.shift.day_name)} ${escapeHTML(
        data.shift.day
      )}</span>
    </div>
    <p class="text-[11px] mb-3 leading-relaxed" style="color:var(--ct-text-muted)">${escapeHTML(meta.blurb)}</p>
    <div class="grid grid-cols-2 gap-2 mb-3">${metrics.join("")}</div>
    ${costPanel(cost)}
    <ul class="text-[11px] space-y-1 mb-1" style="color:var(--ct-text-muted)">${reasons}</ul>
    ${stopAccessNote(data.stop_access)}
    ${microtransitPanel(data.microtransit)}
    ${itinerary("Trip to work", data.outbound, data.has_microtransit_option)}
    ${itinerary("Trip home", data.inbound, data.has_microtransit_option)}
    ${carpoolCta}
  `;

  const carpoolButton = document.getElementById("commute-carpool-btn");
  if (carpoolButton) {
    carpoolButton.addEventListener("click", () => {
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

/** GRTC charges no fare, so the honest comparison is against car ownership. */
function costPanel(cost) {
  if (cost.drive_cost_per_year_usd == null) return "";
  return `<div class="rounded-lg p-2.5 mb-3" style="border:1px solid var(--ct-border-soft);background:var(--ct-raised)">
    <div class="flex items-baseline justify-between mb-1">
      <span class="text-[10px] uppercase font-bold tracking-wider" style="color:var(--ct-text-dim)">What it costs</span>
      <span class="text-[10px]" style="color:var(--ct-text-dim)">${escapeHTML(cost.drive_round_trip_miles)} mi round trip</span>
    </div>
    <div class="flex items-center gap-3">
      <div>
        <p class="text-base font-extrabold" style="color:var(--ct-ok)">Free</p>
        <p class="text-[9.5px]" style="color:var(--ct-text-dim)">by bus or LINK</p>
      </div>
      <span style="color:var(--ct-text-dim)">vs</span>
      <div>
        <p class="text-base font-extrabold" style="color:var(--ct-warn)">${money(cost.drive_cost_per_year_usd)}<span class="text-[10px] font-normal">/yr</span></p>
        <p class="text-[9.5px]" style="color:var(--ct-text-dim)">${money(cost.drive_cost_per_day_usd)}/day to drive</p>
      </div>
    </div>
    <p class="text-[9.5px] mt-1.5" style="color:var(--ct-text-dim)">${escapeHTML(cost.cost_basis)}</p>
  </div>`;
}

/** LINK is fare-free GRTC service the GTFS feed omits entirely. */
function microtransitPanel(options) {
  if (!options || !options.length) return "";
  const cards = options
    .map((option) => {
      const live = option.available;
      const zone = option.zone || {};
      const accent = live ? "var(--ct-info)" : "var(--ct-text-dim)";
      const routes = (zone.connects_routes || []).slice(0, 6);
      return `<div class="rounded-lg p-2.5 mb-2" style="border:1px solid color-mix(in srgb, ${accent} 35%, transparent);background:color-mix(in srgb, ${accent} 8%, transparent)">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs">🚐</span>
          <span class="text-[11px] font-bold" style="color:${accent}">${escapeHTML(option.headline)}</span>
        </div>
        <p class="text-[10.5px] leading-relaxed mb-1.5" style="color:var(--ct-text-muted)">${escapeHTML(option.detail)}</p>
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[9.5px]" style="color:var(--ct-text-dim)">
          <span>Zone: ${escapeHTML(zone.name || "?")}</span>
          <span>Wait ~${escapeHTML(zone.wait_minutes ?? "?")} min</span>
          <span>Fare: ${escapeHTML(zone.fare || "Free")}</span>
          ${zone.hours_today ? `<span>Today ${escapeHTML(zone.hours_today[0])}–${escapeHTML(zone.hours_today[1])}</span>` : "<span>Closed today</span>"}
          ${routes.length ? `<span>Connects: ${routes.map(escapeHTML).join(", ")}</span>` : ""}
        </div>
        ${
          zone.booking
            ? `<p class="text-[9.5px] mt-1" style="color:var(--ct-text-dim)">Book in ${escapeHTML(
                zone.booking.app
              )} or call ${escapeHTML(zone.booking.phone)} · up to ${escapeHTML(
                zone.booking.max_passengers
              )} passengers</p>`
            : ""
        }
      </div>`;
    })
    .join("");
  return `<div class="mt-1 mb-2">
    <p class="text-[11px] uppercase font-bold tracking-wider mb-1.5" style="color:var(--ct-text-dim)">On-demand option</p>
    ${cards}
  </div>`;
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

function itinerary(title, journey, hasLinkOption = false) {
  if (!journey) {
    // A bald "No service" directly under a LINK panel reads as a contradiction.
    // Say precisely which mode is missing.
    const message = hasLinkOption
      ? "No scheduled bus route — use the on-demand option above."
      : "No service.";
    return `<div class="mt-3">
      <p class="text-[11px] uppercase font-bold tracking-wider mb-1" style="color:var(--ct-text-dim)">${title} by bus</p>
      <p class="text-[11px]" style="color:${hasLinkOption ? "var(--ct-text-muted)" : "var(--ct-bad)"}">${message}</p>
    </div>`;
  }

  const legs = journey.legs
    .map((leg) => {
      const isBus = leg.mode === "bus";
      const badge = isBus
        ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded" style="background:color-mix(in srgb, var(--ct-info) 20%, transparent);color:var(--ct-info)">${escapeHTML(
            leg.route || "bus"
          )}</span>`
        : `<span class="text-[10px]" style="color:var(--ct-text-dim)">${leg.distance_m ?? "?"} m walk</span>`;
      return `<li class="ct-leg">
        <span class="ct-leg-icon">${isBus ? "🚌" : "🚶"}</span>
        <div class="min-w-0 flex-1 pb-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${badge}
            <span class="text-[11px]" style="color:var(--ct-text-muted)">${leg.duration_minutes} min</span>
            ${leg.stops ? `<span class="text-[10px]" style="color:var(--ct-text-dim)">${leg.stops} stops</span>` : ""}
          </div>
          <p class="text-[11px] truncate" style="color:var(--ct-text)" title="${escapeHTML(leg.from)} → ${escapeHTML(
            leg.to
          )}">${escapeHTML(leg.from)} → ${escapeHTML(leg.to)}</p>
        </div>
        <span class="text-[10px] shrink-0" style="color:var(--ct-text-dim)">${leg.depart}</span>
      </li>`;
    })
    .join("");

  return `<div class="mt-3">
    <div class="flex justify-between items-baseline mb-1.5">
      <p class="text-[11px] uppercase font-bold tracking-wider" style="color:var(--ct-text-dim)">${title}</p>
      <p class="text-[11px]" style="color:var(--ct-text-muted)">${journey.depart} → ${journey.arrive}
        <span style="color:var(--ct-text-dim)">·</span> ${journey.transfers} transfer${
          journey.transfers === 1 ? "" : "s"
        }</p>
    </div>
    <ul class="rounded-lg p-2.5" style="background:var(--ct-raised);border:1px solid var(--ct-border-soft)">${legs}</ul>
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

