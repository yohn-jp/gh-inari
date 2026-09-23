/**
 * Closed, transport-neutral input for execution after repository/task/capability
 * authorization has completed. Authentication, admission, and credentials stay
 * with their existing authorities.
 */

import { MAX_ISSUE_NUMBER, validateCapabilityClaim, type CapabilityClaim } from "./agent-authority/capability.js";
import type { CapabilityAdmissionSubject } from "./agent-authority/capability-admission.js";
import {
  validateCapabilityExecutionProvenance,
  createCapabilityExecutionProvenance,
  type CapabilityExecutionProvenance,
} from "./agent-authority/capability-provenance.js";
import type { SessionCertificateTask } from "./agent-authority/session-certificate.js";
import {
  validateBranchAdvanceAuthorizationEvidence,
  validateBranchAdvanceSemanticRequest,
  type BranchAdvanceAuthorizationEvidence,
  type BranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticResult,
} from "./agent-authority/branch-advance.js";
import {
  assertTrustedExecution,
  validateIssuerRepositoryIdentity,
  type SessionTrustedExecutionContext,
  type RepositoryIdentity,
} from "./github/effect-authorizer.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  changeMutationRequest,
  changeReadRequest,
  normalizeChangeExecutionResult,
  normalizeChangeProjection,
  type ChangeExecutionEvidence,
  type ChangeExecutionPort,
  type ChangeExecutionResult,
  type ChangeMutationRequest,
} from "./change-execution-port.js";
import { ChangeTrustedExecutorError } from "./change-trusted-executor.js";
import type { ChangeDiagnostic, ChangeProjectionResult } from "./change.js";
import {
  tryValidatePrPublicationRequest,
  type NormalizedPrPublicationRequest,
  type PrPublicationRequest,
  type PrPublicationResult,
} from "./pr-publication.js";

export const AUTHORIZED_EXECUTION_VERSION = 1 as const;

export const AUTHORIZED_EXECUTION_OPERATIONS = Object.freeze([
  "change.issue",
  "change.show",
  "change.ready",
  "change.abort",
  "change.merge",
  "branch.advance",
  "pullRequest.publish",
] as const);
export type AuthorizedExecutionOperation = (typeof AUTHORIZED_EXECUTION_OPERATIONS)[number];

export const AUTHORIZED_EXECUTION_PHASES = Object.freeze([
  "authentication",
  "request",
  "authorization",
  "evidence",
  "execution",
  "conflict",
  "verification",
  "recovery-required",
] as const);
export type AuthorizedExecutionPhase = (typeof AUTHORIZED_EXECUTION_PHASES)[number];

export interface AuthorizedExecutionFailure {
  readonly code: "SESSION_EXECUTION_FAILED";
  readonly phase: AuthorizedExecutionPhase;
  readonly message: string;
  readonly diagnostics?: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeExecutionEvidence;
}

export interface AuthorizedExecutionResult {
  readonly version: typeof AUTHORIZED_EXECUTION_VERSION;
  readonly operation?: AuthorizedExecutionOperation;
  readonly status: "succeeded" | "failed";
  readonly projection?: ChangeProjectionResult;
  readonly execution?: ChangeExecutionResult;
  readonly branchAdvance?: BranchAdvanceSemanticResult;
  readonly publication?: PrPublicationResult;
  readonly provenance?: CapabilityExecutionProvenance;
  readonly failure?: AuthorizedExecutionFailure;
}

interface AuthorizedExecutionBase {
  readonly version: typeof AUTHORIZED_EXECUTION_VERSION;
  readonly repository: RepositoryIdentity;
  readonly task?: SessionCertificateTask;
  readonly subject: CapabilityAdmissionSubject;
  readonly capability: CapabilityClaim;
  /** Only the bounded provenance projection from the completed Admission stage. */
  readonly provenance: CapabilityExecutionProvenance;
}

