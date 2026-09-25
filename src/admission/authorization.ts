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

/** Reads current Executor evidence through the neutral Executor client protocol. */
export type AdmissionEvidenceReader = (request: LocalExecutorEvidenceRequest) => Promise<unknown>;

export interface AdmissionAuthorizationOptions {
  readonly runtimeAuthority: Delegator;
  readonly readEvidence: AdmissionEvidenceReader;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
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

function pinnedRuntimeAuthority(value: unknown): Delegator {
  const result = validateDelegator(value);
  if (!result.valid || result.value === undefined) throw new Error("Public Runtime Authority trust is invalid.");
  return result.value;
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
  if (
    !isRecord(value) ||
    !exactKeys(value, ["repository", "authority", "runtimeAuthority", "change", "implementation", "reviewEvidence"])
  )
    throw new Error("Executor evidence response is malformed.");
  const repositoryResult = validateIssuerRepositoryIdentity(value.repository);
  if (
    !repositoryResult.valid ||
    repositoryResult.value === undefined ||
    !sameRepository(repositoryResult.value, binding.repository)
  )
    throw new Error("Executor repository evidence does not match Session.");
  const authority = value.authority;
  if (
    !isRecord(authority) ||
    !exactKeys(authority, ["ref", "sha"]) ||
    typeof authority.ref !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(authority.ref) ||
    typeof authority.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(authority.sha)
  )
    throw new Error("Executor Authority evidence is malformed.");
  const runtime = pinnedRuntimeAuthority(value.runtimeAuthority);
  if (
    runtime.id !== binding.authority.id ||
    delegatorPublicKeyFingerprint(runtime.key) !== binding.authority.publicKeyFingerprint ||
    canonicalJsonString(runtime as unknown as CanonicalJsonValue) !==
      canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue)
  )
    throw new Error("Current Runtime Authority trust does not match Admission configuration.");
  const projection = validateChangeProjectionResult(value.change);
  if (!projection.valid || projection.projection === undefined)
    throw new Error("Current Change evidence is malformed.");
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
    throw new Error("Current Implementation evidence is malformed.");
  return {
    repository: repositoryResult.value,
    authority: { ref: authority.ref, sha: authority.sha },
    change: projection.projection,
    implementation: value.implementation,
    ...(value.reviewEvidence === undefined ? {} : { reviewEvidence: value.reviewEvidence }),
  };
}

function validateTrustEvidence(value: unknown, binding: LocalSessionBinding, pinnedAuthority: Delegator): Delegator {
  if (!isRecord(value) || !exactKeys(value, ["repository", "authority", "runtimeAuthority"]))
    throw new Error("Executor Runtime Authority evidence is malformed.");
  if (!sameRepository(value.repository, binding.repository))
    throw new Error("Executor repository evidence does not match Session.");
  const authority = value.authority;
  if (
    !isRecord(authority) ||
    !exactKeys(authority, ["ref", "sha"]) ||
    typeof authority.ref !== "string" ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(authority.ref) ||
    typeof authority.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(authority.sha)
  )
    throw new Error("Executor Authority evidence is malformed.");
  const current = pinnedRuntimeAuthority(value.runtimeAuthority);
  if (
    current.id !== binding.authority.id ||
    delegatorPublicKeyFingerprint(current.key) !== binding.authority.publicKeyFingerprint ||
    canonicalJsonString(current as unknown as CanonicalJsonValue) !==
      canonicalJsonString(pinnedAuthority as unknown as CanonicalJsonValue)
  )
    throw new Error("Current Runtime Authority trust does not match Admission configuration.");
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
    throw new Error("Current Implementation is not authorized.");
  const currentInput = { ...authorizationInput, authorization: authorization.authorization };
  const bindingProjection = projectImplementationSessionAuthorizationBinding({
    ...currentInput,
    task: binding.task,
  });
  const scope = tryProjectImplementationScope(currentInput);
  if (!scope.valid || scope.projection === undefined) throw new Error("Current Implementation scope is unavailable.");
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

/** Admits a validated Session binding against current Executor trust evidence. */
export async function admitSession(
  binding: LocalSessionBinding,
  options: AdmissionAuthorizationOptions,
): Promise<AdmittedSession> {
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
  if (stored === undefined || stored.status !== "active") throw new Error("Session is unavailable.");
  const binding = stored.record.binding;
  if (!intentRepositoryMatchesBinding(intent.repository, binding.repository))
    throw new Error("Execution repository does not match Session.");
  const issue = executionIntentIssue(intent);
  if (issue === undefined || binding.task.kind !== "issue" || binding.task.number !== issue)
    throw new Error("Execution task does not match Session.");
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
  const admission = admitAuthenticatedSessionCapability({
    context,
    operation,
    subject: intentSubject(intent),
    projection: evidence.change,
    ...(readTreeDelta(intent) === undefined ? {} : { treeDelta: readTreeDelta(intent) }),
    ...(evidence.reviewEvidence === undefined ? {} : { reviewEvidence: evidence.reviewEvidence }),
  });
  let branchAuthorization: unknown;
  if (intent.operation === "branch.advance") {
    const authorized = authorizeBranchAdvance({ context, admission, request: intent.request });
    if (!authorized.valid) throw new Error("Branch advance is outside the current authorized scope.");
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
