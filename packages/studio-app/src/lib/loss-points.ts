// Bounded-memory loss retention for JobDetail live streams.
// Append raw until `cap`; on overflow compact to ~half so the whole-run
// shape stays visible. Tail-slice would discard initial convergence.

export type { LossPoint } from "../components/jobs/LossChart";

import type { LossPoint } from "../components/jobs/LossChart";

function hasEval(p: LossPoint): boolean {
  return typeof p.evalLoss === "number" && Number.isFinite(p.evalLoss);
}

function hasLoss(p: LossPoint): boolean {
  return typeof p.loss === "number" && Number.isFinite(p.loss);
}

/** Prefer sparse evalLoss, then loss min/max so spikes stay visible. */
function selectBucketReps(bucket: LossPoint[], budget: number): LossPoint[] {
  if (bucket.length <= budget) {
    return [...bucket];
  }
  if (budget <= 0) return [];

  const chosen = new Set<number>();

  const take = (i: number): boolean => {
    if (chosen.has(i) || chosen.size >= budget) return false;
    chosen.add(i);
    return true;
  };

  // evalLoss is sparse and valuable: prioritize keeping it.
  const evalIdx: number[] = [];
  for (const [i, point] of bucket.entries()) {
    if (hasEval(point)) {
      evalIdx.push(i);
    }
  }

  if (evalIdx.length > 0) {
    if (evalIdx.length <= budget) {
      // All evalLoss points fit: keep them all.
      for (const i of evalIdx) {
        take(i);
      }
    } else {
      // Budget is smaller: keep first, last, and extrema.
      take(evalIdx[0]);
      const lastIdx = evalIdx.at(-1);
      if (lastIdx !== undefined) take(lastIdx);

      let minI = evalIdx[0];
      let maxI = evalIdx[0];
      for (const i of evalIdx) {
        const minVal = bucket[minI].evalLoss;
        const maxVal = bucket[maxI].evalLoss;
        const curVal = bucket[i].evalLoss;

        if (
          typeof minVal === "number" &&
          typeof curVal === "number" &&
          curVal < minVal
        ) {
          minI = i;
        }
        if (
          typeof maxVal === "number" &&
          typeof curVal === "number" &&
          curVal > maxVal
        ) {
          maxI = i;
        }
      }

      take(minI);
      take(maxI);

      for (const i of evalIdx) {
        if (chosen.size >= budget) break;
        take(i);
      }
    }
  }

  // Among loss points, preserve local min/max so chart spikes remain.
  let minI: number | undefined;
  let maxI: number | undefined;

  for (let i = 0; i < bucket.length; i += 1) {
    if (chosen.has(i) || !hasLoss(bucket[i])) continue;

    const curVal = bucket[i].loss;
    if (minI === undefined) {
      minI = i;
    } else {
      const minVal = bucket[minI].loss;
      if (
        typeof minVal === "number" &&
        typeof curVal === "number" &&
        curVal < minVal
      ) {
        minI = i;
      }
    }

    if (maxI === undefined) {
      maxI = i;
    } else {
      const maxVal = bucket[maxI].loss;
      if (
        typeof maxVal === "number" &&
        typeof curVal === "number" &&
        curVal > maxVal
      ) {
        maxI = i;
      }
    }
  }

  if (minI !== undefined) take(minI);
  if (maxI !== undefined) take(maxI);

  // Fill remaining budget with earlier points (preserve temporal order bias).
  for (let i = 0; i < bucket.length && chosen.size < budget; i += 1) {
    take(i);
  }

  // ES2022: same unicorn/no-array-sort carve-out as LossChart / stats.
  // eslint-disable-next-line unicorn/no-array-sort
  return [...chosen].sort((a, b) => a - b).map((i) => bucket[i]);
}

function compactLossPoints(points: LossPoint[]): LossPoint[] {
  const n = points.length;
  if (n <= 2) {
    return [...points];
  }

  const first = points[0];
  const last = points[n - 1];

  const middle = points.slice(1, -1);
  if (middle.length === 0) {
    return [first, last];
  }

  // Compact to ~half the original size so appends can resume.
  const target = Math.max(2, Math.ceil(n / 2));
  const middleBudget = Math.max(0, target - 2);
  if (middleBudget === 0) {
    return [first, last];
  }
  if (middle.length <= middleBudget) {
    return [first, ...middle, last];
  }

  // ~2 reps/bucket so local min and max can both survive (shape + spikes).
  const bucketCount = Math.max(1, Math.ceil(middleBudget / 2));
  const out: LossPoint[] = [first];

  for (let b = 0; b < bucketCount; b += 1) {
    const start = Math.floor((b * middle.length) / bucketCount);
    const end = Math.floor(((b + 1) * middle.length) / bucketCount);
    if (start >= end) continue;

    const remaining = middleBudget - (out.length - 1);
    if (remaining <= 0) break;

    const budget = Math.min(2, remaining, end - start);
    const reps = selectBucketReps(middle.slice(start, end), budget);
    for (const rep of reps) {
      out.push(rep);
    }
  }

  out.push(last);
  return out;
}

/**
 * Append `incoming`. When `cap` would be exceeded, compact to ~half then
 * resume appends. Keeps first/last of the series under compaction.
 *
 * Downsampling preserves chart honesty: first/last are always kept (final
 * loss is always accurate; initial convergence stays visible), and bucket
 * min/max are preserved (spikes in the chart). Advanced panel stats
 * (mean, percentiles, etc.) are computed over the retained series only:
 * same data as the chart displays, so stats match what's visible.
 */
export function appendLossPoint(
  points: readonly LossPoint[],
  incoming: LossPoint,
  cap: number,
): LossPoint[] {
  if (cap < 1) return [];

  let next: LossPoint[] = [...points, incoming];
  if (next.length <= cap) return next;

  if (cap === 1) return [incoming];

  while (next.length > cap) {
    const compacted = compactLossPoints(next);
    if (compacted.length >= next.length) {
      // Pathological tiny-cap: keep series endpoints within cap.
      if (cap === 2) {
        const first = next[0];
        const last = next.at(-1);
        return [first, last].filter(Boolean) as LossPoint[];
      }
      return [next[0], ...next.slice(-(cap - 1))] as LossPoint[];
    }
    next = compacted;
  }
  return next;
}
