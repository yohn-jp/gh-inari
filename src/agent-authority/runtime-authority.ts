/**
 * Runtime Authority trust record schema.
 *
 * Canonical shape for the repository-native trust artifact described in
 * `docs/AGENT_CAPABILITY_AUTHORIZATION.md` section 6.1, intended to live at
 * `.github/inari/authorities/<authority-id>.json` on the repository's
 * protected canonical ref. This module validates that JSON shape only. It
 * does not read, write, publish, or register the file; it does not generate
 * or store the Runtime private key; and it performs no cryptographic
 * signature operation -- those are later Gate 1/2/3 concerns per the
 * architecture document's migration plan.
 *
 * A Runtime Authority record is delegation-only: `capabilityCeiling` bounds
 * what a Session Certificate signed by this Runtime may claim, not what the
 * Runtime itself may do to GitHub (section 7.1). Nothing in this module
 * accepts a raw GitHub permission name; see `./capability.js` for the closed
 * semantic vocabulary.
 */

import { validateEd25519PublicJwk, type Ed25519PublicJwk } from "./ed25519-jwk.js";
import { canonicalJsonString, type CanonicalJsonValue } from "./codec.js";
import { CAPABILITY_KINDS, isCapabilityKind, type CapabilityKind } from "./capability.js";

export const RUNTIME_AUTHORITY_CONTRACT_VERSION = 1 as const;
export type RuntimeAuthorityContractVersion = typeof RUNTIME_AUTHORITY_CONTRACT_VERSION;

export const RUNTIME_AUTHORITY_KIND = "runtime-authority" as const;

/** Repository-native trust-artifact location on the authoritative protected ref. */
export const RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY = ".github/inari/authorities" as const;
export const RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX = `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/` as const;

export const RUNTIME_AUTHORITY_STATUSES = Object.freeze(["active", "disabled"] as const);
export type RuntimeAuthorityStatus = (typeof RUNTIME_AUTHORITY_STATUSES)[number];

/** A trust record identifies its signer; bounded to a safe, `kid`-compatible identifier. */
export const MAX_RUNTIME_AUTHORITY_ID_LENGTH = 128 as const;
export const RUNTIME_AUTHORITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

/** Session Certificates are intentionally short-lived (architecture doc 9.3); this is a sanity ceiling, not a policy default. */
export const MIN_SESSION_TTL_SECONDS = 60 as const;
export const MAX_SESSION_TTL_SECONDS = 86_400 as const;

export const MAX_CAPABILITY_CEILING_SIZE = CAPABILITY_KINDS.length;

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export interface RuntimeAuthority {
  readonly version: RuntimeAuthorityContractVersion;
  readonly kind: typeof RUNTIME_AUTHORITY_KIND;
  readonly id: string;
  readonly key: Ed25519PublicJwk;
  readonly status: RuntimeAuthorityStatus;
  readonly notBefore: string;
  /** `null` means no expiry. */
  readonly notAfter: string | null;
  readonly maxSessionTtlSeconds: number;
  readonly capabilityCeiling: readonly CapabilityKind[];
}

export type RuntimeAuthorityDiagnosticCode =
  | "RUNTIME_AUTHORITY_INVALID_ROOT"
  | "RUNTIME_AUTHORITY_MISSING_PROPERTY"
  | "RUNTIME_AUTHORITY_UNKNOWN_PROPERTY"
  | "RUNTIME_AUTHORITY_UNSUPPORTED_VERSION"
  | "RUNTIME_AUTHORITY_INVALID_KIND"
  | "RUNTIME_AUTHORITY_INVALID_ID"
  | "RUNTIME_AUTHORITY_INVALID_KEY"
  | "RUNTIME_AUTHORITY_INVALID_STATUS"
  | "RUNTIME_AUTHORITY_INVALID_TIMESTAMP"
  | "RUNTIME_AUTHORITY_INVALID_TTL"
  | "RUNTIME_AUTHORITY_INVALID_CAPABILITY_CEILING";

