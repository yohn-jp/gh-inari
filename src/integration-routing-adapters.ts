/**
 * Transport adapters for the canonical integration-routing projector.
 *
 * CLI and MCP must expose the same Core result.  This module only unwraps the
 * bounded transport envelope and delegates route selection and validation to
 * `integration-routing.ts`; it does not infer parentage from branch names.
 */

import {
  tryProjectIntegrationRouting,
  type IntegrationRoutingDiagnostic,
  type IntegrationRoutingProjection,
  type IntegrationRoutingResult,
} from "./integration-routing.js";

export const INTEGRATION_ROUTING_ADAPTER_VERSION = 1 as const;

export interface IntegrationRoutingAdapterResult {
  readonly valid: boolean;
  readonly projection?: IntegrationRoutingProjection;
  readonly diagnostics: readonly IntegrationRoutingDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the direct Core route or the `{ routing: ... }` transport envelope.
 * The envelope is deliberately shallow: all route fields remain owned by the
 * Core projector and unknown fields are rejected there.
 */
function routeInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const keys = Object.keys(input);
  if (keys.length === 1 && Object.prototype.hasOwnProperty.call(input, "routing")) return input.routing;
  if (keys.length === 1 && Object.prototype.hasOwnProperty.call(input, "input")) return input.input;
  return input;
}

export function tryAdaptIntegrationRouting(input: unknown): IntegrationRoutingAdapterResult {
  const result: IntegrationRoutingResult = tryProjectIntegrationRouting(routeInput(input));
  return result;
}

/** Compatibility names for callers that describe the adapter as a validator. */
export const tryValidateIntegrationRouting = tryAdaptIntegrationRouting;
export const tryProjectIntegrationRoutingAdapter = tryAdaptIntegrationRouting;

export function adaptIntegrationRouting(input: unknown): IntegrationRoutingProjection {
  const result = tryAdaptIntegrationRouting(input);
  if (!result.valid || result.projection === undefined) {
    throw new Error(result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
  }
  return result.projection;
}

export const projectIntegrationRoutingAdapter = adaptIntegrationRouting;
