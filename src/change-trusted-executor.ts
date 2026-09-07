/**
 * Trusted Change execution orchestration.
 *
 * This module is the executable boundary between the semantic Core contracts,
 * the #216 effect adapter, and the #217 issuer authority. It owns sequencing
 * only. Naming, lifecycle validity, idempotency, compensation, and projection
 * semantics remain delegated to the existing Core authorities.
 */

import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  createChangeDiagnostic,
  planChangeIssuance,
  planChangeIssuanceRecovery,
  planChangeRecovery,
  planChangeReadyTransition,
  planChangeTransition,
  projectChangeFromGitHubEvidence,
  validateGovernedRootIssueEvidence,
  validateChangeReadyTransition,
  type Change,
  type ChangeDiagnostic,
  type ChangeEffect,
  type ChangeIdentity,
  type ChangeIssuanceEffectAttempt,
  type ChangeIssuanceFailureEvidence,
  type ChangeIssuancePlan,
  type ChangeIssuanceRecoveryPlan,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
  type ChangeTransitionPlan,
} from "./change.js";
import { isTrustedInariIssuerPrincipal } from "./issuer-identity.js";
import { changeEffectFailureEvidence, type GitHubChangeEffectFailureEvidence } from "./github/change-effect-adapter.js";
import {
  ISSUER_AUTHORITY_CONTRACT_VERSION,
  INARI_ISSUER_PRINCIPAL,
  type InariIssuerAppAuthority,
  type IssuerMutationRequest,
  type IssuerRepositoryIdentity,
  type TrustedExecutionContext,
} from "./github/issuer-authority.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  type ChangeRemoteEffectEvidence,
  type ChangeRemoteExecutionEvidence,
  type ChangeRemoteExecutionResult,
  type ChangeRemoteExecutor,
  type ChangeRemoteMutationRequest,
  type ChangeRemoteReadRequest,
} from "./change-executor.js";
import {
  executeReadyWithXState,
  type ReadyEffectResult,
  type ReadyExecutionOutcome,
  type ReadyReadResult,
} from "./change/machine/ready-execution-machine.js";
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
} from "./change/machine/abort-execution-machine.js";

export interface ChangeTrustedEvidenceReader {
  /** Returns bounded Core projection input; it never returns a GitHub response. */
  read(request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest): Promise<ChangeProjectionInput>;
  /** Production readers may require the governed root-Issue proof for issuance. */
  readonly requiresGovernedIssueValidation?: boolean;
}

export interface ChangeTrustedExecutorOptions {
  readonly reader: ChangeTrustedEvidenceReader;
  readonly issuerAuthority: Pick<InariIssuerAppAuthority, "applyEffects">;
  readonly execution: TrustedExecutionContext;
  readonly target: IssuerRepositoryIdentity;
}

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

/** Bounded trusted-execution failure; provider/API details are discarded. */
export class ChangeTrustedExecutorError extends Error {
  readonly code: ChangeTrustedExecutorErrorCode;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeRemoteExecutionEvidence;

  constructor(
    code: ChangeTrustedExecutorErrorCode,
    message: string,
    diagnostics: readonly ChangeDiagnostic[] = [],
    evidence?: ChangeRemoteExecutionEvidence,
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

function effectEvidence(attempts: readonly ChangeIssuanceEffectAttempt[]): readonly ChangeRemoteEffectEvidence[] {
  return attempts.map((attempt) => ({
    kind: attempt.effect.kind,
    status: attempt.status,
    ...(attempt.evidence?.kind === "CREATE_BRANCH" ? { createdCommitSha: attempt.evidence.createdCommitSha } : {}),
  }));
}

function executionEvidence(
  operation: ChangeRemoteMutationRequest["operation"],
  outcome: ChangeRemoteExecutionEvidence["outcome"],
  requester: string | undefined,
  effects: readonly ChangeRemoteEffectEvidence[],
  compensation: ChangeRemoteExecutionEvidence["compensation"] = "not-required",
  failure?: ChangeIssuanceFailureEvidence,
): ChangeRemoteExecutionEvidence {
  return {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
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
          },
        }),
  };
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

