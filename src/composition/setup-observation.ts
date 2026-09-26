/**
 * Real Setup observation composition (#1120).
 *
 * Projects the five Setup dimensions from actual owner evidence, each kept
 * distinct and bound to one configuration generation:
 *
 * - configuration: the shared setup record plus Executor custody, Executor,
 *   Authority and Admission configuration and the Runtime profile migration
 *   state, read without mutation;
 * - provider-binding: the recorded App installation of the repository and the
 *   Executor's verification of its Issuer key against that installation;
 * - repository-trust: the protected-ref Runtime Authority records compared
 *   with the adopted Authority (same ID, key, notBefore, TTL and exact
 *   capability ceiling); a recorded publication is pending, never trusted;
 * - health: the injected Runtime lifecycle owner (#1121), never inferred;
 * - session-readiness: the running Admission's own readiness report.
 *
 * Unavailable evidence stays `unknown`. Health never implies trust. Reads
 * never initiate an action, and no secret enters the observation.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import { canonicalDelegatorJson, validateDelegator, type Delegator } from "../agent-authority/delegator.js";
import { DelegatorTrustError, loadDelegatorTrust } from "../agent-authority/delegator-trust.js";
import { executorIssuerCustody, type ExecutorIssuerCustodyStatus } from "../executor/enrollment/owner.js";
import { GitHubAppDeviceFlowClient, type GitHubAppUserCredential } from "../github/app-user-credential.js";
import {
  GitHubAppUserCredentialBroker,
  GitHubAppUserCredentialBrokerError,
} from "../github/app-user-credential-broker.js";
import { FileAppUserCredentialStore } from "../github/app-user-credential-store.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import type { RepositoryContext } from "../github/types.js";
import {
  localComponentPath,
  readExistingLocalJson,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
  validateLocalExecutorConfig,
} from "../local-control/config.js";
import { validateLocalRuntimeEndpoint } from "../local-control/runtime-discovery.js";
import {
  LocalRuntimeProfileStore,
  resolveLocalRuntimeConfigHome,
  type LocalRuntimeProfile,
} from "../local-runtime-profile.js";
import { createReadinessReader } from "../repository-setup.js";
import {
  createRuntimeAuthorityPublicationRequest,
  publishRuntimeAuthority,
  type RuntimeAuthorityPublicationResult,
} from "../runtime-authority-publication.js";
import {
  MAX_SETUP_DIAGNOSTICS,
  SETUP_CONTRACT_VERSION,
  validateSetupObservation,
  type RuntimeComponent,
  type SetupDiagnostic,
  type SetupDimension,
  type SetupDimensionObservation,
  type SetupDimensionStatus,
  type SetupGeneration,
  type SetupObservation,
  type SetupObservationPort,
} from "../runtime-contracts/index.js";
import { SetupConfigStore, type SetupConfigRecord } from "./setup-config-store.js";

// ---------------------------------------------------------------------------
// Injected owner ports

/** Result of a Runtime lifecycle operation; `unknown` when its effect was not observed. */
export interface RuntimeLifecycleResult {
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly diagnostics: readonly SetupDiagnostic[];
}

export interface RuntimeLifecycleRequest {
  /** Stable Setup operation identity, reused for owner-side reconciliation. */
  readonly operationId: string;
  readonly generation: SetupGeneration;
}

/** Health evidence the lifecycle owner binds to the requested generation. */
export interface RuntimeHealthEvidence {
  readonly status: Exclude<SetupDimensionStatus<"health">, "unknown">;
  readonly observedAt: string;
  readonly generation: string;
  readonly diagnostics: readonly SetupDiagnostic[];
}

/**
 * The real local Runtime Supervisor/process lifecycle owner. #1121 supplies
 * it; this composition only dispatches to it and never spawns processes.
 */
export interface RuntimeLifecyclePort {
  observe(generation: SetupGeneration): Promise<RuntimeHealthEvidence>;
  start(request: RuntimeLifecycleRequest, signal?: AbortSignal): Promise<RuntimeLifecycleResult>;
  restart(request: RuntimeLifecycleRequest, signal?: AbortSignal): Promise<RuntimeLifecycleResult>;
}

