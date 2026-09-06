#!/usr/bin/env node
/** Local stdio transport for the native Inari MCP catalog. */
import { type InariMcpServerOptions } from "./server.js";
export interface InariMcpStdioOptions extends InariMcpServerOptions {
    /** Repository working directory used by the local GitHub adapter. */
    readonly repositoryRoot?: string;
    /** Default GitHub repository target used when a tool omits `repository`. */
    readonly repository?: string;
}
/** Start the native server on a caller-provided stdio transport. */
export declare function startInariMcpStdio(options?: InariMcpStdioOptions): Promise<void>;
/** Run the command-line stdio entrypoint. */
export declare function runInariMcpStdio(argv?: readonly string[]): Promise<number>;
