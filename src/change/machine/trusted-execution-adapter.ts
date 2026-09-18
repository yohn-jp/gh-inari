/**
 * Trusted Change execution adapter.
 *
 * This module is the internal boundary between the semantic Core contracts,
 * the #216 Effect Adapter, the #217 Effect Authorizer, and the XState
 * operation machines. The public TrustedChangeExecutor delegates to this
 * adapter so its package-facing surface cannot become a second control-flow
 * authority.
 */

import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  ChangeIssuanceRecoveryValidationError,
  ChangeIssuanceValidationError,
  classifyChangeAbortRecovery,
  createChangeDiagnostic,
  isChangeAbortCleanupComplete,
  planChangeIssuance,
  planChangeIssuanceRecovery,
  planChangeRecovery,
  planChangeReadyTransition,
  planChangeTransition,
  projectChangeFromGitHubEvidence,
  validateChangeMergeAdmission,
  validateGovernedRootIssueEvidence,
  validateChangeReadyTransition,
  type Change,
  type ChangeDiagnostic,
  type ChangeEffect,
  type ChangeIdentity,
  type ChangeIssuanceEffectAttempt,
  type ChangeIssuanceFailureEvidence,
  type ChangeIssuancePlan,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
  type ChangeTransitionPlan,
} from "../../change.js";
import {
  planSemanticPullRequestMutation,
  SemanticPullRequestMutationError,
  type SemanticPullRequestMergeStrategy,
  type SemanticPullRequestMutationExecutionPort,
  type SemanticPullRequestMutationPlan,
  type SemanticPullRequestMutationResult,
} from "../../semantic-pr-mutation.js";
import { isTrustedInariIssuerPrincipal } from "../../issuer-identity.js";
import { readChangeEffectFailureClassification } from "../../change-failure-diagnostics.js";
import {
  changeEffectFailureEvidence,
  type GitHubChangeEffectFailureEvidence,
} from "../../github/change-effect-adapter.js";
import {
  EFFECT_AUTHORIZER_CONTRACT_VERSION,
  INARI_ISSUER_PRINCIPAL,
  assertTrustedExecution,
  type InariEffectAuthorizer,
  type EffectAuthorizerMutationRequest,
  type RepositoryIdentity,
  type TrustedExecutionContext,
} from "../../github/effect-authorizer.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  ChangeExecutionPortError,
  type ChangeEffectEvidence,
  type ChangeExecutionEvidence,
  type ChangeExecutionResult,
  type ChangeExecutionPort,
  type ChangeMutationRequest,
  type ChangeReadRequest,
  hasCallerSuppliedRequester,
  validateChangeRequest,
} from "../../change-execution-port.js";
import {
  executeReadyWithXState,
  type ReadyEffectResult,
  type ReadyExecutionOutcome,
  type ReadyReadResult,
} from "./ready-execution-machine.js";
import {
  executeAbortWithXState,
  type AbortAdmissionResult,
  type AbortEffect,
  type AbortEffectResult,
  type AbortExecutionOutcome,
  type AbortExecutionServices,
  type AbortPlanResult,
  type AbortReadResult,
  type AbortVerificationResult,
} from "./abort-execution-machine.js";
import {
  executeIssuanceWithXState,
  type IssuanceEffect,
  type IssuanceEffectResult,
  type IssuanceExecutionOutcome,
  type IssuanceExecutionServices,
  type IssuanceReadResult,
  type IssuanceRecoveryPlanResult,
} from "./issuance-execution-machine.js";

export interface ChangeTrustedEvidenceReader {
  /** Returns bounded Core projection input; it never returns a GitHub response. */
  read(request: ChangeMutationRequest | ChangeReadRequest): Promise<ChangeProjectionInput>;
  /** Production readers may require the governed root-Issue proof for issuance. */
  readonly requiresGovernedIssueValidation?: boolean;
}

interface ChangeTrustedExecutorOptionsBase {
  readonly reader: ChangeTrustedEvidenceReader;
  readonly execution: TrustedExecutionContext;
  readonly target: RepositoryIdentity;
  /** Existing governed PR mutation authority used only for Change merge composition. */
  readonly semanticPullRequestMutationExecutor?: SemanticPullRequestMutationExecutionPort;
}

export type ChangeTrustedExecutorOptions = ChangeTrustedExecutorOptionsBase &
  /** Canonical App-side effect admission boundary. */
  (
    | {
        readonly effectAuthorizer: Pick<InariEffectAuthorizer, "applyEffects">;
        /** @deprecated Use `effectAuthorizer`. */
        readonly issuerAuthority?: Pick<InariEffectAuthorizer, "applyEffects">;
      }
    /** @deprecated Use `effectAuthorizer`. */
    | {
        readonly effectAuthorizer?: Pick<InariEffectAuthorizer, "applyEffects">;
        readonly issuerAuthority: Pick<InariEffectAuthorizer, "applyEffects">;
      }
  );

export type ChangeTrustedExecutorErrorCode =
  | "CHANGE_EXECUTION_READ_FAILED"
  | "CHANGE_EXECUTION_PRECONDITION_FAILED"
  | "CHANGE_EXECUTION_EFFECT_FAILED"
  | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED"
  | "CHANGE_EXECUTION_RECOVERY_REQUIRED";

export const CHANGE_TRUSTED_EXECUTOR_ERROR_CODES = Object.freeze([
  "CHANGE_EXECUTION_READ_FAILED",
  "CHANGE_EXECUTION_PRECONDITION_FAILED",
  "CHANGE_EXECUTION_EFFECT_FAILED",
  "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  "CHANGE_EXECUTION_RECOVERY_REQUIRED",
] as const);

export function isChangeTrustedExecutorErrorCode(value: unknown): value is ChangeTrustedExecutorErrorCode {
  return CHANGE_TRUSTED_EXECUTOR_ERROR_CODES.includes(value as ChangeTrustedExecutorErrorCode);
}

/** Bounded trusted-execution failure; raw provider/API details are discarded. */
export class ChangeTrustedExecutorError extends Error {
  readonly code: ChangeTrustedExecutorErrorCode;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeExecutionEvidence;