export type AuthorizedExecution =
  | (AuthorizedExecutionBase & {
      readonly operation: "change.show";
      readonly request: Readonly<{
        version: typeof CHANGE_EXECUTION_PORT_CONTRACT_VERSION;
        operation: "show";
        issue: number;
      }>;
      readonly initialProjection: ChangeProjectionResult;
    })
  | (AuthorizedExecutionBase & {
      readonly operation: "change.issue";
      readonly request: ChangeMutationRequest & Readonly<{ operation: "issue" }>;
      readonly execution: SessionTrustedExecutionContext;
    })
  | (AuthorizedExecutionBase & {
      readonly operation: "change.ready";
      readonly request: ChangeMutationRequest & Readonly<{ operation: "ready" }>;
      readonly execution: SessionTrustedExecutionContext;
    })
  | (AuthorizedExecutionBase & {
      readonly operation: "change.abort";
      readonly request: ChangeMutationRequest & Readonly<{ operation: "abort" }>;
      readonly execution: SessionTrustedExecutionContext;
    })
  | (AuthorizedExecutionBase & {
      readonly operation: "change.merge";
      readonly request: ChangeMutationRequest & Readonly<{ operation: "merge" }>;
      readonly execution: SessionTrustedExecutionContext;
    })
  | (AuthorizedExecutionBase & {
      readonly operation: "branch.advance";
      readonly request: BranchAdvanceSemanticRequest;
      readonly branchAuthorization: BranchAdvanceAuthorizationEvidence;
    })
  | (AuthorizedExecutionBase & {
      readonly operation: "pullRequest.publish";
      /** Canonical caller wire request, validated and frozen without derived route fields. */
      readonly request: PrPublicationRequest;
      readonly execution: SessionTrustedExecutionContext;
    });

type NormalizedAuthorizedExecution =
  | Exclude<AuthorizedExecution, { readonly operation: "pullRequest.publish" }>
  | (AuthorizedExecutionBase & {
      readonly operation: "pullRequest.publish";
      readonly request: PrPublicationRequest;
      readonly execution: SessionTrustedExecutionContext;
    });

export interface AuthorizedExecutionChangeFactoryResult {
  readonly executor: ChangeExecutionPort;
  readonly app?: CapabilityExecutionProvenance["app"];
}

export interface AuthorizedExecutionDelegates {
  readonly readExecutor?: Pick<ChangeExecutionPort, "read">;
  readonly changeExecutor?: ChangeExecutionPort;
  readonly createChangeExecutor?: (input: {
    readonly execution: SessionTrustedExecutionContext;
    readonly request: ChangeMutationRequest;
  }) => Promise<ChangeExecutionPort | AuthorizedExecutionChangeFactoryResult>;
  readonly app?: CapabilityExecutionProvenance["app"];
  readonly branchAdvance?: (input: {
    readonly request: BranchAdvanceSemanticRequest;
    readonly branchAuthorization: BranchAdvanceAuthorizationEvidence;
    readonly provenance: CapabilityExecutionProvenance;
  }) => Promise<BranchAdvanceSemanticResult>;
  readonly publishPullRequest?: (input: {
    readonly execution: SessionTrustedExecutionContext;
    readonly request: PrPublicationRequest;
  }) => Promise<Readonly<{ publication: PrPublicationResult; app?: CapabilityExecutionProvenance["app"] }>>;
}

const COMMON_ROOT_KEYS = new Set([
  "version",
  "operation",
  "repository",
  "task",
  "subject",
  "capability",
  "provenance",
  "request",
]);
const CHANGE_REQUEST_KEYS = new Set([
  "version",
  "operation",
  "issue",
  "semanticPullRequestPlan",
  "signedProvenanceRecord",
  "mergeStrategy",
  "implementationConformance",
]);
const CHANGE_SHOW_KEYS = new Set(["version", "operation", "issue"]);
const TASK_KEYS = new Set(["kind", "number"]);
const issuedAuthorizedExecutions = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  if (!Array.isArray(value) && !isRecord(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeIssue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}

function normalizeTask(value: unknown): SessionCertificateTask | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !exactKeys(value, TASK_KEYS) || value.kind !== "issue" || !safeIssue(value.number)) {
    throw new TypeError("Authorized execution task is invalid.");
  }
  return Object.freeze({ kind: "issue", number: value.number });
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.repositoryHost === right.repositoryHost &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase()
  );
}