export interface RuntimeAuthorityDiagnostic {
  readonly version: RuntimeAuthorityContractVersion;
  readonly code: RuntimeAuthorityDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface RuntimeAuthorityValidationResult {
  readonly valid: boolean;
  readonly value?: RuntimeAuthority;
  readonly diagnostics: readonly RuntimeAuthorityDiagnostic[];
}

const ROOT_KEYS = new Set([
  "version",
  "kind",
  "id",
  "key",
  "status",
  "notBefore",
  "notAfter",
  "maxSessionTtlSeconds",
  "capabilityCeiling",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createDiagnostic(
  code: RuntimeAuthorityDiagnosticCode,
  path: string,
  message: string,
): RuntimeAuthorityDiagnostic {
  return { version: RUNTIME_AUTHORITY_CONTRACT_VERSION, code, path, message };
}

function requireProperty(
  input: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: RuntimeAuthorityDiagnostic[],
): boolean {
  if (key in input) return true;
  diagnostics.push(createDiagnostic("RUNTIME_AUTHORITY_MISSING_PROPERTY", `${path}.${key}`, "Property is required."));
  return false;
}

function isValidRfc3339(value: unknown): value is string {
  return typeof value === "string" && RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

/** Validate an untrusted Runtime Authority trust record and canonicalize its shape. */
export function validateRuntimeAuthority(input: unknown, path = "$"): RuntimeAuthorityValidationResult {
  const diagnostics: RuntimeAuthorityDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [
        createDiagnostic("RUNTIME_AUTHORITY_INVALID_ROOT", path, "Runtime Authority record must be an object."),
      ],
    };
  }
  for (const key of Object.keys(input).sort(compareText)) {
    if (!ROOT_KEYS.has(key)) {
      diagnostics.push(
        createDiagnostic("RUNTIME_AUTHORITY_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not accepted."),
      );
    }
  }

  if (requireProperty(input, "version", path, diagnostics) && input.version !== RUNTIME_AUTHORITY_CONTRACT_VERSION) {
    diagnostics.push(
      createDiagnostic(
        "RUNTIME_AUTHORITY_UNSUPPORTED_VERSION",
        `${path}.version`,
        "Runtime Authority contract version is unsupported.",
      ),
    );
  }
  if (requireProperty(input, "kind", path, diagnostics) && input.kind !== RUNTIME_AUTHORITY_KIND) {
    diagnostics.push(
      createDiagnostic("RUNTIME_AUTHORITY_INVALID_KIND", `${path}.kind`, `kind must be "${RUNTIME_AUTHORITY_KIND}".`),
    );
  }

  let id: string | undefined;
  if (requireProperty(input, "id", path, diagnostics)) {
    if (
      typeof input.id !== "string" ||
      input.id.length === 0 ||
      input.id.length > MAX_RUNTIME_AUTHORITY_ID_LENGTH ||
      !RUNTIME_AUTHORITY_ID_PATTERN.test(input.id)
    ) {
      diagnostics.push(
        createDiagnostic("RUNTIME_AUTHORITY_INVALID_ID", `${path}.id`, "id must be a bounded lowercase identifier."),
      );
    } else {
      id = input.id;
    }
  }

  let key: Ed25519PublicJwk | undefined;
  if (requireProperty(input, "key", path, diagnostics)) {
    const keyResult = validateEd25519PublicJwk(input.key, `${path}.key`);
    if (!keyResult.valid || keyResult.value === undefined) {
      diagnostics.push(
        createDiagnostic("RUNTIME_AUTHORITY_INVALID_KEY", `${path}.key`, "key must be a valid Ed25519 public JWK."),
      );
    } else {
      key = keyResult.value;
    }
  }

  if (
    requireProperty(input, "status", path, diagnostics) &&
    !RUNTIME_AUTHORITY_STATUSES.includes(input.status as RuntimeAuthorityStatus)
  ) {
    diagnostics.push(
      createDiagnostic(
        "RUNTIME_AUTHORITY_INVALID_STATUS",
        `${path}.status`,
        `status must be one of ${RUNTIME_AUTHORITY_STATUSES.join(", ")}.`,
      ),
    );
  }

  let notBefore: string | undefined;
  if (requireProperty(input, "notBefore", path, diagnostics)) {
    if (!isValidRfc3339(input.notBefore)) {
      diagnostics.push(
        createDiagnostic(
          "RUNTIME_AUTHORITY_INVALID_TIMESTAMP",
          `${path}.notBefore`,
          "notBefore must be an RFC 3339 timestamp.",
        ),
      );
    } else {
      notBefore = input.notBefore;
    }
  }

  let notAfter: string | null | undefined;
  if (requireProperty(input, "notAfter", path, diagnostics)) {
    if (input.notAfter === null) {
      notAfter = null;
    } else if (!isValidRfc3339(input.notAfter)) {
      diagnostics.push(
        createDiagnostic(
          "RUNTIME_AUTHORITY_INVALID_TIMESTAMP",
          `${path}.notAfter`,
          "notAfter must be null or an RFC 3339 timestamp.",
        ),
      );
    } else if (notBefore !== undefined && Date.parse(input.notAfter) <= Date.parse(notBefore)) {
      diagnostics.push(
        createDiagnostic(
          "RUNTIME_AUTHORITY_INVALID_TIMESTAMP",
          `${path}.notAfter`,
          "notAfter must be strictly after notBefore.",
        ),
      );
    } else {
      notAfter = input.notAfter;
    }
  }

  let maxSessionTtlSeconds: number | undefined;
  if (requireProperty(input, "maxSessionTtlSeconds", path, diagnostics)) {
    const value = input.maxSessionTtlSeconds;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < MIN_SESSION_TTL_SECONDS ||
      value > MAX_SESSION_TTL_SECONDS
    ) {
      diagnostics.push(
        createDiagnostic(
          "RUNTIME_AUTHORITY_INVALID_TTL",
          `${path}.maxSessionTtlSeconds`,
          `maxSessionTtlSeconds must be an integer between ${MIN_SESSION_TTL_SECONDS} and ${MAX_SESSION_TTL_SECONDS}.`,
        ),
      );
    } else {
      maxSessionTtlSeconds = value;
    }
  }

  let capabilityCeiling: readonly CapabilityKind[] | undefined;
  if (requireProperty(input, "capabilityCeiling", path, diagnostics)) {
    const value = input.capabilityCeiling;
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAPABILITY_CEILING_SIZE) {
      diagnostics.push(
        createDiagnostic(
          "RUNTIME_AUTHORITY_INVALID_CAPABILITY_CEILING",
          `${path}.capabilityCeiling`,
          `capabilityCeiling must contain 1-${MAX_CAPABILITY_CEILING_SIZE} semantic capability kinds.`,
        ),
      );
    } else {
      const seen = new Set<string>();
      let ok = true;
      value.forEach((entry, index) => {
        if (!isCapabilityKind(entry)) {
          diagnostics.push(
            createDiagnostic(
              "RUNTIME_AUTHORITY_INVALID_CAPABILITY_CEILING",
              `${path}.capabilityCeiling[${index}]`,
              "Ceiling entries must be a recognized semantic capability kind, not a raw GitHub permission.",
            ),
          );
          ok = false;
          return;
        }
        if (seen.has(entry)) {
          diagnostics.push(
            createDiagnostic(
              "RUNTIME_AUTHORITY_INVALID_CAPABILITY_CEILING",
              `${path}.capabilityCeiling[${index}]`,
              "Ceiling entries must be unique.",
            ),
          );
          ok = false;
          return;
        }
        seen.add(entry);
      });
      if (ok) capabilityCeiling = Object.freeze([...(value as CapabilityKind[])]);
    }
  }