  constructor(
    code: ChangeTrustedExecutorErrorCode,
    message: string,
    diagnostics: readonly ChangeDiagnostic[] = [],
    evidence?: ChangeExecutionEvidence,
  ) {
    super(message);
    this.name = "ChangeTrustedExecutorError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.evidence = evidence;
  }
}

type PlannedChange = ChangeIssuancePlan | ChangeTransitionPlan;

function diagnostic(code: ChangeDiagnostic["code"], path: string, message: string): ChangeDiagnostic {
  return createChangeDiagnostic({ code, path, message });
}

function requestWithProvenance(
  input: ChangeProjectionInput,
  requester: string | undefined,
  issuer: string | undefined,
): ChangeProjectionInput {
  const provenance = {
    ...(input.provenance ?? {}),
    ...(requester === undefined ? {} : { requester }),
    ...(issuer === undefined ? {} : { issuer }),
  };
  return { ...input, provenance };
}

function issueProjectionInput(input: ChangeProjectionInput, requester: string | undefined): ChangeProjectionInput {
  return requestWithProvenance(input, requester, INARI_ISSUER_PRINCIPAL);
}

function projectionIdentity(input: ChangeProjectionInput): ChangeIdentity | undefined {
  const candidate: unknown = input.change;
  const raw =
    typeof candidate === "object" && candidate !== null && "identity" in candidate
      ? (candidate as { readonly identity?: unknown }).identity
      : candidate;
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  return typeof value.repositoryHost === "string" &&
    typeof value.repositoryId === "string" &&
    Number.isSafeInteger(value.rootIssue)
    ? (raw as ChangeIdentity)
    : undefined;
}

function effectEvidence(attempts: readonly ChangeIssuanceEffectAttempt[]): readonly ChangeEffectEvidence[] {
  return attempts.map((attempt) => ({
    kind: attempt.effect.kind,
    status: attempt.status,
    ...(attempt.evidence?.kind === "CREATE_BRANCH" || attempt.evidence?.kind === "CREATE_PROVENANCE_COMMIT"
      ? { createdCommitSha: attempt.evidence.createdCommitSha }
      : {}),
  }));
}

function executionEvidence(
  operation: ChangeMutationRequest["operation"],
  outcome: ChangeExecutionEvidence["outcome"],
  requester: string | undefined,
  effects: readonly ChangeEffectEvidence[],
  compensation: ChangeExecutionEvidence["compensation"] = "not-required",
  failure?: ExecutionFailureEvidence,
  compensationFailure?: ExecutionFailureEvidence,
): ChangeExecutionEvidence {
  return {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation,
    outcome,
    ...(requester === undefined ? {} : { requester }),
    issuer: INARI_ISSUER_PRINCIPAL,
    effects,
    ...(compensation === undefined ? {} : { compensation }),
    ...(failure === undefined
      ? {}
      : {
          failure: {
            kind: failure.effect.kind,
            code: failure.code,
            message: failure.message,
            ...(failure.reason === undefined ? {} : { reason: failure.reason }),
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.provider === undefined ? {} : { provider: failure.provider }),
          },
        }),
    ...(compensationFailure === undefined
      ? {}
      : {
          compensationFailure: {
            kind: compensationFailure.effect.kind,
            code: compensationFailure.code,
            message: compensationFailure.message,
            ...(compensationFailure.reason === undefined ? {} : { reason: compensationFailure.reason }),
            ...(compensationFailure.status === undefined ? {} : { status: compensationFailure.status }),
            ...(compensationFailure.provider === undefined ? {} : { provider: compensationFailure.provider }),
          },
        }),
  };
}

interface ExecutionFailureEvidence {
  readonly effect: { readonly kind: ChangeExecutionEvidence["effects"][number]["kind"] };
  readonly code: string;
  readonly message: string;
  readonly reason?: ChangeIssuanceFailureEvidence["reason"];
  readonly status?: number;
  readonly provider?: ChangeIssuanceFailureEvidence["provider"];
}

function projectionFor(input: ChangeProjectionInput): ChangeProjectionResult {
  return projectChangeFromGitHubEvidence(input);
}

function readyInput(
  input: ChangeProjectionInput,
  change: Change | undefined,
  requester: string | undefined,
): Record<string, unknown> {
  const provenance =
    change === undefined
      ? undefined
      : {
          ...change.provenance,
          ...(requester === undefined ? {} : { requester }),
        };
  const evidence = input.readyEvidence;
  return {
    ...(change === undefined ? {} : { change: { ...change, provenance } }),
    projection: input,
    ...(evidence?.issue === undefined ? {} : { issue: evidence.issue }),
    ...(evidence?.pullRequest === undefined ? {} : { pullRequest: evidence.pullRequest }),
  };
}

function sameIdentity(left: Change | undefined, right: Change | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.identity.repositoryHost === right.identity.repositoryHost &&
    left.identity.repositoryId === right.identity.repositoryId &&
    left.identity.rootIssue === right.identity.rootIssue
  );
}

function expectedProjection(plan: PlannedChange): {
  readonly state: Change["state"];
  readonly branch: string | undefined;
  readonly pullRequest: number | undefined;
} {
  return {
    state: plan.result.state,
    branch: plan.result.projection?.branch,
    pullRequest: plan.result.projection?.pullRequest,
  };
}

function isBranchOnlyAbortRecoveryPlan(plan: PlannedChange): boolean {
  return (
    "request" in plan &&
    plan.request.transition === "abort" &&
    plan.from === "RECOVERY_REQUIRED" &&
    plan.request.change.projection?.branch !== undefined &&
    plan.request.change.projection?.pullRequest === undefined
  );
}

function recoveryProjection(projection: ChangeProjectionResult, change: Change): ChangeProjectionResult {
  const diagnostics =
    projection.diagnostics.length > 0
      ? projection.diagnostics
      : [
          diagnostic(
            "CHANGE_PROJECTION_PARTIAL",
            "$.evidence",
            "A Change effect failed and cleanup requires governed recovery.",
          ),
        ];
  return {
    ...projection,
    valid: false,
    status: "partial",
    change,
    diagnostics,
  };
}

