// Replace the `category` column in data/carparks.csv with lat/lng/address
// geocoded via OneMap. Reuses scripts/.geocode-cache.json from buildCsvCarparks.mjs
// so only names that aren't already cached hit the network.
//
// Run: node scripts/geocodeCarparks.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CSV_PATH = join(ROOT, "data", "carparks.csv");
const CACHE_PATH = join(__dirname, ".geocode-cache.json");

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

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function geocodeOneMap(name) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(name)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OneMap ${r.status}`);
  const j = await r.json();
  if (!j.results || !j.results.length) return null;
  const hit = j.results[0];
  return {
    lat: +hit.LATITUDE,
    lng: +hit.LONGITUDE,
    address: hit.ADDRESS || "",
    source: "onemap"
  };
}

async function geocodeNominatim(name) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&countrycodes=sg&limit=1`;
  const r = await fetch(url, {
    headers: { "User-Agent": "carparkfinder-geocoder/1.0 (github.com/carparkfinder)" }
  });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;
  const hit = j[0];
  return {
    lat: +hit.lat,
    lng: +hit.lon,
    address: hit.display_name || "",
    source: "nominatim"
  };
}

// Known street addresses for carparks whose names aren't findable by either geocoder.
// Keyed by the exact `name` column value in data/carparks.csv.
const MANUAL_QUERIES = {
  // Off-street metered parking (the location IS the road)
  "Hindoo Road Off-Street": "Hindoo Road Singapore",
  "Kampong Bugis Off-Street": "Kampong Bugis Singapore",
  "Kampong Kapor Road Off-Street": "Kampong Kapor Road Singapore",
  "Shrewsbury Road Off-Street": "Shrewsbury Road Singapore",
  "Angullia Park Off-Street": "Angullia Park Singapore",
  "Grange Road Off-Street": "Grange Road Singapore",
  "Penang Road Off-Street": "Penang Road Singapore",
  "Neil Road Off-Street": "Neil Road Singapore",
  "East Coast Park E1/E2/E3 Off-Street": "East Coast Park Service Road Singapore",

  // Hotels
  "Grand Mecure Roxy Hotel": "50 East Coast Road Singapore",
  "Paramount Hotel": "25 Marine Parade Road Singapore",
  "Copthorne Orchid Hotel": "214 Dunearn Road Singapore",
  "Grand Park Orchard": "270 Orchard Road Singapore",
  "klapsons, The Boutique Hotel": "15 Hoe Chiang Road Singapore",
  "Novotel Clarke Quay": "177A River Valley Road Singapore",
  "Orchard Hotel Shopping Arcade": "442 Orchard Road Singapore",
  "Swissotel Merchant Court Hotel": "20 Merchant Road Singapore",

  // Buildings
  "CapitaCommercial Trust (CCT)": "6 Battery Road Singapore",
  "CPF Building Robinson Road": "79 Robinson Road Singapore",
  "Funan DigitaLife Mall": "107 North Bridge Road Singapore",
  "Income At Raffles ( former Hitachi tower)": "16 Collyer Quay Singapore",
  "Keppel Bay Tower / Harbourfront Tower One": "1 HarbourFront Avenue Singapore",
  "Keypoint": "371 Beach Road Singapore",
  "Peninsular Plaza": "111 North Bridge Road Singapore",
  "PWC Building": "8 Cross Street Singapore",
  "The Corporate Office": "39 Robinson Road Singapore",

  // Attractions
  "Changi Chapel and Museum (The Changi Museum)": "1000 Upper Changi Road North Singapore",
  "Labrador Secret Tunnel ( Labrador Park )": "Labrador Villa Road Singapore",
  "Mandai Orchid Garden": "Mandai Lake Road Singapore",
  "Resorts World Sentosa - Universal Studios Singapore (RWS B1 car park)": "8 Sentosa Gateway Singapore",
  "Singapore Science centre/Singapore Discovery Centre / Snow City": "15 Science Centre Road Singapore",
  "Singapore Zoological gardens/Night Safari": "80 Mandai Lake Road Singapore",
  "The Battle Box ( Park at Fort Canning": "2 Cox Terrace Singapore",
  "Underwater World Singapore": "80 Siloso Road Singapore",
  "Changi Airport - South Car Park (between T2 and JetQuay)": "Changi Airport Terminal 2 Singapore"
};

