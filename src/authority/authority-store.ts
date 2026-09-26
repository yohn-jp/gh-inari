/**
 * Authority-ID-scoped Runtime Authority key custody (#1200).
 *
 * The Authority owner keeps one custody entry per Authority identity:
 *
 * ```
 * authority/keys/<authorityId>/config.json
 * authority/keys/<authorityId>/private-key.pem
 * ```
 *
 * `config.json` binds the Authority ID to its public key/fingerprint and is the
 * completion marker: it is written only after the private key is durably
 * present and verified, so an entry without it is never listed or opened.
 * Repositories reference an entry only by Authority ID/fingerprint; no key
 * path or key material leaves this module except through the Authority owner's
 * signer, and the key-bearing opener is not part of the public entry.
 */
import {
  delegatorPublicKeyFingerprint,
  exportDelegatorPublicKey,
  generateDelegatorKeyPair,
  loadDelegatorKeyPair,
  type DelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import {
  createLocalPrivateFile,
  isLocalAuthorityId,
  listExistingLocalComponentDirectory,
  LOCAL_AUTHORITY_KEYS_DIRECTORY,
  LOCAL_CONFIG_VERSION,
  localComponentPath,
  LocalControlError,
  readExistingLocalJson,
  validateLocalAuthorityIdentityConfig,
  writeLocalJson,
  type LocalAuthorityIdentityConfig,
} from "../local-control/config.js";

/** Upper bound for enumerated local Authority identities; more entries fail closed. */
export const MAX_LOCAL_AUTHORITY_IDENTITIES = 256;

const CONFIG_FILE = "config.json";
const PRIVATE_KEY_FILE = "private-key.pem";
/** Bound for files inside one custody entry (descriptor, key and transient publication files). */
const MAX_ENTRY_FILES = 64;

export type AuthorityStoreErrorCode =
  | "AUTHORITY_IDENTITY_INVALID"
  | "AUTHORITY_IDENTITY_NOT_FOUND"
  | "AUTHORITY_IDENTITY_MISMATCH"
  | "AUTHORITY_IDENTITY_CONFLICT"
  | "AUTHORITY_STORE_UNSAFE"
  | "RUNTIME_AUTHORITY_KEY_NOT_FOUND"
  | "RUNTIME_AUTHORITY_KEY_MISMATCH";

export class AuthorityStoreError extends Error {
  readonly code: AuthorityStoreErrorCode;

  constructor(code: AuthorityStoreErrorCode, message: string) {
    super(message);
    this.name = "AuthorityStoreError";
    this.code = code;
  }
}

function fail(code: AuthorityStoreErrorCode, message: string): never {
  throw new AuthorityStoreError(code, message);
}

/** Public Authority identity. Carries no key path and no private key material. */
export interface LocalAuthorityPublicIdentity {
  readonly authorityId: string;
  readonly publicKey: LocalAuthorityIdentityConfig["publicKey"];
  readonly publicKeyFingerprint: string;
}

/** Exact Authority selection: the ID, optionally pinned to an expected public fingerprint. */
export interface LocalAuthoritySelector {
  readonly authorityId: string;
  readonly publicKeyFingerprint?: string;
}

/** Key-bearing custody handle. Only the Authority owner may hold it. */
export interface LocalAuthorityCustody {
  readonly identity: LocalAuthorityPublicIdentity;
  readonly key: DelegatorKeyPair;
}

function assertAuthorityId(authorityId: unknown): string {
  if (!isLocalAuthorityId(authorityId)) fail("AUTHORITY_IDENTITY_INVALID", "Runtime Authority ID is invalid.");
  return authorityId;
}

function entryPath(authorityId: string, fileName: string): string {
  return `${LOCAL_AUTHORITY_KEYS_DIRECTORY}/${authorityId}/${fileName}`;
}

function publicIdentity(config: LocalAuthorityIdentityConfig): LocalAuthorityPublicIdentity {
  return Object.freeze({
    authorityId: config.authorityId,
    publicKey: Object.freeze({ ...config.publicKey }),
    publicKeyFingerprint: config.publicKeyFingerprint,
  });
}

function storageFailure(error: unknown): never {
  if (error instanceof AuthorityStoreError) throw error;
  if (error instanceof LocalControlError && error.code === "LOCAL_CONTROL_CONFIG_CONFLICT")
    fail("AUTHORITY_IDENTITY_CONFLICT", "Existing Runtime Authority custody conflicts with the requested identity.");
  if (error instanceof LocalControlError) fail("AUTHORITY_STORE_UNSAFE", error.message);
  throw error;
}

function readConfig(authorityId: string, environment: NodeJS.ProcessEnv): LocalAuthorityIdentityConfig | undefined {
  let config: LocalAuthorityIdentityConfig | undefined;
  try {
    config = readExistingLocalJson(
      "authority",
      entryPath(authorityId, CONFIG_FILE),
      validateLocalAuthorityIdentityConfig,
      environment,
    );
  } catch (error: unknown) {
    storageFailure(error);
  }
  if (config !== undefined && config.authorityId !== authorityId)
    fail("AUTHORITY_IDENTITY_CONFLICT", "Runtime Authority custody descriptor is stored under another Authority ID.");
  return config;
}

/** Load an entry key: absent is `undefined`; any other load failure fails closed. */
function loadEntryKey(authorityId: string, environment: NodeJS.ProcessEnv): DelegatorKeyPair | undefined {
  let entries: ReturnType<typeof listExistingLocalComponentDirectory>;
  try {
    entries = listExistingLocalComponentDirectory(
      "authority",
      `${LOCAL_AUTHORITY_KEYS_DIRECTORY}/${authorityId}`,
      MAX_ENTRY_FILES,
      environment,
    );
  } catch (error: unknown) {
    storageFailure(error);
  }
  if (entries === undefined || !entries.some((entry) => entry.name === PRIVATE_KEY_FILE)) return undefined;
  try {
    return loadDelegatorKeyPair(localComponentPath("authority", entryPath(authorityId, PRIVATE_KEY_FILE), environment));
  } catch {
    fail("AUTHORITY_STORE_UNSAFE", "Runtime Authority private key could not be loaded safely.");
  }
}

function keyMatches(key: DelegatorKeyPair, config: LocalAuthorityIdentityConfig): boolean {
  return (
    exportDelegatorPublicKey(key).x === config.publicKey.x &&
    delegatorPublicKeyFingerprint(key) === config.publicKeyFingerprint
  );
}

/**
 * Enumerate complete local Authority identities, sorted by Authority ID. Only
 * public identity is returned. The enumeration is non-mutating and bounded;
 * unexpected entries, ID/path disagreement and one key under two IDs fail
 * closed. Entries whose descriptor was never published are incomplete and are
 * not listed.
 */
export function listLocalAuthorityIdentities(
  environment: NodeJS.ProcessEnv = process.env,
): readonly LocalAuthorityPublicIdentity[] {
  let entries: ReturnType<typeof listExistingLocalComponentDirectory>;
  try {
    entries = listExistingLocalComponentDirectory(
      "authority",
      LOCAL_AUTHORITY_KEYS_DIRECTORY,
      MAX_LOCAL_AUTHORITY_IDENTITIES,
      environment,
    );
  } catch (error: unknown) {
    storageFailure(error);
  }
  const identities: LocalAuthorityPublicIdentity[] = [];
  const fingerprints = new Set<string>();
  for (const entry of entries ?? []) {
    if (entry.kind !== "directory" || !isLocalAuthorityId(entry.name))
      fail("AUTHORITY_STORE_UNSAFE", "Runtime Authority key store contains an unexpected entry.");
    const config = readConfig(entry.name, environment);
    if (config === undefined) continue;
    if (fingerprints.has(config.publicKeyFingerprint))
      fail("AUTHORITY_IDENTITY_CONFLICT", "One Runtime Authority key is stored under more than one Authority ID.");
    fingerprints.add(config.publicKeyFingerprint);
    identities.push(publicIdentity(config));
  }
  return Object.freeze(identities);
}

/** Read one complete public Authority identity by ID without touching its key. */
export function readLocalAuthorityIdentity(
  authorityId: string,
  environment: NodeJS.ProcessEnv = process.env,
): LocalAuthorityPublicIdentity | undefined {
  const config = readConfig(assertAuthorityId(authorityId), environment);
  return config === undefined ? undefined : publicIdentity(config);
}

/**
 * Open exactly one Authority entry. The descriptor must exist under the
 * requested ID, match the expected fingerprint when one is given, and the
 * stored private key must match the descriptor. Authority-owner internal.
 */
export function openLocalAuthorityCustody(
  selector: LocalAuthoritySelector,
  environment: NodeJS.ProcessEnv = process.env,
): LocalAuthorityCustody {
  const authorityId = assertAuthorityId(selector.authorityId);
  const config = readConfig(authorityId, environment);
  if (config === undefined) fail("AUTHORITY_IDENTITY_NOT_FOUND", "Runtime Authority identity is not configured.");
  if (selector.publicKeyFingerprint !== undefined && selector.publicKeyFingerprint !== config.publicKeyFingerprint)
    fail("AUTHORITY_IDENTITY_MISMATCH", "Runtime Authority identity does not match the expected fingerprint.");
  let key: DelegatorKeyPair | undefined;
  try {
    key = loadEntryKey(authorityId, environment);
  } catch {
    key = undefined;
  }
  if (key === undefined) fail("RUNTIME_AUTHORITY_KEY_NOT_FOUND", "Runtime Authority private key could not be loaded.");
  if (!keyMatches(key, config))
    fail("RUNTIME_AUTHORITY_KEY_MISMATCH", "Runtime Authority key does not match its custody descriptor.");
  return Object.freeze({ identity: publicIdentity(config), key });
}

function assertKeyNotHeldElsewhere(authorityId: string, fingerprint: string, environment: NodeJS.ProcessEnv): void {
  if (
    listLocalAuthorityIdentities(environment).some(
      (identity) => identity.authorityId !== authorityId && identity.publicKeyFingerprint === fingerprint,
    )
  )
    fail("AUTHORITY_IDENTITY_CONFLICT", "Runtime Authority key is already held by another Authority ID.");
}

function encodePrivateKey(key: DelegatorKeyPair): Buffer {
  const exported = key.privateKey.export({ format: "pem", type: "pkcs8" });
  if (typeof exported !== "string") fail("AUTHORITY_STORE_UNSAFE", "Runtime Authority key could not be encoded.");
  return Buffer.from(exported, "utf8");
}

/** Publish the key once; an existing key is never replaced and must be the same key. */
function persistEntryKey(authorityId: string, key: DelegatorKeyPair, environment: NodeJS.ProcessEnv): void {
  try {
    createLocalPrivateFile("authority", entryPath(authorityId, PRIVATE_KEY_FILE), encodePrivateKey(key), environment);
  } catch (error: unknown) {
    storageFailure(error);
  }
  const stored = loadEntryKey(authorityId, environment);
  if (stored === undefined)
    fail("RUNTIME_AUTHORITY_KEY_NOT_FOUND", "Runtime Authority private key could not be verified after persistence.");
  if (delegatorPublicKeyFingerprint(stored) !== delegatorPublicKeyFingerprint(key))
    fail("AUTHORITY_IDENTITY_CONFLICT", "A different Runtime Authority key is already stored for this Authority ID.");
}

/** Write the completion descriptor after the key is verified, then reread the whole entry. */
function publishEntry(
  authorityId: string,
  key: DelegatorKeyPair,
  environment: NodeJS.ProcessEnv,
): LocalAuthorityPublicIdentity {
  const config: LocalAuthorityIdentityConfig = {
    version: LOCAL_CONFIG_VERSION,
    authorityId,
    publicKey: exportDelegatorPublicKey(key),
    publicKeyFingerprint: delegatorPublicKeyFingerprint(key),
    privateKeyFile: PRIVATE_KEY_FILE,
  };
  try {
    writeLocalJson(
      "authority",
      entryPath(authorityId, CONFIG_FILE),
      config,
      validateLocalAuthorityIdentityConfig,
      environment,
    );
  } catch (error: unknown) {
    storageFailure(error);
  }
  return openLocalAuthorityCustody({ authorityId, publicKeyFingerprint: config.publicKeyFingerprint }, environment)
    .identity;
}

/**
 * Adopt an already-held key under an Authority ID. The key is written only
 * when absent; an existing entry must hold exactly this key. Nothing is
 * generated or replaced. Used by legacy import.
 */
export function adoptLocalAuthorityKey(
  authorityId: string,
  key: DelegatorKeyPair,
  environment: NodeJS.ProcessEnv = process.env,
): LocalAuthorityPublicIdentity {
  const id = assertAuthorityId(authorityId);
  const fingerprint = delegatorPublicKeyFingerprint(key);
  const existing = readConfig(id, environment);
  if (existing !== undefined) {
    if (existing.publicKeyFingerprint !== fingerprint)
      fail("AUTHORITY_IDENTITY_CONFLICT", "Runtime Authority ID is already bound to another key.");
    return openLocalAuthorityCustody({ authorityId: id, publicKeyFingerprint: fingerprint }, environment).identity;
  }
  assertKeyNotHeldElsewhere(id, fingerprint, environment);
  persistEntryKey(id, key, environment);
  return publishEntry(id, key, environment);
}

export interface PreparedLocalAuthorityIdentity {
  readonly identity: LocalAuthorityPublicIdentity;
  /** `created` only when a new key was generated for a previously absent entry. */
  readonly state: "created" | "adopted";
}

/**
 * Select or create the custody entry for one Authority ID. A complete entry is
 * verified and adopted; a key left without its descriptor is verified and
 * adopted; a new key is generated only when the entry holds no key at all.
 * An existing key/ID/fingerprint is never regenerated.
 */
export function prepareLocalAuthorityIdentity(
  authorityId: string,
  environment: NodeJS.ProcessEnv = process.env,
): PreparedLocalAuthorityIdentity {
  const id = assertAuthorityId(authorityId);
  const existing = readConfig(id, environment);
  if (existing !== undefined) {
    const { identity } = openLocalAuthorityCustody(
      { authorityId: id, publicKeyFingerprint: existing.publicKeyFingerprint },
      environment,
    );
    return Object.freeze({ identity, state: "adopted" });
  }
  const held = loadEntryKey(id, environment);
  const key = held ?? generateDelegatorKeyPair();
  assertKeyNotHeldElsewhere(id, delegatorPublicKeyFingerprint(key), environment);
  if (held === undefined) persistEntryKey(id, key, environment);
  return Object.freeze({
    identity: publishEntry(id, key, environment),
    state: held === undefined ? "created" : "adopted",
  });
}
