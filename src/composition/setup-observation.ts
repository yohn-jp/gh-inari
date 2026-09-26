/**
 * Real Setup observation composition (#1120).
 *
 * Projects the five Setup dimensions from actual owner evidence, each kept
 * distinct and bound to one configuration generation:
 *
 * - configuration: the canonical setup record plus the repository's
 *   App-scoped Executor custody, Executor, Authority-ID and Admission
 *   configuration and the Runtime profile migration state, read without
 *   mutation (#1201);
 * - provider-binding: the recorded App installation of the repository and the
 *   Executor's own binding of this repository ID to that App installation and
 *   exact verified credential generation;
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
import path from "node:path";
import { delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import {
  canonicalDelegatorJson,
  isDelegatorActive,
  validateDelegator,
  type Delegator,
} from "../agent-authority/delegator.js";
import { DelegatorTrustError, loadDelegatorTrust } from "../agent-authority/delegator-trust.js";
import { issuerKeyReference, localExecutorAppId } from "../executor/issuer-input.js";
import { createLocalExecutorObservationPort } from "../executor/observation.js";
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
  validateLocalCliConfig,
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
  MAX_SETUP_TEXT_LENGTH,
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
  type ExecutorObservationPort,
  validateRuntimeFailure,
} from "../runtime-contracts/index.js";
import {
  executorBindingFor,
  executorCredentialFor,
  executorCustodyFromObservation,
  readAuthorityReference,
  readExecutorObservation,
  type ExecutorBindingProjection,
  type ExecutorCredentialProjection,
  type ExecutorCustodyEvidence,
} from "./repository-component-binding.js";
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

/** The Admission and pinned Authority identity the observed configuration generation expects. */
export interface SessionReadinessExpectation {
  readonly admissionId: string;
  readonly authority: { readonly id: string; readonly publicKeyFingerprint: string };
}