function recoveryChangeForProjection(issuance: ChangeIssuancePlan, projection: ChangeProjectionResult): Change {
  return {
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    identity: issuance.transaction.identity,
    state: "RECOVERY_REQUIRED",
    provenance: projection.change?.provenance ?? issuance.result.provenance,
    ...(projection.change?.projection === undefined ? {} : { projection: projection.change.projection }),
  };
}

function verifyProjection(plan: PlannedChange, projection: ChangeProjectionResult): void {
  const expected = expectedProjection(plan);
  const actual = projection.change;
  const diagnostics: ChangeDiagnostic[] = [];
  const cleanBranchOnlyAbort = isBranchOnlyAbortRecoveryPlan(plan) && isChangeAbortCleanupComplete(projection);
  if ((!projection.valid || projection.status !== "healthy") && !cleanBranchOnlyAbort) {
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PLAN", "$.projection", "Post-effect projection is not a healthy canonical Change."),
    );
  }
  if (!sameIdentity(actual, plan.result)) {
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.identity", "Projection identity differs from the plan."),
    );
  }
  if (actual?.state !== expected.state && !cleanBranchOnlyAbort) {
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.state", "Projection state differs from the plan."),
    );
  }
  if (actual?.projection?.branch !== expected.branch && !cleanBranchOnlyAbort) {
    diagnostics.push(
      diagnostic(
        "CHANGE_INVALID_PLAN",
        "$.projection.change.projection.branch",
        "Projection branch differs from the plan.",
      ),
    );
  }
  for (const role of ["requester", "issuer", "implementer", "reviewer", "merger"] as const) {
    if (plan.result.provenance[role] !== undefined && actual?.provenance[role] !== plan.result.provenance[role]) {
      diagnostics.push(
        diagnostic(
          "CHANGE_INVALID_PROVENANCE",
          `$.projection.change.provenance.${role}`,
          `Projection ${role} provenance differs from the transition plan.`,
        ),
      );
    }
  }
  if ("operation" in plan && plan.operation === "issue" && actual?.provenance.issuer !== INARI_ISSUER_PRINCIPAL) {
    diagnostics.push(
      diagnostic(
        "CHANGE_INVALID_PROVENANCE",
        "$.projection.change.provenance.issuer",
        "The canonical issuance projection is not attributed to the Inari issuer.",
      ),
    );
  }
  if (expected.pullRequest !== undefined && actual?.projection?.pullRequest !== expected.pullRequest) {
    diagnostics.push(
      diagnostic(
        "CHANGE_INVALID_PLAN",
        "$.projection.change.projection.pullRequest",
        "Projection pull request differs from the plan.",
      ),
    );
  }
  if (diagnostics.length > 0) {
    throw new ChangeTrustedExecutorError(
      "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
      "Post-effect Change projection verification failed.",
      diagnostics,
    );
  }
}

function effectAuthorizationRequest(
  execution: TrustedExecutionContext,
  target: RepositoryIdentity,
  effect: ChangeEffect,
): EffectAuthorizerMutationRequest {
  return {
    version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
    authority: "issuer",
    execution,
    target,
    effects: [effect],
  };
}

function failureFor(effect: ChangeEffect): GitHubChangeEffectFailureEvidence {
  return changeEffectFailureEvidence(effect);
}

const DEFAULT_ABORT_READ_FAILURE = {
  code: "CHANGE_EXECUTION_READ_FAILED",
  message: "Trusted Change evidence read failed closed.",
  diagnostics: [],
} as const;

export class TrustedChangeExecutionAdapter implements ChangeExecutionPort {
  readonly #reader: ChangeTrustedEvidenceReader;
  readonly #effectAuthorizer: Pick<InariEffectAuthorizer, "applyEffects">;
  readonly #execution: TrustedExecutionContext;
  readonly #target: RepositoryIdentity;
  readonly #trustedRequester: string | undefined;
  readonly #semanticPullRequestMutationExecutor: SemanticPullRequestMutationExecutionPort | undefined;

  constructor(options: ChangeTrustedExecutorOptions) {
    this.#reader = options.reader;
    const effectAuthorizer = options.effectAuthorizer ?? options.issuerAuthority;
    if (effectAuthorizer === undefined) throw new Error("An Effect Authorizer is required.");
    this.#effectAuthorizer = effectAuthorizer;
    // Canonicalize and freeze the authenticated execution claim once. The
    // requester used by every operation and effect must come from this bound
    // context, not from a mutable caller-owned object.
    this.#execution = assertTrustedExecution(options.execution);
    this.#target = options.target;
    this.#trustedRequester = this.#execution.requester;
    this.#semanticPullRequestMutationExecutor = options.semanticPullRequestMutationExecutor;
  }

