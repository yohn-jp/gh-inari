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
import { type Ed25519PublicJwk } from "./ed25519-jwk.js";
import { type CapabilityKind } from "./capability.js";
export declare const RUNTIME_AUTHORITY_CONTRACT_VERSION: 1;
export type RuntimeAuthorityContractVersion = typeof RUNTIME_AUTHORITY_CONTRACT_VERSION;
export declare const RUNTIME_AUTHORITY_KIND: "runtime-authority";
export declare const RUNTIME_AUTHORITY_STATUSES: readonly ["active", "disabled"];
export type RuntimeAuthorityStatus = (typeof RUNTIME_AUTHORITY_STATUSES)[number];
/** A trust record identifies its signer; bounded to a safe, `kid`-compatible identifier. */
export declare const MAX_RUNTIME_AUTHORITY_ID_LENGTH: 128;
export declare const RUNTIME_AUTHORITY_ID_PATTERN: RegExp;
/** Session Certificates are intentionally short-lived (architecture doc 9.3); this is a sanity ceiling, not a policy default. */
export declare const MIN_SESSION_TTL_SECONDS: 60;
export declare const MAX_SESSION_TTL_SECONDS: 86400;
export declare const MAX_CAPABILITY_CEILING_SIZE: 6;
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
export type RuntimeAuthorityDiagnosticCode = "RUNTIME_AUTHORITY_INVALID_ROOT" | "RUNTIME_AUTHORITY_MISSING_PROPERTY" | "RUNTIME_AUTHORITY_UNKNOWN_PROPERTY" | "RUNTIME_AUTHORITY_UNSUPPORTED_VERSION" | "RUNTIME_AUTHORITY_INVALID_KIND" | "RUNTIME_AUTHORITY_INVALID_ID" | "RUNTIME_AUTHORITY_INVALID_KEY" | "RUNTIME_AUTHORITY_INVALID_STATUS" | "RUNTIME_AUTHORITY_INVALID_TIMESTAMP" | "RUNTIME_AUTHORITY_INVALID_TTL" | "RUNTIME_AUTHORITY_INVALID_CAPABILITY_CEILING";
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
/** Validate an untrusted Runtime Authority trust record and canonicalize its shape. */
export declare function validateRuntimeAuthority(input: unknown, path?: string): RuntimeAuthorityValidationResult;
export declare class RuntimeAuthorityValidationError extends Error {
    readonly diagnostics: readonly RuntimeAuthorityDiagnostic[];
    constructor(diagnostics: readonly RuntimeAuthorityDiagnostic[]);
}
export declare function assertRuntimeAuthority(input: unknown, path?: string): RuntimeAuthority;
/** Deterministic canonical serialization, reusing the shared JCS codec rather than a second stringify convention. */
export declare function canonicalRuntimeAuthorityJson(value: RuntimeAuthority): string;
export declare function isRuntimeAuthorityActive(authority: RuntimeAuthority, now: Date): boolean;
