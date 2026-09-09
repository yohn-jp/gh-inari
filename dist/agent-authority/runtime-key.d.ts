/**
 * Local Runtime Authority key management.
 *
 * This module owns only the local Ed25519 delegation key. It deliberately
 * does not create, write, or register a Runtime Authority trust record and it
 * has no GitHub/App transport. The public key returned here is suitable for a
 * #367 Runtime Authority record; repository trust remains a separate governed
 * operation owned by later work.
 */
import { type KeyObject } from "node:crypto";
import { type Ed25519PublicJwk } from "./ed25519-jwk.js";
/** PKCS#8 PEM is compact, standard, and contains no Runtime metadata or trust state. */
export declare const RUNTIME_PRIVATE_KEY_FILE_FORMAT: "PKCS#8-PEM";
/** A malformed or unsafe key file must not be allowed to consume unbounded local input. */
export declare const MAX_RUNTIME_PRIVATE_KEY_FILE_BYTES: number;
export type RuntimeAuthorityKeyErrorCode = "RUNTIME_AUTHORITY_KEY_INVALID_PATH" | "RUNTIME_AUTHORITY_KEY_NOT_FOUND" | "RUNTIME_AUTHORITY_KEY_EXISTS" | "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE" | "RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY" | "RUNTIME_AUTHORITY_KEY_STORAGE_FAILED";
/** Safe, non-secret diagnostics for local key-management failures. */
export declare class RuntimeAuthorityKeyError extends Error {
    readonly code: RuntimeAuthorityKeyErrorCode;
    constructor(code: RuntimeAuthorityKeyErrorCode, message: string);
}
export interface RuntimeAuthorityKeyPair {
    /** Local-only delegation signer. Never include this field in public output. */
    readonly privateKey: KeyObject;
    readonly publicKey: KeyObject;
    /** Public JWK compatible with #367's Runtime Authority `key` property. */
    readonly publicKeyJwk: Ed25519PublicJwk;
}
export interface PersistRuntimeAuthorityPrivateKeyOptions {
    /** Replacement is explicit; a normal generation never overwrites an existing key. */
    readonly replace?: boolean;
}
/** Generate an Ed25519 Runtime keypair entirely in local process memory. */
export declare function generateRuntimeAuthorityKeyPair(): RuntimeAuthorityKeyPair;
/** Return only the public JWK, whether the input is a public or private KeyObject or a generated pair. */
export declare function exportRuntimeAuthorityPublicKey(key: KeyObject | RuntimeAuthorityKeyPair): Ed25519PublicJwk;
/** Deterministic public-key JSON for embedding as #367's Runtime Authority `key` value. */
export declare function canonicalRuntimeAuthorityPublicKeyJson(key: Ed25519PublicJwk | KeyObject | RuntimeAuthorityKeyPair): string;
/**
 * Persist only the Runtime private key in a restrictive local secret file.
 * This function never writes a Runtime Authority record or any repository
 * path. Replacement is explicit and uses an atomic same-directory rename.
 */
export declare function persistRuntimeAuthorityPrivateKey(filePath: string, key: KeyObject, options?: PersistRuntimeAuthorityPrivateKeyOptions): string;
/** Generate a local keypair and persist only its private key. */
export declare function generateAndPersistRuntimeAuthorityKeyPair(filePath: string, options?: PersistRuntimeAuthorityPrivateKeyOptions): RuntimeAuthorityKeyPair;
/**
 * Load a local Runtime private key with descriptor-level no-follow and
 * restrictive ownership/mode checks. The returned key remains local process
 * state; no GitHub or repository operation is performed.
 */
export declare function loadRuntimeAuthorityPrivateKey(filePath: string): KeyObject;
/** Load and derive a complete local keypair without exposing private material in its public projection. */
export declare function loadRuntimeAuthorityKeyPair(filePath: string): RuntimeAuthorityKeyPair;
/** Default local secret-file location used by the CLI when no path is supplied. */
export declare function defaultRuntimeAuthorityPrivateKeyPath(): string;
