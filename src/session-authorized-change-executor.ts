/**
 * Transport-neutral composition for Session-authorized Change execution.
 *
 * This module owns sequencing only.  Session authentication, semantic
 * capability admission, bounded execution provenance, Change lifecycle/Core,
 * App/effect execution, and branch advancement remain separate authorities.
 */

import {
  admitAuthenticatedSessionCapability,
  CapabilityAdmissionError,
  type AdmittedSessionCapability,
  type CapabilityAdmissionOperation,
} from "./agent-authority/capability-admission.js";
import {
  authenticateSessionRequest,
  type AuthenticatedSessionContext,
  type AuthenticateSessionRequestOptions,
} from "./agent-authority/session-authentication.js";
import {
  createCapabilityExecutionProvenance,
  type CapabilityExecutionProvenance,
} from "./agent-authority/capability-provenance.js";
import {
  MAX_SESSION_AGENT_METADATA_KEYS,
  MAX_SESSION_AGENT_METADATA_TEXT_LENGTH,
  type SessionAgentMetadata,
} from "./agent-authority/session-bundle.js";
import type { DelegatedTreeDelta } from "./agent-authority/protected-paths.js";
import {
  validateBranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticRequest,
  type BranchAdvanceSemanticResult,
} from "./agent-authority/branch-advance.js";
import { MAX_ISSUE_NUMBER } from "./agent-authority/capability.js";
import { assertTrustedExecution, type DirectAppTrustedExecutionContext } from "./github/effect-authorizer.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  changeMutationRequest,
  changeReadRequest,
  normalizeChangeExecutionResult,
  normalizeChangeProjection,
  type ChangeExecutionEvidence,
  type ChangeExecutionResult,
  type ChangeExecutionPort,
} from "./change-execution-port.js";
import { ChangeTrustedExecutorError } from "./change-trusted-executor.js";
import type { ChangeDiagnostic, ChangeProjectionResult } from "./change.js";
import { validateChangeProvenanceRecord, type SignedChangeProvenanceRecord } from "./change-provenance-record.js";
import {
  tryValidatePrPublicationRequest,
  type NormalizedPrPublicationRequest,
  type PrPublicationResult,
} from "./pr-publication.js";

export const CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION = 1 as const;

export const CAPABILITY_AUTHORIZED_SESSION_OPERATIONS = Object.freeze([
  "change.issue",
  "change.show",
  "change.ready",
  "change.abort",
  "change.merge",
  "branch.advance",
  "pullRequest.publish",
] as const);
export type CapabilityAuthorizedSessionOperation = (typeof CAPABILITY_AUTHORIZED_SESSION_OPERATIONS)[number];

export const SESSION_EXECUTION_PHASES = Object.freeze([
  "authentication",
  "request",
  "authorization",
  "evidence",
  "execution",
  "conflict",
  "verification",
  "recovery-required",
] as const);
export type SessionExecutionPhase = (typeof SESSION_EXECUTION_PHASES)[number];

/** The direct Change body signed inside the #373 Session request envelope. */
export type DirectChangeSemanticRequest =
  | {
      readonly version: 1;
      readonly issue: number;
      readonly semanticPullRequestPlan?: unknown;
      readonly agent?: SessionAgentMetadata;
      /** Runtime-signed provenance bootstrap record for `change.issue`; never a private key. */
      readonly signedProvenanceRecord?: SignedChangeProvenanceRecord;
    }
  | {
      readonly version: 1;
      readonly issue: number;
      readonly mergeStrategy: "merge" | "squash" | "rebase";
      readonly agent?: SessionAgentMetadata;
    }
  | {
      readonly version: 1;
      readonly issue: number;
      readonly implementationConformance?: unknown;
      readonly agent?: SessionAgentMetadata;
    };

type AppProvenance = NonNullable<CapabilityExecutionProvenance["app"]>;

export interface CapabilityAuthorizedSessionExecutionFailure {
  readonly code: "SESSION_EXECUTION_FAILED";
  readonly phase: SessionExecutionPhase;
  readonly message: string;
  readonly diagnostics?: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeExecutionEvidence;
}

export interface CapabilityAuthorizedSessionExecutionResult {
  readonly version: typeof CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION;
  readonly operation?: CapabilityAuthorizedSessionOperation;
  readonly status: "succeeded" | "failed";
  readonly projection?: ChangeProjectionResult;
  readonly execution?: ChangeExecutionResult;
  readonly branchAdvance?: BranchAdvanceSemanticResult;
  readonly publication?: PrPublicationResult;
  /** Present only after #376 has established bounded provenance. */
  readonly provenance?: CapabilityExecutionProvenance;
  readonly failure?: CapabilityAuthorizedSessionExecutionFailure;
}

