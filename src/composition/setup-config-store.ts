/**
 * Shared, secret-free Setup configuration (#1120).
 *
 * The one persisted cross-process record that CLI and browser setup share for
 * a repository, so a fresh process observes the same App, Executor, Authority
 * and publication references without inheriting matching shell exports.
 *
 * Only bounded public identities and references are stored. The schema is
 * closed and has no member for tokens, PEM bytes, private keys, bearer/CSRF
 * values, Session material or copied environment values; every write also
 * passes the generic secret-material guard. Writes are atomic
 * compare-and-replace against the observed revision, and identities that
 * were once recorded (App ID, Executor configuration, Authority) are never
 * silently rewritten. The record lives in its own file and never touches an
 * operator or owner file.
 *
 * Canonical location (#1198): `<config home>/repositories/<repositoryId>/setup.json`
 * inside the repository registry, keyed by immutable repository ID only.
 * The legacy `runtime/setup/<key>.json` record is a read-only compatibility
 * input: it is read only while no canonical record exists, and the first
 * persisted update copies it forward (revision preserved) without touching
 * the legacy file. Once the canonical record exists, legacy state is never
 * consulted again.
 */
import { createHash } from "node:crypto";
import {
  LocalControlError,
  readExistingLocalJson,
  readExistingLocalStorageJson,
  replaceLocalStorageJsonIfCurrent,
} from "../local-control/config.js";
import {
  REPOSITORY_REGISTRY_DIRECTORY,
  RepositoryRegistry,
  RepositoryRegistryError,
  type RepositoryRegistryRecord,
} from "../local-control/repository-registry.js";
import { assertSecretFreeSetupJson, validateRepositoryIdentity } from "../runtime-contracts/index.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";

export const SETUP_CONFIG_VERSION = 1 as const;
/**
 * Directory below the `runtime` component that holds legacy setup records
 * (read-only compatibility input) and the setup operation journal.
 */
export const SETUP_STATE_DIRECTORY = "setup" as const;
/** Canonical setup record file inside a repository registry directory. */
export const SETUP_CONFIG_RECORD_FILE = "setup.json" as const;

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/u;
const COMPONENT_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const AUTHORITY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const PUBLICATION_BRANCH = /^inari\/runtime-authority\/[0-9a-f]{16}$/u;
const MAX_URL_LENGTH = 512;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

export interface SetupConfigApp {
  readonly appId: string;
  readonly installationId?: string;
  readonly clientId?: string;
}

export interface SetupConfigExecutor {
  /** Executor component configuration ID the Issuer key custody is bound to. */
  readonly configId: string;
  /** Public fingerprint of the enrolled Issuer key; never the key. */
  readonly issuerKeyFingerprint: string;
}

export interface SetupConfigAuthority {
  readonly authorityId: string;
  readonly publicKeyFingerprint: string;
}

/** Public evidence of an opened trust publication pull request. Publication is not trust. */
export interface SetupConfigPublication {
  readonly authorityId: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
}

export interface SetupConfigRecord {
  readonly version: typeof SETUP_CONFIG_VERSION;
  readonly repository: RepositoryIdentity;
  /** Monotonic compare-and-replace revision; the absent record is revision 0. */
  readonly revision: number;
  /** Selected Runtime Endpoint (public URL) when known. */
  readonly endpoint?: string;
  readonly app?: SetupConfigApp;
  readonly executor?: SetupConfigExecutor;
  readonly authority?: SetupConfigAuthority;
  readonly publication?: SetupConfigPublication;
}

/** Fields an owner operation may set; `version`, `repository` and `revision` are store-owned. */
export type SetupConfigPatch = Partial<Pick<SetupConfigRecord, "endpoint" | "app" | "executor" | "authority">> & {
  /** `null` clears stale publication evidence (e.g. after trust is observed). */
  readonly publication?: SetupConfigPublication | null;
};

export type SetupConfigStoreErrorCode =
  | "SETUP_CONFIG_INVALID"
  | "SETUP_CONFIG_UNREADABLE"
  | "SETUP_CONFIG_STALE"
  | "SETUP_CONFIG_CONFLICT"
  | "SETUP_CONFIG_STORAGE_FAILED";

export class SetupConfigStoreError extends Error {
  readonly code: SetupConfigStoreErrorCode;

  constructor(code: SetupConfigStoreErrorCode, message: string) {
    super(message);
    this.name = "SetupConfigStoreError";
    this.code = code;
  }
}

function invalid(message: string): SetupConfigStoreError {
  return new SetupConfigStoreError("SETUP_CONFIG_INVALID", message);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, members: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !members.includes(key))) throw invalid(message);
}

