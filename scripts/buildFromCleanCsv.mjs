// Joins data/carparks.csv + data/rates.csv into js/csvCarparks.js in the shape
// js/app.js + js/rates.js already consume. Replaces the old pipeline that built
// from CarparkRates.csv; no app code changes needed.
//
// Run: node scripts/buildFromCleanCsv.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CARPARKS_CSV = join(ROOT, "data", "carparks.csv");
const RATES_CSV = join(ROOT, "data", "rates.csv");
const OUT_PATH = join(ROOT, "js", "csvCarparks.js");

function parseCsv(text) {
  const rows = [];
  let cur = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { cur.push(f); f = ""; }
      else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; }
      else if (c === "\r") { /* skip */ }
      else f += c;
    }
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}

// "07:00" -> 420, "24:00" -> 1440, "01:00 +1d" -> 1500
function minFromTime(t) {
  if (!t) return null;
  const s = t.trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})(?:\s*\+1d)?$/);
  if (!m) return null;
  let mins = +m[1] * 60 + +m[2];
  if (/\+1d/.test(s)) mins += 1440;
  return mins;
}

// Cap at 1440 for same-day representation the tariff schema expects.
function capDay(mins) {
  if (mins == null) return null;
  return Math.min(mins, 1440);
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = +v;
  return isNaN(n) ? null : n;
}

// Primary-window rate in $/30min. Returns { rate_per_30min, first_hour_rate?, subsequent_rate_per_30min?, per_entry_flat? }
function extractPrimaryRate(row) {
  switch (row.rate_type) {
    case "free":
      return { rate_per_30min: 0, isFree: true };
    case "hourly":
      return { rate_per_30min: row.rate_30min };
    case "per_min":
      return row.rate_per_min != null ? { rate_per_30min: row.rate_per_min * 30 } : null;
    case "tiered": {
      // first_hour OR first_Nhr (e.g. $2.14 covers 1st 120 min).
      // rates.js only supports a 1-hour flat, so we collapse N-hour flat onto first_hour_rate.
      // Slightly overcharges for stays 60..Nhr*60 min, otherwise matches.
      const firstFlat = row.first_hour ?? row.first_Nhr;
      if (firstFlat == null && row.rate_30min == null) return null;
      return {
        rate_per_30min: row.rate_30min ?? firstFlat,
        first_hour_rate: firstFlat,
        subsequent_rate_per_30min: row.rate_30min
      };
    }
    case "per_entry":
      return row.per_entry != null
        ? { rate_per_30min: 0, per_entry_flat: row.per_entry }
        : null;
    default:
      return null; // not_public, or anything unrecognised
  }
}

// Rough single-number $/30min for comparing weekday vs weekend.
function blendedRate(row) {
  const p = extractPrimaryRate(row);
  if (!p) return null;
  if (p.first_hour_rate != null) return p.first_hour_rate / 2;
  return p.rate_per_30min;
}

function buildTariff(rates) {
  // Prefer the `main` facility. If absent (e.g. PARKROYAL only has MSCP +
  // hotel_driveway), fall back to the first non-empty facility.
  let main = rates.filter(r => (r.facility || "main") === "main");
  if (!main.length) {
    const facilities = [...new Set(rates.map(r => r.facility).filter(Boolean))];
    if (facilities.length) main = rates.filter(r => r.facility === facilities[0]);
  }
  if (!main.length) return null;

  // Skip carparks whose every row is a non-hourly scheme we can't price.
  const UNPRICEABLE = new Set(["not_public", "coupon"]);
  if (main.every(r => UNPRICEABLE.has(r.rate_type))) {
    return { _unpriceable: main[0].rate_type };
  }

  // `weekday` covers Mon-Fri uniformly; some carparks split into `mon-thu` +
  // `fri_eve_ph` with different Friday-evening pricing - pick mon-thu as the
  // weekday face since Fri-evening edge case isn't modeled by rates.js.
  const WEEKDAY_GROUPS = ["weekday", "mon-thu", "mon-fri"];
  // Sort by window_start so earliest slot is primary; later slots (e.g. 5pm-7am
  // flat fee) become the evening_per_entry window downstream.
  const byStart = (a, b) => (a.window_start ?? 0) - (b.window_start ?? 0);
  const weekdays = main.filter(r => WEEKDAY_GROUPS.includes(r.day_group)).sort(byStart);
  const sats = main.filter(r => r.day_group === "sat").sort(byStart);

  if (!weekdays.length) return null;

  // Primary = first weekday window.
  const primary = weekdays[0];
  const primRate = extractPrimaryRate(primary);
  if (!primRate) return null;

  const tariff = {
    rate_per_30min: primRate.rate_per_30min ?? 0,
    first_free_minutes: 0,
    per_entry_cap: null,
    chargeable_start: primary.window_start ?? 0,
    chargeable_end: capDay(primary.window_end) ?? 1440
  };
  if (primRate.first_hour_rate != null) tariff.first_hour_rate = primRate.first_hour_rate;
  if (primRate.subsequent_rate_per_30min != null) tariff.subsequent_rate_per_30min = primRate.subsequent_rate_per_30min;

  // Flat per-entry with no hourly component - surface as a per_entry_cap and leave rate_per_30min=0.
  if (primRate.per_entry_flat != null) {
    tariff.per_entry_cap = primRate.per_entry_flat;
  }

  // Evening-flat window: later weekday rows that are per_entry with a start time.
  for (let i = 1; i < weekdays.length; i++) {
    const w = weekdays[i];
    if (w.rate_type === "per_entry" && w.per_entry != null && w.window_start != null) {
      tariff.evening_per_entry = {
        start_min: w.window_start,
        end_min: capDay(w.window_end) ?? 1440,
        price: w.per_entry
      };
      break;
    }
  }

  // Weekend: if Saturday's blended rate differs from weekday's, expose it.
  if (sats.length) {
    const wRate = blendedRate(primary);
    const sRate = blendedRate(sats[0]);
    if (wRate != null && sRate != null && Math.abs(wRate - sRate) > 0.01) {
      // rates.js reads weekend_rate_per_30min as the primary weekend rate.
      tariff.weekend_rate_per_30min = extractPrimaryRate(sats[0])?.rate_per_30min ?? sRate;
    }
  }

  return tariff;
}

