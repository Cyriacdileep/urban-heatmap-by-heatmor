/* UrbanHeat India — app logic
 * Live data: Open-Meteo forecast API. Heat history: NASA POWER daily point API.
 * Both are free, need no key and allow browser (CORS) requests.
 */
(function () {
  "use strict";

  const API = "https://api.open-meteo.com/v1/forecast";
  const POWER = "https://power.larc.nasa.gov/api/temporal/daily/point";
  const HISTORY_START = "19900101";
  const CACHE_MS = 15 * 60 * 1000;
  const GRID_N = 9;            // 9 x 9 sample points around a city
  const GRID_HALF_DEG = 0.27;  // ~30 km either side of the centre
  const HOURS = 24;
  const OV = 400;              // overlay canvas size in pixels (~0.15 km per pixel)

  const els = {
    city: document.getElementById("citySelect"),
    locate: document.getElementById("locateBtn"),
    panel: document.getElementById("panelBody"),
    aside: document.getElementById("panel"),
    legend: document.getElementById("legend"),
    status: document.getElementById("status"),
    timebar: document.getElementById("timebar"),
    slider: document.getElementById("hourSlider"),
    hourLabel: document.getElementById("hourLabel"),
    play: document.getElementById("playBtn"),
    simbar: document.getElementById("simbar"),
    simMeter: document.getElementById("simMeter")
  };

  const state = {
    mode: "india",        // "india" | "city"
    layer: "apparent",    // "apparent" | "temp" | "uv"
    hour: 0,              // offset from the current hour, 0..23
    contrast: false,      // stretch colours to local min-max in city mode
    india: null,          // Open-Meteo location objects, aligned with HM.CITIES
    grid: null,           // { locs, lats, lons, pts, bounds, city }
    focus: null,          // { loc, title, subtitle, terrain, lat, lon }
    playing: null,
    reqId: 0,
    tool: null,           // null | "tree" | "roof"
    features: [],         // planted trees / cool roofs: { type, lat, lon, grow, marker }
    histTab: "year",      // "year" | "decades"
    history: {},          // key -> { status, data, error }
    basemap: "map",       // "map" | "sat"
    sat: { kind: "day", period: "latest", dates: {}, opacity: 0.7, cityVals: {}, analyses: {} }
  };

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const dateText = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

  function heatLevel(apparent) {
    let lvl = HM.HEAT_LEVELS[0];
    if (apparent == null) return lvl;
    for (const l of HM.HEAT_LEVELS) if (apparent >= l.min) lvl = l;
    return lvl;
  }
  function uvLevel(uv) {
    let lvl = HM.UV_LEVELS[0];
    if (uv == null) return lvl;
    const u = Math.round(uv); // the UV index is reported as a whole number
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
        return [Math.round(ca[0] + (cb[0] - ca[0]) * t), Math.round(ca[1] + (cb[1] - ca[1]) * t), Math.round(ca[2] + (cb[2] - ca[2]) * t)];
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
  async function getJSON(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
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
    return res.json();
  }
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
    const json = await getJSON(url);
    const data = Array.isArray(json) ? json : [json];
    data.forEach(prepLoc);
    cache.set(url, { t: Date.now(), data });
    return data;
  }
  function prepLoc(loc) {
    const key = loc.current && loc.current.time ? loc.current.time.slice(0, 13) + ":00" : null;
    const i = key ? loc.hourly.time.indexOf(key) : -1;
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
  function isDayAt(loc, h) {
    if (!loc) return true;
    if (h === 0 && loc.current && loc.current.is_day != null) return loc.current.is_day === 1;
    const t = timeAt(loc, h);
    const hr = t ? istParts(t).h : 12;
    return hr >= 6 && hr < 18;
  }
  function timeAt(loc, h) {
    const t = loc && loc.hourly && loc.hourly.time[loc._start + h];
    return t ? new Date(t + ":00+05:30") : null;
  }
  function istParts(d) {
    const x = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
    return { y: x.getFullYear(), m: x.getMonth(), d: x.getDate(), h: x.getHours() };
  }
  function hourText(d, short) {
    if (!d) return "";
    const a = istParts(d), n = istParts(new Date());
    const hr = a.h % 12 || 12, ampm = a.h >= 12 ? "pm" : "am";
    const t = `${hr} ${ampm}`;
    if (short) return t;
    return `${a.d === n.d ? "Today" : "Tomorrow"} ${t}`;
  }
  function istDateMinus(days) {
    const n = istParts(new Date());
    const d = new Date(Date.UTC(n.y, n.m, n.d) - days * 86400000);
    return d.toISOString().slice(0, 10);
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
  const map = L.map("map", { zoomControl: true, minZoom: 4, maxZoom: 16 }).setView([22.8, 80.5], 5);

  /* Base map: OpenStreetMap tiles (no API key), muted with CSS so heat colours stand
   * out. If OSM tiles keep failing, switch to Esri's keyless light-grey basemap. */
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "osm-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  /* Satellite photos: Sentinel-2 cloudless 2023 mosaic by EOX (10 m, keyless, non-commercial
   * licence CC BY-NC-SA 4.0). Falls back to Esri World Imagery if EOX tiles fail. */
  let satBase = L.tileLayer("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg", {
    maxZoom: 19, maxNativeZoom: 17,
    attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless 2023</a> by EOX (contains modified Copernicus Sentinel data 2023)'
  });
  let satErrors = 0, satSwitched = false;
  satBase.on("tileerror", () => {
    if (satSwitched || ++satErrors < 6) return;
    satSwitched = true;
    const on = map.hasLayer(satBase);
    if (on) map.removeLayer(satBase);
    satBase = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics"
    });
    if (on) satBase.addTo(map).bringToBack();
  });
  let lstTiles = null;
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
  const featureLayer = L.layerGroup().addTo(map);
  let overlay = null;
  let clickMarker = null;

  const readout = document.createElement("div");
  readout.className = "readout";
  document.querySelector(".mapwrap").appendChild(readout);

  function layerStops() { return state.layer === "uv" ? UV_STOPS : TEMP_STOPS; }
  function layerName() { return { apparent: "Feels like", temp: "Temperature", uv: "UV index", lst: "Surface temperature" }[state.layer]; }
  function layerUnit() { return state.layer === "uv" ? "" : "°C"; }
  const isLst = () => state.layer === "lst";

  /* ---------------- satellite (NASA surface temperature) ---------------- */
  let lstGrad = null; // { css, colorAt }
  HM.SAT.legendGradient(10, 60).then((g) => { lstGrad = g; if (isLst()) { drawLegend(); drawCityMarkers(); } }).catch(() => {});
  function satDate() {
    return state.sat.period === "summer" ? HM.SAT.summerDate() : state.sat.dates[state.sat.kind] || null;
  }
  async function ensureSatDate() {
    if (state.sat.period === "summer" || state.sat.dates[state.sat.kind]) return satDate();
    const c = state.grid ? state.grid.city : { lat: 22.8, lon: 80.5 };
    state.sat.dates[state.sat.kind] = await HM.SAT.latestDate(state.sat.kind, c.lat, c.lon);
    return satDate();
  }
  function satKey() { return `${state.sat.kind}|${satDate()}`; }
  function satPeriodText() {
    const d = satDate();
    return d ? `${HM.SAT.periodLabel(d)} · ${state.sat.kind === "day" ? "daytime" : "night-time"} pass` : "finding the latest satellite pass…";
  }
  function setBasemap(b) {
    state.basemap = b;
    if (b === "sat") { if (map.hasLayer(osm)) map.removeLayer(osm); if (!map.hasLayer(satBase)) satBase.addTo(map).bringToBack(); }
    else { if (map.hasLayer(satBase)) map.removeLayer(satBase); if (!map.hasLayer(osm)) osm.addTo(map).bringToBack(); }
    document.querySelectorAll("[data-basemap]").forEach((x) => {
      const on = x.dataset.basemap === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  async function updateLstTiles() {
    if (!isLst()) { if (lstTiles) { map.removeLayer(lstTiles); lstTiles = null; } return; }
    const date = await ensureSatDate();
    if (!isLst()) return;
    const url = HM.SAT.leafletUrl(state.sat.kind, date);
    if (lstTiles && lstTiles._url === url) { lstTiles.setOpacity(state.sat.opacity); return; }
    if (lstTiles) map.removeLayer(lstTiles);
    lstTiles = L.tileLayer(url, {
      maxNativeZoom: 7, maxZoom: 19, opacity: state.sat.opacity, className: "lst-tiles", crossOrigin: "anonymous",
      attribution: 'Surface temperature &amp; vegetation: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a> / MODIS'
    }).addTo(map);
    drawLegend();
    loadSatCityVals();
    if (state.mode === "india") renderIndiaPanel();
  }
  async function loadSatCityVals() {
    const date = await ensureSatDate();
    const key = satKey();
    if (state.sat.cityVals[key]) return;
    state.sat.cityVals[key] = "loading";
    const vals = await Promise.all(HM.CITIES.map((c) => HM.SAT.lstAt(state.sat.kind, date, c.lat, c.lon).catch(() => null)));
    state.sat.cityVals[key] = vals;
    if (isLst() && satKey() === key) { drawCityMarkers(); if (state.mode === "india") renderIndiaPanel(); }
  }
  function cityValue(i, layer, h) {
    if (layer === "lst") {
      const v = state.sat.cityVals[satKey()];
      return Array.isArray(v) ? v[i] : null;
    }
    return valueAt(state.india && state.india[i], layer, h);
  }
  function colorForLayer(v) {
    if (isLst()) return lstGrad ? lstGrad.colorAt(v) : [150, 150, 150];
    return colorAt(layerStops(), v);
  }

  /* India overview markers */
  function drawCityMarkers() {
    cityLayer.clearLayers();
    if (!state.india) return;
    HM.CITIES.forEach((c, i) => {
      const loc = state.india[i];
      const v = cityValue(i, state.layer, state.hour);
      const col = v == null ? [150, 150, 150] : colorForLayer(v);
      const size = state.mode === "india" ? 34 : 26;
      const icon = L.divIcon({
        className: "",
        html: `<div class="city-pin" style="width:${size}px;height:${size}px;background:${rgbStr(col)};color:${inkFor(col)}">${v == null ? "?" : Math.round(v)}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2]
      });
      const m = L.marker([c.lat, c.lon], { icon, keyboard: true, title: c.name, riseOnHover: true });
      const app = valueAt(loc, "apparent", state.hour), tmp = valueAt(loc, "temp", state.hour), uv = valueAt(loc, "uv", state.hour);
      const satLine = isLst() ? `<br>Surface (satellite): ${v == null ? "no data / clouds" : fmt(v, 1) + "°C"}` : "";
      m.bindTooltip(`<strong>${esc(c.name)}</strong><br>${fmt(tmp)}°C · feels ${fmt(app)}°C · UV ${fmt(uv, 1)}<br><em>${heatLevel(app).label}</em>${satLine}`, { direction: "top", offset: [0, -size / 2] });
      m.on("click", () => goCity(c));
      m.addTo(cityLayer);
    });
  }

  /* ---------------- city heat grid ---------------- */
  function buildGrid(city) {
    const halfLon = GRID_HALF_DEG / Math.cos(city.lat * Math.PI / 180);
    const lats = [], lons = [], pts = [];
    for (let r = 0; r < GRID_N; r++) lats.push(city.lat + GRID_HALF_DEG - (2 * GRID_HALF_DEG * r) / (GRID_N - 1));
    for (let c = 0; c < GRID_N; c++) lons.push(city.lon - halfLon + (2 * halfLon * c) / (GRID_N - 1));
    for (let r = 0; r < GRID_N; r++) for (let c = 0; c < GRID_N; c++) pts.push({ lat: lats[r], lon: lons[c] });
    return { lats, lons, pts, bounds: L.latLngBounds([lats[GRID_N - 1], lons[0]], [lats[0], lons[GRID_N - 1]]) };
  }
  function gridValues() { return state.grid.locs.map((l) => valueAt(l, state.layer, state.hour)); }
  function gridRange(vals) {
    const v = vals.filter((x) => x != null);
    return v.length ? [Math.min(...v), Math.max(...v)] : [0, 1];
  }
  function sampleGrid(vals, fy, fx) {
    const N = GRID_N;
    const y0 = Math.max(0, Math.min(N - 1, Math.floor(fy))), x0 = Math.max(0, Math.min(N - 1, Math.floor(fx)));
    const y1 = Math.min(N - 1, y0 + 1), x1 = Math.min(N - 1, x0 + 1);
    const ty = fy - y0, tx = fx - x0;
    const a = vals[y0 * N + x0], b = vals[y0 * N + x1], c = vals[y1 * N + x0], d = vals[y1 * N + x1];
    if (a == null || b == null || c == null || d == null) { const f = [a, b, c, d].find((x) => x != null); return f == null ? null : f; }
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  const kmPerPx = () => (2 * GRID_HALF_DEG * 111.2) / (OV - 1);
  function latLngToPx(lat, lon) {
    const g = state.grid;
    return [((lon - g.lons[0]) / (g.lons[GRID_N - 1] - g.lons[0])) * (OV - 1), ((g.lats[0] - lat) / (g.lats[0] - g.lats[GRID_N - 1])) * (OV - 1)];
  }

  /* base field cache: bilinear-interpolated values for the current hour + layer */
  let base = null;
  function getBase() {
    const key = `${state.grid.city.lat},${state.grid.city.lon}|${state.hour}|${state.layer}`;
    if (base && base.key === key) return base;
    const vals = gridValues();
    const f = new Float32Array(OV * OV);
    for (let y = 0; y < OV; y++) {
      for (let x = 0; x < OV; x++) {
        const v = sampleGrid(vals, (y / (OV - 1)) * (GRID_N - 1), (x / (OV - 1)) * (GRID_N - 1));
        f[y * OV + x] = v == null ? NaN : v;
      }
    }
    const [lo, hi] = gridRange(vals);
    base = { key, f, lo, hi };
    return base;
  }

  /* ---------------- cooling simulator ---------------- */
  function treeCoolingAt(dKm, amp) {
    const T = HM.SIM.tree;
    if (dKm <= T.plateauKm) return amp;
    const z = (dKm - T.plateauKm) / T.sigmaKm;
    return amp * Math.exp(-z * z);
  }
  function simFactor() {
    const centre = state.grid && state.grid.locs[Math.floor((GRID_N * GRID_N) / 2)];
    return isDayAt(centre, state.hour) ? 1 : HM.SIM.tree.nightFactor;
  }
  /* returns cooling field (°C, positive = cooler) or null when nothing is planted */
  function coolingField() {
    const trees = state.features.filter((f) => f.type === "tree");
    if (!trees.length || state.layer === "uv") return null;
    const T = HM.SIM.tree, cap = T.cap, kpp = kmPerPx(), day = simFactor();
    // combine overlapping patches with diminishing returns towards the cap:
    // frac = 1 - Π(1 - c_i / cap)
    const keep = new Float32Array(OV * OV).fill(1);
    const reachKm = T.plateauKm + 2.6 * T.sigmaKm, rpx = Math.ceil(reachKm / kpp);
    for (const t of trees) {
      const amp = T.peak * t.grow * day;
      if (amp <= 0) continue;
      const [px, py] = latLngToPx(t.lat, t.lon);
      const x0 = Math.max(0, Math.floor(px - rpx)), x1 = Math.min(OV - 1, Math.ceil(px + rpx));
      const y0 = Math.max(0, Math.floor(py - rpx)), y1 = Math.min(OV - 1, Math.ceil(py + rpx));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - px, y - py) * kpp;
          if (d > reachKm) continue;
          keep[y * OV + x] *= 1 - treeCoolingAt(d, amp) / cap;
        }
      }
    }
    for (let i = 0; i < keep.length; i++) keep[i] = cap * (1 - keep[i]);
    return keep;
  }
  function coolingAtLatLng(lat, lon) {
    if (state.layer === "uv") return 0;
    const T = HM.SIM.tree, day = simFactor();
    let keep = 1;
    for (const t of state.features) {
      if (t.type !== "tree") continue;
      const d = L.latLng(lat, lon).distanceTo([t.lat, t.lon]) / 1000;
      keep *= 1 - treeCoolingAt(d, T.peak * t.grow * day) / T.cap;
    }
    return T.cap * (1 - keep);
  }

  /* ---------------- overlay drawing ---------------- */
  const ovCanvas = document.createElement("canvas");
  ovCanvas.width = OV; ovCanvas.height = OV;
  const ovCtx = ovCanvas.getContext("2d");
  let lastStats = null;

  function drawOverlay() {
    if (state.mode !== "city" || !state.grid || isLst()) {
      if (overlay) { map.removeLayer(overlay); overlay = null; }
      return;
    }
    const b = getBase(), cool = coolingField();
    const stops = layerStops();
    const s0 = stops[0][0], s1 = stops[stops.length - 1][0];
    const img = ovCtx.createImageData(OV, OV), px = img.data;
    const fade = 26;
    let maxB = -Infinity, maxA = -Infinity, sumB = 0, sumA = 0, n = 0, cooledPx = 0, maxC = 0;
    for (let y = 0; y < OV; y++) {
      const ey = Math.min(y, OV - 1 - y) / fade;
      for (let x = 0; x < OV; x++) {
        const i = y * OV + x, k = i * 4;
        const v0 = b.f[i];
        if (Number.isNaN(v0)) { px[k + 3] = 0; continue; }
        const c = cool ? cool[i] : 0;
        let v = v0 - c;
        if (v0 > maxB) maxB = v0;
        if (v > maxA) maxA = v;
        sumB += v0; sumA += v; n++;
        if (c >= 0.3) cooledPx++;
        if (c > maxC) maxC = c;
        if (state.contrast && b.hi - b.lo > 0.05) {
          const t = (v - b.lo) / (b.hi - b.lo);
          v = state.layer === "uv" ? s0 + t * (s1 - s0) * 0.8 : 27 + t * 24;
        }
        const col = colorAt(stops, v);
        px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2];
        const ex = Math.min(x, OV - 1 - x) / fade;
        px[k + 3] = Math.round(255 * Math.min(1, ex, ey));
      }
    }
    ovCtx.putImageData(img, 0, 0);
    const url = ovCanvas.toDataURL();
    if (overlay) overlay.setUrl(url);
    else overlay = L.imageOverlay(url, state.grid.bounds, { opacity: 0.62, interactive: false }).addTo(map);
    const kpp = kmPerPx();
    lastStats = n ? { maxB, maxA, maxC, meanB: sumB / n, meanA: sumA / n, cooledKm2: cooledPx * kpp * kpp } : null;
    updateSimMeter();
  }

  function gridValueAtLatLng(ll) {
    const g = state.grid;
    if (!g || !g.bounds.contains(ll)) return null;
    const fy = ((g.lats[0] - ll.lat) / (g.lats[0] - g.lats[GRID_N - 1])) * (GRID_N - 1);
    const fx = ((ll.lng - g.lons[0]) / (g.lons[GRID_N - 1] - g.lons[0])) * (GRID_N - 1);
    const v = sampleGrid(gridValues(), fy, fx);
    return v == null ? null : v - coolingAtLatLng(ll.lat, ll.lng);
  }

  let readoutToken = 0;
  function placeReadout(e, text) {
    readout.textContent = text;
    readout.style.left = e.containerPoint.x + 14 + "px";
    readout.style.top = e.containerPoint.y + 12 + "px";
    readout.style.display = "block";
  }
  map.on("mousemove", (e) => {
    if (isLst()) {
      const date = satDate();
      if (!date) return;
      const tok = ++readoutToken;
      HM.SAT.lstAt(state.sat.kind, date, e.latlng.lat, e.latlng.lng).then((v) => {
        if (tok !== readoutToken) return;
        placeReadout(e, v == null ? "No satellite reading here (cloud or water)" : `Surface ${fmt(v, 1)}°C · 1 km satellite pixel${state.mode === "city" ? " · click for details" : ""}`);
      }).catch(() => {});
      return;
    }
    if (state.mode !== "city" || !state.grid) { readout.style.display = "none"; return; }
    const v = gridValueAtLatLng(e.latlng);
    if (v == null) { readout.style.display = "none"; return; }
    const hint = state.tool === "tree" ? "click to plant trees" : state.tool === "roof" ? "click to add cool roofs" : "click for details";
    readout.textContent = `${layerName()}: ${fmt(v, 1)}${layerUnit()} · ${hint}`;
    readout.style.left = e.containerPoint.x + 14 + "px";
    readout.style.top = e.containerPoint.y + 12 + "px";
    readout.style.display = "block";
  });
  map.on("mouseout", () => { readout.style.display = "none"; });

  map.on("click", (e) => {
    if (state.mode !== "city") return;
    if (state.tool) return addFeature(state.tool, e.latlng.lat, e.latlng.lng);
    inspectPoint(e.latlng.lat, e.latlng.lng, "Selected spot", null);
  });

  /* ---------------- planting ---------------- */
  const TREE_SVG = `<svg viewBox="0 0 40 48" width="34" height="41" aria-hidden="true"><ellipse cx="20" cy="45" rx="11" ry="2.5" fill="rgba(0,0,0,.25)"/><rect x="17.5" y="30" width="5" height="14" rx="1.5" fill="#7a4b26"/><circle cx="20" cy="18" r="13" fill="#2f9e44"/><circle cx="12" cy="24" r="8.5" fill="#37b24d"/><circle cx="28" cy="24" r="8.5" fill="#2b8a3e"/><circle cx="20" cy="12" r="8" fill="#51cf66"/><circle cx="15" cy="13" r="2.5" fill="#8ce99a" opacity=".8"/></svg>`;
  const ROOF_SVG = `<svg viewBox="0 0 44 40" width="34" height="31" aria-hidden="true"><ellipse cx="22" cy="37" rx="15" ry="2.5" fill="rgba(0,0,0,.2)"/><rect x="9" y="18" width="26" height="17" rx="1.5" fill="#f1c27d" stroke="#8d6e63" stroke-width="1.2"/><path d="M4 20 L22 5 L40 20 Z" fill="#ffffff" stroke="#74c0fc" stroke-width="2.4" stroke-linejoin="round"/><rect x="19" y="25" width="6" height="10" fill="#8d6e63"/><path d="M30 2 l2 3 M36 6 l-3 2 M24 1 l0 3" stroke="#fab005" stroke-width="1.6" stroke-linecap="round"/></svg>`;

  let animRaf = null;
  function animateGrowth() {
    if (animRaf) return;
    const step = () => {
      let pending = false;
      const now = performance.now();
      state.features.forEach((f) => {
        if (f.grow < 1) {
          f.grow = reduceMotion ? 1 : Math.min(1, (now - f.t0) / 1400);
          if (f.grow < 1) pending = true;
        }
      });
      drawOverlay();
      animRaf = pending ? requestAnimationFrame(step) : null;
      if (!pending) refreshAfterSim();
    };
    animRaf = requestAnimationFrame(step);
  }
  function addFeature(type, lat, lon) {
    if (state.features.length >= HM.SIM.maxFeatures) return status(`That's the limit of ${HM.SIM.maxFeatures} items. Press Reset to start again.`, "error");
    const icon = L.divIcon({ className: "", html: `<div class="plant ${type}">${type === "tree" ? TREE_SVG : ROOF_SVG}</div>`, iconSize: [34, 41], iconAnchor: [17, type === "tree" ? 39 : 28] });
    const marker = L.marker([lat, lon], { icon, interactive: false, keyboard: false }).addTo(featureLayer);
    state.features.push({ type, lat, lon, grow: type === "tree" ? 0 : 1, t0: performance.now(), marker });
    // Tree cooling (1–3 °C) is small next to the full 10–54 °C colour scale, so stretch
    // colours to this area's range the first time trees are planted.
    if (type === "tree" && !state.contrast && !state.autoContrastDone) {
      state.contrast = true;
      state.autoContrastDone = true;
      drawLegend();
    }
    if (type === "tree" && state.layer !== "uv") animateGrowth();
    else { updateSimMeter(); refreshAfterSim(); }
  }
  function resetFeatures() {
    featureLayer.clearLayers();
    state.features = [];
    drawOverlay();
    updateSimMeter();
    refreshAfterSim();
  }
  function setTool(tool) {
    state.tool = state.tool === tool ? null : tool;
    els.simbar.querySelectorAll("[data-tool]").forEach((b) => {
      const on = b.dataset.tool === state.tool;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.getElementById("map").classList.toggle("planting", !!state.tool);
    updateSimMeter();
  }
  function plantAtHotspots() {
    if (!state.grid) return;
    if (state.layer === "uv" || isLst()) setLayer("apparent");
    const narrow = window.innerWidth <= 900;
    if (narrow) document.querySelector(".mapwrap").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    const wait = narrow ? 600 : 0;
    hotspots().hot.forEach((h, k) => setTimeout(() => addFeature("tree", h.lat, h.lon), wait + k * 350));
  }
  function updateSimMeter() {
    const m = els.simMeter;
    if (state.mode !== "city") { m.hidden = true; return; }
    const trees = state.features.filter((f) => f.type === "tree").length;
    const roofs = state.features.filter((f) => f.type === "roof").length;
    if (!trees && !roofs) {
      m.hidden = !state.tool;
      m.innerHTML = state.tool === "tree"
        ? "<strong>Plant trees:</strong> click the map to add a small urban forest and watch the heat map cool around it."
        : "<strong>Cool roofs:</strong> click the map to paint a block of roofs with solar-reflective white paint.";
      return;
    }
    m.hidden = false;
    let html = "";
    if (trees) {
      if (state.layer === "uv") {
        html += `<div><strong>🌳 ${trees} tree patch${trees > 1 ? "es" : ""}.</strong> Trees don't change the UV index itself, but their shade cuts the UV that reaches people beneath them. Switch to “Feels like” to see the cooling.</div>`;
      } else if (lastStats) {
        const where = simHotspotChange();
        html += `<div><strong>🌳 ${trees} tree patch${trees > 1 ? "es" : ""}</strong> · up to <b>−${fmt(lastStats.maxC, 1)}°C</b> where you planted · ~${fmt(lastStats.cooledKm2)} km² cooled by 0.3°C or more${where}</div>`;
        if (simFactor() < 1) html += `<div class="note">It's night at this hour: trees cool much less after dark and dense canopy can even trap heat.</div>`;
      }
    }
    if (roofs) {
      html += `<div><strong>🏠 ${roofs} cool-roof block${roofs > 1 ? "s" : ""}.</strong> Homes under reflective roofs can be ${HM.SIM.roof.indoorLow}–${HM.SIM.roof.indoorHigh}°C cooler indoors. The outdoor map barely changes, so roofs aren't drawn as cooling.</div>`;
    }
    if (trees && state.contrast && state.layer !== "uv") html += `<div class="note">Colours are stretched to this area's range so the cooling shows up. Untick “Highlight local hotspots” to see the absolute scale.</div>`;
    html += `<div class="note">Estimate based on published studies, not a measurement. See “About this data”.</div>`;
    m.innerHTML = html;
  }
  function simHotspotChange() {
    if (!state.grid) return "";
    const h = hotspots().hot[0];
    if (!h) return "";
    const c = coolingAtLatLng(h.lat, h.lon);
    if (c < 0.05) return "";
    const v = valueAt(state.grid.locs[h.i], state.layer, state.hour);
    return ` · Hotspot 1: ${fmt(v, 1)} → <b>${fmt(v - c, 1)}°C</b>`;
  }
  let refreshTimer = null;
  function refreshAfterSim() {
    // re-render the panel's simulator summary without rebuilding everything on every frame
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (state.mode === "city" && state.focus) renderPointPanel(); }, 120);
  }

  /* ---------------- legend ---------------- */
  function drawLegend() {
    if (isLst()) return drawLstLegend();
    const stops = layerStops();
    const s0 = stops[0][0], s1 = stops[stops.length - 1][0];
    const grad = stops.map(([s, c]) => `${c} ${(((s - s0) / (s1 - s0)) * 100).toFixed(1)}%`).join(",");
    let zones = "";
    if (state.layer === "uv") {
      zones = HM.UV_LEVELS.map((l, i) => {
        const nx = HM.UV_LEVELS[i + 1];
        return `<span><i style="background:${l.color}"></i>${nx ? `${l.min}–${nx.min - 1}` : `${l.min}+`} ${l.label}</span>`;
      }).join("");
    } else if (state.layer === "temp") {
      zones = `<span class="note">Zones are set by the “feels like” temperature.</span>`;
    } else {
      zones = HM.HEAT_LEVELS.map((l, i) => {
        const nx = HM.HEAT_LEVELS[i + 1];
        const rng = i === 0 ? `&lt;${nx.min}°` : nx ? `${l.min}–${nx.min}°` : `${l.min}°+`;
        return `<span><i style="background:${l.color}"></i>${rng} ${l.label}</span>`;
      }).join("");
    }
    let extra = "";
    if (state.mode === "city") {
      extra = `<label class="chk"><input type="checkbox" id="contrastChk" ${state.contrast ? "checked" : ""}> Highlight local hotspots</label>`;
      if (state.grid) {
        const [lo, hi] = gridRange(gridValues());
        extra += `<div class="note" style="margin-top:4px">Across this area: ${fmt(lo, 1)}–${fmt(hi, 1)}${layerUnit()}</div>`;
      }
    }
    els.legend.innerHTML = `<h4>${layerName()}${layerUnit() ? " (°C)" : ""}</h4>
      <div class="bar" style="background:linear-gradient(90deg,${grad})"></div>
      <div class="ticks"><span>${s0}</span><span>${Math.round((s0 + s1) / 2)}</span><span>${s1}${state.layer === "uv" ? "+" : ""}</span></div>
      ${state.mode === "city" && state.contrast ? `<div class="note" style="margin-top:4px">Colours stretched to this area's range.</div>` : ""}
      <div class="zones">${zones}</div>${extra}`;
    const chk = document.getElementById("contrastChk");
    if (chk) chk.onchange = () => { state.contrast = chk.checked; drawOverlay(); drawLegend(); };
  }

  function drawLstLegend() {
    const css = lstGrad ? lstGrad.css : "linear-gradient(90deg,#999,#ccc)";
    const b = (attr, val, label) => `<button type="button" data-${attr}="${val}" class="${state.sat[attr] === val ? "on" : ""}">${label}</button>`;
    els.legend.innerHTML = `<h4>Surface temperature (°C)</h4>
      <div class="bar" style="background:${css}"></div>
      <div class="ticks"><span>10</span><span>35</span><span>60</span></div>
      <div class="mini-seg">${b("period", "latest", "Latest")}${b("period", "summer", "Last summer")}</div>
      <div class="mini-seg">${b("kind", "day", "☀ Day")}${b("kind", "night", "☾ Night")}</div>
      <label class="chk op">Heat layer <input type="range" id="lstOpacity" min="0" max="100" value="${Math.round(state.sat.opacity * 100)}" aria-label="Surface heat layer opacity"></label>
      <div class="note" style="margin-top:4px">${esc(satPeriodText())}. NASA MODIS, ~1 km pixels. Ground and rooftops, not air. Gaps are clouds or water.</div>`;
    els.legend.querySelectorAll("[data-period]").forEach((x) => x.onclick = () => { state.sat.period = x.dataset.period; satChanged(); });
    els.legend.querySelectorAll("[data-kind]").forEach((x) => x.onclick = () => { state.sat.kind = x.dataset.kind; satChanged(); });
    const op = document.getElementById("lstOpacity");
    op.oninput = () => { state.sat.opacity = op.value / 100; if (lstTiles) lstTiles.setOpacity(state.sat.opacity); };
  }
  function satChanged() {
    drawLegend();
    updateLstTiles();
    renderPanel();
  }

  /* ---------------- sky theme for the side panel ---------------- */
  const SKY = {
    night: { g: ["#0b1430", "#22325f"], sun: null },
    mild: { g: ["#7cc8f8", "#e3f4ff"], sun: ["#ffe066", "#ffd43b"], cloud: "#ffffff" },
    warm: { g: ["#ffcf6e", "#fff1d2"], sun: ["#ffd43b", "#fab005"], cloud: "#fffaf0" },
    hot: { g: ["#ff8f3c", "#ffdcb4"], sun: ["#ffc078", "#f76707"], cloud: "#fff4e6" },
    scorch: { g: ["#d9381e", "#ffab6b"], sun: ["#ffa94d", "#e8590c"], cloud: "#ffe8cc" }
  };
  function skyKey(apparent, day) {
    if (!day) return "night";
    const id = heatLevel(apparent).id;
    return { comfortable: "mild", caution: "warm", "extreme-caution": "hot", danger: "scorch", "extreme-danger": "scorch" }[id];
  }
  const svgUrl = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
  function sunSvg(cx, cy, r, c, rays) {
    let s = "";
    if (rays) for (let a = 0; a < 360; a += 30) {
      const rad = a * Math.PI / 180;
      s += `<line x1="${cx + Math.cos(rad) * (r + 5)}" y1="${cy + Math.sin(rad) * (r + 5)}" x2="${cx + Math.cos(rad) * (r + 13)}" y2="${cy + Math.sin(rad) * (r + 13)}" stroke="${c[1]}" stroke-width="3" stroke-linecap="round" opacity=".75"/>`;
    }
    return s + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c[0]}" stroke="${c[1]}" stroke-width="2"/>`;
  }
  function cloudSvg(x, y, s, fill, op) {
    return `<g transform="translate(${x} ${y}) scale(${s})" opacity="${op}"><ellipse cx="0" cy="10" rx="34" ry="12" fill="${fill}"/><circle cx="-14" cy="2" r="13" fill="${fill}"/><circle cx="8" cy="-4" r="17" fill="${fill}"/><circle cx="26" cy="6" r="10" fill="${fill}"/></g>`;
  }
  function skyPattern(key) {
    const t = SKY[key];
    let inner = "";
    if (key === "night") {
      const stars = [[30, 40], [120, 90], [260, 30], [330, 140], [70, 200], [200, 250], [300, 330], [40, 380], [150, 430], [280, 480], [100, 520], [340, 560]];
      inner = stars.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 1.3 : 2}" fill="#fff" opacity="${i % 2 ? .55 : .85}"/>`).join("") +
        `<circle cx="300" cy="260" r="16" fill="#f1f3f5" opacity=".55"/><circle cx="307" cy="254" r="14" fill="#22325f" opacity=".55"/>` +
        cloudSvg(90, 470, 0.8, "#3b4a7a", .5);
    } else {
      inner = sunSvg(320, 70, 16, t.sun, true) + sunSvg(60, 330, 11, t.sun, true) + sunSvg(250, 520, 9, t.sun, false) +
        cloudSvg(110, 140, 0.9, t.cloud, .8) + cloudSvg(270, 290, 0.7, t.cloud, .7) + cloudSvg(150, 450, 0.6, t.cloud, .65) + cloudSvg(330, 600, 0.5, t.cloud, .6);
    }
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="380" height="640" viewBox="0 0 380 640">${inner}</svg>`);
  }
  function heroArt(key) {
    const t = SKY[key];
    if (key === "night") {
      return `<svg class="hero-art" viewBox="0 0 140 110" aria-hidden="true"><circle class="twinkle" cx="20" cy="20" r="2" fill="#fff"/><circle class="twinkle d2" cx="120" cy="14" r="1.6" fill="#fff"/><circle class="twinkle d3" cx="60" cy="90" r="1.4" fill="#fff"/>
        <circle cx="86" cy="50" r="30" fill="#f8f9fa"/><circle cx="100" cy="40" r="27" fill="${t.g[0]}"/><g class="drift">${cloudSvg(40, 78, .7, "#3b4a7a", .9)}</g></svg>`;
    }
    const big = key === "scorch" || key === "hot";
    const r = big ? 30 : 24;
    let rays = "";
    for (let a = 0; a < 360; a += big ? 20 : 30) rays += `<rect x="-2.5" y="${-(r + 22)}" width="5" height="${big ? 15 : 11}" rx="2.5" fill="${t.sun[1]}" transform="rotate(${a})"/>`;
    return `<svg class="hero-art" viewBox="0 0 140 110" aria-hidden="true"><g transform="translate(88 50)"><g class="spin">${rays}</g>
      <circle r="${r + 6}" fill="${t.sun[0]}" opacity=".35"/><circle r="${r}" fill="${t.sun[0]}" stroke="${t.sun[1]}" stroke-width="3"/></g>
      ${key === "mild" ? `<g class="drift">${cloudSvg(40, 80, .8, "#fff", .95)}</g>` : `<g class="drift">${cloudSvg(36, 86, .55, t.cloud, .8)}</g>`}</svg>`;
  }
  let currentSky = null;
  function applySky(key) {
    currentSky = key;
    const t = SKY[key];
    const a = els.aside;
    a.dataset.sky = key;
    a.style.setProperty("--sky-top", t.g[0]);
    a.style.setProperty("--sky-bottom", t.g[1]);
    a.style.setProperty("--sky-pattern", skyPattern(key));
  }

  /* ---------------- panel ---------------- */
  let charts = [];
  function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

  function panelLoading(title) {
    destroyCharts();
    els.panel.innerHTML = `<div class="hero"><div class="hero-text"><p class="eyebrow">Loading live data</p><h2 class="place">${esc(title)}</h2></div></div>
      <section class="card"><div class="skeleton" style="height:90px"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></section>
      <section class="card"><div class="skeleton" style="height:160px"></div></section>`;
  }
  function hero(eyebrow, title, sub) {
    return `<div class="hero"><div class="hero-text"><p class="eyebrow">${eyebrow}</p><h2 class="place">${esc(title)}</h2>${sub ? `<p class="sub">${sub}</p>` : ""}</div>${heroArt(currentSky || "mild")}</div>`;
  }

  function renderIndiaPanel() {
    destroyCharts();
    if (!state.india) return;
    const h = state.hour;
    const t = timeAt(state.india[0], h);
    const rows = HM.CITIES.map((c, i) => ({ c, v: cityValue(i, state.layer, h), uv: valueAt(state.india[i], "uv", h), app: valueAt(state.india[i], "apparent", h) }))
      .sort((a, b) => (b.v == null ? -99 : b.v) - (a.v == null ? -99 : a.v));
    const apps = rows.map((r) => r.app).filter((x) => x != null).sort((a, b) => a - b);
    applySky(skyKey(apps[Math.floor(apps.length / 2)], isDayAt(state.india[0], h)));
    const counts = {};
    rows.forEach((r) => { const l = heatLevel(r.app); counts[l.id] = (counts[l.id] || 0) + 1; });
    const summary = HM.HEAT_LEVELS.filter((l) => counts[l.id]).map((l) =>
      `<span class="pill"><i style="background:${l.color}"></i>${counts[l.id]} ${l.label.toLowerCase()}</span>`).join("");

    els.panel.innerHTML = `
      ${hero(isLst() ? `Satellite · ${esc(satPeriodText())}` : `${h === 0 ? "Right now" : "Forecast"} · ${esc(hourText(t))}`, "All of India", `${HM.CITIES.length} cities · sorted by ${layerName().toLowerCase()}${isLst() ? " at the city centre" : ""} · tap a city to see its heat map`)}
      <section class="card">
        <div class="pills">${summary}</div>
        <ul class="rank" id="rankList">
          ${rows.map((r) => {
            const col = r.v == null ? [160, 160, 160] : colorForLayer(r.v);
            return `<li data-city="${esc(r.c.name)}" tabindex="0" role="button" aria-label="Open ${esc(r.c.name)}">
              <span class="dot" style="background:${rgbStr(col)}"></span>
              <span class="nm">${esc(r.c.name)} <span class="note">${esc(r.c.state)}</span></span>
              <span class="val">${r.v == null && isLst() ? '<span class="note">clouds</span>' : fmt(r.v, state.layer === "uv" ? 1 : 0) + layerUnit()}</span>
              <span class="uvv">${state.layer === "uv" ? fmt(r.app, 0) + "°C" : "UV " + fmt(r.uv, 0)}</span>
            </li>`;
          }).join("")}
        </ul>
      </section>
      <section class="card">
        <h3 class="sec">What the heat zones mean</h3>
        ${HM.HEAT_LEVELS.map((l, i) => {
          const nx = HM.HEAT_LEVELS[i + 1];
          const rng = i === 0 ? `below ${nx.min}°C` : nx ? `${l.min}–${nx.min}°C` : `${l.min}°C and above`;
          return `<details class="acc"><summary><span><i class="sw" style="background:${l.color}"></i>${l.label} <span class="note">feels like ${rng}</span></span></summary>
            <p class="who">${esc(l.summary)}</p><ul class="tips">${l.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>`;
        }).join("")}
      </section>
      <section class="card">
        <h3 class="sec">See the history and test fixes</h3>
        <p class="note" style="margin:0">Open any city to see when it was hottest since 1990, then plant trees and add cool roofs on its map to see how much they could cool it.</p>
      </section>
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
    const uvForAdvice = Math.max(uv == null ? 0 : uv, uvPeak == null ? 0 : uvPeak);
    const uvl = uvLevel(uv), uvlAdvice = uvLevel(uvForAdvice), uvlPeak = uvLevel(uvPeak);
    const tw = wetBulb(temp, rh);
    const day = isDayAt(loc, h);
    const wx = h === 0 && loc.current ? WEATHER[loc.current.weather_code] : null;
    applySky(skyKey(app, day));

    const idx = HM.HEAT_LEVELS.indexOf(lvl);
    const basics = [];
    for (let i = idx - 1; i >= 1; i--) HM.HEAT_LEVELS[i].actions.forEach((a) => basics.push(a));
    const simCool = state.features.some((x) => x.type === "tree") && state.layer !== "uv" ? coolingAtLatLng(f.lat, f.lon) : 0;

    destroyCharts();
    els.panel.innerHTML = `
      ${hero(`${h === 0 ? "Right now" : "Forecast"} · ${esc(hourText(t))}${wx ? " · " + esc(wx) : ""}`, f.title, esc(f.subtitle || ""))}

      <section class="card">
        <div class="zone-card" style="background:${lvl.color};color:${lvl.ink}">
          <div class="zlabel">Heat zone</div>
          <div class="zname">${esc(lvl.label)}</div>
          <p>${esc(lvl.summary)}</p>
        </div>
        <div class="stats">
          <div class="stat"><div class="k">Temperature</div><div class="v">${fmt(temp, 1)}<small>°C</small></div></div>
          <div class="stat"><div class="k">Feels like</div><div class="v">${fmt(app, 1)}<small>°C</small></div>${simCool >= 0.05 ? `<span class="uv-chip sim">🌳 −${fmt(simCool, 1)}°C with trees</span>` : ""}</div>
          <div class="stat"><div class="k">Humidity</div><div class="v">${fmt(rh)}<small>%</small></div></div>
          <div class="stat"><div class="k">UV index</div><div class="v">${fmt(uv, 1)}</div><span class="uv-chip" style="background:${uvl.color};color:${uvl.ink}">${esc(uvl.label)}</span></div>
          <div class="stat"><div class="k">Today's peak UV</div><div class="v">${fmt(uvPeak, 1)}</div><span class="uv-chip" style="background:${uvlPeak.color};color:${uvlPeak.ink}">${esc(uvlPeak.label)}</span></div>
          <div class="stat" title="Wet-bulb temperature combines heat and humidity. Above about 31°C, even fit people struggle to cool down during activity."><div class="k">Wet-bulb (approx.)</div><div class="v">${fmt(tw, 1)}<small>°C</small></div></div>
          <div class="stat wide" title="Land surface temperature measured by NASA's MODIS satellite for this 1 km spot: ground and rooftops, which get much hotter than the air in sunshine."><div class="k">🛰 Ground surface (satellite)</div><div class="v" id="satStat">…</div><div class="note" id="satStatNote"></div></div>
        </div>
        ${!day && h === 0 ? `<p class="note" style="margin:-4px 0 10px">The sun is down, so the UV index is 0 now. Sun-safety advice below is for today's peak.</p>` : ""}
        ${imdBlock(loc, f.terrain)}
      </section>

      <section class="card">
        <h3 class="sec">Next 24 hours</h3>
        <div class="chart-box"><canvas id="hourChart" aria-label="Hourly temperature, feels-like and UV forecast"></canvas></div>
      </section>

      ${historyCard()}

      ${state.mode === "city" && state.grid ? satelliteCard() : ""}

      <section class="card">
        <h3 class="sec">What to do in this zone</h3>
        <ul class="tips">${lvl.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
        ${basics.length ? `<details class="acc" style="margin-top:8px"><summary>Keep following the basics</summary><ul class="tips">${basics.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>` : ""}
        <h3 class="sec">Sun safety · UV ${esc(uvlAdvice.label.toLowerCase())}${uvPeak != null ? ` (peak ${fmt(uvPeak, 0)} today)` : ""}</h3>
        <ul class="tips">${uvlAdvice.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
      </section>

      ${state.mode === "city" && state.grid ? hotspotBlock() + fixItCard() : ""}

      <section class="card">
        <h3 class="sec">If you are at higher risk</h3>
        ${HM.GROUPS.map((g) => `<details class="acc"><summary>${esc(g.title)}</summary><p class="who">${esc(g.who)}</p><ul class="tips">${g.tips.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>`).join("")}
        <details class="acc" ${lvl.min >= 41 ? "open" : ""}><summary>Heatstroke: signs and first aid</summary>
          <p class="who">Warning signs</p><ul class="tips">${HM.HEATSTROKE.signs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <p class="who">What to do</p><ul class="tips">${HM.HEATSTROKE.firstAid.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        </details>
      </section>

      ${emergencyBlock()}
      ${aboutBlock()}`;

    drawHourChart(loc);
    drawHistoryChart();
    bindPanel();
    fillSatStat(f);
  }
  async function fillSatStat(f) {
    const el = document.getElementById("satStat"), note = document.getElementById("satStatNote");
    if (!el) return;
    try {
      const date = await ensureSatDate();
      const v = await HM.SAT.lstAt(state.sat.kind, date, f.lat, f.lon);
      if (!document.body.contains(el)) return;
      el.innerHTML = v == null ? '<small>no reading (clouds or water)</small>' : `${fmt(v, 1)}<small>°C</small>`;
      note.textContent = `${HM.SAT.periodLabel(date)}, ${state.sat.kind === "day" ? "daytime" : "night-time"} average`;
    } catch (_) { el.innerHTML = "<small>unavailable</small>"; }
  }

  /* ---------------- "What the satellite sees" ---------------- */
  const SAT_RADIUS_KM = 15;
  function satelliteCard() {
    const g = state.grid;
    const name = g.city.name === "Your area" ? "your area" : g.city.name;
    const date = satDate();
    const key = `${g.city.lat.toFixed(3)},${g.city.lon.toFixed(3)}|${satKey()}`;
    const rec = date ? state.sat.analyses[key] : null;
    const head = `<h3 class="sec">🛰 What the satellite sees</h3>
      <div class="mini-seg inline">
        <button type="button" data-satperiod="latest" class="${state.sat.period === "latest" ? "on" : ""}">Latest</button>
        <button type="button" data-satperiod="summer" class="${state.sat.period === "summer" ? "on" : ""}">Last summer</button>
        <button type="button" data-satkind="day" class="${state.sat.kind === "day" ? "on" : ""}">☀ Day</button>
        <button type="button" data-satkind="night" class="${state.sat.kind === "night" ? "on" : ""}">☾ Night</button>
      </div>`;
    if (!date || !rec || rec === "loading") {
      setTimeout(() => runSatAnalysis(key), 0);
      return `<section class="card satcard">${head}<p class="note">Reading NASA satellite data for ${esc(name)}…</p><div class="skeleton" style="height:90px"></div></section>`;
    }
    if (rec.error) return `<section class="card satcard">${head}<p class="note">Couldn't read the satellite data: ${esc(rec.error)}</p><button class="btn small" type="button" id="satRetry">Retry</button></section>`;
    const A = rec;
    if (!A.cells) return `<section class="card satcard">${head}<p class="note">Clouds covered ${esc(name)} for this whole period (${esc(satPeriodText())}). Try “Last summer” or the other pass.</p></section>`;
    const cover = Math.round((A.cells / Math.max(1, A.landTotal)) * 100);
    let compare = "";
    if (A.green && A.grey) {
      const diff = A.grey.mean - A.green.mean;
      const vals = [A.green.mean, A.grey.mean].concat(A.water ? [A.water.mean] : []);
      const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 0.5;
      const w = (v) => Math.max(8, Math.round(((v - lo) / (hi - lo)) * 100));
      const bar = (label, icon, v, sub, cls) => `<div class="cmp-row"><span class="cmp-label">${icon} ${label} <span class="note">${sub}</span></span><span class="cmp-bar ${cls}" style="width:${w(v)}%"></span><b>${fmt(v, 1)}°C</b></div>`;
      compare = `<p class="hist-lead">${diff >= 0.3
        ? `The greenest third of this area averaged <b>${fmt(diff, 1)}°C cooler</b> at ground level than the least green third.`
        : diff <= -0.3
          ? `This time the greenest third was <b>${fmt(-diff, 1)}°C warmer</b> than the least green third. That can happen at night, after rain, or where the least green land is wet or open water.`
          : `The greenest and least green parts of this area were about the same temperature this time.`}</p>
        <div class="cmp">${bar("Greenest third", "🌳", A.green.mean, `greenness ${fmt(A.green.ndvi, 2)} · ${A.green.n} km²`, "g")}${bar("Least green third", "🏙️", A.grey.mean, `greenness ${fmt(A.grey.ndvi, 2)} · ${A.grey.n} km²`, "b")}${A.water ? bar("Water and shoreline", "💧", A.water.mean, `${A.water.n} km²`, "w") : ""}</div>`;
    } else {
      compare = `<p class="note">Not enough clear land pixels to compare greener and less green areas this time.</p>`;
    }
    const spot = (lbl, c, cls) => `<li class="${cls}"><span>${lbl} <span class="note">${offsetText(c.lat, c.lon, g.city)}</span></span><b>${fmt(c.v, 1)}°C</b><button type="button" class="btn small" data-spot="${c.lat},${c.lon},${cls}">Show</button></li>`;
    return `<section class="card satcard">${head}
      <p class="note" style="margin-top:0">Within ${SAT_RADIUS_KM} km of the centre · ${esc(satPeriodText())} · ${cover}% of land clear of clouds</p>
      ${compare}
      <ul class="spots">${spot("Coolest 1 km", A.coolest, "cool")}${spot("Hottest 1 km", A.hottest, "hot")}</ul>
      <button type="button" class="btn primary" id="showSat">🛰 Show surface heat on the satellite map</button>
      <p class="note">Greenness is NASA's vegetation index (NDVI, 250 m; higher means more plant cover). Each 1 km cell is ranked by greenness and the top and bottom thirds are compared. Satellites measure ground and rooftop temperature, which in sunshine runs far hotter than the air. Pixels are 1 km, so small parks blur into their surroundings. Before the monsoon, dry bare farmland can be hotter than the city itself.</p>
    </section>`;
  }
  async function runSatAnalysis(key) {
    if (state.sat.analyses[key] && state.sat.analyses[key] !== "loading-wait") {
      if (state.sat.analyses[key] === "loading") return;
    }
    const g = state.grid;
    if (!g) return;
    const date = await ensureSatDate();
    const realKey = `${g.city.lat.toFixed(3)},${g.city.lon.toFixed(3)}|${state.sat.kind}|${date}`;
    if (state.sat.analyses[realKey]) { if (realKey !== key) renderPointPanel(); return; }
    state.sat.analyses[realKey] = "loading";
    try {
      state.sat.analyses[realKey] = await HM.SAT.analyse(state.sat.kind, date, g.city.lat, g.city.lon, SAT_RADIUS_KM);
    } catch (e) {
      state.sat.analyses[realKey] = { error: e.message || "network error" };
    }
    if (state.mode === "city" && state.grid === g) renderPointPanel();
  }
  function showSatView(lat, lon, zoom, label) {
    setBasemap("sat");
    if (!isLst()) setLayer("lst");
    if (lat != null) {
      state.sat.opacity = Math.min(state.sat.opacity, 0.5);
      if (lstTiles) lstTiles.setOpacity(state.sat.opacity);
      drawLegend();
      map.flyTo([lat, lon], zoom, { duration: 0.8 });
      if (clickMarker) map.removeLayer(clickMarker);
      clickMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="click-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(map);
      if (label) clickMarker.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -8] }).openTooltip();
    } else if (state.grid) {
      map.flyToBounds(state.grid.bounds, { duration: 0.8 });
    }
    if (window.innerWidth <= 900) document.querySelector(".mapwrap").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }

  function drawHourChart(loc) {
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
    charts.push(new Chart(cv, {
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
    }));
  }

  /* ---------------- heat history (timeline) ---------------- */
  function historyPlace() {
    const c = state.grid ? state.grid.city : null;
    return c ? { key: `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`, name: c.name === "Your area" ? "your area" : c.name, lat: c.lat, lon: c.lon } : null;
  }
  async function loadHistory(place) {
    const rec = state.history[place.key];
    if (rec && (rec.status === "loading" || rec.status === "ready")) return;
    state.history[place.key] = { status: "loading" };
    const p = new URLSearchParams({
      parameters: "T2M_MAX", community: "AG",
      latitude: place.lat.toFixed(4), longitude: place.lon.toFixed(4),
      start: HISTORY_START, end: istDateMinus(1).replace(/-/g, ""), format: "JSON"
    });
    try {
      const j = await getJSON(`${POWER}?${p}`, 45000);
      const fill = (j.header && j.header.fill_value) != null ? j.header.fill_value : -999;
      const raw = j.properties && j.properties.parameter && j.properties.parameter.T2M_MAX;
      if (!raw) throw new Error("NASA POWER returned no temperature data.");
      const days = Object.keys(raw).sort().filter((k) => raw[k] != null && raw[k] > fill + 1)
        .map((k) => ({ t: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`, v: raw[k] }));
      if (days.length < 400) throw new Error("Not enough history for this spot.");
      state.history[place.key] = { status: "ready", data: summariseHistory(days) };
    } catch (e) {
      state.history[place.key] = { status: "error", error: e.message };
    }
    const cur = historyPlace();
    if (state.mode === "city" && cur && cur.key === place.key) renderPointPanel();
  }
  function summariseHistory(days) {
    const last365 = days.slice(-365);
    const hotYear = last365.reduce((m, x) => (x.v > m.v ? x : m), last365[0]);
    const years = {};
    const monthSum = new Array(12).fill(0), monthN = new Array(12).fill(0);
    days.forEach((x) => {
      const y = +x.t.slice(0, 4), m = +x.t.slice(5, 7) - 1;
      if (!years[y]) years[y] = { y, v: x.v, t: x.t, n: 0 };
      if (x.v > years[y].v) { years[y].v = x.v; years[y].t = x.t; }
      years[y].n++;
      monthSum[m] += x.v; monthN[m]++;
    });
    const yearList = Object.values(years).sort((a, b) => a.y - b.y);
    const lastYear = yearList[yearList.length - 1];
    const top = days.slice().sort((a, b) => b.v - a.v).slice(0, 5);
    const monthMeans = monthSum.map((s, i) => s / (monthN[i] || 1));
    const hottestMonth = monthMeans.indexOf(Math.max(...monthMeans));
    return { last365, hotYear, yearList, partialYear: lastYear && lastYear.n < 360 ? lastYear.y : null, top, hottestMonth, first: days[0].t, lastDay: days[days.length - 1].t };
  }
  function historyCard() {
    const place = historyPlace();
    if (!place) return "";
    const rec = state.history[place.key];
    if (!rec || rec.status === "loading") {
      if (!rec) setTimeout(() => loadHistory(place), 0);
      return `<section class="card"><h3 class="sec">When was ${esc(place.name)} hottest?</h3><p class="note">Loading daily records since 1990 from NASA…</p><div class="skeleton" style="height:150px"></div></section>`;
    }
    if (rec.status === "error") {
      return `<section class="card"><h3 class="sec">When was ${esc(place.name)} hottest?</h3><p class="note">Couldn't load the history: ${esc(rec.error)}</p><button class="btn small" id="histRetry" type="button">Retry</button></section>`;
    }
    const H = rec.data;
    const rec1 = H.top[0];
    const hill = state.grid && state.grid.city.terrain === "hilly";
    return `<section class="card">
      <h3 class="sec">When was ${esc(place.name)} hottest?</h3>
      <div class="tabs" role="tablist">
        <button type="button" data-tab="year" class="${state.histTab === "year" ? "on" : ""}" role="tab">Past 12 months</button>
        <button type="button" data-tab="decades" class="${state.histTab === "decades" ? "on" : ""}" role="tab">Since 1990</button>
      </div>
      ${state.histTab === "year"
        ? `<p class="hist-lead">Hottest day in the past year: <b>${fmt(H.hotYear.v, 1)}°C</b> on ${dateText(H.hotYear.t)}.</p>`
        : `<p class="hist-lead">Hottest day since 1990: <b>${fmt(rec1.v, 1)}°C</b> on ${dateText(rec1.t)}. Each bar is the hottest day of that year.</p>`}
      <div class="chart-box tall"><canvas id="histChart" aria-label="Heat history chart"></canvas></div>
      ${state.histTab === "decades" ? `<p class="note" style="margin:10px 0 0;font-weight:600">5 hottest days since 1990</p><ol class="toplist">${H.top.map((x) => `<li><span>${dateText(x.t)}</span><b>${fmt(x.v, 1)}°C</b></li>`).join("")}</ol>` : ""}
      <p class="note">Usually hottest in <b>${MONTHS_LONG[H.hottestMonth]}</b>. Daily maximum air temperature from <a href="https://power.larc.nasa.gov/" target="_blank" rel="noopener">NASA POWER</a> (satellite and model data on a roughly 50 km grid), ${dateText(H.first)} to ${dateText(H.lastDay)}. It describes the wider city area, so individual weather stations can record higher or lower peaks.${hill ? " <b>Hill city:</b> the coarse grid mixes in lower, hotter valleys, so these values run higher than the town itself." : ""}</p>
    </section>`;
  }
  function drawHistoryChart() {
    const cv = document.getElementById("histChart");
    const place = historyPlace();
    if (!cv || !place || typeof Chart === "undefined") return;
    const rec = state.history[place.key];
    if (!rec || rec.status !== "ready") return;
    const H = rec.data;
    if (state.histTab === "year") {
      const hotIdx = H.last365.indexOf(H.hotYear);
      charts.push(new Chart(cv, {
        type: "line",
        data: {
          labels: H.last365.map((x) => x.t),
          datasets: [{
            label: "Daily maximum °C", data: H.last365.map((x) => x.v), borderWidth: 1.5, tension: 0.3,
            borderColor: "#f08c00", backgroundColor: "rgba(240,140,0,.12)", fill: true,
            segment: { borderColor: (c) => rgbStr(colorAt(TEMP_STOPS, c.p1.parsed.y)) },
            pointRadius: (c) => (c.dataIndex === hotIdx ? 5 : 0), pointBackgroundColor: "#d9282f", pointBorderColor: "#fff", pointBorderWidth: 2
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => dateText(it[0].label), label: (c) => `Max ${Number(c.raw).toFixed(1)}°C` } } },
          scales: {
            x: { ticks: { font: { size: 10 }, maxTicksLimit: 7, callback: function (v) { const t = this.getLabelForValue(v); return MONTHS[+t.slice(5, 7) - 1] + " " + t.slice(2, 4); } }, grid: { display: false } },
            y: { ticks: { font: { size: 10 } }, title: { display: true, text: "°C", font: { size: 10 } } }
          }
        }
      }));
    } else {
      const ys = H.yearList;
      charts.push(new Chart(cv, {
        data: {
          labels: ys.map((y) => String(y.y)),
          datasets: [
            { type: "bar", label: "Hottest day of the year °C", data: ys.map((y) => y.v), backgroundColor: ys.map((y) => { const c = colorAt(TEMP_STOPS, y.v); return y.y === H.partialYear ? `rgba(${c[0]},${c[1]},${c[2]},.45)` : rgbStr(c); }), borderRadius: 2, order: 2 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => `${Number(c.raw).toFixed(1)}°C on ${dateText(ys[c.dataIndex].t)}${ys[c.dataIndex].y === H.partialYear ? " (year so far)" : ""}` } }
          },
          scales: {
            x: { ticks: { font: { size: 10 }, maxTicksLimit: 9 }, grid: { display: false } },
            y: { beginAtZero: false, min: Math.floor(Math.min(...ys.map((y) => y.v)) - 2), max: Math.ceil(Math.max(...ys.map((y) => y.v)) + 1), ticks: { font: { size: 10 } }, title: { display: true, text: "°C", font: { size: 10 } } }
          }
        }
      }));
    }
  }

  /* ---------------- hotspots + fix-it ---------------- */
  function offsetText(lat, lon, c) {
    const R = 6371, toR = Math.PI / 180;
    const dy = (lat - c.lat) * toR * R, dx = (lon - c.lon) * toR * R * Math.cos(c.lat * toR);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1.5) return "near the centre";
    const ang = (Math.atan2(dx, dy) / toR + 360) % 360;
    const dirs = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    return `~${Math.round(dist)} km ${dirs[Math.round(ang / 45) % 8]} of centre`;
  }
  function hotspots() {
    const g = state.grid;
    const vals = g.locs.map((l, i) => ({ i, v: valueAt(l, "apparent", state.hour), lat: g.pts[i].lat, lon: g.pts[i].lon }))
      .filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    return { hot: vals.slice(0, 3), cool: vals[vals.length - 1] };
  }
  function hotspotBlock() {
    const g = state.grid;
    const { hot, cool } = hotspots();
    if (!hot.length) return "";
    const row = (x, tag) => {
      const c = coolingAtLatLng(x.lat, x.lon);
      const v = x.v - (state.layer === "uv" ? 0 : c);
      const l = heatLevel(v);
      return `<li data-lat="${x.lat}" data-lon="${x.lon}" tabindex="0" role="button"><span class="dot" style="background:${l.color}"></span><span class="nm">${tag} <span class="note">${offsetText(x.lat, x.lon, g.city)}</span></span><span class="val">${fmt(v, 1)}°C${c >= 0.05 && state.layer !== "uv" ? ` <span class="note">(−${fmt(c, 1)})</span>` : ""}</span></li>`;
    };
    return `<section class="card"><h3 class="sec">Hotspots around ${esc(g.city.name)}</h3>
      <ul class="rank" id="hotList">${hot.map((x, k) => row(x, `Hotspot ${k + 1}`)).join("")}${row(cool, "Coolest area")}</ul>
      <p class="note">Feels-like temperature across ${GRID_N * GRID_N} forecast points covering about 60 × 60 km. Tap a row to inspect it.</p></section>`;
  }
  function fixItCard() {
    const g = state.grid;
    const { hot } = hotspots();
    const where = hot.length ? offsetText(hot[0].lat, hot[0].lon, g.city) : "";
    const trees = state.features.filter((f) => f.type === "tree").length, roofs = state.features.filter((f) => f.type === "roof").length;
    return `<section class="card fixit">
      <h3 class="sec">How to cool ${esc(g.city.name === "Your area" ? "this area" : g.city.name)}</h3>
      ${hot.length ? `<p class="hist-lead">Start with <b>Hotspot 1</b> (${where}). It runs ${fmt(hot[0].v - hotspots().cool.v, 1)}°C hotter than the coolest part of this area right now.</p>` : ""}
      <div class="sim-cta">
        <button type="button" class="btn primary" id="plantHot">🌳 Plant trees at the 3 hotspots</button>
        <button type="button" class="btn" data-tool-btn="tree">Plant trees yourself</button>
        <button type="button" class="btn" data-tool-btn="roof">Add cool roofs</button>
      </div>
      ${trees || roofs ? `<p class="note">You've placed ${trees} tree patch${trees === 1 ? "" : "es"} and ${roofs} cool-roof block${roofs === 1 ? "" : "s"}. Watch the map: cooler colours spread out from each tree patch.</p>` : ""}
      <ul class="fix">${HM.MITIGATION.city.map((m) => `<li><span class="fi" aria-hidden="true">${m.icon}</span><div><b>${esc(m.title)}</b><br><span>${esc(m.text)}</span></div></li>`).join("")}</ul>
      <details class="acc"><summary>What you can do at home</summary><ul class="tips">${HM.MITIGATION.home.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
    </section>`;
  }

  function bindPanel() {
    els.panel.querySelectorAll("#hotList li").forEach((li) => {
      const go = () => {
        const lat = +li.dataset.lat, lon = +li.dataset.lon;
        map.panTo([lat, lon]);
        inspectPoint(lat, lon, li.querySelector(".nm").firstChild.textContent.trim(), null);
      };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    els.panel.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { state.histTab = b.dataset.tab; renderPointPanel(); }));
    const retry = document.getElementById("histRetry");
    if (retry) retry.onclick = () => { const p = historyPlace(); delete state.history[p.key]; renderPointPanel(); };
    const ph = document.getElementById("plantHot");
    if (ph) ph.onclick = plantAtHotspots;
    els.panel.querySelectorAll("[data-satperiod]").forEach((b) => b.onclick = () => { state.sat.period = b.dataset.satperiod; satChanged(); });
    els.panel.querySelectorAll("[data-satkind]").forEach((b) => b.onclick = () => { state.sat.kind = b.dataset.satkind; satChanged(); });
    const ss = document.getElementById("showSat");
    if (ss) ss.onclick = () => showSatView(null);
    const sr = document.getElementById("satRetry");
    if (sr) sr.onclick = () => { state.sat.analyses = {}; renderPointPanel(); };
    els.panel.querySelectorAll("[data-spot]").forEach((b) => b.onclick = () => {
      const [lat, lon, cls] = b.dataset.spot.split(",");
      const li = b.closest("li");
      showSatView(+lat, +lon, 13, `${cls === "cool" ? "Coolest" : "Hottest"} 1 km: ${li.querySelector("b").textContent}`);
    });
    els.panel.querySelectorAll("[data-tool-btn]").forEach((b) => b.addEventListener("click", () => {
      if (isLst()) setLayer("apparent");
      if (state.tool !== b.dataset.toolBtn) setTool(b.dataset.toolBtn);
      if (window.innerWidth <= 900) document.querySelector(".mapwrap").scrollIntoView({ behavior: "smooth" });
    }));
  }

  function emergencyBlock() {
    return `<div class="emergency">Heat emergency? Call <strong>108</strong> for an ambulance, or <strong>112</strong>.</div>`;
  }
  function aboutBlock() {
    return `<section class="card"><details class="acc flat"><summary>About this data</summary>
      <p class="note">Live readings and forecasts come from the free Open-Meteo API, which blends national weather-service models (resolution about 2–11 km). The map shows how heat varies across a city at that scale. Street-level differences, such as a concrete market versus a park, need satellite surface-temperature data and are not shown.
      Heat history uses NASA POWER daily maximum temperatures since 1990 (satellite and model data, roughly 50 km grid).
      The satellite view shows NASA MODIS land surface temperature (8-day averages, ~1 km) and vegetation greenness (NDVI, ~250 m) from NASA GIBS, over Sentinel-2 cloudless imagery by EOX.
      Zones use the “feels like” temperature, which combines air temperature, humidity and wind, with the standard heat-index bands. UV categories follow the WHO Global Solar UV Index. Precautions are adapted from India's NDMA heatwave guidance.</p>
      <p class="note"><b>Tree simulator:</b> each tree patch stands for a small urban forest. It cools by up to ${HM.SIM.tree.peak}°C at its centre (urban forests average about 1.6°C cooler than built-up surroundings), fading to almost nothing by about 1.25 km away, the distance park cooling has been measured to reach. Overlapping patches add up with diminishing returns, capped at ${HM.SIM.tree.cap}°C, the peak daytime cooling trees achieve in hot, dry climates. At night the effect is cut to ${Math.round(HM.SIM.tree.nightFactor * 100)}%. Cool roofs lower indoor temperatures by about 2–5°C but barely change outdoor air, so they don't alter the map. These are estimates for exploring ideas, not predictions for a specific site.</p>
      <p class="note">Data refreshes every 15 minutes. This site does not issue official warnings.</p>
      <ul class="tips">${HM.SOURCES.map((s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul></details></section>`;
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
      state.india = await fetchForecast(HM.CITIES);
      els.timebar.hidden = isLst();
      drawCityMarkers();
      if (state.mode === "india") renderIndiaPanel();
      if (state.mode !== "city" || state.grid) status("Live data loaded", "ok");
    } catch (e) {
      state.india = null;
      status(e.message, "error", loadIndia);
      if (state.mode === "india") els.panel.innerHTML = `${hero("Something went wrong", "Couldn't load live data", esc(e.message))}${emergencyBlock()}`;
    }
  }

  function leaveCity() {
    state.grid = null;
    state.focus = null;
    base = null;
    featureLayer.clearLayers();
    state.features = [];
    if (state.tool) setTool(state.tool);
    if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
  }

  function goIndia(push = true) {
    state.mode = "india";
    leaveCity();
    els.simbar.hidden = true;
    els.simMeter.hidden = true;
    els.city.value = "";
    drawOverlay();
    drawLegend();
    map.flyTo([22.8, 80.5], 5, { duration: 0.8 });
    if (push) setHash("");
    if (state.india) { drawCityMarkers(); renderIndiaPanel(); } else loadIndia();
    if (isLst()) loadSatCityVals();
  }

  async function goCity(city, push = true) {
    if (!city) return goIndia(push);
    state.mode = "city";
    state.contrast = false;
    state.autoContrastDone = false;
    leaveCity();
    els.city.value = city.name;
    if (push) setHash("city-" + slug(city.name));
    const g = buildGrid(city);
    g.city = city;
    map.flyToBounds(g.bounds, { duration: 0.8, padding: [10, 10] });
    panelLoading(city.name);
    if (!state.india) loadIndia(); else drawCityMarkers();
    drawOverlay();
    drawLegend();
    const id = ++state.reqId;
    status(`Loading heat map for ${city.name}…`);
    try {
      const locs = await fetchForecast(g.pts);
      if (id !== state.reqId) return;
      g.locs = locs;
      state.grid = g;
      els.timebar.hidden = isLst();
      els.simbar.hidden = isLst();
      const centre = locs[Math.floor((GRID_N * GRID_N) / 2)];
      state.focus = { loc: centre, title: city.name, subtitle: `${city.state} · city centre · tap anywhere on the map to check another spot`, terrain: city.terrain, lat: city.lat, lon: city.lon };
      drawOverlay();
      drawLegend();
      renderPointPanel();
      status("Heat map ready", "ok");
    } catch (e) {
      if (id !== state.reqId) return;
      status(e.message, "error", () => goCity(city, false));
      els.panel.innerHTML = `${hero("Something went wrong", city.name, "Couldn't load live data: " + esc(e.message))}${emergencyBlock()}`;
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
    const baseCity = state.grid ? state.grid.city : near;
    panelLoading(title);
    const id = ++state.reqId;
    try {
      const [loc] = await fetchForecast([{ lat, lon }]);
      if (id !== state.reqId) return;
      state.focus = {
        loc, title, lat, lon, terrain: baseCity.terrain,
        subtitle: subtitle || `${offsetText(lat, lon, baseCity)} ${baseCity.name} · ${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`
      };
      renderPointPanel();
    } catch (e) {
      if (id !== state.reqId) return;
      status(e.message, "error", () => inspectPoint(lat, lon, title, subtitle));
      els.panel.innerHTML = `${hero("Something went wrong", title, "Couldn't load live data: " + esc(e.message))}${emergencyBlock()}`;
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

  let satAutoBasemap = false;
  function setLayer(layer) {
    const wasLst = isLst();
    state.layer = layer;
    if (isLst()) {
      if (!satAutoBasemap) { satAutoBasemap = true; setBasemap("sat"); }
      if (state.tool) setTool(state.tool);
      if (state.playing) els.play.click();
    }
    els.timebar.hidden = isLst() || !state.india;
    els.simbar.hidden = isLst() || state.mode !== "city" || !state.grid;
    if (isLst()) els.simMeter.hidden = true; else if (wasLst) updateSimMeter();
    featureLayer.getPane && (isLst() ? map.removeLayer(featureLayer) : (!map.hasLayer(featureLayer) && featureLayer.addTo(map)));
    updateLstTiles();
    document.querySelectorAll(".seg button[data-layer]").forEach((b) => {
      const on = b.dataset.layer === layer;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    drawCityMarkers();
    drawOverlay();
    drawLegend();
    renderPanel();
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
  document.querySelectorAll(".seg button[data-layer]").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layer)));
  document.querySelectorAll("[data-basemap]").forEach((b) => b.addEventListener("click", () => setBasemap(b.dataset.basemap)));
  els.simbar.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.getElementById("simReset").addEventListener("click", resetFeatures);
  els.slider.addEventListener("input", () => setHour(+els.slider.value));
  els.play.addEventListener("click", () => {
    if (state.playing) { clearInterval(state.playing); state.playing = null; els.play.textContent = "▶"; return; }
    els.play.textContent = "❚❚";
    state.playing = setInterval(() => setHour((state.hour + 1) % HOURS), 900);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.tool) setTool(state.tool); });
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

  // refresh live data every 15 minutes (planted trees are kept)
  setInterval(async () => {
    cache.clear();
    await loadIndia();
    if (state.mode === "city" && state.grid) {
      try {
        const locs = await fetchForecast(state.grid.pts);
        state.grid.locs = locs;
        base = null;
        if (state.focus && state.focus.title === state.grid.city.name) state.focus.loc = locs[Math.floor((GRID_N * GRID_N) / 2)];
        drawOverlay(); drawLegend(); renderPointPanel();
      } catch (_) { /* keep showing the last data */ }
    }
  }, CACHE_MS);

  applySky("mild");
  drawLegend();
  routeFromHash();
})();
