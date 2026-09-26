/**
 * Executor-owned local adapter of `ExecutorObservationPort` (#1223).
 *
 * Projects the Executor's own public custody state through the accepted #1199
 * owner projections: App-scoped credentials and repository bindings are
 * canonical; the legacy single-App index is reported only as labelled
 * `legacy` evidence for an App without App-scoped custody, and its bindings
 * only for repositories without an App-scoped binding while they name that
 * App's selected generation. Observation is read-only: it never adopts legacy
 * custody, never creates owner directories and never returns key bytes or
 * paths. Inconsistent owner state fails closed.
 */
import { readExistingLocalJson, validateLocalExecutorConfig } from "../local-control/config.js";
import {
  orderExecutorObservation,
  type ExecutorAppObservation,
  type ExecutorObservation,
  type ExecutorObservationPort,
  type ExecutorRepositoryBindingObservation,
} from "../runtime-contracts/executor-observation.js";
import { legacyExecutorCustodyPresent } from "./credential-migration.js";
import { executorAppCustody, executorIssuerCustody } from "./enrollment/owner.js";
import { LocalExecutorError } from "./errors.js";

export interface LocalExecutorObservationOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

function unavailable(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_OWNER_OBSERVATION_UNAVAILABLE",
    "Executor owner state could not be observed safely.",
  );
}

function sameRepository(
  left: Pick<ExecutorRepositoryBindingObservation, "repositoryHost" | "repositoryId">,
  right: Pick<ExecutorRepositoryBindingObservation, "repositoryHost" | "repositoryId">,
): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

/** One read-only observation of this Executor's configuration, App custody and repository bindings. */
export function observeLocalExecutorOwner(options: LocalExecutorObservationOptions = {}): ExecutorObservation {
  const environment = options.environment ?? process.env;
  try {
    const config = readExistingLocalJson("executor", "config.json", validateLocalExecutorConfig, environment);
    if (config === undefined) throw unavailable();
    const scoped = executorAppCustody(environment);
    const legacy = legacyExecutorCustodyPresent(environment) ? executorIssuerCustody(environment) : undefined;
    // Custody held for another Executor configuration is not this Executor's evidence.
    if (
      scoped.apps.some((app) => app.configId !== config.id) ||
      (legacy !== undefined && legacy.configId !== config.id)
    )
      throw unavailable();
    const apps: ExecutorAppObservation[] = scoped.apps.map((app) => ({
      appId: app.appId,
      generation: app.generation,
      fingerprint: app.fingerprint,
      providerVerified: app.providerVerified,
      source: "app-scoped" as const,
    }));
    const bindings: ExecutorRepositoryBindingObservation[] = scoped.bindings.map((binding) => ({
      repositoryHost: binding.repositoryHost,
      repositoryId: binding.repositoryId,
      nameWithOwner: binding.nameWithOwner,
      appId: binding.appId,
      installationId: binding.installationId,
      generation: binding.generation,
      fingerprint: binding.fingerprint,
      status: binding.status,
      source: "app-scoped" as const,
    }));
    if (legacy !== undefined) {
      if (!apps.some((app) => app.appId === legacy.appId))
        apps.push({
          appId: legacy.appId,
          generation: legacy.generation,
          fingerprint: legacy.fingerprint,
          providerVerified: legacy.providerVerified,
          source: "legacy",
        });
      const selected = apps.find((app) => app.appId === legacy.appId)!;
      if (selected.generation === legacy.generation && selected.fingerprint === legacy.fingerprint)
        for (const binding of legacy.bindings) {
          if (bindings.some((item) => sameRepository(item, binding))) continue;
          bindings.push({
            repositoryHost: binding.repositoryHost,
            repositoryId: binding.repositoryId,
            nameWithOwner: binding.nameWithOwner,
            appId: legacy.appId,
            installationId: binding.installationId,
            generation: legacy.generation,
            fingerprint: legacy.fingerprint,
            status: selected.providerVerified ? "bound" : "stale",
            source: "legacy",
          });
        }
    }
    return orderExecutorObservation({ executorId: config.id, apps, bindings });
  } catch (error: unknown) {
    if (error instanceof LocalExecutorError) throw error;
    throw unavailable();
  }
}

/** In-process `ExecutorObservationPort` for a co-located Executor. */
export function createLocalExecutorObservationPort(
  options: LocalExecutorObservationOptions = {},
): ExecutorObservationPort {
  return Object.freeze({ observe: async () => observeLocalExecutorOwner(options) });
}
