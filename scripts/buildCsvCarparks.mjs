// Build script: parses CarparkRates.csv, geocodes via OneMap,
// writes js/csvCarparks.js with baked-in lat/lng and parsed tariffs.
//
// Run: node scripts/buildCsvCarparks.mjs
//
// Resume-safe: caches geocode results in scripts/.geocode-cache.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CSV_PATH = join(ROOT, "CarparkRates.csv");
const OUT_PATH = join(ROOT, "js", "csvCarparks.js");
const CACHE_PATH = join(__dirname, ".geocode-cache.json");

// ---------- CSV parsing ----------
function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

// ---------- rate parsing ----------
// Normalise Unicode half-fractions and whitespace.
function norm(s) {
  return (s || "")
    .replace(/½/g, "0.5")
    .replace(/¼/g, "0.25")
    .replace(/¾/g, "0.75")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTimeToMin(tok) {
  // "7am", "5pm", "10.30pm", "12am", "11.59pm", "0700", "2230"
  tok = tok.trim().toLowerCase();
  let m = tok.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = +m[1]; const min = +(m[2] || 0);
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return h * 60 + min;
  }
  m = tok.match(/^(\d{3,4})$/);
  if (m) {
    const n = m[1].padStart(4, "0");
    return +n.slice(0, 2) * 60 + +n.slice(2);
  }
  m = tok.match(/^12\s*midnight$/);
  if (m) return 0;
  m = tok.match(/^12\s*noon$/);
  if (m) return 720;
  return null;
}

// Extract all "Xam-Ypm: ...fragment..." windowed fragments from a string.
function splitByWindows(text) {
  const frags = [];
  // Pattern: optional leading window "Xam-Ypm:" or "Aft Xpm:"
  // We naively split on semicolons first, then each chunk keeps its window.
  const chunks = text.split(";").map(s => s.trim()).filter(Boolean);
  for (const c of chunks) frags.push(c);
  return frags;
}

// Try to extract a basic rate from a fragment.
// Returns { rate_per_30min, first_hour_rate, subsequent_rate_per_30min, per_entry_flat } (partial).
function extractRateNumbers(frag) {
  const t = frag.toLowerCase();

  // "1st hr: $X; 2nd hr: $Y per 0.5 hr; 3rd hr onwards: $Z per 0.5 hr" -> just use first+sub
  // "$X for 1st Nhrs; $Y for sub. 0.5 hr"
  const tiered2hr = t.match(/\$(\d+(?:\.\d+)?)\s*for\s*1st\s*2\s*hrs?[^$]*\$(\d+(?:\.\d+)?)\s*for\s*sub[\.\s]*(?:0\.5|30\s*mins?)/);
  if (tiered2hr) {
    // Treat "$X for 1st 2hrs" as 4 × $X/4 per 30min for simplicity? No - use first_hour_rate = X/2 as a blended approx.
    // Better: emit first_hour_rate = X (covers 2hrs flat), then subsequent_rate_per_30min = Y.
    // But our model treats first_hour_rate as 1 hour. Approx: rate_per_30min = X/4, subsequent from Y.
    return {
      rate_per_30min: +tiered2hr[1] / 4,
      subsequent_rate_per_30min: +tiered2hr[2],
      _note: "1st 2hrs flat"
    };
  }

  // "1st hr $X; 2nd hr $Y per 0.5 hr" or "1st hr: $X; 2nd hr: $Y per 0.5 hr"
  const tieredLabeled = t.match(/1st\s*hr[\s:]*\$?(\d+(?:\.\d+)?)[^$]*?\$(\d+(?:\.\d+)?)\s*(?:per|for\s*sub[\.\s]*)\s*(?:0\.5\s*hr|30\s*mins?|15\s*mins?)/);
  if (tieredLabeled) {
    const per15 = /15\s*mins?/.test(tieredLabeled[0]);
    return {
      first_hour_rate: +tieredLabeled[1],
      subsequent_rate_per_30min: per15 ? +tieredLabeled[2] * 2 : +tieredLabeled[2]
    };
  }

  // "$X for 1st hr; $Y for sub. 0.5 hr"
  const tiered1hr = t.match(/\$(\d+(?:\.\d+)?)\s*for\s*1st\s*hr[^$]*\$(\d+(?:\.\d+)?)\s*(?:for\s*sub[\.\s]*|per\s*)(?:0\.5\s*hr|30\s*mins?|15\s*mins?)/);
  if (tiered1hr) {
    const subRate = +tiered1hr[2];
    const per15 = /15\s*mins?/.test(tiered1hr[0]);
    return {
      first_hour_rate: +tiered1hr[1],
      subsequent_rate_per_30min: per15 ? subRate * 2 : subRate
    };
  }

  // "$X per 0.5 hr" / "$X per 30 mins" / "$X / 30 mins" / "$X for 0.5 hr"
  const per30 = t.match(/\$(\d+(?:\.\d+)?)\s*(?:for|per|\/)\s*(?:0\.5\s*hr|30\s*mins?)/);
  if (per30) return { rate_per_30min: +per30[1] };

  // "$X per 15 mins"
  const per15 = t.match(/\$(\d+(?:\.\d+)?)\s*(?:for|per|\/)\s*15\s*mins?/);
  if (per15) return { rate_per_30min: +per15[1] * 2 };

  // "$X per hr"
  const perHr = t.match(/\$(\d+(?:\.\d+)?)\s*per\s*hr/);
  if (perHr) return { rate_per_30min: +perHr[1] / 2 };

  // "$X per min" / "$X /min"
  const perMin = t.match(/\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*min/);
  if (perMin) return { rate_per_30min: +perMin[1] * 30 };

  // "$X per entry" / "$X /entry" / "$X flat"
  const entry = t.match(/\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*entry/) ||
                t.match(/\$(\d+(?:\.\d+)?)\s*flat/);
  if (entry) return { per_entry_flat: +entry[1] };

  return null;
}

