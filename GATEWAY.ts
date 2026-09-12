/**
 * Cached GraphQL client for The Graph's decentralized gateway.
 *
 * The cache is not an optimisation here, it is load bearing. Shrinking
 * re-evaluates the same property against the same (pool, day) pairs many
 * times over. Without memoisation a single shrink run issues hundreds of
 * identical queries and burns the gateway quota.
 */

const DEFAULT_GATEWAY = "https://gateway.thegraph.com/api/subgraphs/id";

export interface GatewayStats {
  networkQueries: number;
  cacheHits: number;
  retries: number;
}

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GatewayError";
  }
}

export class Gateway {
  private readonly cache = new Map<string, unknown>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  readonly stats: GatewayStats = { networkQueries: 0, cacheHits: 0, retries: 0 };

  constructor(
    private readonly apiKey: string,
    readonly subgraphId: string,
    private readonly base: string = DEFAULT_GATEWAY,
  ) {
    if (!apiKey) throw new GatewayError("Missing gateway API key. Set GRAPH_API_KEY.");
    if (!subgraphId) throw new GatewayError("Missing subgraph id.");
  }

  get endpoint(): string {
    return `${this.base}/${this.subgraphId}`;
  }

  /** Deduplicated, memoised query. Identical (query, variables) never hits the network twice. */
  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const key = JSON.stringify({ query, variables });

    if (this.cache.has(key)) {
      this.stats.cacheHits++;
      return this.cache.get(key) as T;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = this.execute<T>(query, variables);
    this.inflight.set(key, promise);
    try {
      const result = await promise;
      this.cache.set(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const maxAttempts = 4;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        await sleep(400 * 2 ** (attempt - 1));
      }
      try {
        this.stats.networkQueries++;
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({ query, variables }),
        });

        if (response.status === 429 || response.status >= 500) {
          lastError = new GatewayError(`Gateway returned ${response.status}`, response.status);
          continue;
        }
        if (!response.ok) {
          const body = await response.text();
          throw new GatewayError(
            `Gateway returned ${response.status}: ${body.slice(0, 300)}`,
            response.status,
          );
        }

        const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
        if (payload.errors?.length) {
          // Indexers prune history. A time-travel query past the pruned
          // window fails here rather than silently returning nothing.
          throw new GatewayError(payload.errors.map((e) => e.message).join("; "));
        }
        if (!payload.data) throw new GatewayError("Gateway returned no data block.");
        return payload.data;
      } catch (error) {
        if (error instanceof GatewayError && error.status === undefined) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new GatewayError("Gateway request failed after retries.");
  }

  /**
   * Cursor pagination. The Graph caps `skip` at 5000, so anything that walks a
   * large collection has to page on a monotonic field instead.
   */
  async paginate<T>(
    build: (cursor: string | null) => { query: string; variables: Record<string, unknown> },
    extract: (data: Record<string, unknown>) => T[],
    cursorField: keyof T & string,
    limit = 5000,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;

    while (out.length < limit) {
      const { query, variables } = build(cursor);
      const data = await this.query<Record<string, unknown>>(query, variables);
      const page = extract(data);
      if (page.length === 0) break;
      out.push(...page);
      const last = page[page.length - 1];
      if (!last) break;
      const next = (last as Record<string, unknown>)[cursorField];
      if (next === undefined || next === null) break;
      cursor = String(next);
      if (page.length < 1000) break;
    }
    return out.slice(0, limit);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function gatewayFromEnv(subgraphId: string): Gateway {
  const key = process.env.GRAPH_API_KEY ?? "";
  const base = process.env.GRAPH_GATEWAY_BASE ?? DEFAULT_GATEWAY;
  return new Gateway(key, subgraphId, base);
}