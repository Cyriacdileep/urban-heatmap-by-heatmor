/* UrbanHeat India — app logic
 * Live data: Open-Meteo forecast API (no key needed, CORS-enabled).
 */
(function () {
  "use strict";

  const API = "https://api.open-meteo.com/v1/forecast";
  const CACHE_MS = 15 * 60 * 1000;
  const GRID_N = 9;            // 9 x 9 sample points around a city
  const GRID_HALF_DEG = 0.27;  // ~30 km either side of the centre
  const HOURS = 24;

  const els = {
    city: document.getElementById("citySelect"),
    locate: document.getElementById("locateBtn"),
    panel: document.getElementById("panelBody"),
    legend: document.getElementById("legend"),
    status: document.getElementById("status"),
    timebar: document.getElementById("timebar"),
    slider: document.getElementById("hourSlider"),
    hourLabel: document.getElementById("hourLabel"),
    play: document.getElementById("playBtn"),
    readout: null
  };

  const state = {
    mode: "india",        // "india" | "city"
    layer: "apparent",    // "apparent" | "temp" | "uv"
    hour: 0,              // offset from the current hour, 0..23
    contrast: false,      // stretch colours to local min-max in city mode
    india: null,          // array of Open-Meteo location objects, aligned with HM.CITIES
    grid: null,           // { locs, lats, lons, bounds, city }
    focus: null,          // { loc, title, subtitle, terrain, lat, lon }
    playing: null,
    reqId: 0
  };

  /* ---------------- helpers ---------------- */
  const $ = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  function heatLevel(apparent) {
    let lvl = HM.HEAT_LEVELS[0];
    if (apparent == null) return lvl;
    for (const l of HM.HEAT_LEVELS) if (apparent >= l.min) lvl = l;
    return lvl;
  }
  function uvLevel(uv) {
    let lvl = HM.UV_LEVELS[0];
    if (uv == null) return lvl;
    const u = Math.round(uv); // UV index is reported as a whole number
    for (const l of HM.UV_LEVELS) if (u >= l.min) lvl = l;
    return lvl;
  }

  /* colour scales */
  const TEMP_STOPS = [[10, "#2c7bb6"], [20, "#5fb3a3"], [27, "#b5dc70"], [32, "#fee08b"], [37, "#fdae61"], [41, "#f46d43"], [46, "#d73027"], [54, "#7b2cbf"]];
  const UV_STOPS = [[0, "#3ea72d"], [3, "#f2d900"], [6, "#f18b00"], [8, "#e53210"], [11, "#8f3f97"], [14, "#6a2c70"]];
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const STOP_CACHE = new Map();
  function colorAt(stops, v) {
    if (!STOP_CACHE.has(stops)) STOP_CACHE.set(stops, stops.map(([s, c]) => [s, hexToRgb(c)]));
    const st = STOP_CACHE.get(stops);
    if (v <= st[0][0]) return st[0][1];
    if (v >= st[st.length - 1][0]) return st[st.length - 1][1];
    for (let i = 1; i < st.length; i++) {
      if (v <= st[i][0]) {
        const [a, ca] = st[i - 1], [b, cb] = st[i];
        const t = (v - a) / (b - a);
        return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * t));
      }
    }
    return st[st.length - 1][1];
  }
  const rgbStr = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const inkFor = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 160 ? "#1b1b1b" : "#fff");

  /* Stull (2011) wet-bulb approximation, valid for RH 5–99 %, T −20…50 °C */
  function wetBulb(T, RH) {
    if (T == null || RH == null) return null;
    const rh = Math.min(99, Math.max(5, RH));
    return T * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(T + rh) - Math.atan(rh - 1.676331) +
      0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  }

  const WEATHER = { 0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail" };

  /* ---------------- data access ---------------- */
  const cache = new Map();
  function forecastUrl(points) {
    const p = new URLSearchParams({
      latitude: points.map((x) => x.lat.toFixed(4)).join(","),
      longitude: points.map((x) => x.lon.toFixed(4)).join(","),
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,is_day,weather_code",
      hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,uv_index",
      daily: "temperature_2m_max,temperature_2m_min,apparent_temperature_max,uv_index_max",
      timezone: "Asia/Kolkata",
      forecast_days: "3"
    });
    return `${API}?${p.toString()}`;
  }
  async function fetchForecast(points) {
    const url = forecastUrl(points);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "The weather service took too long to respond." : "Could not reach the weather service. Check your internet connection.");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw new Error("The weather service is rate-limiting requests. Please try again in a minute.");
    if (!res.ok) {
      let reason = "";
      try { reason = (await res.json()).reason || ""; } catch (_) { /* ignore */ }
      throw new Error(`Weather service error (${res.status}) ${reason}`.trim());
    }
    const json = await res.json();
    const data = Array.isArray(json) ? json : [json];
    data.forEach(prepLoc);
    cache.set(url, { t: Date.now(), data });
    return data;
  }
  function prepLoc(loc) {
    const key = loc.current && loc.current.time ? loc.current.time.slice(0, 13) + ":00" : null;
    let i = key ? loc.hourly.time.indexOf(key) : -1;
    loc._start = i < 0 ? 0 : i;
  }
  function hourly(loc, name, h) {
    const arr = loc.hourly && loc.hourly[name];
    if (!arr) return null;
    const v = arr[loc._start + h];
    return v == null ? null : v;
  }
  function valueAt(loc, layer, h) {
    if (!loc) return null;
    if (layer === "uv") return hourly(loc, "uv_index", h);
    if (h === 0 && loc.current) return layer === "temp" ? loc.current.temperature_2m : loc.current.apparent_temperature;
    return hourly(loc, layer === "temp" ? "temperature_2m" : "apparent_temperature", h);
  }
  function rhAt(loc, h) {
    if (h === 0 && loc.current) return loc.current.relative_humidity_2m;
    return hourly(loc, "relative_humidity_2m", h);
  }
  function timeAt(loc, h) {
    const t = loc && loc.hourly && loc.hourly.time[loc._start + h];
    return t ? new Date(t + ":00+05:30") : null;
  }
  function hourText(d, short) {
    if (!d) return "";
    const now = new Date();
    const ist = (x) => new Date(x.getTime() + (330 + x.getTimezoneOffset()) * 60000);
    const a = ist(d), n = ist(now);
    const sameDay = a.getDate() === n.getDate();
    let hr = a.getHours();
    const ampm = hr >= 12 ? "pm" : "am";
    hr = hr % 12 || 12;
    const t = `${hr} ${ampm}`;
    if (short) return t;
    return `${sameDay ? "Today" : "Tomorrow"} ${t}`;
  }

  /* ---------------- status ---------------- */
  let statusTimer = null;
  function status(msg, kind, retry) {
    clearTimeout(statusTimer);
    els.status.className = "status" + (msg ? " show" : "") + (kind === "error" ? " error" : "");
    els.status.textContent = msg || "";
    if (retry) {
      const b = document.createElement("button");
      b.textContent = "Retry";
      b.onclick = retry;
      els.status.appendChild(b);
    }
    if (kind === "ok") statusTimer = setTimeout(() => status(""), 2500);
  }

  /* ---------------- map ---------------- */
  const map = L.map("map", { zoomControl: true, minZoom: 4, maxZoom: 14, worldCopyJump: false })
    .setView([22.8, 80.5], 5);
  /* Base map: OpenStreetMap tiles (no API key). The tile pane is muted with CSS so
   * the heat colours stand out. If OSM tiles keep failing, switch to Esri's
   * keyless light-grey basemap. */
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  let tileErrors = 0, switched = false;
  osm.on("tileerror", () => {
    if (switched || ++tileErrors < 6) return;
    switched = true;
    map.removeLayer(osm);
    const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
    L.tileLayer(esri + "World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 16, attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors"
    }).addTo(map);
    const labelsPane = map.createPane("labels");
    labelsPane.style.zIndex = 450;
    labelsPane.style.pointerEvents = "none";
    L.tileLayer(esri + "World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels" }).addTo(map);
  });

  const cityLayer = L.layerGroup().addTo(map);
  let overlay = null;
  let clickMarker = null;

  const readout = document.createElement("div");
  readout.className = "readout";
  readout.style.cssText = "position:absolute;z-index:600;pointer-events:none;background:#1d1b18;color:#fff;font-size:12px;padding:4px 8px;border-radius:7px;display:none;white-space:nowrap;font-variant-numeric:tabular-nums";
  document.querySelector(".mapwrap").appendChild(readout);
  els.readout = readout;

  function layerStops() { return state.layer === "uv" ? UV_STOPS : TEMP_STOPS; }
  function layerName() { return { apparent: "Feels like", temp: "Temperature", uv: "UV index" }[state.layer]; }
  function layerUnit() { return state.layer === "uv" ? "" : "°C"; }

  /* India overview markers */
  function drawCityMarkers() {
    cityLayer.clearLayers();
    if (!state.india) return;
    HM.CITIES.forEach((c, i) => {
      const loc = state.india[i];
      const v = valueAt(loc, state.layer, state.hour);
      const col = v == null ? [150, 150, 150] : colorAt(layerStops(), v);
      const size = state.mode === "india" ? 34 : 26;
      const icon = L.divIcon({
        className: "",
        html: `<div class="city-pin" style="width:${size}px;height:${size}px;background:${rgbStr(col)};color:${inkFor(col)}">${v == null ? "?" : Math.round(v)}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
      });
      const m = L.marker([c.lat, c.lon], { icon, keyboard: true, title: c.name, riseOnHover: true });
      const app = valueAt(loc, "apparent", state.hour), tmp = valueAt(loc, "temp", state.hour), uv = valueAt(loc, "uv", state.hour);
      m.bindTooltip(`<strong>${esc(c.name)}</strong><br>${fmt(tmp)}°C · feels ${fmt(app)}°C · UV ${fmt(uv, 1)}<br><em>${heatLevel(app).label}</em>`, { direction: "top", offset: [0, -size / 2] });
      m.on("click", () => goCity(c));
      m.addTo(cityLayer);
    });
  }

  /* City heat grid */
  function buildGrid(city) {
    const halfLon = GRID_HALF_DEG / Math.cos(city.lat * Math.PI / 180);
    const lats = [], lons = [], pts = [];
    for (let r = 0; r < GRID_N; r++) lats.push(city.lat + GRID_HALF_DEG - (2 * GRID_HALF_DEG * r) / (GRID_N - 1));
    for (let c = 0; c < GRID_N; c++) lons.push(city.lon - halfLon + (2 * halfLon * c) / (GRID_N - 1));
    for (let r = 0; r < GRID_N; r++) for (let c = 0; c < GRID_N; c++) pts.push({ lat: lats[r], lon: lons[c] });
    return { lats, lons, pts, bounds: L.latLngBounds([lats[GRID_N - 1], lons[0]], [lats[0], lons[GRID_N - 1]]) };
  }
  function gridValues() {
    const g = state.grid;
    return g.locs.map((l) => valueAt(l, state.layer, state.hour));
  }
  function gridRange(vals) {
    const v = vals.filter((x) => x != null);
    return v.length ? [Math.min(...v), Math.max(...v)] : [0, 1];
  }
  function sampleGrid(vals, fy, fx) {
    // fy, fx in grid units (0..N-1); bilinear with null fallback to nearest
    const N = GRID_N;
    const y0 = Math.max(0, Math.min(N - 1, Math.floor(fy))), x0 = Math.max(0, Math.min(N - 1, Math.floor(fx)));
    const y1 = Math.min(N - 1, y0 + 1), x1 = Math.min(N - 1, x0 + 1);
    const ty = fy - y0, tx = fx - x0;
    const g = (r, c) => vals[r * N + c];
    const a = g(y0, x0), b = g(y0, x1), c = g(y1, x0), d = g(y1, x1);
    if ([a, b, c, d].some((x) => x == null)) return [a, b, c, d].find((x) => x != null) ?? null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  function drawOverlay() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    if (state.mode !== "city" || !state.grid) return;
    const vals = gridValues();
    const [lo, hi] = gridRange(vals);
    const W = 240, H = 240;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    const stops = layerStops();
    const s0 = stops[0][0], s1 = stops[stops.length - 1][0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = sampleGrid(vals, (y / (H - 1)) * (GRID_N - 1), (x / (W - 1)) * (GRID_N - 1));
        const k = (y * W + x) * 4;
        if (v == null) { img.data[k + 3] = 0; continue; }
        if (state.contrast && hi - lo > 0.05) {
          // map local range onto the warm half of the scale so hotspots pop
          const t = (v - lo) / (hi - lo);
          v = state.layer === "uv" ? s0 + t * (s1 - s0) * 0.8 : 27 + t * 24;
        }
        const col = colorAt(stops, v);
        img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2];
        // soft edge fade
        const ex = Math.min(x, W - 1 - x) / 18, ey = Math.min(y, H - 1 - y) / 18;
        img.data[k + 3] = Math.round(255 * Math.min(1, ex, ey));
      }
    }
    ctx.putImageData(img, 0, 0);
    overlay = L.imageOverlay(cv.toDataURL(), state.grid.bounds, { opacity: 0.62, interactive: false }).addTo(map);
  }

  function gridValueAtLatLng(ll) {
    const g = state.grid;
    if (!g || !g.bounds.contains(ll)) return null;
    const fy = ((g.lats[0] - ll.lat) / (g.lats[0] - g.lats[GRID_N - 1])) * (GRID_N - 1);
    const fx = ((ll.lng - g.lons[0]) / (g.lons[GRID_N - 1] - g.lons[0])) * (GRID_N - 1);
    return sampleGrid(gridValues(), fy, fx);
  }

  map.on("mousemove", (e) => {
    if (state.mode !== "city" || !state.grid) { readout.style.display = "none"; return; }
    const v = gridValueAtLatLng(e.latlng);
    if (v == null) { readout.style.display = "none"; return; }
    readout.textContent = `${layerName()}: ${fmt(v, state.layer === "uv" ? 1 : 1)}${layerUnit()} · click for details`;
    readout.style.left = e.containerPoint.x + 14 + "px";
    readout.style.top = e.containerPoint.y + 12 + "px";
    readout.style.display = "block";
  });
  map.on("mouseout", () => { readout.style.display = "none"; });

  map.on("click", (e) => {
    if (state.mode !== "city") return;
    inspectPoint(e.latlng.lat, e.latlng.lng, "Selected spot", null);
  });

  /* ---------------- legend ---------------- */
  function drawLegend() {
    const stops = layerStops();
    const s0 = stops[0][0], s1 = stops[stops.length - 1][0];
    const grad = stops.map(([s, c]) => `${c} ${(((s - s0) / (s1 - s0)) * 100).toFixed(1)}%`).join(",");
    let zones = "";
    if (state.layer === "uv") {
      zones = HM.UV_LEVELS.map((l, i) => {
        const nx = HM.UV_LEVELS[i + 1];
        return `<span><i style="background:${l.color}"></i>${nx ? `${l.min}–${nx.min - 1}` : `${l.min}+`} ${l.label}</span>`;
      }).join("");
    } else {
      zones = HM.HEAT_LEVELS.map((l, i) => {
        const nx = HM.HEAT_LEVELS[i + 1];
        const rng = i === 0 ? `&lt;${nx.min}°` : nx ? `${l.min}–${nx.min}°` : `${l.min}°+`;
        return `<span><i style="background:${l.color}"></i>${rng} ${l.label}</span>`;
      }).join("");
      if (state.layer === "temp") zones = `<span class="note">Zones are set by the “feels like” temperature.</span>`;
    }
    let contrast = "";
    if (state.mode === "city") {
      contrast = `<label style="display:flex;gap:6px;align-items:center;margin-top:8px;cursor:pointer"><input type="checkbox" id="contrastChk" ${state.contrast ? "checked" : ""}> Highlight local hotspots</label>`;
      if (state.grid) {
        const [lo, hi] = gridRange(gridValues());
        contrast += `<div class="note" style="margin-top:4px">Across this area: ${fmt(lo, 1)}–${fmt(hi, 1)}${layerUnit()}</div>`;
      }
    }
    els.legend.innerHTML = `<h4>${layerName()}${layerUnit() ? " (°C)" : ""}</h4>
      <div class="bar" style="background:linear-gradient(90deg,${grad})"></div>
      <div class="ticks"><span>${s0}</span><span>${Math.round((s0 + s1) / 2)}</span><span>${s1}${state.layer === "uv" ? "+" : ""}</span></div>
      ${state.mode === "city" && state.contrast ? `<div class="note" style="margin-top:4px">Colours stretched to this area's range.</div>` : ""}
      <div class="zones">${zones}</div>${contrast}`;
    const chk = document.getElementById("contrastChk");
    if (chk) chk.onchange = () => { state.contrast = chk.checked; drawOverlay(); drawLegend(); };
  }

  /* ---------------- panel ---------------- */
  let chart = null;
  function destroyChart() { if (chart) { chart.destroy(); chart = null; } }

  function panelLoading(title) {
    destroyChart();
    els.panel.innerHTML = `<p class="eyebrow">Loading live data</p><h2 class="place">${esc(title)}</h2>
      <div class="skeleton" style="height:90px"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div><div class="skeleton" style="height:160px"></div>`;
  }

  function renderIndiaPanel() {
    destroyChart();
    if (!state.india) return;
    const h = state.hour;
    const t = timeAt(state.india[0], h);
    const rows = HM.CITIES.map((c, i) => ({ c, loc: state.india[i], v: valueAt(state.india[i], state.layer, h), uv: valueAt(state.india[i], "uv", h), app: valueAt(state.india[i], "apparent", h) }))
      .sort((a, b) => (b.v ?? -99) - (a.v ?? -99));
    const counts = {};
    rows.forEach((r) => { const l = heatLevel(r.app); counts[l.id] = (counts[l.id] || 0) + 1; });
    const summary = HM.HEAT_LEVELS.filter((l) => counts[l.id]).map((l) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;margin:0 10px 4px 0;font-size:13px"><i style="width:10px;height:10px;border-radius:3px;background:${l.color};display:inline-block"></i>${counts[l.id]} ${l.label.toLowerCase()}</span>`).join("");

    els.panel.innerHTML = `
      <p class="eyebrow">${h === 0 ? "Right now" : "Forecast"} · ${esc(hourText(t))}</p>
      <h2 class="place">All of India</h2>
      <p class="sub">${HM.CITIES.length} cities · sorted by ${layerName().toLowerCase()} · tap a city to see its heat map</p>
      <div style="margin-bottom:10px">${summary}</div>
      <ul class="rank" id="rankList">
        ${rows.map((r) => {
          const col = r.v == null ? [160, 160, 160] : colorAt(layerStops(), r.v);
          return `<li data-city="${esc(r.c.name)}" tabindex="0" role="button" aria-label="Open ${esc(r.c.name)}">
            <span class="dot" style="background:${rgbStr(col)}"></span>
            <span class="nm">${esc(r.c.name)} <span class="note">${esc(r.c.state)}</span></span>
            <span class="val">${fmt(r.v, state.layer === "uv" ? 1 : 0)}${layerUnit()}</span>
            <span class="uvv">${state.layer === "uv" ? fmt(r.app, 0) + "°C" : "UV " + fmt(r.uv, 0)}</span>
          </li>`;
        }).join("")}
      </ul>
      <h3 class="sec">What the heat zones mean</h3>
      ${HM.HEAT_LEVELS.map((l, i) => {
        const nx = HM.HEAT_LEVELS[i + 1];
        const rng = i === 0 ? `below ${nx.min}°C` : nx ? `${l.min}–${nx.min}°C` : `${l.min}°C and above`;
        return `<details class="acc"><summary><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${l.color};margin-right:6px"></i>${l.label} <span class="note">feels like ${rng}</span></span></summary>
          <p class="who">${esc(l.summary)}</p><ul class="tips">${l.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>`;
      }).join("")}
      ${emergencyBlock()}
      ${aboutBlock()}`;
    els.panel.querySelectorAll("#rankList li").forEach((li) => {
      const go = () => goCity(HM.CITIES.find((c) => c.name === li.dataset.city));
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function imdBlock(loc, terrain) {
    const d = loc.daily;
    if (!d || !d.temperature_2m_max) return "";
    const tmax = d.temperature_2m_max[0], tmax2 = d.temperature_2m_max[1];
    const rule = HM.IMD[terrain] || HM.IMD.plains;
    const terrainName = { plains: "plains", coastal: "coastal", hilly: "hill" }[terrain] || "plains";
    let hit = false, line;
    if (terrain === "plains" && tmax >= rule.severe) { hit = true; line = `Today's forecast maximum of ${fmt(tmax, 1)}°C is at IMD's <b>severe heatwave</b> level (47°C or more).`; }
    else if (terrain === "plains" && tmax >= rule.heatwave) { hit = true; line = `Today's forecast maximum of ${fmt(tmax, 1)}°C is at IMD's <b>heatwave</b> level (45°C or more).`; }
    else if (tmax >= rule.threshold) { hit = true; line = `Today's forecast maximum of ${fmt(tmax, 1)}°C crosses the ${rule.threshold}°C threshold IMD uses for ${terrainName} stations. IMD calls it a heatwave when the temperature is also 4.5°C or more above normal.`; }
    else { line = `Today's forecast maximum is ${fmt(tmax, 1)}°C, below the ${rule.threshold}°C heatwave threshold IMD uses for ${terrainName} stations.`; }
    return `<div class="imd ${hit ? "hit" : ""}"><strong>IMD heatwave check</strong>${line}
      Tomorrow: ${fmt(tmax2, 1)}°C.<br><span class="note">Indicator only. IMD declares a heatwave when its criteria hold at two or more stations for two consecutive days. See <a href="https://mausam.imd.gov.in/" target="_blank" rel="noopener">IMD</a> for official warnings.</span></div>`;
  }

  function renderPointPanel() {
    const f = state.focus;
    if (!f || !f.loc) return;
    const loc = f.loc, h = state.hour;
    const t = timeAt(loc, h);
    const temp = valueAt(loc, "temp", h), app = valueAt(loc, "apparent", h), uv = valueAt(loc, "uv", h), rh = rhAt(loc, h);
    const lvl = heatLevel(app);
    const uvPeak = loc.daily && loc.daily.uv_index_max ? loc.daily.uv_index_max[0] : null;
    // UV precautions follow the higher of the selected hour and the rest of today's peak
    const uvForAdvice = Math.max(uv ?? 0, uvPeak ?? 0);
    const uvl = uvLevel(uv), uvlAdvice = uvLevel(uvForAdvice);
    const tw = wetBulb(temp, rh);
    const isNight = h === 0 && loc.current && loc.current.is_day === 0;
    const wx = h === 0 && loc.current ? WEATHER[loc.current.weather_code] : null;

    // cumulative heat actions: this level first, then the basics from lower levels
    const idx = HM.HEAT_LEVELS.indexOf(lvl);
    const basics = [];
    for (let i = idx - 1; i >= 1; i--) HM.HEAT_LEVELS[i].actions.forEach((a) => basics.push(a));

    destroyChart();
    els.panel.innerHTML = `
      <p class="eyebrow">${h === 0 ? "Right now" : "Forecast"} · ${esc(hourText(t))}${wx ? " · " + esc(wx) : ""}</p>
      <h2 class="place">${esc(f.title)}</h2>
      <p class="sub">${esc(f.subtitle || "")}</p>

      <div class="zone-card" style="background:${lvl.color};color:${lvl.ink}">
        <div class="zlabel">Heat zone</div>
        <div class="zname">${esc(lvl.label)}</div>
        <p>${esc(lvl.summary)}</p>
      </div>

      <div class="stats">
        <div class="stat"><div class="k">Temperature</div><div class="v">${fmt(temp, 1)}<small>°C</small></div></div>
        <div class="stat"><div class="k">Feels like</div><div class="v">${fmt(app, 1)}<small>°C</small></div></div>
        <div class="stat"><div class="k">Humidity</div><div class="v">${fmt(rh)}<small>%</small></div></div>
        <div class="stat"><div class="k">UV index</div><div class="v">${fmt(uv, 1)}</div><span class="uv-chip" style="background:${uvl.color};color:${uvl.ink}">${esc(uvl.label)}</span></div>
        <div class="stat"><div class="k">Today's peak UV</div><div class="v">${fmt(uvPeak, 1)}</div><span class="uv-chip" style="background:${uvLevel(uvPeak).color};color:${uvLevel(uvPeak).ink}">${esc(uvLevel(uvPeak).label)}</span></div>
        <div class="stat" title="Wet-bulb temperature combines heat and humidity. Above about 31°C, even fit people struggle to cool down during activity."><div class="k">Wet-bulb (approx.)</div><div class="v">${fmt(tw, 1)}<small>°C</small></div></div>
      </div>
      ${isNight ? `<p class="note" style="margin-top:-6px">The sun is down, so the UV index is 0 now. Sun-safety advice below is for today's peak.</p>` : ""}

      ${imdBlock(loc, f.terrain)}

      <h3 class="sec">Next 24 hours</h3>
      <div class="chart-box"><canvas id="hourChart" aria-label="Hourly temperature, feels-like and UV forecast"></canvas></div>

      <h3 class="sec">What to do in this zone</h3>
      <ul class="tips">${lvl.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
      ${basics.length ? `<details class="acc" style="margin-top:8px"><summary>Keep following the basics</summary><ul class="tips">${basics.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>` : ""}

      <h3 class="sec">Sun safety · UV ${esc(uvlAdvice.label.toLowerCase())}${uvPeak != null ? ` (peak ${fmt(uvPeak, 0)} today)` : ""}</h3>
      <ul class="tips">${uvlAdvice.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>

      <h3 class="sec">If you are at higher risk</h3>
      ${HM.GROUPS.map((g) => `<details class="acc"><summary>${esc(g.title)}</summary><p class="who">${esc(g.who)}</p><ul class="tips">${g.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>`).join("")}

      <details class="acc" ${lvl.min >= 41 ? "open" : ""}><summary>Heatstroke: signs and first aid</summary>
        <p class="who">Warning signs</p><ul class="tips">${HM.HEATSTROKE.signs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <p class="who">What to do</p><ul class="tips">${HM.HEATSTROKE.firstAid.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </details>

      ${state.mode === "city" && state.grid ? hotspotBlock() : ""}
      ${emergencyBlock()}
      ${aboutBlock()}`;

    drawChart(loc);
    bindHotspots();
  }

  function drawChart(loc) {
    const cv = document.getElementById("hourChart");
    if (!cv || typeof Chart === "undefined") return;
    const labels = [], tt = [], aa = [], uu = [];
    for (let h = 0; h < HOURS; h++) {
      labels.push(h === 0 ? "Now" : hourText(timeAt(loc, h), true));
      tt.push(valueAt(loc, "temp", h));
      aa.push(valueAt(loc, "apparent", h));
      uu.push(valueAt(loc, "uv", h));
    }
    const sel = state.hour;
    chart = new Chart(cv, {
      data: {
        labels,
        datasets: [
          { type: "line", label: "Feels like °C", data: aa, borderColor: "#d9282f", backgroundColor: "#d9282f", tension: 0.35, pointRadius: (c) => (c.dataIndex === sel ? 4 : 0), borderWidth: 2, yAxisID: "y" },
          { type: "line", label: "Temperature °C", data: tt, borderColor: "#f08c00", backgroundColor: "#f08c00", borderDash: [4, 3], tension: 0.35, pointRadius: 0, borderWidth: 2, yAxisID: "y" },
          { type: "bar", label: "UV index", data: uu, backgroundColor: uu.map((v) => uvLevel(v).color + "cc"), yAxisID: "y2", barPercentage: 0.9, categoryPercentage: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw == null ? "–" : Number(c.raw).toFixed(1)}` } }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
          y: { position: "left", ticks: { font: { size: 10 } }, title: { display: true, text: "°C", font: { size: 10 } } },
          y2: { position: "right", min: 0, suggestedMax: 12, grid: { display: false }, ticks: { font: { size: 10 } }, title: { display: true, text: "UV", font: { size: 10 } } }
        },
        onClick: (_, el) => { if (el && el.length) setHour(el[0].index); }
      }
    });
  }

  function offsetText(lat, lon, c) {
    const R = 6371, toR = Math.PI / 180;
    const dy = (lat - c.lat) * toR * R, dx = (lon - c.lon) * toR * R * Math.cos(c.lat * toR);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1.5) return "near the centre";
    const ang = (Math.atan2(dx, dy) / toR + 360) % 360;
    const dirs = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    return `~${Math.round(dist)} km ${dirs[Math.round(ang / 45) % 8]} of centre`;
  }
  function hotspotBlock() {
    const g = state.grid;
    const vals = g.locs.map((l, i) => ({ i, v: valueAt(l, "apparent", state.hour), lat: g.pts[i].lat, lon: g.pts[i].lon }))
      .filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    if (!vals.length) return "";
    const hot = vals.slice(0, 3), cool = vals[vals.length - 1];
    const row = (x, tag) => {
      const l = heatLevel(x.v);
      return `<li data-lat="${x.lat}" data-lon="${x.lon}" tabindex="0" role="button"><span class="dot" style="background:${l.color}"></span><span class="nm">${tag} <span class="note">${offsetText(x.lat, x.lon, g.city)}</span></span><span class="val">${fmt(x.v, 1)}°C</span></li>`;
    };
    return `<h3 class="sec">Hotspots around ${esc(g.city.name)}</h3>
      <ul class="rank" id="hotList">${hot.map((x, k) => row(x, `Hotspot ${k + 1}`)).join("")}${row(cool, "Coolest area")}</ul>
      <p class="note">Feels-like temperature across ${GRID_N * GRID_N} forecast points covering about 60 × 60 km. Tap a row to inspect it.</p>`;
  }
  function bindHotspots() {
    els.panel.querySelectorAll("#hotList li").forEach((li) => {
      const go = () => {
        const lat = +li.dataset.lat, lon = +li.dataset.lon;
        map.panTo([lat, lon]);
        inspectPoint(lat, lon, li.querySelector(".nm").firstChild.textContent.trim(), null);
      };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function emergencyBlock() {
    return `<div class="emergency">Heat emergency? Call <strong>108</strong> for an ambulance, or <strong>112</strong>.</div>`;
  }
  function aboutBlock() {
    return `<details class="acc" style="margin-top:14px"><summary>About this data</summary>
      <p class="note">Live readings and forecasts come from the free Open-Meteo API, which blends national weather-service models (resolution about 2–11 km). The map shows how heat varies across a city at that scale. Street-level differences, such as a concrete market versus a park, need satellite surface-temperature data and are not shown.
      Zones use the “feels like” temperature, which combines air temperature, humidity and wind, with the standard heat-index bands. UV categories follow the WHO Global Solar UV Index. Precautions are adapted from India's NDMA heatwave guidance.
      Data refreshes every 15 minutes. This site does not issue official warnings.</p>
      <ul class="tips">${HM.SOURCES.map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul></details>`;
  }

  function renderPanel() {
    if (state.mode === "india") renderIndiaPanel();
    else renderPointPanel();
  }

  /* ---------------- flows ---------------- */
  let indiaInFlight = null;
  function loadIndia() {
    if (!indiaInFlight) indiaInFlight = loadIndiaOnce().finally(() => { indiaInFlight = null; });
    return indiaInFlight;
  }
  async function loadIndiaOnce() {
    status("Loading live data for " + HM.CITIES.length + " cities…");
    try {
      const data = await fetchForecast(HM.CITIES);
      state.india = data;
      els.timebar.hidden = false;
      drawCityMarkers();
      if (state.mode === "india") renderIndiaPanel();
      if (state.mode !== "city" || state.grid) status("Live data loaded", "ok");
    } catch (e) {
      state.india = null;
      status(e.message, "error", loadIndia);
      if (state.mode === "india") els.panel.innerHTML = `<h2 class="place">Couldn't load live data</h2><p class="sub">${esc(e.message)}</p>${emergencyBlock()}`;
    }
  }

  function goIndia(push = true) {
    state.mode = "india";
    state.grid = null;
    state.focus = null;
    if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
    els.city.value = "";
    drawOverlay();
    drawLegend();
    map.flyTo([22.8, 80.5], 5, { duration: 0.8 });
    if (push) setHash("");
    if (state.india) { drawCityMarkers(); renderIndiaPanel(); } else loadIndia();
  }

  async function goCity(city, push = true) {
    if (!city) return goIndia(push);
    state.mode = "city";
    state.contrast = false;
    els.city.value = city.name;
    if (push) setHash("city-" + slug(city.name));
    if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
    const g = buildGrid(city);
    g.city = city;
    map.flyToBounds(g.bounds, { duration: 0.8, padding: [10, 10] });
    panelLoading(city.name);
    if (!state.india) loadIndia(); else drawCityMarkers();
    drawLegend();
    const id = ++state.reqId;
    status(`Loading heat map for ${city.name}…`);
    try {
      const locs = await fetchForecast(g.pts);
      if (id !== state.reqId) return;
      g.locs = locs;
      state.grid = g;
      els.timebar.hidden = false;
      const centre = locs[Math.floor((GRID_N * GRID_N) / 2)];
      state.focus = { loc: centre, title: city.name, subtitle: `${city.state} · city centre · tap anywhere on the map to check another spot`, terrain: city.terrain, lat: city.lat, lon: city.lon };
      drawOverlay();
      drawLegend();
      renderPointPanel();
      status("Heat map ready", "ok");
    } catch (e) {
      if (id !== state.reqId) return;
      status(e.message, "error", () => goCity(city, false));
      els.panel.innerHTML = `<h2 class="place">${esc(city.name)}</h2><p class="sub">Couldn't load live data: ${esc(e.message)}</p>${emergencyBlock()}`;
    }
  }

  function nearestCity(lat, lon) {
    let best = HM.CITIES[0], bd = Infinity;
    HM.CITIES.forEach((c) => { const d = (c.lat - lat) ** 2 + ((c.lon - lon) * Math.cos(lat * Math.PI / 180)) ** 2; if (d < bd) { bd = d; best = c; } });
    return best;
  }

  async function inspectPoint(lat, lon, title, subtitle) {
    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="click-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(map);
    const near = nearestCity(lat, lon);
    const base = state.grid ? state.grid.city : near;
    panelLoading(title);
    const id = ++state.reqId;
    try {
      const [loc] = await fetchForecast([{ lat, lon }]);
      if (id !== state.reqId) return;
      state.focus = {
        loc, title, lat, lon, terrain: base.terrain,
        subtitle: subtitle || `${offsetText(lat, lon, base)} ${base.name} · ${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`
      };
      renderPointPanel();
    } catch (e) {
      if (id !== state.reqId) return;
      status(e.message, "error", () => inspectPoint(lat, lon, title, subtitle));
      els.panel.innerHTML = `<h2 class="place">${esc(title)}</h2><p class="sub">Couldn't load live data: ${esc(e.message)}</p>${emergencyBlock()}`;
    }
  }

  function setHour(h) {
    state.hour = Math.max(0, Math.min(HOURS - 1, h));
    els.slider.value = state.hour;
    const ref = (state.focus && state.focus.loc) || (state.india && state.india[0]);
    els.hourLabel.textContent = state.hour === 0 ? "Now" : hourText(timeAt(ref, state.hour));
    drawCityMarkers();
    drawOverlay();
    drawLegend();
    renderPanel();
  }

  function setLayer(layer) {
    state.layer = layer;
    document.querySelectorAll(".seg button").forEach((b) => {
      const on = b.dataset.layer === layer;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    drawCityMarkers();
    drawOverlay();
    drawLegend();
    if (state.mode === "india") renderIndiaPanel();
  }

  /* hash routing: #city-delhi */
  function setHash(h) {
    try { history.replaceState(null, "", h ? "#" + h : location.pathname + location.search); } catch (_) { location.hash = h; }
  }
  function routeFromHash() {
    const h = (location.hash || "").slice(1);
    if (h.startsWith("city-")) {
      const c = HM.CITIES.find((x) => "city-" + slug(x.name) === h);
      if (c) return goCity(c, false);
    }
    goIndia(false);
  }

  /* ---------------- wiring ---------------- */
  HM.CITIES.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.name; o.textContent = `${c.name}, ${c.state}`;
    els.city.appendChild(o);
  });
  els.city.addEventListener("change", () => {
    const c = HM.CITIES.find((x) => x.name === els.city.value);
    c ? goCity(c) : goIndia();
  });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layer)));
  els.slider.addEventListener("input", () => setHour(+els.slider.value));
  els.play.addEventListener("click", () => {
    if (state.playing) { clearInterval(state.playing); state.playing = null; els.play.textContent = "▶"; return; }
    els.play.textContent = "❚❚";
    state.playing = setInterval(() => setHour((state.hour + 1) % HOURS), 900);
  });
  els.locate.addEventListener("click", () => {
    if (!navigator.geolocation) return status("Your browser can't share its location.", "error");
    status("Finding your location…");
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const inIndia = lat > 6 && lat < 37.6 && lon > 68 && lon < 97.5;
      const near = nearestCity(lat, lon);
      status(inIndia ? "" : "You seem to be outside India. Showing your spot anyway.", inIndia ? "ok" : "error");
      const pseudo = { name: "Your area", state: `near ${near.name}`, lat, lon, terrain: near.terrain };
      goCity(pseudo).then(() => {
        if (state.focus) { state.focus.title = "Your location"; state.focus.subtitle = `Near ${near.name} · ${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`; renderPointPanel(); }
      });
      els.city.value = "";
      setHash("");
    }, (err) => {
      status(err.code === 1 ? "Location permission was denied. Pick a city from the list instead." : "Couldn't get your location. Pick a city from the list instead.", "error");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
  window.addEventListener("hashchange", routeFromHash);

  // refresh live data every 15 minutes
  setInterval(() => {
    cache.clear();
    state.india = null;
    loadIndia().then(() => { if (state.mode === "city" && state.grid) goCity(state.grid.city, false); });
  }, CACHE_MS);

  drawLegend();
  routeFromHash();
})();
