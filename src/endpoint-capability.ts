/**
 * The closed read-capability vocabulary owned by Endpoint authorization.
 *
 * Endpoint read capabilities are intentionally independent from delegated
 * Agent mutation capabilities.  A claim names exactly one Endpoint read
 * operation and carries no implied authority for any other operation.
 */

export const ENDPOINT_CAPABILITY_KINDS = Object.freeze(["repository.read", "work.read", "presence.read"] as const);
export type EndpointCapabilityKind = (typeof ENDPOINT_CAPABILITY_KINDS)[number];
export type EndpointReadOperation = EndpointCapabilityKind;

export interface EndpointCapability {
  readonly kind: EndpointCapabilityKind;
}

export type EndpointCapabilityDiagnosticCode =
  | "ENDPOINT_CAPABILITY_INVALID_ROOT"
  | "ENDPOINT_CAPABILITY_MISSING_PROPERTY"
  | "ENDPOINT_CAPABILITY_UNKNOWN_PROPERTY"
  | "ENDPOINT_CAPABILITY_UNSUPPORTED_KIND"
  | "ENDPOINT_CAPABILITY_UNSUPPORTED_OPERATION";

export interface EndpointCapabilityDiagnostic {
  readonly code: EndpointCapabilityDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EndpointCapabilityValidationResult {
  readonly valid: boolean;
  readonly value?: EndpointCapability;
  readonly diagnostics: readonly EndpointCapabilityDiagnostic[];
}

function diagnostic(
  code: EndpointCapabilityDiagnosticCode,
  path: string,
  message: string,
): EndpointCapabilityDiagnostic {
  return Object.freeze({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEndpointCapabilityKind(value: unknown): value is EndpointCapabilityKind {
  return typeof value === "string" && ENDPOINT_CAPABILITY_KINDS.includes(value as EndpointCapabilityKind);
}

function capabilityForKind(kind: EndpointCapabilityKind): EndpointCapability {
  return Object.freeze({ kind });
}

/** Validate one closed Endpoint read-capability claim. */
export function validateEndpointCapability(value: unknown, path = "$"): EndpointCapabilityValidationResult {
  if (!isRecord(value)) {
    return {
      valid: false,
      diagnostics: [
        diagnostic("ENDPOINT_CAPABILITY_INVALID_ROOT", path, "Endpoint capability claim must be a plain object."),
      ],
    };
  }

  const diagnostics: EndpointCapabilityDiagnostic[] = [];
  if (!Object.prototype.hasOwnProperty.call(value, "kind")) {
    diagnostics.push(
      diagnostic("ENDPOINT_CAPABILITY_MISSING_PROPERTY", `${path}.kind`, "Required property is missing."),
    );
  } else if (!isEndpointCapabilityKind(value.kind)) {
    diagnostics.push(
      diagnostic(
        "ENDPOINT_CAPABILITY_UNSUPPORTED_KIND",
        `${path}.kind`,
        "Endpoint capability kind is not a recognized V1 read capability.",
      ),
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key !== "kind") {
      diagnostics.push(
        diagnostic(
          "ENDPOINT_CAPABILITY_UNKNOWN_PROPERTY",
          typeof key === "string" ? `${path}.${key}` : path,
          "Property is not accepted by the closed Endpoint capability contract.",
        ),
      );
    }
  }

  if (diagnostics.length > 0) return { valid: false, diagnostics: Object.freeze(diagnostics) };
  return {
    valid: true,
    value: capabilityForKind(value.kind as EndpointCapabilityKind),
    diagnostics: [],
  };
}

/** Total V1 mapping from each Endpoint read operation to its exact claim. */
export const ENDPOINT_READ_OPERATION_CAPABILITIES: Readonly<Record<EndpointReadOperation, EndpointCapability>> =
  Object.freeze({
    "repository.read": capabilityForKind("repository.read"),
    "work.read": capabilityForKind("work.read"),
    "presence.read": capabilityForKind("presence.read"),
  });

/** Return the exact capability required by a V1 read operation. */
export function endpointCapabilityForOperation(operation: unknown): EndpointCapability {
  if (typeof operation !== "string" || !ENDPOINT_CAPABILITY_KINDS.includes(operation as EndpointReadOperation)) {
    throw new TypeError(`Unsupported Endpoint read operation: ${String(operation)}`);
  }
  return ENDPOINT_READ_OPERATION_CAPABILITIES[operation as EndpointReadOperation];
}