/** Admission-owned Session readiness evidence. */
export interface SessionReadinessEvidence {
  readonly status: Exclude<SetupDimensionStatus<"session-readiness">, "unknown">;
  readonly observedAt: string;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export interface SessionReadinessPort {
  observe(generation: SetupGeneration, expectedAdmissionId: string): Promise<SessionReadinessEvidence>;
}

/** Repository/App coordinates of one provider operation. */
export interface SetupProviderContext {
  readonly repository: RepositoryIdentity;
  readonly appId: string;
  /** Public App client ID; enables non-interactive App-user credential refresh. */
  readonly clientId?: string;
}

export type SetupProviderFailureStage = "authorization" | "installation" | "unavailable" | "uncertain";

/** Provider failure with the stage it stopped at; only `uncertain` may follow a remote effect. */
export class SetupProviderError extends Error {
  readonly stage: SetupProviderFailureStage;

  constructor(stage: SetupProviderFailureStage) {
    super(`Setup provider operation failed (${stage}).`);
    this.name = "SetupProviderError";
    this.stage = stage;
  }
}

/**
 * Bootstrap provider operations performed with this operator's own App-user
 * authority (never the Executor Issuer credential).
 */
export interface SetupProviderPort {
  resolveInstallation(context: SetupProviderContext): Promise<{
    readonly appId: string;
    readonly installationId: string;
    readonly repositoryId: string;
  }>;
  readCanonicalAuthorities(context: SetupProviderContext): Promise<readonly Delegator[]>;
  publishAuthority(context: SetupProviderContext, authority: Delegator): Promise<RuntimeAuthorityPublicationResult>;
}

/** Device Flow client limited to refresh: bootstrap authorization is never started implicitly here. */
class RefreshOnlyDeviceFlow extends GitHubAppDeviceFlowClient {
  override async authorize(): Promise<GitHubAppUserCredential> {
    throw new SetupProviderError("authorization");
  }
}

function providerFailure(error: unknown, effectStarted: boolean): SetupProviderError {
  if (error instanceof SetupProviderError) return error;
  if (error instanceof GitHubAppUserCredentialBrokerError) {
    if (error.stage === "user-credential" || error.stage === "issuer-configuration")
      return new SetupProviderError("authorization");
    if (error.stage === "installation-scope") return new SetupProviderError("installation");
  }
  return new SetupProviderError(effectStarted ? "uncertain" : "unavailable");
}

export interface AppUserSetupProviderOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

/** Real App-user provider over the existing App-user broker, trust reader and publication owner. */
export function createAppUserSetupProvider(options: AppUserSetupProviderOptions = {}): SetupProviderPort {
  const environment = options.environment ?? process.env;
  const broker = (context: SetupProviderContext): GitHubAppUserCredentialBroker => {
    const [owner, name] = context.repository.nameWithOwner.split("/");
    if (owner === undefined || name === undefined) throw new SetupProviderError("unavailable");
    return new GitHubAppUserCredentialBroker({
      appId: context.appId,
      repository: { hostname: context.repository.repositoryHost, owner, name },
      repositoryId: context.repository.repositoryId,
      credentialStore: new FileAppUserCredentialStore({
        path: path.join(resolveLocalRuntimeConfigHome({ environment }), "app-user-credential.json"),
        createDirectory: false,
      }),
      ...(context.clientId === undefined
        ? {}
        : {
            deviceFlow: new RefreshOnlyDeviceFlow({
              clientId: context.clientId,
              hostname: context.repository.repositoryHost,
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              ...(options.now === undefined ? {} : { now: options.now }),
            }),
          }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  };
  const repositoryContext = (repository: RepositoryIdentity): RepositoryContext => {
    const [owner = "", name = ""] = repository.nameWithOwner.split("/");
    return {
      hostname: repository.repositoryHost,
      host: repository.repositoryHost,
      owner,
      name,
      nameWithOwner: repository.nameWithOwner,
      url: `https://${repository.repositoryHost}/${repository.nameWithOwner}`,
      repositoryId: repository.repositoryId,
    };
  };
  return Object.freeze({
    async resolveInstallation(context: SetupProviderContext) {
      try {
        return await broker(context).withRepositoryReadCapability({}, async (capability) => ({
          appId: capability.scope.app.appId,
          installationId: capability.scope.installation.installationId,
          repositoryId: capability.scope.repository.repositoryId,
        }));
      } catch (error: unknown) {
        throw providerFailure(error, false);
      }
    },
    async readCanonicalAuthorities(context: SetupProviderContext) {
      try {
        return await broker(context).withRepositoryReadCapability({}, async (capability) => {
          let snapshot;
          try {
            snapshot = await loadDelegatorTrust(
              createReadinessReader(
                capability,
                {
                  repositoryHost: context.repository.repositoryHost,
                  repositoryId: context.repository.repositoryId,
                  repositoryNameWithOwner: context.repository.nameWithOwner,
                },
                repositoryContext(context.repository),
              ),
            );
          } catch (error: unknown) {
            if (error instanceof DelegatorTrustError && error.code === "RUNTIME_AUTHORITY_NOT_FOUND") return [];
            throw error;
          }
          return snapshot.authorities.map((item) => item.authority);
        });
      } catch (error: unknown) {
        throw providerFailure(error, false);
      }
    },
    async publishAuthority(context: SetupProviderContext, authority: Delegator) {
      const instance = broker(context);
      try {
        return await publishRuntimeAuthority(
          createRuntimeAuthorityPublicationRequest(authority),
          context.repository,
          {
            withRuntimeAuthorityPublicationCapability:
              instance.withRuntimeAuthorityPublicationCapability.bind(instance),
          },
          { requireAuthor: null },
        );
      } catch (error: unknown) {
        // Authorization and installation scope are resolved before any mutation.
        throw providerFailure(error, true);
      }
    },
  });
}

export interface AdmissionSessionReadinessOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/**
 * Admission-owned readiness: the announced local Admission instance of the
 * configured identity reports its own readiness. No announcement means the
 * Admission is not running (not ready); an unreachable or foreign instance
 * is unknown.
 */
export function createAdmissionSessionReadiness(options: AdmissionSessionReadinessOptions = {}): SessionReadinessPort {
  const environment = options.environment ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async observe(_generation: SetupGeneration, expectedAdmissionId: string): Promise<SessionReadinessEvidence> {
      const announcement = readExistingLocalJson(
        "runtime",
        "endpoints/admission.json",
        validateLocalRuntimeEndpoint,
        environment,
      );
      if (announcement === undefined)
        return {
          status: "not-ready",
          observedAt: now().toISOString(),
          diagnostics: [diagnostic("SETUP_ADMISSION_NOT_RUNNING", "The local Admission is not announced.")],
        };
      if (announcement.component !== "admission" || announcement.id !== expectedAdmissionId)
        throw new Error("Announced Admission identity does not match setup.");
      const url = new URL("/health", announcement.endpoint);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Admission is not loopback.");
      const response = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 2_000) });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status !== 200 || body.component !== "admission" || body.admissionId !== expectedAdmissionId)
        throw new Error("Admission readiness is unavailable.");
      return {
        status: body.readiness === "ready" ? "ready" : "not-ready",
        observedAt: now().toISOString(),
        diagnostics: [],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Configuration evidence

type Read<T> =
  { readonly state: "absent" } | { readonly state: "present"; readonly value: T } | { readonly state: "unreadable" };

export interface SetupConfigurationEvidence {
  readonly repository: RepositoryIdentity;
  /** Setup configuration generation bound into every observation and action. */
  readonly generation: string;
  readonly config?: SetupConfigRecord;
  readonly executorConfigId?: string;
  readonly custody?: ExecutorIssuerCustodyStatus;
  readonly authorityDescriptorFingerprint?: string;
  readonly admission?: { readonly id: string; readonly executorId: string };
  /** Adopted public Runtime Authority record pinned by Admission. */
  readonly pin?: Delegator;
  readonly profile?: LocalRuntimeProfile;
  /** Secret-free subjects that could not be read safely. */
  readonly unreadable: readonly string[];
}

function read<T>(load: () => T | undefined): Read<T> {
  try {
    const value = load();
    return value === undefined ? { state: "absent" } : { state: "present", value };
  } catch {
    return { state: "unreadable" };
  }
}

function pinValidator(value: unknown): Delegator {
  const result = validateDelegator(value);
  if (!result.valid || result.value === undefined) throw new Error("invalid pin");
  return result.value;
}

function digest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

/** Custody is read only when its public index exists, so observation never creates owner directories. */
function readCustody(environment: NodeJS.ProcessEnv): ExecutorIssuerCustodyStatus | undefined {
  try {
    lstatSync(localComponentPath("executor", "issuer/issuer-key.json", environment));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return executorIssuerCustody(environment);
}

/** Read every owner's configuration evidence without mutation and derive the configuration generation. */
export async function readSetupConfigurationEvidence(
  repository: RepositoryIdentity,
  environment: NodeJS.ProcessEnv,
): Promise<SetupConfigurationEvidence> {
  const config = read(() => new SetupConfigStore({ environment }).read(repository));
  const executor = read(() =>
    readExistingLocalJson("executor", "config.json", validateLocalExecutorConfig, environment),
  );
  const custody = read(() => readCustody(environment));
  const descriptor = read(() =>
    readExistingLocalJson("authority", "config.json", validateLocalAuthorityConfig, environment),
  );
  const admission = read(() =>
    readExistingLocalJson("admission", "config.json", validateLocalAdmissionConfig, environment),
  );
  const pin = read(() => readExistingLocalJson("admission", "runtime-authority.json", pinValidator, environment));
  let profile: Read<LocalRuntimeProfile>;
  try {
    const value = await new LocalRuntimeProfileStore({ environment }).findForRepository({
      repositoryHost: repository.repositoryHost,
      repositoryNameWithOwner: repository.nameWithOwner,
    });
    profile =
      value === undefined
        ? { state: "absent" }
        : value.repository.repositoryId === repository.repositoryId
          ? { state: "present", value }
          : { state: "unreadable" };
  } catch {
    profile = { state: "unreadable" };
  }
  const unreadable = (
    [
      ["setup-config", config],
      ["executor/config.json", executor],
      ["executor/issuer", custody],
      ["authority/config.json", descriptor],
      ["admission/config.json", admission],
      ["admission/runtime-authority.json", pin],
      ["runtime-profile", profile],
    ] as const
  )
    .filter(([, item]) => item.state === "unreadable")
    .map(([subject]) => subject);
  const value = <T>(item: Read<T>): T | undefined => (item.state === "present" ? item.value : undefined);
  const evidence = {
    repository,
    ...(value(config) === undefined ? {} : { config: value(config) }),
    ...(value(executor) === undefined ? {} : { executorConfigId: value(executor)!.id }),
    ...(value(custody) === undefined ? {} : { custody: value(custody) }),
    ...(value(descriptor) === undefined
      ? {}
      : { authorityDescriptorFingerprint: value(descriptor)!.publicKeyFingerprint }),
    ...(value(admission) === undefined
      ? {}
      : { admission: { id: value(admission)!.id, executorId: value(admission)!.executor.id } }),
    ...(value(pin) === undefined ? {} : { pin: value(pin) }),
    ...(value(profile) === undefined ? {} : { profile: value(profile) }),
    unreadable,
  };
  // Executor custody and configuration are excluded: `executor.configure`
  // enrolls them inside the same operation before its action step, which must
  // still match the generation the operator confirmed. Its result is bound by
  // the shared record it writes next; custody itself is re-read by every owner
  // operation that relies on it.
  const generation = `cfg-${digest({
    repository: { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId },
    config: evidence.config,
    authority: evidence.authorityDescriptorFingerprint,
    admission: evidence.admission,
    pin: evidence.pin === undefined ? undefined : canonicalDelegatorJson(evidence.pin),
    profile: evidence.profile,
    unreadable,
  }).slice(0, 32)}`;
  return Object.freeze({ ...evidence, generation });
}

// ---------------------------------------------------------------------------
// Dimension projection

function diagnostic(code: string, message: string): SetupDiagnostic {
  return Object.freeze({ code, message });
}

interface DimensionResult<D extends SetupDimension> {
  readonly status: SetupDimensionStatus<D>;
  readonly diagnostics: readonly SetupDiagnostic[];
  readonly observedAt?: string;
}

function dimension<D extends SetupDimension>(
  name: D,
  owner: RuntimeComponent,
  generation: string,
  observedAt: string,
  result: DimensionResult<D>,
): SetupDimensionObservation<D> {
  return {
    dimension: name,
    status: result.status,
    ...(result.status === "unknown"
      ? {}
      : { evidence: { owner, observedAt: result.observedAt ?? observedAt, generation } }),
    diagnostics: result.diagnostics.slice(0, MAX_SETUP_DIAGNOSTICS),
  };
}

/** Authority custody the #1116 migration converges every Runtime profile key reference to. */
export function authorityCustodyKeyPath(environment: NodeJS.ProcessEnv): string {
  return localComponentPath("authority", "private-key.pem", environment);
}

/** Configuration parts that are still missing or inconsistent; empty means configured. */
export function missingConfiguration(
  evidence: SetupConfigurationEvidence,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const { config, custody, pin, profile } = evidence;
  const missing: string[] = [];
  if (config?.app === undefined) missing.push("app");
  if (
    config?.executor === undefined ||
    custody === undefined ||
    custody.configId !== config.executor.configId ||
    custody.appId !== config.app?.appId ||
    custody.fingerprint !== config.executor.issuerKeyFingerprint ||
    evidence.executorConfigId !== config.executor.configId
  )
    missing.push("executor");
  const authority = config?.authority;
  if (authority === undefined || evidence.authorityDescriptorFingerprint !== authority.publicKeyFingerprint)
    missing.push("authority");
  if (evidence.admission === undefined || evidence.admission.executorId !== evidence.executorConfigId)
    missing.push("admission");
  if (
    pin === undefined ||
    authority === undefined ||
    pin.id !== authority.authorityId ||
    delegatorPublicKeyFingerprint(pin.key) !== authority.publicKeyFingerprint
  )
    missing.push("admission-pin");
  if (
    profile !== undefined &&
    (authority === undefined ||
      profile.authority.authorityId !== authority.authorityId ||
      profile.authority.publicKeyFingerprint !== authority.publicKeyFingerprint ||
      profile.authority.privateKeyPath !== authorityCustodyKeyPath(environment))
  )
    missing.push("runtime-profile");
  return missing;
}

function configurationStatus(
  evidence: SetupConfigurationEvidence,
  environment: NodeJS.ProcessEnv,
): DimensionResult<"configuration"> {
  if (evidence.unreadable.length > 0)
    return {
      status: "unknown",
      diagnostics: [
        diagnostic("SETUP_CONFIGURATION_UNREADABLE", `Unreadable setup evidence: ${evidence.unreadable.join(", ")}.`),
      ],
    };
  if (evidence.config === undefined && evidence.custody === undefined)
    return { status: "unconfigured", diagnostics: [] };
  const missing = missingConfiguration(evidence, environment);
  if (missing.length === 0) return { status: "configured", diagnostics: [] };
  return {
    status: "partial",
    diagnostics: [diagnostic("SETUP_CONFIGURATION_INCOMPLETE", `Missing or inconsistent: ${missing.join(", ")}.`)],
  };
}

function providerBindingStatus(evidence: SetupConfigurationEvidence): DimensionResult<"provider-binding"> {
  if (evidence.unreadable.length > 0) return { status: "unknown", diagnostics: [] };
  const app = evidence.config?.app;
  const custody = evidence.custody;
  if (app === undefined || custody === undefined) return { status: "unbound", diagnostics: [] };
  const profile = evidence.profile;
  if (
    custody.appId !== app.appId ||
    (profile !== undefined &&
      (profile.app.appId !== app.appId ||
        (app.installationId !== undefined && profile.app.installationId !== app.installationId)))
  )
    return {
      status: "mismatched",
      diagnostics: [diagnostic("SETUP_PROVIDER_BINDING_MISMATCH", "Recorded App binding differs from owner state.")],
    };
  if (app.installationId !== undefined && custody.providerVerified) return { status: "bound", diagnostics: [] };
  return {
    status: "unbound",
    diagnostics:
      app.installationId === undefined
        ? []
        : [diagnostic("SETUP_ISSUER_KEY_UNVERIFIED", "The Issuer key is not verified for the App installation.")],
  };
}

function sameCeiling(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

/** Exact immutable trust: same ID, key, notBefore, TTL and capability ceiling, and active. */
export function sameAdoptedTrust(canonical: Delegator, adopted: Delegator): boolean {
  return (
    canonical.id === adopted.id &&
    canonical.status === "active" &&
    delegatorPublicKeyFingerprint(canonical.key) === delegatorPublicKeyFingerprint(adopted.key) &&
    canonical.notBefore === adopted.notBefore &&
    canonical.maxSessionTtlSeconds === adopted.maxSessionTtlSeconds &&
    sameCeiling(canonical.capabilityCeiling, adopted.capabilityCeiling)
  );
}

export type TrustComparison = "trusted" | "absent" | "conflict";

/** Compare protected-ref records with the adopted Authority without any implicit trust change. */
export function compareCanonicalTrust(records: readonly Delegator[], adopted: Delegator): TrustComparison {
  const fingerprint = delegatorPublicKeyFingerprint(adopted.key);
  const related = records.filter(
    (record) => record.id === adopted.id || delegatorPublicKeyFingerprint(record.key) === fingerprint,
  );
  if (related.length === 0) return "absent";
  return related.length === 1 && sameAdoptedTrust(related[0]!, adopted) ? "trusted" : "conflict";
}

/** Provider context of the recorded App; undefined until the App is configured. */
export function providerContext(evidence: SetupConfigurationEvidence): SetupProviderContext | undefined {
  const app = evidence.config?.app;
  if (app === undefined) return undefined;
  const clientId = app.clientId ?? evidence.profile?.app.clientId;
  return { repository: evidence.repository, appId: app.appId, ...(clientId === undefined ? {} : { clientId }) };
}

async function repositoryTrustStatus(
  evidence: SetupConfigurationEvidence,
  provider: SetupProviderPort | undefined,
): Promise<DimensionResult<"repository-trust">> {
  const authority = evidence.config?.authority;
  const pin = evidence.pin;
  const context = providerContext(evidence);
  if (
    authority === undefined ||
    pin === undefined ||
    context === undefined ||
    pin.id !== authority.authorityId ||
    delegatorPublicKeyFingerprint(pin.key) !== authority.publicKeyFingerprint
  )
    return {
      status: "unknown",
      diagnostics: [diagnostic("SETUP_TRUST_AUTHORITY_UNCONFIGURED", "No adopted Runtime Authority is configured.")],
    };
  if (provider === undefined)
    return {
      status: "unknown",
      diagnostics: [diagnostic("SETUP_TRUST_UNAVAILABLE", "Protected-ref trust cannot be read.")],
    };
  let records: readonly Delegator[];
  try {
    records = await provider.readCanonicalAuthorities(context);
  } catch (error: unknown) {
    return {
      status: "unknown",
      diagnostics: [
        error instanceof SetupProviderError && error.stage === "authorization"
          ? diagnostic("SETUP_APP_USER_AUTHORIZATION_REQUIRED", "App-user authorization is required to read trust.")
          : diagnostic("SETUP_TRUST_UNAVAILABLE", "Protected-ref trust could not be read."),
      ],
    };
  }
  const comparison = compareCanonicalTrust(records, pin);
  if (comparison === "trusted") return { status: "trusted", diagnostics: [] };
  if (comparison === "conflict")
    return {
      status: "unknown",
      diagnostics: [
        diagnostic(
          "SETUP_TRUST_CONFLICT",
          "Protected-ref trust differs from the adopted Runtime Authority; an explicit trust change is required.",
        ),
      ],
    };
  const publication = evidence.config?.publication;
  if (publication !== undefined && publication.authorityId === authority.authorityId)
    return {
      status: "pending-human-trust",
      diagnostics: [
        diagnostic(
          "SETUP_TRUST_PUBLICATION_PENDING",
          `Trust publication #${publication.number} awaits human review and merge.`,
        ),
      ],
    };
  return { status: "untrusted", diagnostics: [] };
}

export interface SetupObservationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly provider?: SetupProviderPort;
  readonly lifecycle?: RuntimeLifecyclePort;
  readonly sessionReadiness?: SessionReadinessPort;
  readonly now?: () => Date;
}

const VALID_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

async function healthStatus(
  lifecycle: RuntimeLifecyclePort | undefined,
  generation: SetupGeneration,
): Promise<DimensionResult<"health">> {
  if (lifecycle === undefined)
    return {
      status: "unknown",
      diagnostics: [
        diagnostic("SETUP_RUNTIME_LIFECYCLE_UNAVAILABLE", "No Runtime lifecycle owner is available to report health."),
      ],
    };
  try {
    const evidence = await lifecycle.observe(generation);
    if (
      evidence.generation !== generation.configuration ||
      !["not-running", "unhealthy", "healthy"].includes(evidence.status) ||
      !VALID_TIMESTAMP.test(evidence.observedAt)
    )
      throw new Error("foreign health evidence");
    return { status: evidence.status, observedAt: evidence.observedAt, diagnostics: evidence.diagnostics };
  } catch {
    return {
      status: "unknown",
      diagnostics: [diagnostic("SETUP_RUNTIME_HEALTH_UNAVAILABLE", "Runtime health could not be observed.")],
    };
  }
}

async function sessionReadinessStatus(
  port: SessionReadinessPort | undefined,
  evidence: SetupConfigurationEvidence,
  generation: SetupGeneration,
): Promise<DimensionResult<"session-readiness">> {
  const admission = evidence.admission;
  if (port === undefined || admission === undefined)
    return {
      status: "unknown",
      diagnostics: [diagnostic("SETUP_SESSION_READINESS_UNAVAILABLE", "Admission readiness cannot be observed.")],
    };
  try {
    const observed = await port.observe(generation, admission.id);
    if (!["not-ready", "ready"].includes(observed.status) || !VALID_TIMESTAMP.test(observed.observedAt))
      throw new Error("invalid readiness");
    return { status: observed.status, observedAt: observed.observedAt, diagnostics: observed.diagnostics };
  } catch {
    return {
      status: "unknown",
      diagnostics: [diagnostic("SETUP_SESSION_READINESS_UNAVAILABLE", "Admission readiness could not be observed.")],
    };
  }
}

/** One observation over actual owner evidence, all dimensions bound to the same generation. */
export async function observeSetup(
  repository: RepositoryIdentity,
  options: SetupObservationOptions = {},
): Promise<SetupObservation> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const evidence = await readSetupConfigurationEvidence(repository, environment);
  const generation: SetupGeneration = { repository, configuration: evidence.generation };
  const [trust, health, readiness] = await Promise.all([
    repositoryTrustStatus(evidence, options.provider),
    healthStatus(options.lifecycle, generation),
    sessionReadinessStatus(options.sessionReadiness, evidence, generation),
  ]);
  const observedAt = now().toISOString();
  const id = evidence.generation;
  return validateSetupObservation({
    version: SETUP_CONTRACT_VERSION,
    generation,
    observedAt,
    configuration: dimension(
      "configuration",
      "composition",
      id,
      observedAt,
      configurationStatus(evidence, environment),
    ),
    providerBinding: dimension("provider-binding", "executor", id, observedAt, providerBindingStatus(evidence)),
    repositoryTrust: dimension("repository-trust", "authority", id, observedAt, trust),
    health: dimension("health", "composition", id, observedAt, health),
    sessionReadiness: dimension("session-readiness", "admission", id, observedAt, readiness),
  });
}

export function createSetupObservationPort(options: SetupObservationOptions = {}): SetupObservationPort {
  return Object.freeze({ observe: (repository: RepositoryIdentity) => observeSetup(repository, options) });
}