function sameCapability(left: CapabilityClaim, right: CapabilityClaim): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "change.implement":
    case "change.ready":
    case "change.abort":
    case "change.merge":
      return right.kind === left.kind && right.issue === left.issue;
    case "branch.create":
      return right.kind === left.kind && right.branch === left.branch && right.max === left.max;
    case "branch.advance":
      return right.kind === left.kind && right.branch === left.branch && right.pathPolicy === left.pathPolicy;
    case "pullRequest.create":
      return right.kind === left.kind && right.head === left.head && right.base === left.base && right.max === left.max;
  }
}

function issueAndCapability(value: Record<string, unknown>): { issue: number; kind: string } {
  switch (value.operation) {
    case "change.issue":
    case "change.show":
    case "change.ready":
    case "change.abort":
    case "change.merge": {
      if (!isRecord(value.request) || !safeIssue(value.request.issue))
        throw new TypeError("Authorized request is invalid.");
      const expectedRequestOperation =
        value.operation === "change.show" ? "show" : value.operation.slice("change.".length);
      if (value.request.operation !== expectedRequestOperation) throw new TypeError("Authorized request is invalid.");
      return {
        issue: value.request.issue,
        kind:
          value.operation === "change.issue" || value.operation === "change.show"
            ? "change.implement"
            : value.operation,
      };
    }
    case "branch.advance": {
      if (!isRecord(value.request) || !safeIssue(value.request.issue) || typeof value.request.branch !== "string") {
        throw new TypeError("Authorized request is invalid.");
      }
      return { issue: value.request.issue, kind: "branch.advance" };
    }
    case "pullRequest.publish": {
      if (
        !isRecord(value.request) ||
        !isRecord(value.subject) ||
        value.subject.kind !== "pullRequest" ||
        !safeIssue(value.subject.issue)
      )
        throw new TypeError("Authorized request is invalid.");
      return { issue: value.subject.issue, kind: "pullRequest.create" };
    }
    default:
      throw new TypeError("Authorized execution operation is invalid.");
  }
}

function expectedSubjectMatches(
  operation: AuthorizedExecutionOperation,
  request: unknown,
  suppliedSubject: unknown,
  provenance: CapabilityExecutionProvenance,
): boolean {
  if (!isRecord(request)) return false;
  const subject = provenance.subject;
  if (!isRecord(suppliedSubject) || suppliedSubject.kind !== subject.kind) return false;
  if (operation.startsWith("change.")) {
    return (
      subject.kind === "change" &&
      exactKeys(suppliedSubject, new Set(["kind", "issue"])) &&
      suppliedSubject.issue === subject.issue &&
      subject.issue === request.issue
    );
  }
  if (operation === "branch.advance") {
    return (
      subject.kind === "branch" &&
      exactKeys(suppliedSubject, new Set(["kind", "issue", "branch"])) &&
      suppliedSubject.issue === subject.issue &&
      suppliedSubject.branch === subject.branch &&
      subject.issue === request.issue &&
      subject.branch === request.branch
    );
  }
  return (
    subject.kind === "pullRequest" &&
    exactKeys(suppliedSubject, new Set(["kind", "issue", "head", "base"])) &&
    suppliedSubject.issue === subject.issue &&
    suppliedSubject.head === subject.head &&
    suppliedSubject.base === subject.base
  );
}

function normalizeChangeRequest(
  operation: AuthorizedExecutionOperation,
  value: unknown,
): ChangeMutationRequest | undefined {
  if (!isRecord(value) || !exactKeys(value, CHANGE_REQUEST_KEYS))
    throw new TypeError("Authorized Change request is invalid.");
  if (operation === "change.show") {
    if (
      !exactKeys(value, CHANGE_SHOW_KEYS) ||
      value.version !== CHANGE_EXECUTION_PORT_CONTRACT_VERSION ||
      value.operation !== "show" ||
      !safeIssue(value.issue)
    ) {
      throw new TypeError("Authorized Change request is invalid.");
    }
    return undefined;
  }
  const expected = operation.slice("change.".length);
  if (
    value.version !== CHANGE_EXECUTION_PORT_CONTRACT_VERSION ||
    value.operation !== expected ||
    !safeIssue(value.issue)
  ) {
    throw new TypeError("Authorized Change request is invalid.");
  }
  return changeMutationRequest(
    expected as ChangeMutationRequest["operation"],
    value.issue,
    value.semanticPullRequestPlan,
    value.signedProvenanceRecord as ChangeMutationRequest["signedProvenanceRecord"],
    value.mergeStrategy as ChangeMutationRequest["mergeStrategy"],
    value.implementationConformance,
  );
}

function clonePublicationWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => clonePublicationWireValue(entry));
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) clone[key] = clonePublicationWireValue(value[key]);
    return clone;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new TypeError("Authorized publication routing is invalid.");
}

/** Preserve the validated publication wire shape; its normalized route is internal derived data. */
function canonicalPublicationWireRequest(
  input: unknown,
  normalized: NormalizedPrPublicationRequest,
): PrPublicationRequest {
  if (!isRecord(input)) throw new TypeError("Authorized publication request is invalid.");
  return freezeDeep({
    version: normalized.version,
    kind: normalized.kind,
    repository: normalized.repository,
    workIdentity: normalized.workIdentity,
    ...(input.routing === undefined ? {} : { routing: clonePublicationWireValue(input.routing) }),
    expectedHead: normalized.expectedHead,
    expectedBase: normalized.expectedBase,
    headRevision: normalized.headRevision,
    title: normalized.title,
    body: normalized.body,
    ...(normalized.draft === undefined ? {} : { draft: normalized.draft }),
    ...(normalized.maintainerCanModify === undefined ? {} : { maintainerCanModify: normalized.maintainerCanModify }),
  }) as PrPublicationRequest;
}

function normalizeAuthorizedExecution(input: unknown): NormalizedAuthorizedExecution {
  if (!isRecord(input) || input.version !== AUTHORIZED_EXECUTION_VERSION) {
    throw new TypeError("Authorized execution context is invalid.");
  }
  const operation = input.operation as AuthorizedExecutionOperation;
  if (!AUTHORIZED_EXECUTION_OPERATIONS.includes(operation))
    throw new TypeError("Authorized execution context is invalid.");
  const allowedRootKeys = new Set(COMMON_ROOT_KEYS);
  if (operation === "change.show") allowedRootKeys.add("initialProjection");
  else if (operation === "branch.advance") {
    allowedRootKeys.add("branchAuthorization");
  } else allowedRootKeys.add("execution");
  if (!exactKeys(input, allowedRootKeys)) throw new TypeError("Authorized execution context is invalid.");
  const { issue, kind } = issueAndCapability(input);
  const repositoryResult = validateIssuerRepositoryIdentity(input.repository);
  const capabilityResult = validateCapabilityClaim(input.capability);
  const provenanceResult = validateCapabilityExecutionProvenance(input.provenance);
  if (
    !repositoryResult.valid ||
    repositoryResult.value === undefined ||
    !capabilityResult.valid ||
    capabilityResult.value === undefined ||
    !provenanceResult.valid ||
    provenanceResult.value === undefined
  )
    throw new TypeError("Authorized execution context is invalid.");
  const repository = repositoryResult.value;
  const capability = capabilityResult.value;
  const provenance = provenanceResult.value;
  if (
    provenance.stage !== "authorized" ||
    provenance.request.operation !== operation ||
    !sameRepository(repository, provenance.repository) ||
    provenance.capability === undefined ||
    !sameCapability(capability, provenance.capability) ||
    capability.kind !== kind ||
    !expectedSubjectMatches(operation, input.request, input.subject, provenance)
  )
    throw new TypeError("Authorized execution context is invalid.");

  if (operation.startsWith("change.") && !("issue" in capability && capability.issue === issue)) {
    throw new TypeError("Authorized execution capability does not match its request.");
  }

  const task = normalizeTask(input.task);
  if (task !== undefined && task.number !== issue)
    throw new TypeError("Authorized execution task does not match its request.");

  let request:
    ChangeMutationRequest | ReturnType<typeof changeReadRequest> | BranchAdvanceSemanticRequest | PrPublicationRequest;
  let initialProjection: ChangeProjectionResult | undefined;
  let execution: SessionTrustedExecutionContext | undefined;
  let branchAuthorization: BranchAdvanceAuthorizationEvidence | undefined;
  if (operation.startsWith("change.")) {
    const changeRequest = normalizeChangeRequest(operation, input.request);
    if (changeRequest === undefined) {
      request = changeReadRequest(issue);
      initialProjection = normalizeChangeProjection("show", input.initialProjection);
    } else {
      const trusted = assertTrustedExecution(input.execution);
      if (trusted.runtime !== "inari-app" && trusted.runtime !== "inari-local-admission")
        throw new TypeError("Authorized execution context is invalid.");
      execution = trusted as SessionTrustedExecutionContext;
      request = changeRequest;
    }
  } else if (operation === "branch.advance") {
    const validated = validateBranchAdvanceSemanticRequest(input.request);
    if (!validated.valid || validated.value === undefined) throw new TypeError("Authorized branch request is invalid.");
    const authorization = validateBranchAdvanceAuthorizationEvidence(input.branchAuthorization, validated.value);
    if (!authorization.valid || authorization.authorization === undefined) {
      throw new TypeError("Authorized branch scope evidence is invalid.");
    }
    if (capability.kind !== "branch.advance" || capability.branch !== validated.value.branch) {
      throw new TypeError("Authorized branch capability does not match its request.");
    }
    request = validated.value;
    branchAuthorization = authorization.authorization;
  } else {
    const validated = tryValidatePrPublicationRequest(input.request);
    if (!validated.valid || validated.request === undefined)
      throw new TypeError("Authorized publication request is invalid.");
    const subject = provenance.subject;
    if (
      subject.kind !== "pullRequest" ||
      subject.head !== validated.request.expectedHead ||
      subject.base !== validated.request.expectedBase ||
      capability.kind !== "pullRequest.create" ||
      capability.head !== validated.request.expectedHead ||
      capability.base !== validated.request.expectedBase ||
      validated.request.repository.repositoryHost !== repository.repositoryHost ||
      validated.request.repository.repositoryId !== repository.repositoryId ||
      (validated.request.repository.repository !== undefined &&
        validated.request.repository.repository.toLowerCase() !== repository.nameWithOwner.toLowerCase())
    ) {
      throw new TypeError("Authorized publication request does not match its subject.");
    }
    const trusted = assertTrustedExecution(input.execution);
    if (trusted.runtime !== "inari-app" && trusted.runtime !== "inari-local-admission")
      throw new TypeError("Authorized execution context is invalid.");
    execution = trusted as SessionTrustedExecutionContext;
    request = canonicalPublicationWireRequest(input.request, validated.request);
  }

  if (
    execution !== undefined &&
    (!sameRepository(repository, execution.repository) ||
      execution.requestId !== provenance.request.requestId ||
      execution.sessionId !== provenance.session.id ||
      (execution.runtime === "inari-app"
        ? execution.certificateJti !== provenance.session.certificateJti
        : execution.sessionBindingSignature !== provenance.session.certificateJti))
  )
    throw new TypeError("Authorized execution context is invalid.");

  const base = {
    version: AUTHORIZED_EXECUTION_VERSION,
    operation,
    repository,
    ...(task === undefined ? {} : { task }),
    subject: provenance.subject,
    capability,
    provenance,
  } as const;
  if (operation === "change.show") {
    return Object.freeze({
      ...base,
      operation,
      request: freezeDeep(request as ReturnType<typeof changeReadRequest>),
      initialProjection: freezeDeep(initialProjection as ChangeProjectionResult),
    });
  }
  if (operation.startsWith("change.")) {
    return Object.freeze({
      ...base,
      operation,
      request: freezeDeep(request as ChangeMutationRequest),
      execution: execution!,
    }) as NormalizedAuthorizedExecution;
  }
  if (operation === "branch.advance") {
    return Object.freeze({
      ...base,
      operation,
      request: request as BranchAdvanceSemanticRequest,
      branchAuthorization: branchAuthorization!,
    }) as NormalizedAuthorizedExecution;
  }
  return Object.freeze({
    ...base,
    operation,
    request: request as PrPublicationRequest,
    execution: execution!,
  }) as NormalizedAuthorizedExecution;
}

