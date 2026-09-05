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
  planChangeTransition,
  projectChangeFromGitHubEvidence,
  type Change,
  type ChangeDiagnostic,
  type ChangeEffect,
  type ChangeIssuanceEffectAttempt,
  type ChangeIssuanceFailureEvidence,
  type ChangeIssuancePlan,
  type ChangeIssuanceRecoveryPlan,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
  type ChangeTransitionPlan,
} from "./change.js";
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

export interface ChangeTrustedEvidenceReader {
  /** Returns bounded Core projection input; it never returns a GitHub response. */
  read(request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest): Promise<ChangeProjectionInput>;
}

export interface ChangeTrustedExecutorOptions {
  readonly reader: ChangeTrustedEvidenceReader;
  readonly issuerAuthority: Pick<InariIssuerAppAuthority, "applyEffects">;
  readonly execution: TrustedExecutionContext;
  readonly target: IssuerRepositoryIdentity;
}

export type ChangeTrustedExecutorErrorCode =
  | "CHANGE_EXECUTION_READ_FAILED"
  | "CHANGE_EXECUTION_EFFECT_FAILED"
  | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED"
  | "CHANGE_EXECUTION_RECOVERY_REQUIRED";

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

function effectEvidence(attempts: readonly ChangeIssuanceEffectAttempt[]): readonly ChangeRemoteEffectEvidence[] {
  return attempts.map((attempt) => ({ kind: attempt.effect.kind, status: attempt.status }));
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

  async execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    const input = await this.readInput(request);
    if (request.operation === "issue") return this.executeIssue(request, input);
    const current = projectionFor(input);
    if (!current.valid || current.change === undefined) {
      throw new ChangeTrustedExecutorError(
        "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "A valid canonical Change projection is required before a lifecycle transition.",
        current.diagnostics,
      );
    }
    const plan = planChangeTransition({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      transition: request.operation,
      change: {
        ...current.change,
        provenance: {
          ...current.change.provenance,
          ...(request.requester === undefined ? {} : { requester: request.requester }),
        },
      },
      target: {
        ...(current.change.projection?.branch === undefined ? {} : { branch: current.change.projection.branch }),
        ...(current.change.projection?.pullRequest === undefined
          ? {}
          : { pullRequest: current.change.projection.pullRequest }),
      },
    });
    return this.executeTransition(request, plan, input);
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

  private async executeIssue(
    request: ChangeRemoteMutationRequest,
    input: ChangeProjectionInput,
  ): Promise<ChangeRemoteExecutionResult> {
    const plan = planChangeIssuance(issueProjectionInput(input, request.requester));
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
        await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
        attempts.push({ effect, status: "succeeded" });
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
    let recovery: ChangeIssuanceRecoveryPlan = planChangeIssuanceRecovery({
      issuance,
      attemptedEffects: attempts,
      failure,
      projection: failedProjectionInput,
    });
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
    const projection = projectionFor(compensatedProjectionInput);
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

  private async executeTransition(
    request: ChangeRemoteMutationRequest,
    plan: ChangeTransitionPlan,
    input: ChangeProjectionInput,
  ): Promise<ChangeRemoteExecutionResult> {
    void input;
    const attempts: ChangeIssuanceEffectAttempt[] = [];
    for (const effect of plan.effects) {
      try {
        await this.#issuerAuthority.applyEffects(issuerMutation(this.#execution, this.#target, effect));
        attempts.push({ effect, status: "succeeded" });
      } catch {
        attempts.push({ effect, status: "failed" });
        const failure = failureFor(effect);
        return {
          projection: projectionFor(await this.readInput(request)),
          evidence: executionEvidence(
            request.operation,
            "failed",
            request.requester,
            effectEvidence(attempts),
            "not-required",
            failure,
          ),
        };
      }
    }
    const after = projectionFor(await this.readInput(request));
    verifyProjection(plan, after);
    return {
      projection: after,
      evidence: executionEvidence(request.operation, "verified", request.requester, effectEvidence(attempts)),
    };
  }
}

export const GitHubActionsChangeExecutor = TrustedChangeExecutor;
