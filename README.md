# UrbanHeat India

A live heat-stress and UV index map for 38 Indian cities, with safety precautions for each heat zone.

## Features

- **India overview:** every city coloured by its live "feels like" temperature, actual temperature or UV index, plus a ranked list of the hottest cities.
- **City heat map:** a live heat surface from 81 forecast points covering about 60 × 60 km around the city. Hover to read values, or click any spot for full details.
- **Highlight local hotspots:** stretches the colours to the city's own range so the hottest and coolest areas stand out. The panel lists the top 3 hotspots and the coolest area.
- **24-hour forecast slider** with play/pause, and an hourly chart of temperature, feels-like temperature and UV index.
- **Heat zones** (Comfortable → Extreme danger) from the feels-like temperature, using standard heat-index bands, with precautions for each zone.
- **UV readings:** current UV and today's peak, using WHO UV categories and their sun-safety advice.
- **IMD heatwave check:** compares the day's forecast maximum with IMD thresholds (plains 40/45/47°C, coastal 37°C, hills 30°C). It's an indicator, not an official warning.
- Advice for high-risk groups, heatstroke warning signs and first aid, and emergency numbers (108 / 112).
- "My location", shareable city links (`#city-delhi`) and a mobile layout.

## Data

| What | Source |
|---|---|
| Temperature, feels-like, humidity, UV index (live + hourly forecast) | [Open-Meteo](https://open-meteo.com/) forecast API (free, no key, CC BY 4.0) |
| Heatwave thresholds | India Meteorological Department criteria |
| Precautions | NDMA heat-wave do's & don'ts; WHO Global Solar UV Index |
| Base map | © OpenStreetMap contributors, © CARTO |

Data refreshes every 15 minutes. Model resolution is roughly 2–11 km, so the map shows heat variation at neighbourhood-to-district scale. It can't tell one street from the next. That would need satellite land-surface temperature (Landsat / MODIS).

## Run locally

It's a static site with no build step:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

Push to GitHub, then go to **Settings → Pages → Deploy from a branch → `main` / root**. Netlify and Vercel also work with zero configuration.

## Project layout

```
index.html          page shell
css/style.css       styles
js/data.js          cities, heat/UV bands, guidance text
js/app.js           map, live data, heat surface, panel, chart
vendor/             Leaflet 1.9.4 and Chart.js 4 (bundled, no CDN needed)
```

To add a city, append it to `HM.CITIES` in `js/data.js` with its terrain (`plains`, `coastal` or `hilly`).

*Not an official warning service. Always follow IMD and local authority alerts.*
