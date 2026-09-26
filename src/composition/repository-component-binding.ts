/**
 * Secret-free repository component-binding projection (#1201).
 *
 * Composes, for one immutable repository identity, the public identities the
 * repository is bound to, read only from canonical registry state and owner
 * public projections:
 *
 * - repository identity: the repository registry record (#1197), so a rename
 *   is resolved by `repositoryHost + repositoryId`, never by name;
 * - setup record: `repositories/<repositoryId>/setup.json` (#1198);
 * - Executor: its component configuration ID, the App-scoped credential
 *   generation/fingerprint of the repository's App, and the Executor-owned
 *   repository binding of this repository ID (#1199);
 * - Authority: the Authority-ID-scoped public identity the repository
 *   references (#1200);
 * - Admission: its component ID and the Executor it is pinned to;
 * - the selected public Runtime Endpoint recorded by setup.
 *
 * The projection carries IDs, fingerprints and public URLs only: no key bytes,
 * key or owner file paths, tokens, Session material or environment copies.
 * Legacy single-App Executor custody, the legacy single Authority descriptor
 * and legacy setup records are compatibility inputs only: each is consulted
 * solely while the canonical owner state for the same subject is absent, is
 * labelled `legacy`, and never overrides canonical state.
 *
 * Reads never create directories and never mutate owner state. Local Runtime
 * transport, discovery and mTLS are unchanged; Admission is referenced only by
 * its existing public component identity.
 */
import { listLocalAuthorityIdentities } from "../authority/index.js";
import { createLocalExecutorObservationPort } from "../executor/observation.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  readExistingLocalJson,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
} from "../local-control/config.js";
import { RepositoryRegistry } from "../local-control/repository-registry.js";
import {
  assertSecretFreeSetupJson,
  type ExecutorObservation,
  type ExecutorObservationPort,
} from "../runtime-contracts/index.js";
import {
  SetupConfigStore,
  type SetupConfigApp,
  type SetupConfigAuthority,
  type SetupConfigSource,
} from "./setup-config-store.js";

export const REPOSITORY_COMPONENT_BINDING_VERSION = 1 as const;

/** `app-scoped`/`authority-id` is canonical owner custody; `legacy` is un-adopted compatibility input. */
export type ExecutorCustodySource = "app-scoped" | "legacy";

/** Public identity of the current Issuer credential generation of one App. */
export interface ExecutorCredentialProjection {
  readonly configId: string;
  readonly appId: string;
  readonly generation: string;
  readonly fingerprint: string;
  readonly providerVerified: boolean;
  readonly source: ExecutorCustodySource;
}

/** Executor-owned binding of one repository ID to an App installation and exact credential generation. */
export interface ExecutorBindingProjection {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly appId: string;
  readonly installationId: string;
  readonly generation: string;
  readonly fingerprint: string;
  /** `bound` only while the binding names its App's current, provider-verified generation. */
  readonly status: "bound" | "stale";
  readonly source: ExecutorCustodySource;
}

/** All public Executor custody evidence, canonical first. */
export interface ExecutorCustodyEvidence {
  readonly credentials: readonly ExecutorCredentialProjection[];
  readonly bindings: readonly ExecutorBindingProjection[];
}

export interface AuthorityReferenceProjection {
  /** Absent for the legacy descriptor before setup recorded an Authority ID; the descriptor has none. */
  readonly authorityId?: string;
  readonly publicKeyFingerprint: string;
  /** `authority-id`: Authority-ID-scoped custody; `legacy`: the single pre-#1200 descriptor. */
  readonly custody: "authority-id" | "legacy";
}

export type RepositoryComponentConflict =
  /** The recorded Executor configuration is not the Executor component's configuration. */
  | "executor-configuration"
  /** The repository's App credential is held by another Executor configuration or another key. */
  | "executor-credential"
  /** The Executor binding of this repository names another App or installation than setup recorded. */
  | "executor-binding"
  /** The referenced Authority identity carries another public key than setup recorded. */
  | "authority"
  /** Admission is pinned to another Executor than the Executor component. */
  | "admission-executor";

