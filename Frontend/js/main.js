/** App shell: view switching, API status, and shared chrome. */

import { getJSON } from "./api.js";
import { map, ready, setVisibility } from "./map.js";
import * as access from "./access.js";
import * as commute from "./commute.js";
import * as employer from "./employer.js";
import * as carpoolView from "./carpool.js";

const VIEWS = {
  access: {
    panel: "access-view",
    legend: ["legend-access"],
    module: access,
    title: "Where transit reaches across Henrico County",
  },
  commute: {
    panel: "commute-view",
    legend: ["legend-commute"],
    module: commute,
    title: "Check whether one commute is viable",
  },
  employer: {
    panel: "employer-view",
    legend: ["legend-employer"],
    module: employer,
    title: "Find staff who cannot reach a worksite",
  },
  carpool: {
    panel: "carpool-view",
    legend: ["legend-carpool"],
    module: carpoolView,
    title: "Match stranded staff with colleagues who drive",
  },
};

let currentView = "access";

function setApiStatus(text, ok) {
  const el = document.getElementById("api-status");
  el.textContent = text;
  el.className = ok
    ? "text-xs px-2 py-1 rounded-full border border-emerald-600 text-emerald-400"
    : "text-xs px-2 py-1 rounded-full border border-red-600 text-red-400";
}

function showView(name) {
  if (!VIEWS[name]) return;

  // Leaving a view takes its markers with it, otherwise a commute pin lingers on
  // the employer map.
  if (currentView !== name) {
    const leaving = VIEWS[currentView];
    if (leaving && typeof leaving.module.clear === "function") leaving.module.clear();
  }
  currentView = name;

  Object.entries(VIEWS).forEach(([key, view]) => {
    document.getElementById(view.panel).classList.toggle("hidden", key !== name);
    view.legend.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("hidden", key !== name);
    });
    // Each view only paints its own layers.
    if (key !== name) setVisibility(view.module.layers || [], false);
  });

  document.querySelectorAll(".view-tab").forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.className = active
      ? "view-tab px-3 py-1.5 text-xs font-semibold rounded-md bg-emerald-500 text-gray-900 transition"
      : "view-tab px-3 py-1.5 text-xs font-semibold rounded-md text-gray-400 hover:text-white hover:bg-gray-700 transition";
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  document.getElementById("view-subtitle").textContent = VIEWS[name].title;

  if (name === "access") access.restoreLayerVisibility();
  const view = VIEWS[name].module;
  if (typeof view.focus === "function") view.focus();
}

async function start() {
  try {
    const health = await getJSON("/api/v1/health");
    setApiStatus(`API ok · ${health.data_source}`, true);
    const budget = document.getElementById("budget-label");
    if (budget) budget.textContent = health.travel_time_budget_minutes ?? 45;
  } catch (err) {
    setApiStatus("API offline", false);
    document.getElementById("offline-banner").classList.remove("hidden");
    return;
  }

  await ready;

  // Access layers must exist before other views insert layers relative to them.
  await access.init();
  await commute.init();
  await employer.init();
  await carpoolView.init();

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });

  window.addEventListener("crosstown:show-employer", () => showView("employer"));

  document.getElementById("toggle-sidebar").addEventListener("click", (event) => {
    const sidebar = document.getElementById("sidebar");
    const hidden = sidebar.classList.toggle("hidden");
    event.target.textContent = hidden ? "Show panel" : "Hide panel";
    map.resize();
  });

  showView("access");
}

// Without this, one view failing to initialise leaves the whole shell dead with
// nothing in the console: the tab listeners below never get attached either.
start().catch((err) => {
  console.error("CrossTown failed to start:", err);
  setApiStatus("startup failed", false);
  const banner = document.getElementById("offline-banner");
  banner.querySelector("p").textContent = "CrossTown failed to start";
  banner.querySelectorAll("p")[1].textContent = err && err.message ? err.message : String(err);
  banner.classList.remove("hidden");
});
