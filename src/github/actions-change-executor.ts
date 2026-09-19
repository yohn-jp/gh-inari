/**
 * GitHub Actions trusted runtime for Change plans.
 *
 * The workflow supplies only a semantic request. This module resolves bounded
 * GitHub evidence, invokes Core planning, applies explicit effects through the
 * #217 Effect Authorizer, and verifies a fresh #213 projection.
 */

import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  projectChangeFromGitHubEvidence,
  validateGovernedRootIssueEvidence,
  type ChangeDiagnostic,
  type ChangeEffectFailureClassification,
} from "../change.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  changeMutationRequest,
  changeReadRequest,
  normalizeChangeExecutionEvidence,
  normalizeChangeExecutionResult,
  normalizeChangeProjection,
  validateChangeRequest,
  type ChangeExecutionPort,
  type ChangeExecutionEvidence,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "../change-execution-port.js";
import {
  ChangeTrustedExecutorError,
  isChangeTrustedExecutorErrorCode,
  TrustedChangeExecutor,
  type ChangeTrustedExecutorErrorCode,
} from "../change-trusted-executor.js";
import {
  normalizeTrustedFailureDiagnostics,
  readChangeEffectFailureClassification,
} from "../change-failure-diagnostics.js";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES,
  type GitHubChangeEffectRepository,
  type GitHubChangeProvenanceSignerOptions,
} from "./change-effect-adapter.js";
import {
  GitHubAppApiTransport,
  GitHubAppInstallationCredentialBroker,
  resolveGitHubRepository,
  type GitHubAppInstallationCredentialBrokerOptions,
  type GitHubAppRepositoryReadCapability,
  type GitHubAppCredentialFailureStage,
} from "./app-installation-credential-broker.js";
import type { SemanticPullRequestMutationExecutionPort } from "../semantic-pr-mutation.js";
import { createAppRepositoryEvidenceReader } from "./app-repository-evidence-reader.js";
import { GitHubChangeStateProjector, type GitHubChangeStateProjectorOptions } from "./change-state-projector.js";
import {
  GitHubRepositoryEvidenceReaderError,
  REPOSITORY_EVIDENCE_FAILURE_REASONS,
  isRepositoryEvidenceFailureReason,
} from "./repository-evidence-reader.js";
import type { RepositoryEvidenceFailureReason } from "./repository-evidence-reader.js";
import { resolveDelegator } from "../agent-authority/delegator-trust.js";
import {
  validateChangeProvenanceRecord,
  verifyChangeProvenanceRecord,
  type SignedChangeProvenanceRecord,
} from "../change-provenance-record.js";
import {
  InariEffectAuthorizer,
  assertTrustedExecution,
  TRUSTED_EXECUTION_EVENTS,
  type TrustedExecutionEvent,
  type TrustedExecutionContext,
  type RepositoryIdentity,
  EffectAuthorizerError,
} from "./effect-authorizer.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
import { parsePullRequestPolicyOverlay } from "../pr-policy.js";
import {
  readGitHubProviderFailure,
  type GitHubProviderFailureClassification,
} from "./provider-failure.js";
import type { PullRequestBranchGovernance } from "../contract/ir.js";

const POLICY_PATHS = [".github/inari/pr-policy.yml", ".inari/pr-policy.yml"] as const;
const DEFAULT_API_URL = "https://api.github.com";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;

/** Convert the authenticated trusted workflow actor into Change provenance. */
function canonicalGitHubRequester(login: string): string {
  return `github:${login}`;
}

/** Stable, non-secret boundaries exposed for trusted Actions runtime failures. */
export const TRUSTED_ACTIONS_FAILURE_STAGES = Object.freeze([
  "repository-evidence",
  "trusted-execution",
  "branch-governance",
  "issuer-configuration",
  "installation-token",
  "installation-scope",
  "projection-execution",
] as const);
export type TrustedActionsFailureStage = (typeof TRUSTED_ACTIONS_FAILURE_STAGES)[number];