export interface CapabilityAuthorizedChangeExecutorFactoryInput {
  readonly context: AuthenticatedSessionContext;
  readonly execution: DirectAppTrustedExecutionContext;
  readonly admission: AdmittedSessionCapability;
  readonly request: {
    readonly version: typeof CHANGE_EXECUTION_PORT_CONTRACT_VERSION;
    readonly operation: "issue" | "ready" | "abort" | "merge";
    readonly issue: number;
    readonly semanticPullRequestPlan?: unknown;
    readonly mergeStrategy?: "merge" | "squash" | "rebase";
    /** Runtime-signed provenance bootstrap record, present only for `operation: "issue"`. */
    readonly signedProvenanceRecord?: SignedChangeProvenanceRecord;
    /** Seed evidence for the Core-owned Implementation conformance reread on Ready. */
    readonly implementationConformance?: unknown;
  };
}

export interface CapabilityAuthorizedChangeExecutorFactoryResult {
  readonly executor: ChangeExecutionPort;
  /** Bounded App installation identity established by the existing App authority. */
  readonly app?: AppProvenance;
}

export interface CapabilityAuthorizedBranchAdvanceInput {
  readonly envelope: unknown;
  readonly context: AuthenticatedSessionContext;
  readonly admission: AdmittedSessionCapability;
  /** The exact signed #466 semantic request; #465 does not reinterpret it. */
  readonly request: BranchAdvanceSemanticRequest;
}

export interface CapabilityAuthorizedSessionExecutorOptions {
  /** Existing #374 inputs. No alternate authentication callback is accepted. */
  readonly authentication: Omit<AuthenticateSessionRequestOptions, "request">;
  /** Existing read-only Change executor used before authorization. */
  readonly readExecutor?: Pick<ChangeExecutionPort, "read">;
  /** Existing direct-App Change executor, when no post-admission factory is needed. */
  readonly changeExecutor?: ChangeExecutionPort;
  /** Called only after #375 admission; normally constructs TrustedChangeExecutor. */
  readonly createChangeExecutor?: (
    input: CapabilityAuthorizedChangeExecutorFactoryInput,
  ) => Promise<ChangeExecutionPort | CapabilityAuthorizedChangeExecutorFactoryResult>;
  /** Bounded identity returned by the existing App capability authority. */
  readonly app?: AppProvenance;
  /** #466 owns branch validation and Git tree/ref execution. */
  readonly branchAdvance?: (input: CapabilityAuthorizedBranchAdvanceInput) => Promise<BranchAdvanceSemanticResult>;
  /** Existing Operational Observation authority used for REVIEW rework admission. */
  readonly reviewEvidenceReader?: (input: { readonly issue: number; readonly pullRequest: number }) => Promise<unknown>;
  /** Canonical #926 publication Core/provider delegate, admitted by this Session boundary. */
  readonly publishPullRequest?: (
    input: CapabilityAuthorizedPullRequestPublicationInput,
  ) => Promise<CapabilityAuthorizedPullRequestPublicationResult>;
}

export interface CapabilityAuthorizedPullRequestPublicationInput {
  readonly context: AuthenticatedSessionContext;
  readonly execution: DirectAppTrustedExecutionContext;
  readonly admission: AdmittedSessionCapability;
  readonly request: NormalizedPrPublicationRequest;
}

export interface CapabilityAuthorizedPullRequestPublicationResult {
  readonly publication: PrPublicationResult;
  /** Bounded App installation identity established by the existing App authority. */
  readonly app?: AppProvenance;
}

/** Public transport-neutral executor seam for one authenticated Session envelope. */
export interface CapabilityAuthorizedSessionExecutor {
  execute(envelope: unknown): Promise<CapabilityAuthorizedSessionExecutionResult>;
}

const DIRECT_REQUEST_KEYS = new Set([
  "version",
  "issue",
  "semanticPullRequestPlan",
  "mergeStrategy",
  "agent",
  "signedProvenanceRecord",
]);
const DIRECT_MERGE_KEYS = new Set(["version", "issue", "mergeStrategy", "agent"]);
const DIRECT_NON_ISSUE_KEYS = new Set(["version", "issue", "agent"]);
const DIRECT_READY_KEYS = new Set([...DIRECT_NON_ISSUE_KEYS, "implementationConformance"]);
const DIRECT_PUBLICATION_KEYS = new Set([
  "version",
  "issue",
  "publication",
  "repository",
  "workIdentity",
  "routing",
  "expectedHead",
  "expectedBase",
  "headRevision",
  "title",
  "body",
  "draft",
  "maintainerCanModify",
  "agent",
]);
const AGENT_KEYS = new Set(["name", "version", "runtime", "product"]);
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value);
}

function safeIssue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}

