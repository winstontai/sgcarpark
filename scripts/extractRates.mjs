// Extract the free-text rules in CarparkRates.csv into a structured long-format
// schema: data/carparks.csv + data/rates.csv + data/unparsed_rows.csv.
//
// Run: node scripts/extractRates.mjs
//
// The goal is clarity and reviewability. Edge cases the parser can't handle
// cleanly are dumped into unparsed_rows.csv for manual entry.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CSV_PATH = join(ROOT, "CarparkRates.csv");
const DATA_DIR = join(ROOT, "data");

// ---------- CSV helpers ----------
function parseCsv(text) {
  const rows = [];
  let cur = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
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

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(path, header, rows) {
  const lines = [header.map(csvEscape).join(",")];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(","));
  writeFileSync(path, lines.join("\n") + "\n");
}

// ---------- text helpers ----------
function norm(s) {
  return (s || "")
    .replace(/½/g, "0.5")
    .replace(/¼/g, "0.25")
    .replace(/¾/g, "0.75")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bS\$/g, "$")
    .replace(/\b1\/2\s*(hr|hour)/gi, "0.5 $1")
    .replace(/\b1\/4\s*(hr|hour)/gi, "0.25 $1")
    .replace(/\bfor\s+for\b/gi, "for")
    .replace(/\/\s*per\b/gi, "/")
    .trim();
}

function slug(s) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50);
}

function parseTimeToMin(tok) {
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
  if (/^12\s*midnight$/.test(tok)) return 0;
  if (/^12\s*noon$/.test(tok)) return 720;
  return null;
}

function minToHHMM(min) {
  const days = Math.floor(min / 1440);
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const base = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return days > 0 ? `${base} +${days}d` : base;
}

// ---------- rate extraction (on a contiguous content chunk) ----------
// Convert a "subsequent unit" token ($Y per 15 mins / per 10 mins / per hr / per 0.5 hr)
// into an equivalent rate_30min so the downstream schema stays uniform.
function subRateTo30Min(amount, unitText) {
  if (/10\s*mins?/.test(unitText)) return amount * 3;       // 10min × 3 = 30min
  if (/15\s*mins?/.test(unitText)) return amount * 2;       // 15min × 2 = 30min
  if (/(?:hr|hour)s?\b/.test(unitText) && !/0\.5\s*(?:hr|hour)|0\.25\s*(?:hr|hour)/.test(unitText)) {
    return amount / 2;
  }
  return amount;                                            // 0.5 hr / 30 mins
}