function actionsToAppFailureStage(
  stage: TrustedActionsFailureStage | undefined,
): GitHubAppCredentialFailureStage | undefined {
  switch (stage) {
    case "repository-evidence":
      return "repository-read";
    case "issuer-configuration":
    case "installation-token":
    case "installation-scope":
    case "projection-execution":
      return stage;
    default:
      return "projection-execution";
  }
}

/**
 * Bounded, secret-safe reasons within the `repository-evidence` stage. Fixed at the
 * exact repository read boundary that failed so evidence failures do not collapse
 * into one undifferentiated stage.
 */
export {
  REPOSITORY_EVIDENCE_FAILURE_REASONS,
  isRepositoryEvidenceFailureReason,
} from "./repository-evidence-reader.js";
export type { RepositoryEvidenceFailureReason } from "./repository-evidence-reader.js";

export interface TrustedActionsFailureDiagnostic {
  readonly stage: TrustedActionsFailureStage;
  readonly reason?: RepositoryEvidenceFailureReason;
  readonly trustedCode?: ChangeTrustedExecutorErrorCode;
  readonly diagnostics?: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeExecutionEvidence;
  readonly effectFailure?: ChangeEffectFailureClassification;
  readonly providerFailure?: GitHubProviderFailureClassification;
}

export function isTrustedActionsFailureStage(value: unknown): value is TrustedActionsFailureStage {
  return TRUSTED_ACTIONS_FAILURE_STAGES.includes(value as TrustedActionsFailureStage);
}

function failureDiagnostic(
  stage: TrustedActionsFailureStage,
  reason?: RepositoryEvidenceFailureReason,
  fields: Omit<TrustedActionsFailureDiagnostic, "stage" | "reason"> = {},
): TrustedActionsFailureDiagnostic {
  return Object.freeze({
    stage,
    ...(reason === undefined ? {} : { reason }),
    ...(fields.trustedCode === undefined ? {} : { trustedCode: fields.trustedCode }),
    ...(fields.diagnostics === undefined ? {} : { diagnostics: fields.diagnostics }),
    ...(fields.evidence === undefined ? {} : { evidence: fields.evidence }),
    ...(fields.effectFailure === undefined ? {} : { effectFailure: fields.effectFailure }),
    ...(fields.providerFailure === undefined ? {} : { providerFailure: fields.providerFailure }),
  });
}

function trustedFailureFields(
  error: ChangeTrustedExecutorError,
): Omit<TrustedActionsFailureDiagnostic, "stage" | "reason"> {
  const fields: {
    trustedCode?: ChangeTrustedExecutorErrorCode;
    diagnostics?: readonly ChangeDiagnostic[];
    evidence?: ChangeExecutionEvidence;
  } = {};
  if (isChangeTrustedExecutorErrorCode(error.code)) fields.trustedCode = error.code;
  try {
    const diagnostics = normalizeTrustedFailureDiagnostics(error.diagnostics);
    if (diagnostics !== undefined && diagnostics.length > 0) fields.diagnostics = diagnostics;
  } catch {
    // Invalid internal diagnostics are omitted rather than serialized.
  }
  if (error.evidence !== undefined) {
    try {
      fields.evidence = normalizeChangeExecutionEvidence(error.evidence.operation, error.evidence);
    } catch {
      // Invalid internal evidence is omitted rather than serialized.
    }
  }
  return fields;
}

export class GitHubActionsChangeExecutorError extends Error {
  readonly code = "CHANGE_ACTIONS_RUNTIME_INVALID" as const;
  readonly details?: TrustedActionsFailureDiagnostic;

  constructor(
    message = "Trusted Change Actions runtime configuration is invalid.",
    stage?: TrustedActionsFailureStage,
    reason?: RepositoryEvidenceFailureReason,
    fields: Omit<TrustedActionsFailureDiagnostic, "stage" | "reason"> = {},
  ) {
    super(message);
    this.name = "GitHubActionsChangeExecutorError";
    this.details = stage === undefined ? undefined : failureDiagnostic(stage, reason, fields);
  }
}