// Extract time window prefix from a fragment, e.g. "7am-10pm" -> [420, 1320].
function extractWindow(frag) {
  const t = frag.toLowerCase();

  // "aft Xpm" / "after Xpm"
  const aft = t.match(/aft(?:er)?\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{3,4}|12\s*midnight)/);
  if (aft) {
    const start = parseTimeToMin(aft[1]);
    if (start != null) return { start, end: 1440, afterOnly: true };
  }

  // "Xam-Ypm" with optional colon/time variants
  const rng = t.match(/(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{3,4}|12\s*midnight|12\s*noon)\s*[-to]+\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{3,4}|12\s*midnight|12\s*noon)/);
  if (rng) {
    const s = parseTimeToMin(rng[1]);
    const e = parseTimeToMin(rng[2]);
    if (s != null && e != null) return { start: s, end: e === 0 ? 1440 : e };
  }

  return null;
}

// Parse a combined rate text (one or both weekday columns) into a tariff object.
// Returns { tariff, notes, parsed: boolean }.
function parseTariff(weekday1, weekday2, weekendSat, weekendSun) {
  const w1 = norm(weekday1);
  const w2 = norm(weekday2);

  // Skip unusable rows.
  const skip = /not in use|coupon parking|valet parking only|closed all day|reserved for/i;
  if (skip.test(w1) && (!w2 || skip.test(w2))) {
    return { parsed: false, reason: "unusable" };
  }

  // Free parking
  if (/^free(\s|$)|free daily|daily free|free parking/i.test(w1) && !/\$/.test(w1)) {
    return {
      parsed: true,
      tariff: { rate_per_30min: 0, first_free_minutes: 0, per_entry_cap: 0, chargeable_start: 0, chargeable_end: 1440 },
      notes: "Free parking"
    };
  }

  let rate_per_30min = null;
  let first_hour_rate = null;
  let subsequent_rate_per_30min = null;
  let chargeable_start = 0, chargeable_end = 1440;
  let evening_per_entry = null;
  let per_entry_cap = null;

  // Extract rate across the whole weekday1 (lets tiered patterns match across
  // semicolon splits like "Mon-Fri: $1.20 for 1st hr; $0.60 for sub. 0.5 hr").
  const frags1 = splitByWindows(w1);
  const rateFull = extractRateNumbers(w1);
  const rateFrag0 = frags1.length ? extractRateNumbers(frags1[0]) : null;
  const rate = rateFull || rateFrag0;

  if (rate) {
    if (rate.first_hour_rate != null) first_hour_rate = rate.first_hour_rate;
    if (rate.subsequent_rate_per_30min != null) subsequent_rate_per_30min = rate.subsequent_rate_per_30min;
    if (rate.rate_per_30min != null) rate_per_30min = rate.rate_per_30min;
    if (rate.per_entry_flat != null && first_hour_rate == null && rate_per_30min == null) {
      // Flat entry with no hourly component.
      const winFlat = frags1.length ? extractWindow(frags1[0]) : null;
      if (!winFlat) {
        return {
          parsed: true,
          tariff: {
            rate_per_30min: 0,
            per_entry_cap: rate.per_entry_flat,
            first_free_minutes: 0,
            chargeable_start: 0, chargeable_end: 1440
          },
          notes: `$${rate.per_entry_flat.toFixed(2)} per entry (flat)`
        };
      }
    }
  }

  // Chargeable time window from first fragment of w1.
  if (frags1.length) {
    const win = extractWindow(frags1[0]);
    if (win) {
      chargeable_start = win.start;
      chargeable_end = win.end;
    }
  }

  // Evening flat entry: check weekday2, or any later semicolon frag, for "Aft Xpm: $Y per entry".
  const eveningCandidates = [];
  if (w2) eveningCandidates.push(...splitByWindows(w2));
  if (frags1.length > 1) eveningCandidates.push(...frags1.slice(1));
  for (const c of eveningCandidates) {
    const win = extractWindow(c);
    const rate = extractRateNumbers(c);
    if (win && rate && rate.per_entry_flat != null) {
      evening_per_entry = {
        start_min: win.start,
        end_min: win.end,
        price: rate.per_entry_flat
      };
      break;
    }
  }

  // Capped per-entry in weekday1 like "Capped at $X" or "(Max: $X per 24hrs)"
  const capMatch = w1.match(/cap(?:ped)?\s*(?:at)?\s*\$(\d+(?:\.\d+)?)/i) ||
                   w1.match(/max(?:imum)?:?\s*\$(\d+(?:\.\d+)?)/i);
  if (capMatch) per_entry_cap = +capMatch[1];

  // Fail if we got nothing usable.
  if (rate_per_30min == null && first_hour_rate == null && !evening_per_entry) {
    return { parsed: false, reason: "no rate extracted" };
  }

  // Default rate_per_30min if we only got first_hour + subsequent.
  if (rate_per_30min == null && first_hour_rate != null) {
    rate_per_30min = first_hour_rate; // used only for stays <= 1hr effectively
  }
  if (rate_per_30min == null) rate_per_30min = 0;

  const tariff = {
    rate_per_30min,
    first_free_minutes: 0,
    per_entry_cap,
    chargeable_start,
    chargeable_end
  };
  if (first_hour_rate != null) tariff.first_hour_rate = first_hour_rate;
  if (subsequent_rate_per_30min != null) tariff.subsequent_rate_per_30min = subsequent_rate_per_30min;
  if (evening_per_entry) tariff.evening_per_entry = evening_per_entry;

  return { parsed: true, tariff, notes: norm(`${w1}${w2 ? " | " + w2 : ""}`).slice(0, 140) };
}

