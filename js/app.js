// Main application wiring: geocoding, carpark data, map, results.
//
// Data sources:
//   - OneMap search (geocoding): https://www.onemap.gov.sg/api/common/elastic/search
//   - HDB carpark info:          bundled in js/hdbCarparks.js (snapshot of data.gov.sg)
//   - Private/mall carparks:     bundled in js/privateCarparks.js + js/csvCarparks.js
//
// Rationale: data.gov.sg rate-limits by IP (HTTP 429), which caused random
// search failures for visitors. HDB carpark locations change rarely, so we
// ship a snapshot built by scripts/buildHdbCarparks.mjs.

const OM_SEARCH = "https://www.onemap.gov.sg/api/common/elastic/search";

// ---------- Map setup ----------
const map = L.map("map").setView([1.3521, 103.8198], 12);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 20
}).addTo(map);

let destMarker = null;
let carparkLayer = L.layerGroup().addTo(map);

// ---------- Geocoding ----------
async function geocode(query, options) {
  const url = `${OM_SEARCH}?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error("Geocoding failed");
  const data = await res.json();
  if (!data.results || data.results.length === 0) return [];
  return data.results.map(r => ({
    label: `${r.SEARCHVAL} (${r.ADDRESS})`,
    lat: parseFloat(r.LATITUDE),
    lng: parseFloat(r.LONGITUDE),
    postal: r.POSTAL
  }));
}

// ---------- HDB carpark info (bundled snapshot) ----------
function loadHdbCarparks() {
  return (window.HDB_CARPARKS || []).map((cp) => ({ ...cp, kind: "hdb" }));
}

function loadPrivateCarparks() {
  const curated = (window.PRIVATE_CARPARKS || []).map(cp => ({ ...cp, kind: "private" }));
  const csv = (window.CSV_CARPARKS || []).map(cp => ({ ...cp, kind: "private" }));
  // Dedupe by name (curated wins over CSV for hand-tuned entries like MBS).
  const seen = new Set(curated.map(cp => cp.name.toLowerCase()));
  const merged = [...curated];
  for (const cp of csv) {
    if (seen.has(cp.name.toLowerCase())) continue;
    seen.add(cp.name.toLowerCase());
    merged.push(cp);
  }
  return merged;
}

// ---------- Geometry ----------
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Approximate walking distance by scaling crow-fly by a typical urban
// sinuosity factor. Avoids an API call per carpark; within ~15% of routed
// walking distance in dense Singapore street grids.
const WALK_FACTOR = 1.3;
function walkingMetres(lat1, lon1, lat2, lon2) {
  return haversineMetres(lat1, lon1, lat2, lon2) * WALK_FACTOR;
}

// "4 Fourth Chin Bee Road, S(619698)" -> "4 Fourth Chin Bee Road, 619698"
function stripPostalPrefix(addr) {
  return String(addr || "").replace(/S\((\d{6})\)/g, "$1");
}

// ---------- UI ----------
const $ = sel => document.querySelector(sel);
const locationInput = $("#location");
const suggestionsEl = $("#suggestions");
const searchBtn = $("#searchBtn");
const statusEl = $("#status");
const plansEl = $("#plans");
const changesInput = $("#changes");
const changesLabel = $("#changesLabel");
const hoursInput = $("#hours");
const radiusInput = $("#radius");
const arrivalInput = $("#arrival");
const dayTypeInput = $("#dayType");

(function initArrival() {
  const d = new Date();
  d.setMinutes(Math.round(d.getMinutes() / 15) * 15, 0, 0);
  arrivalInput.value = d.toTimeString().slice(0, 5);
})();

(function initDayType() {
  const dow = new Date().getDay();
  dayTypeInput.value = dow === 0 ? "sunday_ph" : dow === 6 ? "saturday" : "weekday";
})();

function changesLabelText(n) {
  if (n === 0) return "Park once";
  if (n === 1) return "1 move OK";
  return `${n} moves OK`;
}
changesInput.addEventListener("input", () => {
  changesLabel.textContent = changesLabelText(parseInt(changesInput.value, 10));
});
changesLabel.textContent = changesLabelText(parseInt(changesInput.value, 10));

let chosenDestination = null;
let debounceTimer = null;
let suggestController = null;
let suggestSeq = 0;
let searchSeq = 0;
locationInput.addEventListener("input", () => {
  chosenDestination = null;
  clearTimeout(debounceTimer);
  if (suggestController) suggestController.abort();
  const q = locationInput.value.trim();
  if (q.length < 3) {
    suggestController = null;
    suggestionsEl.classList.add("hidden");
    return;
  }
  debounceTimer = setTimeout(async () => {
    const requestId = ++suggestSeq;
    suggestController = new AbortController();
    try {
      const results = await geocode(q, { signal: suggestController.signal });
      if (requestId !== suggestSeq || locationInput.value.trim() !== q) return;
      renderSuggestions(results);
    } catch (err) {
      if (err.name === "AbortError") return;
      suggestionsEl.classList.add("hidden");
    } finally {
      if (requestId === suggestSeq) suggestController = null;
    }
  }, 250);
});

document.addEventListener("click", e => {
  if (!suggestionsEl.contains(e.target) && e.target !== locationInput) {
    suggestionsEl.classList.add("hidden");
  }
});

function renderSuggestions(results) {
  if (!results.length) {
    suggestionsEl.classList.add("hidden");
    return;
  }
  suggestionsEl.innerHTML = "";
  for (const r of results.slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = r.label;
    li.addEventListener("click", () => {
      chosenDestination = r;
      locationInput.value = r.label;
      suggestionsEl.classList.add("hidden");
    });
    suggestionsEl.appendChild(li);
  }
  suggestionsEl.classList.remove("hidden");
}

searchBtn.addEventListener("click", runSearch);

async function runSearch() {
  if (searchBtn.disabled) return;

  setStatus("", false);
  plansEl.innerHTML = "";
  carparkLayer.clearLayers();

  const hours = parseFloat(hoursInput.value);
  const radius = parseFloat(radiusInput.value);
  const changes = parseInt(changesInput.value, 10);
  const arrival = arrivalInput.value;
  const dayType = (dayTypeInput && dayTypeInput.value) || "weekday";

  if (!arrival || !isFinite(hours) || hours <= 0) {
    setStatus("Please enter a valid arrival time and hours.", true);
    return;
  }

  searchBtn.disabled = true;
  const runId = ++searchSeq;

  let dest = chosenDestination;
  try {
    if (!dest) {
      const q = locationInput.value.trim();
      if (!q) {
        setStatus("Enter a postal code or address.", true);
        return;
      }
      setStatus("Looking up destination...", false, true);
      const hits = await geocode(q);
      if (runId !== searchSeq) return;
      if (!hits.length) {
        setStatus("No matching location found.", true);
        return;
      }
      dest = hits[0];
    }

    map.setView([dest.lat, dest.lng], 16);
    if (destMarker) destMarker.remove();
    destMarker = L.marker([dest.lat, dest.lng], { title: "Destination" })
      .addTo(map)
      .bindPopup(`<b>Destination</b><br/>${escapeHtml(dest.label)}`);

    setStatus("Loading carparks...", false, true);
    showPlansSkeleton();

    const hdb = loadHdbCarparks();
    const priv = loadPrivateCarparks();
    const allCarparks = [...hdb, ...priv];

    const nearby = [];
    for (const cp of allCarparks) {
      const d = walkingMetres(dest.lat, dest.lng, cp.lat, cp.lng);
      if (d <= radius) {
        nearby.push({
          ...cp,
          distance: d,
          _day_type: dayType
        });
      }
    }

    if (nearby.length === 0) {
      setStatus(`No carparks within ${radius}m. Try widening the radius.`, true);
      plansEl.innerHTML = "";
      return;
    }

    for (const cp of nearby) {
      const colour = cp.kind === "private" ? "#7c3aed" : "#0284c7";
      L.circleMarker([cp.lat, cp.lng], {
        radius: 7, color: "#fff", fillColor: colour, weight: 2, fillOpacity: 1
      })
        .bindPopup(
          `<b>${escapeHtml(cp.name || cp.car_park_no)}</b><br/>${escapeHtml(stripPostalPrefix(cp.address))}<br/>` +
          `<small>${cp.kind === "private" ? "Private / Mall" : "HDB"}</small>`
        )
        .addTo(carparkLayer);
    }

    const [hh, mm] = arrival.split(":").map(Number);
    const startMin = hh * 60 + mm;
    const endMin = startMin + Math.round(hours * 60);
    const prepared = Optimizer.prepare(nearby, startMin, endMin);

    const plans = [];
    for (let c = 0; c <= changes; c++) {
      const result = Optimizer.solvePrepared(prepared, c);
      if (result) plans.push({ allowedChanges: c, ...result });
    }

    const unique = [];
    const seen = new Set();
    for (const p of plans) {
      const key = p.plan.map(s => `${s.carpark.car_park_no}@${s.startMin}-${s.endMin}`).join("|");
      if (!seen.has(key)) { seen.add(key); unique.push(p); }
    }

    renderPlans(unique);
    const hdbCount = nearby.filter(c => c.kind === "hdb").length;
    const privCount = nearby.filter(c => c.kind === "private").length;
    setStatus(`Compared ${hdbCount} HDB and ${privCount} private carparks within ${radius}m.`);
  } catch (e) {
    setStatus("Search failed: " + e.message, true);
  } finally {
    if (runId === searchSeq) searchBtn.disabled = false;
  }
}

// Inline SVG icons used in step meta
const ICON = {
  clock:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  walk:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4" r="2"/><path d="m15 22-3-5 1-6-3 2-1 4m5 0-3-6-5-1m3 6H6"/></svg>`,
  timer:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="14" r="8"/><path d="M12 10v4l2 2M9 2h6"/></svg>`,
  ext:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// Classify a breakdown fragment into a chip style based on keywords.
function chipClass(frag) {
  const s = frag.toLowerCase();
  if (s.includes("free")) return "chip chip-free";
  if (s.includes("grace")) return "chip chip-grace";
  if (s.includes("cap")) return "chip chip-cap";
  if (s.includes("evening")) return "chip chip-evening";
  if (s.includes("night")) return "chip chip-night";
  return "chip";
}

function renderBreakdownChips(breakdown) {
  if (!breakdown) return "";
  // Split on " + " boundaries the rate calculator uses.
  const parts = breakdown.split(/\s+\+\s+/);
  return parts.map(p => `<span class="${chipClass(p)}">${escapeHtml(p)}</span>`).join("");
}

function showPlansSkeleton() {
  plansEl.innerHTML = `
    <div class="skeleton-card">
      <div class="skeleton-row">
        <div style="flex:1">
          <div class="skeleton-line w20"></div>
          <div class="skeleton-line h-title w60"></div>
          <div class="skeleton-line w40"></div>
        </div>
        <div class="skeleton-line h-cost"></div>
      </div>
      <div class="skeleton-step"><div class="skeleton-line w80"></div><div class="skeleton-line w60"></div></div>
      <div class="skeleton-step"><div class="skeleton-line w80"></div><div class="skeleton-line w40"></div></div>
    </div>
    <div class="skeleton-card">
      <div class="skeleton-row">
        <div style="flex:1">
          <div class="skeleton-line w20"></div>
          <div class="skeleton-line h-title w60"></div>
        </div>
        <div class="skeleton-line h-cost"></div>
      </div>
      <div class="skeleton-step"><div class="skeleton-line w80"></div><div class="skeleton-line w40"></div></div>
    </div>`;
}

function addPlanMarkers(plan) {
  carparkLayer.clearLayers();
  plan.forEach((stay, i) => {
    const icon = L.divIcon({
      className: "plan-marker-wrap",
      html: `<div class="plan-marker">${i + 1}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    L.marker([stay.carpark.lat, stay.carpark.lng], { icon, zIndexOffset: 1000 })
      .bindPopup(`<b>Step ${i + 1}: ${escapeHtml(stay.carpark.name || stay.carpark.car_park_no)}</b>`)
      .addTo(carparkLayer);
  });
}

