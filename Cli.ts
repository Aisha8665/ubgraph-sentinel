#!/usr/bin/env node
/**
 * CLI.
 *
 *   sentinel audit <subgraphId> [--pools N] [--runs N] [--json] [--md]
 *   sentinel hunt  <id> <id> ...   sweep several deployments, report only hits
 *
 * Requires GRAPH_API_KEY from Subgraph Studio.
 */

import { gatewayFromEnv, GatewayError } from "./gateway.js";
import { audit, DEFAULT_OPTIONS } from "./runner.js";
import { renderMarkdown, renderText, toJson } from "./report.js";

interface Flags {
  pools: number;
  runs: number;
  tolerance: number;
  json: boolean;
  md: boolean;
  quiet: boolean;
}

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {
    pools: DEFAULT_OPTIONS.pools,
    runs: DEFAULT_OPTIONS.runs,
    tolerance: DEFAULT_OPTIONS.tolerance,
    json: false,
    md: false,
    quiet: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--pools":
        flags.pools = Number(argv[++i] ?? flags.pools);
        break;
      case "--runs":
        flags.runs = Number(argv[++i] ?? flags.runs);
        break;
      case "--tolerance":
        flags.tolerance = Number(argv[++i] ?? flags.tolerance);
        break;
      case "--json":
        flags.json = true;
        break;
      case "--md":
        flags.md = true;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      default:
        positional.push(arg);
    }
  }
  return { positional, flags };
}

async function runAudit(subgraphId: string, flags: Flags): Promise<number> {
  const gw = gatewayFromEnv(subgraphId);
  const report = await audit(gw, {
    pools: flags.pools,
    runs: flags.runs,
    tolerance: flags.tolerance,
    onProgress: flags.quiet || flags.json ? undefined : (m) => process.stderr.write(`${m}\n`),
  });

  if (flags.json) process.stdout.write(toJson(report) + "\n");
  else if (flags.md) process.stdout.write(renderMarkdown(report) + "\n");
  else process.stdout.write(renderText(report));

  // Non-zero exit on a defect so this works unchanged as a CI gate.
  return report.violations.some((v) => v.severity === "defect") ? 1 : 0;
}

async function runHunt(ids: string[], flags: Flags): Promise<number> {
  let hits = 0;
  for (const id of ids) {
    process.stderr.write(`\n=== ${id} ===\n`);
    try {
      const gw = gatewayFromEnv(id);
      const report = await audit(gw, {
        pools: flags.pools,
        runs: flags.runs,
        tolerance: flags.tolerance,
        onProgress: undefined,
      });
      const defects = report.violations.filter((v) => v.severity === "defect");
      if (defects.length > 0) {
        hits++;
        process.stdout.write(renderText(report));
      } else {
        process.stderr.write(
          `clean — ${report.poolsExamined} pools, ${report.snapshotsExamined} snapshots\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`skipped: ${(error as Error).message}\n`);
    }
  }
  process.stderr.write(`\n${hits} of ${ids.length} deployments had defects\n`);
  return hits > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  if (!command || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  try {
    if (command === "audit") {
      const id = positional[0];
      if (!id) throw new Error("Usage: sentinel audit <subgraphId>");
      process.exit(await runAudit(id, flags));
    }
    if (command === "hunt") {
      if (positional.length === 0) throw new Error("Usage: sentinel hunt <id> [<id> ...]");
      process.exit(await runHunt(positional, flags));
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : (error as Error).message;
    process.stderr.write(`\nerror: ${message}\n`);
    process.exit(2);
  }
}

const USAGE = `subgraph-sentinel — property-based integrity verification for live subgraphs

  sentinel audit <subgraphId> [options]   audit one deployment
  sentinel hunt <id> [<id> ...]           sweep many, print only the ones with defects

Options
  --pools N       pools to examine, by descending TVL (default ${DEFAULT_OPTIONS.pools})
  --runs N        fast-check runs per property (default ${DEFAULT_OPTIONS.runs})
  --tolerance F   relative tolerance (default ${DEFAULT_OPTIONS.tolerance})
  --json          machine readable output
  --md            markdown report
  --quiet         suppress progress

Environment
  GRAPH_API_KEY   required, from Subgraph Studio

Exit codes
  0 clean   1 defect found   2 error
`;

main();