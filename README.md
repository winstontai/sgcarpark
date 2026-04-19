# ParkSmart SG

ParkSmart SG is a lightweight browser app for comparing nearby Singapore carparks and finding the cheapest parking plan for a specific trip.

It combines live HDB location data, OneMap geocoding, and a curated set of private or mall carparks. Instead of only showing the cheapest single carpark, it can also model plans where you move your car mid-stay to take advantage of entry caps or night rates.

## What it does

- Search by postal code or address using OneMap
- Compare nearby HDB and private carparks within a custom walking radius
- Estimate total parking cost for the exact arrival time and stay duration
- Generate alternative plans with 0 to 3 car moves
- Surface savings versus the "park once" baseline
- Plot destination and candidate carparks on an interactive Leaflet map

## How it works

The optimizer splits a stay at natural pricing boundaries such as `7:00` and `22:30`, prices each continuous block across every nearby carpark, and then uses dynamic programming to find the lowest-cost plan within the allowed number of moves.

This helps the app handle cases like:

- HDB daytime vs night pricing
- Mall carparks with per-entry caps
- Switching to a cheaper night-rate carpark later in the stay
- Re-entering a capped carpark to reset the cap

## Project structure

```text
index.html           Main app shell
styles.css           UI styles
js/app.js            App flow, map, geocoding, result rendering
js/optimizer.js      Parking-plan optimization logic
js/rates.js          HDB and tariff cost calculations
js/privateCarparks.js Curated private and mall carpark dataset
js/svy21.js          SVY21 to WGS84 coordinate conversion
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

- Public holidays are not detected automatically; use the weekend or PH toggle manually
- Private carpark tariffs are curated estimates and may change without notice
- Carpark availability is not included; the app focuses on cost optimization
- HDB location data is cached in `localStorage` for 24 hours to reduce repeated API calls

## Updating private carparks

To update a private carpark, edit the matching entry in `js/privateCarparks.js`.

To add a new one, copy an existing object and update:

- `car_park_no`
- `name`
- `address`
- `lat` and `lng`
- `tariff`

## Tech stack

- HTML, CSS, and vanilla JavaScript
- Leaflet for mapping
- OneMap and data.gov.sg APIs
