#!/usr/bin/env node
/**
 * MCP server.
 *
 * This is the reusable-infrastructure surface: any MCP client (Claude, Cursor,
 * ChatGPT) can audit a live deployment and then reason about the result.
 *
 * Note the division of labour. The deterministic phase runs here and owns the
 * finding. The explanation phase does not call a model from inside this
 * process — the client already is one. `fetch_handler_context` hands it the
 * manifest and handler source, and the client localises the fault. That keeps
 * the counterexample reproducible and the explanation attributable.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { gatewayFromEnv } from "./gateway.js";
import { audit } from "./runner.js";
import { renderMarkdown, toJson } from "./report.js";

const IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? "https://ipfs.network.thegraph.com/api/v0/cat";

const server = new McpServer({ name: "subgraph-sentinel", version: "0.1.0" });

server.tool(
  "audit_subgraph",
  "Run property-based integrity checks against a live subgraph deployment on The Graph. " +
    "Checks that cumulative counters never decrease, that daily values reconcile with the " +
    "cumulative fields they roll into, and that protocol totals equal the sum across pools. " +
    "Returns a markdown report with a reproduction query for every finding.",
  {
    subgraphId: z.string().describe("Subgraph ID from Graph Explorer, e.g. FUbEPQw1oMghy39..."),
    pools: z.number().int().min(1).max(50).default(8).describe("Pools to examine, by TVL"),
    runs: z.number().int().min(50).max(5000).default(400).describe("fast-check runs per property"),
  },
  async ({ subgraphId, pools, runs }) => {
    try {
      const gw = gatewayFromEnv(subgraphId);
      const report = await audit(gw, { pools, runs });
      return { content: [{ type: "text" as const, text: renderMarkdown(report) }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Audit failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "audit_subgraph_json",
  "Same audit as audit_subgraph but returns structured JSON, for chaining into further analysis.",
  {
    subgraphId: z.string(),
    pools: z.number().int().min(1).max(50).default(8),
  },
  async ({ subgraphId, pools }) => {
    try {
      const gw = gatewayFromEnv(subgraphId);
      const report = await audit(gw, { pools });
      return { content: [{ type: "text" as const, text: toJson(report) }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Audit failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "fetch_handler_context",
  "Fetch a deployment's manifest from IPFS so a failing field can be traced to the handler " +
    "that writes it. Important: IPFS stores the compiled WASM, not AssemblyScript source. " +
    "The manifest gives you the event-to-handler mapping and the mapping file path; the " +
    "source itself lives in the project's public repository (for Messari subgraphs, " +
    "github.com/messari/subgraphs).",
  {
    deploymentId: z.string().describe("Deployment ID starting Qm..., from the audit report"),
  },
  async ({ deploymentId }) => {
    try {
      const response = await fetch(`${IPFS_GATEWAY}?arg=${encodeURIComponent(deploymentId)}`);
      if (!response.ok) {
        return {
          content: [
            { type: "text" as const, text: `IPFS returned ${response.status} for ${deploymentId}` },
          ],
          isError: true,
        };
      }
      const manifest = await response.text();
      return {
        content: [
          {
            type: "text" as const,
            text: `Manifest for ${deploymentId}\n\n${manifest.slice(0, 20000)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Fetch failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);