function parseAgent(value: unknown): SessionAgentMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("Agent metadata is invalid.");
  if (Object.keys(value).some((key) => !AGENT_KEYS.has(key))) throw new TypeError("Agent metadata is invalid.");
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_SESSION_AGENT_METADATA_KEYS) {
    throw new TypeError("Agent metadata is invalid.");
  }
  const normalized: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      !boundedText(item, MAX_SESSION_AGENT_METADATA_TEXT_LENGTH) ||
      !/^[\x20-\x7e]+$/u.test(item) ||
      /(?:private\s*key|secret|token|credential|begin\s+[-a-z]+\s+key)/iu.test(item)
    ) {
      throw new TypeError("Agent metadata is invalid.");
    }
    normalized[key] = item;
  }
  return Object.freeze(normalized) as SessionAgentMetadata;
}

function parseDirectRequest(
  operation: CapabilityAuthorizedSessionOperation,
  input: unknown,
): DirectChangeSemanticRequest {
  if (!isRecord(input) || operation === "branch.advance") throw new TypeError("Direct Change request is invalid.");
  const allowed =
    operation === "change.issue"
      ? DIRECT_REQUEST_KEYS
      : operation === "change.merge"
        ? DIRECT_MERGE_KEYS
        : operation === "change.ready"
          ? DIRECT_READY_KEYS
          : DIRECT_NON_ISSUE_KEYS;
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Direct Change request is invalid.");
  if (input.version !== CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION || !safeIssue(input.issue)) {
    throw new TypeError("Direct Change request is invalid.");
  }
  const agent = parseAgent(input.agent);
  if (operation === "change.issue") {
    let signedProvenanceRecord: SignedChangeProvenanceRecord | undefined;
    if (hasOwn(input, "signedProvenanceRecord")) {
      // Shape/signature validity is re-verified downstream against the
      // repository-trusted Delegator; this only rejects structurally
      // invalid input early, matching how other optional fields here defer
      // deeper semantic validation to their owning authority.
      const validation = validateChangeProvenanceRecord(input.signedProvenanceRecord);
      if (!validation.valid || validation.record === undefined) {
        throw new TypeError("Direct Change request is invalid.");
      }
      signedProvenanceRecord = validation.record;
    }
    return Object.freeze({
      version: 1,
      issue: input.issue,
      ...(hasOwn(input, "semanticPullRequestPlan") ? { semanticPullRequestPlan: input.semanticPullRequestPlan } : {}),
      ...(agent === undefined ? {} : { agent }),
      ...(signedProvenanceRecord === undefined ? {} : { signedProvenanceRecord }),
    });
  }
  if (operation === "change.merge") {
    if (input.mergeStrategy !== "merge" && input.mergeStrategy !== "squash" && input.mergeStrategy !== "rebase") {
      throw new TypeError("Direct Change merge request is invalid.");
    }
    return Object.freeze({
      version: 1,
      issue: input.issue,
      mergeStrategy: input.mergeStrategy,
      ...(agent === undefined ? {} : { agent }),
    });
  }
  if (hasOwn(input, "semanticPullRequestPlan")) throw new TypeError("Direct Change request is invalid.");
  if (hasOwn(input, "mergeStrategy")) throw new TypeError("Direct Change request is invalid.");
  return Object.freeze({
    version: 1,
    issue: input.issue,
    ...(operation === "change.ready" && hasOwn(input, "implementationConformance")
      ? { implementationConformance: input.implementationConformance }
      : {}),
    ...(agent === undefined ? {} : { agent }),
  });
}

function parsePublicationRequest(input: unknown): {
  readonly version: 1;
  readonly issue: number;
  readonly publication: unknown;
  readonly agent?: SessionAgentMetadata;
} {
  if (!isRecord(input) || Object.keys(input).some((key) => !DIRECT_PUBLICATION_KEYS.has(key))) {
    throw new TypeError("Pull-request publication request is invalid.");
  }
  if (input.version !== CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION || !safeIssue(input.issue)) {
    throw new TypeError("Pull-request publication request is invalid.");
  }
  const agent = parseAgent(input.agent);
  if (hasOwn(input, "publication")) {
    return Object.freeze({
      version: 1,
      issue: input.issue,
      publication: input.publication,
      ...(agent === undefined ? {} : { agent }),
    });
  }
  const publication: Record<string, unknown> = { version: 1 };
  for (const key of [
    "kind",
    "repository",
    "workIdentity",
    "routing",
    "expectedHead",
    "expectedBase",
    "headRevision",
    "title",
    "body",
    "draft",
    "maintainerCanModify",
  ]) {
    if (hasOwn(input, key)) publication[key] = input[key];
  }
  return Object.freeze({
    version: 1,
    issue: input.issue,
    publication: Object.freeze(publication),
    ...(agent === undefined ? {} : { agent }),
  });
}

function directExecutionContext(context: AuthenticatedSessionContext): DirectAppTrustedExecutionContext {
  return assertTrustedExecution({
    version: 1,
    runtime: "inari-app",
    event: "session-request",
    repository: context.repository,
    requestId: context.request.requestId,
    sessionId: context.session.id,
    certificateJti: context.session.certificateJti,
    requester: `session:${context.session.id}`,
  }) as DirectAppTrustedExecutionContext;
}