function withFailureStage(error: unknown, stage: TrustedActionsFailureStage): GitHubActionsChangeExecutorError {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error;
  const providerFailure = readGitHubProviderFailure(error);
  return new GitHubActionsChangeExecutorError(undefined, stage, undefined, {
    ...(providerFailure === undefined ? {} : { providerFailure }),
  });
}

function atRepositoryEvidenceReason(reason: RepositoryEvidenceFailureReason): (error: unknown) => never {
  return (error: unknown) => {
    const hasOwnReason =
      error instanceof GitHubActionsChangeExecutorError &&
      error.details !== undefined &&
      (error.details.stage !== "repository-evidence" || error.details.reason !== undefined);
    if (hasOwnReason) throw error;
    const providerFailure = readGitHubProviderFailure(error);
    throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", reason, {
      ...(providerFailure === undefined ? {} : { providerFailure }),
    });
  };
}

async function atFailureStage<T>(stage: TrustedActionsFailureStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw withFailureStage(error, stage);
  }
}

function boundedString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value;
}

function boundedSecret(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000\u007F]/u.test(value)) {
    throw new GitHubActionsChangeExecutorError();
  }
  return value;
}

function requiredSignedProvenanceRecord(request: ChangeMutationRequest): SignedChangeProvenanceRecord {
  if (request.operation !== "issue" || request.signedProvenanceRecord === undefined) {
    throw new GitHubActionsChangeExecutorError(undefined, "issuer-configuration");
  }
  const validation = validateChangeProvenanceRecord(request.signedProvenanceRecord);
  if (!validation.valid || validation.record === undefined) {
    throw new GitHubActionsChangeExecutorError(undefined, "issuer-configuration");
  }
  return validation.record;
}

function parseRepository(value: string, hostname = "github.com"): GitHubChangeEffectRepository {
  try {
    const parts = value.split("/");
    if (parts.length !== 2) throw new GitHubActionsChangeExecutorError();
    return {
      hostname: boundedString(hostname, 255),
      owner: boundedString(parts[0], 255),
      name: boundedString(parts[1], 255),
    };
  } catch (error: unknown) {
    throw atRepositoryEvidenceReason("repository-configuration")(error);
  }
}

function assertBrokeredRepositoryScope(
  capability: GitHubAppRepositoryReadCapability,
  target: RepositoryIdentity,
): void {
  const scoped = capability.scope.repository;
  if (
    scoped.repositoryHost.toLowerCase() !== target.repositoryHost.toLowerCase() ||
    scoped.repositoryId !== target.repositoryId ||
    scoped.nameWithOwner !== target.nameWithOwner
  ) {
    throw new GitHubActionsChangeExecutorError(undefined, "installation-scope");
  }
}

export interface GitHubActionsApiTransportOptions {
  readonly apiUrl?: string;
  readonly token: string;
  /** GraphQL repository node ID used by the atomic conditional ref update. */
  readonly repositoryNodeId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly failureStage?: TrustedActionsFailureStage;
}

/** Compatibility wrapper; the credential-bound implementation lives in the App module. */
export class GitHubActionsApiTransport extends GitHubAppApiTransport {
  constructor(options: GitHubActionsApiTransportOptions) {
    super({
      ...options,
      failureStage: actionsToAppFailureStage(options.failureStage),
      failure: (stage) =>
        new GitHubActionsChangeExecutorError(
          undefined,
          stage === "repository-read" ? "repository-evidence" : (stage as TrustedActionsFailureStage),
        ),
    });
  }
}

export interface GitHubActionsCredentialBrokerOptions extends GitHubAppInstallationCredentialBrokerOptions {}