function isAbortCleanupRecoveryProjection(projection: ChangeProjectionResult): boolean {
  if (!projection.valid && projection.status !== "partial") return false;
  if (projection.change?.state !== "RECOVERY_REQUIRED" || projection.canonicalBranch === undefined) return false;
  const canonicalBranches = projection.candidates.branches.filter(
    (candidate) => candidate.classification === "canonical" && candidate.candidate.name === projection.canonicalBranch,
  );
  const canonicalPullRequests = projection.candidates.pullRequests.filter(
    (candidate) =>
      candidate.classification === "canonical" &&
      candidate.candidate.state === "closed" &&
      candidate.candidate.merged === false,
  );
  return canonicalBranches.length === 1 && canonicalPullRequests.length === 1;
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
  if (!projection.valid || projection.status !== "healthy") {
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PLAN", "$.projection", "Post-effect projection is not a healthy canonical Change."),
    );
  }
  if (!sameIdentity(actual, plan.result)) {
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.identity", "Projection identity differs from the plan."),
    );
  }
  if (actual?.state !== expected.state) {
    diagnostics.push(
      diagnostic("CHANGE_INVALID_PLAN", "$.projection.change.state", "Projection state differs from the plan."),
    );
  }
  if (actual?.projection?.branch !== expected.branch) {
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

function issuerMutation(
  execution: TrustedExecutionContext,
  target: IssuerRepositoryIdentity,
  effect: ChangeEffect,
): IssuerMutationRequest {
  return {
    version: ISSUER_AUTHORITY_CONTRACT_VERSION,
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

export class TrustedChangeExecutor implements ChangeRemoteExecutor {
  readonly #reader: ChangeTrustedEvidenceReader;
  readonly #issuerAuthority: Pick<InariIssuerAppAuthority, "applyEffects">;
  readonly #execution: TrustedExecutionContext;
  readonly #target: IssuerRepositoryIdentity;

  constructor(options: ChangeTrustedExecutorOptions) {
    this.#reader = options.reader;
    this.#issuerAuthority = options.issuerAuthority;
    this.#execution = options.execution;
    this.#target = options.target;
  }

  async read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult> {
    const boundRequest = this.bindRequester(request);
    try {
      return projectionFor(await this.readInput(boundRequest));
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) throw error;
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_READ_FAILED",
        "Trusted Change evidence read failed closed.",
      );
    }
  }

  async execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    const boundRequest = this.bindRequester(request);
    if (boundRequest.operation === "issue") return this.executeIssue(boundRequest);
    if (boundRequest.operation === "ready") return this.executeReady(boundRequest);
    return this.executeAbort(boundRequest);
  }

  /**
   * Bind semantic provenance to the authenticated trusted runtime actor.
   * Caller input may corroborate that identity, but can never replace it.
   */
  private bindRequester<T extends ChangeRemoteMutationRequest | ChangeRemoteReadRequest>(request: T): T {
    const trustedRequester = this.#execution.requester;
    if (trustedRequester !== undefined && request.requester !== undefined && request.requester !== trustedRequester) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "The Change requester does not match the trusted execution actor.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_CONFLICT",
            "$.requester",
            "Caller requester provenance does not match the authenticated trusted actor.",
          ),
        ],
      );
    }
    if (trustedRequester === undefined || request.requester === trustedRequester) return request;
    return { ...request, requester: trustedRequester } as T;
  }

  private async executeReady(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    const outcome: ReadyExecutionOutcome = await executeReadyWithXState({
      request,
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
          evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
        }),
        verified: (projection, effect) => ({
          projection,
          evidence: executionEvidence(request.operation, "verified", request.requester, [
            { kind: effect.kind, status: "succeeded" },
          ]),
        }),
        failed: (projection, effect, effectFailure) => ({
          projection,
          evidence: executionEvidence(
            request.operation,
            "failed",
            request.requester,
            [{ kind: effect.kind, status: "failed" }],
            "not-required",
            { effect, code: effectFailure.code, message: effectFailure.message },
          ),
        }),
      },
    });
    if (outcome.kind === "result") return outcome.result;
    throw new ChangeTrustedExecutorError(outcome.failure.code, outcome.failure.message, outcome.failure.diagnostics);
  }

  private async readReadyInput(request: ChangeRemoteMutationRequest): Promise<ReadyReadResult> {
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
      await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
      return { ok: true };
    } catch {
      const failure = failureFor(effect);
      return { ok: false, failure: { code: failure.code, message: failure.message } };
    }
  }

  private verifyReadyProjection(
    request: ChangeRemoteMutationRequest,
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
    const validation = validateChangeReadyTransition(readyInput(input, projection.change, request.requester));
    if (!validation.valid || projection.change.state !== "REVIEW") {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Post-effect Ready projection verification failed.",
        validation.diagnostics,
      );
    }
    verifyProjection(plan, projection);
  }

  private async readInput(
    request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest,
  ): Promise<ChangeProjectionInput> {
    try {
      const input = requestWithProvenance(await this.#reader.read(request), request.requester, undefined);
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
  private async readRawInput(request: ChangeRemoteMutationRequest): Promise<ChangeProjectionInput> {
    try {
      return requestWithProvenance(await this.#reader.read(request), request.requester, undefined);
    } catch (error: unknown) {
      if (error instanceof ChangeTrustedExecutorError) throw error;
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_READ_FAILED",
        "Trusted Change evidence read failed closed.",
      );
    }
  }

  private async executeAbort(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    const results: AbortExecutionServices["results"] = {
      returnedExisting: (projection) => ({
        projection,
        evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
      }),
      verified: (projection, attempts) => ({
        projection,
        evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
      }),
      recoveryRequired: (projection, attempts, failure) => ({
        projection,
        evidence: executionEvidence(
          request.operation,
          "recovery-required",
          request.requester,
          effectEvidence(attempts),
          "failed",
          { effect: failure.effect, code: failure.code, message: failure.message },
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
          abortRequest.requester,
          effectEvidence(attempts),
          "failed",
          { effect: failure.effect, code: failure.code, message: failure.message },
        ),
      }),
      semantics: {
        project: projectionFor,
        classify: (projection): AbortAdmissionResult => {
          const recoveryRetry = isAbortCleanupRecoveryProjection(projection);
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
          return { ok: true, phase: recoveryRetry ? "recovery" : "normal" };
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
          try {
            const plan = planChangeTransition({
              version: CHANGE_TRANSITION_CONTRACT_VERSION,
              transition: abortRequest.operation,
              change: {
                ...projection.change,
                provenance: {
                  ...projection.change.provenance,
                  ...(abortRequest.requester === undefined ? {} : { requester: abortRequest.requester }),
                },
              },
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
          };
          const evidence = executionEvidence(
            abortRequest.operation,
            "recovery-required",
            abortRequest.requester,
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

  private async readAbortInput(request: ChangeRemoteMutationRequest): Promise<AbortReadResult> {
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
            evidence: error.evidence,
          },
        };
      }
      return { ok: false, failure: { ...DEFAULT_ABORT_READ_FAILURE } };
    }
  }

  private async applyAbortEffect(effect: AbortEffect): Promise<AbortEffectResult> {
    try {
      await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
      return { ok: true };
    } catch {
      const failure = failureFor(effect);
      return { ok: false, failure: { code: failure.code, message: failure.message } };
    }
  }

  private async executeIssue(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    const input = await this.readInput(request);
    const rootIssueDiagnostics =
      this.#reader.requiresGovernedIssueValidation || input.governedIssue !== undefined
        ? validateGovernedRootIssueEvidence(input.governedIssue, projectionIdentity(input), input.baseBranch)
        : [];
    if (rootIssueDiagnostics.length > 0) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Governed root Issue validation failed before Change issuance planning.",
        rootIssueDiagnostics,
      );
    }

    // Re-read the complete trusted evidence immediately before planning. The
    // contract provenance carries the governance generation; a changed
    // template/native source therefore cannot authorize the first effect.
    const freshInput = await this.readInput(request);
    const freshRootIssueDiagnostics =
      this.#reader.requiresGovernedIssueValidation || freshInput.governedIssue !== undefined
        ? validateGovernedRootIssueEvidence(
            freshInput.governedIssue,
            projectionIdentity(freshInput),
            freshInput.baseBranch,
          )
        : [];
    if (freshRootIssueDiagnostics.length > 0) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Governed root Issue validation changed before Change issuance planning.",
        freshRootIssueDiagnostics,
      );
    }
    const validatedGeneration = input.governedIssue?.contract.provenance?.treeSha;
    const freshGeneration = freshInput.governedIssue?.contract.provenance?.treeSha;
    if (validatedGeneration !== undefined && freshGeneration !== validatedGeneration) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Repository governance changed before Change issuance planning.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_CONFLICT",
            "$.governedIssue.contract.provenance.treeSha",
            "The validated root Issue governance generation changed before issuance.",
          ),
        ],
      );
    }
    const semanticPullRequestPlan = freshInput.semanticPullRequestPlan;
    if (
      semanticPullRequestPlan !== undefined &&
      (freshInput.governedIssue?.contract.provenance?.treeSha === undefined ||
        semanticPullRequestPlan.generation.treeSha !== freshInput.governedIssue.contract.provenance.treeSha)
    ) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PRECONDITION_FAILED",
        "Semantic PR plan generation changed before Change issuance planning.",
        [
          diagnostic(
            "CHANGE_PROVENANCE_CONFLICT",
            "$.semanticPullRequestPlan.generation.treeSha",
            "The Semantic PR plan generation does not match the trusted repository generation.",
          ),
        ],
      );
    }
    const plannedInput = freshInput;
    const plan = planChangeIssuance(issueProjectionInput(plannedInput, request.requester));
    if (plan.mode === "return-existing") {
      const after = projectionFor(await this.readInput(request));
      verifyProjection(plan, after);
      return {
        projection: after,
        evidence: executionEvidence(request.operation, "returned-existing", request.requester, []),
      };
    }

    const attempts: ChangeIssuanceEffectAttempt[] = [];
    for (const effect of plan.effects) {
      try {
        const mutation = await this.#issuerAuthority.applyEffects(
          issuerMutation(this.#execution, this.#target, effect),
        );
        const evidence = mutation.effects[0]?.evidence;
        attempts.push({ effect, status: "succeeded", ...(evidence === undefined ? {} : { evidence }) });
      } catch {
        attempts.push({ effect, status: "failed" });
        return this.recoverIssuance(request, plan, attempts, failureFor(effect));
      }
    }

    const after = projectionFor(await this.readInput(request));
    verifyProjection(plan, after);
    return {
      projection: after,
      evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
    };
  }

  private async recoverIssuance(
    request: ChangeRemoteMutationRequest,
    issuance: ChangeIssuancePlan,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: ChangeIssuanceFailureEvidence,
  ): Promise<ChangeRemoteExecutionResult> {
    if (attempts.length !== 2 || attempts[0]?.status !== "succeeded") {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_EFFECT_FAILED",
        "A Change effect failed before a compensable partial issuance was established.",
        [],
        executionEvidence(
          request.operation,
          "failed",
          request.requester,
          effectEvidence(attempts),
          "not-required",
          failure,
        ),
      );
    }
    let failedProjectionInput: ChangeProjectionInput;
    try {
      failedProjectionInput = await this.readInput(request);
    } catch {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        "Issuance failed and its partial projection could not be bounded for recovery.",
        [],
        executionEvidence(
          request.operation,
          "recovery-required",
          request.requester,
          effectEvidence(attempts),
          "failed",
          failure,
        ),
      );
    }
    let recovery: ChangeIssuanceRecoveryPlan;
    try {
      recovery = planChangeIssuanceRecovery({
        issuance,
        attemptedEffects: attempts,
        failure,
        projection: failedProjectionInput,
      });
    } catch {
      const projection = projectionFor(failedProjectionInput);
      return {
        projection: recoveryProjection(projection, recoveryChangeForProjection(issuance, projection)),
        evidence: executionEvidence(
          request.operation,
          "recovery-required",
          request.requester,
          effectEvidence(attempts),
          "failed",
          failure,
        ),
      };
    }
    const compensationEffect = recovery.compensation.plan.effects[0];
    if (compensationEffect === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        "Issuance recovery did not produce an explicit compensation effect.",
        [],
        executionEvidence(
          request.operation,
          "recovery-required",
          request.requester,
          effectEvidence(attempts),
          "failed",
          failure,
        ),
      );
    }

    let compensationFailure: ChangeIssuanceFailureEvidence | undefined;
    let compensationStatus: "succeeded" | "failed" = "succeeded";
    try {
      await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, compensationEffect));
    } catch {
      compensationStatus = "failed";
      compensationFailure = failureFor(compensationEffect);
    }

    let compensatedProjectionInput: ChangeProjectionInput;
    try {
      compensatedProjectionInput = await this.readInput(request);
    } catch {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        "Issuance compensation completed without bounded post-compensation evidence.",
        [],
        executionEvidence(
          request.operation,
          "recovery-required",
          request.requester,
          effectEvidence(attempts),
          compensationStatus,
          failure,
        ),
      );
    }
    const projection = projectionFor(compensatedProjectionInput);
    try {
      recovery = planChangeIssuanceRecovery({
        issuance,
        attemptedEffects: attempts,
        failure,
        projection: failedProjectionInput,
        compensation: {
          status: compensationStatus,
          projection: compensatedProjectionInput,
          ...(compensationFailure === undefined ? {} : { failure: compensationFailure }),
        },
      });
    } catch {
      return {
        projection: recoveryProjection(projection, recoveryChangeForProjection(issuance, projection)),
        evidence: executionEvidence(
          request.operation,
          "recovery-required",
          request.requester,
          effectEvidence(attempts),
          compensationStatus,
          failure,
        ),
      };
    }
    const evidence = executionEvidence(
      request.operation,
      compensationStatus === "succeeded" ? "compensated" : "recovery-required",
      request.requester,
      effectEvidence(attempts),
      compensationStatus,
      failure,
    );
    return { projection, evidence };
  }
}

export const GitHubActionsChangeExecutor = TrustedChangeExecutor;
