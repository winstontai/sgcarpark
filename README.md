# ParkSmart SG

ParkSmart SG is a lightweight browser app for comparing nearby Singapore carparks and finding the cheapest parking plan for a specific trip.

It combines live HDB location data, OneMap geocoding, a curated set of private or mall carparks, and an additional CSV-sourced dataset of ~230 private/mall carparks. Instead of only showing the cheapest single carpark, it can also model plans where you move your car mid-stay to take advantage of entry caps, evening flat-fee windows, or night rates.

## What it does

- Search by postal code or address using OneMap
- Compare nearby HDB and private carparks within a custom walking radius
- Estimate total parking cost for the exact arrival time and stay duration
- Pick day type (Weekday / Saturday / Sunday+PH) to apply the correct tariff, including the HDB Free Parking Scheme on Sundays and public holidays
- Generate alternative plans with 0 to 3 car moves
- Surface savings versus the "park once" baseline
- Plot destination and candidate carparks on an interactive Leaflet map

## How it works

The optimizer splits a stay at natural pricing boundaries (HDB `7:00` and `22:30`, plus each private carpark's chargeable-window edges and evening-flat-fee window edges), prices each continuous block across every nearby carpark, and then uses dynamic programming to find the lowest-cost plan within the allowed number of moves.

This helps the app handle cases like:

- HDB daytime vs night pricing (with per-night $5 cap)
- HDB Free Parking Scheme on Sunday/PH for non-central carparks
- Mall carparks with per-entry caps
- Evening flat-fee windows (e.g. "$5 per entry after 6pm")
- Tiered "$X for first hour, $Y per 30 min after" pricing
- Switching to a cheaper night-rate or evening-flat carpark later in the stay
- Re-entering a capped carpark to reset the cap

## Project structure

```text
index.html                     Main app shell
styles.css                     UI styles
js/app.js                      App flow, map, geocoding, result rendering
js/optimizer.js                Parking-plan optimization logic
js/rates.js                    HDB and tariff cost calculations
js/privateCarparks.js          Curated private and mall carpark dataset
js/csvCarparks.js              Auto-generated dataset from CarparkRates.csv
js/svy21.js                    SVY21 to WGS84 coordinate conversion
scripts/buildCsvCarparks.mjs   Node builder that parses CarparkRates.csv
CarparkRates.csv               Raw private/mall tariff rows (source data)
```

## Run locally

Because the app fetches remote APIs in the browser, serve it over HTTP instead of opening `index.html` directly.

### Python

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

### Node

```bash
npx serve .
```

## Data sources

- OneMap Search API for geocoding
- data.gov.sg HDB Carpark Information dataset for HDB carpark locations
- Curated private and mall carpark data in `js/privateCarparks.js`

## Notes and limitations

- Public holidays are not detected automatically; select "Sunday / Public Holiday" from the day-of-visit dropdown manually
- Private carpark tariffs are curated or parsed estimates and may change without notice
- Tiered "$X for first 2 hours" rates from the CSV dataset are approximated as a flat first-hour rate plus the subsequent per-30-min rate
- Carpark availability is not included; the app focuses on cost optimization
- HDB location data is cached in `localStorage` for 24 hours to reduce repeated API calls

## Updating private carparks

There are two sources:

1. **Curated (`js/privateCarparks.js`)** - hand-maintained entries; these take precedence on name collisions.
2. **CSV-sourced (`js/csvCarparks.js`)** - auto-generated from `CarparkRates.csv`.

To update a curated carpark, edit the matching entry in `js/privateCarparks.js`.

To regenerate the CSV-sourced dataset after editing `CarparkRates.csv`:

```bash
node scripts/buildCsvCarparks.mjs
```

The builder geocodes each row via OneMap and caches results in `scripts/.geocode-cache.json` (git-ignored) so reruns are fast.

## Tech stack

- HTML, CSS, and vanilla JavaScript
- Leaflet for mapping
- OneMap and data.gov.sg APIs
