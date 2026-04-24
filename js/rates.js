// Rate rules for Singapore carparks (HDB + curated private/mall).
//
// Two pricing paths:
//   1. HDB carparks - standardised schedule (set below)
//   2. Private/mall carparks - each carries its own `tariff` (see privateCarparks.js)

// ---------- HDB schedule ----------
const CENTRAL_CARPARKS = new Set([
  "ACB", "BBB", "BRB1", "CY", "DUXM", "HLM", "KAB", "KAM", "KAS",
  "PRM", "SLS", "SR1", "SR2", "TPM", "UCS", "WCB"
]);

const HDB_HALF_HOUR_CENTRAL = 1.20;
const HDB_HALF_HOUR_NORMAL  = 0.60;
const HDB_NIGHT_FLAT_FEE    = 5.00;
const HDB_DAY_START_MIN     = 7 * 60;       // 7:00am
const HDB_DAY_END_MIN       = 22 * 60 + 30; // 10:30pm

// ---------- shared helpers ----------

/**
 * Minutes within [startMin, endMin] that fall inside a recurring daily window
 * [windowStart, windowEnd] (both in minutes since midnight).
 */
function minutesInDailyWindow(startMin, endMin, windowStart, windowEnd) {
  let total = 0;
  let s = startMin;
  while (s < endMin) {
    const dayOffset = Math.floor(s / 1440) * 1440;
    const segEnd = Math.min(endMin, dayOffset + 1440);
    const winStart = dayOffset + windowStart;
    const winEnd = dayOffset + windowEnd;
    const a = Math.max(s, winStart);
    const b = Math.min(segEnd, winEnd);
    if (b > a) total += b - a;
    s = segEnd;
  }
  return total;
}

// ---------- HDB cost ----------
// Algorithm: split the stay into day-periods [07:00-22:30] and night-periods
// [22:30-07:00]. Charge each period at $0.60/30min (rounded up), then cap each
// night-period at $5. Sum everything.
function hdbStayCost(carpark, startMin, endMin) {
  if (endMin <= startMin) return { cost: 0, breakdown: "Free (no time)" };

  const isCentral = CENTRAL_CARPARKS.has(carpark.car_park_no);
  // HDB Free Parking Scheme: most non-central carparks are free on Sun/PH.
  // Central-area carparks still charge.
  if (carpark._day_type === "sunday_ph" && !isCentral) {
    return { cost: 0, breakdown: "Free on Sun/PH (Free Parking Scheme)" };
  }
  const rate = isCentral ? HDB_HALF_HOUR_CENTRAL : HDB_HALF_HOUR_NORMAL;

  let total = 0;
  const parts = [];
  const startDay = Math.floor(startMin / 1440);
  const endDay   = Math.floor((endMin - 1) / 1440);

  // Iterate from startDay-1 so the previous day's 22:30-07:00 night window
  // is considered for stays that begin in the early morning (e.g. 03:00).
  for (let d = startDay - 1; d <= endDay; d++) {
    const base = d * 1440;

    // Day period: 07:00 - 22:30
    const dS = Math.max(startMin, base + HDB_DAY_START_MIN);
    const dE = Math.min(endMin,   base + HDB_DAY_END_MIN);
    if (dE > dS) {
      const blocks = Math.ceil((dE - dS) / 30);
      const cost = blocks * rate;
      total += cost;
      parts.push(`Day ${blocks}x30min = $${cost.toFixed(2)}`);
    }

    // Night period: 22:30 - 07:00 next day
    const nS = Math.max(startMin, base + HDB_DAY_END_MIN);
    const nE = Math.min(endMin,   base + 1440 + HDB_DAY_START_MIN);
    if (nE > nS) {
      const blocks = Math.ceil((nE - nS) / 30);
      let cost = blocks * rate;
      let note = `Night ${blocks}x30min = $${cost.toFixed(2)}`;
      if (cost > HDB_NIGHT_FLAT_FEE) {
        cost = HDB_NIGHT_FLAT_FEE;
        note = `Night capped at $${HDB_NIGHT_FLAT_FEE.toFixed(2)}`;
      }
      total += cost;
      parts.push(note);
    }
  }

  if (total === 0) return { cost: 0, breakdown: "Free (outside chargeable hours)" };
  return { cost: total, breakdown: parts.join(" + ") + (isCentral ? " (central)" : "") };
}