  async read(request: ChangeReadRequest): Promise<ChangeProjectionResult> {
    this.assertRequest(request);
    try {
      return projectionFor(await this.readInput(request));
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) throw error;
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_READ_FAILED",
        "Trusted Change evidence read failed closed.",
      );
    }
  }

  async execute(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    this.assertRequest(request);
    if (request.operation === "issue") return this.executeIssue(request);
    if (request.operation === "ready") return this.executeReady(request);
    if (request.operation === "merge") return this.executeMerge(request);
    return this.executeAbort(request);
  }

  /**
   * Validate the caller-controlled request before trusted execution. Requester
   * provenance is deliberately not a request field; legacy or forged payloads
   * fail closed at this boundary instead of being silently ignored.
   */
  private assertRequest(request: ChangeMutationRequest | ChangeReadRequest): void {
    if (hasCallerSuppliedRequester(request)) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Caller-supplied requester identity is not accepted by trusted Change execution.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_CONFLICT",
            "$.requester",
            "Requester provenance must be derived from the authenticated trusted execution context.",
          ),
        ],
      );
    }
    try {
      validateChangeRequest(request);
    } catch (error: unknown) {
      if (error instanceof ChangeExecutionPortError) {
        throw new ChangeTrustedExecutorError(
          "CHANGE_EXECUTION_PRECONDITION_FAILED",
          "Trusted Change request validation failed closed.",
        );
      }
      throw error;
    }
  }

  private async executeReady(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    const outcome: ReadyExecutionOutcome = await executeReadyWithXState({
      request,
      trustedRequester: this.#trustedRequester,
      read: (readyRequest) => this.readReadyInput(readyRequest),
      apply: (effect) => this.applyReadyEffect(effect),
      failureForEffect: (effect) => {
        const failure = failureFor(effect);
        return { code: failure.code, message: failure.message };
      },
      semantics: {
        project: projectionFor,
        validationInput: readyInput,
        validate: validateChangeReadyTransition,
        plan: planChangeReadyTransition,
        verify: (readyRequest, input, projection, plan) => {
          try {
            this.verifyReadyProjection(readyRequest, input, projection, plan);
            return { valid: true, diagnostics: [] };
          } catch (error: unknown) {
            if (error instanceof ChangeTrustedExecutorError) {
              return { valid: false, diagnostics: error.diagnostics, message: error.message };
            }
            return {
              valid: false,
              diagnostics: [],
              message: "Post-effect Ready projection verification failed.",
            };
          }
        },
      },
      results: {
        returnedExisting: (projection) => ({
          projection,
          evidence: executionEvidence(request.operation, "returned-existing", this.#trustedRequester, []),
        }),
        verified: (projection, effect) => ({
          projection,
          evidence: executionEvidence(request.operation, "verified", this.#trustedRequester, [
            { kind: effect.kind, status: "succeeded" },
          ]),
        }),
        failed: (projection, effect, effectFailure) => ({
          projection,
          evidence: executionEvidence(
            request.operation,
            "failed",
            this.#trustedRequester,
            [{ kind: effect.kind, status: "failed" }],
            "not-required",
            {
              effect,
              code: effectFailure.code,
              message: effectFailure.message,
              ...(effectFailure.reason === undefined ? {} : { reason: effectFailure.reason }),
              ...(effectFailure.status === undefined ? {} : { status: effectFailure.status }),
              ...(effectFailure.provider === undefined ? {} : { provider: effectFailure.provider }),
            },
          ),
        }),
      },
    });
    if (outcome.kind === "result") return outcome.result;
    throw new ChangeTrustedExecutorError(outcome.failure.code, outcome.failure.message, outcome.failure.diagnostics);
  }

  private async readReadyInput(request: ChangeMutationRequest): Promise<ReadyReadResult> {
    try {
      return { ok: true, input: await this.readRawInput(request) };
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) {
        return {
          ok: false,
          failure: {
            code: error.code,
            message: error.message,
            diagnostics: error.diagnostics,
          },
        };
      }
      return {
        ok: false,
        failure: {
          code: "CHANGE_EXECUTION_READ_FAILED",
          message: "Trusted Change evidence read failed closed.",
          diagnostics: [],
        },
      };
    }
  }

  private async applyReadyEffect(
    effect: Extract<ChangeEffect, { readonly kind: "MARK_PULL_REQUEST_READY" }>,
  ): Promise<ReadyEffectResult> {
    try {
      await this.#effectAuthorizer.applyEffects(effectAuthorizationRequest(this.#execution, this.#target, effect));
      return { ok: true };
    } catch (error: unknown) {
      const failure = failureFor(effect);
      const classification = readChangeEffectFailureClassification(error);
      return {
        ok: false,
        failure: {
          code: failure.code,
          message: failure.message,
          ...(classification === undefined ? {} : classification),
        },
      };
    }
  }

  private verifyReadyProjection(
    request: ChangeMutationRequest,
    input: ChangeProjectionInput,
    projection: ChangeProjectionResult,
    plan: ChangeTransitionPlan,
  ): void {
    if (projection.change === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Post-effect Change projection verification failed.",
      );
    }
    const validation = validateChangeReadyTransition(readyInput(input, projection.change, this.#trustedRequester));
    if (!validation.valid || projection.change.state !== "REVIEW") {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Post-effect Ready projection verification failed.",
        validation.diagnostics,
      );
    }
    verifyProjection(plan, projection);
  }

  private async readInput(request: ChangeMutationRequest | ChangeReadRequest): Promise<ChangeProjectionInput> {
    try {
      const input = requestWithProvenance(await this.#reader.read(request), this.#trustedRequester, undefined);
      const projection = projectionFor(input);
      if (projection.change?.identity.rootIssue !== request.issue) {
        throw new ChangeTrustedExecutorError(
          "CHANGE_EXECUTION_READ_FAILED",
          "Trusted Change evidence identity does not match the semantic request.",
        );
      }
      return input;
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) throw error;
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_READ_FAILED",
        "Trusted Change evidence read failed closed.",
      );
    }
  }

  /** Read normalized evidence without projecting it; the Ready actor owns the next projection state. */
  private async readRawInput(request: ChangeMutationRequest): Promise<ChangeProjectionInput> {
    try {
      return requestWithProvenance(await this.#reader.read(request), this.#trustedRequester, undefined);
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) throw error;
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_READ_FAILED",
        "Trusted Change evidence read failed closed.",
      );
    }
  }

  private async executeMerge(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    const input = await this.readRawInput(request);
    const projection = projectionFor(input);
    const change = projection.change;
    if (change === undefined || !projection.valid || projection.status !== "healthy") {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "A healthy canonical Change projection is required before merge admission.",
        projection.diagnostics,
      );
    }
    if (change.identity.rootIssue !== request.issue) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_READ_FAILED",
        "Trusted Change evidence identity does not match the semantic request.",
      );
    }
    if (change.state !== "REVIEW" && change.state !== "ACCEPTED" && change.state !== "MERGED") {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Change merge is admitted only from REVIEW, ACCEPTED, or a proven MERGED replay.",
        [
          diagnostic(
            "CHANGE_TRANSITION_NOT_ALLOWED",
            "$.change.state",
            `Merge is not allowed from Change state "${change.state}".`,
          ),
        ],
      );
    }

    const readyEvidence = input.readyEvidence;
    if (readyEvidence === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Governed pull-request evidence is required before merge admission.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_INVALID_PR_CONTRACT",
            "$.readyEvidence.pullRequest",
            "The canonical pull-request contract and body were not supplied.",
          ),
        ],
      );
    }
    const admission = validateChangeMergeAdmission({
      change,
      projection: input,
      pullRequest: readyEvidence.pullRequest,
    });
    if (!admission.valid || admission.change === undefined || admission.projection === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Change merge admission failed closed.",
        admission.diagnostics,
      );
    }

    const canonicalBranch = admission.change.projection?.branch;
    const canonicalPullRequest = admission.change.projection?.pullRequest;
    const canonicalBaseBranch = admission.projection.canonicalBaseBranch;
    const physicalPullRequest = admission.physicalPullRequest;
    const branchCandidate = admission.projection.candidates.branches.find(
      (candidate) => candidate.classification === "canonical" && candidate.candidate.name === canonicalBranch,
    );
    const expectedHead = physicalPullRequest?.headSha ?? branchCandidate?.candidate.sha;
    if (
      canonicalBranch === undefined ||
      canonicalPullRequest === undefined ||
      canonicalBaseBranch === undefined ||
      physicalPullRequest === undefined ||
      expectedHead === undefined
    ) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Canonical pull-request head, base, and identity evidence are required before merge.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_CONFLICT",
            "$.projection.candidates",
            "The canonical pull-request head generation is unavailable or ambiguous.",
          ),
        ],
      );
    }
    if (request.mergeStrategy === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Change merge strategy is required.",
      );
    }
    if (this.#semanticPullRequestMutationExecutor === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "The governed Semantic PR merge authority is unavailable.",
      );
    }

    let mergePlan: SemanticPullRequestMutationPlan;
    try {
      mergePlan = planSemanticPullRequestMutation({
        version: "1",
        operation: "merge",
        repository: {
          hostname: this.#target.repositoryHost,
          nameWithOwner: this.#target.nameWithOwner,
          repositoryId: this.#target.repositoryId,
        },
        pullRequest: canonicalPullRequest,
        expectedHead,
        expectedBase: canonicalBaseBranch,
        strategy: request.mergeStrategy,
      });
    } catch {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "The canonical Semantic PR merge plan could not be prepared.",
        [
          diagnostic(
            "CHANGE_INVALID_PLAN",
            "$.semanticPullRequestMergePlan",
            "The canonical Semantic PR merge plan is invalid.",
          ),
        ],
      );
    }

    if (change.state !== "MERGED") {
      try {
        planChangeTransition({
          version: CHANGE_TRANSITION_CONTRACT_VERSION,
          transition: "merge",
          change: admission.change,
          target: {
            branch: canonicalBranch,
            baseBranch: canonicalBaseBranch,
            pullRequest: canonicalPullRequest,
            semanticPullRequestMergePlan: mergePlan,
          },
        });
      } catch {
        throw new ChangeTrustedExecutorError(
          "CHANGE_EXECUTION_PRECONDITION_FAILED",
          "Change merge transition planning failed closed.",
          [
            diagnostic(
              "CHANGE_INVALID_PLAN",
              "$.target.semanticPullRequestMergePlan",
              "The merge plan is not bound to the canonical Change projection.",
            ),
          ],
        );
      }
    }

    let semanticResult: SemanticPullRequestMutationResult;
    try {
      semanticResult = await this.#semanticPullRequestMutationExecutor.execute({
        version: "1",
        plan: mergePlan,
      });
    } catch (error: unknown) {
      if (error instanceof SemanticPullRequestMutationError) {
        const executionCode =
          error.outcome === "recovery-required"
            ? "CHANGE_EXECUTION_RECOVERY_REQUIRED"
            : error.outcome === "stale" || error.outcome === "blocked"
              ? "CHANGE_EXECUTION_PRECONDITION_FAILED"
              : "CHANGE_EXECUTION_EFFECT_FAILED";
        const diagnostics = error.diagnostics.map((entry) =>
          diagnostic(
            entry.code === "PR_MUTATION_STALE_HEAD" || entry.code === "PR_MUTATION_STALE_BASE"
              ? "CHANGE_PROVENANCE_CONFLICT"
              : "CHANGE_INVALID_PLAN",
            entry.path,
            entry.message,
          ),
        );
        const evidence = executionEvidence(
          request.operation,
          error.outcome === "recovery-required" ? "recovery-required" : "failed",
          this.#trustedRequester,
          [{ kind: "MERGE_PULL_REQUEST", status: "failed" }],
          error.outcome === "recovery-required" ? "failed" : "not-required",
          {
            effect: { kind: "MERGE_PULL_REQUEST" },
            code: error.code,
            message: error.message,
          },
        );
        throw new ChangeTrustedExecutorError(
          executionCode,
          "Governed Semantic PR merge execution failed closed.",
          diagnostics,
          evidence,
        );
      }
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_EFFECT_FAILED",
        "Governed Semantic PR merge execution failed closed.",
        [],
        executionEvidence(
          request.operation,
          "failed",
          this.#trustedRequester,
          [{ kind: "MERGE_PULL_REQUEST", status: "failed" }],
          "not-required",
          {
            effect: { kind: "MERGE_PULL_REQUEST" },
            code: "PR_MUTATION_EFFECT_FAILED",
            message: "Merge effect failed.",
          },
        ),
      );
    }

    const currentHead = semanticResult.current.headSha ?? semanticResult.current.head;
    if (
      semanticResult.current.number !== canonicalPullRequest ||
      currentHead !== expectedHead ||
      semanticResult.current.base !== canonicalBaseBranch ||
      semanticResult.current.state !== "closed"
    ) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Semantic PR merge postcondition did not prove the canonical merged pull request.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_CONFLICT",
            "$.semanticPullRequestMutation.current",
            "The merged pull-request postcondition differs from the canonical Change head or base.",
          ),
        ],
        executionEvidence(
          request.operation,
          "recovery-required",
          this.#trustedRequester,
          [{ kind: "MERGE_PULL_REQUEST", status: "failed" }],
          "failed",
          {
            effect: { kind: "MERGE_PULL_REQUEST" },
            code: "PR_MUTATION_POSTCONDITION_FAILED",
            message: "Merged postcondition was not proven.",
          },
        ),
      );
    }

    let finalInput: ChangeProjectionInput;
    try {
      finalInput = await this.readRawInput(request);
    } catch {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        "Merge effect completed without an authoritative Change reread.",
        [],
        executionEvidence(
          request.operation,
          "recovery-required",
          this.#trustedRequester,
          [{ kind: "MERGE_PULL_REQUEST", status: "succeeded" }],
          "failed",
          {
            effect: { kind: "MERGE_PULL_REQUEST" },
            code: "PR_MUTATION_POSTCONDITION_READ_FAILED",
            message: "Merged Change projection reread failed.",
          },
        ),
      );
    }
    const finalProjection = projectionFor(finalInput);
    const finalAdmissionEvidence = finalInput.readyEvidence;
    const finalChange = finalProjection.change;
    const finalAdmission =
      finalChange === undefined || finalAdmissionEvidence === undefined
        ? { valid: false, diagnostics: finalProjection.diagnostics }
        : validateChangeMergeAdmission({
            change: finalChange,
            projection: finalInput,
            pullRequest: finalAdmissionEvidence.pullRequest,
          });
    if (
      !finalProjection.valid ||
      finalProjection.status !== "healthy" ||
      finalChange?.state !== "MERGED" ||
      !finalAdmission.valid ||
      finalChange.projection?.pullRequest !== canonicalPullRequest ||
      finalChange.projection?.branch !== canonicalBranch
    ) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Post-merge Change projection verification failed.",
        finalAdmission.diagnostics.length > 0 ? finalAdmission.diagnostics : finalProjection.diagnostics,
        executionEvidence(
          request.operation,
          "recovery-required",
          this.#trustedRequester,
          [{ kind: "MERGE_PULL_REQUEST", status: "succeeded" }],
          "failed",
          {
            effect: { kind: "MERGE_PULL_REQUEST" },
            code: "PR_MUTATION_POSTCONDITION_FAILED",
            message: "Merged Change projection was not proven.",
          },
        ),
      );
    }
    return {
      projection: finalProjection,
      evidence: executionEvidence(
        request.operation,
        semanticResult.outcome === "idempotent" ? "returned-existing" : "verified",
        this.#trustedRequester,
        semanticResult.outcome === "idempotent" ? [] : [{ kind: "MERGE_PULL_REQUEST", status: "succeeded" }],
      ),
    };
  }

  private async executeAbort(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    const results: AbortExecutionServices["results"] = {
      returnedExisting: (projection) => ({
        projection,
        evidence: executionEvidence(request.operation, "returned-existing", this.#trustedRequester, []),
      }),
      verified: (projection, attempts) => ({
        projection,
        evidence: executionEvidence(request.operation, "verified", this.#trustedRequester, effectEvidence(attempts)),
      }),
      recoveryRequired: (projection, attempts, failure) => ({
        projection,
        evidence: executionEvidence(
          request.operation,
          "recovery-required",
          this.#trustedRequester,
          effectEvidence(attempts),
          "failed",
          {
            effect: failure.effect,
            code: failure.code,
            message: failure.message,
            ...(failure.reason === undefined ? {} : { reason: failure.reason }),
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.provider === undefined ? {} : { provider: failure.provider }),
          },
        ),
      }),
    };
    const services: AbortExecutionServices = {
      request,
      read: (abortRequest) => this.readAbortInput(abortRequest),
      apply: (effect) => this.applyAbortEffect(effect),
      failureForEffect: (effect) => {
        const failure = failureFor(effect);
        return { code: failure.code, message: failure.message };
      },
      recoveryReadFailure: (abortRequest, attempts, failure) => ({
        code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        message: "A failed Change transition could not be bounded for recovery.",
        diagnostics: [],
        evidence: executionEvidence(
          abortRequest.operation,
          "recovery-required",
          this.#trustedRequester,
          effectEvidence(attempts),
          "failed",
          {
            effect: failure.effect,
            code: failure.code,
            message: failure.message,
            ...(failure.reason === undefined ? {} : { reason: failure.reason }),
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.provider === undefined ? {} : { provider: failure.provider }),
          },
        ),
      }),
      semantics: {
        project: projectionFor,
        classify: (projection): AbortAdmissionResult => {
          const recoveryRetry = classifyChangeAbortRecovery(projection) !== undefined;
          if ((!projection.valid || projection.change === undefined) && !recoveryRetry) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                message: "A valid canonical Change projection is required before a lifecycle transition.",
                diagnostics: projection.diagnostics,
              },
            };
          }
          if (projection.change === undefined) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                message: "A canonical Change snapshot is required before a lifecycle transition.",
                diagnostics: projection.diagnostics,
              },
            };
          }
          if (!isTrustedInariIssuerPrincipal(projection.change.provenance.issuer)) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                message: "The canonical Change issuer provenance is not trusted.",
                diagnostics: [
                  diagnostic(
                    "CHANGE_PROVENANCE_ISSUER_MISMATCH",
                    "$.projection.change.provenance.issuer",
                    "The canonical Change issuer provenance is not trusted.",
                  ),
                ],
              },
            };
          }
          return {
            ok: true,
            phase: isChangeAbortCleanupComplete(projection) ? "clean" : recoveryRetry ? "recovery" : "normal",
          };
        },
        plan: (abortRequest, projection): AbortPlanResult => {
          if (projection.change === undefined) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                message: "A canonical Change snapshot is required before an abort transition.",
                diagnostics: projection.diagnostics,
              },
            };
          }
          const change = {
            ...projection.change,
            provenance: {
              ...projection.change.provenance,
              ...(this.#trustedRequester === undefined ? {} : { requester: this.#trustedRequester }),
            },
          } satisfies Change;
          try {
            const plan = planChangeTransition({
              version: CHANGE_TRANSITION_CONTRACT_VERSION,
              transition: abortRequest.operation,
              change,
              target: {
                ...(projection.change.projection?.branch === undefined
                  ? {}
                  : { branch: projection.change.projection.branch }),
                ...(projection.change.projection?.pullRequest === undefined
                  ? {}
                  : { pullRequest: projection.change.projection.pullRequest }),
              },
            });
            return { ok: true, plan };
          } catch (error: unknown) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                message: "Abort transition planning failed closed.",
                diagnostics: error instanceof ChangeTrustedExecutorError ? error.diagnostics : [],
              },
            };
          }
        },
        recover: (abortRequest, transition, attempts, failed, failedInput) => {
          const failureEvidence: ChangeIssuanceFailureEvidence = {
            effect: failed.effect,
            code: failed.code,
            message: failed.message,
            ...(failed.reason === undefined ? {} : { reason: failed.reason }),
            ...(failed.status === undefined ? {} : { status: failed.status }),
            ...(failed.provider === undefined ? {} : { provider: failed.provider }),
          };
          const evidence = executionEvidence(
            abortRequest.operation,
            "recovery-required",
            this.#trustedRequester,
            effectEvidence(attempts),
            "failed",
            failureEvidence,
          );
          try {
            const recovery = planChangeRecovery({
              transition,
              attemptedEffects: attempts,
              failure: failureEvidence,
              projection: failedInput,
            });
            if (!("transition" in recovery)) {
              return {
                ok: false,
                failure: {
                  code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                  message: "A failed Change transition produced an invalid recovery authority result.",
                  diagnostics: [],
                  evidence,
                },
              };
            }
            const projection = projectionFor(failedInput);
            return {
              ok: true,
              result: results.recoveryRequired(
                recoveryProjection(projection, recovery.result.change),
                attempts,
                failed,
              ),
            };
          } catch (error: unknown) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                message: "A failed Change transition could not produce a bounded recovery plan.",
                diagnostics: error instanceof ChangeTrustedExecutorError ? error.diagnostics : [],
                evidence,
              },
            };
          }
        },
        verify: (abortRequest, _input, projection, plan): AbortVerificationResult => {
          try {
            verifyProjection(plan, projection);
            return { valid: true, diagnostics: [] };
          } catch (error: unknown) {
            if (error instanceof ChangeTrustedExecutorError) {
              return { valid: false, diagnostics: error.diagnostics, message: error.message };
            }
            return {
              valid: false,
              diagnostics: [],
              message: "Post-effect Abort projection verification failed.",
            };
          }
        },
      },
      results,
    };
    const outcome: AbortExecutionOutcome = await executeAbortWithXState(services);
    if (outcome.kind === "result") return outcome.result;
    throw new ChangeTrustedExecutorError(
      outcome.failure.code,
      outcome.failure.message,
      outcome.failure.diagnostics,
      outcome.failure.evidence,
    );
  }

  private async readAbortInput(request: ChangeMutationRequest): Promise<AbortReadResult> {
    try {
      const input = await this.readRawInput(request);
      // A branch-only recovery has no PR from which to recover issuer
      // provenance. Bind the trusted issuer only when the reader supplied no
      // issuer claim; an explicit untrusted claim remains rejectable below.
      return {
        ok: true,
        input:
          input.provenance?.issuer === undefined
            ? requestWithProvenance(input, this.#trustedRequester, INARI_ISSUER_PRINCIPAL)
            : input,
      };
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) {
        return {
          ok: false,
          failure: {
            code: error.code,
            message: error.message,
            diagnostics: error.diagnostics,
            evidence: error.evidence,
          },
        };
      }
      return { ok: false, failure: { ...DEFAULT_ABORT_READ_FAILURE } };
    }
  }

  private async applyAbortEffect(effect: AbortEffect): Promise<AbortEffectResult> {
    try {
      await this.#effectAuthorizer.applyEffects(effectAuthorizationRequest(this.#execution, this.#target, effect));
      return { ok: true };
    } catch (error: unknown) {
      const failure = failureFor(effect);
      const classification = readChangeEffectFailureClassification(error);
      return {
        ok: false,
        failure: {
          code: failure.code,
          message: failure.message,
          ...(classification === undefined ? {} : classification),
        },
      };
    }
  }

  private async executeIssue(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    const services: IssuanceExecutionServices = {
      request,
      trustedRequester: this.#trustedRequester,
      read: (issuanceRequest) => this.readIssuanceInput(issuanceRequest),
      apply: (effect) => this.applyIssuanceEffect(effect),
      failureForEffect: (effect) => {
        const failure = failureFor(effect);
        return { code: failure.code, message: failure.message };
      },
      semantics: {
        project: projectionFor,
        validateGovernance: (issuanceInput) => this.validateIssuanceGovernance(issuanceInput),
        validateGovernanceDrift: (initial, fresh) => validateIssuanceGovernanceDrift(initial, fresh),
        plan: (issuanceInput, requester) => {
          try {
            return { ok: true, plan: planChangeIssuance(issueProjectionInput(issuanceInput, requester)) };
          } catch (error: unknown) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                message: "Change issuance planning failed closed.",
                diagnostics: error instanceof ChangeIssuanceValidationError ? error.diagnostics : [],
              },
            };
          }
        },
        verify: (issuanceRequest, issuanceInput, projection, plan) => {
          try {
            verifyProjection(plan, projection);
            return { valid: true, diagnostics: [] };
          } catch (error: unknown) {
            if (error instanceof ChangeTrustedExecutorError) {
              return { valid: false, diagnostics: error.diagnostics, message: error.message };
            }
            return {
              valid: false,
              diagnostics: [],
              message: "Post-effect Change issuance projection verification failed.",
            };
          }
        },
        classifyEffectFailureProjection: (projection) =>
          projection.status === "absent" && projection.valid && projection.change?.state === "DEFINED"
            ? "confirmed-absent"
            : "unresolved",
        planRecovery: (recoveryInput): IssuanceRecoveryPlanResult => {
          try {
            const plan = planChangeIssuanceRecovery({
              issuance: recoveryInput.issuance,
              attemptedEffects: recoveryInput.attempts,
              failure: recoveryInput.failure,
              projection: recoveryInput.projectionInput,
              ...(recoveryInput.compensation === undefined
                ? {}
                : {
                    compensation: {
                      status: recoveryInput.compensation.status,
                      projection: recoveryInput.compensation.projectionInput,
                      ...(recoveryInput.compensation.failure === undefined
                        ? {}
                        : { failure: recoveryInput.compensation.failure }),
                    },
                  }),
            });
            return { ok: true, plan };
          } catch (error: unknown) {
            return {
              ok: false,
              failure: {
                code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                message: "A failed Change issuance could not produce a bounded recovery plan.",
                diagnostics: error instanceof ChangeIssuanceRecoveryValidationError ? error.diagnostics : [],
              },
            };
          }
        },
      },
      results: {
        returnedExisting: (projection) => ({
          projection,
          evidence: executionEvidence(request.operation, "returned-existing", this.#trustedRequester, []),
        }),
        verified: (projection, attempts) => ({
          projection,
          evidence: executionEvidence(request.operation, "verified", this.#trustedRequester, effectEvidence(attempts)),
        }),
        effectFailed: (attempts, failure) => ({
          code: "CHANGE_EXECUTION_EFFECT_FAILED",
          message: "A Change effect failed before a compensable partial issuance was established.",
          diagnostics: [],
          evidence: executionEvidence(
            request.operation,
            "failed",
            this.#trustedRequester,
            effectEvidence(attempts),
            "not-required",
            failure,
          ),
        }),
        compensated: (projection, attempts, failure) => ({
          projection,
          evidence: executionEvidence(
            request.operation,
            "compensated",
            this.#trustedRequester,
            effectEvidence(attempts),
            "succeeded",
            failure,
          ),
        }),
        recoveryRequired: (projection, attempts, failure, compensationStatus, compensationFailure) => ({
          projection,
          evidence: executionEvidence(
            request.operation,
            compensationStatus === "succeeded" ? "compensated" : "recovery-required",
            this.#trustedRequester,
            effectEvidence(attempts),
            compensationStatus,
            failure,
            compensationFailure,
          ),
        }),
        recoveryUnsafe: (plan, projection, attempts, failure, compensationStatus, compensationFailure) => ({
          projection: recoveryProjection(projection, recoveryChangeForProjection(plan, projection)),
          evidence: executionEvidence(
            request.operation,
            "recovery-required",
            this.#trustedRequester,
            effectEvidence(attempts),
            compensationStatus,
            failure,
            compensationFailure,
          ),
        }),
        recoveryReadFailure: (attempts, failure, compensationStatus, compensationFailure) => ({
          code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
          message:
            compensationStatus === undefined
              ? "Issuance failed and its partial projection could not be bounded for recovery."
              : "Issuance compensation completed without bounded post-compensation evidence.",
          diagnostics: [],
          evidence: executionEvidence(
            request.operation,
            "recovery-required",
            this.#trustedRequester,
            effectEvidence(attempts),
            compensationStatus ?? "failed",
            failure,
            compensationFailure,
          ),
        }),
      },
    };
    const outcome: IssuanceExecutionOutcome = await executeIssuanceWithXState(services);
    if (outcome.kind === "result") return outcome.result;
    throw new ChangeTrustedExecutorError(
      outcome.failure.code,
      outcome.failure.message,
      outcome.failure.diagnostics,
      outcome.failure.evidence,
    );
  }

  private validateIssuanceGovernance(input: ChangeProjectionInput): readonly ChangeDiagnostic[] {
    return this.#reader.requiresGovernedIssueValidation || input.governedIssue !== undefined
      ? validateGovernedRootIssueEvidence(input.governedIssue, projectionIdentity(input), input.baseBranch)
      : [];
  }

  private async readIssuanceInput(request: ChangeMutationRequest): Promise<IssuanceReadResult> {
    try {
      return { ok: true, input: await this.readRawInput(request) };
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) {
        return {
          ok: false,
          failure: { code: error.code, message: error.message, diagnostics: error.diagnostics },
        };
      }
      return {
        ok: false,
        failure: {
          code: "CHANGE_EXECUTION_READ_FAILED",
          message: "Trusted Change evidence read failed closed.",
          diagnostics: [],
        },
      };
    }
  }

  private async applyIssuanceEffect(effect: IssuanceEffect): Promise<IssuanceEffectResult> {
    try {
      const mutation = await this.#effectAuthorizer.applyEffects(
        effectAuthorizationRequest(this.#execution, this.#target, effect),
      );
      const evidence = mutation.effects[0]?.evidence;
      return { ok: true, ...(evidence === undefined ? {} : { evidence }) };
    } catch (error: unknown) {
      const failure = failureFor(effect);
      const classification = readChangeEffectFailureClassification(error);
      return {
        ok: false,
        failure: {
          code: failure.code,
          message: failure.message,
          ...(classification === undefined ? {} : classification),
        },
      };
    }
  }
}

