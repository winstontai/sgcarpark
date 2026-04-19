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

function qualifiesForHdbNight(startMin, endMin) {
  const nightStart = HDB_DAY_END_MIN;            // 22:30
  const nightEndNext = 24 * 60 + HDB_DAY_START_MIN; // +1 day 07:00 => 1860
  return startMin >= nightStart && endMin <= nightEndNext;
}

// ---------- HDB cost ----------
function hdbStayCost(carpark, startMin, endMin) {
  const durationMin = endMin - startMin;
  if (durationMin <= 0) return { cost: 0, breakdown: "Free (no time)" };

  const isCentral = CENTRAL_CARPARKS.has(carpark.car_park_no);
  const halfHourRate = isCentral ? HDB_HALF_HOUR_CENTRAL : HDB_HALF_HOUR_NORMAL;

  if (qualifiesForHdbNight(startMin, endMin) && carpark.night_parking_available) {
    return {
      cost: HDB_NIGHT_FLAT_FEE,
      breakdown: `HDB night flat $${HDB_NIGHT_FLAT_FEE.toFixed(2)}`
    };
  }

  const chargeMin = minutesInDailyWindow(
    startMin, endMin, HDB_DAY_START_MIN, HDB_DAY_END_MIN
  );
  if (chargeMin === 0) {
    return { cost: 0, breakdown: "Free (outside chargeable hours)" };
  }

  const blocks = Math.ceil(chargeMin / 30);
  const cost = blocks * halfHourRate;
  return {
    cost,
    breakdown: `${blocks} x 30min @ $${halfHourRate.toFixed(2)}` +
               (isCentral ? " (central)" : "")
  };
}

// ---------- Private / mall cost ----------
function privateStayCost(carpark, startMin, endMin) {
  const t = carpark.tariff;
  const durationMin = endMin - startMin;
  if (durationMin <= 0) return { cost: 0, breakdown: "Free (no time)" };

  // Grace period (e.g. first 15 min free)
  const chargeableDur = Math.max(0, durationMin - (t.first_free_minutes || 0));
  if (chargeableDur === 0) {
    return { cost: 0, breakdown: "Within grace period" };
  }

  // Chargeable window intersection (most malls are 24/7)
  const cStart = t.chargeable_start ?? 0;
  const cEnd = t.chargeable_end ?? 1440;
  let chargeMin;
  if (cStart === 0 && cEnd === 1440) {
    chargeMin = chargeableDur;
  } else {
    // Apply grace only at the start; reconstruct a shifted window.
    const effectiveStart = startMin + (t.first_free_minutes || 0);
    chargeMin = minutesInDailyWindow(effectiveStart, endMin, cStart, cEnd);
  }
  if (chargeMin === 0) {
    return { cost: 0, breakdown: "Free (outside chargeable hours)" };
  }

  // Pick weekday vs weekend rate. We don't know the actual weekday, so the UI
  // exposes a weekend flag; default = weekday.
  const useWeekend = !!carpark._use_weekend_rate && t.weekend_rate_per_30min;
  const rate = useWeekend ? t.weekend_rate_per_30min : t.rate_per_30min;

  const blocks = Math.ceil(chargeMin / 30);
  let cost = blocks * rate;
  let note = `${blocks} x 30min @ $${rate.toFixed(2)}`;

  if (t.per_entry_cap != null && cost > t.per_entry_cap) {
    cost = t.per_entry_cap;
    note = `Capped at $${t.per_entry_cap.toFixed(2)}/entry`;
  }

  return { cost, breakdown: note };
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