function extractRate(frag) {
  const t = frag.toLowerCase();

  // Unit regex reused below: matches the "sub / next / every" unit token and its variants.
  const UNIT = "(0\\.5\\s*(?:hr|hour)s?|30\\s*mins?|15\\s*mins?|10\\s*mins?|(?:hr|hour)s?\\b)";

  // ---- Tiered: "$X for 1st N hrs[,;and]... $Y [for|per|every][sub.] <unit>"
  const tieredNhr = t.match(new RegExp(
    `\\$(\\d+(?:\\.\\d+)?)\\s*(?:for\\s*)?1st\\s*(\\d+(?:\\.\\d+)?)\\s*-?\\s*hrs?[^$]*?\\$(\\d+(?:\\.\\d+)?)\\s*(?:for|per|\\/|every)?\\s*(?:(?:next\\s+)?sub\\.?\\s*(?:seq\\w*)?)?\\s*${UNIT}`
  ));
  if (tieredNhr) {
    const unit = tieredNhr[4];
    return {
      rate_type: "tiered",
      first_Nhr: +tieredNhr[1],
      first_Nhr_covers_mins: Math.round(+tieredNhr[2] * 60),
      rate_30min: +subRateTo30Min(+tieredNhr[3], unit).toFixed(4)
    };
  }

  // ---- Tiered: "$X for 1st ½ hr; $Y for sub. <unit>" (first tier is a fraction < 1 hr)
  const tieredFirstFrac = t.match(new RegExp(
    `\\$(\\d+(?:\\.\\d+)?)\\s*for\\s*1st\\s*(?:0\\.5\\s*hr|30\\s*mins?)[^$]*?\\$(\\d+(?:\\.\\d+)?)\\s*(?:for|per|\\/|every)?\\s*(?:(?:next\\s+)?sub\\.?\\s*)?${UNIT}`
  ));
  if (tieredFirstFrac) {
    const unit = tieredFirstFrac[3];
    return {
      rate_type: "tiered",
      first_Nhr: +tieredFirstFrac[1],
      first_Nhr_covers_mins: 30,
      rate_30min: +subRateTo30Min(+tieredFirstFrac[2], unit).toFixed(4)
    };
  }

  // ---- Tiered: "$X for 1st hr; $Y [for|per|every][sub.] <unit>"
  //     also matches "$X for 1st hr; $Y for ½ hr" (no explicit "sub.").
  const tiered1hr = t.match(new RegExp(
    `\\$(\\d+(?:\\.\\d+)?)\\s*for\\s*1st\\s*hr[^$]*?\\$(\\d+(?:\\.\\d+)?)\\s*(?:for|per|\\/|every)?\\s*(?:(?:next\\s+)?sub\\.?\\s*(?:seq\\w*)?)?\\s*${UNIT}`
  ));
  if (tiered1hr) {
    const unit = tiered1hr[3];
    return {
      rate_type: "tiered",
      first_hour: +tiered1hr[1],
      rate_30min: +subRateTo30Min(+tiered1hr[2], unit).toFixed(4)
    };
  }

  // ---- "Free 1st hr; $Y for sub. <unit>"  and  "1st hr: Free; $Y for sub. <unit>"
  const freeFirst = t.match(new RegExp(
    `(?:free\\s*1st\\s*hr|1st\\s*hr[\\s:]*free)[^$]*?\\$(\\d+(?:\\.\\d+)?)\\s*(?:for|per|\\/|every)?\\s*(?:(?:next\\s+)?sub\\.?\\s*)?${UNIT}`
  ));
  if (freeFirst) {
    const unit = freeFirst[2];
    return {
      rate_type: "tiered",
      first_hour: 0,
      rate_30min: +subRateTo30Min(+freeFirst[1], unit).toFixed(4)
    };
  }

  // ---- "1st hr: $X; 2nd hr: $Y per 0.5 hr" (labeled with colon)
  const tieredLabeled = t.match(new RegExp(
    `1st\\s*hr[\\s:]*\\$?(\\d+(?:\\.\\d+)?)[^$]*?\\$(\\d+(?:\\.\\d+)?)\\s*(?:for|per|\\/|every)?\\s*(?:(?:next\\s+)?sub\\.?\\s*)?${UNIT}`
  ));
  if (tieredLabeled) {
    const unit = tieredLabeled[3];
    return {
      rate_type: "tiered",
      first_hour: +tieredLabeled[1],
      rate_30min: +subRateTo30Min(+tieredLabeled[2], unit).toFixed(4)
    };
  }

  // ---- Flat rates (no tiered prefix)

  // "$X per 10 mins"
  const per10 = t.match(/\$(\d+(?:\.\d+)?)\s*(?:for|per|\/)\s*10\s*mins?/);
  if (per10) return { rate_type: "hourly", rate_30min: +(+per10[1] * 3).toFixed(4) };

  // "$X per 0.5 hr" / "$X per 30 mins" / "$X per 0.5 hour"
  const per30 = t.match(/\$(\d+(?:\.\d+)?)\s*(?:for|per|\/)\s*(?:0\.5\s*(?:hr|hour)s?|30\s*mins?)/);
  if (per30) return { rate_type: "hourly", rate_30min: +per30[1] };

  // "$X per 15 mins"
  const per15 = t.match(/\$(\d+(?:\.\d+)?)\s*(?:for|per|\/)\s*15\s*mins?/);
  if (per15) return { rate_type: "hourly", rate_30min: +(+per15[1] * 2).toFixed(4) };

  // "$X per N-hourly" (flat every N hours)
  const perNhourly = t.match(/\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*(\d+(?:\.\d+)?)\s*-?\s*hourly/);
  if (perNhourly) {
    return { rate_type: "hourly", rate_30min: +(+perNhourly[1] / (+perNhourly[2] * 2)).toFixed(4) };
  }

  // "$X per hr" / "$X per hour"
  const perHr = t.match(/\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*(?:hr|hour)s?\b/);
  if (perHr) return { rate_type: "hourly", rate_30min: +(+perHr[1] / 2).toFixed(4) };

  // "$X per min" / "$X /min"
  const perMin = t.match(/\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*min\b/);
  if (perMin) return { rate_type: "per_min", rate_per_min: +perMin[1] };

  // "$X per entry" / "$X /entry" / "$X flat"
  const entry = t.match(/\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*entry/) ||
                t.match(/\$(\d+(?:\.\d+)?)\s*flat/);
  if (entry) return { rate_type: "per_entry", per_entry: +entry[1] };

  return null;
}