function renderPlans(plans) {
  plansEl.innerHTML = "";
  if (!plans.length) {
    plansEl.innerHTML = `<div class="empty-state"><p>No plans to show.</p></div>`;
    return;
  }

  // Display in order of changes allowed (0, 1, 2, 3) so users see progression.
  const byChanges = [...plans].sort((a, b) => a.allowedChanges - b.allowedChanges);
  const cheapestTotal = Math.min(...plans.map(p => p.total));
  const baseline = byChanges[0].total; // "park once" baseline for savings calc
  const bestNoMove = byChanges.find(p => p.allowedChanges === 0) || byChanges[0];
  const bestOverall = byChanges.find(p => Math.abs(p.total - cheapestTotal) < 1e-9) || byChanges[0];
  let activeCard = null;

  function setActivePlan(card, plan) {
    if (activeCard) activeCard.classList.remove("selected");
    activeCard = card;
    if (activeCard) activeCard.classList.add("selected");
    addPlanMarkers(plan.plan);
  }

  plansEl.appendChild(renderPlanHighlights(bestNoMove, bestOverall));

  for (const p of byChanges) {
    const isBest = Math.abs(p.total - cheapestTotal) < 1e-9;
    const savings = baseline - p.total;
    const card = document.createElement("article");
    card.className = "plan" + (isBest ? " best" : "");
    card.tabIndex = 0;

    const titleText = p.allowedChanges === 0
      ? "Park once, stay put"
      : `Allow up to ${p.allowedChanges} move${p.allowedChanges === 1 ? "" : "s"}`;
    const usedMoves = p.plan.length - 1;
    const metaText = usedMoves === 0
      ? `Single carpark | no driving around`
      : `${p.plan.length} carparks | ${usedMoves} move${usedMoves === 1 ? "" : "s"}`;

    const savingsBadge = savings > 0.005
      ? `<div class="plan-savings">Save $${savings.toFixed(2)} vs parking once</div>`
      : "";

    card.innerHTML = `
      <div class="plan-header">
        <div>
          <div class="plan-label">Plan</div>
          <div class="plan-title">${titleText}</div>
          <div class="plan-meta">${metaText}</div>
        </div>
        <div class="plan-cost-wrap">
          <div class="plan-cost"><span class="currency">$</span>${p.total.toFixed(2)}</div>
          ${savingsBadge}
        </div>
      </div>
      <ul class="plan-steps"></ul>
    `;
    const list = card.querySelector(".plan-steps");

    p.plan.forEach((stay, i) => {
      const li = document.createElement("li");
      const from = formatTime(stay.startMin);
      const to = formatTime(stay.endMin);
      const durHours = (stay.endMin - stay.startMin) / 60;
      const walkMin = Math.max(1, Math.round(stay.carpark.distance / 80)); // ~80 m/min
      const kindTag = stay.carpark.kind === "private"
        ? '<span class="tag private">Private</span>'
        : '<span class="tag hdb">HDB</span>';
      const displayName = escapeHtml(stay.carpark.name || stay.carpark.car_park_no);
      const address = escapeHtml(stripPostalPrefix(stay.carpark.address));

      li.innerHTML = `
        <span class="step-num">${i + 1}</span>
        <div class="step-info">
          <div class="step-name">${displayName}${kindTag}</div>
          <div class="step-address">${address}</div>
          <div class="step-meta">
            <span class="step-meta-item">${ICON.clock}${from} -> ${to}</span>
            <span class="step-meta-item">${ICON.timer}${durHours.toFixed(1)}h</span>
            <span class="step-meta-item">${ICON.walk}${Math.round(stay.carpark.distance)}m | ~${walkMin} min walk</span>
          </div>
          <div class="step-breakdown">${renderBreakdownChips(stay.breakdown)}</div>
          <div class="step-directions">${ICON.ext}Open in Google Maps</div>
        </div>
        <div class="step-cost">$${stay.cost.toFixed(2)}</div>
      `;
      li.title = "Open in Google Maps";
      li.addEventListener("click", () => {
        const { lat, lng } = stay.carpark;
        const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
        window.open(url, "_blank", "noopener");
      });
      list.appendChild(li);
    });

    card.addEventListener("click", () => setActivePlan(card, p));
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      setActivePlan(card, p);
    });

    plansEl.appendChild(card);

    if (isBest || !activeCard) setActivePlan(card, p);
  }
}