export interface RepositoryComponentBinding {
  readonly version: typeof REPOSITORY_COMPONENT_BINDING_VERSION;
  /** Registry identity when registered; the caller's observed identity otherwise. */
  readonly repository: RepositoryIdentity;
  readonly registered: boolean;
  readonly setup?: { readonly source: SetupConfigSource; readonly revision: number };
  /** Selected public Runtime Endpoint reference recorded by setup. */
  readonly endpoint?: string;
  readonly app?: SetupConfigApp;
  readonly executor?: {
    /** Executor component configuration ID from the Executor owner's public configuration. */
    readonly componentId?: string;
    /** Executor configuration and Issuer key fingerprint setup recorded for this repository. */
    readonly recordedConfigId?: string;
    readonly recordedIssuerKeyFingerprint?: string;
    /** Public identity of the repository App's current Executor credential generation. */
    readonly appCredential?: ExecutorCredentialProjection;
    readonly binding?: ExecutorBindingProjection;
  };
  readonly authority?: {
    readonly recorded?: SetupConfigAuthority;
    readonly identity?: AuthorityReferenceProjection;
  };
  readonly admission?: { readonly id: string; readonly executorId: string };
  readonly conflicts: readonly RepositoryComponentConflict[];
}

export type RepositoryComponentBindingSubject =
  "repository-registry" | "setup-config" | "executor" | "authority" | "admission/config.json";

export class RepositoryComponentBindingError extends Error {
  readonly code = "REPOSITORY_COMPONENT_BINDING_UNREADABLE" as const;
  readonly subjects: readonly RepositoryComponentBindingSubject[];

  constructor(subjects: readonly RepositoryComponentBindingSubject[]) {
    super(`Repository component binding evidence is unreadable: ${subjects.join(", ")}.`);
    this.name = "RepositoryComponentBindingError";
    this.subjects = Object.freeze([...subjects]);
  }
}

function sameRepository(
  left: Pick<RepositoryIdentity, "repositoryHost" | "repositoryId">,
  right: Pick<RepositoryIdentity, "repositoryHost" | "repositoryId">,
): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

/**
 * Executor custody evidence from one `ExecutorObservationPort` observation
 * (#1223). The Executor already resolved canonical App-scoped custody over
 * labelled legacy compatibility evidence; every credential it reports is held
 * by the observed Executor configuration. Returns `undefined` when the
 * Executor holds no custody at all.
 */
export function executorCustodyFromObservation(observation: ExecutorObservation): ExecutorCustodyEvidence | undefined {
  if (observation.apps.length === 0 && observation.bindings.length === 0) return undefined;
  return Object.freeze({
    credentials: Object.freeze(
      observation.apps.map((app) =>
        Object.freeze({
          configId: observation.executorId,
          appId: app.appId,
          generation: app.generation,
          fingerprint: app.fingerprint,
          providerVerified: app.providerVerified,
          source: app.source,
        }),
      ),
    ),
    bindings: Object.freeze(
      observation.bindings.map((binding) =>
        Object.freeze({
          repositoryHost: binding.repositoryHost,
          repositoryId: binding.repositoryId,
          appId: binding.appId,
          installationId: binding.installationId,
          generation: binding.generation,
          fingerprint: binding.fingerprint,
          status: binding.status,
          source: binding.source,
        }),
      ),
    ),
  });
}

/** Result of observing the Executor for one repository context. */
export type ExecutorObservationRead =
  | { readonly state: "present"; readonly observation: ExecutorObservation }
  /** No Executor evidence, and the repository has not recorded an Executor yet. */
  | { readonly state: "absent" }
  | { readonly state: "unreadable" };

/**
 * Observe the Executor through its owner port. A failed observation is
 * unreadable once the repository has recorded an Executor configuration, so a
 * configured repository fails closed; before that, it only means no Executor
 * evidence exists yet. Owner files are never consulted as a fallback.
 */
