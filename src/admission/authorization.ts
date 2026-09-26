/**
 * Admission authorization (#1107). Private Admission module: it admits and
 * closes Sessions against current Executor trust evidence and produces an
 * `AuthorizedExecution` only after the existing Session, repository, task,
 * Implementation, capability, expiry and replay checks. It reuses the pure
 * Session, Delegator and capability validators, reaches the Executor only
 * through the evidence reader it is given, and holds no provider credential or
 * private signing key. Every failure throws; the server maps it to a bounded
 * denial.
 */
import { closeAdmissionSession, createAdmissionSession, readAdmissionSession } from "../local-control/session-store.js";
import type { LocalSessionBinding } from "../local-control/session-binding.js";
import type { LocalExecutorEvidenceRequest } from "../local-control/executor-http.js";
import { executionIntentIssue, type ExecutionIntent } from "../local-control/execution-intent.js";
import { validateDelegator, type Delegator } from "../agent-authority/delegator.js";
import { delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import {
  admitAuthenticatedSessionCapability,
  type CapabilityAdmissionOperation,
  type CapabilityAdmissionSubject,
} from "../agent-authority/capability-admission.js";
import { authorizeBranchAdvance, type BranchAdvanceSemanticRequest } from "../agent-authority/branch-advance.js";
import {
  createCapabilityExecutionProvenance,
  type CapabilityExecutionProvenance,
} from "../agent-authority/capability-provenance.js";
import type { SessionAdmissionAuthorizationContext } from "../agent-authority/session-authentication.js";
import type { SessionCertificateRepository } from "../agent-authority/session-certificate.js";
import { canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";
import { createAuthorizedExecution, type AuthorizedExecution } from "../authorized-execution.js";
import { changeReadRequest } from "../change-execution-port.js";
import { validateChangeProjectionResult, type ChangeProjectionResult } from "../change.js";
import { tryAuthorizeImplementation, type ImplementationAuthorizationInput } from "../implementation-authorization.js";
import { projectImplementationSessionAuthorizationBinding } from "../implementation-session-binding.js";
import { tryProjectImplementationScope } from "../implementation-scope-projection.js";
import {
  assertTrustedExecution,
  validateIssuerRepositoryIdentity,
  type RepositoryIdentity,
} from "../github/effect-authorizer.js";
import type { PrPublicationRequest } from "../pr-publication.js";
import { observeLocalBranch, type ObserveLocalBranchInput } from "../cli/runtime/branch-observation.js";
import {
  runtimeFailure,
  type RuntimeFailure,
  type RuntimeFailureReason,
  type RuntimeFailureStage,
} from "../runtime-contracts/runtime-failure.js";

/** Bounded Admission denial carrying the owner stage and catalog reason (#1180). */
export class AdmissionAuthorizationError extends Error {
  readonly code: RuntimeFailureReason;
  readonly runtimeFailure: RuntimeFailure;

  constructor(stage: RuntimeFailureStage, code: RuntimeFailureReason, message: string) {
    super(message);
    this.name = "AdmissionAuthorizationError";
    this.code = code;
    this.runtimeFailure = runtimeFailure(stage, code);
  }
}

function deny(stage: RuntimeFailureStage, code: RuntimeFailureReason, message: string): never {
  throw new AdmissionAuthorizationError(stage, code, message);
}

/** Reads current Executor evidence through the neutral Executor client protocol. */
export type AdmissionEvidenceReader = (request: LocalExecutorEvidenceRequest) => Promise<unknown>;

export interface AdmissionAuthorizationOptions {
  readonly runtimeAuthority: Delegator;
  readonly readEvidence: AdmissionEvidenceReader;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Public owner-port observation supplied by the caller, without provider credentials. */
  readonly branchObservation?: ObserveLocalBranchInput;
}

function requireCurrentBranchObservation(
  binding: LocalSessionBinding,
  options: AdmissionAuthorizationOptions,
  stage: RuntimeFailureStage,
): void {
  if (binding.branchObservation === undefined) return;
  if (options.branchObservation === undefined)
    deny(stage, "ADMISSION_BRANCH_OBSERVATION_MISSING", "Current repository branch observation is missing.");
  let current;
  try {
    current = observeLocalBranch(options.branchObservation);
  } catch {
    deny(stage, "ADMISSION_BRANCH_OBSERVATION_STALE", "Current repository branch observation is invalid or stale.");
  }
  if (
    canonicalJsonString(current as unknown as CanonicalJsonValue) !==
    canonicalJsonString(binding.branchObservation as unknown as CanonicalJsonValue)
  )
    deny(
      stage,
      "ADMISSION_BRANCH_OBSERVATION_CONTRADICTED",
      "Current repository branch observation contradicts Session binding.",
    );
}

export interface AdmittedSession {
  readonly id: string;
  readonly status: string;
  readonly exp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function pinnedRuntimeAuthority(value: unknown, stage: RuntimeFailureStage): Delegator {
  const result = validateDelegator(value);
  if (!result.valid || result.value === undefined)
    deny(stage, "ADMISSION_EVIDENCE_MALFORMED", "Public Runtime Authority trust is invalid.");
  return result.value;
}

function requirePinnedAuthorityMatch(
  current: Delegator,
  binding: Pick<LocalSessionBinding, "authority">,
  pinnedAuthority: Delegator,
  stage: RuntimeFailureStage,
): void {
  if (
    current.id !== binding.authority.id ||
    delegatorPublicKeyFingerprint(current.key) !== binding.authority.publicKeyFingerprint ||
    canonicalJsonString(current as unknown as CanonicalJsonValue) !==
      canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue)
  )
    deny(
      stage,
      "ADMISSION_RUNTIME_AUTHORITY_MISMATCH",
      "Current Runtime Authority trust does not match Admission configuration.",
    );
}

function requireAuthorityRef(authority: unknown, stage: RuntimeFailureStage): { ref: string; sha: string } {
  if (
    !isRecord(authority) ||
    !exactKeys(authority, ["ref", "sha"]) ||
    typeof authority.ref !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(authority.ref) ||
    typeof authority.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(authority.sha)
  )
    deny(stage, "ADMISSION_EVIDENCE_MALFORMED", "Executor Authority evidence is malformed.");
  return { ref: authority.ref, sha: authority.sha };
}

function sameRepository(left: unknown, right: SessionCertificateRepository): boolean {
  if (!isRecord(left)) return false;
  return (
    left.repositoryHost === "github.com" &&
    left.repositoryId === right.id &&
    (left.nameWithOwner === undefined ||
      (typeof left.nameWithOwner === "string" && left.nameWithOwner.toLowerCase() === right.name.toLowerCase()))
  );
}

function evidenceRepository(repository: SessionCertificateRepository) {
  return { id: repository.id, name: repository.name };
}

function intentRepositoryMatchesBinding(
  intent: ExecutionIntent["repository"],
  binding: SessionCertificateRepository,
): boolean {
  return (
    intent.repositoryHost === "github.com" &&
    intent.repositoryId === binding.id &&
    (intent.repositoryNameWithOwner === undefined ||
      intent.repositoryNameWithOwner.toLocaleLowerCase("en-US") === binding.name.toLocaleLowerCase("en-US"))
  );
}

function makeContext(
  binding: LocalSessionBinding,
  repository: RepositoryIdentity,
  authority: { readonly ref: string; readonly sha: string },
  intent: ExecutionIntent,
  operation: CapabilityAdmissionOperation,
  nowSeconds: number,
): SessionAdmissionAuthorizationContext {
  const request = Object.freeze({
    requestId: intent.requestId,
    operation,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
  });
  return Object.freeze({
    repository,
    runtimeAuthority: Object.freeze({ id: binding.authority.id, kid: binding.authority.id }),
    session: Object.freeze({ id: binding.sessionId, certificateJti: binding.signature }),
    task: binding.task,
    capabilities: binding.capabilities,
    authority,
    request,
    semanticRequest: intent.request as SessionAdmissionAuthorizationContext["semanticRequest"],
  });
}

function capabilityOperation(intent: ExecutionIntent): CapabilityAdmissionOperation {
  return intent.operation === "pullRequest.publish" ? "pullRequest.create" : intent.operation;
}

function intentSubject(intent: ExecutionIntent): CapabilityAdmissionSubject {
  const issue = executionIntentIssue(intent);
  if (issue === undefined) throw new Error("ExecutionIntent has no task Issue.");
  if (intent.operation === "branch.advance") {
    const request = intent.request as BranchAdvanceSemanticRequest;
    return { kind: "branch", issue, branch: request.branch };
  }
  if (intent.operation === "pullRequest.publish") {
    const request = intent.request as PrPublicationRequest;
    if (typeof request.expectedHead !== "string" || typeof request.expectedBase !== "string")
      throw new Error("Pull request publication route is unavailable.");
    return { kind: "pullRequest", issue, head: request.expectedHead, base: request.expectedBase };
  }
  return { kind: "change", issue };
}

function readTreeDelta(intent: ExecutionIntent) {
  if (intent.operation !== "branch.advance") return undefined;
  const request = intent.request as BranchAdvanceSemanticRequest;
  return {
    changes: request.changes.map((change) => ({ operation: "modify" as const, path: change.path })),
  };
}

function validateEvidence(
  value: unknown,
  binding: LocalSessionBinding,
  pinnedAuthority: Delegator,
): {
  readonly repository: RepositoryIdentity;
  readonly authority: { readonly ref: string; readonly sha: string };
  readonly change: ChangeProjectionResult;
  readonly implementation: Record<string, unknown>;
  readonly reviewEvidence?: unknown;
} {
  const stage = "implementation-admission";
  if (
    !isRecord(value) ||
    !exactKeys(value, ["repository", "authority", "runtimeAuthority", "change", "implementation", "reviewEvidence"])
  )
    deny(stage, "ADMISSION_EVIDENCE_MALFORMED", "Executor evidence response is malformed.");
  const repositoryResult = validateIssuerRepositoryIdentity(value.repository);
  if (
    !repositoryResult.valid ||
    repositoryResult.value === undefined ||
    !sameRepository(repositoryResult.value, binding.repository)
  )
    deny(stage, "ADMISSION_REPOSITORY_MISMATCH", "Executor repository evidence does not match Session.");
  const authority = requireAuthorityRef(value.authority, stage);
  const runtime = pinnedRuntimeAuthority(value.runtimeAuthority, stage);
  requirePinnedAuthorityMatch(runtime, binding, pinnedAuthority, stage);
  const projection = validateChangeProjectionResult(value.change);
  if (!projection.valid || projection.projection === undefined)
    deny(stage, "ADMISSION_EVIDENCE_MALFORMED", "Current Change evidence is malformed.");
  if (
    !isRecord(value.implementation) ||
    !exactKeys(value.implementation, [
      "implementation",
      "issue",
      "repository",
      "base",
      "readiness",
      "change",
      "pullRequest",
    ])
  )
    deny(stage, "ADMISSION_EVIDENCE_MALFORMED", "Current Implementation evidence is malformed.");
  return {
    repository: repositoryResult.value,
    authority,
    change: projection.projection,
    implementation: value.implementation,
    ...(value.reviewEvidence === undefined ? {} : { reviewEvidence: value.reviewEvidence }),
  };
}

function validateTrustEvidence(
  value: unknown,
  subject: Pick<LocalSessionBinding, "repository" | "authority">,
  pinnedAuthority: Delegator,
): Delegator {
  const stage = "trust-evidence";
  if (!isRecord(value) || !exactKeys(value, ["repository", "authority", "runtimeAuthority"]))
    deny(stage, "ADMISSION_EVIDENCE_MALFORMED", "Executor Runtime Authority evidence is malformed.");
  if (!sameRepository(value.repository, subject.repository))
    deny(stage, "ADMISSION_REPOSITORY_MISMATCH", "Executor repository evidence does not match Session.");
  requireAuthorityRef(value.authority, stage);
  const current = pinnedRuntimeAuthority(value.runtimeAuthority, stage);
  requirePinnedAuthorityMatch(current, subject, pinnedAuthority, stage);
  return current;
}

function currentImplementationAuthorization(
  evidence: ReturnType<typeof validateEvidence>,
  binding: LocalSessionBinding,
) {
  const implementationEvidence = evidence.implementation;
  const authorizationInput: ImplementationAuthorizationInput = {
    implementation: implementationEvidence.implementation as ImplementationAuthorizationInput["implementation"],
    issue: implementationEvidence.issue as ImplementationAuthorizationInput["issue"],
    repository: implementationEvidence.repository as ImplementationAuthorizationInput["repository"],
    base: implementationEvidence.base as ImplementationAuthorizationInput["base"],
    readiness: implementationEvidence.readiness,
  };
  const authorization = tryAuthorizeImplementation(authorizationInput);
  if (!authorization.valid || authorization.status !== "authorized" || authorization.authorization === undefined)
    deny(
      "implementation-admission",
      "ADMISSION_IMPLEMENTATION_UNAUTHORIZED",
      "Current Implementation is not authorized.",
    );
  const currentInput = { ...authorizationInput, authorization: authorization.authorization };
  const bindingProjection = projectImplementationSessionAuthorizationBinding({
    ...currentInput,
    task: binding.task,
  });
  const scope = tryProjectImplementationScope(currentInput);
  if (!scope.valid || scope.projection === undefined)
    deny(
      "implementation-admission",
      "ADMISSION_IMPLEMENTATION_SCOPE_UNAVAILABLE",
      "Current Implementation scope is unavailable.",
    );
  return { binding: bindingProjection, scope: scope.projection };
}

async function currentTrust(binding: LocalSessionBinding, options: AdmissionAuthorizationOptions): Promise<Delegator> {
  const evidence = await options.readEvidence({
    version: 1,
    repository: evidenceRepository(binding.repository),
    authorityId: binding.authority.id,
  });
  return validateTrustEvidence(evidence, binding, options.runtimeAuthority);
}

/**
 * Repository-bound Session readiness (#1182): the same current Executor
 * repository binding and protected-ref trust evidence Session registration
 * requires, for the Authority the caller expects Admission to have pinned. It
 * admits nothing and stores nothing; every failure throws a bounded denial.
 */
export async function observeRepositoryReadiness(
  repository: SessionCertificateRepository,
  expectedAuthority: { readonly id: string; readonly publicKeyFingerprint: string },
  options: AdmissionAuthorizationOptions,
): Promise<void> {
  const pinned = options.runtimeAuthority;
  if (
    pinned.id !== expectedAuthority.id ||
    delegatorPublicKeyFingerprint(pinned.key) !== expectedAuthority.publicKeyFingerprint
  )
    deny(
      "trust-evidence",
      "ADMISSION_RUNTIME_AUTHORITY_MISMATCH",
      "The Authority Admission pins differs from the configured setup Authority.",
    );
  const subject = {
    repository,
    authority: { id: pinned.id, publicKeyFingerprint: expectedAuthority.publicKeyFingerprint },
  } as Pick<LocalSessionBinding, "repository" | "authority">;
  const evidence = await options.readEvidence({
    version: 1,
    repository: evidenceRepository(repository),
    authorityId: pinned.id,
  });
  validateTrustEvidence(evidence, subject, pinned);
}

/** Admits a validated Session binding against current Executor trust evidence. */
export async function admitSession(
  binding: LocalSessionBinding,
  options: AdmissionAuthorizationOptions,
): Promise<AdmittedSession> {
  requireCurrentBranchObservation(binding, options, "session-registration");
  const current = await currentTrust(binding, options);
  const snapshot = createAdmissionSession(binding, current, {
    environment: options.environment,
    now: options.now?.(),
  });
  return { id: snapshot.record.binding.sessionId, status: snapshot.status, exp: snapshot.record.binding.exp };
}

/** Closes a validated Session binding against current Executor trust evidence. */
export async function closeSession(
  binding: LocalSessionBinding,
  options: AdmissionAuthorizationOptions,
): Promise<Omit<AdmittedSession, "exp">> {
  const current = await currentTrust(binding, options);
  const snapshot = closeAdmissionSession(binding, current, {
    environment: options.environment,
    now: options.now?.(),
  });
  return { id: snapshot.record.binding.sessionId, status: snapshot.status };
}

/**
 * Produces an `AuthorizedExecution` for a validated ExecutionIntent on an
 * active Session, after every current-evidence, Implementation and capability
 * check. It never dispatches the execution.
 */
export async function authorizeExecutionIntent(
  intent: ExecutionIntent,
  sessionId: string,
  options: AdmissionAuthorizationOptions,
): Promise<AuthorizedExecution> {
  const stored = readAdmissionSession(sessionId, options.runtimeAuthority, {
    environment: options.environment,
    now: options.now?.(),
  });
  if (stored === undefined || stored.status !== "active")
    deny("implementation-admission", "ADMISSION_SESSION_UNAVAILABLE", "Session is unavailable.");
  const binding = stored.record.binding;
  requireCurrentBranchObservation(binding, options, "implementation-admission");
  if (
    binding.branchObservation !== undefined &&
    intent.operation === "branch.advance" &&
    (intent.request as BranchAdvanceSemanticRequest).branch !== binding.branchObservation.expectedBranch
  )
    deny(
      "implementation-admission",
      "ADMISSION_BRANCH_SCOPE_DENIED",
      "Branch advance does not match the Session policy branch.",
    );
  if (!intentRepositoryMatchesBinding(intent.repository, binding.repository))
    deny("implementation-admission", "ADMISSION_TASK_MISMATCH", "Execution repository does not match Session.");
  const issue = executionIntentIssue(intent);
  if (issue === undefined || binding.task.kind !== "issue" || binding.task.number !== issue)
    deny("implementation-admission", "ADMISSION_TASK_MISMATCH", "Execution task does not match Session.");
  const evidenceValue = await options.readEvidence({
    version: 1,
    repository: evidenceRepository(binding.repository),
    authorityId: binding.authority.id,
    issue,
    implementationIssue: binding.task.number,
  });
  const evidence = validateEvidence(evidenceValue, binding, options.runtimeAuthority);
  const current = currentImplementationAuthorization(evidence, binding);
  const operation = capabilityOperation(intent);
  const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const context = {
    ...makeContext(binding, evidence.repository, evidence.authority, intent, operation, nowSeconds),
    implementationBinding: current.binding,
    implementationScope: current.scope,
  } as SessionAdmissionAuthorizationContext;
  let admission: ReturnType<typeof admitAuthenticatedSessionCapability>;
  try {
    admission = admitAuthenticatedSessionCapability({
      context,
      operation,
      subject: intentSubject(intent),
      projection: evidence.change,
      ...(readTreeDelta(intent) === undefined ? {} : { treeDelta: readTreeDelta(intent) }),
      ...(evidence.reviewEvidence === undefined ? {} : { reviewEvidence: evidence.reviewEvidence }),
    });
  } catch {
    deny(
      "implementation-admission",
      "ADMISSION_CAPABILITY_DENIED",
      "The Session capability does not authorize this operation.",
    );
  }
  let branchAuthorization: unknown;
  if (intent.operation === "branch.advance") {
    const authorized = authorizeBranchAdvance({ context, admission, request: intent.request });
    if (!authorized.valid)
      deny(
        "implementation-admission",
        "ADMISSION_BRANCH_SCOPE_DENIED",
        "Branch advance is outside the current authorized scope.",
      );
    branchAuthorization = authorized.authorization;
  }
  const provenanceRequest = {
    ...context.request,
    operation: intent.operation,
  };
  const provenance: CapabilityExecutionProvenance = createCapabilityExecutionProvenance({
    version: 1,
    stage: "authorized",
    repository: evidence.repository,
    runtimeAuthority: context.runtimeAuthority,
    session: context.session,
    authority: context.authority,
    request: provenanceRequest,
    subject: admission.subject,
    capability: admission.capability,
  });
  const localAdmissionExecution = assertTrustedExecution({
    version: 1,
    runtime: "inari-local-admission",
    event: "authorized-session-execution",
    repository: evidence.repository,
    requestId: intent.requestId,
    sessionId: binding.sessionId,
    sessionBindingSignature: binding.signature,
    requester: `session:${binding.sessionId}`,
  });
  const executionInput: Record<string, unknown> = {
    version: 1,
    operation: intent.operation,
    repository: evidence.repository,
    task: binding.task,
    subject: admission.subject,
    capability: admission.capability,
    provenance,
    request: intent.operation === "change.show" ? changeReadRequest(issue) : intent.request,
  };
  if (intent.operation === "change.show") executionInput.initialProjection = evidence.change;
  else if (intent.operation === "branch.advance") executionInput.branchAuthorization = branchAuthorization;
  else executionInput.execution = localAdmissionExecution;
  return createAuthorizedExecution(executionInput);
}
