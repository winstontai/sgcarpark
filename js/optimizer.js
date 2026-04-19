// Parking-plan optimiser (DP over time segments + carpark choice).
//
// A "plan" is an ordered list of entries (blocks). Each block is one continuous
// stay at one carpark. `maxChanges` caps the number of blocks to `maxChanges+1`.
//
// Correctness: we enumerate the globally cheapest carpark for every contiguous
// span of natural segments, then run a DP that picks the best partition of the
// stay into 1..maxBlocks blocks. This avoids the per-segment greedy trap where
// a locally-best carpark per segment isn't globally optimal (per-entry caps,
// night flat rates, etc.).

const DAY = 1440;

// Natural HDB rate boundaries - 7am (420) and 10:30pm (1350) each day.
// These are where rate changes happen, so switching carparks at other times
// can't beat switching here.
function boundariesBetween(startMin, endMin) {
  const marks = new Set([startMin, endMin]);
  for (let d = Math.floor(startMin / DAY); d <= Math.floor(endMin / DAY); d++) {
    [420, 1350].forEach(m => {
      const t = d * DAY + m;
      if (t > startMin && t < endMin) marks.add(t);
    });
  }
  return [...marks].sort((a, b) => a - b);
}

function segmentsFrom(startMin, endMin) {
  const marks = boundariesBetween(startMin, endMin);
  const segs = [];
  for (let i = 0; i < marks.length - 1; i++) {
    segs.push({ startMin: marks[i], endMin: marks[i + 1] });
  }
  return segs;
}

/**
 * Find the globally cheapest plan that uses at most (maxChanges + 1) blocks.
 */
function optimise(carparks, startMin, endMin, maxChanges) {
  if (!carparks.length || endMin <= startMin) return null;

  const segs = segmentsFrom(startMin, endMin);
  const M = segs.length;
  if (M === 0) return null;

  // blockBest[i][j] = cheapest single-entry stay covering segs[i..j] inclusive.
  // Key insight: we price the whole [i..j] span against every carpark, not just
  // per-segment. Per-entry caps / night flats are applied correctly for the
  // full block.
  const blockBest = Array.from({ length: M }, () => Array(M).fill(null));
  for (let i = 0; i < M; i++) {
    for (let j = i; j < M; j++) {
      const s = segs[i].startMin;
      const e = segs[j].endMin;
      let best = null;
      for (const cp of carparks) {
        const r = Rates.computeStayCost(cp, s, e);
        const betterCost = !best || r.cost < best.cost;
        const tieByDistance =
          best && r.cost === best.cost &&
          (cp.distance ?? 0) < (best.cp.distance ?? 0);
        if (betterCost || tieByDistance) {
          best = {
            cp,
            cost: r.cost,
            breakdown: r.breakdown,
            startMin: s,
            endMin: e
          };
        }
      }
      blockBest[i][j] = best;
    }
  }

  // DP. F[i][b] = min cost covering segs[0..i-1] using exactly b blocks.
  //      P[i][b] = backpointer { j, block }.
  const maxBlocks = maxChanges + 1;
  const F = Array.from({ length: M + 1 }, () => Array(maxBlocks + 1).fill(Infinity));
  const P = Array.from({ length: M + 1 }, () => Array(maxBlocks + 1).fill(null));
  F[0][0] = 0;

  for (let i = 1; i <= M; i++) {
    for (let b = 1; b <= maxBlocks; b++) {
      for (let j = 0; j < i; j++) {
        if (F[j][b - 1] === Infinity) continue;
        const block = blockBest[j][i - 1];
        if (!block) continue;
        const cand = F[j][b - 1] + block.cost;
        if (cand < F[i][b]) {
          F[i][b] = cand;
          P[i][b] = { j, block };
        }
      }
    }
  }

  // Pick the cheapest block-count; prefer fewer blocks on ties (= fewer moves).
  let bestB = -1, bestCost = Infinity;
  for (let b = 1; b <= maxBlocks; b++) {
    if (F[M][b] < bestCost - 1e-9) {
      bestCost = F[M][b];
      bestB = b;
    }
  }
  if (bestB < 0) return null;

  // Reconstruct the plan from backpointers.
  const plan = [];
  let idx = M, b = bestB;
  while (idx > 0 && b > 0) {
    const step = P[idx][b];
    if (!step) break;
    plan.unshift({
      carpark: step.block.cp,
      startMin: step.block.startMin,
      endMin: step.block.endMin,
      cost: step.block.cost,
      breakdown: step.block.breakdown
    });
    idx = step.j;
    b--;
  }

  return { plan, total: bestCost, changes: plan.length - 1 };
}

window.Optimizer = { optimise };
