# ParkSmart SG

ParkSmart SG is a lightweight browser app for comparing nearby Singapore carparks and finding the cheapest parking plan for a specific trip.

It combines geocoded HDB carpark locations (2,000+ carparks), OneMap geocoding, a curated set of private or mall carparks, and a larger CSV-sourced dataset of ~980 private/mall carparks. Instead of only showing the cheapest single carpark, it can also model plans where you move your car mid-stay to take advantage of entry caps, evening flat-fee windows, or night rates.

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
styles.css                     UI styles (mobile-friendly)
js/app.js                      App flow, map, geocoding, result rendering
js/optimizer.js                Parking-plan optimization logic
js/rates.js                    HDB and tariff cost calculations
js/privateCarparks.js          Curated private and mall carpark dataset
js/csvCarparks.js              Auto-generated private/mall dataset
js/hdbCarparks.js              Auto-generated HDB carpark snapshot
scripts/                       Data-pipeline scripts (scraping, merging, building)
data/                          Intermediate CSV datasets
CarparkRates.csv               Raw private/mall tariff rows (seed data)
```

## Run locally

Because the app uses OneMap for live geocoding, serve it over HTTP instead of opening `index.html` directly.

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
- data.gov.sg HDB Carpark Information dataset (bundled as a snapshot in `js/hdbCarparks.js`)
- motorist.sg for private/mall carpark tariffs (scraped, merged into `js/csvCarparks.js`)
- Curated private and mall carpark data in `js/privateCarparks.js`

## Notes and limitations

- Public holidays are not detected automatically; select "Sunday / Public Holiday" from the day-of-visit dropdown manually
- Private carpark tariffs are curated or parsed estimates and may change without notice
- Tiered "$X for first 2 hours" rates are approximated as a flat first-hour rate plus the subsequent per-30-min rate
- Carpark availability is not included; the app focuses on cost optimization
- HDB locations are bundled as a static snapshot — re-run `node scripts/buildHdbCarparks.mjs` every few months to refresh

## Updating data

There are two private/mall sources:

1. **Curated (`js/privateCarparks.js`)** — hand-maintained entries; these take precedence on name collisions.
2. **CSV-sourced (`js/csvCarparks.js`)** — auto-generated from `data/carparks.csv` + `data/rates.csv`.

To regenerate the CSV-sourced dataset:

```bash
node scripts/buildFromCleanCsv.mjs
```

To refresh the HDB carpark snapshot:

```bash
node scripts/buildHdbCarparks.mjs
```

## Tech stack

- HTML, CSS, and vanilla JavaScript
- Leaflet for mapping
- OneMap for geocoding
