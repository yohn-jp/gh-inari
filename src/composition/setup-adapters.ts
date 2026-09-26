/**
 * Real Setup owner adapters (#1120).
 *
 * One `SetupActionPort` dispatches every canonical Setup action to the owner
 * that already implements it, and one Executor `SecretEnrollmentPort`
 * streams the Issuer key to Executor custody:
 *
 * - `executor.configure`: enrollment reaches the #1114 Executor enrollment
 *   owner with the action's validated App ID; the action then records only
 *   the public App and Executor custody references.
 * - `composition.complete-configuration`: #1115 Authority adoption (existing
 *   record, key, notBefore, TTL and ceiling kept; never generated or rotated)
 *   plus the #1116 migration preview/confirm/apply and Admission setup.
 * - `executor.bind-repository`: App-user bootstrap installation scope, then
 *   the Executor verifies its stored key against that installation.
 * - `authority.publish-trust`: the existing App-user publication capability
 *   opens (or finds) the trust pull request; it never approves or merges.
 * - `authority.recheck-trust`: protected-ref records must match the adopted
 *   Authority exactly.
 * - `composition.start-runtime` / `composition.restart-runtime`: dispatched to
 *   the injected Runtime lifecycle owner (#1121); absent means failed.
 *
 * Every action first binds the request to the current repository and
 * configuration generation. Failures before an effect are `failed`; an effect
 * that may have applied without being observed is `unknown`.
 */
import path from "node:path";
import { delegatorPublicKeyFingerprint, loadDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { loadLocalDelegatorRepository } from "../agent-authority/delegator-lifecycle.js";
import type { Delegator } from "../agent-authority/delegator.js";
import { LocalAdmissionError, setupLocalAdmission } from "../admission/setup.js";
import { setupOperationId, setupOperationKind } from "../application/setup/index.js";
import {
  applyLocalConfigMigration,
  previewLocalConfigMigration,
  type LocalConfigMigrationBlocker,
} from "../authority/local-migration.js";
import { SetupTrustSelectionError, selectSetupAuthority } from "../authority/setup-trust.js";
import { ExecutorEnrollmentOwner, type ExecutorEnrollmentOwnerOptions } from "../executor/enrollment/owner.js";
import { createLocalExecutorObservationPort } from "../executor/observation.js";
import { LocalExecutorError, ensureLocalExecutorConfiguration } from "../executor/setup.js";
import { bindLocalCliAdmissionRoute, ensureLocalCliTopology } from "../local-control/config.js";
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  MAX_SETUP_DIAGNOSTICS,
  MAX_SETUP_TEXT_LENGTH,
  SETUP_CONTRACT_VERSION,
  sameSetupGeneration,
  validateSecretEnrollmentRequest,
  validateSetupActionRequest,
  validateSetupActionResult,
  type SecretEnrollmentPort,
  type SecretEnrollmentReceipt,
  type SecretEnrollmentRequest,
  type SetupActionOutcome,
  type SetupActionPort,
  type SetupActionRequest,
  type SetupActionResult,
  type SetupDiagnostic,
  type SetupJournalPort,
  type SetupObservationPort,
  type ExecutorObservationPort,
} from "../runtime-contracts/index.js";
import { executorCredentialFor, type ExecutorCredentialProjection } from "./repository-component-binding.js";
import { SetupConfigStore, SetupConfigStoreError, type SetupConfigPatch } from "./setup-config-store.js";
import { SetupJournalStore } from "./setup-journal-store.js";
import {
  SetupProviderError,
  compareCanonicalTrust,
  createAdmissionSessionReadiness,
  createAppUserSetupProvider,
  createSetupObservationPort,
  missingConfiguration,
  providerContext,
  readSetupConfigurationEvidence,
  type RuntimeLifecyclePort,
  type RuntimeLifecycleResult,
  type SessionReadinessPort,
  type SetupConfigurationEvidence,
  type SetupProviderPort,
} from "./setup-observation.js";

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const DEFAULT_SESSION_TTL_SECONDS = 3_600;