function queryVariants(name) {
  const base = name.replace(/\(.*?\)/g, "").trim();
  const beforeComma = name.split(",")[0].trim();
  const variants = [
    name,
    base,
    beforeComma,
    base + " Singapore",
    beforeComma + " Singapore",
    base.replace(/\bhotel\b|\bshopping\b|\bcentre\b|\bcenter\b|\bcomplex\b/gi, "").trim()
  ];
  if (MANUAL_QUERIES[name]) variants.unshift(MANUAL_QUERIES[name]);
  return variants.filter((v, i, a) => v && a.indexOf(v) === i);
}

async function geocodeWithFallback(name) {
  const variants = queryVariants(name);
  for (const q of variants) {
    try {
      const r = await geocodeOneMap(q);
      if (r) return r;
    } catch { /* retry next */ }
    await new Promise(r => setTimeout(r, 120));
  }
  for (const q of variants) {
    try {
      const r = await geocodeNominatim(q);
      if (r) return r;
    } catch { /* retry next */ }
    await new Promise(r => setTimeout(r, 1100));
  }
  return null;
}

// Extract 6-digit Singapore postal code from an address string.
function extractPostal(addr) {
  const m = addr?.match(/(?:singapore\s+|S\()(\d{6})\)?/i);
  return m ? m[1] : null;
}

async function main() {
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const header = rows.shift();
  const idx = {
    id:      header.indexOf("carpark_id"),
    name:    header.indexOf("name"),
    lat:     header.indexOf("lat"),
    lng:     header.indexOf("lng"),
    address: header.indexOf("address"),
    coupon:  header.indexOf("has_coupon_parking"),
  };

  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};

  const out = [];
  const misses = [];
  let fetched = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[idx.id]?.trim()) continue;
    const id     = row[idx.id];
    const name   = row[idx.name];
    const coupon = row[idx.coupon];
    const existingLat = row[idx.lat];
    const existingLng = row[idx.lng];
    const existingAddr = row[idx.address] || "";

    // Already geocoded — preserve as-is, no network call needed.
    if (existingLat && existingLng && +existingLat && +existingLng) {
      out.push([id, name, existingLat, existingLng, existingAddr, coupon]);
      continue;
    }

    // Build search queries: try postal code first (most precise), then name.
    const postal = extractPostal(existingAddr);
    const cacheKey = postal ? `postal:${postal}` : name;

    let geo = cache[cacheKey];
    if (!geo || geo._miss || geo.lat == null) {
      process.stdout.write(`[${i + 1}/${rows.length}] geocoding: ${name}\n`);
      try {
        // Try postal code via OneMap first
        if (postal) {
          geo = await geocodeOneMap(postal).catch(() => null);
          if (!geo) geo = await geocodeOneMap(existingAddr).catch(() => null);
        }
        // Fall back to name-based variants
        if (!geo) geo = await geocodeWithFallback(name);
      } catch {
        geo = null;
      }
      cache[cacheKey] = geo || { _miss: true };
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      fetched++;
      await new Promise(r => setTimeout(r, 300));
    }

    if (!geo || geo._miss || geo.lat == null) {
      misses.push({ id, name });
      out.push([id, name, "", "", existingAddr, coupon]);
    } else {
      out.push([id, name, geo.lat, geo.lng, geo.address || existingAddr, coupon]);
    }
  }

  const newHeader = ["carpark_id", "name", "lat", "lng", "address", "has_coupon_parking"];
  const text = [newHeader, ...out].map(r => r.map(csvEscape).join(",")).join("\n") + "\n";
  writeFileSync(CSV_PATH, text);

  console.log(`\nDone. Rows: ${out.length}. Fetched this run: ${fetched}. Misses: ${misses.length}.`);
  for (const m of misses) console.log(`  MISS ${m.id}: ${m.name}`);
}

main().catch(e => { console.error(e); process.exit(1); });