/** Compatibility wrapper; Actions and direct App runtimes share the broker implementation. */
export class GitHubActionsCredentialBroker extends GitHubAppInstallationCredentialBroker {
  constructor(options: GitHubActionsCredentialBrokerOptions) {
    super({
      ...options,
      failure: (stage) =>
        new GitHubActionsChangeExecutorError(
          undefined,
          stage === "repository-read" ? "repository-evidence" : (stage as TrustedActionsFailureStage),
        ),
      mutationFailure: (effect) =>
        new GitHubActionsChangeExecutorError(GITHUB_CHANGE_EFFECT_FAILURE_MESSAGES[effect.kind]),
    });
  }
}

/** Compatibility wrapper; semantic projection and provider I/O are now separate roles. */
export interface GitHubActionsEvidenceReaderOptions extends GitHubChangeStateProjectorOptions {}

export { deriveChangeNamingFromIssueTitle } from "./change-state-projector.js";

/**
 * Compatibility wrapper for the former Actions-named reader.
 *
 * Semantic projection now lives in GitHubChangeStateProjector and provider I/O
 * lives in GitHubRepositoryEvidenceReader. This wrapper preserves existing
 * Actions imports while Direct App composes the deployment-neutral roles.
 */
export class GitHubActionsEvidenceReader extends GitHubChangeStateProjector {
  constructor(options: GitHubActionsEvidenceReaderOptions) {
    super({
      ...options,
      onReadFailure: (error: unknown): never => {
        if (error instanceof GitHubRepositoryEvidenceReaderError) {
          throw new GitHubActionsChangeExecutorError(undefined, "repository-evidence", error.reason);
        }
        throw withFailureStage(error, "repository-evidence");
      },
    });
  }
}

export async function loadBranchGovernance(cwd: string): Promise<PullRequestBranchGovernance | undefined> {
  try {
    for (const policyPath of POLICY_PATHS) {
      const filePath = path.join(cwd, policyPath);
      // O_NOFOLLOW pins the candidate to a single filesystem object: the open
      // itself fails on a symlinked final path element, so there is no window
      // between a link check and the read where the path can be swapped.
      // This is a read-only repository policy open, not temporary-file creation.
      // lgtm [js/insecure-temporary-file]
      let handle;
      try {
        handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error: unknown) {
        // A fallback is safe only when the candidate path itself is absent.
        if (isFileNotFound(error)) continue;
        throw new GitHubActionsChangeExecutorError();
      }
      try {
        // Repository policy is a regular file authority; the descriptor above
        // already excludes a symlinked final path element.
        const stats = await handle.stat();
        if (!stats.isFile()) throw new GitHubActionsChangeExecutorError();
        const source = await handle.readFile("utf8");
        const overlay = parsePullRequestPolicyOverlay(source);
        // A repository-native policy with no branch rule declares no branch precondition.
        return overlay.branch;
      } finally {
        await handle.close();
      }
    }
    throw new GitHubActionsChangeExecutorError();
  } catch (error: unknown) {
    throw withFailureStage(error, "branch-governance");
  }
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  key: string,
  stage: TrustedActionsFailureStage = "trusted-execution",
): string {
  const value = environment[key];
  if (value === undefined) throw new GitHubActionsChangeExecutorError(undefined, stage);
  try {
    return boundedString(value, 16_384);
  } catch (error: unknown) {
    throw withFailureStage(error, stage);
  }
}

/**
 * The workflow SHA is the generation that GitHub attested for this workflow.
 * Refusing to continue when the checkout resolves anything else closes the
 * moving-default-branch race before any privileged executor can be created.
 */
function assertAttestedCheckout(cwd: string, workflowSha: string): void {
  if (!COMMIT_SHA_PATTERN.test(workflowSha)) throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");

  let checkedOutSha: string;
  try {
    checkedOutSha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }

  if (!COMMIT_SHA_PATTERN.test(checkedOutSha) || checkedOutSha.toLowerCase() !== workflowSha.toLowerCase()) {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }
}