export interface SetupAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** Repository working tree holding local Runtime Authority records; defaults to the process cwd. */
  readonly root?: string;
  /** App-user bootstrap provider; defaults to the real App-user broker. */
  readonly provider?: SetupProviderPort;
  /** Real Runtime lifecycle owner, supplied by #1121. Absent means start/restart fail truthfully. */
  readonly lifecycle?: RuntimeLifecyclePort;
  /** Admission-owned readiness; defaults to the announced local Admission's own report. */
  readonly sessionReadiness?: SessionReadinessPort;
  /** Shared setup record store; injectable so persistence failures can be exercised. */
  readonly configStore?: SetupConfigStore;
  /**
   * Executor owner observation (#1223): the co-located local adapter by
   * default, or an explicitly configured observation client.
   */
  readonly executorObservation?: ExecutorObservationPort;
  /** Executor owner verification seams (tests); production uses the installation broker. */
  readonly executorVerification?: Pick<ExecutorEnrollmentOwnerOptions, "verifyProvider" | "verifyInstallation">;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export interface LocalSetupPorts {
  readonly observation: SetupObservationPort;
  readonly action: SetupActionPort;
  readonly journal: SetupJournalPort;
  readonly enrollment: readonly SecretEnrollmentPort[];
}

function diagnostic(code: string, message: string): SetupDiagnostic {
  return Object.freeze({ code, message: message.slice(0, MAX_SETUP_TEXT_LENGTH) });
}

