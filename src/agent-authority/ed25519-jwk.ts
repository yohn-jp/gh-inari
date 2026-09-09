/**
 * Shared Ed25519 public-key JWK contract.
 *
 * Both the Runtime Authority trust record and the Session Certificate carry
 * an Ed25519 public key in JWK form. This module owns that one shape so
 * neither record reimplements key-structural validation; it validates the
 * public-key encoding only and never touches private-key material, storage,
 * generation, or signature verification, all of which are out of scope for
 * this schema layer.
 */

const OKP_KTY = "OKP" as const;
const ED25519_CRV = "Ed25519" as const;
/** Raw Ed25519 public keys are exactly 32 bytes; JWK `x` carries them unpadded base64url-encoded. */
const ED25519_PUBLIC_KEY_BYTES = 32 as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
/** ceil(32 * 4 / 3) unpadded base64url characters for 32 raw bytes. */
const ED25519_X_LENGTH = 43 as const;

export interface Ed25519PublicJwk {
  readonly kty: typeof OKP_KTY;
  readonly crv: typeof ED25519_CRV;
  /** Unpadded base64url encoding of the 32-byte raw Ed25519 public key. */
  readonly x: string;
}

export type Ed25519PublicJwkDiagnosticCode =
  | "ED25519_JWK_INVALID_ROOT"
  | "ED25519_JWK_UNKNOWN_PROPERTY"
  | "ED25519_JWK_MISSING_PROPERTY"
  | "ED25519_JWK_INVALID_KTY"
  | "ED25519_JWK_INVALID_CRV"
  | "ED25519_JWK_INVALID_KEY_MATERIAL";

export interface Ed25519PublicJwkDiagnostic {
  readonly code: Ed25519PublicJwkDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface Ed25519PublicJwkValidationResult {
  readonly valid: boolean;
  readonly value?: Ed25519PublicJwk;
  readonly diagnostics: readonly Ed25519PublicJwkDiagnostic[];
}

const JWK_KEYS = new Set(["kty", "crv", "x"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: Ed25519PublicJwkDiagnosticCode, path: string, message: string): Ed25519PublicJwkDiagnostic {
  return { code, path, message };
}

export function validateEd25519PublicJwk(input: unknown, path = "$.key"): Ed25519PublicJwkValidationResult {
  const diagnostics: Ed25519PublicJwkDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [diagnostic("ED25519_JWK_INVALID_ROOT", path, "Public key must be an object.")],
    };
  }
  for (const key of Object.keys(input).sort()) {
    if (!JWK_KEYS.has(key)) {
      diagnostics.push(diagnostic("ED25519_JWK_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not accepted."));
    }
  }
  if (!("kty" in input)) {
    diagnostics.push(diagnostic("ED25519_JWK_MISSING_PROPERTY", `${path}.kty`, "Property is required."));
  } else if (input.kty !== OKP_KTY) {
    diagnostics.push(diagnostic("ED25519_JWK_INVALID_KTY", `${path}.kty`, `Key type must be "${OKP_KTY}".`));
  }
  if (!("crv" in input)) {
    diagnostics.push(diagnostic("ED25519_JWK_MISSING_PROPERTY", `${path}.crv`, "Property is required."));
  } else if (input.crv !== ED25519_CRV) {
    diagnostics.push(diagnostic("ED25519_JWK_INVALID_CRV", `${path}.crv`, `Curve must be "${ED25519_CRV}".`));
  }
  if (!("x" in input)) {
    diagnostics.push(diagnostic("ED25519_JWK_MISSING_PROPERTY", `${path}.x`, "Property is required."));
  } else {
    const x = input.x;
    if (
      typeof x !== "string" ||
      x.length !== ED25519_X_LENGTH ||
      !BASE64URL_PATTERN.test(x) ||
      !decodesToExpectedLength(x)
    ) {
      diagnostics.push(
        diagnostic(
          "ED25519_JWK_INVALID_KEY_MATERIAL",
          `${path}.x`,
          `Public key must be unpadded base64url encoding ${ED25519_PUBLIC_KEY_BYTES} raw bytes.`,
        ),
      );
    }
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  return {
    valid: true,
    value: Object.freeze({ kty: OKP_KTY, crv: ED25519_CRV, x: (input as { x: string }).x }),
    diagnostics: [],
  };
}

function decodesToExpectedLength(x: string): boolean {
  try {
    return Buffer.from(x, "base64url").length === ED25519_PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

export function assertEd25519PublicJwk(input: unknown, path = "$.key"): Ed25519PublicJwk {
  const result = validateEd25519PublicJwk(input, path);
  if (!result.valid || result.value === undefined) {
    const first = result.diagnostics[0];
    throw new TypeError(first === undefined ? "Invalid Ed25519 public key." : `${first.path}: ${first.message}`);
  }
  return result.value;
}