function renderPlanHighlights(bestNoMove, bestOverall) {
  const wrap = document.createElement("section");
  wrap.className = "plan-highlights";
  wrap.innerHTML = `
    <div class="plan-highlights-header">
      <div>
        <div class="plan-highlights-eyebrow">Top picks</div>
        <h3 class="plan-highlights-title">Start with the clearest recommendation</h3>
      </div>
      <p class="plan-highlights-copy">Compare the easiest no-move option against the absolute cheapest plan before diving into the full breakdowns.</p>
    </div>
  `;

  wrap.appendChild(buildHighlightCard({
    title: "Best park-once option",
    subtitle: "No car moves required",
    plan: bestNoMove,
    savings: 0,
    tone: "calm"
  }));

  wrap.appendChild(buildHighlightCard({
    title: "Best overall option",
    subtitle: bestOverall.changes > 0
      ? `${bestOverall.changes} move${bestOverall.changes === 1 ? "" : "s"} for the lowest total`
      : "Same as the best no-move plan",
    plan: bestOverall,
    savings: Math.max(0, bestNoMove.total - bestOverall.total),
    tone: "success"
  }));

  return wrap;
}

function buildHighlightCard({ title, subtitle, plan, savings, tone }) {
  const el = document.createElement("article");
  el.className = `plan-highlight ${tone}`;

  const firstStay = plan.plan[0];
  const primaryName = escapeHtml(firstStay.carpark.name || firstStay.carpark.car_park_no);
  const distance = Math.round(firstStay.carpark.distance);
  const walkMin = Math.max(1, Math.round(firstStay.carpark.distance / 80));
  const moveLabel = plan.changes === 0
    ? "Single carpark"
    : `${plan.plan.length} carparks | ${plan.changes} move${plan.changes === 1 ? "" : "s"}`;
  const savingsText = savings > 0.005
    ? `Save $${savings.toFixed(2)} vs park-once`
    : "Lowest-friction choice";
  const toneBadge = tone === "success" ? "Lowest total" : "Least hassle";

  el.innerHTML = `
    <div class="plan-highlight-topline">
      <div class="plan-highlight-label">${title}</div>
      <div class="plan-highlight-badge">${toneBadge}</div>
    </div>
    <div class="plan-highlight-title">${primaryName}</div>
    <div class="plan-highlight-meta">${escapeHtml(subtitle)} | ${moveLabel}</div>
    <div class="plan-highlight-stats">
      <span class="plan-highlight-stat">${distance}m walk</span>
      <span class="plan-highlight-stat">~${walkMin} min on foot</span>
      <span class="plan-highlight-stat">${formatTime(plan.plan[0].startMin)} -> ${formatTime(plan.plan[plan.plan.length - 1].endMin)}</span>
    </div>
    <div class="plan-highlight-footer">
      <div class="plan-highlight-cost"><span class="currency">$</span>${plan.total.toFixed(2)}</div>
      <div class="plan-highlight-note">${escapeHtml(savingsText)}</div>
    </div>
  `;

  return el;
}

function formatTime(minutes) {
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.floor(minutes % 60);
  const dayOffset = Math.floor(minutes / 1440);
  const suffix = dayOffset > 0 ? ` +${dayOffset}d` : "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${suffix}`;
}

function setStatus(msg, isError, isLoading) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
  statusEl.classList.toggle("loading", !!isLoading);
}