function outcome(
  request: SetupActionRequest,
  value: SetupActionOutcome,
  diagnostics: readonly SetupDiagnostic[] = [],
): SetupActionResult {
  return validateSetupActionResult({
    version: SETUP_CONTRACT_VERSION,
    actionId: request.actionId,
    generation: request.generation,
    outcome: value,
    diagnostics: diagnostics.slice(0, MAX_SETUP_DIAGNOSTICS),
  });
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

/** Maps a shared-record write failure: rejected before the write is `failed`, an unverified write is `unknown`. */
function persistFailure(request: SetupActionRequest, error: unknown, code: string, message: string): SetupActionResult {
  const preWrite =
    error instanceof SetupConfigStoreError &&
    (error.code === "SETUP_CONFIG_STALE" ||
      error.code === "SETUP_CONFIG_CONFLICT" ||
      error.code === "SETUP_CONFIG_INVALID");
  return outcome(request, preWrite ? "failed" : "unknown", [
    diagnostic(code, message),
    diagnostic(
      error instanceof SetupConfigStoreError ? error.code : "SETUP_CONFIG_STORAGE_FAILED",
      preWrite ? "The shared setup record was not changed." : "The shared setup record write was not confirmed.",
    ),
  ]);
}

function providerDiagnostic(error: unknown): SetupDiagnostic {
  const stage = error instanceof SetupProviderError ? error.stage : "unavailable";
  if (stage === "authorization")
    return diagnostic(
      "SETUP_APP_USER_AUTHORIZATION_REQUIRED",
      "App-user authorization is required; run `inari setup --endpoint <endpoint-url>` (Device Flow) for this repository, then retry.",
    );
  if (stage === "installation")
    return diagnostic("SETUP_APP_INSTALLATION_REQUIRED", "The Inari App is not installed for this repository.");
  return diagnostic("SETUP_PROVIDER_UNAVAILABLE", "The provider operation could not be completed.");
}

function blockerDiagnostics(blockers: readonly LocalConfigMigrationBlocker[]): SetupDiagnostic[] {
  return blockers.map((blocker) =>
    diagnostic(`SETUP_MIGRATION_${blocker.code}`, `Local configuration migration is blocked at ${blocker.subject}.`),
  );
}

// ---------------------------------------------------------------------------
// Executor enrollment

function receipt(
  request: SecretEnrollmentRequest,
  diagnostics: readonly SetupDiagnostic[],
  publicFingerprint?: string,
): SecretEnrollmentReceipt {
  return Object.freeze({
    version: SETUP_CONTRACT_VERSION,
    kind: request.kind,
    operationId: request.operationId,
    repository: request.repository,
    outcome: publicFingerprint === undefined ? ("rejected" as const) : ("enrolled" as const),
    ...(publicFingerprint === undefined ? {} : { publicFingerprint }),
    diagnostics: diagnostics.slice(0, MAX_SETUP_DIAGNOSTICS),
  });
}

/** Owner-observed custody state of one App through the Executor observation port (#1223). */
async function custodyState(executor: ExecutorObservationPort, appId: string): Promise<string> {
  try {
    const app = (await executor.observe()).apps.find((item) => item.appId === appId);
    return app === undefined ? "absent" : `${app.source}:${app.generation}:${app.fingerprint}`;
  } catch {
    return "unreadable";
  }
}

function executorPort(options: SetupAdapterOptions, environment: NodeJS.ProcessEnv): ExecutorObservationPort {
  return options.executorObservation ?? createLocalExecutorObservationPort({ environment });
}

/**
 * Executor enrollment for `executor.configure`. The App ID comes only from
 * the same action's validated secret-free inputs; the key bytes go straight
 * to the Executor enrollment owner, which alone parses and stores them.
 */
export function createExecutorSetupEnrollmentPort(options: SetupAdapterOptions = {}): SecretEnrollmentPort {
  const environment = options.environment ?? process.env;
  const executor = executorPort(options, environment);
  return Object.freeze({
    owner: "executor" as const,
    kinds: Object.freeze(["executor-issuer-private-key"] as const),
    async enroll(
      untrusted: SecretEnrollmentRequest,
      secret: AsyncIterable<Uint8Array>,
      signal?: AbortSignal,
    ): Promise<SecretEnrollmentReceipt> {
      const request = validateSecretEnrollmentRequest(untrusted);
      if (setupOperationKind(request.operationId) !== "executor.configure")
        return receipt(request, [
          diagnostic("SETUP_ENROLLMENT_ACTION_INVALID", "Issuer key enrollment belongs to executor.configure."),
        ]);
      const appId = request.inputs?.["app-id"];
      if (typeof appId !== "string" || !DECIMAL_ID.test(appId))
        return receipt(request, [
          diagnostic("SETUP_APP_ID_INVALID", "A numeric Issuer App ID from the same action is required."),
        ]);
      const evidence = await readSetupConfigurationEvidence(request.repository, environment, executor);
      if (
        request.operationId !==
        setupOperationId("executor.configure", { repository: request.repository, configuration: evidence.generation })
      )
        return receipt(request, [
          diagnostic("SETUP_GENERATION_STALE", "The configuration generation changed; refresh the state."),
        ]);
      if (evidence.config?.app !== undefined && evidence.config.app.appId !== appId)
        return receipt(request, [
          diagnostic("SETUP_APP_ID_CONFLICT", "A different App ID is already recorded for this repository."),
        ]);
      if (signal?.aborted) throw new Error("Enrollment was cancelled before any effect.");
      let configId: string;
      try {
        configId = (await ensureLocalExecutorConfiguration(environment)).config.id;
      } catch (error: unknown) {
        if (!(error instanceof LocalExecutorError)) throw error;
        return receipt(request, [diagnostic(error.code, "The Executor configuration could not be prepared.")]);
      }
      const owner = new ExecutorEnrollmentOwner({
        configId,
        appId,
        environment,
        ...(options.executorVerification?.verifyProvider === undefined
          ? {}
          : { verifyProvider: options.executorVerification.verifyProvider }),
      });
      let capability;
      try {
        capability = owner.issue();
      } catch {
        return receipt(request, [
          diagnostic(
            "SETUP_EXECUTOR_CUSTODY_CONFLICT",
            "Executor custody is bound to another configuration or App; an explicit key replacement is required.",
          ),
        ]);
      }
      const before = await custodyState(executor, appId);
      try {
        const enrolled = await owner.enrollStream(capability, request, secret, signal);
        return receipt(request, [], enrolled.publicFingerprint);
      } catch (error: unknown) {
        // Reconcile from fresh owner evidence: unchanged custody proves no effect.
        if (before !== "unreadable" && (await custodyState(executor, appId)) === before)
          return receipt(request, [
            diagnostic("SETUP_ENROLLMENT_REJECTED", "The Executor rejected the key; custody is unchanged."),
          ]);
        throw error;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Actions

interface ActionContext {
  readonly request: SetupActionRequest;
  readonly repository: RepositoryIdentity;
  readonly evidence: SetupConfigurationEvidence;
}

/** The Executor's current credential of exactly `appId`, held by the configured Executor (#1199/#1201). */
function appCustody(evidence: SetupConfigurationEvidence, appId: string): ExecutorCredentialProjection | undefined {
  const credential = executorCredentialFor(evidence.executorCustody, appId);
  return credential !== undefined && credential.configId === evidence.executorConfigId ? credential : undefined;
}

export function createSetupActionPort(options: SetupAdapterOptions = {}): SetupActionPort {
  const environment = options.environment ?? process.env;
  const executor = executorPort(options, environment);
  const store = options.configStore ?? new SetupConfigStore({ environment });
  const provider =
    options.provider ?? createAppUserSetupProvider({ environment, fetch: options.fetch, now: options.now });
  const root = path.resolve(options.root ?? process.cwd());

  function update(context: ActionContext, patch: SetupConfigPatch) {
    return store.update(context.repository, context.evidence.config?.revision ?? 0, patch);
  }

  async function configureExecutor({ request, repository, evidence }: ActionContext): Promise<SetupActionResult> {
    const appId = request.inputs["app-id"];
    if (typeof appId !== "string" || !DECIMAL_ID.test(appId))
      return outcome(request, "failed", [diagnostic("SETUP_APP_ID_INVALID", "A numeric Issuer App ID is required.")]);
    const custody = appCustody(evidence, appId);
    if (custody === undefined)
      return outcome(request, "failed", [
        diagnostic("SETUP_EXECUTOR_ENROLLMENT_MISSING", "No Executor-held Issuer key is enrolled for this App ID."),
      ]);
    try {
      update(
        { request, repository, evidence },
        {
          app: { ...evidence.config?.app, appId },
          executor: { configId: custody.configId, issuerKeyFingerprint: custody.fingerprint },
        },
      );
    } catch (error: unknown) {
      return persistFailure(
        request,
        error,
        "SETUP_EXECUTOR_REFERENCE_UNRECORDED",
        "The Executor reference was not recorded.",
      );
    }
    return outcome(request, "succeeded");
  }

  /** #1115 adoption: an existing record only, with canonical trust taking precedence when readable. */
  async function adoptAuthority(evidence: SetupConfigurationEvidence): Promise<Delegator | SetupDiagnostic> {
    if (evidence.pin !== undefined) return evidence.pin;
    const profile = evidence.profile;
    if (profile === undefined)
      return diagnostic(
        "SETUP_AUTHORITY_PREPARATION_REQUIRED",
        "No Runtime Authority exists to adopt. Prepare one with explicit capability intent: `inari setup --endpoint <endpoint-url> --capability change.implement`, then retry.",
      );
    let key;
    let local: readonly Delegator[];
    try {
      key = loadDelegatorKeyPair(profile.authority.privateKeyPath);
      local = loadLocalDelegatorRepository(root).artifacts.map((artifact) => artifact.authority);
    } catch {
      return diagnostic("SETUP_AUTHORITY_UNAVAILABLE", "Existing Runtime Authority material could not be loaded.");
    }
    const context = providerContext(evidence);
    let canonical: readonly Delegator[] | undefined;
    if (context !== undefined) canonical = await provider.readCanonicalAuthorities(context).catch(() => undefined);
    try {
      return selectSetupAuthority({
        repository: profile.repository,
        profile,
        authorityId: profile.authority.authorityId,
        key,
        local,
        ...(canonical === undefined ? {} : { canonical }),
        maxSessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
      });
    } catch (error: unknown) {
      return diagnostic(
        error instanceof SetupTrustSelectionError ? `SETUP_AUTHORITY_${error.code}` : "SETUP_AUTHORITY_UNAVAILABLE",
        "The existing Runtime Authority could not be adopted without an explicit trust change.",
      );
    }
  }

  async function completeConfiguration(context: ActionContext): Promise<SetupActionResult> {
    const { request, repository, evidence } = context;
    const appId = evidence.config?.app?.appId ?? evidence.custody?.appId;
    const custody = appId === undefined ? undefined : appCustody(evidence, appId);
    if (appId === undefined || custody === undefined)
      return outcome(request, "failed", [
        diagnostic("SETUP_EXECUTOR_ENROLLMENT_MISSING", "Configure the Executor Issuer App before completing setup."),
      ]);
    if (evidence.profile !== undefined && evidence.profile.app.appId !== appId)
      return outcome(request, "failed", [
        diagnostic("SETUP_PROVIDER_BINDING_MISMATCH", "The Runtime profile names a different App."),
      ]);
    const adopted = await adoptAuthority(evidence);
    if (!("id" in adopted && "key" in adopted)) return outcome(request, "failed", [adopted as SetupDiagnostic]);
    const fingerprint = delegatorPublicKeyFingerprint(adopted.key);
    const recorded = evidence.config?.authority;
    if (
      recorded !== undefined &&
      (recorded.authorityId !== adopted.id || recorded.publicKeyFingerprint !== fingerprint)
    )
      return outcome(request, "failed", [
        diagnostic("SETUP_AUTHORITY_CONFLICT", "The adopted Runtime Authority differs from the recorded one."),
      ]);

    const effects: SetupDiagnostic[] = [];
    if (evidence.profile !== undefined) {
      const identity = { endpoint: evidence.profile.endpoint, repository: evidence.profile.repository };
      const preview = await previewLocalConfigMigration({ identity, adoptedAuthority: adopted, environment });
      if (preview.status === "blocked")
        return outcome(request, "failed", [
          ...blockerDiagnostics(preview.blockers),
          ...preview.operatorActions.map((action) =>
            diagnostic("SETUP_OPERATOR_ACTION_REQUIRED", `Operator action required: ${action}.`),
          ),
        ]);
      if (preview.status === "ready") {
        let applied;
        try {
          applied = await applyLocalConfigMigration({
            identity,
            adoptedAuthority: adopted,
            environment,
            generation: preview.generation,
            confirm: true,
          });
        } catch {
          return outcome(request, "unknown", [
            diagnostic("SETUP_MIGRATION_UNCONFIRMED", "The local configuration migration outcome was not observed."),
          ]);
        }
        if (applied.status === "recovery-required")
          return outcome(request, "unknown", [
            diagnostic(
              "SETUP_MIGRATION_RECOVERY_REQUIRED",
              `Migration stopped after ${applied.completedSteps.join(", ") || "no step"}; recovery evidence is kept.`,
            ),
          ]);
        if (applied.status !== "migrated")
          return outcome(request, "failed", [
            diagnostic(
              `SETUP_MIGRATION_${applied.status.toUpperCase()}`,
              "The local configuration migration was not applied.",
            ),
            ...blockerDiagnostics(applied.blockers),
          ]);
        effects.push(diagnostic("SETUP_MIGRATION_APPLIED", "Local configuration was migrated to Authority custody."));
      }
    }

    const current = await readSetupConfigurationEvidence(repository, environment, executor);
    if (current.admission === undefined || current.pin === undefined) {
      try {
        setupLocalAdmission(adopted, environment);
      } catch (error: unknown) {
        return outcome(request, error instanceof LocalAdmissionError && effects.length === 0 ? "failed" : "unknown", [
          ...effects,
          diagnostic(
            error instanceof LocalAdmissionError ? error.code : "SETUP_ADMISSION_UNCONFIRMED",
            "Admission could not be configured with the adopted Runtime Authority.",
          ),
        ]);
      }
    }

    // Route the local CLI to the configured Admission, as `admission setup` does.
    const routed = await readSetupConfigurationEvidence(repository, environment, executor);
    if (routed.admission !== undefined && routed.cliAdmissionRouteId !== routed.admission.id) {
      try {
        ensureLocalCliTopology(environment);
        bindLocalCliAdmissionRoute({ id: routed.admission.id }, environment);
      } catch {
        return outcome(request, effects.length === 0 ? "failed" : "unknown", [
          ...effects,
          diagnostic(
            "SETUP_CLI_ROUTE_UNBOUND",
            "The local CLI could not be routed to the configured Admission; its existing route is kept.",
          ),
        ]);
      }
    }

    const clientId = evidence.config?.app?.clientId ?? evidence.profile?.app.clientId;
    try {
      update(context, {
        ...(evidence.profile === undefined ? {} : { endpoint: evidence.profile.endpoint }),
        app: { ...evidence.config?.app, appId, ...(clientId === undefined ? {} : { clientId }) },
        executor: { configId: custody.configId, issuerKeyFingerprint: custody.fingerprint },
        authority: { authorityId: adopted.id, publicKeyFingerprint: fingerprint },
      });
    } catch (error: unknown) {
      return outcome(request, "unknown", [
        ...effects,
        ...persistFailure(
          request,
          error,
          "SETUP_AUTHORITY_REFERENCE_UNRECORDED",
          "Owner configuration changed but the shared record was not updated.",
        ).diagnostics,
      ]);
    }
    const final = await readSetupConfigurationEvidence(repository, environment, executor);
    const missing = missingConfiguration(final, environment);
    if (missing.length > 0)
      return outcome(request, "failed", [
        ...effects,
        diagnostic("SETUP_CONFIGURATION_INCOMPLETE", `Still missing or inconsistent: ${missing.join(", ")}.`),
      ]);
    return outcome(request, "succeeded", effects);
  }

  async function bindRepository({ request, repository, evidence }: ActionContext): Promise<SetupActionResult> {
    const context = providerContext(evidence);
    const custody = context === undefined ? undefined : appCustody(evidence, context.appId);
    if (context === undefined || custody === undefined)
      return outcome(request, "failed", [
        diagnostic("SETUP_EXECUTOR_ENROLLMENT_MISSING", "Configure the Executor Issuer App before binding."),
      ]);
    let scope;
    try {
      scope = await provider.resolveInstallation(context);
    } catch (error: unknown) {
      return outcome(request, "failed", [providerDiagnostic(error)]);
    }
    if (scope.appId !== context.appId || scope.repositoryId !== repository.repositoryId)
      return outcome(request, "failed", [
        diagnostic("SETUP_PROVIDER_BINDING_MISMATCH", "The App installation scope is for another App or repository."),
      ]);
    const recorded = evidence.config?.app?.installationId;
    if (recorded !== undefined && recorded !== scope.installationId)
      return outcome(request, "failed", [
        diagnostic("SETUP_PROVIDER_BINDING_MISMATCH", "A different App installation is already recorded."),
      ]);
    const owner = new ExecutorEnrollmentOwner({
      configId: custody.configId,
      appId: context.appId,
      environment,
      ...(options.executorVerification?.verifyInstallation === undefined
        ? {}
        : { verifyInstallation: options.executorVerification.verifyInstallation }),
    });
    let verified: boolean;
    try {
      verified = await owner.verifyStoredProvider(repository, scope.installationId);
    } catch {
      return outcome(request, "unknown", [
        diagnostic("SETUP_ISSUER_VERIFICATION_UNCONFIRMED", "The Issuer key verification outcome was not observed."),
      ]);
    }
    if (!verified)
      return outcome(request, "failed", [
        diagnostic("SETUP_ISSUER_KEY_UNVERIFIED", "The Issuer key could not act for this App installation."),
      ]);
    try {
      store.update(repository, evidence.config?.revision ?? 0, {
        app: { ...evidence.config?.app, appId: context.appId, installationId: scope.installationId },
      });
    } catch (error: unknown) {
      return persistFailure(request, error, "SETUP_BINDING_UNRECORDED", "The verified installation was not recorded.");
    }
    return outcome(request, "succeeded");
  }

  function adoptedTrust(evidence: SetupConfigurationEvidence): Delegator | undefined {
    const authority = evidence.config?.authority;
    const pin = evidence.pin;
    return authority !== undefined &&
      pin !== undefined &&
      pin.id === authority.authorityId &&
      delegatorPublicKeyFingerprint(pin.key) === authority.publicKeyFingerprint
      ? pin
      : undefined;
  }

  async function publishTrust({ request, repository, evidence }: ActionContext): Promise<SetupActionResult> {
    const authority = adoptedTrust(evidence);
    const context = providerContext(evidence);
    if (authority === undefined || context === undefined)
      return outcome(request, "failed", [
        diagnostic("SETUP_TRUST_AUTHORITY_UNCONFIGURED", "No adopted Runtime Authority is configured."),
      ]);
    let published;
    try {
      published = await provider.publishAuthority(context, authority);
    } catch (error: unknown) {
      const stage = error instanceof SetupProviderError ? error.stage : "uncertain";
      if (stage === "authorization" || stage === "installation")
        return outcome(request, "failed", [providerDiagnostic(error)]);
      return outcome(request, "unknown", [
        diagnostic(
          "SETUP_PUBLICATION_UNCONFIRMED",
          "The trust publication outcome was not observed; do not retry blindly.",
        ),
      ]);
    }
    const pending = diagnostic(
      "SETUP_TRUST_PUBLICATION_PENDING",
      `Trust pull request #${published.pullRequest.number} is open (${published.status}); a human must review and merge it: ${published.pullRequest.url}`,
    );
    if (published.authorityId !== authority.id)
      return outcome(request, "unknown", [
        diagnostic("SETUP_PUBLICATION_MISMATCH", "The publication result names another Runtime Authority."),
      ]);
    try {
      store.update(repository, evidence.config?.revision ?? 0, {
        publication: {
          authorityId: published.authorityId,
          number: published.pullRequest.number,
          url: published.pullRequest.url,
          branch: published.branch,
        },
      });
    } catch {
      // The pull request exists; only its local evidence is missing.
      return outcome(request, "unknown", [
        pending,
        diagnostic("SETUP_PUBLICATION_UNRECORDED", "The opened trust pull request was not recorded locally."),
      ]);
    }
    return outcome(request, "succeeded", [pending]);
  }

  async function recheckTrust({ request, evidence }: ActionContext): Promise<SetupActionResult> {
    const authority = adoptedTrust(evidence);
    const context = providerContext(evidence);
    if (authority === undefined || context === undefined)
      return outcome(request, "failed", [
        diagnostic("SETUP_TRUST_AUTHORITY_UNCONFIGURED", "No adopted Runtime Authority is configured."),
      ]);
    let records;
    try {
      records = await provider.readCanonicalAuthorities(context);
    } catch (error: unknown) {
      return outcome(request, "failed", [providerDiagnostic(error)]);
    }
    const comparison = compareCanonicalTrust(records, authority, options.now?.() ?? new Date());
    if (comparison === "inactive")
      return outcome(request, "failed", [
        diagnostic(
          "SETUP_TRUST_INACTIVE",
          "The protected-ref Runtime Authority matches but is inactive or outside its validity window.",
        ),
      ]);
    if (comparison === "trusted")
      return outcome(request, "succeeded", [
        diagnostic("SETUP_TRUST_CONFIRMED", "Protected-ref trust matches the adopted Runtime Authority."),
      ]);
    if (comparison === "conflict")
      return outcome(request, "failed", [
        diagnostic(
          "SETUP_TRUST_CONFLICT",
          "Protected-ref trust differs from the adopted Runtime Authority; an explicit trust change is required.",
        ),
      ]);
    return outcome(request, "action-required", [
      diagnostic(
        "SETUP_TRUST_PENDING",
        "Trust is not on the protected ref yet; a human must merge the trust pull request.",
      ),
    ]);
  }

  async function lifecycle({ request }: ActionContext, operation: "start" | "restart"): Promise<SetupActionResult> {
    const owner = options.lifecycle;
    if (owner === undefined)
      return outcome(request, "failed", [
        diagnostic(
          "SETUP_RUNTIME_LIFECYCLE_UNAVAILABLE",
          "No Runtime lifecycle owner is available in this process; the Runtime was not started.",
        ),
      ]);
    let result: RuntimeLifecycleResult;
    try {
      result = await owner[operation]({ operationId: request.actionId, generation: request.generation });
    } catch {
      return outcome(request, "unknown", [
        diagnostic("SETUP_RUNTIME_LIFECYCLE_UNCONFIRMED", "The Runtime lifecycle outcome was not observed."),
      ]);
    }
    if (!["succeeded", "failed", "unknown"].includes(result.outcome))
      return outcome(request, "unknown", [
        diagnostic("SETUP_RUNTIME_LIFECYCLE_UNCONFIRMED", "The Runtime lifecycle owner returned no bounded outcome."),
      ]);
    return outcome(request, result.outcome, result.diagnostics);
  }

  const handlers: Readonly<Record<string, (context: ActionContext) => Promise<SetupActionResult>>> = Object.freeze({
    "executor.configure": configureExecutor,
    "composition.complete-configuration": completeConfiguration,
    "executor.bind-repository": bindRepository,
    "authority.publish-trust": publishTrust,
    "authority.recheck-trust": recheckTrust,
    "composition.start-runtime": (context) => lifecycle(context, "start"),
    "composition.restart-runtime": (context) => lifecycle(context, "restart"),
  });

  return Object.freeze({
    async perform(input: SetupActionRequest): Promise<SetupActionResult> {
      const request = validateSetupActionRequest(input);
      const repository = request.generation.repository;
      const kind = setupOperationKind(request.actionId);
      const handler = handlers[kind];
      if (handler === undefined || request.actionId !== setupOperationId(kind, request.generation))
        return outcome(request, "failed", [
          diagnostic("SETUP_ACTION_UNSUPPORTED", "The action is not a canonical Setup action of this generation."),
        ]);
      // Authorization, identity and freshness precede every protected effect.
      const evidence = await readSetupConfigurationEvidence(repository, environment, executor);
      if (
        !sameRepository(evidence.repository, repository) ||
        !sameSetupGeneration({ repository, configuration: evidence.generation }, request.generation)
      )
        return outcome(request, "stale", [
          diagnostic("SETUP_GENERATION_STALE", "The configuration generation changed; refresh the state."),
        ]);
      if (evidence.unreadable.length > 0)
        return outcome(request, "failed", [
          diagnostic("SETUP_CONFIGURATION_UNREADABLE", `Unreadable setup evidence: ${evidence.unreadable.join(", ")}.`),
        ]);
      return handler({ request, repository, evidence });
    },
  });
}

/**
 * The local Setup owner ports for the Setup Application. Runtime lifecycle is
 * whatever the embedding supplies (#1121); nothing here starts a process.
 */
export function createLocalSetupPorts(options: SetupAdapterOptions = {}): LocalSetupPorts {
  const environment = options.environment ?? process.env;
  const provider =
    options.provider ?? createAppUserSetupProvider({ environment, fetch: options.fetch, now: options.now });
  const executor = executorPort(options, environment);
  const shared = { ...options, environment, provider, executorObservation: executor };
  return Object.freeze({
    observation: createSetupObservationPort({
      environment,
      provider,
      executor,
      ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
      sessionReadiness:
        options.sessionReadiness ??
        createAdmissionSessionReadiness({ environment, fetch: options.fetch, now: options.now }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    action: createSetupActionPort(shared),
    journal: new SetupJournalStore({ environment }),
    enrollment: Object.freeze([createExecutorSetupEnrollmentPort(shared)]),
  });
}
