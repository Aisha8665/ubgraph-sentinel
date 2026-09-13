---
name: subgraph-sentinel
description: Audit a live subgraph deployment on The Graph for silent data corruption. Use when asked to verify, audit, or check the integrity of a subgraph, when a dashboard or frontend shows impossible values (negative TVL, volume that went down, totals that do not add up), or when someone wants to know whether indexed data can be trusted before building on it.
---

# Subgraph Sentinel

Property-based integrity verification for live subgraph deployments.

## Why this exists

Smart contracts fail loudly: a broken invariant reverts the transaction. Indexers
fail silently. A mishandled reorg, a rounding error in fee accumulation, a handler
that misses an event — the indexer keeps running and writes corrupted state to the
database. Frontends then display wrong balances, and nobody notices for months.

This skill checks whether a deployment's own historical state is internally
consistent, using live data from The Graph.

## When to use it

- Before integrating a subgraph you did not write
- When a value in a dashboard looks impossible
- As a pre-merge gate (the CLI exits non-zero on a defect)
- When auditing an ecosystem of deployments that share a schema

## What it checks

Three invariants, ordered by how hard the finding is to argue with.

| Invariant | Claim | Why it is hard to dismiss |
| --- | --- | --- |
| `monotonic` | Cumulative counters never decrease as blocks advance | Volume traded yesterday does not become untraded today |
| `prefix-sum` | Daily values summed from inception equal the cumulative field | Inactive days produce no snapshot, contribute zero, and carry forward — gaps are not false positives |
| `aggregate` | Protocol totals equal the sum across every pool | Flagged for review rather than as a defect: prices derived at different times can explain small gaps |

## Standards leverage

The checks bind to the **Messari standardized DEX AMM schema**, not to any one
protocol. The same binding runs unchanged against Uniswap V3, SushiSwap,
PancakeSwap and every other deployment speaking that schema, on every chain they
are deployed to. Adding a protocol costs one subgraph ID, not one integration.

## Setup

```bash
npm install
export GRAPH_API_KEY=...     # from Subgraph Studio
```

## Use

```bash
# Audit one deployment
npx tsx src/cli.ts audit FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS

# Sweep many, print only the ones with defects
npx tsx src/cli.ts hunt <id> <id> <id>

# Machine readable, for CI
npx tsx src/cli.ts audit <id> --json
```

Exit codes: `0` clean, `1` defect found, `2` error.

## MCP

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

Tools: `audit_subgraph`, `audit_subgraph_json`, `fetch_handler_context`.

## Explaining a finding

The auditor reports *that* an invariant broke and gives a reproduction query. To
work out *why*, call `fetch_handler_context` with the deployment ID from the
report. It returns the manifest, which maps events to handlers.

One constraint worth knowing before you plan around it: **IPFS stores the compiled
WASM, not the AssemblyScript source.** The manifest tells you which mapping file
owns the handler; the source itself lives in the project's public repository. For
Messari deployments that is `github.com/messari/subgraphs`.

## Reading the output

Every finding carries a `repro` block — GraphQL that a maintainer can paste into
the playground to see the same thing. A finding without one is not worth filing.

Counterexamples are minimal. Generated inputs are integer indices into
pre-fetched arrays, so fast-check's built-in integer shrinking collapses a
failure to the earliest offending pool and the earliest offending day. When two
regressions exist in the same series, the reported one is the first.