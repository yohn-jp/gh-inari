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
declare const OKP_KTY: "OKP";
declare const ED25519_CRV: "Ed25519";
export interface Ed25519PublicJwk {
    readonly kty: typeof OKP_KTY;
    readonly crv: typeof ED25519_CRV;
    /** Unpadded base64url encoding of the 32-byte raw Ed25519 public key. */
    readonly x: string;
}
export type Ed25519PublicJwkDiagnosticCode = "ED25519_JWK_INVALID_ROOT" | "ED25519_JWK_UNKNOWN_PROPERTY" | "ED25519_JWK_MISSING_PROPERTY" | "ED25519_JWK_INVALID_KTY" | "ED25519_JWK_INVALID_CRV" | "ED25519_JWK_INVALID_KEY_MATERIAL";
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
export declare function validateEd25519PublicJwk(input: unknown, path?: string): Ed25519PublicJwkValidationResult;
export declare function assertEd25519PublicJwk(input: unknown, path?: string): Ed25519PublicJwk;
export {};