/** Mint an immutable execution input after the caller has completed Admission. */
export function createAuthorizedExecution(input: unknown): AuthorizedExecution {
  const execution = normalizeAuthorizedExecution(input);
  issuedAuthorizedExecutions.add(execution);
  return execution;
}

function failure(
  operation: AuthorizedExecutionOperation | undefined,
  phase: AuthorizedExecutionPhase,
  provenance: CapabilityExecutionProvenance | undefined,
  message: string,
  options: {
    readonly diagnostics?: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeExecutionEvidence;
    readonly branchAdvance?: BranchAdvanceSemanticResult;
    readonly publication?: PrPublicationResult;
  } = {},
): AuthorizedExecutionResult {
  return Object.freeze({
    version: AUTHORIZED_EXECUTION_VERSION,
    ...(operation === undefined ? {} : { operation }),
    status: "failed" as const,
    ...(provenance === undefined ? {} : { provenance }),
    ...(options.branchAdvance === undefined ? {} : { branchAdvance: options.branchAdvance }),
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    failure: Object.freeze({
      code: "SESSION_EXECUTION_FAILED" as const,
      phase,
      message,
      ...(options.diagnostics === undefined || options.diagnostics.length === 0
        ? {}
        : { diagnostics: Object.freeze([...options.diagnostics]) }),
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    }),
  });
}