function issuerFailureStage(error: unknown): TrustedActionsFailureStage {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error.details.stage;
  if (error instanceof EffectAuthorizerError) {
    if (["ISSUER_INVALID_EXECUTION", "ISSUER_UNTRUSTED_EXECUTION", "ISSUER_UNSUPPORTED_EVENT"].includes(error.code)) {
      return "trusted-execution";
    }
    if (
      [
        "ISSUER_INVALID_SCOPE",
        "ISSUER_PERMISSION_MISMATCH",
        "ISSUER_SCOPE_MISMATCH",
        "ISSUER_CREDENTIAL_EXPIRED",
      ].includes(error.code)
    ) {
      return "installation-scope";
    }
    if (["ISSUER_INVALID_EFFECT", "ISSUER_UNSUPPORTED_EFFECT", "ISSUER_MUTATION_FAILED"].includes(error.code)) {
      return "projection-execution";
    }
  }
  return "installation-token";
}

function trustedFailureStage(
  error: unknown,
  issuerStage: TrustedActionsFailureStage | undefined,
): TrustedActionsFailureStage {
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) return error.details.stage;
  if (error instanceof ChangeTrustedExecutorError) {
    if (error.code === "CHANGE_EXECUTION_READ_FAILED") return "repository-evidence";
    return issuerStage ?? "projection-execution";
  }
  if (error instanceof EffectAuthorizerError) return issuerFailureStage(error);
  return issuerStage ?? "projection-execution";
}

export function asTrustedActionsFailure(
  error: unknown,
  issuerStage: TrustedActionsFailureStage | undefined,
): GitHubActionsChangeExecutorError {
  const effectFailure = readChangeEffectFailureClassification(error);
  const providerFailure = readGitHubProviderFailure(error);
  if (error instanceof GitHubActionsChangeExecutorError && error.details !== undefined) {
    if (
      (effectFailure === undefined || error.details.effectFailure !== undefined) &&
      (providerFailure === undefined || error.details.providerFailure !== undefined)
    ) {
      return error;
    }
    return new GitHubActionsChangeExecutorError(undefined, error.details.stage, error.details.reason, {
      trustedCode: error.details.trustedCode,
      diagnostics: error.details.diagnostics,
      evidence: error.details.evidence,
      ...(error.details.effectFailure !== undefined
        ? { effectFailure: error.details.effectFailure }
        : effectFailure === undefined
          ? {}
          : { effectFailure }),
      ...(error.details.providerFailure !== undefined
        ? { providerFailure: error.details.providerFailure }
        : providerFailure === undefined
          ? {}
          : { providerFailure }),
    });
  }
  const stage = trustedFailureStage(error, issuerStage);
  return new GitHubActionsChangeExecutorError(undefined, stage, undefined, {
    ...(error instanceof ChangeTrustedExecutorError ? trustedFailureFields(error) : {}),
    ...(effectFailure === undefined ? {} : { effectFailure }),
    ...(providerFailure === undefined ? {} : { providerFailure }),
  });
}

export interface GitHubActionsRuntimeOptions {
  readonly cwd: string;
  readonly request: ChangeMutationRequest | ChangeReadRequest;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
}

