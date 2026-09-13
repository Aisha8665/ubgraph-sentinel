/**
 * Reporting. A finding is only useful if a maintainer can confirm it in one
 * paste, so every violation carries the GraphQL that reproduces it.
 */

import type { AuditReport } from "./runner.js";
import type { Violation } from "./invariants.js";

export function renderText(report: AuditReport): string {
  const lines: string[] = [];
  const defects = report.violations.filter((v) => v.severity === "defect");
  const review = report.violations.filter((v) => v.severity === "review");

  lines.push("");
  lines.push(`Subgraph    ${report.subgraphId}`);
  lines.push(`Deployment  ${report.deployment}`);
  lines.push(`Protocol    ${report.protocolName ?? "unknown"}`);
  lines.push(`Head block  ${report.headBlock}`);
  lines.push(`Schema      ${report.schemaVersion ?? "unknown"}`);
  lines.push(
    `Examined    ${report.poolsExamined} pools, ${report.snapshotsExamined} daily snapshots`,
  );
  lines.push(
    `Queries     ${report.stats.networkQueries} network, ${report.stats.cacheHits} served from cache`,
  );
  lines.push(`Elapsed     ${(report.elapsedMs / 1000).toFixed(1)}s`);
  lines.push("");

  if (report.hasIndexingErrors) {
    lines.push("! Deployment reports indexing errors. Findings may be downstream of those.");
    lines.push("");
  }

  if (report.violations.length === 0) {
    lines.push("No invariant violations found.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`${defects.length} defect(s), ${review.length} needing review`);
  lines.push("");

  for (const [i, v] of report.violations.entries()) {
    lines.push(`${i + 1}. [${v.severity}] ${v.invariant} — ${v.field}`);
    lines.push(`   subject: ${v.subject}`);
    lines.push(`   ${v.detail}`);
    for (const [k, val] of Object.entries(v.observed)) {
      lines.push(`     ${k.padEnd(20)} ${format(val)}`);
    }
    lines.push("");
    lines.push(indent(v.repro, "   "));
    lines.push("");
  }
  return lines.join("\n");
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# Integrity audit — ${report.protocolName ?? report.subgraphId}`);
  lines.push("");
  lines.push(`- Subgraph: \`${report.subgraphId}\``);
  lines.push(`- Deployment: \`${report.deployment}\``);
  lines.push(`- Head block: ${report.headBlock}`);
  lines.push(`- Examined: ${report.poolsExamined} pools, ${report.snapshotsExamined} snapshots`);
  lines.push("");

  if (report.violations.length === 0) {
    lines.push("No invariant violations found.");
    return lines.join("\n");
  }

  for (const v of report.violations) {
    lines.push(`## ${v.invariant} — \`${v.field}\``);
    lines.push("");
    lines.push(`**Severity:** ${v.severity}  `);
    lines.push(`**Subject:** \`${v.subject}\``);
    lines.push("");
    lines.push(v.detail);
    lines.push("");
    lines.push("| field | value |");
    lines.push("| --- | --- |");
    for (const [k, val] of Object.entries(v.observed)) {
      lines.push(`| ${k} | ${format(val)} |`);
    }
    lines.push("");
    lines.push("Reproduce:");
    lines.push("");
    lines.push("```graphql");
    lines.push(v.repro);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

/** Compact shape for the MCP server and for feeding an explanation model. */
export function toJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

export function summarize(v: Violation): string {
  return `${v.invariant}/${v.field} on ${v.subject.slice(0, 12)} — ${v.detail}`;
}

function format(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0)) {
      return value.toExponential(6);
    }
    return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
  return value;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}