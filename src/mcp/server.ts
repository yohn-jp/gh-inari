/** Transport-neutral native Inari MCP server. */

import { McpServer } from "@modelcontextprotocol/server";
import {
  INARI_MCP_TOOL_CONTRACT_VERSION,
  registerChangeTools,
  registerGoldenPathTools,
  registerIntegrationRoutingTools,
  registerImplementationTools,
  registerOperationalDiscoveryTools,
  registerSessionAuthorizedChangeTools,
  registerSemanticBranchTools,
  registerSemanticIssueTools,
  registerSemanticPullRequestTools,
  type NativeChangeDependencies,
} from "./tools.js";
import { createMcpSessionAppBridge } from "./session-app-bridge.js";
import { linkInariAppTool, registerInariAppResource } from "./apps/inari-app.js";

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
        "Inari MCP exposes semantic Issue, Branch, and pull-request contract discovery, materialization, read-only plan preview, observation, drift comparison, canonical Issue/Epic/Implementation routing validation, the read-only Golden Path entry/action and status projections, and the canonical Change implementation handoff. The default catalog performs no GitHub mutation. When an embedding supplies the existing Session-authorized App executor, optional Change execution and governed pullRequest.publish tools forward signed Session requests to that executor without adding MCP authorization. Governed pull-request comment/review/merge writes are not exposed through MCP, and MCP must not open a second authorization plane for them. Inari Core, the #409/#410 Golden Path projectors, and the repository Canon remain authoritative.",
    },
  );
  // The catalog registration surface remains owned by the existing MCP
  // tools module. The v2 server preserves that registration contract while
  // providing the extension-capable runtime at this boundary.
  const catalogServer = server as unknown as Parameters<typeof registerGoldenPathTools>[0];
  registerGoldenPathTools(catalogServer);
  registerIntegrationRoutingTools(catalogServer);
  registerOperationalDiscoveryTools(catalogServer, options);
  const issueTools = registerSemanticIssueTools(catalogServer, options);
  // The App metadata is attached to the existing read-only Issue view tool;
  // its handler and semantic/authorization dependencies remain unchanged.
  const issueViewTool = issueTools[4];
  if (issueViewTool === undefined) throw new Error("Inari Issue view tool registration is incomplete.");
  linkInariAppTool(issueViewTool);
  registerInariAppResource(server);
  registerSemanticBranchTools(catalogServer, options);
  registerSemanticPullRequestTools(catalogServer, options);
  registerImplementationTools(catalogServer, options);
  registerChangeTools(catalogServer, options);
  if (options.sessionExecutor !== undefined) {
    registerSessionAuthorizedChangeTools(catalogServer, createMcpSessionAppBridge(options.sessionExecutor));
  }
  return server;
}
