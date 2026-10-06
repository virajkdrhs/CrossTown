/** Commute Check: is one person's trip to one workplace actually viable? */

import { getJSON, postJSON } from "./api.js";
import { map, THEME, setMarker, showMarkersWithPrefix, fitToPoints, setVisibility, emptyCollection } from "./map.js";
import {
  escapeHTML, statusPill, verdictMeta, verdictColor, tile, money, icon, sectionTitle,
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
  const destinationInput = document.getElementById("commute-destination");
  select.addEventListener("change", () => {
    const preset = WORKSITE_PRESETS[Number(select.value)];
    if (preset) destinationInput.value = preset.label;
    else {
      destinationInput.value = "";
      destinationInput.focus();
    }
  });
  // Keep the dropdown honest about what will be sent.
  destinationInput.addEventListener("input", () => {
    const match = WORKSITE_PRESETS.findIndex((preset) => preset.label === destinationInput.value.trim());
    select.value = String(match);
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
      note.style.color = "var(--orange)";
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

  ["commute-shift-start", "commute-shift-end"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      const start = document.getElementById("commute-shift-start").value;
      const end = document.getElementById("commute-shift-end").value;
      chips.forEach((chip) =>
        chip.setAttribute("aria-pressed", chip.dataset.start === start && chip.dataset.end === end ? "true" : "false")
      );
    });
  });

  // Enter anywhere in the form runs the check.
  ["commute-origin", "commute-destination"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") runCheck();
    });
  });

  document.getElementById("commute-result").innerHTML = emptyState(
    "bus",
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
      "line-color": "#8e8e93",
      "line-width": 3.5,
      "line-dasharray": [0.1, 2],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "commute-route-bus",
    type: "line",
    source: "commute-route-source",
    filter: ["==", ["get", "mode"], "bus"],
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0071e3", "line-width": 6, "line-opacity": 0.95 },
  });

  map.addSource("commute-stops-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "commute-stops-layer",
    type: "circle",
    source: "commute-stops-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 5.5,
      "circle-color": THEME.ink,
      "circle-stroke-width": 3,
      "circle-stroke-color": "#0071e3",
    },
  });
}

export const layers = ["commute-route-walk", "commute-route-bus", "commute-stops-layer"];

