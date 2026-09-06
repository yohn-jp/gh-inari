/** Transport-neutral native Inari MCP server. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  INARI_MCP_TOOL_CONTRACT_VERSION,
  registerSemanticBranchTools,
  registerSemanticIssueTools,
  registerSemanticPullRequestTools,
  type NativeSemanticPullRequestDependencies,
} from "./tools.js";

export const INARI_MCP_SERVER_NAME = "inari" as const;
export const INARI_MCP_SERVER_VERSION = INARI_MCP_TOOL_CONTRACT_VERSION;

export interface InariMcpServerOptions extends NativeSemanticPullRequestDependencies {
  /** Optional embedding override; stdio and hosted transports use the same catalog. */
  readonly name?: string;
  readonly version?: string;
}

/**
 * Create the native Inari MCP server without selecting a transport.
 *
 * The server contains only the protocol-facing registration and delegates all
 * semantic work to the existing Core boundaries. A future HTTP adapter can
 * connect this same server/catalog without another implementation.
 */
export function createInariMcpServer(options: InariMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? INARI_MCP_SERVER_NAME,
      version: options.version ?? INARI_MCP_SERVER_VERSION,
    },
    {
      instructions:
        "Inari MCP exposes semantic Issue, Branch, and pull-request contract discovery, materialization, and read-only plan preview. Inari Core and the repository Canon remain authoritative; this server performs no GitHub mutation.",
    },
  );
  registerSemanticIssueTools(server, options);
  registerSemanticBranchTools(server, options);
  registerSemanticPullRequestTools(server, options);
  return server;
}