function validateIssuanceGovernanceDrift(
  initial: ChangeProjectionInput,
  fresh: ChangeProjectionInput,
): readonly ChangeDiagnostic[] {
  const diagnostics: ChangeDiagnostic[] = [];
  const validatedGeneration = initial.governedIssue?.contract.provenance?.treeSha;
  const freshGeneration = fresh.governedIssue?.contract.provenance?.treeSha;
  if (validatedGeneration !== undefined && freshGeneration !== validatedGeneration) {
    diagnostics.push(
      diagnostic(
        "CHANGE_PROVENANCE_CONFLICT",
        "$.governedIssue.contract.provenance.treeSha",
        "The validated root Issue governance generation changed before issuance.",
      ),
    );
  }
  const semanticPullRequestPlan = fresh.semanticPullRequestPlan;
  if (
    semanticPullRequestPlan !== undefined &&
    (fresh.governedIssue?.contract.provenance?.treeSha === undefined ||
      semanticPullRequestPlan.generation.treeSha !== fresh.governedIssue.contract.provenance.treeSha)
  ) {
    diagnostics.push(
      diagnostic(
        "CHANGE_PROVENANCE_CONFLICT",
        "$.semanticPullRequestPlan.generation.treeSha",
        "The Semantic PR plan generation does not match the trusted repository generation.",
      ),
    );
  }
  return diagnostics;
}