export function focus() {
  setVisibility(layers, true);
  showMarkersWithPrefix("commute-", true);
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
    resultEl.innerHTML = emptyState("triangle", "Couldn't check that commute", err.message);
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
  metrics.push(tile("By car", `${comparison.drive_estimate_minutes} min`, "estimated"));
  if (comparison.transit_penalty != null) {
    metrics.push(tile("Transit penalty", `${comparison.transit_penalty}×`, "longer than driving", "var(--orange)"));
  }
  // Name the distance for what it actually is, so a fallback never masquerades
  // as a road measurement.
  const roadRouted = comparison.distance_provider === "osrm" && comparison.road_km != null;
  metrics.push(
    roadRouted
      ? tile("Distance", `${comparison.road_km} km`, "by road")
      : tile("Distance", `${comparison.straight_line_km} km`, "straight-line estimate")
  );

  const reasons = data.reasons.length
    ? `<div>
        ${sectionTitle("Why")}
        <ul class="group reasons">${data.reasons
          .map((reason) => `<li>${icon("alert-circle", 16)}<span>${escapeHTML(reason)}</span></li>`)
          .join("")}</ul>
        ${stopAccessNote(data.stop_access)}
      </div>`
    : stopAccessNote(data.stop_access);

  const carpoolCta = data.carpool_recommended
    ? `<div class="callout green">
         <p class="callout-title">${icon("car", 18)}Carpool recommended</p>
         <p class="callout-body">Transit can't cover this trip. The next step is the rider's employer pool for this shift.</p>
         <button id="commute-carpool-btn" class="btn btn-primary btn-sm mt-3">See who else is stranded</button>
       </div>`
    : "";

  result.innerHTML = `
    <div>
      <div class="verdict-head mb-2">
        ${statusPill(data.verdict, { size: "lg" })}
        <span class="small text-3">${escapeHTML(data.shift.day_name)}, ${escapeHTML(data.shift.day)}</span>
      </div>
      <p class="blurb">${escapeHTML(meta.blurb)}</p>
    </div>
    <div class="tile-grid">${metrics.join("")}</div>
    ${carpoolCta}
    ${reasons}
    ${microtransitPanel(data.microtransit)}
    ${itinerary("Getting there", data.outbound, data.has_microtransit_option)}
    ${itinerary("Getting home", data.inbound, data.has_microtransit_option)}
    ${costPanel(cost)}
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
  return `<div>
    ${sectionTitle("What it costs", `${cost.drive_round_trip_miles} mi round trip`)}
    <div class="group">
      <div class="versus">
        <div>
          <p class="big" style="color:var(--green)">Free</p>
          <p class="tiny text-3">by bus or LINK</p>
        </div>
        <span class="vs">vs</span>
        <div class="right">
          <p class="big" style="color:var(--orange)">${money(cost.drive_cost_per_year_usd)}<small>/yr</small></p>
          <p class="tiny text-3">${money(cost.drive_cost_per_day_usd)} a day to drive</p>
        </div>
      </div>
    </div>
    <p class="group-note">${escapeHTML(cost.cost_basis)}</p>
  </div>`;
}

/** LINK is fare-free GRTC service the GTFS feed omits entirely. */
function microtransitPanel(options) {
  if (!options || !options.length) return "";
  const cards = options
    .map((option) => {
      const zone = option.zone || {};
      const routes = (zone.connects_routes || []).slice(0, 6);
      return `<div class="callout ${option.available ? "teal" : "muted"}">
        <p class="callout-title">${icon("van", 18)}${escapeHTML(option.headline)}</p>
        <p class="callout-body">${escapeHTML(option.detail)}</p>
        <div class="meta-line">
          <span>Zone ${escapeHTML(zone.name || "?")}</span>
          <span>~${escapeHTML(zone.wait_minutes ?? "?")} min wait</span>
          <span>${escapeHTML(zone.fare || "Free")}</span>
          ${zone.hours_today ? `<span>Today ${escapeHTML(zone.hours_today[0])}–${escapeHTML(zone.hours_today[1])}</span>` : "<span>Closed today</span>"}
          ${routes.length ? `<span>Connects to ${routes.map(escapeHTML).join(", ")}</span>` : ""}
        </div>
        ${
          zone.booking
            ? `<p class="meta-line">Book in ${escapeHTML(zone.booking.app)} or call ${escapeHTML(
                zone.booking.phone
              )} · up to ${escapeHTML(zone.booking.max_passengers)} riders</p>`
            : ""
        }
      </div>`;
    })
    .join("");
  return `<div>${sectionTitle("On-demand option")}<div class="stack gap-2">${cards}</div></div>`;
}

function stopAccessNote(access) {
  if (!access) return "";
  const parts = [];
  if (access.destination_nearest_stop_m != null) {
    parts.push(
      `Nearest stop to work: ${escapeHTML(access.destination_nearest_stop || "?")}, ` +
        `${access.destination_nearest_stop_m.toLocaleString()} m`
    );
  }
  if (access.origin_nearest_stop_m != null) {
    parts.push(`nearest stop to home: ${access.origin_nearest_stop_m.toLocaleString()} m`);
  }
  if (!parts.length) return "";
  return `<p class="group-note">${parts.join(" · ")}.</p>`;
}

function itinerary(title, journey, hasLinkOption = false) {
  if (!journey) {
    // A bald "No service" directly under a LINK panel reads as a contradiction.
    // Say precisely which mode is missing.
    const message = hasLinkOption
      ? "No scheduled bus route. Use the on-demand option above."
      : "No bus can make this trip.";
    return `<div>
      ${sectionTitle(title)}
      <div class="group row"><span class="small" style="color:${
        hasLinkOption ? "var(--text-2)" : "var(--red)"
      }">${message}</span></div>
    </div>`;
  }

  const legs = journey.legs
    .map((leg) => {
      const isBus = leg.mode === "bus";
      const detail = isBus
        ? `<span class="route-badge">${escapeHTML(leg.route || "Bus")}</span>
           <span class="when">${escapeHTML(leg.duration_minutes)} min${
             leg.stops ? ` · ${escapeHTML(leg.stops)} stops` : ""
           }</span>`
        : `<span class="when">Walk ${escapeHTML(leg.distance_m ?? "?")} m · ${escapeHTML(leg.duration_minutes)} min</span>`;
      return `<li class="ct-leg">
        <span class="ct-leg-icon ${isBus ? "bus" : ""}">${icon(isBus ? "bus" : "walk", 15)}</span>
        <div class="grow">
          <div class="hstack gap-2 wrap">${detail}</div>
          <p class="where truncate" title="${escapeHTML(leg.from)} → ${escapeHTML(leg.to)}">${escapeHTML(
            leg.from
          )} → ${escapeHTML(leg.to)}</p>
        </div>
        <span class="when nowrap">${escapeHTML(leg.depart)}</span>
      </li>`;
    })
    .join("");

  const transfers = `${journey.transfers} transfer${journey.transfers === 1 ? "" : "s"}`;
  return `<div>
    ${sectionTitle(title, `${journey.depart} → ${journey.arrive} · ${transfers}`)}
    <ul class="group timeline">${legs}</ul>
  </div>`;
}

function drawJourney(data) {
  const journey = data.outbound;
  setMarker("commute-origin", [data.origin.lon, data.origin.lat], {
    color: "#0071e3",
    label: `<strong>Home</strong><br>${escapeHTML(data.origin.name)}`,
  });
  setMarker("commute-destination", [data.destination.lon, data.destination.lat], {
    color: "#ff9500",
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
  showMarkersWithPrefix("commute-", false);
}

