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
import type { BranchAdvanceSemanticRequest, BranchAdvanceSemanticResult } from "./agent-authority/branch-advance.js";
import { MAX_ISSUE_NUMBER } from "./agent-authority/capability.js";
import { assertTrustedExecution, type DirectAppTrustedExecutionContext } from "./github/issuer-authority.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  changeRemoteMutationRequest,
  changeRemoteReadRequest,
  normalizeChangeRemoteExecutionResult,
  normalizeChangeRemoteProjection,
  type ChangeRemoteExecutionEvidence,
  type ChangeRemoteExecutionResult,
  type ChangeRemoteExecutor,
} from "./change-executor.js";
import { ChangeTrustedExecutorError } from "./change-trusted-executor.js";
import type { ChangeDiagnostic, ChangeProjectionResult } from "./change.js";

export const CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION = 1 as const;

export const CAPABILITY_AUTHORIZED_SESSION_OPERATIONS = Object.freeze([
  "change.issue",
  "change.show",
  "change.ready",
  "change.abort",
  "branch.advance",
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
    }
  | {
      readonly version: 1;
      readonly issue: number;
      readonly agent?: SessionAgentMetadata;
    };

type AppProvenance = NonNullable<CapabilityExecutionProvenance["app"]>;

export interface CapabilityAuthorizedSessionExecutionFailure {
  readonly code: "SESSION_EXECUTION_FAILED";
  readonly phase: SessionExecutionPhase;
  readonly message: string;
  readonly diagnostics?: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeRemoteExecutionEvidence;
}

export interface CapabilityAuthorizedSessionExecutionResult {
  readonly version: typeof CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION;
  readonly operation?: CapabilityAuthorizedSessionOperation;
  readonly status: "succeeded" | "failed";
  readonly projection?: ChangeProjectionResult;
  readonly execution?: ChangeRemoteExecutionResult;
  readonly branchAdvance?: BranchAdvanceSemanticResult;
  /** Present only after #376 has established bounded provenance. */
  readonly provenance?: CapabilityExecutionProvenance;
  readonly failure?: CapabilityAuthorizedSessionExecutionFailure;
}

export interface CapabilityAuthorizedChangeExecutorFactoryInput {
  readonly context: AuthenticatedSessionContext;
  readonly execution: DirectAppTrustedExecutionContext;
  readonly admission: AdmittedSessionCapability;
  readonly request: {
    readonly version: typeof CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION;
    readonly operation: "issue" | "ready" | "abort";
    readonly issue: number;
    readonly semanticPullRequestPlan?: unknown;
  };
}

export interface CapabilityAuthorizedChangeExecutorFactoryResult {
  readonly executor: ChangeRemoteExecutor;
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
  readonly readExecutor?: Pick<ChangeRemoteExecutor, "read">;
  /** Existing direct-App Change executor, when no post-admission factory is needed. */
  readonly changeExecutor?: ChangeRemoteExecutor;
  /** Called only after #375 admission; normally constructs TrustedChangeExecutor. */
  readonly createChangeExecutor?: (
    input: CapabilityAuthorizedChangeExecutorFactoryInput,
  ) => Promise<ChangeRemoteExecutor | CapabilityAuthorizedChangeExecutorFactoryResult>;
  /** Bounded identity returned by the existing App capability authority. */
  readonly app?: AppProvenance;
  /** #466 owns branch validation and Git tree/ref execution. */
  readonly branchAdvance?: (input: CapabilityAuthorizedBranchAdvanceInput) => Promise<BranchAdvanceSemanticResult>;
}

/** Public transport-neutral executor seam for one authenticated Session envelope. */
export interface CapabilityAuthorizedSessionExecutor {
  execute(envelope: unknown): Promise<CapabilityAuthorizedSessionExecutionResult>;
}

const DIRECT_REQUEST_KEYS = new Set(["version", "issue", "semanticPullRequestPlan", "agent"]);
const DIRECT_NON_ISSUE_KEYS = new Set(["version", "issue", "agent"]);
const AGENT_KEYS = new Set(["name", "version", "runtime", "product"]);
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_TOKEN = /^[\x21-\x7e]+$/u;

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

function boundedToken(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TOKEN.test(value);
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
  const allowed = operation === "change.issue" ? DIRECT_REQUEST_KEYS : DIRECT_NON_ISSUE_KEYS;
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Direct Change request is invalid.");
  if (input.version !== CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION || !safeIssue(input.issue)) {
    throw new TypeError("Direct Change request is invalid.");
  }
  const agent = parseAgent(input.agent);
  if (operation === "change.issue") {
    return Object.freeze({
      version: 1,
      issue: input.issue,
      ...(hasOwn(input, "semanticPullRequestPlan") ? { semanticPullRequestPlan: input.semanticPullRequestPlan } : {}),
      ...(agent === undefined ? {} : { agent }),
    });
  }
  if (hasOwn(input, "semanticPullRequestPlan")) throw new TypeError("Direct Change request is invalid.");
  return Object.freeze({ version: 1, issue: input.issue, ...(agent === undefined ? {} : { agent }) });
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
  }) as DirectAppTrustedExecutionContext;
}