function success(
  operation: AuthorizedExecutionOperation,
  provenance: CapabilityExecutionProvenance,
  options: {
    readonly projection?: ChangeProjectionResult;
    readonly execution?: ChangeExecutionResult;
    readonly branchAdvance?: BranchAdvanceSemanticResult;
    readonly publication?: PrPublicationResult;
  },
): AuthorizedExecutionResult {
  return Object.freeze({
    version: AUTHORIZED_EXECUTION_VERSION,
    operation,
    status: "succeeded" as const,
    ...(options.projection === undefined ? {} : { projection: options.projection }),
    ...(options.execution === undefined ? {} : { execution: options.execution }),
    ...(options.branchAdvance === undefined ? {} : { branchAdvance: options.branchAdvance }),
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    provenance,
  });
}

function sameProjection(left: ChangeProjectionResult, right: ChangeProjectionResult, issue: number): boolean {
  const leftChange = left.change;
  const rightChange = right.change;
  if (left.status !== right.status || left.valid !== right.valid) return false;
  if (left.canonicalBranch !== right.canonicalBranch || left.canonicalBaseBranch !== right.canonicalBaseBranch)
    return false;
  if (leftChange === undefined || rightChange === undefined) return leftChange === rightChange;
  return (
    leftChange.identity.repositoryHost === rightChange.identity.repositoryHost &&
    leftChange.identity.repositoryId === rightChange.identity.repositoryId &&
    leftChange.identity.rootIssue === issue &&
    rightChange.identity.rootIssue === issue &&
    leftChange.state === rightChange.state &&
    leftChange.projection?.branch === rightChange.projection?.branch &&
    leftChange.projection?.pullRequest === rightChange.projection?.pullRequest
  );
}

function validPostExecutionProjection(
  projection: ChangeProjectionResult,
  issue: number,
  operation: AuthorizedExecutionOperation,
): boolean {
  if (
    projection.valid &&
    projection.status === "healthy" &&
    projection.change !== undefined &&
    projection.change.identity.rootIssue === issue
  )
    return true;
  return (
    operation === "change.abort" &&
    projection.valid &&
    projection.status === "absent" &&
    projection.diagnostics.length === 0 &&
    projection.change?.identity.rootIssue === issue &&
    projection.change.state === "DEFINED" &&
    projection.change.projection === undefined &&
    projection.candidates.branches.length === 0 &&
    projection.candidates.pullRequests.length === 0
  );
}

