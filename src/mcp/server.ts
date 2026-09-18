/** Transport-neutral native Inari MCP server. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  INARI_MCP_TOOL_CONTRACT_VERSION,
  registerChangeTools,
  registerGoldenPathTools,
  registerSessionAuthorizedChangeTools,
  registerSemanticBranchTools,
  registerSemanticIssueTools,
  registerSemanticPullRequestTools,
  type NativeChangeDependencies,
} from "./tools.js";
import { createMcpSessionAppBridge } from "./session-app-bridge.js";

export const INARI_MCP_SERVER_NAME = "inari" as const;
export const INARI_MCP_SERVER_VERSION = INARI_MCP_TOOL_CONTRACT_VERSION;

export interface InariMcpServerOptions extends NativeChangeDependencies {
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
        "Inari MCP exposes semantic Issue, Branch, and pull-request contract discovery, materialization, read-only plan preview, observation, drift comparison, the read-only Golden Path entry/action and status projections, and the canonical Change implementation handoff. The default catalog performs no GitHub mutation. When an embedding supplies the existing Session-authorized App executor, the optional Change execution tool forwards signed Session requests to that executor without adding MCP authorization. Governed pull-request comment/review/merge writes are not exposed through MCP: the canonical Session-authorized App executor does not yet admit those operations, and MCP must not open a second authorization plane for them. Inari Core, the #409/#410 Golden Path projectors, and the repository Canon remain authoritative.",
    },
  );
  registerGoldenPathTools(server);
  registerSemanticIssueTools(server, options);
  registerSemanticBranchTools(server, options);
  registerSemanticPullRequestTools(server, options);
  registerChangeTools(server, options);
  if (options.sessionExecutor !== undefined) {
    registerSessionAuthorizedChangeTools(server, createMcpSessionAppBridge(options.sessionExecutor));
  }
  return server;
}
