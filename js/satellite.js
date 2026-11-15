/* Satellite data from NASA GIBS (no key, CORS-enabled):
 *  - MODIS Terra land surface temperature, 8-day composites, ~1 km (zoom 7 tiles)
 *  - MODIS Terra NDVI (vegetation greenness), 8-day, ~250 m (zoom 9 tiles)
 * Tiles are colour-coded PNGs; GIBS publishes the colour maps, so each pixel's
 * colour is turned back into a value.
 */
window.HM = window.HM || {};
HM.SAT = (function () {
  "use strict";

  const BASE = "https://gibs.earthdata.nasa.gov/";
  const LST = { day: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", night: "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night" };
  const NDVI = "MODIS_Terra_NDVI_8Day";
  const LST_TMS = "GoogleMapsCompatible_Level7", LST_Z = 7;
  const NDVI_TMS = "GoogleMapsCompatible_Level9", NDVI_Z = 9;
  const CMAPS = {
    lst: BASE + "colormaps/v1.3/MODIS_Land_Surface_Temp.xml",
    ndvi: BASE + "colormaps/v1.3/MODIS_NDVI.xml"
  };
  const DAY = 86400000;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const tileUrl = (layer, date, tms, z, y, x) => `${BASE}wmts/epsg3857/best/${layer}/default/${date}/${tms}/${z}/${y}/${x}.png`;
  const leafletUrl = (kind, date) => `${BASE}wmts/epsg3857/best/${LST[kind]}/default/${date}/${LST_TMS}/{z}/{y}/{x}.png`;

  /* ---------- colour maps: "r,g,b" -> value ---------- */
  const lutPromises = {};
  function loadLut(name) {
    if (lutPromises[name]) return lutPromises[name];
    lutPromises[name] = fetch(CMAPS[name]).then((r) => {
      if (!r.ok) throw new Error("colour map " + r.status);
      return r.text();
    }).then((txt) => {
      const doc = new DOMParser().parseFromString(txt, "application/xml");
      const map = new Map(), list = [];
      for (const cm of doc.getElementsByTagName("ColorMap")) {
        for (const e of cm.getElementsByTagName("ColorMapEntry")) {
          if (e.getAttribute("nodata") === "true") continue;
          if (name === "ndvi" && e.getAttribute("transparent") === "true") continue;
          const v = e.getAttribute("value");
          const m = v && v.match(/[\[(]\s*([-\d.]+)\s*,\s*([-\d.]+)\s*[\])]/);
          if (!m) continue;
          let val = (+m[1] + +m[2]) / 2;
          if (name === "lst") { if (+m[1] < 150) continue; val -= 273.15; } // Kelvin -> °C, skip the catch-all bin
          const rgb = e.getAttribute("rgb");
          map.set(rgb, val);
          list.push([val, rgb.split(",").map(Number)]);
        }
      }
      list.sort((a, b) => a[0] - b[0]);
      return { map, list };
    });
    lutPromises[name].catch(() => { delete lutPromises[name]; });
    return lutPromises[name];
  }

  /* ---------- Web Mercator ---------- */
  function worldPx(lat, lon, z) {
    const n = 256 * Math.pow(2, z);
    const s = Math.sin(lat * Math.PI / 180);
    return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  function pxToLatLon(x, y, z) {
    const n = 256 * Math.pow(2, z);
    const lon = (x / n) * 360 - 180;
    const k = Math.PI - (2 * Math.PI * y) / n;
    return [(180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k))), lon];
  }

  /* ---------- tiles (decoded RGBA, cached) ---------- */
  const tiles = new Map();
  function getTile(layer, date, tms, z, x, y) {
    const key = `${layer}/${date}/${z}/${x}/${y}`;
    if (tiles.has(key)) return tiles.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timer = setTimeout(() => resolve(null), 15000);
      img.onload = () => {
        clearTimeout(timer);
        try {
          const cv = document.createElement("canvas");
          cv.width = cv.height = 256;
          const g = cv.getContext("2d", { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          resolve(g.getImageData(0, 0, 256, 256).data);
        } catch (_) { resolve(null); }
      };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = tileUrl(layer, date, tms, z, y, x);
    });
    tiles.set(key, p);
    if (tiles.size > 400) tiles.delete(tiles.keys().next().value);
    return p;
  }
  async function rgbaAtPx(layer, date, tms, z, px, py) {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const d = await getTile(layer, date, tms, z, tx, ty);
    if (!d) return null;
    const k = ((Math.floor(py) - ty * 256) * 256 + (Math.floor(px) - tx * 256)) * 4;
    return [d[k], d[k + 1], d[k + 2], d[k + 3]];
  }

  /* ---------- dates: 8-day periods restart on 1 January ---------- */
  const fmt = (d) => d.toISOString().slice(0, 10);
  const parse = (s) => new Date(s + "T00:00:00Z");
  function todayUTC() { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); }
  function periodStart(d) {
    const y = d.getUTCFullYear();
    const doy = Math.floor((d - Date.UTC(y, 0, 1)) / DAY) + 1;
    return new Date(Date.UTC(y, 0, 1 + 8 * Math.floor((doy - 1) / 8)));
  }
  function periodEnd(start) {
    const end = new Date(start.getTime() + 7 * DAY);
    const dec31 = new Date(Date.UTC(start.getUTCFullYear(), 11, 31));
    return end > dec31 ? dec31 : end;
  }
  function periodLabel(date) {
    const s = parse(date), e = periodEnd(s);
    const sameMonth = s.getUTCMonth() === e.getUTCMonth();
    return `${s.getUTCDate()}${sameMonth ? "" : " " + MON[s.getUTCMonth()]}–${e.getUTCDate()} ${MON[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
  }
  function summerDate() {
    const t = todayUTC();
    let y = t.getUTCFullYear();
    if (t < Date.UTC(y, 5, 15)) y -= 1;
    return fmt(periodStart(new Date(Date.UTC(y, 4, 25)))); // the 8-day period around 25 May
  }
  const latestCache = {};
  async function latestDate(kind, lat, lon) {
    if (latestCache[kind]) return latestCache[kind];
    const t = todayUTC();
    let d = periodStart(t);
    const [px, py] = worldPx(lat, lon, LST_Z);
    for (let i = 0; i < 6; i++) {
      if (d.getTime() + 10 * DAY <= t.getTime()) {
        const tile = await getTile(LST[kind], fmt(d), LST_TMS, LST_Z, Math.floor(px / 256), Math.floor(py / 256));
        if (tile) { latestCache[kind] = fmt(d); return latestCache[kind]; }
      }
      d = periodStart(new Date(d.getTime() - DAY));
    }
    latestCache[kind] = fmt(d);
    return latestCache[kind];
  }
  function ndviDateFor(lstDate) {
    // NDVI is published daily as a rolling 8-day composite: use the end of the LST window, not after yesterday
    const end = periodEnd(parse(lstDate));
    const y = new Date(todayUTC().getTime() - 2 * DAY);
    return fmt(end < y ? end : y);
  }

  /* ---------- values ---------- */
  async function lstAt(kind, date, lat, lon) {
    const [lut, px] = await Promise.all([loadLut("lst"), Promise.resolve(worldPx(lat, lon, LST_Z))]);
    const c = await rgbaAtPx(LST[kind], date, LST_TMS, LST_Z, px[0], px[1]);
    if (!c || c[3] === 0) return null;
    const v = lut.map.get(`${c[0]},${c[1]},${c[2]}`);
    return v == null ? null : v;
  }

  /* Compare surface temperature of the greenest third vs the least green third of
   * land within radiusKm of a point (relative split, so it works for green and dry cities) */
  async function ndviCell(lut, date, px, py) {
    let sum = 0, n = 0, water = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      // 4 x 4 NDVI pixels (250 m) sit inside each 1 km LST pixel
      const q = await rgbaAtPx(NDVI, date, NDVI_TMS, NDVI_Z, px * 4 + sx + 0.5, py * 4 + sy + 0.5);
      if (!q) continue;
      if (q[3] === 0) { water++; continue; }
      const nv = lut.map.get(`${q[0]},${q[1]},${q[2]}`);
      if (nv != null) { sum += nv; n++; }
    }
    return { ndvi: n ? sum / n : null, water: water >= 8 };
  }
  async function analyse(kind, date, lat, lon, radiusKm) {
    const [lstLut, ndviLut] = await Promise.all([loadLut("lst"), loadLut("ndvi").catch(() => null)]);
    const dLat = radiusKm / 111.2, dLon = radiusKm / (111.2 * Math.cos(lat * Math.PI / 180));
    const [x0, y0] = worldPx(lat + dLat, lon - dLon, LST_Z), [x1, y1] = worldPx(lat - dLat, lon + dLon, LST_Z);
    const ndviDate = ndviDateFor(date);
    const cells = [];
    let cloudy = 0, seaOrNoData = 0;
    for (let py = Math.floor(y0); py <= Math.floor(y1); py++) {
      for (let px = Math.floor(x0); px <= Math.floor(x1); px++) {
        const [clat, clon] = pxToLatLon(px + 0.5, py + 0.5, LST_Z);
        const dist = Math.hypot((clat - lat) * 111.2, (clon - lon) * 111.2 * Math.cos(lat * Math.PI / 180));
        if (dist > radiusKm) continue;
        const c = await rgbaAtPx(LST[kind], date, LST_TMS, LST_Z, px + 0.5, py + 0.5);
        const v = c && c[3] !== 0 ? lstLut.map.get(`${c[0]},${c[1]},${c[2]}`) : null;
        const nd = ndviLut ? await ndviCell(ndviLut, ndviDate, px, py) : { ndvi: null, water: false };
        if (v == null) { if (nd.water) seaOrNoData++; else cloudy++; continue; }
        cells.push({ v, lat: clat, lon: clon, ndvi: nd.ndvi, water: nd.water, dist });
      }
    }
    const landTotal = cells.length + cloudy;
    if (!cells.length) return { cells: 0, cloudy, landTotal, seaOrNoData };
    const mean = (arr, k) => arr.reduce((s, c) => s + c[k || "v"], 0) / arr.length;
    const land = cells.filter((c) => !c.water && c.ndvi != null).sort((a, b) => b.ndvi - a.ndvi);
    const third = Math.floor(land.length / 3);
    const water = cells.filter((c) => c.water);
    const byV = cells.slice().sort((a, b) => a.v - b.v);
    let green = null, grey = null;
    if (third >= 10) {
      const g = land.slice(0, third), b = land.slice(land.length - third);
      green = { n: g.length, mean: mean(g), ndvi: mean(g, "ndvi") };
      grey = { n: b.length, mean: mean(b), ndvi: mean(b, "ndvi") };
    }
    return {
      date, kind, ndviDate, cells: cells.length, cloudy, landTotal, seaOrNoData,
      mean: mean(cells),
      coolest: byV[0], hottest: byV[byV.length - 1],
      green, grey,
      water: water.length >= 3 ? { n: water.length, mean: mean(water) } : null,
      hasNdvi: !!ndviLut
    };
  }

  /* ---------- legend colours ---------- */
  async function colorFor(v) {
    const lut = await loadLut("lst");
    return nearestColor(lut, v);
  }
  function nearestColor(lut, v) {
    const l = lut.list;
    if (!l.length) return [128, 128, 128];
    let lo = 0, hi = l.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (l[mid][0] < v) lo = mid + 1; else hi = mid; }
    return l[lo][1];
  }
  async function legendGradient(min, max) {
    const lut = await loadLut("lst");
    const stops = [];
    for (let i = 0; i <= 10; i++) {
      const v = min + ((max - min) * i) / 10;
      const c = nearestColor(lut, v);
      stops.push(`rgb(${c[0]},${c[1]},${c[2]}) ${i * 10}%`);
    }
    return { css: `linear-gradient(90deg,${stops.join(",")})`, colorAt: (v) => nearestColor(lut, v) };
  }

  return { leafletUrl, latestDate, summerDate, periodLabel, lstAt, analyse, colorFor, legendGradient, loadLut };
})();