function executionPhase(error: unknown): AuthorizedExecutionPhase {
  if (error instanceof ChangeTrustedExecutorError) {
    if (error.code === "CHANGE_EXECUTION_RECOVERY_REQUIRED") return "recovery-required";
    if (error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED") return "conflict";
    if (error.code === "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED") return "verification";
  }
  return "execution";
}

function executionFailure(
  operation: AuthorizedExecutionOperation,
  provenance: CapabilityExecutionProvenance,
  error: unknown,
): AuthorizedExecutionResult {
  const trusted = error instanceof ChangeTrustedExecutorError ? error : undefined;
  return failure(operation, executionPhase(error), provenance, "Session-authorized Change execution failed closed.", {
    ...(trusted === undefined
      ? {}
      : {
          diagnostics: trusted.diagnostics.slice(0, 16),
          evidence: trusted.evidence,
        }),
  });
}

function publicationFailurePhase(publication: PrPublicationResult): AuthorizedExecutionPhase {
  if (
    publication.diagnostics.some(
      (diagnostic) => diagnostic.code.includes("AMBIGUOUS") || diagnostic.code.includes("CONFLICTING"),
    )
  )
    return "conflict";
  if (
    publication.diagnostics.some(
      (diagnostic) => diagnostic.code.includes("INVALID") || diagnostic.code.includes("MISMATCH"),
    )
  )
    return "authorization";
  return "execution";
}

function appScopedProvenance(
  provenance: CapabilityExecutionProvenance,
  app: CapabilityExecutionProvenance["app"],
): CapabilityExecutionProvenance {
  return createCapabilityExecutionProvenance({ ...provenance, stage: "app-scoped", app });
}

function verifiedProvenance(
  provenance: CapabilityExecutionProvenance,
  app: CapabilityExecutionProvenance["app"],
): CapabilityExecutionProvenance {
  return createCapabilityExecutionProvenance({ ...provenance, stage: "verified", app });
}

function executorFromFactory(value: ChangeExecutionPort | AuthorizedExecutionChangeFactoryResult): {
  readonly executor: ChangeExecutionPort;
  readonly app?: CapabilityExecutionProvenance["app"];
} {
  if (isRecord(value) && "executor" in value) {
    if (
      !isObject(value.executor) ||
      typeof value.executor.execute !== "function" ||
      typeof value.executor.read !== "function"
    ) {
      throw new TypeError("Change executor factory returned an invalid executor.");
    }
    return {
      executor: value.executor as unknown as ChangeExecutionPort,
      app: value.app as CapabilityExecutionProvenance["app"],
    };
  }
  if (!isObject(value) || typeof value.execute !== "function" || typeof value.read !== "function") {
    throw new TypeError("Change executor factory returned an invalid executor.");
  }
  return { executor: value as unknown as ChangeExecutionPort };
}

/** Execute an already-authorized semantic operation without authenticating or admitting a Session. */
export async function executeAuthorizedExecution(
  input: unknown,
  delegates: AuthorizedExecutionDelegates,
): Promise<AuthorizedExecutionResult> {
  let execution: NormalizedAuthorizedExecution;
  if (!isObject(input) || !issuedAuthorizedExecutions.has(input)) {
    const operation =
      isRecord(input) && AUTHORIZED_EXECUTION_OPERATIONS.includes(input.operation as AuthorizedExecutionOperation)
        ? (input.operation as AuthorizedExecutionOperation)
        : undefined;
    return failure(operation, "authorization", undefined, "Authorized execution context is invalid.");
  }
  execution = input as unknown as NormalizedAuthorizedExecution;

  const provenance = execution.provenance;
  const operation = execution.operation;
  if (operation === "change.show") {
    const reader = delegates.readExecutor ?? delegates.changeExecutor;
    if (reader === undefined) return failure(operation, "evidence", provenance, "Change evidence read failed closed.");
    let reread: ChangeProjectionResult;
    try {
      reread = normalizeChangeProjection("show", await reader.read(changeReadRequest(execution.request.issue)));
    } catch {
      return failure(operation, "verification", provenance, "Authoritative Change verification failed.");
    }
    if (
      !reread.valid ||
      (reread.status !== "absent" && reread.status !== "healthy") ||
      !sameProjection(execution.initialProjection, reread, execution.request.issue)
    ) {
      return failure(operation, "verification", provenance, "Authoritative Change verification failed.");
    }
    return success(operation, provenance, { projection: reread });
  }

  if (operation === "branch.advance") {
    if (delegates.branchAdvance === undefined)
      return failure(operation, "execution", provenance, "The #466 branch advance delegate is unavailable.");
    let delegated: BranchAdvanceSemanticResult;
    try {
      delegated = await delegates.branchAdvance({
        request: execution.request,
        branchAuthorization: execution.branchAuthorization,
        provenance,
      });
    } catch {
      return failure(operation, "execution", provenance, "Branch advance delegation failed closed.");
    }
    if (delegated.status === "failed") {
      const phase =
        delegated.outcome === "recovery-required"
          ? "recovery-required"
          : delegated.outcome === "stale"
            ? "conflict"
            : "execution";
      return failure(operation, phase, delegated.provenance ?? provenance, "Branch advance failed closed.", {
        branchAdvance: delegated,
      });
    }
    if (delegated.provenance === undefined || delegated.provenance.stage !== "verified") {
      return failure(
        operation,
        "verification",
        delegated.provenance ?? provenance,
        "Branch advance succeeded without authoritative verified provenance.",
        { branchAdvance: delegated },
      );
    }
    return success(operation, delegated.provenance, { branchAdvance: delegated });
  }

  if (operation === "pullRequest.publish") {
    if (delegates.publishPullRequest === undefined)
      return failure(operation, "execution", provenance, "Authorized PR publication is unavailable.");
    let delegated: Readonly<{ publication: PrPublicationResult; app?: CapabilityExecutionProvenance["app"] }>;
    try {
      delegated = await delegates.publishPullRequest({ execution: execution.execution, request: execution.request });
    } catch {
      return failure(operation, "execution", provenance, "PR publication failed closed.");
    }
    const publication = delegated?.publication;
    if (publication === undefined || publication.classification === "failed" || !publication.ok) {
      return failure(
        operation,
        publication === undefined ? "execution" : publicationFailurePhase(publication),
        provenance,
        "PR publication failed closed.",
        {
          ...(publication === undefined ? {} : { publication }),
        },
      );
    }
    const app = delegated.app ?? delegates.app;
    if (app === undefined)
      return failure(operation, "verification", provenance, "Verified App execution provenance is unavailable.", {
        publication,
      });
    let verified: CapabilityExecutionProvenance;
    try {
      verified = verifiedProvenance(provenance, app);
    } catch {
      return failure(operation, "verification", provenance, "Verified execution provenance is invalid.", {
        publication,
      });
    }
    return success(operation, verified, { publication });
  }

  const request = execution.request;
  let executor: ChangeExecutionPort | undefined = delegates.changeExecutor;
  let app = delegates.app;
  if (delegates.createChangeExecutor !== undefined) {
    try {
      const created = executorFromFactory(
        await delegates.createChangeExecutor({ execution: execution.execution, request }),
      );
      executor = created.executor;
      app = created.app ?? app;
    } catch {
      return failure(operation, "execution", provenance, "Authorized Change executor could not be created.");
    }
  }
  if (executor === undefined)
    return failure(operation, "execution", provenance, "Authorized Change executor is unavailable.");

  let appScoped = provenance;
  if (app !== undefined) {
    try {
      appScoped = appScopedProvenance(provenance, app);
    } catch {
      return failure(operation, "execution", provenance, "App-scoped execution provenance is invalid.");
    }
  }

  let result: ChangeExecutionResult;
  try {
    result = normalizeChangeExecutionResult(request.operation, await executor.execute(request));
  } catch (error: unknown) {
    return executionFailure(operation, appScoped, error);
  }
  const evidence = result.evidence;
  if (evidence?.outcome === "recovery-required")
    return failure(operation, "recovery-required", appScoped, "Change execution requires governed recovery.", {
      evidence,
    });
  if (evidence?.outcome === "failed")
    return failure(operation, "execution", appScoped, "Change effect execution failed.", { evidence });

  let verifiedProjection: ChangeProjectionResult;
  try {
    verifiedProjection = normalizeChangeProjection("show", await executor.read(changeReadRequest(request.issue)));
  } catch {
    return failure(operation, "verification", appScoped, "Authoritative Change verification failed.", { evidence });
  }
  if (
    !validPostExecutionProjection(verifiedProjection, request.issue, operation) ||
    !sameProjection(result.projection, verifiedProjection, request.issue)
  ) {
    return failure(operation, "verification", appScoped, "Authoritative Change verification failed.", { evidence });
  }
  if (app === undefined)
    return failure(operation, "verification", provenance, "Verified App execution provenance is unavailable.", {
      evidence,
    });
  let verified: CapabilityExecutionProvenance;
  try {
    verified = verifiedProvenance(provenance, app);
  } catch {
    return failure(operation, "verification", appScoped, "Verified execution provenance is invalid.", { evidence });
  }
  return success(operation, verified, { projection: verifiedProjection, execution: result });
}
