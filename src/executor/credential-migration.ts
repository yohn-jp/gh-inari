/**
 * Adoption of the legacy single-App Executor custody (#1199).
 *
 * The legacy `executor/issuer/issuer-key.json + issuer-*.pem` store is read
 * and its key fingerprint verified; the same generation is committed into
 * App-scoped custody (no key regeneration) and each legacy `bindings[]` entry
 * becomes a repository binding for that exact generation. New records are
 * committed first; the legacy store is never written or deleted here, so an
 * interrupted adoption leaves the working legacy credential intact and a
 * rerun converges idempotently.
 */
import { lstatSync } from "node:fs";
import { localComponentPath } from "../local-control/config.js";
import {
  ExecutorAppCredentialStore,
  ExecutorCredentialStore,
  type AppCredentialGeneration,
  type StoredIssuerKey,
} from "./credential-store.js";
import { ExecutorRepositoryBindingStore } from "./repository-binding-store.js";

export class ExecutorCredentialMigrationError extends Error {
  readonly code = "EXECUTOR_CREDENTIAL_MIGRATION_FAILED";
  constructor() {
    super("Executor Issuer custody adoption failed closed.");
  }
}

function failure(): ExecutorCredentialMigrationError {
  return new ExecutorCredentialMigrationError();
}

/** Public, secret-free adoption outcome: IDs and counts only, never a key path. */
export interface LegacyCustodyAdoption {
  readonly status: "absent" | "adopted" | "unchanged";
  readonly appId?: string;
  readonly generation?: string;
  readonly fingerprint?: string;
  readonly bindings: number;
}

export interface LegacyCustodyAdoptionOptions {
  /**
   * The App-scoped generation the caller observed before an explicit, owner
   * confirmed legacy key replacement. Only this exact generation may be
   * advanced to the legacy generation; any other divergence fails closed.
   */
  readonly replacing?: AppCredentialGeneration;
}

/** Whether a legacy single-App custody index exists. Never creates directories. */
export function legacyExecutorCustodyPresent(environment: NodeJS.ProcessEnv = process.env): boolean {
  try {
    lstatSync(localComponentPath("executor", "issuer/issuer-key.json", environment));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw failure();
  }
}

export function adoptLegacyExecutorCustody(
  environment: NodeJS.ProcessEnv = process.env,
  options: LegacyCustodyAdoptionOptions = {},
): LegacyCustodyAdoption {
  if (!legacyExecutorCustodyPresent(environment)) return Object.freeze({ status: "absent", bindings: 0 });
  try {
    const legacy = new ExecutorCredentialStore(environment);
    const record: StoredIssuerKey | undefined = legacy.current();
    if (record === undefined) throw failure();
    const apps = new ExecutorAppCredentialStore(environment);
    let changed = false;
    let current = apps.current(record.appId);
    if (current !== undefined && current.configId !== record.configId) throw failure();
    if (current === undefined || current.generation !== record.generation) {
      if (current?.fingerprint === record.fingerprint) throw failure();
      const expected =
        current === undefined
          ? undefined
          : options.replacing !== undefined &&
              options.replacing.generation === current.generation &&
              options.replacing.fingerprint === current.fingerprint
            ? current
            : undefined;
      if (current !== undefined && expected === undefined) throw failure();
      current = apps.adopt(
        {
          configId: record.configId,
          appId: record.appId,
          generation: record.generation,
          fingerprint: record.fingerprint,
          providerVerified: record.providerVerified,
        },
        legacy.readKey(record),
        expected,
      ).record;
      changed = true;
    } else if (current.fingerprint !== record.fingerprint) throw failure();
    if (record.providerVerified && !current.providerVerified) {
      current = apps.markProviderVerified(record.appId, record.generation);
      changed = true;
    }
    const bindings = new ExecutorRepositoryBindingStore(environment);
    for (const binding of record.bindings ?? []) {
      changed =
        bindings.publish({
          repositoryHost: binding.repositoryHost,
          repositoryId: binding.repositoryId,
          nameWithOwner: binding.nameWithOwner,
          appId: record.appId,
          installationId: binding.installationId,
          generation: record.generation,
          fingerprint: record.fingerprint,
        }).changed || changed;
    }
    return Object.freeze({
      status: changed ? ("adopted" as const) : ("unchanged" as const),
      appId: record.appId,
      generation: record.generation,
      fingerprint: record.fingerprint,
      bindings: record.bindings?.length ?? 0,
    });
  } catch {
    throw failure();
  }
}
