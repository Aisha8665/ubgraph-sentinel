/**
 * Bindings for the Messari standardized DEX AMM schema.
 *
 * Everything here is schema-shaped rather than protocol-shaped, which is the
 * whole point: one binding runs against Uniswap V3, SushiSwap, PancakeSwap and
 * every other deployment that speaks this schema, on any chain.
 */

import type { Gateway } from "./gateway.js";

/** Cumulative counters that must never decrease as blocks advance. */
export const CUMULATIVE_FIELDS = [
  "cumulativeVolumeUSD",
  "cumulativeSupplySideRevenueUSD",
  "cumulativeProtocolSideRevenueUSD",
  "cumulativeTotalRevenueUSD",
] as const;

/** Daily field paired with the cumulative counter it is supposed to roll into. */
export const PREFIX_SUM_PAIRS = [
  { daily: "dailyVolumeUSD", cumulative: "cumulativeVolumeUSD" },
  { daily: "dailySupplySideRevenueUSD", cumulative: "cumulativeSupplySideRevenueUSD" },
  { daily: "dailyProtocolSideRevenueUSD", cumulative: "cumulativeProtocolSideRevenueUSD" },
  { daily: "dailyTotalRevenueUSD", cumulative: "cumulativeTotalRevenueUSD" },
] as const;

export interface PoolRef {
  id: string;
  name: string | null;
  totalValueLockedUSD: string;
  cumulativeVolumeUSD: string;
  createdBlockNumber: string;
}

export interface PoolSnapshot {
  id: string;
  timestamp: string;
  blockNumber: string;
  [field: string]: string;
}

export interface ProtocolTotals {
  id: string;
  name: string | null;
  totalPoolCount: number;
  cumulativeVolumeUSD: string;
  cumulativeSupplySideRevenueUSD: string;
  cumulativeProtocolSideRevenueUSD: string;
  cumulativeTotalRevenueUSD: string;
  totalValueLockedUSD: string;
}

const SNAPSHOT_FIELDS = [
  "id",
  "timestamp",
  "blockNumber",
  ...PREFIX_SUM_PAIRS.map((p) => p.daily),
  ...CUMULATIVE_FIELDS,
].join("\n    ");

/** Cheap probe: does this deployment speak the Messari DEX schema at all? */
export const PROBE_QUERY = `query Probe {
  _meta { block { number } deployment hasIndexingErrors }
  dexAmmProtocols(first: 1) { id name schemaVersion subgraphVersion }
}`;

export async function probe(
  gw: Gateway,
): Promise<{ block: number; deployment: string; hasIndexingErrors: boolean; schemaVersion: string | null }> {
  const data = await gw.query<{
    _meta: { block: { number: number }; deployment: string; hasIndexingErrors: boolean };
    dexAmmProtocols: Array<{ schemaVersion?: string }>;
  }>(PROBE_QUERY);
  return {
    block: data._meta.block.number,
    deployment: data._meta.deployment,
    hasIndexingErrors: data._meta.hasIndexingErrors,
    schemaVersion: data.dexAmmProtocols[0]?.schemaVersion ?? null,
  };
}

export async function fetchProtocol(gw: Gateway): Promise<ProtocolTotals> {
  const data = await gw.query<{ dexAmmProtocols: ProtocolTotals[] }>(`query Protocol {
  dexAmmProtocols(first: 1) {
    id
    name
    totalPoolCount
    cumulativeVolumeUSD
    cumulativeSupplySideRevenueUSD
    cumulativeProtocolSideRevenueUSD
    cumulativeTotalRevenueUSD
    totalValueLockedUSD
  }
}`);
  const protocol = data.dexAmmProtocols[0];
  if (!protocol) throw new Error("No DexAmmProtocol entity found; not a Messari DEX subgraph.");
  return protocol;
}

/** Top pools by TVL. These are the ones whose corruption would actually be noticed. */
export async function fetchTopPools(gw: Gateway, first: number): Promise<PoolRef[]> {
  const data = await gw.query<{ liquidityPools: PoolRef[] }>(
    `query TopPools($first: Int!) {
  liquidityPools(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id
    name
    totalValueLockedUSD
    cumulativeVolumeUSD
    createdBlockNumber
  }
}`,
    { first },
  );
  return data.liquidityPools;
}

/** Every pool, paginated on id. Needed for the protocol-equals-sum check. */
export async function fetchAllPools(gw: Gateway, limit = 5000): Promise<PoolRef[]> {
  return gw.paginate<PoolRef>(
    (cursor) => ({
      query: `query AllPools($cursor: String!) {
  liquidityPools(first: 1000, orderBy: id, orderDirection: asc, where: { id_gt: $cursor }) {
    id
    name
    totalValueLockedUSD
    cumulativeVolumeUSD
    createdBlockNumber
  }
}`,
      variables: { cursor: cursor ?? "" },
    }),
    (data) => (data.liquidityPools as PoolRef[]) ?? [],
    "id",
    limit,
  );
}

/**
 * Full snapshot history for one pool, oldest first.
 *
 * Paginated on id because `skip` caps at 5000, then sorted numerically on
 * timestamp because snapshot ids sort lexicographically and "-10" lands
 * before "-9".
 */
export async function fetchPoolSnapshots(gw: Gateway, poolId: string): Promise<PoolSnapshot[]> {
  const rows = await gw.paginate<PoolSnapshot>(
    (cursor) => ({
      query: `query Snapshots($pool: String!, $cursor: String!) {
  liquidityPoolDailySnapshots(
    first: 1000
    orderBy: id
    orderDirection: asc
    where: { pool: $pool, id_gt: $cursor }
  ) {
    ${SNAPSHOT_FIELDS}
  }
}`,
      variables: { pool: poolId, cursor: cursor ?? "" },
    }),
    (data) => (data.liquidityPoolDailySnapshots as PoolSnapshot[]) ?? [],
    "id",
  );
  return rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

/** Protocol-wide daily snapshots, for the same checks one level up. */
export async function fetchFinancialSnapshots(gw: Gateway): Promise<PoolSnapshot[]> {
  const rows = await gw.paginate<PoolSnapshot>(
    (cursor) => ({
      query: `query Financials($cursor: String!) {
  financialsDailySnapshots(
    first: 1000
    orderBy: id
    orderDirection: asc
    where: { id_gt: $cursor }
  ) {
    ${SNAPSHOT_FIELDS}
  }
}`,
      variables: { cursor: cursor ?? "" },
    }),
    (data) => (data.financialsDailySnapshots as PoolSnapshot[]) ?? [],
    "id",
  );
  return rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

/**
 * BigDecimal arrives as a string. Parsing to float64 is safe for USD
 * magnitudes (~15 significant digits) but the comparison must be relative,
 * not absolute: a 0.01 gap is noise at $4bn and a real defect at $0.05.
 */
export function num(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function relativeGap(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale;
}