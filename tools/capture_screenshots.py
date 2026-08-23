"""Capture presentation screenshots of every CrossTown feature.

Drives the real app in Chrome at 2x, so the images are crisp enough to project.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path("/Users/adamyasingh/Desktop/CrossTown-screenshots")
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://127.0.0.1:5500/index.html"

shots = []

def settle(pg, extra=2200):
    """Wait until the map has finished drawing, then let animations land."""
    pg.evaluate("""() => new Promise(r => {
      const m = window.__crosstown && window.__crosstown.map;
      if (!m) return r();
      if (m.loaded()) return r();
      m.once('idle', r);
      setTimeout(r, 7000);
    })""")
    pg.wait_for_timeout(extra)

def shot(pg, name, caption):
    path = OUT / f"{name}.png"
    pg.screenshot(path=str(path))
    shots.append((path.name, caption))
    print(f"  ✓ {path.name:34} {caption}")

def tab(pg, view):
    pg.click(f'.view-tab[data-view="{view}"]')
    pg.wait_for_timeout(700)

def scroll_panel(pg, y):
    pg.evaluate(f"document.getElementById('sidebar').scrollTop = {y}")
    pg.wait_for_timeout(500)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    ctx = browser.new_context(viewport={"width": 1512, "height": 945}, device_scale_factor=2)
    pg = ctx.new_page()
    # Make sure the panel starts open regardless of any stored preference.
    pg.add_init_script("try{localStorage.removeItem('crosstown.sidebar.collapsed')}catch(e){}")
    pg.goto(URL, wait_until="load")
    pg.wait_for_selector("#api-status", timeout=20000)
    pg.wait_for_function("() => document.querySelector('#api-status').textContent.includes('API ok')", timeout=30000)
    pg.wait_for_function("() => window.__crosstown !== undefined", timeout=20000)
    settle(pg, 3000)

    print("ACCESS MAP")
    shot(pg, "01-access-map", "County-wide transit access grid, 130 scored nodes")

    pg.wait_for_function("() => !document.querySelector('#stats-panel').textContent.includes('Loading')", timeout=20000)
    pg.check("#toggle-census"); settle(pg, 1800)
    shot(pg, "02-access-carfree-households", "Census car-free households overlay (ACS B25044)")
    pg.uncheck("#toggle-census"); pg.wait_for_timeout(500)

    pg.check("#toggle-destinations"); settle(pg, 1800)
    shot(pg, "03-access-amenities", "437 amenity destinations by category")
    pg.uncheck("#toggle-destinations"); pg.wait_for_timeout(500)

    pg.check("#toggle-link-zones"); settle(pg, 2000)
    shot(pg, "04-access-link-zones", "GRTC LINK on-demand zones — absent from the GTFS feed")
    pg.uncheck("#toggle-link-zones"); pg.wait_for_timeout(500)

    # Click a grid node to show the score breakdown
    pg.evaluate("""() => {
      const m = window.__crosstown.map;
      const f = m.getSource('access-grid-source')._data.features.find(x => x.properties.id === 36);
      const pt = m.project(f.geometry.coordinates);
      const cc = m.getCanvasContainer();
      const r = m.getCanvas().getBoundingClientRect();
      const sx = r.width / m.getCanvas().clientWidth, sy = r.height / m.getCanvas().clientHeight;
      const cx = r.left + pt.x * sx, cy = r.top + pt.y * sy;
      for (const t of ['mousedown','mouseup','click'])
        cc.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, clientX:cx, clientY:cy, button:0}));
    }""")
    settle(pg, 1500)
    shot(pg, "05-access-node-detail", "Clicking a zone: composite score and category breakdown")

    print("COMMUTE CHECK")
    tab(pg, "commute")
    pg.fill("#commute-origin", "Highland Springs")
    pg.select_option("#commute-worksite-preset", "2")   # Downtown Richmond
    pg.click("#commute-check-btn")
    pg.wait_for_selector("#commute-result .ct-pill", timeout=45000)
    settle(pg, 2200)
    shot(pg, "06-commute-works", "A commute that works: routed live on the GRTC schedule")
    scroll_panel(pg, 780)
    shot(pg, "07-commute-itinerary", "Leg-by-leg itinerary, both directions, with cost comparison")

    scroll_panel(pg, 0)
    pg.fill("#commute-origin", "Downtown Richmond")
    pg.select_option("#commute-worksite-preset", "0")   # Innsbrook
    pg.click("#commute-check-btn")
    pg.wait_for_function("() => document.querySelector('#commute-result .ct-pill')", timeout=45000)
    settle(pg, 2200)
    shot(pg, "08-commute-no-service", "Innsbrook: no bus stop within 1.4 km — unreachable at any hour")

    scroll_panel(pg, 0)
    pg.fill("#commute-origin", "Varina")
    pg.select_option("#commute-worksite-preset", "4")   # Richmond Intl Airport
    pg.click("#commute-check-btn")
    pg.wait_for_function("() => document.querySelector('#commute-result .ct-pill')", timeout=45000)
    settle(pg, 2200)
    shot(pg, "09-commute-link-on-demand", "Varina: no fixed route, but LINK covers it door to door, free")
    scroll_panel(pg, 700)
    shot(pg, "10-commute-link-detail", "LINK booking details, hours, connecting routes and fare")

    print("EMPLOYER REPORT")
    tab(pg, "employer")
    pg.click("#employer-load-roster")
    pg.wait_for_function("() => !document.querySelector('#employer-analyse').disabled", timeout=30000)
    pg.select_option("#employer-worksite-preset", "1")  # Short Pump
    pg.click("#employer-analyse")
    pg.wait_for_selector("#employer-export", timeout=90000)
    settle(pg, 2500)
    shot(pg, "11-employer-gap-report", "59 of 60 staff cannot reach this worksite on transit")
    scroll_panel(pg, 620)
    shot(pg, "12-employer-reasons", "Why transit fails, and carpool seed zones")
    pg.evaluate("() => { const d = document.querySelector('#employer-result details'); if (d) d.open = true; }")
    scroll_panel(pg, 1000)
    pg.wait_for_timeout(600)
    shot(pg, "13-employer-per-employee", "Per-employee verdicts, exportable as CSV")

    print("CARPOOL PLANNER")
    tab(pg, "carpool")
    scroll_panel(pg, 0)
    pg.click("#carpool-build")
    pg.wait_for_selector("#carpool-export", timeout=120000)
    settle(pg, 3000)
    shot(pg, "14-carpool-plan", "Carpools routed on real roads — 24 of 26 riders matched")
    scroll_panel(pg, 640)
    shot(pg, "15-carpool-pools", "Each pool: pickup order, times, and the driver's detour")

    print("CHROME")
    tab(pg, "access")
    pg.click("#help-btn")
    pg.wait_for_timeout(900)
    shot(pg, "16-help-dialog", "Built-in guide and keyboard shortcuts")
    pg.click("#help-close")
    pg.wait_for_timeout(500)

    ctx.close()

    # Mobile
    mctx = browser.new_context(viewport={"width": 430, "height": 860}, device_scale_factor=3, is_mobile=True, has_touch=True)
    mp = mctx.new_page()
    mp.add_init_script("try{localStorage.removeItem('crosstown.sidebar.collapsed')}catch(e){}")
    mp.goto(URL, wait_until="load")
    mp.wait_for_function("() => document.querySelector('#api-status').textContent.includes('API ok')", timeout=30000)
    mp.wait_for_function("() => window.__crosstown !== undefined", timeout=20000)
    settle(mp, 3000)
    shot(mp, "17-mobile-responsive", "Responsive layout at phone width")
    mctx.close()

    # API docs — useful for showing the engineering behind it
    actx = browser.new_context(viewport={"width": 1512, "height": 945}, device_scale_factor=2)
    ap = actx.new_page()
    ap.goto("http://127.0.0.1:8000/docs", wait_until="load")
    ap.wait_for_timeout(3500)
    shot(ap, "18-api-docs", "The 14-endpoint API behind the interface")
    actx.close()
    browser.close()

print(f"\n{len(shots)} screenshots -> {OUT}")
