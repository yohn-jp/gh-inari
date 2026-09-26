/**
 * Canonical local repository registry (#1197).
 *
 * One secret-free record per provider repository at
 * `<config home>/repositories/<repositoryId>/repository.json`. The decimal
 * repository ID is the only path identity; `repositoryHost` and
 * `nameWithOwner` are validated record metadata and never directory names.
 * Semantic identity stays `repositoryHost + repositoryId`: the same ID under
 * another host is an identity conflict, and a rename changes only
 * `nameWithOwner` of the same host+ID through compare-and-replace.
 *
 * The registry never infers entries from other component directories and
 * owns only public repository identity metadata. Persistence reuses the
 * generic config-home storage primitives of `config.ts`.
 */
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import { assertSecretFreeSetupJson, validateRepositoryIdentity } from "../runtime-contracts/index.js";
import {
  LocalControlError,
  listExistingLocalStorageDirectory,
  localStoragePath,
  readExistingLocalStorageJson,
  replaceLocalStorageJsonIfCurrent,
} from "./config.js";

export const REPOSITORY_REGISTRY_VERSION = 1 as const;
/** Config-home directory that holds one directory per registered repository ID. */
export const REPOSITORY_REGISTRY_DIRECTORY = "repositories" as const;
export const REPOSITORY_REGISTRY_RECORD_FILE = "repository.json" as const;
export const MAX_REGISTERED_REPOSITORIES = 256;

const REPOSITORY_ID = /^[1-9][0-9]{0,19}$/u;
const RECORD_MEMBERS = ["version", "repositoryHost", "repositoryId", "nameWithOwner"] as const;

export interface RepositoryRegistryRecord {
  readonly version: typeof REPOSITORY_REGISTRY_VERSION;
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly nameWithOwner: string;
}

export type RepositoryRegistryErrorCode =
  /** Caller input is malformed or carries secret-like material. */
  | "REPOSITORY_REGISTRY_INVALID"
  /** The repository ID is already registered under another host. */
  | "REPOSITORY_REGISTRY_IDENTITY_CONFLICT"
  /** The same host+ID is registered with other metadata; use `updateNameWithOwner`. */
  | "REPOSITORY_REGISTRY_METADATA_CONFLICT"
  /** The stored record changed after it was observed. */
  | "REPOSITORY_REGISTRY_STALE"
  /** Registry storage is unsafe, malformed, inconsistent or over its bound. */
  | "REPOSITORY_REGISTRY_UNREADABLE"
  | "REPOSITORY_REGISTRY_STORAGE_FAILED";

export class RepositoryRegistryError extends Error {
  readonly code: RepositoryRegistryErrorCode;

  constructor(code: RepositoryRegistryErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RepositoryRegistryError";
    this.code = code;
  }
}

/** Closed, secret-free registry record schema. */
export function validateRepositoryRegistryRecord(value: unknown): RepositoryRegistryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RepositoryRegistryError("REPOSITORY_REGISTRY_INVALID", "Repository registry record is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(RECORD_MEMBERS as readonly string[]).includes(key))) {
    throw new RepositoryRegistryError(
      "REPOSITORY_REGISTRY_INVALID",
      "Repository registry record has unsupported fields.",
    );
  }
  if (record.version !== REPOSITORY_REGISTRY_VERSION) {
    throw new RepositoryRegistryError(
      "REPOSITORY_REGISTRY_INVALID",
      "Repository registry record version is unsupported.",
    );
  }
  const identity = validateIdentity({
    repositoryHost: record.repositoryHost,
    repositoryId: record.repositoryId,
    nameWithOwner: record.nameWithOwner,
  });
  return Object.freeze({ version: REPOSITORY_REGISTRY_VERSION, ...identity });
}

function validateIdentity(value: unknown): RepositoryIdentity {
  try {
    assertSecretFreeSetupJson(value, "$.repository");
    return validateRepositoryIdentity(value, "$.repository");
  } catch (error: unknown) {
    throw new RepositoryRegistryError("REPOSITORY_REGISTRY_INVALID", "Repository identity is invalid.", {
      cause: error,
    });
  }
}

function validateRepositoryId(repositoryId: unknown): string {
  if (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId)) {
    throw new RepositoryRegistryError("REPOSITORY_REGISTRY_INVALID", "Repository ID must be a decimal database ID.");
  }
  return repositoryId;
}

function recordRelativePath(repositoryId: string): string {
  return `${REPOSITORY_REGISTRY_DIRECTORY}/${validateRepositoryId(repositoryId)}/${REPOSITORY_REGISTRY_RECORD_FILE}`;
}

/** Absolute registry record path; derived from the decimal repository ID only. */
export function repositoryRegistryRecordPath(
  repositoryId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return localStoragePath(recordRelativePath(repositoryId), environment);
}

function unreadable(message: string, cause?: unknown): RepositoryRegistryError {
  return new RepositoryRegistryError("REPOSITORY_REGISTRY_UNREADABLE", message, { cause });
}

function compareRepositoryIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRecord(identity: RepositoryIdentity): RepositoryRegistryRecord {
  return validateRepositoryRegistryRecord({ version: REPOSITORY_REGISTRY_VERSION, ...identity });
}

function sameRecord(left: RepositoryRegistryRecord, right: RepositoryRegistryRecord): boolean {
  return (
    left.repositoryHost === right.repositoryHost &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner === right.nameWithOwner
  );
}

