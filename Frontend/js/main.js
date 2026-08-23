/** App shell: view switching, keyboard control, API status, shared chrome. */

import { getJSON } from "./api.js";
import { map, ready, setVisibility } from "./map.js";
import * as access from "./access.js";
import * as commute from "./commute.js";
import * as employer from "./employer.js";
import * as carpoolView from "./carpool.js";
import * as linkZones from "./linkzones.js";
import { toast } from "./ui.js";

const VIEWS = {
  access: {
    panel: "access-view",
    legend: ["legend-access"],
    module: access,
    title: "Where transit reaches across Henrico County",
    // LINK zones are context on the county map only when asked for.
    linkZones: "toggle",
  },
  commute: {
    panel: "commute-view",
    legend: ["legend-commute"],
    module: commute,
    title: "Check whether one commute is viable",
    // Always on here: an on-demand zone can be the answer to "no bus reaches me".
    linkZones: "on",
  },
  employer: {
    panel: "employer-view",
    legend: ["legend-employer"],
    module: employer,
    title: "Find staff who cannot reach a worksite",
    linkZones: "on",
  },
  carpool: {
    panel: "carpool-view",
    legend: ["legend-carpool"],
    module: carpoolView,
    title: "Match stranded staff with colleagues who drive",
    linkZones: "off",
  },
};

const VIEW_ORDER = ["access", "commute", "employer", "carpool"];
const SIDEBAR_KEY = "crosstown.sidebar.collapsed";

let currentView = "access";
let started = false;

function setApiStatus(text, ok) {
  const el = document.getElementById("api-status");
  el.textContent = text;
  el.style.color = ok ? "var(--ct-ok)" : "var(--ct-bad)";
  el.style.borderColor = ok
    ? "color-mix(in srgb, var(--ct-ok) 45%, transparent)"
    : "color-mix(in srgb, var(--ct-bad) 45%, transparent)";
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
    if (key !== name) setVisibility(view.module.layers || [], false);
  });

  document.querySelectorAll(".view-tab").forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.style.background = active ? "var(--ct-brand)" : "transparent";
    tab.style.color = active ? "var(--ct-bg)" : "var(--ct-text-muted)";
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  });

  document.getElementById("view-subtitle").textContent = VIEWS[name].title;

  const linkMode = VIEWS[name].linkZones;
  if (linkMode === "on") linkZones.show(true);
  else if (linkMode === "off") linkZones.show(false);
  else linkZones.show(document.getElementById("toggle-link-zones")?.checked ?? false);
  const linkLegend = document.getElementById("legend-link");
  if (linkLegend) linkLegend.classList.toggle("hidden", linkMode === "off");

  if (name === "access") access.restoreLayerVisibility();
  const view = VIEWS[name].module;
  if (typeof view.focus === "function") view.focus();
}

/* ------------------------------------------------------------------ sidebar */

function setSidebar(collapsed) {
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.toggle("ct-collapsed", collapsed);
  const button = document.getElementById("toggle-sidebar");
  button.textContent = collapsed ? "Show panel" : "Hide panel";
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch (_) {
    /* private browsing */
  }
  map.resize();
}

/* ------------------------------------------------------------ keyboard help */

function toggleHelp(force) {
  const dialog = document.getElementById("help-dialog");
  const open = force ?? dialog.classList.contains("hidden");
  dialog.classList.toggle("hidden", !open);
  if (open) dialog.querySelector("button").focus();
}

function wireKeyboard() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing =
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

    if (event.key === "Escape") {
      toggleHelp(false);
      if (typing) target.blur();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key >= "1" && event.key <= "4") {
      showView(VIEW_ORDER[Number(event.key) - 1]);
      event.preventDefault();
    } else if (event.key === "?") {
      toggleHelp();
      event.preventDefault();
    } else if (event.key === "[") {
      setSidebar(!document.getElementById("sidebar").classList.contains("ct-collapsed"));
      event.preventDefault();
    }
  });

  // Arrow keys move between tabs, per the ARIA tablist pattern.
  document.getElementById("view-tabs").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = VIEW_ORDER.indexOf(currentView);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % VIEW_ORDER.length
        : (index - 1 + VIEW_ORDER.length) % VIEW_ORDER.length;
    showView(VIEW_ORDER[next]);
    document.querySelector(`.view-tab[data-view="${VIEW_ORDER[next]}"]`).focus();
    event.preventDefault();
  });
}

/* -------------------------------------------------------------------- start */

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
  await linkZones.init();
  await commute.init();
  await employer.init();
  await carpoolView.init();

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });

  window.addEventListener("crosstown:show-employer", () => showView("employer"));
  window.addEventListener("crosstown:show-carpool", () => showView("carpool"));

  document.getElementById("toggle-sidebar").addEventListener("click", () => {
    setSidebar(!document.getElementById("sidebar").classList.contains("ct-collapsed"));
  });

  const linkToggle = document.getElementById("toggle-link-zones");
  if (linkToggle) {
    linkToggle.addEventListener("change", (event) => {
      if (VIEWS[currentView].linkZones === "toggle") linkZones.show(event.target.checked);
    });
  }

  document.getElementById("help-btn").addEventListener("click", () => toggleHelp());
  document.getElementById("help-close").addEventListener("click", () => toggleHelp(false));
  document.getElementById("help-dialog").addEventListener("click", (event) => {
    if (event.target.id === "help-dialog") toggleHelp(false);
  });

  wireKeyboard();

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch (_) {
    collapsed = false;
  }
  setSidebar(window.innerWidth <= 640 ? true : collapsed);

  showView("access");
  started = true;
}

// Without this, one view failing to initialise leaves the whole shell dead with
// nothing in the console: the tab listeners above never get attached either.
start().catch((err) => {
  console.error("CrossTown failed to start:", err);
  setApiStatus("startup failed", false);
  const banner = document.getElementById("offline-banner");
  banner.querySelector("p").textContent = "CrossTown failed to start";
  banner.querySelectorAll("p")[1].textContent = err && err.message ? err.message : String(err);
  banner.classList.remove("hidden");
});