// ---------- window-header detection ----------
// Returns [{ start, end, content }] where content is the rate text between windows.
function splitByWindowHeaders(text) {
  // Matches "Xam-Ypm:", "Aft Xpm:", "After Xpm:", "From Xam:"
  // Time can be "7am", "10.30pm", "12 midnight", "12 noon", "1700"
  const timeRe = "\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)|12\\s*(?:midnight|noon)|\\d{3,4}";
  const rangeRe = new RegExp(`((?:${timeRe})\\s*[-to]+\\s*(?:${timeRe}))\\s*:`, "gi");
  const aftRe = new RegExp(`(aft(?:er)?\\s+(?:${timeRe})|from\\s+(?:${timeRe}))\\s*:`, "gi");

  const headers = [];
  const seen = new Set();
  for (const re of [rangeRe, aftRe]) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      headers.push({
        index: m.index,
        endOfHeader: m.index + m[0].length,
        windowText: m[1]
      });
    }
  }
  headers.sort((a, b) => a.index - b.index);

  if (headers.length === 0) return [{ start: 0, end: 1440, content: text }];

  const sections = [];
  // If there's text before the first window header, treat it as a daily rule.
  if (headers[0].index > 0) {
    const pre = text.slice(0, headers[0].index).trim().replace(/[;,.\s]+$/, "");
    if (pre && /\$/.test(pre)) {
      sections.push({ start: 0, end: 1440, content: pre });
    }
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const next = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const content = text.slice(h.endOfHeader, next).trim().replace(/[;,.\s]+$/, "");
    const win = parseWindowText(h.windowText);
    if (win) sections.push({ start: win.start, end: win.end, content });
  }

  return sections;
}

function parseWindowText(text) {
  const t = text.toLowerCase().trim();

  const aft = t.match(/^(?:aft(?:er)?|from)\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{3,4}|12\s*midnight|12\s*noon)$/);
  if (aft) {
    const s = parseTimeToMin(aft[1]);
    if (s != null) return { start: s, end: 1440 };
  }

  const rng = t.match(/^(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{3,4}|12\s*midnight|12\s*noon)\s*[-to]+\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{3,4}|12\s*midnight|12\s*noon)$/);
  if (rng) {
    const s = parseTimeToMin(rng[1]);
    let e = parseTimeToMin(rng[2]);
    if (s != null && e != null) {
      if (e === 0) e = 1440;
      else if (e <= s) e += 1440; // cross midnight
      return { start: s, end: e };
    }
  }

  return null;
}

// ---------- day-of-week detection ----------
// Strip leading labels like "Mon-Fri:", "Sat:", "Sat, Sun/Ph:", "Weekdays:", "Daily:".
function stripDayLabel(text) {
  return text.replace(
    /^\s*(Mon-Fri|Mon-Sat|Weekdays?|Wkdays?|Daily|Sat(?:urday)?(?:\s*,\s*Sun(?:day)?(?:\s*\/\s*(?:PH|Ph))?)?|Sun(?:day)?(?:\s*\/\s*(?:PH|Ph))?|PH)\s*:\s*/i,
    ""
  );
}

// Split on mid-text day-group markers like "Mon-Thu: ...; Fri & Eve of PH: ..."
function splitByDayGroupsMidText(text, defaultGroup) {
  const re = /(?:^|;\s*)\b(Mon-(?:Thu|Thurs|Thursdays?)|Fri(?:\s*&\s*Eve\s*of\s*PH)?|Fri)\s*:\s*/gi;
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ index: m.index + (m[0].startsWith(";") ? 1 : 0), labelEnd: m.index + m[0].length, label: m[1] });
  }
  if (matches.length === 0) return [{ day_group: defaultGroup, text }];

  const groups = [];
  if (matches[0].index > 0) {
    const pre = text.slice(0, matches[0].index).trim().replace(/[;,.]\s*$/, "");
    if (pre) groups.push({ day_group: defaultGroup, text: pre });
  }
  for (let i = 0; i < matches.length; i++) {
    const h = matches[i];
    const next = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(h.labelEnd, next).trim().replace(/[;,.]\s*$/, "");
    groups.push({ day_group: normalizeDayGroup(h.label), text: content });
  }
  return groups;
}

