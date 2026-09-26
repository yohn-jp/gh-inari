/**
 * Neutral Executor owner observation contract (#1223).
 *
 * The Executor is the only owner of App credentials and repository bindings.
 * Control-plane consumers observe them only through `ExecutorObservationPort`,
 * served either in process by the Executor-owned local adapter or over the
 * Executor's HTTP route by the observation client. Both return this one closed,
 * versioned, bounded record.
 *
 * The record carries public identities only: the Executor configuration ID,
 * per-App credential generation/fingerprint/verification, and per-repository
 * bindings with their owner-evaluated `bound`/`stale` status. It has no member
 * for key bytes, PEM, key or file paths, provider tokens, environment values,
 * Session material or free-form diagnostics. Legacy single-App custody that the
 * Executor has not adopted yet appears only as `source: "legacy"` evidence and
 * never for an App or repository that canonical App-scoped custody covers.
 */
import { invalid, RuntimeContractError } from "./errors.js";
import { assertSecretFreeSetupJson } from "./secret-material.js";

export const EXECUTOR_OBSERVATION_VERSION = 1 as const;
/** Bounds on one observation; larger owner state fails closed instead of being truncated. */
export const MAX_EXECUTOR_OBSERVED_APPS = 64;
export const MAX_EXECUTOR_OBSERVED_BINDINGS = 256;

/** `app-scoped` is canonical Executor custody; `legacy` is un-adopted single-App compatibility evidence. */
export type ExecutorCustodySource = "app-scoped" | "legacy";

/** Public identity of the current Issuer credential generation of one App. */
export interface ExecutorAppObservation {
  readonly appId: string;
  readonly generation: string;
  readonly fingerprint: string;
  readonly providerVerified: boolean;
  readonly source: ExecutorCustodySource;
}

/** Executor-owned binding of one immutable repository identity to an App installation and credential generation. */
export interface ExecutorRepositoryBindingObservation {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  /** Display name recorded with the binding; never a binding key. */
  readonly nameWithOwner: string;
  readonly appId: string;
  readonly installationId: string;
  readonly generation: string;
  readonly fingerprint: string;
  /** `bound` only while the binding names its App's current, provider-verified generation. */
  readonly status: "bound" | "stale";
  readonly source: ExecutorCustodySource;
}

export interface ExecutorObservation {
  readonly version: typeof EXECUTOR_OBSERVATION_VERSION;
  /** Executor component configuration ID that holds this custody. */
  readonly executorId: string;
  /** Sorted by numeric App ID; at most one entry per App. */
  readonly apps: readonly ExecutorAppObservation[];
  /** Sorted by repository host and numeric repository ID; at most one entry per repository. */
  readonly bindings: readonly ExecutorRepositoryBindingObservation[];
}

/**
 * Read-only Executor owner observation. Implementations never migrate,
 * create or write owner state, and fail closed instead of reporting absence
 * when evidence cannot be obtained.
 */
export interface ExecutorObservationPort {
  observe(): Promise<ExecutorObservation>;
}

const EXECUTOR_ID = /^exec_[A-Za-z0-9_-]{16,64}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const GENERATION = /^[A-Za-z0-9_-]{16,64}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const NAME_WITH_OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const OBSERVATION_MEMBERS = ["version", "executorId", "apps", "bindings"] as const;
const APP_MEMBERS = ["appId", "generation", "fingerprint", "providerVerified", "source"] as const;
const BINDING_MEMBERS = [
  "repositoryHost",
  "repositoryId",
  "nameWithOwner",
  "appId",
  "installationId",
  "generation",
  "fingerprint",
  "status",
  "source",
] as const;