function matching(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(message);
  return value;
}

function publicUrl(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) throw invalid(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(message);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid(message);
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0)
    throw invalid(message);
  return value;
}

function validateApp(value: unknown): SetupConfigApp {
  const app = record(value, "Setup App reference is invalid.");
  closed(app, ["appId", "installationId", "clientId"], "Setup App reference has unsupported fields.");
  return Object.freeze({
    appId: matching(app.appId, DECIMAL_ID, "Setup App ID is invalid."),
    ...(app.installationId === undefined
      ? {}
      : { installationId: matching(app.installationId, DECIMAL_ID, "Setup App installation ID is invalid.") }),
    ...(app.clientId === undefined
      ? {}
      : { clientId: matching(app.clientId, CLIENT_ID, "Setup App client ID is invalid.") }),
  });
}

function validateExecutor(value: unknown): SetupConfigExecutor {
  const executor = record(value, "Setup Executor reference is invalid.");
  closed(executor, ["configId", "issuerKeyFingerprint"], "Setup Executor reference has unsupported fields.");
  return Object.freeze({
    configId: matching(executor.configId, COMPONENT_ID, "Setup Executor configuration ID is invalid."),
    issuerKeyFingerprint: matching(executor.issuerKeyFingerprint, FINGERPRINT, "Issuer key fingerprint is invalid."),
  });
}

function validateAuthority(value: unknown): SetupConfigAuthority {
  const authority = record(value, "Setup Authority reference is invalid.");
  closed(authority, ["authorityId", "publicKeyFingerprint"], "Setup Authority reference has unsupported fields.");
  return Object.freeze({
    authorityId: matching(authority.authorityId, AUTHORITY_ID, "Setup Authority ID is invalid."),
    publicKeyFingerprint: matching(authority.publicKeyFingerprint, FINGERPRINT, "Authority fingerprint is invalid."),
  });
}

function validatePublication(value: unknown): SetupConfigPublication {
  const publication = record(value, "Setup publication evidence is invalid.");
  closed(publication, ["authorityId", "number", "url", "branch"], "Setup publication has unsupported fields.");
  if (typeof publication.number !== "number" || !Number.isSafeInteger(publication.number) || publication.number < 1)
    throw invalid("Setup publication number is invalid.");
  return Object.freeze({
    authorityId: matching(publication.authorityId, AUTHORITY_ID, "Setup publication Authority ID is invalid."),
    number: publication.number,
    url: publicUrl(publication.url, "Setup publication URL is invalid."),
    branch: matching(publication.branch, PUBLICATION_BRANCH, "Setup publication branch is invalid."),
  });
}

/** Validate a closed, bounded, secret-free setup configuration record. */
export function validateSetupConfigRecord(value: unknown): SetupConfigRecord {
  try {
    assertSecretFreeSetupJson(value);
  } catch {
    throw invalid("Setup configuration must not contain secret material.");
  }
  const config = record(value, "Setup configuration is invalid.");
  closed(
    config,
    ["version", "repository", "revision", "endpoint", "app", "executor", "authority", "publication"],
    "Setup configuration has unsupported fields.",
  );
  if (config.version !== SETUP_CONFIG_VERSION) throw invalid("Setup configuration version is unsupported.");
  if (
    typeof config.revision !== "number" ||
    !Number.isSafeInteger(config.revision) ||
    config.revision < 1 ||
    config.revision > MAX_REVISION
  )
    throw invalid("Setup configuration revision is invalid.");
  let repository: RepositoryIdentity;
  try {
    repository = validateRepositoryIdentity(config.repository, "$.repository");
  } catch {
    throw invalid("Setup repository identity is invalid.");
  }
  return Object.freeze({
    version: SETUP_CONFIG_VERSION,
    repository,
    revision: config.revision,
    ...(config.endpoint === undefined ? {} : { endpoint: publicUrl(config.endpoint, "Setup Endpoint is invalid.") }),
    ...(config.app === undefined ? {} : { app: validateApp(config.app) }),
    ...(config.executor === undefined ? {} : { executor: validateExecutor(config.executor) }),
    ...(config.authority === undefined ? {} : { authority: validateAuthority(config.authority) }),
    ...(config.publication === undefined ? {} : { publication: validatePublication(config.publication) }),
  });
}