function normalizeDayGroup(raw) {
  const r = raw.toLowerCase().replace(/\s+/g, " ");
  if (/mon-thu/.test(r) || /mon-thurs/.test(r)) return "mon-thu";
  if (/fri\s*&\s*eve/.test(r)) return "fri_eve_ph";
  if (/^fri$/.test(r)) return "fri";
  return "weekday";
}

// ---------- facility split ----------
function splitByFacilities(text) {
  const t = text;
  const m = t.match(/^(.*?\bmulti[\s-]*storey\s+carpark\b)\s*-\s*(.*?)\s*\b(hotel driveway)\b\s*-\s*(.*)$/i);
  if (m) {
    return [
      { facility: "MSCP", text: m[2].trim().replace(/\.\s*$/, "") },
      { facility: "hotel_driveway", text: m[4].trim().replace(/\.\s*$/, "") }
    ];
  }
  return [{ facility: "main", text: t }];
}

// ---------- main parser ----------
function parseRateText(text, defaultGroup, carpark_id) {
  const t = norm(text);
  if (!t || t === "-" || /^nil$/i.test(t)) return { rules: [], unparsed: null };

  // Whole-text specials
  if (/(?:hdb|ura)\s*coupon\s*parking|^coupon\s*parking/i.test(t)) {
    return {
      rules: [mkRule(carpark_id, "main", defaultGroup, 0, 1440, { rate_type: "coupon" }, t)],
      unparsed: null
    };
  }
  if (/not\s+in\s+use|season\s+parking\s+only|for\s+tenants\s+only|reserved\s+for\s+(?:cars|staff|tenants)/i.test(t)) {
    return {
      rules: [mkRule(carpark_id, "main", defaultGroup, 0, 1440, { rate_type: "not_public" }, t)],
      unparsed: null
    };
  }
  if (!/\$/.test(t) && /\bfree\b/i.test(t)) {
    return {
      rules: [mkRule(carpark_id, "main", defaultGroup, 0, 1440, { rate_type: "free" }, t)],
      unparsed: null
    };
  }

  // Strip leading day label so window parsing sees the rate text cleanly.
  const stripped = stripDayLabel(t);

  // Detect Mon-Thu / Fri mid-text splits (rare but important).
  const dayGroups = splitByDayGroupsMidText(stripped, defaultGroup);

  const rules = [];
  const unparsedBits = [];

  for (const dg of dayGroups) {
    const facilities = splitByFacilities(stripDayLabel(dg.text));
    for (const fac of facilities) {
      const sections = splitByWindowHeaders(fac.text);
      for (const sec of sections) {
        if (!sec.content || !/\$/.test(sec.content)) continue;
        const rate = extractRate(sec.content);
        if (!rate) {
          unparsedBits.push(sec.content);
          continue;
        }
        rules.push(mkRule(carpark_id, fac.facility, dg.day_group, sec.start, sec.end, rate, sec.content));
      }
    }
  }

  return {
    rules,
    unparsed: unparsedBits.length ? unparsedBits.join(" | ") : null
  };
}

function mkRule(carpark_id, facility, day_group, startMin, endMin, rate, raw) {
  const endStr = endMin >= 1440 ? (endMin === 1440 ? "24:00" : minToHHMM(endMin)) : minToHHMM(endMin);
  return {
    carpark_id,
    facility,
    day_group,
    window_start: minToHHMM(startMin),
    window_end: endStr,
    rate_type: rate.rate_type || "",
    first_hour: rate.first_hour ?? "",
    first_Nhr: rate.first_Nhr ?? "",
    first_Nhr_covers_mins: rate.first_Nhr_covers_mins ?? "",
    rate_30min: rate.rate_30min ?? "",
    rate_per_min: rate.rate_per_min ?? "",
    per_entry: rate.per_entry ?? "",
    raw: raw.length > 200 ? raw.slice(0, 200) + "..." : raw
  };
}

// ---------- inheritance ----------
function isInheritText(text) {
  const t = norm(text).toLowerCase();
  return !t || t === "-" || /^nil$/i.test(t) ||
         /same as (?:wk|weekdays?|wkday)/i.test(t) ||
         /charges? same as (?:wk|weekdays?)/i.test(t);
}

function isSameAsSat(text) {
  return /same as sat(?:urday)?/i.test(norm(text));
}