// ---------- Private / mall cost ----------
// Hourly portion: applies the first tier (if set) for its covered minutes,
// then subsequent_rate_per_30min (if set) else rate_per_30min.
function hourlyCost(chargeMin, t, useWeekend) {
  const baseRate = (useWeekend && t.weekend_rate_per_30min) ? t.weekend_rate_per_30min : t.rate_per_30min;
  const subRate  = t.subsequent_rate_per_30min != null ? t.subsequent_rate_per_30min : baseRate;
  const firstTierMinutes = t.first_tier_minutes ?? (t.first_hour_rate != null ? 60 : null);
  const firstTierRate = t.first_hour_rate;

  if (firstTierRate != null && firstTierMinutes != null) {
    if (chargeMin <= firstTierMinutes) {
      const tierLabel = firstTierMinutes === 60
        ? "1st hr"
        : `1st ${formatTierMinutes(firstTierMinutes)}`;
      return { cost: firstTierRate, note: `${tierLabel} flat $${firstTierRate.toFixed(2)}` };
    }
    const after = chargeMin - firstTierMinutes;
    const blocks = Math.ceil(after / 30);
    const cost = firstTierRate + blocks * subRate;
    const tierLabel = firstTierMinutes === 60
      ? "1st hr"
      : `1st ${formatTierMinutes(firstTierMinutes)}`;
    return {
      cost,
      note: `${tierLabel} $${firstTierRate.toFixed(2)} + ${blocks} x 30min @ $${subRate.toFixed(2)}`
    };
  }
  const blocks = Math.ceil(chargeMin / 30);
  return { cost: blocks * baseRate, note: `${blocks} x 30min @ $${baseRate.toFixed(2)}` };
}

function formatTierMinutes(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hr${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
}

function privateStayCost(carpark, startMin, endMin) {
  const t = carpark.tariff;
  const durationMin = endMin - startMin;
  if (durationMin <= 0) return { cost: 0, breakdown: "Free (no time)" };

  // Grace period (e.g. first 15 min free)
  const graceMin = t.first_free_minutes || 0;
  const chargeableDur = Math.max(0, durationMin - graceMin);
  if (chargeableDur === 0) {
    return { cost: 0, breakdown: "Within grace period" };
  }

  const effectiveStart = startMin + graceMin;
  const isWeekendDay = carpark._day_type === "saturday" || carpark._day_type === "sunday_ph";
  const useWeekend = isWeekendDay && t.weekend_rate_per_30min;

  // Split into evening-flat-entry window vs rest.
  const ev = t.evening_per_entry;
  let totalCost = 0;
  const notes = [];

  const cStart = t.chargeable_start ?? 0;
  const cEnd   = t.chargeable_end ?? 1440;

  // Minutes inside the evening-flat window (per day), and outside it.
  // If the evening window ends at midnight AND there's an overnight gap before
  // the next morning's chargeable_start, treat that gap as part of the evening
  // entry - a "$X per entry after Ypm" tariff covers overnight stays until the
  // next morning, not just until midnight.
  let eveningMin = 0;
  if (ev) {
    eveningMin = minutesInDailyWindow(effectiveStart, endMin, ev.start_min, ev.end_min);
    if (ev.end_min === 1440 && cStart > 0) {
      eveningMin += minutesInDailyWindow(effectiveStart, endMin, 0, cStart);
    }
  }
  // Hourly-chargeable minutes: inside chargeable window but outside evening window.
  let hourlyMin;
  if (ev) {
    // We need intersection of [chargeable window] and [NOT evening window].
    const inChargeable = minutesInDailyWindow(effectiveStart, endMin, cStart, cEnd);
    const evInChargeable = minutesInDailyWindow(effectiveStart, endMin,
      Math.max(cStart, ev.start_min),
      Math.min(cEnd,   ev.end_min));
    hourlyMin = Math.max(0, inChargeable - evInChargeable);
  } else {
    hourlyMin = (cStart === 0 && cEnd === 1440)
      ? chargeableDur
      : minutesInDailyWindow(effectiveStart, endMin, cStart, cEnd);
  }

  if (hourlyMin > 0) {
    const h = hourlyCost(hourlyMin, t, useWeekend);
    totalCost += h.cost;
    notes.push(h.note);
  }
  if (eveningMin > 0) {
    totalCost += ev.price;
    notes.push(`Evening flat $${ev.price.toFixed(2)}`);
  }

  if (totalCost === 0 && !notes.length) {
    return { cost: 0, breakdown: "Free (outside chargeable hours)" };
  }

  if (t.per_entry_cap != null && totalCost > t.per_entry_cap) {
    totalCost = t.per_entry_cap;
    notes.length = 0;
    notes.push(`Capped at $${t.per_entry_cap.toFixed(2)}/entry`);
  }

  return { cost: totalCost, breakdown: notes.join(" + ") };
}

// ---------- dispatcher ----------
function computeStayCost(carpark, startMin, endMin) {
  if (carpark.tariff) return privateStayCost(carpark, startMin, endMin);
  return hdbStayCost(carpark, startMin, endMin);
}

window.Rates = {
  computeStayCost,
  CENTRAL_CARPARKS,
  HDB_NIGHT_FLAT_FEE
};