/** Build the trusted executor from GitHub Actions runtime claims and secrets. */
export async function createGitHubActionsChangeExecutor(
  options: GitHubActionsRuntimeOptions,
): Promise<ChangeExecutionPort> {
  try {
    validateChangeRequest(options.request);
  } catch {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }
  const environment = options.environment ?? process.env;
  let repositoryNameWithOwner: string;
  let hostname = "github.com";
  let bootstrapTransport: GitHubActionsApiTransport;
  try {
    repositoryNameWithOwner = requiredEnvironment(environment, "GITHUB_REPOSITORY", "repository-evidence");
    if (environment.GITHUB_SERVER_URL !== undefined) {
      hostname = new URL(environment.GITHUB_SERVER_URL).hostname;
    }
    // GITHUB_TOKEN is retained only for the Actions bootstrap read that binds
    // the workflow target to an immutable repository identity. All semantic
    // evidence below is acquired through the App broker capability.
    bootstrapTransport = new GitHubActionsApiTransport({
      apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
      token: requiredEnvironment(environment, "GITHUB_TOKEN", "repository-evidence"),
      fetch: options.fetch,
      failureStage: "repository-evidence",
    });
  } catch (error: unknown) {
    throw atRepositoryEvidenceReason("repository-configuration")(error);
  }
  const repository = parseRepository(repositoryNameWithOwner, hostname);
  const resolvedRepository = await resolveGitHubRepository(
    repository,
    bootstrapTransport,
    (reason, providerFailure) =>
      new GitHubActionsChangeExecutorError(undefined, "repository-evidence", reason, {
        ...(providerFailure === undefined ? {} : { providerFailure }),
      }),
  );
  const { target, repositoryNodeId } = resolvedRepository;

  const event = requiredEnvironment(environment, "GITHUB_EVENT_NAME", "trusted-execution");
  if (!TRUSTED_EXECUTION_EVENTS.includes(event as TrustedExecutionEvent)) {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }

  // GITHUB_REF constrains the target ref only. Under workflow_call this reflects the
  // *caller's* context, so it cannot alone prove the trusted-executor source — see below.
  if (requiredEnvironment(environment, "GITHUB_REF", "trusted-execution") !== "refs/heads/main") {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }

  // GITHUB_WORKFLOW_REF names the workflow FILE actually executing (owner/repo/path@ref).
  // Unlike GITHUB_REF it cannot be substituted by a workflow_call caller, so an exact match
  // against this repository's protected executor workflow is the real trust proof: only this
  // check licenses workflowTrust: "protected" / codeExecution: "trusted-only" below.
  const expectedWorkflowRef = `${repositoryNameWithOwner}/.github/workflows/inari-change-executor.yml@refs/heads/main`;
  if (requiredEnvironment(environment, "GITHUB_WORKFLOW_REF", "trusted-execution") !== expectedWorkflowRef) {
    throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
  }
  const workflowRef = "refs/heads/main";
  const workflowSha = requiredEnvironment(environment, "GITHUB_WORKFLOW_SHA", "trusted-execution");
  assertAttestedCheckout(options.cwd, workflowSha);
  const actor = requiredEnvironment(environment, "GITHUB_ACTOR", "trusted-execution");

  let execution: TrustedExecutionContext;
  try {
    execution = assertTrustedExecution({
      version: 1,
      runtime: "github-actions",
      event,
      repository: target,
      workflowRef,
      workflowSha,
      workflowTrust: "protected",
      codeExecution: "trusted-only",
      // repositoryBody.fork is an auxiliary scope check on the target repository identity;
      // the primary proof against untrusted/forked execution is the workflow-ref match above.
      fork: resolvedRepository.fork,
      pullRequest: event === "pull_request" || event === "pull_request_target",
      requester: canonicalGitHubRequester(actor),
    });
  } catch (error: unknown) {
    throw withFailureStage(error, "trusted-execution");
  }
  const branchGovernance = await atFailureStage("branch-governance", () => loadBranchGovernance(options.cwd));
  let broker: GitHubActionsCredentialBroker;
  let effectAuthorizer: InariEffectAuthorizer;
  try {
    const appId = requiredEnvironment(environment, "INARI_ISSUER_APP_ID", "issuer-configuration");
    const installationId = requiredEnvironment(environment, "INARI_ISSUER_INSTALLATION_ID", "issuer-configuration");
    const brokerOptions: GitHubActionsCredentialBrokerOptions = {
      appId,
      installationId,
      privateKeyPem: boundedSecret(environment.INARI_ISSUER_APP_PRIVATE_KEY, 16_384),
      repository,
      repositoryNodeId,
      apiUrl: environment.GITHUB_API_URL ?? DEFAULT_API_URL,
      fetch: options.fetch,
    };
    // Establish the broker before any Runtime Authority or semantic evidence
    // read. The initial instance has no provenance signer and is read-only for
    // bootstrap/trust discovery; issue effects use a fresh instance below with
    // the already verified Runtime Authority record.
    broker = new GitHubActionsCredentialBroker(brokerOptions);
    if (options.request.operation === "issue") {
      // Parse and validate the caller-produced record before selecting any
      // repository trust anchor. The signed kid is the sole selector.
      const signedRecord = requiredSignedProvenanceRecord(options.request);
      const provenance = await broker.withRepositoryReadCapability({}, async (capability) => {
        assertBrokeredRepositoryScope(capability, target);
        const runtimeReader = createAppRepositoryEvidenceReader(capability, repository, target);
        const loaded = await resolveDelegator(runtimeReader, signedRecord.signature.kid);
        // The Runtime signs before this trusted executor boundary; this process
        // never imports or holds the Runtime private key.
        const payload = verifyChangeProvenanceRecord(signedRecord, loaded.authority);
        if (payload.rootIssue !== options.request.issue || payload.operation !== "change.issue") {
          throw new GitHubActionsChangeExecutorError(undefined, "issuer-configuration");
        }
        const signer: GitHubChangeProvenanceSignerOptions = {
          runtimeAuthority: loaded.authority,
          signedRecord,
        };
        return signer;
      });
      // The Runtime signs before this trusted executor boundary; this process
      // never imports or holds the Runtime private key.
      broker = new GitHubActionsCredentialBroker({ ...brokerOptions, provenance });
    }
    effectAuthorizer = new InariEffectAuthorizer({ appId, broker });
  } catch (error: unknown) {
    throw withFailureStage(error, "issuer-configuration");
  }

  const withBrokeredEvidence = <T>(
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T> =>
    broker.withRepositoryReadCapability({}, async (capability) => {
      assertBrokeredRepositoryScope(capability, target);
      return operation(capability);
    });

  const buildReader = (capability: GitHubAppRepositoryReadCapability): GitHubActionsEvidenceReader =>
    new GitHubActionsEvidenceReader({
      repository,
      identity: {
        repositoryHost: capability.scope.repository.repositoryHost,
        repositoryId: capability.scope.repository.repositoryId,
        rootIssue: options.request.issue,
      },
      branchGovernance,
      transport: capability.transport,
      providerPrincipal: capability.providerPrincipal,
      cwd: options.cwd,
      ...(options.request.operation !== "issue" || options.request.semanticPullRequestPlan === undefined
        ? {}
        : { semanticPullRequestPlan: options.request.semanticPullRequestPlan }),
    });

  if (options.request.operation === "show") {
    return {
      execute: async () => {
        throw new GitHubActionsChangeExecutorError(
          "Read-only Change execution cannot apply effects.",
          "projection-execution",
        );
      },
      read: async (request) => {
        try {
          return await withBrokeredEvidence(async (capability) =>
            projectChangeFromGitHubEvidence(await buildReader(capability).read(request)),
          );
        } catch (error: unknown) {
          throw withFailureStage(error, "projection-execution");
        }
      },
    };
  }
  let issuerStage: TrustedActionsFailureStage | undefined;
  const stagedEffectAuthorizer: Pick<InariEffectAuthorizer, "applyEffects"> = {
    applyEffects: async (input) => {
      try {
        return await effectAuthorizer.applyEffects(input);
      } catch (error: unknown) {
        issuerStage = issuerFailureStage(error);
        throw error;
      }
    },
  };
  const withTrustedExecutor = <T>(
    operation: (executor: TrustedChangeExecutor) => Promise<T>,
    semanticPullRequestMutationExecutor?: SemanticPullRequestMutationExecutionPort,
  ): Promise<T> =>
    withBrokeredEvidence(async (capability) => {
      const trustedExecutor = new TrustedChangeExecutor({
        reader: buildReader(capability),
        effectAuthorizer: stagedEffectAuthorizer,
        execution,
        target,
        ...(semanticPullRequestMutationExecutor === undefined ? {} : { semanticPullRequestMutationExecutor }),
      });
      return operation(trustedExecutor);
    });
  return {
    execute: async (request) => {
      issuerStage = undefined;
      try {
        if (request.operation === "merge") {
          return await broker.withSemanticPullRequestMutationExecutor({ target }, async (semanticExecutor) =>
            withTrustedExecutor((trustedExecutor) => trustedExecutor.execute(request), semanticExecutor),
          );
        }
        return await withTrustedExecutor((trustedExecutor) => trustedExecutor.execute(request));
      } catch (error: unknown) {
        throw asTrustedActionsFailure(error, issuerStage);
      }
    },
    read: async (request) => {
      try {
        return await withTrustedExecutor((trustedExecutor) => trustedExecutor.read(request));
      } catch (error: unknown) {
        throw asTrustedActionsFailure(error, undefined);
      }
    },
  };
}

function sanitizedFailure(error: unknown): Record<string, unknown> {
  if (error instanceof GitHubActionsChangeExecutorError) {
    return {
      code: error.code,
      message: "Trusted Change execution failed closed.",
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: "CHANGE_ACTIONS_RUNTIME_INVALID", message: "Trusted Change execution failed closed." };
}

/** Workflow entrypoint. It emits one bounded JSON result and never logs secrets. */
export async function runGitHubActionsChangeExecutor(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<number> {
  try {
    const serialized = requiredEnvironment(environment, "INARI_CHANGE_REQUEST", "trusted-execution");
    let requestValue: unknown;
    try {
      requestValue = JSON.parse(serialized) as unknown;
    } catch {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (typeof requestValue !== "object" || requestValue === null || Array.isArray(requestValue)) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    const requestRecord = requestValue as Record<string, unknown>;
    const allowedRequestKeys = new Set([
      "version",
      "operation",
      "issue",
      "semanticPullRequestPlan",
      "signedProvenanceRecord",
      "mergeStrategy",
      "implementationConformance",
    ]);
    if (Object.keys(requestRecord).some((key) => !allowedRequestKeys.has(key))) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (
      requestRecord.version !== CHANGE_EXECUTION_PORT_CONTRACT_VERSION ||
      typeof requestRecord.operation !== "string" ||
      typeof requestRecord.issue !== "number"
    ) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.operation !== "show" && !["issue", "ready", "abort", "merge"].includes(requestRecord.operation)) {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.semanticPullRequestPlan !== undefined && requestRecord.operation !== "issue") {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.mergeStrategy !== undefined && requestRecord.operation !== "merge") {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.signedProvenanceRecord !== undefined && requestRecord.operation !== "issue") {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    if (requestRecord.implementationConformance !== undefined && requestRecord.operation !== "ready") {
      throw new GitHubActionsChangeExecutorError(undefined, "trusted-execution");
    }
    const request =
      requestRecord.operation === "show"
        ? changeReadRequest(requestRecord.issue)
        : changeMutationRequest(
            requestRecord.operation as "issue" | "ready" | "abort" | "merge",
            requestRecord.issue,
            requestRecord.semanticPullRequestPlan,
            requestRecord.signedProvenanceRecord as SignedChangeProvenanceRecord | undefined,
            requestRecord.mergeStrategy as "merge" | "squash" | "rebase" | undefined,
            requestRecord.implementationConformance,
          );
    const executor = await createGitHubActionsChangeExecutor({ cwd, request, environment });
    const result =
      request.operation === "show"
        ? normalizeChangeProjection(request.operation, await executor.read(request))
        : normalizeChangeExecutionResult(request.operation, await executor.execute(request));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error: unknown) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: sanitizedFailure(error) })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && invokedPath.endsWith("actions-change-executor.js")) {
  runGitHubActionsChangeExecutor().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
