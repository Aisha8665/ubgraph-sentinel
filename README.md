# Subgraph Sentinel

Property-based integrity verification for live subgraph deployments on The Graph.

Smart contracts have Foundry and Echidna. Indexers have nothing.

## The problem

When a smart contract breaks an invariant, the transaction reverts. When an
indexer breaks one, nothing happens. A mishandled reorg, a rounding error in fee
accumulation, a handler that misses an event — the indexer keeps going and writes
corrupted state into the database it serves from. Frontends display wrong
balances, liquidation bots read bad numbers, dashboards show impossible metrics.
The failure is silent, and it stays silent until somebody notices by eye.

Subgraph Sentinel checks whether a deployment's own historical state is
internally consistent, against live data, with no configuration.

## What it checks

Three invariants, ordered by how hard each finding is to explain away:

1. **`monotonic`** — cumulative counters never decrease as blocks advance.
   Ranked first because nothing innocent explains it. Volume traded yesterday
   does not become untraded today.
2. **`prefix-sum`** — daily values summed from inception equal the cumulative
   field they roll into. Days with no activity produce no snapshot, contribute
   zero, and carry the cumulative forward, so gaps are not false positives here.
3. **`aggregate`** — protocol totals equal the sum across every pool. Reported as
   *review* rather than *defect* unless the gap is large, because USD values
   derived at different times with different prices give a maintainer something
   to argue.

## Standards leverage

The checks bind to the **Messari standardized DEX AMM schema**, not to any single
protocol. One binding runs unchanged against Uniswap V3, SushiSwap, PancakeSwap
and every other deployment that speaks that schema, on every chain. Onboarding a
new protocol costs one subgraph ID, not one integration.

That is the whole argument for standardized schemas, made executable: the same
query pattern, the same invariants, across an entire category of protocol.

## Free shrinking

Generated inputs are integer indices into arrays fetched once, up front —
not synthesized data. fast-check already shrinks integers toward zero, so a
failure at (pool 47, day 903) collapses to the earliest offending pool and the
earliest offending day with no bespoke minimisation code.

This matters for `prefix-sum` in particular: shrinking the end index lands on the
*first* day the daily and cumulative series diverge, which is where the handler
bug is, rather than where it eventually became visible.

Verified in `test/shrinking.test.ts`: two regressions planted in a 900-day
series, and the reported counterexample is the first one.

## Install

```bash
npm install
cp .env.example .env      # add your Subgraph Studio API key
export GRAPH_API_KEY=...
```

## Use

```bash
npx tsx src/cli.ts audit <subgraphId>          # audit one deployment
npx tsx src/cli.ts hunt <id> <id> <id>         # sweep, print only defects
npx tsx src/cli.ts audit <id> --json           # machine readable
npx tsx src/cli.ts audit <id> --md             # markdown report
```

Exit codes: `0` clean, `1` defect found, `2` error. The non-zero exit is what
makes this usable unchanged as a pre-merge CI gate.

## MCP server

```json
{
  "mcpServers": {
    "subgraph-sentinel": {
      "command": "npx",
      "args": ["tsx", "/path/to/subgraph-sentinel/src/mcp.ts"],
      "env": { "GRAPH_API_KEY": "..." }
    }
  }
}
```

Three tools: `audit_subgraph`, `audit_subgraph_json`, `fetch_handler_context`.

The division of labour is deliberate. The deterministic phase finds the violation
and owns the counterexample. The explanation phase does not call a model from
inside this process — in MCP the client already is one. `fetch_handler_context`
returns the manifest and the client localises the fault. A hallucination there
produces a bad explanation next to a real, reproducible finding, never a fake bug.

## Architecture

```
subgraph id
   ├─ phase 1, deterministic ──────────────────────────────
   │    schema probe  →  invariant check  →  counterexample
   │                     (sample + shrink)
   └─ phase 2, model-assisted ─────────────────────────────
        manifest (IPFS) + handler source (repo)
                          ↓
             triage, then localise to a handler
```

## Known limits

Stated plainly, because a tool that overclaims is worse than one with a small
scope.

- **Reorg handling is not tested.** A live endpoint has already reconciled, and
  the pre-reorg state is gone. Testing that needs a local graph-node against a
  forked chain.
- **Cross-source differential is not implemented.** Comparing indexed state to
  `eth_call` at a pinned block is the natural next invariant; it needs an archive
  node and careful block pinning to avoid false positives from indexing lag.
- **IPFS holds compiled WASM, not AssemblyScript.** The manifest gives the
  event-to-handler mapping; the source comes from the project's public repo.
  Closed-source deployments get manifest-level explanation only.
- **Float comparison.** BigDecimal values are parsed to float64 and compared with
  a relative tolerance, configurable via `--tolerance`. Safe at USD magnitudes,
  not exact.
- **Scope is the Messari DEX AMM schema.** Other standardized schemas (lending,
  yield) follow the same shape but are not bound yet.

## Tests

```bash
npx tsx test/invariants.test.ts   # predicate correctness, offline
npx tsx test/shrinking.test.ts    # shrinking finds the earliest of two faults
```

## License

MIT