function dedupeRules(rs) {
  const seen = new Set();
  const out = [];
  for (const r of rs) {
    const key = [r.facility, r.day_group, r.window_start, r.window_end, r.rate_type,
                 r.first_hour, r.first_Nhr, r.first_Nhr_covers_mins,
                 r.rate_30min, r.rate_per_min, r.per_entry].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------- main ----------
function main() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const csv = readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(csv);
  rows.shift();

  const carparks = [];
  const rules = [];
  const unparsed = [];
  const seenIds = new Map();

  for (const row of rows) {
    if (!row[0] || !row[0].trim()) continue;
    const name = row[0].trim();
    const category = (row[1] || "").trim();
    const w1 = row[2] || "";
    const w2 = row[3] || "";
    const sat = row[4] || "";
    const sun = row[5] || "";

    let carpark_id = slug(name);
    if (seenIds.has(carpark_id)) {
      const n = seenIds.get(carpark_id) + 1;
      seenIds.set(carpark_id, n);
      carpark_id = `${carpark_id}_${n}`;
    } else {
      seenIds.set(carpark_id, 1);
    }

    const hasCoupon = /coupon parking|hdb coupon/i.test(w1 + " " + w2);
    carparks.push({ carpark_id, name, category, has_coupon_parking: hasCoupon ? "TRUE" : "FALSE" });

    // Combine w1 + w2 into one weekday text for unified parsing (preserves tiered
    // patterns that span both columns). When w1 === w2 skip w2 to avoid duplicates.
    const w1n = norm(w1);
    const w2n = norm(w2);
    const wkParts = [];
    if (w1n && w1n !== "-") wkParts.push(w1n);
    if (w2n && w2n !== "-" && w2n !== w1n) wkParts.push(w2n);
    const wkText = wkParts.join("; ");
    const wkP = parseRateText(wkText, "weekday", carpark_id);
    if (wkP.unparsed) unparsed.push({ carpark_id, name, column: "weekdays", text: wkP.unparsed });
    rules.push(...dedupeRules(wkP.rules));

    // Saturday
    let satRules = [];
    if (isInheritText(sat)) {
      satRules = wkP.rules.map(r => ({ ...r, day_group: "sat" }));
    } else {
      const satP = parseRateText(sat, "sat", carpark_id);
      satRules = satP.rules;
      if (satP.unparsed) unparsed.push({ carpark_id, name, column: "saturday", text: satP.unparsed });
    }
    satRules = dedupeRules(satRules);
    rules.push(...satRules);

    // Sunday/PH
    let sunRules = [];
    if (isSameAsSat(sun)) {
      sunRules = satRules.map(r => ({ ...r, day_group: "sun_ph" }));
    } else if (isInheritText(sun)) {
      sunRules = wkP.rules.map(r => ({ ...r, day_group: "sun_ph" }));
    } else {
      const sunP = parseRateText(sun, "sun_ph", carpark_id);
      sunRules = sunP.rules;
      if (sunP.unparsed) unparsed.push({ carpark_id, name, column: "sunday_ph", text: sunP.unparsed });
    }
    rules.push(...dedupeRules(sunRules));
  }

  writeCsv(join(DATA_DIR, "carparks.csv"),
    ["carpark_id", "name", "category", "has_coupon_parking"],
    carparks);

  writeCsv(join(DATA_DIR, "rates.csv"),
    ["carpark_id", "facility", "day_group", "window_start", "window_end",
     "rate_type", "first_hour", "first_Nhr", "first_Nhr_covers_mins",
     "rate_30min", "rate_per_min", "per_entry", "raw"],
    rules);

  writeCsv(join(DATA_DIR, "unparsed_rows.csv"),
    ["carpark_id", "name", "column", "text"],
    unparsed);

  const carparksWithRules = new Set(rules.map(r => r.carpark_id));
  const carparksNoRules = carparks.filter(c => !carparksWithRules.has(c.carpark_id));

  console.log(`Carparks:       ${carparks.length}`);
  console.log(`Rate rules:     ${rules.length}`);
  console.log(`No rules:       ${carparksNoRules.length}`);
  console.log(`Unparsed bits:  ${unparsed.length}`);
  console.log(`\nOutputs:`);
  console.log(`  data/carparks.csv`);
  console.log(`  data/rates.csv`);
  console.log(`  data/unparsed_rows.csv`);

  if (carparksNoRules.length) {
    console.log(`\nNo rules extracted for:`);
    for (const c of carparksNoRules.slice(0, 30)) console.log(`  - ${c.name}`);
    if (carparksNoRules.length > 30) console.log(`  ... and ${carparksNoRules.length - 30} more`);
  }
}

main();
