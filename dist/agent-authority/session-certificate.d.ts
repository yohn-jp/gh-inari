/**
 * Session Certificate schema, canonical JWS signing input, and offline
 * admission evaluation against a trusted Runtime Authority record.
 *
 * Shape and semantics follow `docs/AGENT_CAPABILITY_AUTHORIZATION.md`
 * section 9: a Runtime-signed JWS (`alg: EdDSA`) binding one ephemeral
 * Session public key to an immutable repository identity, a bounded
 * task/capability claim set, and an expiry no later than the delegating
 * Runtime's `maxSessionTtlSeconds`.
 *
 * Scope boundary: this module defines the deterministic bytes a Runtime
 * signs and a decoder that structurally validates a certificate and detects
 * non-canonical ("drifted") encoding, plus the offline half of admission
 * (section 7.3's `Authority(S) ⊆ CapabilityCeiling(R)`, `TTL(S) <=
 * MaxSessionTTL(R)`, and repository-identity binding). It does not verify
 * the Ed25519 signature, does not hold or generate any private key, and does
 * not evaluate live repository policy or GitHub state
 * (`CurrentStateAdmission` in section 11.1) -- signature verification and
 * full App admission are later Gate 2/3 work.
 */
import { type Ed25519PublicJwk } from "./ed25519-jwk.js";
import { type CapabilityClaim } from "./capability.js";
import { type RuntimeAuthority } from "./runtime-authority.js";
export declare const SESSION_CERTIFICATE_CONTRACT_VERSION: 1;
export type SessionCertificateContractVersion = typeof SESSION_CERTIFICATE_CONTRACT_VERSION;
export declare const SESSION_CERTIFICATE_ALG: "EdDSA";
export declare const SESSION_CERTIFICATE_TYP: "inari-session+jwt";
export declare const MAX_OPAQUE_ID_LENGTH: 128;
export declare const MAX_CAPABILITIES: 16;
/** 2100-01-01T00:00:00Z; a sanity ceiling against absurd/overflowing Unix-time claims, not a policy default. */
export declare const MAX_UNIX_TIME_SECONDS: 4102444800;
export interface SessionCertificateHeader {
    readonly alg: typeof SESSION_CERTIFICATE_ALG;
    readonly typ: typeof SESSION_CERTIFICATE_TYP;
    /** Must resolve to an active trusted Runtime Authority `id`. */
    readonly kid: string;
}
export interface SessionCertificateRepository {
    /** Immutable GitHub repository ID; the sole security binding (architecture doc 9.1/18.6/18.7). */
    readonly id: string;
    /** Diagnostic-only; never a security boundary. */
    readonly name: string;
}
export interface SessionCertificateTask {
    readonly kind: "issue";
    readonly number: number;
}
export interface SessionCertificatePayload {
    readonly ver: SessionCertificateContractVersion;
    /** `runtime:<Runtime Authority id>`. */
    readonly iss: string;
    /** `session:<opaque session id>`. */
    readonly sub: string;
    readonly jti: string;
    readonly repository: SessionCertificateRepository;
    readonly sessionKey: Ed25519PublicJwk;
    readonly task?: SessionCertificateTask;
    readonly capabilities: readonly CapabilityClaim[];
    readonly iat: number;
    readonly nbf: number;
    readonly exp: number;
}
export type SessionCertificateDiagnosticCode = "SESSION_CERTIFICATE_INVALID_ROOT" | "SESSION_CERTIFICATE_MISSING_PROPERTY" | "SESSION_CERTIFICATE_UNKNOWN_PROPERTY" | "SESSION_CERTIFICATE_UNSUPPORTED_VERSION" | "SESSION_CERTIFICATE_INVALID_ALG" | "SESSION_CERTIFICATE_INVALID_TYP" | "SESSION_CERTIFICATE_INVALID_KID" | "SESSION_CERTIFICATE_INVALID_ISSUER" | "SESSION_CERTIFICATE_INVALID_SUBJECT" | "SESSION_CERTIFICATE_INVALID_JTI" | "SESSION_CERTIFICATE_INVALID_REPOSITORY" | "SESSION_CERTIFICATE_INVALID_SESSION_KEY" | "SESSION_CERTIFICATE_INVALID_TASK" | "SESSION_CERTIFICATE_INVALID_CAPABILITIES" | "SESSION_CERTIFICATE_TASK_SCOPE_MISMATCH" | "SESSION_CERTIFICATE_INVALID_TIME" | "SESSION_CERTIFICATE_HEADER_ISSUER_MISMATCH" | "SESSION_CERTIFICATE_INVALID_ENCODING" | "SESSION_CERTIFICATE_CANONICAL_DRIFT";
export interface SessionCertificateDiagnostic {
    readonly version: SessionCertificateContractVersion;
    readonly code: SessionCertificateDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export interface SessionCertificateValidationResult<T> {
    readonly valid: boolean;
    readonly value?: T;
    readonly diagnostics: readonly SessionCertificateDiagnostic[];
}
export declare function validateSessionCertificateHeader(input: unknown, path?: string): SessionCertificateValidationResult<SessionCertificateHeader>;
export declare function validateSessionCertificatePayload(input: unknown, path?: string): SessionCertificateValidationResult<SessionCertificatePayload>;
export interface SessionCertificateSigningInput {
    readonly encodedHeader: string;
    readonly encodedPayload: string;
    /** The exact UTF-8 bytes an Ed25519 Runtime signature is computed over. */
    readonly signingInput: string;
}
/**
 * Build the deterministic JWS signing input for a header/payload pair: each
 * segment is the base64url encoding of its RFC 8785 canonical JSON form, so
 * two independent conformant implementations produce byte-identical output
 * for the same claims.
 */
export declare function sessionCertificateSigningInput(header: SessionCertificateHeader, payload: SessionCertificatePayload): SessionCertificateSigningInput;
/** Assemble the three-segment compact JWS from an already-computed Ed25519 signature (base64url, 64 raw bytes). */
export declare function encodeSessionCertificateCompact(header: SessionCertificateHeader, payload: SessionCertificatePayload, signature: string): string;
export interface DecodedSessionCertificate {
    readonly header: SessionCertificateHeader;
    readonly payload: SessionCertificatePayload;
    readonly signingInput: string;
    readonly signature: string;
}
/**
 * Parse and structurally validate a compact Session Certificate. This never
 * verifies the Ed25519 signature; it verifies structure, bounds, and that
 * the wire encoding is exactly the canonical encoding this module would have
 * produced (a mismatch here -- "signature-input drift" -- means the bytes an
 * eventual verifier would recompute the signature over are not the bytes the
 * decoded claims canonicalize to, which is rejected outright rather than
 * silently re-canonicalized).
 */
export declare function decodeSessionCertificateCompact(compact: unknown): SessionCertificateValidationResult<DecodedSessionCertificate>;
export declare class SessionCertificateValidationError extends Error {
    readonly diagnostics: readonly SessionCertificateDiagnostic[];
    constructor(diagnostics: readonly SessionCertificateDiagnostic[]);
}
export type SessionCertificateRuntimeAuthorityDiagnosticCode = "SESSION_CERTIFICATE_UNTRUSTED_RUNTIME" | "SESSION_CERTIFICATE_RUNTIME_NOT_ACTIVE" | "SESSION_CERTIFICATE_REPOSITORY_MISMATCH" | "SESSION_CERTIFICATE_NOT_YET_VALID" | "SESSION_CERTIFICATE_EXPIRED" | "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING" | "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING";
export interface SessionCertificateRuntimeAuthorityDiagnostic {
    readonly code: SessionCertificateRuntimeAuthorityDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export interface SessionCertificateRuntimeAuthorityContext {
    readonly runtimeAuthority: RuntimeAuthority;
    /** The immutable repository ID the caller is evaluating this certificate for (architecture doc 18.6). */
    readonly expectedRepositoryId: string;
    readonly now: Date;
}
export interface SessionCertificateRuntimeAuthorityEvaluation {
    readonly admitted: boolean;
    readonly diagnostics: readonly SessionCertificateRuntimeAuthorityDiagnostic[];
}
/**
 * Offline half of architecture doc section 7.3/11.1's `EffectiveAuthority`
 * intersection: repository binding, Runtime trust/activity, TTL ceiling, and
 * capability ceiling containment. `RepositoryPolicy(current canonical ref)`
 * and `CurrentStateAdmission(GitHub evidence)` require live repository/App
 * state and are explicitly out of scope for this schema-only Issue.
 */
export declare function evaluateSessionCertificateAgainstRuntimeAuthority(certificate: {
    readonly header: SessionCertificateHeader;
    readonly payload: SessionCertificatePayload;
}, context: SessionCertificateRuntimeAuthorityContext): SessionCertificateRuntimeAuthorityEvaluation;