/** Relative path key of a repository's legacy setup record and journal below the `runtime` component. */
export function setupStateFileKey(repository: Pick<RepositoryIdentity, "repositoryHost" | "repositoryId">): string {
  return createHash("sha256")
    .update(`${repository.repositoryHost}\u0000${repository.repositoryId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

/** Once recorded, these identities change only through an explicit owner migration, never through setup. */
function assertImmutable(current: SetupConfigRecord | undefined, next: SetupConfigRecord): void {
  if (current === undefined) return;
  const conflict = (message: string): never => {
    throw new SetupConfigStoreError("SETUP_CONFIG_CONFLICT", message);
  };
  if (current.app !== undefined && next.app?.appId !== current.app.appId)
    conflict("The recorded App ID cannot be replaced by setup.");
  if (
    current.app?.installationId !== undefined &&
    next.app?.installationId !== undefined &&
    next.app.installationId !== current.app.installationId
  )
    conflict("The recorded App installation cannot be replaced by setup.");
  if (current.executor !== undefined && next.executor?.configId !== current.executor.configId)
    conflict("The recorded Executor configuration cannot be replaced by setup.");
  if (
    current.authority !== undefined &&
    (next.authority?.authorityId !== current.authority.authorityId ||
      next.authority.publicKeyFingerprint !== current.authority.publicKeyFingerprint)
  )
    conflict("The recorded Runtime Authority cannot be replaced by setup.");
}

/** Config-home relative path of the canonical setup record; derived from the repository ID only. */
export function setupConfigRecordRelativePath(repository: Pick<RepositoryIdentity, "repositoryId">): string {
  if (typeof repository.repositoryId !== "string" || !DECIMAL_ID.test(repository.repositoryId))
    throw invalid("Setup repository ID is invalid.");
  return `${REPOSITORY_REGISTRY_DIRECTORY}/${repository.repositoryId}/${SETUP_CONFIG_RECORD_FILE}`;
}

function legacySetupRelativePath(repository: RepositoryIdentity): string {
  return `${SETUP_STATE_DIRECTORY}/${setupStateFileKey(repository)}.json`;
}

function unreadable(message: string): SetupConfigStoreError {
  return new SetupConfigStoreError("SETUP_CONFIG_UNREADABLE", message);
}

/**
 * Register the observed repository through the registry owner before a
 * canonical setup write. A rename of the same host+ID refreshes only the
 * registry display metadata; another host under the same ID is a conflict.
 */
export function ensureSetupRepositoryRegistered(
  repository: RepositoryIdentity,
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryRegistryRecord {
  const registry = new RepositoryRegistry({ environment });
  try {
    const current = registry.get(repository.repositoryId);
    if (current === undefined) return registry.register(repository);
    if (current.repositoryHost !== repository.repositoryHost)
      throw new SetupConfigStoreError("SETUP_CONFIG_CONFLICT", "Repository ID is registered under another host.");
    if (current.nameWithOwner === repository.nameWithOwner) return current;
    return registry.updateNameWithOwner(current, repository);
  } catch (error: unknown) {
    if (error instanceof SetupConfigStoreError) throw error;
    if (error instanceof RepositoryRegistryError) {
      if (error.code === "REPOSITORY_REGISTRY_IDENTITY_CONFLICT")
        throw new SetupConfigStoreError("SETUP_CONFIG_CONFLICT", "Repository ID is registered under another host.");
      if (error.code === "REPOSITORY_REGISTRY_STALE" || error.code === "REPOSITORY_REGISTRY_METADATA_CONFLICT")
        throw new SetupConfigStoreError("SETUP_CONFIG_STALE", "Repository registry changed after it was observed.");
      if (error.code === "REPOSITORY_REGISTRY_UNREADABLE")
        throw unreadable("Repository registry could not be read safely.");
    }
    throw new SetupConfigStoreError("SETUP_CONFIG_STORAGE_FAILED", "Repository registry could not be persisted.");
  }
}

/** Where a read record came from. Legacy records are compatibility input only. */
export type SetupConfigSource = "canonical" | "legacy";

export interface SetupConfigObservation {
  readonly source: SetupConfigSource;
  readonly record: SetupConfigRecord;
}

export interface SetupConfigStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export class SetupConfigStore {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: SetupConfigStoreOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  /** Read the canonical registry record only, without creating directories or consulting legacy state. */
  readCanonical(repository: RepositoryIdentity): SetupConfigRecord | undefined {
    const relativePath = setupConfigRecordRelativePath(repository);
    let value: SetupConfigRecord | undefined;
    try {
      value = readExistingLocalStorageJson(relativePath, validateSetupConfigRecord, this.#environment);
    } catch {
      throw unreadable("Setup configuration could not be read safely.");
    }
    if (value === undefined) return undefined;
    if (!sameRepository(value.repository, repository))
      throw unreadable("Setup configuration is for another repository.");
    let registered: RepositoryRegistryRecord | undefined;
    try {
      registered = new RepositoryRegistry({ environment: this.#environment }).get(repository.repositoryId);
    } catch {
      throw unreadable("Repository registry could not be read safely.");
    }
    if (registered === undefined || registered.repositoryHost !== repository.repositoryHost)
      throw unreadable("Setup configuration has no matching repository registry record.");
    return value;
  }

  /** Read the legacy `runtime/setup` record only; it is never written. */
  readLegacy(repository: RepositoryIdentity): SetupConfigRecord | undefined {
    let value: SetupConfigRecord | undefined;
    try {
      value = readExistingLocalJson(
        "runtime",
        legacySetupRelativePath(repository),
        validateSetupConfigRecord,
        this.#environment,
      );
    } catch {
      throw unreadable("Legacy setup configuration could not be read safely.");
    }
    if (value !== undefined && !sameRepository(value.repository, repository))
      throw unreadable("Legacy setup configuration is for another repository.");
    return value;
  }

  /**
   * The canonical record when present; otherwise the legacy record as
   * read-only compatibility input. Legacy state never overrides a canonical record.
   */
  observe(repository: RepositoryIdentity): SetupConfigObservation | undefined {
    const canonicalRecord = this.readCanonical(repository);
    if (canonicalRecord !== undefined) return Object.freeze({ source: "canonical", record: canonicalRecord });
    const legacy = this.readLegacy(repository);
    return legacy === undefined ? undefined : Object.freeze({ source: "legacy", record: legacy });
  }

  /** Read without creating directories. Unreadable or foreign records fail closed. */
  read(repository: RepositoryIdentity): SetupConfigRecord | undefined {
    return this.observe(repository)?.record;
  }

  /**
   * Apply `patch` only while the stored revision still equals
   * `expectedRevision` (0 for an absent record). A patch that changes nothing
   * returns the current record, so retries are idempotent. Every write goes
   * to the canonical registry location; a legacy-only record is copied
   * forward with its revision continued and the legacy file left untouched.
   */
  update(repository: RepositoryIdentity, expectedRevision: number, patch: SetupConfigPatch): SetupConfigRecord {
    const observed = this.observe(repository);
    const current = observed?.record;
    if ((current?.revision ?? 0) !== expectedRevision)
      throw new SetupConfigStoreError("SETUP_CONFIG_STALE", "Setup configuration changed after it was observed.");
    const { publication, ...rest } = patch;
    const merged: Record<string, unknown> = {
      version: SETUP_CONFIG_VERSION,
      ...(current ?? {}),
      repository: {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.nameWithOwner,
      },
      ...rest,
    };
    if (publication === null) delete merged.publication;
    else if (publication !== undefined) merged.publication = publication;
    merged.revision = current?.revision ?? 0;
    if (current !== undefined && canonical(merged) === canonical(current)) return current;
    merged.revision = (current?.revision ?? 0) + 1;
    const next = validateSetupConfigRecord(merged);
    assertImmutable(current, next);
    return this.#persist(repository, observed?.source === "canonical" ? current : undefined, next);
  }

  /**
   * Create the canonical record from an explicitly adopted record. Only an
   * absent canonical record is written; an existing one is never replaced.
   */
  adopt(repository: RepositoryIdentity, record: SetupConfigRecord): SetupConfigRecord {
    const next = validateSetupConfigRecord(record);
    if (!sameRepository(next.repository, repository))
      throw new SetupConfigStoreError(
        "SETUP_CONFIG_CONFLICT",
        "Adopted setup configuration is for another repository.",
      );
    return this.#persist(repository, undefined, next);
  }

  #persist(
    repository: RepositoryIdentity,
    expected: SetupConfigRecord | undefined,
    next: SetupConfigRecord,
  ): SetupConfigRecord {
    ensureSetupRepositoryRegistered(repository, this.#environment);
    try {
      return replaceLocalStorageJsonIfCurrent(
        setupConfigRecordRelativePath(repository),
        expected,
        next,
        validateSetupConfigRecord,
        this.#environment,
      );
    } catch (error: unknown) {
      if (error instanceof LocalControlError && error.code === "LOCAL_CONTROL_CONFIG_CONFLICT")
        throw new SetupConfigStoreError("SETUP_CONFIG_STALE", "Setup configuration changed after it was observed.");
      throw new SetupConfigStoreError("SETUP_CONFIG_STORAGE_FAILED", "Setup configuration could not be persisted.");
    }
  }
}
