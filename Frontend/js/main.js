/** App shell: view switching, keyboard control, API status, shared chrome. */

import { getJSON } from "./api.js";
import { ready, setVisibility, syncPadding } from "./map.js";
import * as access from "./access.js";
import * as commute from "./commute.js";
import * as employer from "./employer.js";
import * as carpoolView from "./carpool.js";
import * as linkZones from "./linkzones.js";
import { hydrateIcons } from "./ui.js";

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

hydrateIcons();

function setApiStatus(text, ok) {
  const el = document.getElementById("api-status");
  el.dataset.state = ok ? "ok" : "bad";
  el.querySelector(".status-text").textContent = text;
  el.title = text;
}

function linkToggleChecked() {
  return document.getElementById("toggle-link-zones")?.checked ?? false;
}

/** The LINK legend follows the zones themselves, not just the view. */
function syncLinkLegend() {
  const mode = VIEWS[currentView].linkZones;
  const visible = mode === "on" || (mode === "toggle" && linkToggleChecked());
  linkZones.show(visible);
  document.getElementById("legend-link")?.classList.toggle("hidden", !visible);
}

function showView(name) {
  if (!VIEWS[name]) return;

  // Leaving a view hides its markers, otherwise a commute pin lingers on the
  // employer map. Each view restores its own when it is shown again.
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
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  });

  document.title = `CrossTown — ${VIEWS[name].title}`;
  document.querySelector(".panel-scroll")?.scrollTo({ top: 0 });

  syncLinkLegend();

  if (name === "access") access.restoreLayerVisibility();
  const view = VIEWS[name].module;
  if (typeof view.focus === "function") view.focus();
}

/* ------------------------------------------------------------------ sidebar */

function setSidebar(collapsed, { remember = true, animate = true } = {}) {
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.toggle("ct-collapsed", collapsed);
  const button = document.getElementById("toggle-sidebar");
  button.setAttribute("aria-label", collapsed ? "Show panel" : "Hide panel");
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  button.setAttribute("aria-pressed", collapsed ? "false" : "true");
  // Only a deliberate toggle is a preference. Collapsing automatically because
  // the window is narrow used to be stored the same way, so opening the app once
  // on a phone left the panel hidden on every later visit from a laptop.
  if (remember) {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch (_) {
      /* private browsing */
    }
  }
  syncPadding(animate);
}

function toggleSidebar() {
  setSidebar(!document.getElementById("sidebar").classList.contains("ct-collapsed"));
}

/* ------------------------------------------------------------ keyboard help */

let helpReturnFocus = null;

function toggleHelp(force) {
  const dialog = document.getElementById("help-dialog");
  const open = force ?? dialog.classList.contains("hidden");
  if (open === !dialog.classList.contains("hidden")) return;
  dialog.classList.toggle("hidden", !open);
  if (open) {
    helpReturnFocus = document.activeElement;
    document.getElementById("help-close").focus();
  } else if (helpReturnFocus && typeof helpReturnFocus.focus === "function") {
    // Hand focus back to whatever opened the sheet.
    helpReturnFocus.focus();
    helpReturnFocus = null;
  }
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
      toggleSidebar();
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
    setApiStatus(`Live · ${health.data_source}`, true);
    const budget = document.getElementById("budget-label");
    if (budget) budget.textContent = health.travel_time_budget_minutes ?? 45;
  } catch (err) {
    setApiStatus("Offline", false);
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

  document.getElementById("toggle-sidebar").addEventListener("click", toggleSidebar);
  document.querySelector(".panel-grabber")?.addEventListener("click", () => setSidebar(true));

  document.getElementById("toggle-link-zones")?.addEventListener("change", syncLinkLegend);

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
  setSidebar(collapsed, { remember: false, animate: false });

  showView("access");
}

// Without this, one view failing to initialise leaves the whole shell dead with
// nothing in the console: the tab listeners above never get attached either.
start().catch((err) => {
  console.error("CrossTown failed to start:", err);
  setApiStatus("Startup failed", false);
  const banner = document.getElementById("offline-banner");
  banner.querySelector(".banner-title").textContent = "CrossTown failed to start";
  banner.querySelector(".banner-body").textContent = err && err.message ? err.message : String(err);
  banner.classList.remove("hidden");
});

// Keep the map's framing honest when the window crosses the phone breakpoint.
window.addEventListener("resize", () => syncPadding(false));
