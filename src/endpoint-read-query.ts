/**
 * Closed, bounded query fields for the authenticated Endpoint read contract.
 *
 * The Endpoint API owns the meaning of these fields. Provider and projection
 * adapters receive only the normalized root selected by the caller.
 */

import type { EndpointReadOperation } from "./endpoint-capability.js";

export const ENDPOINT_READ_QUERY_VERSION = 1 as const;
export type EndpointReadQueryVersion = typeof ENDPOINT_READ_QUERY_VERSION;

/** GitHub Issue numbers are bounded before they reach any reader/provider. */
export const ENDPOINT_READ_QUERY_LIMITS = Object.freeze({
  maxRootIssue: 999_999_999,
} as const);

export interface EndpointReadQuery {
  readonly rootIssue?: number;
}

export type EndpointReadQueryDiagnosticCode =
  | "ENDPOINT_READ_QUERY_INVALID_ROOT"
  | "ENDPOINT_READ_QUERY_MISSING_ROOT"
  | "ENDPOINT_READ_QUERY_UNKNOWN_PROPERTY"
  | "ENDPOINT_READ_QUERY_UNSUPPORTED_FIELD"
  | "ENDPOINT_READ_QUERY_INVALID_ROOT_OBJECT"
  | "ENDPOINT_READ_QUERY_UNSUPPORTED_OPERATION";

export interface EndpointReadQueryDiagnostic {
  readonly code: EndpointReadQueryDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EndpointReadQueryValidationResult {
  readonly valid: boolean;
  readonly value?: EndpointReadQuery;
  readonly diagnostics: readonly EndpointReadQueryDiagnostic[];
}

const QUERY_KEYS = new Set(["rootIssue"]);

function diagnostic(code: EndpointReadQueryDiagnosticCode, path: string, message: string): EndpointReadQueryDiagnostic {
  return Object.freeze({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate and normalize the closed query for one Endpoint read operation. */
export function validateEndpointReadQuery(
  operation: unknown,
  value: unknown,
  path = "$.query",
): EndpointReadQueryValidationResult {
  if (operation !== "repository.read" && operation !== "work.read" && operation !== "presence.read") {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "ENDPOINT_READ_QUERY_UNSUPPORTED_OPERATION",
          "$.operation",
          "Endpoint read query operation is not supported.",
        ),
      ],
    };
  }

  if (value === undefined) {
    if (operation === "work.read") {
      return {
        valid: false,
        diagnostics: [
          diagnostic(
            "ENDPOINT_READ_QUERY_MISSING_ROOT",
            `${path}.rootIssue`,
            "work.read requires a positive bounded rootIssue.",
          ),
        ],
      };
    }
    return { valid: true, value: Object.freeze({}), diagnostics: [] };
  }

  if (!isRecord(value)) {
    return {
      valid: false,
      diagnostics: [
        diagnostic("ENDPOINT_READ_QUERY_INVALID_ROOT_OBJECT", path, "Endpoint read query must be a plain object."),
      ],
    };
  }

  const diagnostics: EndpointReadQueryDiagnostic[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !QUERY_KEYS.has(key)) {
      diagnostics.push(
        diagnostic(
          "ENDPOINT_READ_QUERY_UNKNOWN_PROPERTY",
          typeof key === "string" ? `${path}.${key}` : path,
          "Property is not accepted by the closed Endpoint read query contract.",
        ),
      );
    }
  }

  const hasRoot = Object.prototype.hasOwnProperty.call(value, "rootIssue");
  if (operation === "presence.read" && hasRoot) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_READ_QUERY_UNSUPPORTED_FIELD",
        `${path}.rootIssue`,
        "presence.read does not accept work query fields.",
      ),
    );
  }
  if (operation === "work.read" && !hasRoot) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_READ_QUERY_MISSING_ROOT",
        `${path}.rootIssue`,
        "work.read requires a positive bounded rootIssue.",
      ),
    );
  }
  if (hasRoot && operation !== "presence.read") {
    const rootIssue = value.rootIssue;
    if (
      typeof rootIssue !== "number" ||
      !Number.isSafeInteger(rootIssue) ||
      rootIssue < 1 ||
      rootIssue > ENDPOINT_READ_QUERY_LIMITS.maxRootIssue
    ) {
      diagnostics.push(
        diagnostic(
          "ENDPOINT_READ_QUERY_INVALID_ROOT",
          `${path}.rootIssue`,
          `rootIssue must be a positive safe integer no greater than ${ENDPOINT_READ_QUERY_LIMITS.maxRootIssue}.`,
        ),
      );
    }
  }

  if (diagnostics.length > 0) return { valid: false, diagnostics: Object.freeze(diagnostics) };
  return {
    valid: true,
    value: Object.freeze(hasRoot ? { rootIssue: value.rootIssue as number } : {}),
    diagnostics: [],
  };
}

export type EndpointReadQueryOperation = EndpointReadOperation;
