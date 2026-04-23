// Merge motorist.sg data into data/carparks.csv + data/rates.csv.
//
// For each motorist carpark:
//   - Match to existing entry by postal code → skip (keep curated data)
//   - New carpark → add with MOT_* id, no lat/lng (geocode separately)
//
// For each motorist rate (Car rows only):
//   - Expand day string → one row per day_group
//   - Convert 12h times → 24h window_start / window_end
//   - Parse free-text rate → structured fields
//
// Run: node scripts/mergeMotorisg.mjs
// After running: node scripts/geocodeCarparks.mjs  (fills in lat/lng)
//               node scripts/buildFromCleanCsv.mjs  (rebuilds js/csvCarparks.js)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CARPARKS_CSV    = join(ROOT, "data", "carparks.csv");
const RATES_CSV       = join(ROOT, "data", "rates.csv");
const MOT_CARPARKS    = join(ROOT, "data", "motorist_carparks.csv");
const MOT_RATES       = join(ROOT, "data", "motorist_rates.csv");

// ---------- CSV helpers ----------

function parseCsv(text) {
  const rows = [];
  let cur = [], f = "", q = false;
  for (const c of text) {
    if (q) {
      if (c === '"') q = false; else f += c;
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

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(fields) {
  return fields.map(csvEscape).join(",");
}

// ---------- Postal code ----------

function extractPostalCode(address) {
  // "Singapore XXXXXX" or "SINGAPORE XXXXXX"
  let m = address.match(/singapore\s+(\d{6})/i);
  if (m) return m[1];
  // "S(XXXXXX)"
  m = address.match(/S\((\d{6})\)/i);
  if (m) return m[1];
  // Last 6-digit block
  const all = [...address.matchAll(/\b(\d{6})\b/g)];
  if (all.length) return all[all.length - 1][1];
  return null;
}

// ---------- Day expansion ----------

// Maps a motorist day string to one or more rates.csv day_group values.
// Returns [] if the day is unrecognized or a parsing artifact.
const DAY_MAP = {
  "Mon - Sun & PH": ["weekday", "sat", "sun_ph"],
  "Mon - Sun":      ["weekday", "sat", "sun_ph"],
  "Mon - Fri & PH": ["weekday", "sun_ph"],
  "Mon - Fri":      ["weekday"],
  "Mon - Sat":      ["weekday", "sat"],
  "Mon - Thu":      ["mon-thu"],
  "Mon":            ["weekday"],
  "Fri - Sun & PH": ["fri_eve_ph", "sat", "sun_ph"],
  "Fri - Sat":      ["fri_eve_ph", "sat"],
  "Fri":            ["fri_eve_ph"],
  "Thu - Sat":      ["sat"],          // Thu folded into Sat for build script
  "Sat - Sun & PH": ["sat", "sun_ph"],
  "Sat - Sun":      ["sat", "sun_ph"],
  "Sat":            ["sat"],
  "Sun & PH":       ["sun_ph"],
  "Sun":            ["sun_ph"],
  "& PH":           ["sun_ph"],
};

function expandDay(dayRaw) {
  const day = dayRaw.trim();
  return DAY_MAP[day] ?? [];
}

// ---------- Time conversion ----------

function toMins(hhmm) {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

// "06:01 AM" → "06:01", "12:00 AM" → "00:00", "12:00 PM" → "12:00", "06:00 PM" → "18:00"
function from12h(t) {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = +m[1], min = +m[2];
  const pm = m[3].toUpperCase() === "PM";
  if (pm) { if (h !== 12) h += 12; }
  else    { if (h === 12) h  = 0;  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// Returns { window_start: "HH:MM", window_end: "HH:MM" or "HH:MM +1d" or "24:00" }
function makeWindow(rawStart, rawEnd) {
  const s = from12h(rawStart);
  const e = from12h(rawEnd);

  if (!s || !e) return { window_start: "00:00", window_end: "24:00" };

  // "12:00 AM" → "12:00 AM": all-day pattern
  if (s === "00:00" && e === "00:00") return { window_start: "00:00", window_end: "24:00" };

  const sMins = toMins(s);
  const eMins = toMins(e);

  // End at midnight (00:00) with non-midnight start = end of day = 24:00
  if (eMins === 0 && sMins > 0) return { window_start: s, window_end: "24:00" };

  // Normal: end after start
  if (eMins > sMins) return { window_start: s, window_end: e };

  // Crosses midnight
  return { window_start: s, window_end: e + " +1d" };
}

// ---------- Rate text parser ----------

function parseRate(raw) {
  let text = raw.trim();

  // No parking
  if (/^no\s+parking$/i.test(text)) return null;

  // Free parking
  if (/^free(?:\s+parking)?$/i.test(text)) return { rate_type: "free" };

  // Strip leading grace-period prefix (any number of mins/hours)
  text = text.replace(/^\d+\s+(?:min|mins|hour|hours)\s+grace\s+period;\s*/i, "");
  text = text.replace(/^hour\s+grace\s+period;\s*/i, "");

  // Strip trailing cap: "; Capped at $X"
  text = text.replace(/;\s*capped\s+at\s+\$[0-9.]+\s*$/i, "").trim();

  // Re-check after stripping
  if (/^free(?:\s+parking)?$/i.test(text)) return { rate_type: "free" };
  if (/^per\s+\d+\s+mins?\s+free$/i.test(text)) return { rate_type: "free" };
  if (/^per\s+\d+\s+mins?\s+free;/i.test(text)) {
    // e.g. "Per 0 mins free; ..." — treat as free
    return { rate_type: "free" };
  }

  // $0.00 per entry = free
  const zeroM = text.match(/^\$0(?:\.0+)?\s+per\s+entry/i);
  if (zeroM) return { rate_type: "free" };

  // Lone "Capped at $X" → no rate info
  if (/^capped\s+at\s+\$/i.test(text)) return null;

  let m;

  // Per minute: "$X per min" or "Per min $X"
  m = text.match(/^\$([0-9.]+)\s+per\s+min(?:ute)?(?:;|$)/i) ||
      text.match(/^Per\s+min(?:ute)?\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "per_min", rate_per_min: +m[1] };

  // "First N mins free; Subsequent M mins/hour $Y" → hourly
  m = text.match(/^First\s+\d+\s+mins?\s+free;\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[1]; return { rate_type: "hourly", rate_30min: +m[2] * (30 / sub) }; }
  m = text.match(/^First\s+\d+\s+mins?\s+free;\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "hourly", rate_30min: +m[1] / 2 };

  // "First 0 mins free; Subsequent hour $X" → hourly
  m = text.match(/^First\s+0\s+mins?\s+free;\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "hourly", rate_30min: +m[1] / 2 };

  // "First N hours free; Subsequent M mins $Y"
  m = text.match(/^First\s+(\d+)\s+hours?\s+free;\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[2]; return { rate_type: "tiered", first_Nhr: 0, first_Nhr_covers_mins: +m[1]*60, rate_30min: +m[3]*(30/sub) }; }

  m = text.match(/^First\s+hour\s+free;\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_hour: 0, rate_30min: +m[1] / 2 };

  m = text.match(/^First\s+hour\s+free;\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[1]; return { rate_type: "tiered", first_hour: 0, rate_30min: +m[2]*(30/sub) }; }

  // "First N hours $X; Subsequent M mins $Y" (M = 10, 15, 30, or "hour")
  m = text.match(/^First\s+(\d+)\s+hours?\s+\$([0-9.]+);\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[3]; return { rate_type: "tiered", first_Nhr: +m[2], first_Nhr_covers_mins: +m[1]*60, rate_30min: +m[4]*(30/sub) }; }

  m = text.match(/^First\s+(\d+)\s+hours?\s+\$([0-9.]+);\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_Nhr: +m[2], first_Nhr_covers_mins: +m[1]*60, rate_30min: +m[3]/2 };

  // "First N hours $X" alone (no subsequent stated)
  m = text.match(/^First\s+(\d+)\s+hours?\s+\$([0-9.]+)(?:\s*$|;)/i);
  if (m) return { rate_type: "tiered", first_Nhr: +m[2], first_Nhr_covers_mins: +m[1]*60, rate_30min: null };

  // "First 30 mins $X; Subsequent M mins $Y"
  m = text.match(/^First\s+30\s+mins?\s+\$([0-9.]+);\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[2]; return { rate_type: "tiered", first_Nhr: +m[1], first_Nhr_covers_mins: 30, rate_30min: +m[3]*(30/sub) }; }

  m = text.match(/^First\s+30\s+mins?\s+\$([0-9.]+);\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_Nhr: +m[1], first_Nhr_covers_mins: 30, rate_30min: +m[2]/2 };

  // "First 15 mins $X; Subsequent 15 mins $Y"
  m = text.match(/^First\s+15\s+mins?\s+\$([0-9.]+);\s+Subsequent\s+15\s+mins?\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_Nhr: +m[1], first_Nhr_covers_mins: 15, rate_30min: +m[2]*2 };

  // "First N mins $X; Subsequent M mins $Y" (small N like 5)
  m = text.match(/^First\s+(\d+)\s+mins?\s+\$([0-9.]+);\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[3]; return { rate_type: "tiered", first_Nhr: +m[2], first_Nhr_covers_mins: +m[1], rate_30min: +m[4]*(30/sub) }; }

  m = text.match(/^First\s+(\d+)\s+mins?\s+\$([0-9.]+);\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_Nhr: +m[2], first_Nhr_covers_mins: +m[1], rate_30min: +m[3]/2 };

  // "First hour $X; Subsequent M mins $Y" (M = 10, 15, 30)
  m = text.match(/^First\s+hour\s+\$([0-9.]+);\s+Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
  if (m) { const sub = +m[2]; return { rate_type: "tiered", first_hour: +m[1], rate_30min: +m[3]*(30/sub) }; }

  m = text.match(/^First\s+hour\s+\$([0-9.]+);\s+Subsequent\s+hour\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_hour: +m[1], rate_30min: +m[2]/2 };

  // "First hour $X; Subsequent min $Y" (per-minute subsequent)
  m = text.match(/^First\s+hour\s+\$([0-9.]+);\s+Subsequent\s+min\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "tiered", first_hour: +m[1], rate_per_min: +m[2] };

  // "First hour $X" (with possible trailing noise – take first_hour, derive rate_30min if present)
  m = text.match(/^First\s+hour\s+\$([0-9.]+)/i);
  if (m) {
    const r = { rate_type: "tiered", first_hour: +m[1], rate_30min: null };
    const subM2 = text.match(/Subsequent\s+(\d+)\s+mins?\s+\$([0-9.]+)/i);
    if (subM2) { const s2 = +subM2[1]; r.rate_30min = +subM2[2]*(30/s2); }
    const subH = text.match(/Subsequent\s+hour\s+\$([0-9.]+)/i);
    if (subH) r.rate_30min = +subH[1]/2;
    return r;
  }

  // "First min $X; Subsequent min $Y" → per_min
  m = text.match(/^First\s+min\s+\$([0-9.]+);\s+Subsequent\s+min\s+\$([0-9.]+)/i);
  if (m) return { rate_type: "per_min", rate_per_min: +m[1] };

  // "$X per N hours" (fixed block, N>=2)
  m = text.match(/^\$([0-9.]+)\s+per\s+(\d+)\s+hours?(?:;|$|\s*$)/i);
  if (m) return { rate_type: "tiered", first_Nhr: +m[1], first_Nhr_covers_mins: +m[2]*60, rate_30min: null };

  // Per 30 mins: "$X per 30 mins" or "Per 30 mins $X"
  m = text.match(/^(?:\$([0-9.]+)\s+per\s+30\s+mins?|Per\s+30\s+mins?\s+\$([0-9.]+))(?:;|$|\s)/i);
  if (m) return { rate_type: "hourly", rate_30min: +(m[1]??m[2]) };

  // Per 15 mins
  m = text.match(/^(?:\$([0-9.]+)\s+per\s+15\s+mins?|Per\s+15\s+mins?\s+\$([0-9.]+))(?:;|$|\s)/i);
  if (m) return { rate_type: "hourly", rate_30min: +(m[1]??m[2])*2 };

  // Per 10 mins
  m = text.match(/^(?:\$([0-9.]+)\s+per\s+10\s+mins?|Per\s+10\s+mins?\s+\$([0-9.]+))(?:;|$|\s)/i);
  if (m) return { rate_type: "hourly", rate_30min: +(m[1]??m[2])*3 };

  // Per hour: "$X per hour" or "Per hour $X"
  m = text.match(/^(?:\$([0-9.]+)\s+per\s+hour|Per\s+hour\s+\$([0-9.]+))(?:;|$|\s)/i);
  if (m) return { rate_type: "hourly", rate_30min: +(m[1]??m[2])/2 };

  // Per day: "$X per N day(s)"
  m = text.match(/^\$([0-9.]+)\s+per\s+(?:\d+\s+)?days?(?:;|$|\s*$)/i);
  if (m) return { rate_type: "per_entry", per_entry: +m[1] };

  // Per entry: "$X per entry" (possibly with trailing noise)
  m = text.match(/^\$([0-9.]+)\s+per\s+entry/i);
  if (m) return { rate_type: "per_entry", per_entry: +m[1] };

  return null; // unrecognized
}

// ---------- Slug → carpark_id ----------

function slugToId(slug) {
  return "MOT_" + slug.toUpperCase().replace(/-/g, "_");
}

// ---------- Main ----------

function main() {
  // --- Load existing carparks ---
  const cpRows = parseCsv(readFileSync(CARPARKS_CSV, "utf8"));
  const cpHeader = cpRows.shift(); // ["carpark_id","name","lat","lng","address","has_coupon_parking"]
  // Map: postalCode → carpark_id (for deduplication)
  const existingByPostal = new Map();
  const existingIds = new Set();
  for (const r of cpRows) {
    const [id, , , , address] = r;
    if (!id) continue;
    existingIds.add(id);
    const pc = extractPostalCode(address);
    if (pc && !existingByPostal.has(pc)) existingByPostal.set(pc, id);
  }

  // --- Load existing rates ---
  const rtRowsRaw = parseCsv(readFileSync(RATES_CSV, "utf8"));
  const rtHeader = rtRowsRaw.shift();
  // Drop all MOT_* rows — we're going to re-process motorist rates from scratch
  // so fixes to the parser/dedup logic actually take effect.
  const rtRows = rtRowsRaw.filter(r => !(r[0] && r[0].startsWith("MOT_")));
  // Dedup key is (id, day_group, window_start) so carparks with multiple time
  // slots per day (e.g. morning hourly + evening flat) keep all slots.
  const existingRateKeys = new Set();
  for (const r of rtRows) {
    const [id, , dayGroup, ws] = r;
    if (id && dayGroup) existingRateKeys.add(`${id}|${dayGroup}|${ws}`);
  }

  // --- Load motorist carparks ---
  const motCpRows = parseCsv(readFileSync(MOT_CARPARKS, "utf8"));
  motCpRows.shift(); // header: slug, name, address

  // Build slug → { carpark_id, isNew } map
  const slugMap = new Map();
  const newCarparkRows = []; // rows to append to carparks.csv

  for (const [slug, name, address] of motCpRows) {
    if (!slug) continue;
    const pc = extractPostalCode(address);
    const existingId = pc ? existingByPostal.get(pc) : null;
    if (existingId) {
      slugMap.set(slug, { carpark_id: existingId, isNew: false });
    } else {
      const newId = slugToId(slug);
      if (!existingIds.has(newId)) {
        slugMap.set(slug, { carpark_id: newId, isNew: true });
        newCarparkRows.push([newId, name, "", "", address, "FALSE"]);
        existingIds.add(newId);
        if (pc) existingByPostal.set(pc, newId);
      } else {
        // ID collision (duplicate slug after conversion)
        slugMap.set(slug, { carpark_id: newId, isNew: false });
      }
    }
  }

  // --- Load & process motorist rates ---
  const motRtRows = parseCsv(readFileSync(MOT_RATES, "utf8"));
  motRtRows.shift(); // header: slug, name, address, vehicle_type, day, time_start, time_end, rate

  const newRateRows = [];
  let skippedNotCar = 0, skippedExisting = 0, skippedBadDay = 0,
      skippedNoRate = 0, skippedNoSlug = 0;
  const unparsedRates = [];

  for (const cols of motRtRows) {
    const [slug, , , vehicleType, dayRaw, timeStart, timeEnd, rateRaw] = cols;
    if (!slug || !rateRaw) { skippedNoSlug++; continue; }

    // Only car rates
    if (!vehicleType.includes("Car")) { skippedNotCar++; continue; }

    const entry = slugMap.get(slug);
    if (!entry) { skippedNoSlug++; continue; }

    // Keep curated rates for pre-existing (non-motorist) carparks; re-process
    // any MOT_* carpark even if it already exists, since we just cleared its rows.
    if (!entry.isNew && !entry.carpark_id.startsWith("MOT_")) {
      skippedExisting++;
      continue;
    }

    const dayGroups = expandDay(dayRaw);
    if (!dayGroups.length) { skippedBadDay++; continue; }

    const { window_start, window_end } = makeWindow(timeStart, timeEnd);
    const parsed = parseRate(rateRaw);

    if (!parsed) {
      unparsedRates.push({ slug, dayRaw, rateRaw });
      skippedNoRate++;
      continue;
    }

    const { rate_type, first_hour, first_Nhr, first_Nhr_covers_mins, rate_30min, rate_per_min, per_entry } = parsed;

    for (const dayGroup of dayGroups) {
      const key = `${entry.carpark_id}|${dayGroup}|${window_start}`;
      if (existingRateKeys.has(key)) continue; // already have this slot
      existingRateKeys.add(key); // dedupe within this run

      newRateRows.push([
        entry.carpark_id,    // carpark_id
        "main",              // facility
        dayGroup,            // day_group
        window_start,        // window_start
        window_end,          // window_end
        rate_type,           // rate_type
        first_hour ?? "",    // first_hour
        first_Nhr ?? "",     // first_Nhr
        first_Nhr_covers_mins ?? "", // first_Nhr_covers_mins
        rate_30min ?? "",    // rate_30min
        rate_per_min ?? "",  // rate_per_min
        per_entry ?? "",     // per_entry
        rateRaw,             // raw
      ]);
    }
  }

  // --- Write carparks.csv ---
  const cpLines = [
    cpHeader.map(csvEscape).join(","),
    ...cpRows.map(r => r.map(csvEscape).join(",")),
    ...newCarparkRows.map(r => toCsvRow(r)),
  ].join("\n") + "\n";
  writeFileSync(CARPARKS_CSV, cpLines);

  // --- Write rates.csv ---
  const rtLines = [
    rtHeader.map(csvEscape).join(","),
    ...rtRows.map(r => r.map(csvEscape).join(",")),
    ...newRateRows.map(r => toCsvRow(r)),
  ].join("\n") + "\n";
  writeFileSync(RATES_CSV, rtLines);

  // --- Summary ---
  const newCarparks = newCarparkRows.length;
  const matchedExisting = [...slugMap.values()].filter(v => !v.isNew).length;
  console.log(`\nDone.`);
  console.log(`  Carparks: ${newCarparks} new added, ${matchedExisting} matched existing`);
  console.log(`  Rate rows added: ${newRateRows.length}`);
  console.log(`  Skipped — not car: ${skippedNotCar}, existing carpark: ${skippedExisting}`);
  console.log(`            bad day: ${skippedBadDay}, unparsed rate: ${skippedNoRate}`);
  if (unparsedRates.length) {
    console.log(`\n  Unparsed rate samples (first 20):`);
    for (const u of unparsedRates.slice(0, 20)) {
      console.log(`    [${u.slug}] day="${u.dayRaw}" rate="${u.rateRaw}"`);
    }
  }
  console.log(`\nNext steps:`);
  console.log(`  node scripts/geocodeCarparks.mjs   # fill lat/lng for ${newCarparks} new carparks`);
  console.log(`  node scripts/buildFromCleanCsv.mjs  # rebuild js/csvCarparks.js`);
}

main();