function notesFor(rates) {
  const main = rates.filter(r => (r.facility || "main") === "main");
  const w = main.filter(r => r.day_group === "weekday").map(r => r.raw).filter(Boolean);
  const s = main.filter(r => r.day_group === "sat").map(r => r.raw).filter(Boolean);
  const parts = [];
  if (w.length) parts.push("Mon-Fri: " + w.join(" | "));
  if (s.length && s.join("|") !== w.join("|")) parts.push("Sat: " + s[0]);
  return parts.join(" || ").slice(0, 200);
}

function main() {
  const cpRows = parseCsv(readFileSync(CARPARKS_CSV, "utf8"));
  const cpHeader = cpRows.shift();
  const cpIdx = {
    id: cpHeader.indexOf("carpark_id"),
    name: cpHeader.indexOf("name"),
    lat: cpHeader.indexOf("lat"),
    lng: cpHeader.indexOf("lng"),
    address: cpHeader.indexOf("address")
  };

  const rtRows = parseCsv(readFileSync(RATES_CSV, "utf8"));
  const rtHeader = rtRows.shift();
  const ri = name => rtHeader.indexOf(name);
  const idxC = ri("carpark_id"), idxF = ri("facility"), idxD = ri("day_group");
  const idxWs = ri("window_start"), idxWe = ri("window_end"), idxT = ri("rate_type");
  const idxFh = ri("first_hour"), idxR30 = ri("rate_30min"), idxRpm = ri("rate_per_min"), idxPe = ri("per_entry"), idxRaw = ri("raw");

  // Group rates by carpark_id.
  const byId = new Map();
  for (const row of rtRows) {
    const id = row[idxC];
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({
      facility: row[idxF],
      day_group: row[idxD],
      window_start: minFromTime(row[idxWs]),
      window_end: minFromTime(row[idxWe]),
      rate_type: row[idxT],
      first_hour: numOrNull(row[idxFh]),
      rate_30min: numOrNull(row[idxR30]),
      rate_per_min: numOrNull(row[idxRpm]),
      per_entry: numOrNull(row[idxPe]),
      raw: row[idxRaw]
    });
  }

  const out = [];
  const skipped = [];

  for (const row of cpRows) {
    const id = row[cpIdx.id];
    if (!id) continue;
    const name = row[cpIdx.name];
    const lat = +row[cpIdx.lat];
    const lng = +row[cpIdx.lng];
    const address = row[cpIdx.address] || "";

    if (!isFinite(lat) || !isFinite(lng)) {
      skipped.push({ id, name, reason: "no coords" });
      continue;
    }
    const rates = byId.get(id);
    if (!rates || !rates.length) {
      skipped.push({ id, name, reason: "no rates" });
      continue;
    }
    const tariff = buildTariff(rates);
    if (!tariff) {
      skipped.push({ id, name, reason: "unparseable rates" });
      continue;
    }
    if (tariff._unpriceable) {
      skipped.push({ id, name, reason: tariff._unpriceable });
      continue;
    }

    out.push({
      car_park_no: "CSV_" + id,
      name,
      address,
      lat,
      lng,
      operator: "CSV",
      tariff,
      notes: notesFor(rates)
    });
  }

  // Dedupe by name (same as old build script). Curated PRIVATE_CARPARKS already
  // wins over CSV in app.js, so ordering here doesn't matter for overlaps.
  const seen = new Set();
  const unique = [];
  for (const cp of out) {
    const key = cp.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cp);
  }

  const body =
`// Auto-generated by scripts/buildFromCleanCsv.mjs from data/carparks.csv + data/rates.csv
// Do not edit by hand - regenerate with: node scripts/buildFromCleanCsv.mjs
// Entries: ${unique.length}  Skipped: ${skipped.length}

window.CSV_CARPARKS = ${JSON.stringify(unique, null, 2)};
`;
  writeFileSync(OUT_PATH, body);

  console.log(`Wrote ${unique.length} carparks to js/csvCarparks.js`);
  console.log(`Skipped ${skipped.length}:`);
  for (const s of skipped.slice(0, 40)) console.log(`  - ${s.id}: ${s.reason} (${s.name})`);
  if (skipped.length > 40) console.log(`  ... and ${skipped.length - 40} more`);
}

main();