// ---------- geocoding ----------
async function geocode(name) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(name)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OneMap ${r.status}`);
  const j = await r.json();
  if (!j.results || !j.results.length) return null;
  const hit = j.results[0];
  return {
    lat: +hit.LATITUDE,
    lng: +hit.LONGITUDE,
    address: hit.ADDRESS || ""
  };
}

async function geocodeWithFallback(name) {
  const base = name.replace(/\(.*?\)/g, "").trim();
  const beforeComma = name.split(",")[0].trim();
  const attempts = [
    name,
    base,
    beforeComma,
    base + " Singapore",
    beforeComma + " Singapore",
    base.replace(/\bhotel\b|\bshopping\b|\bcentre\b|\bcenter\b|\bcomplex\b/gi, "").trim()
  ].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const q of attempts) {
    try {
      const r = await geocode(q);
      if (r) return r;
    } catch (e) { /* retry next */ }
    await new Promise(r => setTimeout(r, 120));
  }
  return null;
}

// ---------- slug ----------
function slug(s) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

// ---------- main ----------
async function main() {
  const csv = readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(csv);
  const header = rows.shift();

  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};

  const out = [];
  const skipped = [];
  let done = 0;

  for (const row of rows) {
    if (!row[0] || !row[0].trim()) continue;
    const name = row[0].trim();
    const category = row[1] || "";
    const w1 = row[2] || "";
    const w2 = row[3] || "";
    const sat = row[4] || "";
    const sun = row[5] || "";

    const parsed = parseTariff(w1, w2, sat, sun);
    if (!parsed.parsed) {
      skipped.push({ name, reason: parsed.reason, rates: w1 });
      continue;
    }

    let geo = cache[name];
    // Retry prior misses each run (fallbacks may have improved).
    if (!geo || geo._miss) {
      try {
        geo = await geocodeWithFallback(name);
      } catch (e) {
        geo = null;
      }
      cache[name] = geo || { _miss: true };
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      await new Promise(r => setTimeout(r, 250)); // throttle OneMap
    }

    done++;
    if (done % 20 === 0) console.log(`[${done}/${rows.length}] ${name}`);

    if (!geo || geo._miss || geo.lat == null) {
      skipped.push({ name, reason: "geocode failed" });
      continue;
    }

    out.push({
      car_park_no: "CSV_" + slug(name),
      name,
      category,
      address: geo.address,
      lat: geo.lat,
      lng: geo.lng,
      operator: "CSV",
      tariff: parsed.tariff,
      notes: parsed.notes
    });
  }

  // Dedupe by name - prefer the first entry, but keep different categories distinct by appending.
  const seen = new Set();
  const unique = [];
  for (const cp of out) {
    const key = cp.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cp);
  }

  const body =
`// Auto-generated by scripts/buildCsvCarparks.mjs from CarparkRates.csv
// Do not edit by hand - regenerate with: node scripts/buildCsvCarparks.mjs
// Entries: ${unique.length}  Skipped: ${skipped.length}

window.CSV_CARPARKS = ${JSON.stringify(unique, null, 2)};
`;
  writeFileSync(OUT_PATH, body);

  console.log(`\nWrote ${unique.length} carparks to js/csvCarparks.js`);
  console.log(`Skipped ${skipped.length}:`);
  for (const s of skipped.slice(0, 40)) console.log(`  - ${s.name}: ${s.reason}`);
  if (skipped.length > 40) console.log(`  ... and ${skipped.length - 40} more`);
}

main().catch(e => { console.error(e); process.exit(1); });
