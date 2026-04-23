// Scrape all carpark rates from motorist.sg/parking-rates
// Outputs data/motorist_rates.csv (long format) and data/motorist_carparks.csv
//
// Run: node scripts/scrapeMotorisg.mjs
// Resumable — uses scripts/.motorist-cache.json to skip already-fetched pages.
// Add --force to re-scrape everything from scratch.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE_PATH = join(__dirname, ".motorist-cache.json");
const CARPARKS_OUT = join(ROOT, "data", "motorist_carparks.csv");
const RATES_OUT = join(ROOT, "data", "motorist_rates.csv");
const BASE = "https://www.motorist.sg";
const FORCE = process.argv.includes("--force");
const CONCURRENCY = 4;
const DELAY_MS = 500; // polite delay between batches

// ---------- helpers ----------

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(...fields) {
  return fields.map(csvEscape).join(",") + "\n";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function decodeEntities(html) {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Minimal tag stripper — good enough for these pages
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function extractAttr(html, attr) {
  const m = html.match(new RegExp(`${attr}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

// ---------- listing page ----------

async function fetchListingUrls() {
  console.log("Fetching listing page…");
  const html = await fetchHtml(`${BASE}/parking-rates`);
  const urls = [];
  const re = /href="(\/parking\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!urls.includes(m[1])) urls.push(m[1]);
  }
  return urls;
}

// ---------- detail page ----------

function parseDetail(html, slug) {
  // Name
  const nameMatch = html.match(
    /itemprop="name"[^>]*>([^<]+)<\/h1>/
  );
  const name = nameMatch ? decodeEntities(nameMatch[1].trim()) : slug;

  // Address
  const addrMatch = html.match(
    /itemprop="streetAddress"[^>]*>([^<]+)<\/span>/
  );
  const address = addrMatch ? decodeEntities(addrMatch[1].trim()) : "";

  // Split into vehicle-type sections by <h4> headings
  const sections = [];
  const h4Re = /<h4[^>]*>([^<]+)<\/h4>([\s\S]*?)(?=<h4|<\/div>\s*<div\s+itemprop="openingHoursSpecification"|$)/gi;
  let hm;
  while ((hm = h4Re.exec(html)) !== null) {
    const vehicleType = stripTags(hm[1]).trim();
    const block = hm[2];
    sections.push({ vehicleType, block });
  }

  const rates = [];

  for (const { vehicleType, block } of sections) {
    // Match <td> elements — they close properly even when <tr> nesting is malformed.
    // Track currentDay from day cells; extract rate info from rate cells.
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdm;
    let currentDay = "";

    while ((tdm = tdRe.exec(block)) !== null) {
      const tdHtml = tdm[1];

      // Day cell
      const dayMatch = tdHtml.match(/itemprop="dayOfWeek"[^>]*>([\s\S]*?)<\/span>/i);
      if (dayMatch) currentDay = stripTags(dayMatch[1]).trim();

      // Rate cell
      const opensMatch = tdHtml.match(/itemprop="opens"[^>]*>([^<]+)<\/span>/i);
      const closesMatch = tdHtml.match(/itemprop="closes"[^>]*>([^<]+)<\/span>/i);
      const descMatch = tdHtml.match(/itemprop="description"[^>]*>([\s\S]*?)<\/span>/i);

      if (descMatch && currentDay) {
        rates.push({
          vehicleType,
          day: currentDay,
          timeStart: opensMatch ? opensMatch[1].trim() : "",
          timeEnd: closesMatch ? closesMatch[1].trim() : "",
          rateDesc: stripTags(descMatch[1]).trim(),
        });
      }
    }
  }

  return { name, address, rates };
}

// ---------- main ----------

async function main() {
  const cache = (!FORCE && existsSync(CACHE_PATH))
    ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
    : {};

  const urls = await fetchListingUrls();
  console.log(`Found ${urls.length} carpark pages.`);

  const carparks = []; // { slug, name, address }
  const rateRows = []; // { slug, name, address, vehicleType, day, timeStart, timeEnd, rateDesc }
  let fetched = 0, cached = 0, errors = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);

    await Promise.all(
      batch.map(async (path) => {
        const slug = path.replace("/parking/", "").replace("-parking-rates", "");
        if (cache[slug]) {
          cached++;
          const c = cache[slug];
          carparks.push({ slug, name: c.name, address: c.address });
          for (const r of c.rates) rateRows.push({ slug, name: c.name, address: c.address, ...r });
          return;
        }
        try {
          const html = await fetchHtml(`${BASE}${path}`);
          const { name, address, rates } = parseDetail(html, slug);
          cache[slug] = { name, address, rates };
          carparks.push({ slug, name, address });
          for (const r of rates) rateRows.push({ slug, name, address, ...r });
          fetched++;
        } catch (e) {
          console.error(`  ERROR ${path}: ${e.message}`);
          errors++;
        }
      })
    );

    // Save cache after each batch
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

    const done = Math.min(i + CONCURRENCY, urls.length);
    process.stdout.write(`\r  ${done}/${urls.length} (${fetched} fetched, ${cached} cached, ${errors} errors)`);

    if (i + CONCURRENCY < urls.length) await sleep(DELAY_MS);
  }

  console.log("\nWriting CSVs…");

  // motorist_carparks.csv
  let carparksCsv = row("slug", "name", "address");
  for (const c of carparks) carparksCsv += row(c.slug, c.name, c.address);
  writeFileSync(CARPARKS_OUT, carparksCsv);

  // motorist_rates.csv
  let ratesCsv = row("slug", "name", "address", "vehicle_type", "day", "time_start", "time_end", "rate");
  for (const r of rateRows) {
    ratesCsv += row(r.slug, r.name, r.address, r.vehicleType, r.day, r.timeStart, r.timeEnd, r.rateDesc);
  }
  writeFileSync(RATES_OUT, ratesCsv);

  console.log(`Done. ${carparks.length} carparks, ${rateRows.length} rate rows.`);
  console.log(`  → ${CARPARKS_OUT}`);
  console.log(`  → ${RATES_OUT}`);
  if (errors) console.warn(`  ⚠ ${errors} pages failed — re-run to retry.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
