/** Transport-neutral native Inari MCP server. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type NativeChangeDependencies } from "./tools.js";
export declare const INARI_MCP_SERVER_NAME: "inari";
export declare const INARI_MCP_SERVER_VERSION: "1";
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
export declare function createInariMcpServer(options?: InariMcpServerOptions): McpServer;