export interface SessionReadinessPort {
  observe(generation: SetupGeneration, expected: SessionReadinessExpectation): Promise<SessionReadinessEvidence>;
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
 * Admission-owned, repository-bound readiness (#1182): the announced local
 * Admission instance of the configured identity evaluates the repository of
 * the observed generation with the same current Executor binding and
 * protected-ref trust evidence Session registration requires, for the
 * Authority this generation pins. Process health alone is never readiness. No
 * announcement means not running (not ready); an unreachable, foreign or
 * malformed report is unknown.
 */
export function createAdmissionSessionReadiness(options: AdmissionSessionReadinessOptions = {}): SessionReadinessPort {
  const environment = options.environment ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async observe(
      generation: SetupGeneration,
      expected: SessionReadinessExpectation,
    ): Promise<SessionReadinessEvidence> {
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
      if (announcement.component !== "admission" || announcement.id !== expected.admissionId)
        throw new Error("Announced Admission identity does not match setup.");
      const url = new URL("/v1/readiness", announcement.endpoint);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Admission is not loopback.");
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          repository: { id: generation.repository.repositoryId, name: generation.repository.nameWithOwner },
          authority: expected.authority,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (
        response.status !== 200 ||
        body.ok !== true ||
        body.component !== "admission" ||
        body.admissionId !== expected.admissionId ||
        (body.readiness !== "ready" && body.readiness !== "not-ready")
      )
        throw new Error("Admission readiness is unavailable.");
      if (body.readiness === "ready") return { status: "ready", observedAt: now().toISOString(), diagnostics: [] };
      const failure = validateRuntimeFailure(body.failure);
      return {
        status: "not-ready",
        observedAt: now().toISOString(),
        diagnostics: [
          failure === undefined
            ? diagnostic("SETUP_SESSION_NOT_READY", "Admission reports the repository is not ready for Sessions.")
            : diagnostic(failure.reason, `${failure.message} (stage: ${failure.stage})`),
        ],
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
  /** All public Executor custody evidence (App-scoped canonical, legacy single-App compatibility). */
  readonly executorCustody?: ExecutorCustodyEvidence;
  /** The repository's App credential: the recorded App, else the App bound to this repository ID. */
  readonly custody?: ExecutorCredentialProjection;
  /** The Executor's binding of this repository ID; never selected by name. */
  readonly binding?: ExecutorBindingProjection;
  /** Public fingerprint of the Authority identity the repository references (Authority-ID custody first). */
  readonly authorityFingerprint?: string;
  readonly admission?: { readonly id: string; readonly executorId: string };
  /** Admission instance the local CLI routes Session requests to. */
  readonly cliAdmissionRouteId?: string;
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

/**
 * The repository's App credential: the recorded App; else the App the
 * Executor bound this repository ID to; else the only credential the Executor
 * holds (single-App setup before an App is recorded).
 */
function selectCustody(
  custody: ExecutorCustodyEvidence | undefined,
  config: SetupConfigRecord | undefined,
  binding: ExecutorBindingProjection | undefined,
): ExecutorCredentialProjection | undefined {
  const appId = config?.app?.appId ?? binding?.appId;
  if (appId !== undefined) return executorCredentialFor(custody, appId);
  return custody?.credentials.length === 1 ? custody.credentials[0] : undefined;
}

/** Read every owner's configuration evidence without mutation and derive the configuration generation. */
export async function readSetupConfigurationEvidence(
  repository: RepositoryIdentity,
  environment: NodeJS.ProcessEnv,
  executorPort: ExecutorObservationPort = createLocalExecutorObservationPort({ environment }),
): Promise<SetupConfigurationEvidence> {
  const config = read(() => new SetupConfigStore({ environment }).read(repository));
  // Executor identity, App custody and repository bindings come only from the Executor owner port (#1223).
  const executor = await readExecutorObservation(
    executorPort,
    config.state === "present" && config.value.executor !== undefined,
  );
  const observation = executor.state === "present" ? executor.observation : undefined;
  const custody: Read<ExecutorCustodyEvidence> =
    executor.state === "unreadable"
      ? { state: "unreadable" }
      : observation === undefined
        ? { state: "absent" }
        : (() => {
            const value = executorCustodyFromObservation(observation);
            return value === undefined ? { state: "absent" } : { state: "present", value };
          })();
  const recordedAuthority = config.state === "present" ? config.value.authority : undefined;
  const authority = read(() => readAuthorityReference(recordedAuthority, environment));
  const admission = read(() =>
    readExistingLocalJson("admission", "config.json", validateLocalAdmissionConfig, environment),
  );
  const pin = read(() => readExistingLocalJson("admission", "runtime-authority.json", pinValidator, environment));
  const cli = read(() => readExistingLocalJson("cli", "config.json", validateLocalCliConfig, environment));
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
      ["executor", executor],
      ["authority", authority],
      ["admission/config.json", admission],
      ["admission/runtime-authority.json", pin],
      ["cli/config.json", cli],
      ["runtime-profile", profile],
    ] as const
  )
    .filter(([, item]) => item.state === "unreadable")
    .map(([subject]) => subject);
  const value = <T>(item: Read<T>): T | undefined => (item.state === "present" ? item.value : undefined);
  const binding = executorBindingFor(value(custody), repository);
  const selected = selectCustody(value(custody), value(config), binding);
  const evidence = {
    repository,
    ...(value(config) === undefined ? {} : { config: value(config) }),
    ...(observation === undefined ? {} : { executorConfigId: observation.executorId }),
    ...(value(custody) === undefined ? {} : { executorCustody: value(custody) }),
    ...(selected === undefined ? {} : { custody: selected }),
    ...(binding === undefined ? {} : { binding }),
    ...(value(authority) === undefined ? {} : { authorityFingerprint: value(authority)!.publicKeyFingerprint }),
    ...(value(admission) === undefined
      ? {}
      : { admission: { id: value(admission)!.id, executorId: value(admission)!.executor.id } }),
    ...(value(pin) === undefined ? {} : { pin: value(pin) }),
    ...(value(cli)?.admission === undefined ? {} : { cliAdmissionRouteId: value(cli)!.admission!.id }),
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
    authority: evidence.authorityFingerprint,
    admission: evidence.admission,
    cliAdmissionRouteId: evidence.cliAdmissionRouteId,
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
  if (authority === undefined || evidence.authorityFingerprint !== authority.publicKeyFingerprint)
    missing.push("authority");
  if (evidence.admission === undefined || evidence.admission.executorId !== evidence.executorConfigId)
    missing.push("admission");
  // The CLI must route Sessions to exactly this Admission, or setup is not usable.
  if (evidence.admission === undefined || evidence.cliAdmissionRouteId !== evidence.admission.id)
    missing.push("cli-route");
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

/**
 * #1178: an operator shell may still carry the legacy explicit Issuer
 * reference. It is never adopted implicitly; the diagnostic names the explicit,
 * non-destructive enrollment into managed Executor custody.
 */
function externalIssuerReferenceDiagnostics(environment: NodeJS.ProcessEnv): readonly SetupDiagnostic[] {
  const reference = issuerKeyReference(environment);
  const file = reference.INARI_GITHUB_APP_PRIVATE_KEY_FILE ?? reference.GITHUB_APP_PRIVATE_KEY_FILE;
  if (file === undefined || file.trim().length === 0) return [];
  const appId = localExecutorAppId(environment) ?? "<issuer-app-id>";
  return [
    diagnostic(
      "SETUP_EXECUTOR_EXTERNAL_KEY_REFERENCE",
      `This shell exports an Issuer key reference that is not in managed Executor custody. Enroll it explicitly: inari setup next --yes --input app-id=${appId} --enrollment-file issuer-key=${file.trim()}`.slice(
        0,
        MAX_SETUP_TEXT_LENGTH,
      ),
    ),
  ];
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
  if (evidence.config === undefined && evidence.executorCustody === undefined)
    return { status: "unconfigured", diagnostics: externalIssuerReferenceDiagnostics(environment) };
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
  // #1182/#1199: the Executor's own binding of this repository ID, to its App's exact verified
  // generation, is the owner evidence execution uses.
  const bound = evidence.binding;
  if (
    custody.appId !== app.appId ||
    (bound !== undefined && bound.appId !== app.appId) ||
    (bound !== undefined && app.installationId !== undefined && bound.installationId !== app.installationId) ||
    (bound !== undefined && profile !== undefined && profile.app.installationId !== bound.installationId) ||
    (profile !== undefined &&
      (profile.app.appId !== app.appId ||
        (app.installationId !== undefined && profile.app.installationId !== app.installationId)))
  )
    return {
      status: "mismatched",
      diagnostics: [diagnostic("SETUP_PROVIDER_BINDING_MISMATCH", "Recorded App binding differs from owner state.")],
    };
  if (app.installationId !== undefined && bound?.installationId === app.installationId && bound.status === "bound")
    return { status: "bound", diagnostics: [] };
  return {
    status: "unbound",
    diagnostics:
      app.installationId === undefined
        ? []
        : [
            diagnostic(
              "SETUP_ISSUER_KEY_UNVERIFIED",
              "The Executor has not verified its Issuer key for this repository's App installation.",
            ),
          ],
  };
}

export type TrustComparison = "trusted" | "absent" | "conflict" | "inactive";

/**
 * Compare protected-ref records with the adopted Authority without any
 * implicit trust change (#1182). Trusted means exactly one related record,
 * byte-identical in the canonical Delegator serialization (ID, key,
 * notBefore, notAfter, status, TTL and ceiling) and active at `now` under the
 * canonical Delegator validity rule the Admission/Executor resolution uses.
 */
export function compareCanonicalTrust(
  records: readonly Delegator[],
  adopted: Delegator,
  now: Date = new Date(),
): TrustComparison {
  const fingerprint = delegatorPublicKeyFingerprint(adopted.key);
  const related = records.filter(
    (record) => record.id === adopted.id || delegatorPublicKeyFingerprint(record.key) === fingerprint,
  );
  if (related.length === 0) return "absent";
  if (related.length !== 1 || canonicalDelegatorJson(related[0]!) !== canonicalDelegatorJson(adopted))
    return "conflict";
  return isDelegatorActive(related[0]!, now) ? "trusted" : "inactive";
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
  now: Date,
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
  const comparison = compareCanonicalTrust(records, pin, now);
  if (comparison === "trusted") return { status: "trusted", diagnostics: [] };
  if (comparison === "inactive")
    return {
      status: "unknown",
      diagnostics: [
        diagnostic(
          "SETUP_TRUST_INACTIVE",
          "The protected-ref Runtime Authority matches but is inactive or outside its validity window.",
        ),
      ],
    };
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
  /**
   * Executor owner observation (#1223): the co-located local adapter by
   * default, or an explicitly configured observation client.
   */
  readonly executor?: ExecutorObservationPort;
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
  const pin = evidence.pin;
  if (port === undefined || admission === undefined || pin === undefined)
    return {
      status: "unknown",
      diagnostics: [diagnostic("SETUP_SESSION_READINESS_UNAVAILABLE", "Admission readiness cannot be observed.")],
    };
  try {
    const observed = await port.observe(generation, {
      admissionId: admission.id,
      authority: { id: pin.id, publicKeyFingerprint: delegatorPublicKeyFingerprint(pin.key) },
    });
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
  const executor = options.executor ?? createLocalExecutorObservationPort({ environment });
  const evidence = await readSetupConfigurationEvidence(repository, environment, executor);
  const generation: SetupGeneration = { repository, configuration: evidence.generation };
  const [trust, health, observedReadiness] = await Promise.all([
    repositoryTrustStatus(evidence, options.provider, now()),
    healthStatus(options.lifecycle, generation),
    sessionReadinessStatus(options.sessionReadiness, evidence, generation),
  ]);
  // #1182: Admission readiness is evaluated against live owner state, so it binds to
  // this generation only if the configuration is unchanged when observation ends. A
  // readiness report that raced a setup change is never adopted as `ready` evidence
  // for the generation observed at the start.
  const readiness: DimensionResult<"session-readiness"> =
    observedReadiness.status === "ready" &&
    (await readSetupConfigurationEvidence(repository, environment, executor)).generation !== evidence.generation
      ? {
          status: "unknown",
          diagnostics: [
            diagnostic(
              "SETUP_SESSION_READINESS_STALE",
              "Setup configuration changed while Admission readiness was observed; observe again.",
            ),
          ],
        }
      : observedReadiness;
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
