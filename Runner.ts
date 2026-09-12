/**
 * The property harness.
 *
 * Generated inputs are integers indexing into arrays that were fetched once,
 * up front. fast-check shrinks integers toward zero for free, so the reported
 * counterexample is the earliest offending pool and the earliest offending day
 * without any bespoke minimisation logic.
 */

import fc from "fast-check";
import type { Gateway } from "./gateway.js";
import {
  fetchFinancialSnapshots,
  fetchAllPools,
  fetchPoolSnapshots,
  fetchProtocol,
  fetchTopPools,
  probe,
  type PoolRef,
  type PoolSnapshot,
} from "./messari.js";
import {
  MONOTONIC_FIELDS,
  PREFIX_PAIRS,
  checkAggregate,
  checkMonotonic,
  checkPrefixSum,
  pairCount,
  type Violation,
} from "./invariants.js";

export interface AuditOptions {
  /** How many pools to examine, taken by descending TVL. */
  pools: number;
  /** fast-check runs per property. Scaled against series length. */
  runs: number;
  tolerance: number;
  onProgress?: (message: string) => void;
}

export interface AuditReport {
  subgraphId: string;
  deployment: string;
  headBlock: number;
  schemaVersion: string | null;
  hasIndexingErrors: boolean;
  protocolName: string | null;
  poolsExamined: number;
  snapshotsExamined: number;
  violations: Violation[];
  stats: { networkQueries: number; cacheHits: number; retries: number };
  elapsedMs: number;
}

export const DEFAULT_OPTIONS: AuditOptions = {
  pools: 12,
  runs: 400,
  tolerance: 1e-6,
};

export async function audit(gw: Gateway, options: Partial<AuditOptions> = {}): Promise<AuditReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const say = opts.onProgress ?? (() => {});
  const started = Date.now();

  const meta = await probe(gw);
  say(`Head block ${meta.block}, schema ${meta.schemaVersion ?? "unknown"}`);
  if (meta.hasIndexingErrors) {
    say("Warning: deployment reports indexing errors. Findings may be downstream of those.");
  }

  const protocol = await fetchProtocol(gw);
  const violations: Violation[] = [];
  let snapshotsExamined = 0;

  // INV-1 and INV-2, per pool, on the pools whose corruption would be noticed.
  const pools = await fetchTopPools(gw, opts.pools);
  say(`Examining ${pools.length} pools by descending TVL`);

  for (const pool of pools) {
    const snapshots = await fetchPoolSnapshots(gw, pool.id);
    snapshotsExamined += snapshots.length;
    if (snapshots.length < 2) continue;
    say(`  ${label(pool)} — ${snapshots.length} daily snapshots`);
    violations.push(...auditSeries(snapshots, pool.id, opts));
  }

  // The same two invariants one level up, on protocol-wide financials.
  const financials = await fetchFinancialSnapshots(gw);
  if (financials.length >= 2) {
    say(`Protocol financials — ${financials.length} daily snapshots`);
    snapshotsExamined += financials.length;
    violations.push(...auditSeries(financials, protocol.id, opts));
  }

  // INV-3 needs every pool, not just the top ones.
  say("Reconciling protocol totals against the full pool set");
  const allPools = await fetchAllPools(gw);
  const aggregate = checkAggregate(protocol, allPools, "cumulativeVolumeUSD");
  if (aggregate) violations.push(aggregate);

  return {
    subgraphId: gw.subgraphId,
    deployment: meta.deployment,
    headBlock: meta.block,
    schemaVersion: meta.schemaVersion,
    hasIndexingErrors: meta.hasIndexingErrors,
    protocolName: protocol.name,
    poolsExamined: pools.length,
    snapshotsExamined,
    violations: rank(violations),
    stats: { ...gw.stats },
    elapsedMs: Date.now() - started,
  };
}

/** Runs INV-1 and INV-2 over one ordered snapshot series. */
export function auditSeries(
  snapshots: PoolSnapshot[],
  subject: string,
  opts: AuditOptions,
): Violation[] {
  const found: Violation[] = [];
  const pairs = pairCount(snapshots);
  if (pairs < 1) return found;

  const runs = Math.min(Math.max(opts.runs, snapshots.length), 5000);

  // INV-1: shrinks to the earliest consecutive pair that goes backwards.
  for (const field of MONOTONIC_FIELDS) {
    const result = fc.check(
      fc.property(fc.nat({ max: pairs - 1 }), (i) =>
        checkMonotonic(snapshots, i, field, subject, opts.tolerance) === null,
      ),
      { numRuns: runs },
    );
    if (result.failed && result.counterexample) {
      const index = result.counterexample[0] as number;
      const violation = checkMonotonic(snapshots, index, field, subject, opts.tolerance);
      if (violation) found.push(violation);
    }
  }

  // INV-2: shrinks to the first day the daily series stops reconciling.
  for (const pair of PREFIX_PAIRS) {
    if (snapshots[0]?.[pair.daily] === undefined) continue;
    const result = fc.check(
      fc.property(fc.nat({ max: snapshots.length - 1 }), (i) =>
        checkPrefixSum(snapshots, i, pair, subject, opts.tolerance) === null,
      ),
      { numRuns: runs },
    );
    if (result.failed && result.counterexample) {
      const index = result.counterexample[0] as number;
      const violation = checkPrefixSum(snapshots, index, pair, subject, opts.tolerance);
      if (violation) found.push(violation);
    }
  }

  return found;
}

/** Defects before review items; within a class, larger gaps first. */
function rank(violations: Violation[]): Violation[] {
  const order = { monotonic: 0, "prefix-sum": 1, aggregate: 2 } as const;
  return [...violations].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "defect" ? -1 : 1;
    return order[a.invariant] - order[b.invariant];
  });
}

function label(pool: PoolRef): string {
  return pool.name ?? pool.id.slice(0, 10);
}