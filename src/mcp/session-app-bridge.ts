/**
 * Thin MCP-to-App bridge for the canonical Session-authorized execution path.
 *
 * MCP owns only the protocol boundary. The supplied executor remains the
 * authority for Session request verification, proof-of-possession,
 * capability admission, trusted Change/Core/XState execution, and App
 * effects. This bridge deliberately does not parse, re-sign, enrich, or
 * otherwise reinterpret the signed request envelope.
 */

import type {
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
} from "../session-authorized-change-executor.js";

export interface McpSessionAppBridge {
  /** Forward the canonical Session request envelope without reinterpretation. */
  execute(envelope: unknown): Promise<CapabilityAuthorizedSessionExecutionResult>;
}

function isSessionExecutor(value: unknown): value is CapabilityAuthorizedSessionExecutor {
  return typeof value === "object" && value !== null && "execute" in value && typeof value.execute === "function";
}

/**
 * Adapt one existing Session-authorized executor to the MCP protocol seam.
 * No MCP-specific certificate, capability, or Session state is introduced.
 */
export function createMcpSessionAppBridge(executor: CapabilityAuthorizedSessionExecutor): McpSessionAppBridge {
  if (!isSessionExecutor(executor)) throw new TypeError("MCP Session/App bridge executor is invalid.");
  return Object.freeze({
    execute: (envelope: unknown) => executor.execute(envelope),
  });
}