export async function readExecutorObservation(
  port: ExecutorObservationPort,
  recordedExecutor: boolean,
): Promise<ExecutorObservationRead> {
  try {
    return Object.freeze({ state: "present" as const, observation: await port.observe() });
  } catch {
    return Object.freeze({ state: recordedExecutor ? ("unreadable" as const) : ("absent" as const) });
  }
}

/** The current credential of exactly this App, canonical before legacy. */
export function executorCredentialFor(
  custody: ExecutorCustodyEvidence | undefined,
  appId: string,
): ExecutorCredentialProjection | undefined {
  return custody?.credentials.find((credential) => credential.appId === appId);
}

/** The Executor binding of exactly this repository ID; names are never used as binding keys. */
export function executorBindingFor(
  custody: ExecutorCustodyEvidence | undefined,
  repository: Pick<RepositoryIdentity, "repositoryHost" | "repositoryId">,
): ExecutorBindingProjection | undefined {
  return custody?.bindings.find((binding) => sameRepository(binding, repository));
}

/**
 * The public Authority identity a repository references. The Authority-ID
 * entry is canonical; the single legacy descriptor (which has no ID) is used
 * only while no entry exists for the recorded ID, or before any Authority is
 * recorded.
 */
export function readAuthorityReference(
  recorded: SetupConfigAuthority | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): AuthorityReferenceProjection | undefined {
  if (recorded !== undefined) {
    const identity = listLocalAuthorityIdentities(environment).find(
      (candidate) => candidate.authorityId === recorded.authorityId,
    );
    if (identity !== undefined)
      return Object.freeze({
        authorityId: identity.authorityId,
        publicKeyFingerprint: identity.publicKeyFingerprint,
        custody: "authority-id" as const,
      });
  }
  const descriptor = readExistingLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment);
  if (descriptor === undefined) return undefined;
  return Object.freeze({
    ...(recorded === undefined ? {} : { authorityId: recorded.authorityId }),
    publicKeyFingerprint: descriptor.publicKeyFingerprint,
    custody: "legacy" as const,
  });
}

export interface RepositoryComponentBindingOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Executor owner observation (#1223). Defaults to the co-located local
   * adapter; a separately hosted Executor is observed through an explicitly
   * configured `ExecutorObservationClient`.
   */
  readonly executor?: ExecutorObservationPort;
}

type Read<T> = { readonly ok: true; readonly value: T | undefined } | { readonly ok: false };

