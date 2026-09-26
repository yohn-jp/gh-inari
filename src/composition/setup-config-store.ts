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
 */
import { createHash } from "node:crypto";
import { LocalControlError, readExistingLocalJson, replaceLocalJsonIfCurrent } from "../local-control/config.js";
import { assertSecretFreeSetupJson, validateRepositoryIdentity } from "../runtime-contracts/index.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";

export const SETUP_CONFIG_VERSION = 1 as const;
/** Directory below the `runtime` component that holds setup records. */
export const SETUP_STATE_DIRECTORY = "setup" as const;

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

/** Relative path of a repository's setup record below the `runtime` component. */
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

export interface SetupConfigStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export class SetupConfigStore {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: SetupConfigStoreOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  #path(repository: RepositoryIdentity): string {
    return `${SETUP_STATE_DIRECTORY}/${setupStateFileKey(repository)}.json`;
  }

  /** Read without creating directories. Unreadable or foreign records fail closed. */
  read(repository: RepositoryIdentity): SetupConfigRecord | undefined {
    let value: SetupConfigRecord | undefined;
    try {
      value = readExistingLocalJson("runtime", this.#path(repository), validateSetupConfigRecord, this.#environment);
    } catch {
      throw new SetupConfigStoreError("SETUP_CONFIG_UNREADABLE", "Setup configuration could not be read safely.");
    }
    if (value !== undefined && !sameRepository(value.repository, repository))
      throw new SetupConfigStoreError("SETUP_CONFIG_UNREADABLE", "Setup configuration is for another repository.");
    return value;
  }

  /**
   * Apply `patch` only while the stored revision still equals
   * `expectedRevision` (0 for an absent record). A patch that changes nothing
   * returns the current record, so retries are idempotent.
   */
  update(repository: RepositoryIdentity, expectedRevision: number, patch: SetupConfigPatch): SetupConfigRecord {
    const current = this.read(repository);
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
    try {
      return replaceLocalJsonIfCurrent(
        "runtime",
        this.#path(repository),
        current,
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