export interface RepositoryRegistryOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export class RepositoryRegistry {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: RepositoryRegistryOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  /** Read one record by immutable repository ID without mutating storage. */
  get(repositoryId: string): RepositoryRegistryRecord | undefined {
    const relativePath = recordRelativePath(repositoryId);
    let record: RepositoryRegistryRecord | undefined;
    try {
      record = readExistingLocalStorageJson(relativePath, validateRepositoryRegistryRecord, this.#environment);
    } catch (error: unknown) {
      throw unreadable("Repository registry record could not be read safely.", error);
    }
    if (record !== undefined && record.repositoryId !== repositoryId) {
      throw unreadable("Repository registry record does not match its repository ID.");
    }
    return record;
  }

  /**
   * Register or adopt an explicitly observed repository. An identical record
   * is returned unchanged; the same ID under another host or with other
   * metadata fails before any write.
   */
  register(observation: RepositoryIdentity): RepositoryRegistryRecord {
    const next = toRecord(observation);
    const current = this.get(next.repositoryId);
    if (current !== undefined) return this.#classifyExisting(current, next);
    try {
      return replaceLocalStorageJsonIfCurrent(
        recordRelativePath(next.repositoryId),
        undefined,
        next,
        validateRepositoryRegistryRecord,
        this.#environment,
      );
    } catch (error: unknown) {
      if (error instanceof LocalControlError && error.code === "LOCAL_CONTROL_CONFIG_CONFLICT") {
        const raced = this.get(next.repositoryId);
        if (raced !== undefined) return this.#classifyExisting(raced, next);
      }
      throw this.#storageFailure(error);
    }
  }

  /**
   * Replace `nameWithOwner` of the same host+ID only while the stored record
   * still equals `expected`. A record that already carries the observed name
   * is returned unchanged, so retries are idempotent.
   */
  updateNameWithOwner(expected: RepositoryRegistryRecord, observation: RepositoryIdentity): RepositoryRegistryRecord {
    const previous = validateRepositoryRegistryRecord(expected);
    const next = toRecord(observation);
    if (previous.repositoryId !== next.repositoryId || previous.repositoryHost !== next.repositoryHost) {
      throw new RepositoryRegistryError(
        "REPOSITORY_REGISTRY_IDENTITY_CONFLICT",
        "A rename must keep the same repository host and ID.",
      );
    }
    const current = this.get(next.repositoryId);
    if (current === undefined) {
      throw new RepositoryRegistryError("REPOSITORY_REGISTRY_STALE", "Repository is not registered.");
    }
    if (current.repositoryHost !== next.repositoryHost) {
      throw new RepositoryRegistryError(
        "REPOSITORY_REGISTRY_IDENTITY_CONFLICT",
        "Repository ID is registered under another host.",
      );
    }
    if (sameRecord(current, next)) return current;
    if (!sameRecord(current, previous)) {
      throw new RepositoryRegistryError(
        "REPOSITORY_REGISTRY_STALE",
        "Repository registry record changed after it was observed.",
      );
    }
    try {
      return replaceLocalStorageJsonIfCurrent(
        recordRelativePath(next.repositoryId),
        previous,
        next,
        validateRepositoryRegistryRecord,
        this.#environment,
      );
    } catch (error: unknown) {
      if (error instanceof LocalControlError && error.code === "LOCAL_CONTROL_CONFIG_CONFLICT") {
        throw new RepositoryRegistryError(
          "REPOSITORY_REGISTRY_STALE",
          "Repository registry record changed after it was observed.",
          { cause: error },
        );
      }
      throw this.#storageFailure(error);
    }
  }

  /**
   * Deterministic, bounded enumeration ordered by numeric repository ID.
   * Every entry of the registry directory must be a repository ID directory
   * holding a matching record; anything else fails instead of being skipped.
   */
  list(): readonly RepositoryRegistryRecord[] {
    let entries;
    try {
      entries = listExistingLocalStorageDirectory(
        REPOSITORY_REGISTRY_DIRECTORY,
        MAX_REGISTERED_REPOSITORIES,
        this.#environment,
      );
    } catch (error: unknown) {
      throw unreadable("Repository registry could not be enumerated safely.", error);
    }
    if (entries === undefined) return Object.freeze([]);
    const records: RepositoryRegistryRecord[] = [];
    for (const entry of entries) {
      if (entry.kind !== "directory" || !REPOSITORY_ID.test(entry.name)) {
        throw unreadable("Repository registry contains an unexpected entry.");
      }
      const record = this.get(entry.name);
      if (record === undefined) throw unreadable("Repository registry entry has no repository record.");
      records.push(record);
    }
    return Object.freeze(records.sort((left, right) => compareRepositoryIds(left.repositoryId, right.repositoryId)));
  }

  #classifyExisting(current: RepositoryRegistryRecord, next: RepositoryRegistryRecord): RepositoryRegistryRecord {
    if (current.repositoryHost !== next.repositoryHost) {
      throw new RepositoryRegistryError(
        "REPOSITORY_REGISTRY_IDENTITY_CONFLICT",
        "Repository ID is registered under another host.",
      );
    }
    if (!sameRecord(current, next)) {
      throw new RepositoryRegistryError(
        "REPOSITORY_REGISTRY_METADATA_CONFLICT",
        "Repository is registered with other metadata; update it by compare-and-replace.",
      );
    }
    return current;
  }

  #storageFailure(error: unknown): RepositoryRegistryError {
    if (error instanceof RepositoryRegistryError) return error;
    return new RepositoryRegistryError(
      "REPOSITORY_REGISTRY_STORAGE_FAILED",
      "Repository registry record could not be persisted.",
      { cause: error },
    );
  }
}
