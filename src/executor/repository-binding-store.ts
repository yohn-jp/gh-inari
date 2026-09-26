/**
 * Executor-owned repository bindings (#1199). One record per immutable
 * repository ID binds that repository to exactly one App, one installation
 * and one verified App credential generation. Records carry public IDs only:
 * no key bytes, no key path, and no copy of the App's PEM.
 */
import { lstatSync, readdirSync } from "node:fs";
import {
  readExistingLocalJson,
  replaceLocalJsonIfCurrent,
  localComponentPath,
  ensureLocalComponentDirectory,
} from "../local-control/config.js";
import { ExecutorAppCredentialStore, type StoredAppCredential } from "./credential-store.js";

export interface ExecutorRepositoryBinding {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly nameWithOwner: string;
  readonly appId: string;
  readonly installationId: string;
  /** The exact App credential generation the owner verified for this installation. */
  readonly generation: string;
  readonly fingerprint: string;
}

/** `bound` only while the binding names the App's current, provider-verified generation. */
export type ExecutorRepositoryBindingState = "bound" | "stale";

const DIRECTORY = "repository-bindings";
/** Same bound as the legacy per-key binding list; not widened (#1199). */
const MAX_REPOSITORY_BINDINGS = 32;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,64}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const NAME_WITH_OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const FIELDS = [
  "repositoryHost",
  "repositoryId",
  "nameWithOwner",
  "appId",
  "installationId",
  "generation",
  "fingerprint",
] as const;

export class ExecutorRepositoryBindingError extends Error {
  readonly code = "EXECUTOR_REPOSITORY_BINDING_FAILED";
  constructor() {
    super("Executor repository binding failed closed.");
  }
}

function failure(): ExecutorRepositoryBindingError {
  return new ExecutorRepositoryBindingError();
}

function validBinding(value: unknown): value is ExecutorRepositoryBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === FIELDS.length &&
    FIELDS.every((key) => typeof record[key] === "string") &&
    record.repositoryHost === "github.com" &&
    DECIMAL_ID.test(record.repositoryId as string) &&
    NAME_WITH_OWNER.test(record.nameWithOwner as string) &&
    DECIMAL_ID.test(record.appId as string) &&
    DECIMAL_ID.test(record.installationId as string) &&
    IDENTIFIER.test(record.generation as string) &&
    FINGERPRINT.test(record.fingerprint as string)
  );
}

function validator(value: unknown): ExecutorRepositoryBinding {
  if (!validBinding(value)) throw failure();
  return {
    repositoryHost: value.repositoryHost,
    repositoryId: value.repositoryId,
    nameWithOwner: value.nameWithOwner,
    appId: value.appId,
    installationId: value.installationId,
    generation: value.generation,
    fingerprint: value.fingerprint,
  };
}

/**
 * Whether `binding` is satisfied by `credential`: the same App, its exact
 * generation and fingerprint, and a provider-verified credential. A new key
 * generation therefore leaves every older binding stale until reverified.
 */
export function repositoryBindingState(
  binding: ExecutorRepositoryBinding,
  credential: StoredAppCredential | undefined,
): ExecutorRepositoryBindingState {
  return credential !== undefined &&
    credential.providerVerified &&
    credential.appId === binding.appId &&
    credential.generation === binding.generation &&
    credential.fingerprint === binding.fingerprint
    ? "bound"
    : "stale";
}

function file(repositoryId: string): string {
  if (!DECIMAL_ID.test(repositoryId)) throw failure();
  return `${DIRECTORY}/${repositoryId}.json`;
}

export class ExecutorRepositoryBindingStore {
  readonly #environment: NodeJS.ProcessEnv;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  read(repositoryId: string): ExecutorRepositoryBinding | undefined {
    const relative = file(repositoryId);
    try {
      const record = readExistingLocalJson("executor", relative, validator, this.#environment);
      if (record !== undefined && record.repositoryId !== repositoryId) throw failure();
      return record;
    } catch {
      throw failure();
    }
  }

  /** Every binding, bounded; an unexpected entry fails closed instead of being skipped. */
  list(): readonly ExecutorRepositoryBinding[] {
    let entries: string[];
    try {
      lstatSync(localComponentPath("executor", DIRECTORY, this.#environment));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw failure();
    }
    try {
      // The directory exists; this only re-validates its ownership, mode and no-follow chain.
      entries = readdirSync(ensureLocalComponentDirectory("executor", this.#environment, DIRECTORY));
    } catch {
      throw failure();
    }
    const records = entries
      .filter((entry) => !/^[1-9][0-9]{0,19}\.json\.tmp-/u.test(entry))
      .sort()
      .map((entry) => {
        const match = /^([1-9][0-9]{0,19})\.json$/u.exec(entry);
        if (match === null) throw failure();
        const record = this.read(match[1] as string);
        if (record === undefined) throw failure();
        return record;
      });
    if (records.length > MAX_REPOSITORY_BINDINGS) throw failure();
    return records;
  }

  /** The binding for a repository locator; host and name compare case-insensitively like the legacy index. */
  find(repositoryHost: string, nameWithOwner: string): ExecutorRepositoryBinding | undefined {
    const matches = this.list().filter(
      (item) =>
        item.repositoryHost.toLowerCase() === repositoryHost.toLowerCase() &&
        item.nameWithOwner.toLowerCase() === nameWithOwner.toLowerCase(),
    );
    if (matches.length > 1) throw failure();
    return matches[0];
  }

  /**
   * Publish a binding the Executor owner has just verified. The App's current
   * credential must be provider-verified at exactly the binding's generation
   * and fingerprint. An existing binding never moves to another host, App or
   * installation; the same App and installation may advance to a reverified
   * generation.
   */
  publish(binding: ExecutorRepositoryBinding): { binding: ExecutorRepositoryBinding; changed: boolean } {
    const next = validator({ ...binding });
    const credential = new ExecutorAppCredentialStore(this.#environment).current(next.appId);
    if (repositoryBindingState(next, credential) !== "bound") throw failure();
    const existing = this.read(next.repositoryId);
    if (
      existing !== undefined &&
      (existing.repositoryHost !== next.repositoryHost ||
        existing.appId !== next.appId ||
        existing.installationId !== next.installationId)
    )
      throw failure();
    if (existing !== undefined && FIELDS.every((key) => existing[key] === next[key]))
      return { binding: existing, changed: false };
    if (existing === undefined && this.list().length >= MAX_REPOSITORY_BINDINGS) throw failure();
    try {
      ensureLocalComponentDirectory("executor", this.#environment, DIRECTORY);
      return {
        binding: replaceLocalJsonIfCurrent(
          "executor",
          file(next.repositoryId),
          existing,
          next,
          validator,
          this.#environment,
        ),
        changed: true,
      };
    } catch {
      throw failure();
    }
  }
}