function subjectForChange(issue: number): { readonly kind: "change"; readonly issue: number } {
  return Object.freeze({ kind: "change", issue });
}

function subjectForPullRequest(
  issue: number,
  head: string,
  base: string,
): { readonly kind: "pullRequest"; readonly issue: number; readonly head: string; readonly base: string } {
  return Object.freeze({ kind: "pullRequest", issue, head, base });
}

/** Map the semantic publish operation onto the existing pullRequest.create capability authority. */
function capabilityAdmissionContext(context: AuthenticatedSessionContext): AuthenticatedSessionContext {
  if (context.request.operation !== "pullRequest.publish") return context;
  return {
    ...context,
    request: { ...context.request, operation: "pullRequest.create" },
    verifiedRequest: {
      ...context.verifiedRequest,
      envelope: { ...context.verifiedRequest.envelope, operation: "pullRequest.create" },
    },
  };
}

function authenticatedProvenance(
  context: AuthenticatedSessionContext,
  subject:
    | { readonly kind: "change"; readonly issue: number }
    | { readonly kind: "branch"; readonly issue: number; readonly branch: string }
    | { readonly kind: "pullRequest"; readonly issue: number; readonly head: string; readonly base: string },
  agent?: SessionAgentMetadata,
  stage: "authenticated" | "authorized" | "app-scoped" | "verified" = "authenticated",
  capability?: AdmittedSessionCapability["capability"],
  app?: AppProvenance,
): CapabilityExecutionProvenance {
  return createCapabilityExecutionProvenance({
    version: 1,
    stage,
    repository: context.repository,
    runtimeAuthority: context.runtimeAuthority,
    session: context.session,
    authority: context.authority,
    request: context.request,
    subject,
    ...(capability === undefined ? {} : { capability }),
    ...(app === undefined ? {} : { app }),
    ...(agent === undefined ? {} : { agent }),
  });
}