function read<T>(load: () => T | undefined): Read<T> {
  try {
    return { ok: true, value: load() };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve the one secret-free component binding of a repository from
 * canonical registry and owner public state. The repository is selected by
 * `repositoryHost + repositoryId`; a registered name wins over the caller's.
 * Unreadable evidence fails closed with the unreadable subjects.
 */
export async function resolveRepositoryComponentBinding(
  repository: RepositoryIdentity,
  options: RepositoryComponentBindingOptions = {},
): Promise<RepositoryComponentBinding> {
  const environment = options.environment ?? process.env;
  const registry = read(() => new RepositoryRegistry({ environment }).get(repository.repositoryId));
  const setup = read(() => new SetupConfigStore({ environment }).observe(repository));
  const executor = await readExecutorObservation(
    options.executor ?? createLocalExecutorObservationPort({ environment }),
    setup.ok && setup.value?.record.executor !== undefined,
  );
  const admission = read(() =>
    readExistingLocalJson("admission", "config.json", validateLocalAdmissionConfig, environment),
  );
  const record = setup.ok ? setup.value?.record : undefined;
  const authority = read(() => readAuthorityReference(record?.authority, environment));
  const unreadable = (
    [
      ["repository-registry", registry],
      ["setup-config", setup],
      ["executor", { ok: executor.state !== "unreadable" }],
      ["authority", authority],
      ["admission/config.json", admission],
    ] as const
  )
    .filter(([, item]) => !item.ok)
    .map(([subject]) => subject);
  if (unreadable.length > 0) throw new RepositoryComponentBindingError(unreadable);
  const value = <T>(item: Read<T>): T | undefined => (item.ok ? item.value : undefined);

  const registered = value(registry);
  if (registered !== undefined && registered.repositoryHost !== repository.repositoryHost)
    throw new RepositoryComponentBindingError(["repository-registry"]);
  const identity: RepositoryIdentity = Object.freeze(
    registered === undefined
      ? {
          repositoryHost: repository.repositoryHost,
          repositoryId: repository.repositoryId,
          nameWithOwner: repository.nameWithOwner,
        }
      : {
          repositoryHost: registered.repositoryHost,
          repositoryId: registered.repositoryId,
          nameWithOwner: registered.nameWithOwner,
        },
  );
  const observation = executor.state === "present" ? executor.observation : undefined;
  const componentId = observation?.executorId;
  const evidence = observation === undefined ? undefined : executorCustodyFromObservation(observation);
  const binding = executorBindingFor(evidence, identity);
  const appId = record?.app?.appId ?? binding?.appId;
  const credential = appId === undefined ? undefined : executorCredentialFor(evidence, appId);
  const authorityIdentity = value(authority);
  const admissionConfig = value(admission);

  const conflicts: RepositoryComponentConflict[] = [];
  if (record?.executor !== undefined && componentId !== undefined && record.executor.configId !== componentId)
    conflicts.push("executor-configuration");
  if (
    record?.executor !== undefined &&
    credential !== undefined &&
    (credential.configId !== record.executor.configId ||
      credential.fingerprint !== record.executor.issuerKeyFingerprint)
  )
    conflicts.push("executor-credential");
  if (
    binding !== undefined &&
    record?.app !== undefined &&
    (binding.appId !== record.app.appId ||
      (record.app.installationId !== undefined && binding.installationId !== record.app.installationId))
  )
    conflicts.push("executor-binding");
  if (
    record?.authority !== undefined &&
    authorityIdentity !== undefined &&
    authorityIdentity.publicKeyFingerprint !== record.authority.publicKeyFingerprint
  )
    conflicts.push("authority");
  if (admissionConfig !== undefined && componentId !== undefined && admissionConfig.executor.id !== componentId)
    conflicts.push("admission-executor");

  const executorProjection = {
    ...(componentId === undefined ? {} : { componentId }),
    ...(record?.executor === undefined
      ? {}
      : {
          recordedConfigId: record.executor.configId,
          recordedIssuerKeyFingerprint: record.executor.issuerKeyFingerprint,
        }),
    ...(credential === undefined ? {} : { appCredential: credential }),
    ...(binding === undefined ? {} : { binding }),
  };
  const authorityProjection = {
    ...(record?.authority === undefined ? {} : { recorded: record.authority }),
    ...(authorityIdentity === undefined || record?.authority === undefined ? {} : { identity: authorityIdentity }),
  };
  const projection: RepositoryComponentBinding = Object.freeze({
    version: REPOSITORY_COMPONENT_BINDING_VERSION,
    repository: identity,
    registered: registered !== undefined,
    ...(setup.ok && setup.value !== undefined
      ? { setup: Object.freeze({ source: setup.value.source, revision: setup.value.record.revision }) }
      : {}),
    ...(record?.endpoint === undefined ? {} : { endpoint: record.endpoint }),
    ...(record?.app === undefined ? {} : { app: record.app }),
    ...(Object.keys(executorProjection).length === 0 ? {} : { executor: Object.freeze(executorProjection) }),
    ...(Object.keys(authorityProjection).length === 0 ? {} : { authority: Object.freeze(authorityProjection) }),
    ...(admissionConfig === undefined
      ? {}
      : { admission: Object.freeze({ id: admissionConfig.id, executorId: admissionConfig.executor.id }) }),
    conflicts: Object.freeze(conflicts),
  });
  assertSecretFreeSetupJson(projection);
  return projection;
}
