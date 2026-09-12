/**
 * The invariants, as pure functions over already-fetched arrays.
 *
 * Every predicate is addressed by integer index. That is what makes shrinking
 * free: fast-check already knows how to shrink an integer toward zero, so a
 * failure at (pool 47, day 903) collapses to the earliest offending pool and
 * the earliest offending day without a line of custom minimisation code.
 *
 * Ordered by how hard the finding is to explain away. Run them in this order.
 */

import {
  CUMULATIVE_FIELDS,
  PREFIX_SUM_PAIRS,
  num,
  relativeGap,
  type PoolRef,
  type PoolSnapshot,
  type ProtocolTotals,
} from "./messari.js";

export type Severity = "defect" | "review";

export interface Violation {
  invariant: "monotonic" | "prefix-sum" | "aggregate";
  severity: Severity;
  field: string;
  subject: string;
  detail: string;
  observed: Record<string, string | number>;
  /** GraphQL a maintainer can paste to see it themselves. */
  repro: string;
}

export const DEFAULT_TOLERANCE = 1e-6;

/**
 * INV-1 monotonicity. A cumulative counter that decreases as blocks advance.
 *
 * Ranked first because there is no innocent reading of it. Volume traded
 * yesterday does not become untraded today. Pruned history, missing days and
 * re-derived prices all fail to explain a counter going backwards.
 */
export function checkMonotonic(
  snapshots: PoolSnapshot[],
  index: number,
  field: string,
  subject: string,
  tolerance = DEFAULT_TOLERANCE,
): Violation | null {
  const prev = snapshots[index];
  const next = snapshots[index + 1];
  if (!prev || !next) return null;

  const before = num(prev[field]);
  const after = num(next[field]);
  if (Number.isNaN(before) || Number.isNaN(after)) return null;
  if (after >= before) return null;
  if (relativeGap(before, after) < tolerance) return null;

  return {
    invariant: "monotonic",
    severity: "defect",
    field,
    subject,
    detail: `${field} decreased between two consecutive daily snapshots`,
    observed: {
      fromBlock: prev.blockNumber,
      toBlock: next.blockNumber,
      before,
      after,
      delta: after - before,
    },
    repro: reproSnapshotPair(subject, prev.id, next.id, field),
  };
}

/**
 * INV-2 prefix sum. Daily values summed from inception must equal the
 * cumulative counter at that point.
 *
 * A day with no activity produces no snapshot, contributes zero, and carries
 * the cumulative forward, so gaps are not a false positive here. Shrinking the
 * end index toward zero lands on the *first* day the two series diverge, which
 * is where the handler bug actually is rather than where it became visible.
 */
export function checkPrefixSum(
  snapshots: PoolSnapshot[],
  endIndex: number,
  pair: { daily: string; cumulative: string },
  subject: string,
  tolerance = DEFAULT_TOLERANCE,
): Violation | null {
  const end = snapshots[endIndex];
  if (!end) return null;

  let running = 0;
  for (let i = 0; i <= endIndex; i++) {
    const row = snapshots[i];
    if (!row) continue;
    const daily = num(row[pair.daily]);
    if (Number.isNaN(daily)) return null;
    running += daily;
  }

  const claimed = num(end[pair.cumulative]);
  if (Number.isNaN(claimed)) return null;

  const gap = relativeGap(running, claimed);
  if (gap < tolerance) return null;

  return {
    invariant: "prefix-sum",
    severity: "defect",
    field: `${pair.daily} -> ${pair.cumulative}`,
    subject,
    detail: `Daily values summed from inception do not reconcile with ${pair.cumulative}`,
    observed: {
      throughBlock: end.blockNumber,
      days: endIndex + 1,
      summedDaily: running,
      claimedCumulative: claimed,
      relativeGap: gap,
    },
    repro: reproSnapshotRange(subject, pair.daily, pair.cumulative),
  };
}

/**
 * INV-3 aggregation. Protocol totals versus the sum over every pool.
 *
 * Ranked last and marked "review" rather than "defect": a maintainer can
 * plausibly argue that USD values were derived at different times with
 * different prices. Real when the gap is large, arguable when it is small.
 */
export function checkAggregate(
  protocol: ProtocolTotals,
  pools: PoolRef[],
  field: "cumulativeVolumeUSD",
  tolerance = 1e-3,
): Violation | null {
  const summed = pools.reduce((acc, pool) => acc + num(pool[field]), 0);
  const claimed = num(protocol[field]);
  if (Number.isNaN(summed) || Number.isNaN(claimed)) return null;

  const gap = relativeGap(summed, claimed);
  if (gap < tolerance) return null;

  return {
    invariant: "aggregate",
    severity: gap > 0.05 ? "defect" : "review",
    field,
    subject: protocol.id,
    detail: `Protocol ${field} does not equal the sum across ${pools.length} pools`,
    observed: {
      poolsCounted: pools.length,
      totalPoolCount: protocol.totalPoolCount,
      summedPools: summed,
      claimedProtocol: claimed,
      relativeGap: gap,
    },
    repro: reproAggregate(field),
  };
}

/** Bounds helper so the runner never generates an index it cannot use. */
export function pairCount(snapshots: PoolSnapshot[]): number {
  return Math.max(0, snapshots.length - 1);
}

export const MONOTONIC_FIELDS = CUMULATIVE_FIELDS;
export const PREFIX_PAIRS = PREFIX_SUM_PAIRS;

function reproSnapshotPair(pool: string, beforeId: string, afterId: string, field: string): string {
  return `query Repro {
  before: liquidityPoolDailySnapshot(id: "${beforeId}") { id blockNumber ${field} }
  after:  liquidityPoolDailySnapshot(id: "${afterId}")  { id blockNumber ${field} }
  pool: liquidityPool(id: "${pool}") { id name ${field} }
}`;
}

function reproSnapshotRange(pool: string, daily: string, cumulative: string): string {
  return `query Repro {
  liquidityPoolDailySnapshots(
    first: 1000
    orderBy: timestamp
    orderDirection: asc
    where: { pool: "${pool}" }
  ) {
    id
    blockNumber
    timestamp
    ${daily}
    ${cumulative}
  }
}`;
}

function reproAggregate(field: string): string {
  return `query Repro {
  dexAmmProtocols(first: 1) { id totalPoolCount ${field} }
  liquidityPools(first: 1000, orderBy: id, orderDirection: asc) { id ${field} }
}`;
}