function failure(
  operation: CapabilityAuthorizedSessionOperation | undefined,
  phase: SessionExecutionPhase,
  provenance: CapabilityExecutionProvenance | undefined,
  message: string,
  options: {
    readonly diagnostics?: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeExecutionEvidence;
    readonly branchAdvance?: BranchAdvanceSemanticResult;
    readonly publication?: PrPublicationResult;
  } = {},
): CapabilityAuthorizedSessionExecutionResult {
  return Object.freeze({
    version: CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION,
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
  operation: CapabilityAuthorizedSessionOperation,
  provenance: CapabilityExecutionProvenance,
  options: {
    readonly projection?: ChangeProjectionResult;
    readonly execution?: ChangeExecutionResult;
    readonly branchAdvance?: BranchAdvanceSemanticResult;
    readonly publication?: PrPublicationResult;
  },
): CapabilityAuthorizedSessionExecutionResult {
  return Object.freeze({
    version: CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION,
    operation,
    status: "succeeded" as const,
    ...(options.projection === undefined ? {} : { projection: options.projection }),
    ...(options.execution === undefined ? {} : { execution: options.execution }),
    ...(options.branchAdvance === undefined ? {} : { branchAdvance: options.branchAdvance }),
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    provenance,
  });
}

function admissionPhase(reason: CapabilityAdmissionError["reason"]): SessionExecutionPhase {
  if (reason === "canonical-state") return "conflict";
  if (reason === "stale-evidence") return "evidence";
  return "authorization";
}

function trustedDiagnostics(error: ChangeTrustedExecutorError): readonly ChangeDiagnostic[] {
  return error.diagnostics.slice(0, 16);
}

function trustedEvidence(error: ChangeTrustedExecutorError): ChangeExecutionEvidence | undefined {
  return error.evidence;
}

function executionPhase(error: unknown): SessionExecutionPhase {
  if (error instanceof ChangeTrustedExecutorError) {
    if (error.code === "CHANGE_EXECUTION_RECOVERY_REQUIRED") return "recovery-required";
    if (error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED") return "conflict";
    if (error.code === "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED") return "verification";
  }
  return "execution";
}

function executionFailure(
  operation: CapabilityAuthorizedSessionOperation,
  provenance: CapabilityExecutionProvenance,
  error: unknown,
): CapabilityAuthorizedSessionExecutionResult {
  const trusted = error instanceof ChangeTrustedExecutorError ? error : undefined;
  return failure(operation, executionPhase(error), provenance, "Session-authorized Change execution failed closed.", {
    ...(trusted === undefined ? {} : { diagnostics: trustedDiagnostics(trusted), evidence: trustedEvidence(trusted) }),
  });
}

function publicationFailurePhase(publication: PrPublicationResult): SessionExecutionPhase {
  if (
    publication.diagnostics.some(
      (diagnostic) => diagnostic.code.includes("AMBIGUOUS") || diagnostic.code.includes("CONFLICTING"),
    )
  ) {
    return "conflict";
  }
  if (
    publication.diagnostics.some(
      (diagnostic) => diagnostic.code.includes("INVALID") || diagnostic.code.includes("MISMATCH"),
    )
  ) {
    return "authorization";
  }
  return "execution";
}

function appFromFactory(value: ChangeExecutionPort | CapabilityAuthorizedChangeExecutorFactoryResult): {
  readonly executor: ChangeExecutionPort;
  readonly app?: AppProvenance;
} {
  if (isRecord(value) && "executor" in value) {
    if (
      !isObject(value.executor) ||
      typeof value.executor.execute !== "function" ||
      typeof value.executor.read !== "function"
    ) {
      throw new TypeError("Change executor factory returned an invalid executor.");
    }
    return { executor: value.executor as unknown as ChangeExecutionPort, app: value.app as AppProvenance | undefined };
  }
  if (!isObject(value) || typeof value.execute !== "function" || typeof value.read !== "function") {
    throw new TypeError("Change executor factory returned an invalid executor.");
  }
  return { executor: value as unknown as ChangeExecutionPort };
}

function equivalentProjection(left: ChangeProjectionResult, right: ChangeProjectionResult, issue: number): boolean {
  const leftChange = left.change;
  const rightChange = right.change;
  if (left.status !== right.status || left.valid !== right.valid) return false;
  if (left.canonicalBranch !== right.canonicalBranch || left.canonicalBaseBranch !== right.canonicalBaseBranch) {
    return false;
  }
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
  operation: CapabilityAuthorizedSessionOperation,
): boolean {
  if (
    projection.valid &&
    projection.status === "healthy" &&
    projection.change !== undefined &&
    projection.change.identity.rootIssue === issue
  ) {
    return true;
  }
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

function branchRequestFields(input: unknown): {
  readonly request: BranchAdvanceSemanticRequest;
  readonly treeDelta: DelegatedTreeDelta;
} {
  const validation = validateBranchAdvanceSemanticRequest(input);
  if (!validation.valid || validation.value === undefined) throw new TypeError("Branch advance request is invalid.");
  const request = validation.value;
  return {
    request,
    treeDelta: {
      changes: request.changes.map((change) => ({
        operation: change.operation === "delete" ? ("delete" as const) : ("modify" as const),
        path: change.path,
      })),
    },
  };
}

export class SessionAuthorizedChangeExecutor implements CapabilityAuthorizedSessionExecutor {
  readonly #options: CapabilityAuthorizedSessionExecutorOptions;

  constructor(options: CapabilityAuthorizedSessionExecutorOptions) {
    if (!isRecord(options) || !isRecord(options.authentication)) {
      throw new TypeError("Session-authorized executor configuration is invalid.");
    }
    if (options.changeExecutor === undefined && options.readExecutor === undefined) {
      throw new TypeError("An existing Change read executor is required.");
    }
    if (
      options.changeExecutor !== undefined &&
      (!isObject(options.changeExecutor) ||
        typeof options.changeExecutor.read !== "function" ||
        typeof options.changeExecutor.execute !== "function")
    ) {
      throw new TypeError("The existing Change executor is invalid.");
    }
    if (
      options.readExecutor !== undefined &&
      (!isObject(options.readExecutor) || typeof options.readExecutor.read !== "function")
    ) {
      throw new TypeError("The existing Change read executor is invalid.");
    }
    this.#options = options;
  }

  async execute(envelope: unknown): Promise<CapabilityAuthorizedSessionExecutionResult> {
    let context: AuthenticatedSessionContext;
    try {
      context = await authenticateSessionRequest({ ...this.#options.authentication, request: envelope });
    } catch {
      return failure(undefined, "authentication", undefined, "Session authentication failed closed.");
    }

    const operationValue = context.request.operation;
    if (!CAPABILITY_AUTHORIZED_SESSION_OPERATIONS.includes(operationValue as CapabilityAuthorizedSessionOperation)) {
      return failure(undefined, "request", undefined, "Session execution request is invalid.");
    }
    const operation = operationValue as CapabilityAuthorizedSessionOperation;
    const signedRequest = context.verifiedRequest.envelope.request;

    if (operation === "branch.advance") return this.executeBranch(envelope, context, signedRequest, operation);

    if (operation === "pullRequest.publish") return this.executePublication(context, signedRequest);

    let directRequest: DirectChangeSemanticRequest;
    try {
      directRequest = parseDirectRequest(operation, signedRequest);
    } catch {
      return failure(operation, "request", undefined, "Session execution request is invalid.");
    }
    const issue = directRequest.issue;
    let authenticated: CapabilityExecutionProvenance;
    try {
      authenticated = authenticatedProvenance(context, subjectForChange(issue), directRequest.agent);
    } catch {
      return failure(operation, "request", undefined, "Session execution provenance could not be established.");
    }

    const reader = this.#options.readExecutor ?? this.#options.changeExecutor;
    if (reader === undefined)
      return failure(operation, "evidence", authenticated, "Change evidence read failed closed.");
    let initial: ChangeProjectionResult;
    try {
      initial = normalizeChangeProjection("show", await reader.read(changeReadRequest(issue)));
    } catch {
      return failure(operation, "evidence", authenticated, "Current Change evidence could not be read.");
    }

    let admission: AdmittedSessionCapability;
    try {
      admission = admitAuthenticatedSessionCapability({
        context,
        operation: operation as CapabilityAdmissionOperation,
        subject: subjectForChange(issue),
        projection: initial,
      });
    } catch (error: unknown) {
      if (error instanceof CapabilityAdmissionError) {
        return failure(operation, admissionPhase(error.reason), authenticated, "Session capability admission denied.");
      }
      return failure(operation, "authorization", authenticated, "Session capability admission denied.");
    }

    let authorized: CapabilityExecutionProvenance;
    try {
      authorized = authenticatedProvenance(
        context,
        subjectForChange(issue),
        directRequest.agent,
        "authorized",
        admission.capability,
      );
    } catch {
      return failure(
        operation,
        "authorization",
        authenticated,
        "Session execution provenance could not be established.",
      );
    }

    if (operation === "change.show") {
      let reread: ChangeProjectionResult;
      try {
        reread = normalizeChangeProjection("show", await reader.read(changeReadRequest(issue)));
      } catch {
        return failure(operation, "verification", authorized, "Authoritative Change verification failed.");
      }
      if (
        !reread.valid ||
        (reread.status !== "absent" && reread.status !== "healthy") ||
        !equivalentProjection(initial, reread, issue)
      ) {
        return failure(operation, "verification", authorized, "Authoritative Change verification failed.");
      }
      return success(operation, authorized, { projection: reread });
    }

    const request = changeMutationRequest(
      operation === "change.issue"
        ? "issue"
        : operation === "change.ready"
          ? "ready"
          : operation === "change.abort"
            ? "abort"
            : "merge",
      issue,
      operation === "change.issue" && "semanticPullRequestPlan" in directRequest
        ? directRequest.semanticPullRequestPlan
        : undefined,
      operation === "change.issue" && "signedProvenanceRecord" in directRequest
        ? directRequest.signedProvenanceRecord
        : undefined,
      operation === "change.merge" && "mergeStrategy" in directRequest ? directRequest.mergeStrategy : undefined,
      operation === "change.ready" && "implementationConformance" in directRequest
        ? directRequest.implementationConformance
        : undefined,
    );
    const executionContext = (() => {
      try {
        return directExecutionContext(context);
      } catch {
        return undefined;
      }
    })();
    if (executionContext === undefined) {
      return failure(operation, "authorization", authorized, "Direct App trusted execution context is invalid.");
    }

    let executor: ChangeExecutionPort = this.#options.changeExecutor as ChangeExecutionPort;
    let app = this.#options.app;
    if (this.#options.createChangeExecutor !== undefined) {
      try {
        const factoryRequest = {
          ...request,
          ...(operation === "change.issue" && "signedProvenanceRecord" in directRequest
            ? { signedProvenanceRecord: directRequest.signedProvenanceRecord }
            : {}),
        };
        const created = appFromFactory(
          await this.#options.createChangeExecutor({
            context,
            execution: executionContext,
            admission,
            request: factoryRequest,
          }),
        );
        executor = created.executor;
        app = created.app ?? app;
      } catch {
        return failure(operation, "execution", authorized, "Authorized Change executor could not be created.");
      }
    }
    if (executor === undefined)
      return failure(operation, "execution", authorized, "Authorized Change executor is unavailable.");

    let appScoped = authorized;
    if (app !== undefined) {
      try {
        appScoped = authenticatedProvenance(
          context,
          subjectForChange(issue),
          directRequest.agent,
          "app-scoped",
          admission.capability,
          app,
        );
      } catch {
        return failure(operation, "execution", authorized, "App-scoped execution provenance is invalid.");
      }
    }

    let execution: ChangeExecutionResult;
    try {
      execution = normalizeChangeExecutionResult(request.operation, await executor.execute(request));
    } catch (error: unknown) {
      return executionFailure(operation, appScoped, error);
    }
    const evidence = execution.evidence;
    if (evidence?.outcome === "recovery-required") {
      return failure(operation, "recovery-required", appScoped, "Change execution requires governed recovery.", {
        evidence,
      });
    }
    if (evidence?.outcome === "failed") {
      return failure(operation, "execution", appScoped, "Change effect execution failed.", { evidence });
    }

    let verifiedProjection: ChangeProjectionResult;
    try {
      verifiedProjection = normalizeChangeProjection("show", await executor.read(changeReadRequest(issue)));
    } catch {
      return failure(operation, "verification", appScoped, "Authoritative Change verification failed.", { evidence });
    }
    if (
      !validPostExecutionProjection(verifiedProjection, issue, operation) ||
      !equivalentProjection(execution.projection, verifiedProjection, issue)
    ) {
      return failure(operation, "verification", appScoped, "Authoritative Change verification failed.", { evidence });
    }
    if (app === undefined) {
      return failure(operation, "verification", authorized, "Verified App execution provenance is unavailable.", {
        evidence,
      });
    }
    let verified: CapabilityExecutionProvenance;
    try {
      verified = authenticatedProvenance(
        context,
        subjectForChange(issue),
        directRequest.agent,
        "verified",
        admission.capability,
        app,
      );
    } catch {
      return failure(operation, "verification", appScoped, "Verified execution provenance is invalid.", { evidence });
    }
    return success(operation, verified, { projection: verifiedProjection, execution });
  }

  private async executePublication(
    context: AuthenticatedSessionContext,
    signedRequest: unknown,
  ): Promise<CapabilityAuthorizedSessionExecutionResult> {
    let directRequest: ReturnType<typeof parsePublicationRequest>;
    try {
      directRequest = parsePublicationRequest(signedRequest);
    } catch {
      return failure("pullRequest.publish", "request", undefined, "Pull-request publication request is invalid.");
    }
    const validated = tryValidatePrPublicationRequest(directRequest.publication);
    if (!validated.valid || validated.request === undefined) {
      return failure("pullRequest.publish", "request", undefined, "Pull-request publication request is invalid.");
    }
    const request = validated.request;
    const issue = directRequest.issue;
    const subject = subjectForPullRequest(issue, request.expectedHead, request.expectedBase);
    let authenticated: CapabilityExecutionProvenance;
    try {
      authenticated = authenticatedProvenance(context, subject, directRequest.agent);
    } catch {
      return failure(
        "pullRequest.publish",
        "request",
        undefined,
        "Session execution provenance could not be established.",
      );
    }

    const reader = this.#options.readExecutor ?? this.#options.changeExecutor;
    if (reader === undefined) {
      return failure("pullRequest.publish", "evidence", authenticated, "Change evidence read failed closed.");
    }
    let initial: ChangeProjectionResult;
    try {
      initial = normalizeChangeProjection("show", await reader.read(changeReadRequest(issue)));
    } catch {
      return failure("pullRequest.publish", "evidence", authenticated, "Current Change evidence could not be read.");
    }

    let admission: AdmittedSessionCapability;
    try {
      admission = admitAuthenticatedSessionCapability({
        context: capabilityAdmissionContext(context),
        operation: "pullRequest.create",
        subject,
        projection: initial,
      });
    } catch (error: unknown) {
      if (error instanceof CapabilityAdmissionError) {
        return failure(
          "pullRequest.publish",
          admissionPhase(error.reason),
          authenticated,
          "Session capability admission denied.",
        );
      }
      return failure("pullRequest.publish", "authorization", authenticated, "Session capability admission denied.");
    }
    if (admission.capability.kind !== "pullRequest.create") {
      return failure("pullRequest.publish", "authorization", authenticated, "Session capability admission denied.");
    }

    let authorized: CapabilityExecutionProvenance;
    try {
      authorized = authenticatedProvenance(context, subject, directRequest.agent, "authorized", admission.capability);
    } catch {
      return failure(
        "pullRequest.publish",
        "authorization",
        authenticated,
        "Session execution provenance could not be established.",
      );
    }
    const executionContext = (() => {
      try {
        return directExecutionContext(context);
      } catch {
        return undefined;
      }
    })();
    if (executionContext === undefined) {
      return failure(
        "pullRequest.publish",
        "authorization",
        authorized,
        "Direct App trusted execution context is invalid.",
      );
    }
    if (this.#options.publishPullRequest === undefined) {
      return failure("pullRequest.publish", "execution", authorized, "Authorized PR publication is unavailable.");
    }

    let delegated: CapabilityAuthorizedPullRequestPublicationResult;
    try {
      delegated = await this.#options.publishPullRequest({
        context,
        execution: executionContext,
        admission,
        request,
      });
    } catch {
      return failure("pullRequest.publish", "execution", authorized, "PR publication failed closed.");
    }
    const publication = delegated?.publication;
    if (publication === undefined || publication.classification === "failed" || !publication.ok) {
      return failure(
        "pullRequest.publish",
        publication === undefined ? "execution" : publicationFailurePhase(publication),
        authorized,
        "PR publication failed closed.",
        { ...(publication === undefined ? {} : { publication }) },
      );
    }
    const app = delegated.app ?? this.#options.app;
    if (app === undefined) {
      return failure(
        "pullRequest.publish",
        "verification",
        authorized,
        "Verified App execution provenance is unavailable.",
        { publication },
      );
    }
    let verified: CapabilityExecutionProvenance;
    try {
      verified = authenticatedProvenance(context, subject, directRequest.agent, "verified", admission.capability, app);
    } catch {
      return failure("pullRequest.publish", "verification", authorized, "Verified execution provenance is invalid.", {
        publication,
      });
    }
    return success("pullRequest.publish", verified, { publication });
  }

  private async executeBranch(
    envelope: unknown,
    context: AuthenticatedSessionContext,
    signedRequest: unknown,
    operation: "branch.advance",
  ): Promise<CapabilityAuthorizedSessionExecutionResult> {
    let fields: {
      readonly request: BranchAdvanceSemanticRequest;
      readonly treeDelta: DelegatedTreeDelta;
    };
    const issue = context.task?.kind === "issue" ? context.task.number : undefined;
    try {
      fields = branchRequestFields(signedRequest);
    } catch {
      return failure(operation, "request", undefined, "Session execution request is invalid.");
    }
    if (issue === undefined || fields.request.issue !== issue)
      return failure(operation, "authorization", undefined, "Session task binding is required.");

    let authenticated: CapabilityExecutionProvenance;
    try {
      authenticated = authenticatedProvenance(context, {
        kind: "branch",
        issue,
        branch: fields.request.branch,
      });
    } catch {
      return failure(operation, "request", undefined, "Session execution provenance could not be established.");
    }
    const reader = this.#options.readExecutor ?? this.#options.changeExecutor;
    if (reader === undefined)
      return failure(operation, "evidence", authenticated, "Change evidence read failed closed.");
    let projection: ChangeProjectionResult;
    try {
      projection = normalizeChangeProjection("show", await reader.read(changeReadRequest(issue)));
    } catch {
      return failure(operation, "evidence", authenticated, "Current Change evidence could not be read.");
    }

    let reviewEvidence: unknown;
    if (fields.request.rework !== undefined) {
      const pullRequest = projection.change?.projection?.pullRequest;
      if (pullRequest === undefined || this.#options.reviewEvidenceReader === undefined) {
        return failure(operation, "evidence", authenticated, "Current pull-request review evidence could not be read.");
      }
      try {
        reviewEvidence = await this.#options.reviewEvidenceReader({ issue, pullRequest });
      } catch {
        return failure(operation, "evidence", authenticated, "Current pull-request review evidence could not be read.");
      }
    }

    let admission: AdmittedSessionCapability;
    try {
      admission = admitAuthenticatedSessionCapability({
        context,
        operation,
        subject: { kind: "branch", issue, branch: fields.request.branch },
        projection,
        treeDelta: fields.treeDelta,
        ...(reviewEvidence === undefined ? {} : { reviewEvidence }),
      });
    } catch (error: unknown) {
      if (error instanceof CapabilityAdmissionError) {
        return failure(operation, admissionPhase(error.reason), authenticated, "Session capability admission denied.");
      }
      return failure(operation, "authorization", authenticated, "Session capability admission denied.");
    }
    let authorized: CapabilityExecutionProvenance;
    try {
      authorized = authenticatedProvenance(
        context,
        { kind: "branch", issue, branch: fields.request.branch },
        undefined,
        "authorized",
        admission.capability,
      );
    } catch {
      return failure(
        operation,
        "authorization",
        authenticated,
        "Session execution provenance could not be established.",
      );
    }

    if (this.#options.branchAdvance === undefined) {
      return failure(operation, "execution", authorized, "The #466 branch advance delegate is unavailable.");
    }

    let delegated: BranchAdvanceSemanticResult;
    try {
      delegated = await this.#options.branchAdvance({ envelope, context, admission, request: fields.request });
    } catch {
      return failure(operation, "execution", authorized, "Branch advance delegation failed closed.");
    }
    if (delegated.status === "failed") {
      const phase =
        delegated.outcome === "recovery-required"
          ? "recovery-required"
          : delegated.outcome === "stale"
            ? "conflict"
            : "execution";
      return failure(operation, phase, delegated.provenance ?? authorized, "Branch advance failed closed.", {
        branchAdvance: delegated,
      });
    }
    const verified = delegated.provenance;
    if (verified === undefined || verified.stage !== "verified") {
      return failure(
        operation,
        "verification",
        verified ?? authorized,
        "Branch advance succeeded without authoritative verified provenance.",
        { branchAdvance: delegated },
      );
    }
    return success(operation, verified, { branchAdvance: delegated });
  }
}

export function createCapabilityAuthorizedSessionExecutor(
  options: CapabilityAuthorizedSessionExecutorOptions,
): CapabilityAuthorizedSessionExecutor {
  return new SessionAuthorizedChangeExecutor(options);
}