function closedRecord(value: unknown, members: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(path, "must be an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== members.length || keys.some((key) => !members.includes(key)))
    throw invalid(path, "must have exactly the contract members.");
  return record;
}

function matching(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(path, "is not a valid public identifier.");
  return value;
}

function source(value: unknown, path: string): ExecutorCustodySource {
  if (value !== "app-scoped" && value !== "legacy") throw invalid(path, "must be app-scoped or legacy.");
  return value;
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBindings(
  left: Pick<ExecutorRepositoryBindingObservation, "repositoryHost" | "repositoryId">,
  right: Pick<ExecutorRepositoryBindingObservation, "repositoryHost" | "repositoryId">,
): number {
  if (left.repositoryHost !== right.repositoryHost) return left.repositoryHost < right.repositoryHost ? -1 : 1;
  return compareDecimal(left.repositoryId, right.repositoryId);
}

function validateApp(value: unknown, path: string): ExecutorAppObservation {
  const app = closedRecord(value, APP_MEMBERS, path);
  if (typeof app.providerVerified !== "boolean") throw invalid(`${path}.providerVerified`, "must be a boolean.");
  return Object.freeze({
    appId: matching(app.appId, DECIMAL_ID, `${path}.appId`),
    generation: matching(app.generation, GENERATION, `${path}.generation`),
    fingerprint: matching(app.fingerprint, FINGERPRINT, `${path}.fingerprint`),
    providerVerified: app.providerVerified,
    source: source(app.source, `${path}.source`),
  });
}

function validateBinding(value: unknown, path: string): ExecutorRepositoryBindingObservation {
  const binding = closedRecord(value, BINDING_MEMBERS, path);
  if (binding.status !== "bound" && binding.status !== "stale")
    throw invalid(`${path}.status`, "must be bound or stale.");
  return Object.freeze({
    repositoryHost: matching(binding.repositoryHost, HOST, `${path}.repositoryHost`),
    repositoryId: matching(binding.repositoryId, DECIMAL_ID, `${path}.repositoryId`),
    nameWithOwner: matching(binding.nameWithOwner, NAME_WITH_OWNER, `${path}.nameWithOwner`),
    appId: matching(binding.appId, DECIMAL_ID, `${path}.appId`),
    installationId: matching(binding.installationId, DECIMAL_ID, `${path}.installationId`),
    generation: matching(binding.generation, GENERATION, `${path}.generation`),
    fingerprint: matching(binding.fingerprint, FINGERPRINT, `${path}.fingerprint`),
    status: binding.status,
    source: source(binding.source, `${path}.source`),
  });
}

function boundedArray(value: unknown, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(path, "must be an array.");
  if (value.length > max) throw new RuntimeContractError("RUNTIME_CONTRACT_TOO_LARGE", path, "exceeds its bound.");
  return value;
}

/**
 * Validate one Executor observation: closed schema, supported version, public
 * identifiers only, bounded, strictly ordered with unique Apps and repositories,
 * and free of secret material.
 */
export function validateExecutorObservation(value: unknown): ExecutorObservation {
  assertSecretFreeSetupJson(value);
  const observation = closedRecord(value, OBSERVATION_MEMBERS, "$");
  if (observation.version !== EXECUTOR_OBSERVATION_VERSION)
    throw invalid("$.version", "is not a supported observation version.");
  const apps = boundedArray(observation.apps, MAX_EXECUTOR_OBSERVED_APPS, "$.apps").map((item, index) =>
    validateApp(item, `$.apps[${index}]`),
  );
  const bindings = boundedArray(observation.bindings, MAX_EXECUTOR_OBSERVED_BINDINGS, "$.bindings").map((item, index) =>
    validateBinding(item, `$.bindings[${index}]`),
  );
  for (let index = 1; index < apps.length; index += 1)
    if (compareDecimal(apps[index - 1]!.appId, apps[index]!.appId) >= 0)
      throw invalid(`$.apps[${index}]`, "must be unique and ordered by App ID.");
  for (let index = 1; index < bindings.length; index += 1)
    if (compareBindings(bindings[index - 1]!, bindings[index]!) >= 0)
      throw invalid(`$.bindings[${index}]`, "must be unique and ordered by repository identity.");
  return Object.freeze({
    version: EXECUTOR_OBSERVATION_VERSION,
    executorId: matching(observation.executorId, EXECUTOR_ID, "$.executorId"),
    apps: Object.freeze(apps),
    bindings: Object.freeze(bindings),
  });
}

/** Deterministic order used by every producer of an observation. */
export function orderExecutorObservation(
  observation: Omit<ExecutorObservation, "version"> & { readonly version?: typeof EXECUTOR_OBSERVATION_VERSION },
): ExecutorObservation {
  return validateExecutorObservation({
    version: EXECUTOR_OBSERVATION_VERSION,
    executorId: observation.executorId,
    apps: [...observation.apps].sort((left, right) => compareDecimal(left.appId, right.appId)),
    bindings: [...observation.bindings].sort(compareBindings),
  });
}