function subjectForChange(issue: number): { readonly kind: "change"; readonly issue: number } {
  return Object.freeze({ kind: "change", issue });
}

function authenticatedProvenance(
  context: AuthenticatedSessionContext,
  subject:
    | { readonly kind: "change"; readonly issue: number }
    | { readonly kind: "branch"; readonly issue: number; readonly branch: string },
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
    readonly evidence?: ChangeRemoteExecutionEvidence;
    readonly branchAdvance?: BranchAdvanceSemanticResult;
  } = {},
): CapabilityAuthorizedSessionExecutionResult {
  return Object.freeze({
    version: CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION,
    ...(operation === undefined ? {} : { operation }),
    status: "failed" as const,
    ...(provenance === undefined ? {} : { provenance }),
    ...(options.branchAdvance === undefined ? {} : { branchAdvance: options.branchAdvance }),
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
    readonly execution?: ChangeRemoteExecutionResult;
    readonly branchAdvance?: BranchAdvanceSemanticResult;
  },
): CapabilityAuthorizedSessionExecutionResult {
  return Object.freeze({
    version: CAPABILITY_AUTHORIZED_SESSION_EXECUTION_VERSION,
    operation,
    status: "succeeded" as const,
    ...(options.projection === undefined ? {} : { projection: options.projection }),
    ...(options.execution === undefined ? {} : { execution: options.execution }),
    ...(options.branchAdvance === undefined ? {} : { branchAdvance: options.branchAdvance }),
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

function trustedEvidence(error: ChangeTrustedExecutorError): ChangeRemoteExecutionEvidence | undefined {
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

function appFromFactory(value: ChangeRemoteExecutor | CapabilityAuthorizedChangeExecutorFactoryResult): {
  readonly executor: ChangeRemoteExecutor;
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
    return { executor: value.executor as unknown as ChangeRemoteExecutor, app: value.app as AppProvenance | undefined };
  }
  if (!isObject(value) || typeof value.execute !== "function" || typeof value.read !== "function") {
    throw new TypeError("Change executor factory returned an invalid executor.");
  }
  return { executor: value as unknown as ChangeRemoteExecutor };
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

function validPostExecutionProjection(projection: ChangeProjectionResult, issue: number): boolean {
  return (
    projection.valid &&
    projection.status === "healthy" &&
    projection.change !== undefined &&
    projection.change.identity.rootIssue === issue
  );
}

function branchRequestFields(input: unknown): {
  readonly branch: string;
  readonly treeDelta: DelegatedTreeDelta | undefined;
  readonly request: BranchAdvanceSemanticRequest;
} {
  if (!isRecord(input) || !boundedText(input.branch, 255)) throw new TypeError("Branch advance request is invalid.");
  return {
    branch: input.branch,
    treeDelta: input.treeDelta as DelegatedTreeDelta | undefined,
    request: input as unknown as BranchAdvanceSemanticRequest,
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
      initial = normalizeChangeRemoteProjection("show", await reader.read(changeRemoteReadRequest(issue)));
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
        reread = normalizeChangeRemoteProjection("show", await reader.read(changeRemoteReadRequest(issue)));
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

    const request = changeRemoteMutationRequest(
      operation === "change.issue" ? "issue" : operation === "change.ready" ? "ready" : "abort",
      issue,
      undefined,
      operation === "change.issue" && "semanticPullRequestPlan" in directRequest
        ? directRequest.semanticPullRequestPlan
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

    let executor: ChangeRemoteExecutor = this.#options.changeExecutor as ChangeRemoteExecutor;
    let app = this.#options.app;
    if (this.#options.createChangeExecutor !== undefined) {
      try {
        const created = appFromFactory(
          await this.#options.createChangeExecutor({ context, execution: executionContext, admission, request }),
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

    let execution: ChangeRemoteExecutionResult;
    try {
      execution = normalizeChangeRemoteExecutionResult(request.operation, await executor.execute(request));
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
      verifiedProjection = normalizeChangeRemoteProjection("show", await executor.read(changeRemoteReadRequest(issue)));
    } catch {
      return failure(operation, "verification", appScoped, "Authoritative Change verification failed.", { evidence });
    }
    if (
      !validPostExecutionProjection(verifiedProjection, issue) ||
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

  private async executeBranch(
    envelope: unknown,
    context: AuthenticatedSessionContext,
    signedRequest: unknown,
    operation: "branch.advance",
  ): Promise<CapabilityAuthorizedSessionExecutionResult> {
    let fields: {
      readonly branch: string;
      readonly treeDelta: DelegatedTreeDelta | undefined;
      readonly request: BranchAdvanceSemanticRequest;
    };
    const issue = context.task?.kind === "issue" ? context.task.number : undefined;
    try {
      fields = branchRequestFields(signedRequest);
    } catch {
      return failure(operation, "request", undefined, "Session execution request is invalid.");
    }
    if (issue === undefined) return failure(operation, "authorization", undefined, "Session task binding is required.");

    let authenticated: CapabilityExecutionProvenance;
    try {
      authenticated = authenticatedProvenance(context, { kind: "branch", issue, branch: fields.branch });
    } catch {
      return failure(operation, "request", undefined, "Session execution provenance could not be established.");
    }
    const reader = this.#options.readExecutor ?? this.#options.changeExecutor;
    if (reader === undefined)
      return failure(operation, "evidence", authenticated, "Change evidence read failed closed.");
    let projection: ChangeProjectionResult;
    try {
      projection = normalizeChangeRemoteProjection("show", await reader.read(changeRemoteReadRequest(issue)));
    } catch {
      return failure(operation, "evidence", authenticated, "Current Change evidence could not be read.");
    }

    let admission: AdmittedSessionCapability;
    try {
      admission = admitAuthenticatedSessionCapability({
        context,
        operation,
        subject: { kind: "branch", issue, branch: fields.branch },
        projection,
        treeDelta: fields.treeDelta,
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
        { kind: "branch", issue, branch: fields.branch },
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
    const delegateProvenance = delegated.provenance;
    const delegateResultProvenance = delegateProvenance ?? authorized;
    if (delegated.status === "failed") {
      const phase =
        delegated.outcome === "recovery-required"
          ? "recovery-required"
          : delegated.outcome === "stale"
            ? "conflict"
            : "execution";
      return failure(operation, phase, delegateResultProvenance, "Branch advance failed closed.", {
        branchAdvance: delegated,
      });
    }
    return success(operation, delegateResultProvenance, { branchAdvance: delegated });
  }
}

export function createCapabilityAuthorizedSessionExecutor(
  options: CapabilityAuthorizedSessionExecutorOptions,
): CapabilityAuthorizedSessionExecutor {
  return new SessionAuthorizedChangeExecutor(options);
}
