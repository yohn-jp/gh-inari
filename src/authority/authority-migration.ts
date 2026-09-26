/**
 * Legacy single-Authority import (#1200).
 *
 * The pre-#1200 Authority owner held one identity at `authority/config.json +
 * authority/private-key.pem` without an Authority ID. Import adopts that key
 * into Authority-ID-scoped custody under the trusted canonical Runtime
 * Authority record's ID, after proving the legacy descriptor, the legacy key
 * and the canonical record all name the same public key. Import never
 * generates or replaces a key, never writes a Runtime Authority record (so its
 * capability ceiling, TTL and validity window stay canonical), and never
 * removes the legacy files.
 */
import {
  delegatorPublicKeyFingerprint,
  exportDelegatorPublicKey,
  loadDelegatorKeyPair,
  type DelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import type { Delegator } from "../agent-authority/delegator.js";
import {
  localComponentPath,
  LocalControlError,
  readExistingLocalJson,
  validateLocalAuthorityConfig,
  type LocalAuthorityConfig,
} from "../local-control/config.js";
import {
  adoptLocalAuthorityKey,
  AuthorityStoreError,
  readLocalAuthorityIdentity,
  type LocalAuthorityPublicIdentity,
} from "./authority-store.js";

export type LegacyAuthorityImportErrorCode =
  "LEGACY_AUTHORITY_NOT_FOUND" | "LEGACY_AUTHORITY_UNSAFE" | "LEGACY_AUTHORITY_CONFLICT";

export class LegacyAuthorityImportError extends Error {
  readonly code: LegacyAuthorityImportErrorCode;

  constructor(code: LegacyAuthorityImportErrorCode, message: string) {
    super(message);
    this.name = "LegacyAuthorityImportError";
    this.code = code;
  }
}

function fail(code: LegacyAuthorityImportErrorCode, message: string): never {
  throw new LegacyAuthorityImportError(code, message);
}

export interface ImportLegacyLocalAuthorityOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** Trusted canonical Runtime Authority record whose ID becomes the owner storage identity. */
  readonly authority: Delegator;
}

export interface LegacyLocalAuthorityImport {
  readonly status: "imported" | "already-imported";
  readonly identity: LocalAuthorityPublicIdentity;
}

function readLegacyConfig(environment: NodeJS.ProcessEnv): LocalAuthorityConfig {
  let config: LocalAuthorityConfig | undefined;
  try {
    config = readExistingLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment);
  } catch (error: unknown) {
    if (error instanceof LocalControlError) fail("LEGACY_AUTHORITY_UNSAFE", error.message);
    throw error;
  }
  if (config === undefined) fail("LEGACY_AUTHORITY_NOT_FOUND", "Legacy Runtime Authority descriptor is absent.");
  return config;
}

function loadLegacyKey(config: LocalAuthorityConfig, environment: NodeJS.ProcessEnv): DelegatorKeyPair {
  let key: DelegatorKeyPair;
  try {
    key = loadDelegatorKeyPair(localComponentPath("authority", config.privateKeyFile, environment));
  } catch {
    fail("LEGACY_AUTHORITY_UNSAFE", "Legacy Runtime Authority private key could not be loaded safely.");
  }
  if (
    exportDelegatorPublicKey(key).x !== config.publicKey.x ||
    delegatorPublicKeyFingerprint(key) !== config.publicKeyFingerprint
  )
    fail("LEGACY_AUTHORITY_CONFLICT", "Legacy Runtime Authority key does not match its custody descriptor.");
  return key;
}

/**
 * Import the legacy single Authority idempotently. The new entry's key is
 * written and verified before its descriptor is published and reread, so an
 * interrupted import leaves no complete new identity and the legacy custody
 * remains usable. Any disagreement between legacy descriptor, legacy key,
 * canonical record or an existing new entry blocks without writing.
 */
export function importLegacyLocalAuthority(options: ImportLegacyLocalAuthorityOptions): LegacyLocalAuthorityImport {
  const { environment, authority } = options;
  const legacy = readLegacyConfig(environment);
  const key = loadLegacyKey(legacy, environment);
  if (
    authority.key.x !== legacy.publicKey.x ||
    delegatorPublicKeyFingerprint(authority.key) !== legacy.publicKeyFingerprint
  )
    fail("LEGACY_AUTHORITY_CONFLICT", "Legacy Runtime Authority key does not match the canonical Authority record.");

  try {
    const existing = readLocalAuthorityIdentity(authority.id, environment);
    if (existing !== undefined && existing.publicKeyFingerprint !== legacy.publicKeyFingerprint)
      fail("LEGACY_AUTHORITY_CONFLICT", "Runtime Authority ID is already bound to another key.");
    const identity = adoptLocalAuthorityKey(authority.id, key, environment);
    return Object.freeze({ status: existing === undefined ? "imported" : "already-imported", identity });
  } catch (error: unknown) {
    if (error instanceof AuthorityStoreError) {
      if (error.code === "AUTHORITY_IDENTITY_CONFLICT" || error.code === "AUTHORITY_IDENTITY_INVALID")
        fail("LEGACY_AUTHORITY_CONFLICT", error.message);
      fail("LEGACY_AUTHORITY_UNSAFE", error.message);
    }
    throw error;
  }
}