  if (
    diagnostics.length > 0 ||
    id === undefined ||
    key === undefined ||
    notBefore === undefined ||
    notAfter === undefined ||
    maxSessionTtlSeconds === undefined ||
    capabilityCeiling === undefined
  ) {
    return { valid: false, diagnostics };
  }

  return {
    valid: true,
    value: Object.freeze({
      version: RUNTIME_AUTHORITY_CONTRACT_VERSION,
      kind: RUNTIME_AUTHORITY_KIND,
      id,
      key,
      status: input.status as RuntimeAuthorityStatus,
      notBefore,
      notAfter,
      maxSessionTtlSeconds,
      capabilityCeiling,
    }),
    diagnostics: [],
  };
}

export class RuntimeAuthorityValidationError extends Error {
  readonly diagnostics: readonly RuntimeAuthorityDiagnostic[];

  constructor(diagnostics: readonly RuntimeAuthorityDiagnostic[]) {
    const first = diagnostics[0];
    super(first === undefined ? "Runtime Authority record is invalid." : `${first.path}: ${first.message}`);
    this.name = "RuntimeAuthorityValidationError";
    this.diagnostics = diagnostics;
  }
}

export function assertRuntimeAuthority(input: unknown, path = "$"): RuntimeAuthority {
  const result = validateRuntimeAuthority(input, path);
  if (!result.valid || result.value === undefined) throw new RuntimeAuthorityValidationError(result.diagnostics);
  return result.value;
}

/** Deterministic canonical serialization, reusing the shared JCS codec rather than a second stringify convention. */
export function canonicalRuntimeAuthorityJson(value: RuntimeAuthority): string {
  return canonicalJsonString(value as unknown as CanonicalJsonValue);
}

export function isRuntimeAuthorityActive(authority: RuntimeAuthority, now: Date): boolean {
  if (authority.status !== "active") return false;
  const nowMs = now.getTime();
  if (nowMs < Date.parse(authority.notBefore)) return false;
  if (authority.notAfter !== null && nowMs > Date.parse(authority.notAfter)) return false;
  return true;
}
