import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import type {
  ChangeDiagnostic,
  ChangeEffect,
  ChangeEffectSuccessEvidence,
  ChangeIssuanceEffectAttempt,
  ChangeIssuanceFailureEvidence,
  ChangeIssuancePlan,
  ChangeIssuanceRecoveryPlan,
  ChangeProjectionInput,
  ChangeProjectionResult,
} from "../../change.js";
import type { ChangeRemoteExecutionResult, ChangeRemoteMutationRequest } from "../../change-executor.js";

export type IssuanceExecutionFailureCode =
  | "CHANGE_EXECUTION_READ_FAILED"
  | "CHANGE_EXECUTION_PRECONDITION_FAILED"
  | "CHANGE_EXECUTION_EFFECT_FAILED"
  | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED"
  | "CHANGE_EXECUTION_RECOVERY_REQUIRED";

export interface IssuanceExecutionFailure {
  readonly code: IssuanceExecutionFailureCode;
  readonly message: string;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeRemoteExecutionResult["evidence"];
}

/** The two ordered create-mode issuance effects; DELETE_BRANCH is compensation-only. */
export type IssuanceCreateEffect = Extract<ChangeEffect, { readonly kind: "CREATE_BRANCH" | "CREATE_PULL_REQUEST" }>;
export type IssuanceCompensationEffect = Extract<ChangeEffect, { readonly kind: "DELETE_BRANCH" }>;
export type IssuanceEffect = IssuanceCreateEffect | IssuanceCompensationEffect;

export interface IssuanceReadSuccess {
  readonly ok: true;
  readonly input: ChangeProjectionInput;
}

export interface IssuanceReadFailure {
  readonly ok: false;
  readonly failure: IssuanceExecutionFailure;
}

export type IssuanceReadResult = IssuanceReadSuccess | IssuanceReadFailure;

export interface IssuanceEffectSuccess {
  readonly ok: true;
  readonly evidence?: ChangeEffectSuccessEvidence;
}

export interface IssuanceEffectFailureResult {
  readonly ok: false;
  readonly failure: { readonly code: string; readonly message: string };
}

export type IssuanceEffectResult = IssuanceEffectSuccess | IssuanceEffectFailureResult;

export interface IssuancePlanSuccess {
  readonly ok: true;
  readonly plan: ChangeIssuancePlan;
}

export interface IssuancePlanFailure {
  readonly ok: false;
  readonly failure: IssuanceExecutionFailure;
}

export type IssuancePlanResult = IssuancePlanSuccess | IssuancePlanFailure;

export interface IssuanceRecoveryPlanSuccess {
  readonly ok: true;
  readonly plan: ChangeIssuanceRecoveryPlan;
}

export interface IssuanceRecoveryPlanFailure {
  readonly ok: false;
  readonly failure: IssuanceExecutionFailure;
}

export type IssuanceRecoveryPlanResult = IssuanceRecoveryPlanSuccess | IssuanceRecoveryPlanFailure;

export interface IssuanceRecoveryPlanInput {
  readonly issuance: ChangeIssuancePlan;
  readonly attempts: readonly ChangeIssuanceEffectAttempt[];
  readonly failure: ChangeIssuanceFailureEvidence;
  readonly projectionInput: ChangeProjectionInput;
  readonly compensation?: {
    readonly status: "succeeded" | "failed";
    readonly projectionInput: ChangeProjectionInput;
    readonly failure?: ChangeIssuanceFailureEvidence;
  };
}

export interface IssuanceVerificationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly message?: string;
}

/** Classification of authoritative evidence rechecked after an effect failure. */
export type IssuanceEffectFailureProjectionClass = "confirmed-absent" | "unresolved";

export interface IssuanceExecutionSemantics {
  readonly project: (input: ChangeProjectionInput) => ChangeProjectionResult;
  /** Governed root-Issue validation; Core owns the exact rule. */
  readonly validateGovernance: (input: ChangeProjectionInput) => readonly ChangeDiagnostic[];
  /** Anti-drift check between the initial and immediately-pre-plan reads. */
  readonly validateGovernanceDrift: (
    initial: ChangeProjectionInput,
    fresh: ChangeProjectionInput,
  ) => readonly ChangeDiagnostic[];
  readonly plan: (input: ChangeProjectionInput, requester: string | undefined) => IssuancePlanResult;
  readonly verify: (
    request: ChangeRemoteMutationRequest,
    input: ChangeProjectionInput,
    projection: ChangeProjectionResult,
    plan: ChangeIssuancePlan,
  ) => IssuanceVerificationResult;
  /** Classifies rechecked evidence after a CREATE_BRANCH effect failure. */
  readonly classifyEffectFailureProjection: (
    projection: ChangeProjectionResult,
  ) => IssuanceEffectFailureProjectionClass;
  readonly planRecovery: (input: IssuanceRecoveryPlanInput) => IssuanceRecoveryPlanResult;
}

export interface IssuanceExecutionResults {
  readonly returnedExisting: (projection: ChangeProjectionResult) => ChangeRemoteExecutionResult;
  readonly verified: (
    projection: ChangeProjectionResult,
    attempts: readonly ChangeIssuanceEffectAttempt[],
  ) => ChangeRemoteExecutionResult;
  /** Bounded thrown failure for a CREATE_BRANCH failure confirmed to have applied no effect. */
  readonly effectFailed: (
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: ChangeIssuanceFailureEvidence,
  ) => IssuanceExecutionFailure;
  readonly compensated: (
    projection: ChangeProjectionResult,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: ChangeIssuanceFailureEvidence,
  ) => ChangeRemoteExecutionResult;
  /** Core-validated recovery-required outcome; the reread projection is used as-is. */
  readonly recoveryRequired: (
    projection: ChangeProjectionResult,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: ChangeIssuanceFailureEvidence,
    compensationStatus: "succeeded" | "failed",
  ) => ChangeRemoteExecutionResult;
  /**
   * Recovery-required outcome for evidence Core could not validate as a safe
   * compensation/recovery result; a bounded synthetic RECOVERY_REQUIRED
   * projection is substituted instead of trusting the raw reread shape.
   */
  readonly recoveryUnsafe: (
    plan: ChangeIssuancePlan,
    projection: ChangeProjectionResult,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: ChangeIssuanceFailureEvidence,
    compensationStatus: "succeeded" | "failed",
  ) => ChangeRemoteExecutionResult;
  /** Bounded thrown failure when repository evidence cannot be reread after an effect failure. */
  readonly recoveryReadFailure: (
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: ChangeIssuanceFailureEvidence,
    compensationStatus?: "succeeded" | "failed",
  ) => IssuanceExecutionFailure;
}

export interface IssuanceExecutionServices {
  readonly request: ChangeRemoteMutationRequest;
  /** The read actor is the only machine boundary for repository evidence I/O. */
  readonly read: (request: ChangeRemoteMutationRequest) => Promise<IssuanceReadResult>;
  /** The effect actor is the only machine boundary for privileged GitHub mutation. */
  readonly apply: (effect: IssuanceEffect) => Promise<IssuanceEffectResult>;
  readonly failureForEffect: (effect: IssuanceEffect) => { readonly code: string; readonly message: string };
  readonly semantics: IssuanceExecutionSemantics;
  readonly results: IssuanceExecutionResults;
}

export type IssuanceExecutionOutcome =
  | { readonly kind: "result"; readonly result: ChangeRemoteExecutionResult }
  | { readonly kind: "failure"; readonly failure: IssuanceExecutionFailure };

interface IssuanceMachineContext {
  readonly services: IssuanceExecutionServices;
  readonly initialInput?: ChangeProjectionInput;
  readonly freshInput?: ChangeProjectionInput;
  readonly plan?: ChangeIssuancePlan;
  readonly effectIndex: number;
  readonly attempts: readonly ChangeIssuanceEffectAttempt[];
  readonly effectFailure?: ChangeIssuanceFailureEvidence;
  readonly failureInput?: ChangeProjectionInput;
  readonly failureProjection?: ChangeProjectionResult;
  readonly compensationEffect?: IssuanceCompensationEffect;
  readonly compensationStatus?: "succeeded" | "failed";
  readonly compensationFailure?: ChangeIssuanceFailureEvidence;
  readonly compensationInput?: ChangeProjectionInput;
  readonly readInput?: ChangeProjectionInput;
  readonly recoveryPlanOk?: boolean;
  readonly failure?: IssuanceExecutionFailure;
  readonly result?: ChangeRemoteExecutionResult;
  readonly outcome?: IssuanceExecutionOutcome;
}

const readEvidence = fromPromise<IssuanceReadResult, IssuanceExecutionServices>(({ input }) =>
  input.read(input.request),
);

const applyIssuanceEffect = fromPromise<
  IssuanceEffectResult,
  { readonly services: IssuanceExecutionServices; readonly effect: IssuanceEffect }
>(({ input }) => input.services.apply(input.effect));

const DEFAULT_READ_FAILURE: IssuanceExecutionFailure = {
  code: "CHANGE_EXECUTION_READ_FAILED",
  message: "Trusted Change evidence read failed closed.",
  diagnostics: [],
};

const DEFAULT_RECOVERY_REQUIRED_FAILURE: IssuanceExecutionFailure = {
  code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
  message: "A failed Change issuance could not be bounded for recovery.",
  diagnostics: [],
};

function defaultVerificationFailure(
  message = "Post-effect Change issuance projection verification failed.",
): IssuanceExecutionFailure {
  return { code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", message, diagnostics: [] };
}

function defaultPreconditionFailure(message = "Change issuance preconditions failed."): IssuanceExecutionFailure {
  return { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message, diagnostics: [] };
}

/** A read boundary check, not semantic classification: evidence must describe the requested Change. */
function identityMismatchFailure(
  context: IssuanceMachineContext,
  input: ChangeProjectionInput,
): IssuanceExecutionFailure | undefined {
  const projection = context.services.semantics.project(input);
  return projection.change?.identity.rootIssue === context.services.request.issue
    ? undefined
    : {
        code: "CHANGE_EXECUTION_READ_FAILED",
        message: "Trusted Change evidence identity does not match the semantic request.",
        diagnostics: [],
      };
}

function createEffectAt(context: IssuanceMachineContext): IssuanceCreateEffect | undefined {
  const effect = context.plan?.effects[context.effectIndex];
  return effect?.kind === "CREATE_BRANCH" || effect?.kind === "CREATE_PULL_REQUEST" ? effect : undefined;
}

function appendAttempt(
  context: IssuanceMachineContext,
  effect: IssuanceCreateEffect,
  status: "succeeded" | "failed",
  evidence?: ChangeEffectSuccessEvidence,
): readonly ChangeIssuanceEffectAttempt[] {
  return [...context.attempts, { effect, status, ...(evidence === undefined ? {} : { evidence }) }];
}

function failedEffectEvidence(
  effect: IssuanceEffect,
  failure: { readonly code: string; readonly message: string },
): ChangeIssuanceFailureEvidence {
  return { effect, code: failure.code, message: failure.message };
}

const issuanceExecutionMachine = setup({
  types: {
    context: {} as IssuanceMachineContext,
    input: {} as IssuanceExecutionServices,
  },
  actors: {
    readEvidence,
    applyIssuanceEffect,
  },
}).createMachine({
  id: "change-issuance-execution",
  initial: "readingInitial",
  context: ({ input }) => ({ services: input, effectIndex: 0, attempts: [] }),
  output: ({ context }): IssuanceExecutionOutcome =>
    context.outcome ?? {
      kind: "failure",
      failure: defaultVerificationFailure("Change issuance execution machine failed closed."),
    },
  states: {
    readingInitial: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "validatingInitialGovernance",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              initialInput: ({ event }) => (event.output.ok ? event.output.input : undefined),
              failure: undefined,
            }),
          },
          {
            target: "readFailed",
            actions: assign({
              failure: ({ event }) => (event.output.ok ? DEFAULT_READ_FAILURE : event.output.failure),
            }),
          },
        ],
        onError: { target: "readFailed", actions: assign({ failure: DEFAULT_READ_FAILURE }) },
      },
    },
    validatingInitialGovernance: {
      entry: assign(({ context }) => {
        const input = context.initialInput;
        if (input === undefined) return { failure: DEFAULT_READ_FAILURE };
        const identityFailure = identityMismatchFailure(context, input);
        if (identityFailure !== undefined) return { failure: identityFailure };
        const diagnostics = context.services.semantics.validateGovernance(input);
        return diagnostics.length > 0
          ? {
              failure: {
                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                message: "Governed root Issue validation failed before Change issuance planning.",
                diagnostics,
              } satisfies IssuanceExecutionFailure,
            }
          : { failure: undefined };
      }),
      always: [
        { target: "readingFresh", guard: ({ context }) => context.failure === undefined },
        { target: "readFailed", guard: ({ context }) => context.failure?.code === "CHANGE_EXECUTION_READ_FAILED" },
        { target: "preconditionFailed" },
      ],
    },
    readingFresh: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "validatingFreshGovernance",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              freshInput: ({ event }) => (event.output.ok ? event.output.input : undefined),
              failure: undefined,
            }),
          },
          {
            target: "readFailed",
            actions: assign({
              failure: ({ event }) => (event.output.ok ? DEFAULT_READ_FAILURE : event.output.failure),
            }),
          },
        ],
        onError: { target: "readFailed", actions: assign({ failure: DEFAULT_READ_FAILURE }) },
      },
    },
    validatingFreshGovernance: {
      entry: assign(({ context }) => {
        const fresh = context.freshInput;
        const initial = context.initialInput;
        if (fresh === undefined || initial === undefined) return { failure: DEFAULT_READ_FAILURE };
        const identityFailure = identityMismatchFailure(context, fresh);
        if (identityFailure !== undefined) return { failure: identityFailure };
        const diagnostics = [
          ...context.services.semantics.validateGovernance(fresh),
          ...context.services.semantics.validateGovernanceDrift(initial, fresh),
        ];
        return diagnostics.length > 0
          ? {
              failure: {
                code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                message: "Repository governance changed before Change issuance planning.",
                diagnostics,
              } satisfies IssuanceExecutionFailure,
            }
          : { failure: undefined };
      }),
      always: [
        { target: "planning", guard: ({ context }) => context.failure === undefined },
        { target: "readFailed", guard: ({ context }) => context.failure?.code === "CHANGE_EXECUTION_READ_FAILED" },
        { target: "preconditionFailed" },
      ],
    },
    planning: {
      entry: assign(({ context }) => {
        const fresh = context.freshInput;
        if (fresh === undefined) return { plan: undefined, failure: DEFAULT_READ_FAILURE };
        const planned = context.services.semantics.plan(fresh, context.services.request.requester);
        return planned.ok ? { plan: planned.plan, failure: undefined } : { plan: undefined, failure: planned.failure };
      }),
      always: [
        {
          target: "rereading",
          guard: ({ context }) => context.plan !== undefined && context.plan.effects.length === 0,
        },
        {
          target: "applyingEffect",
          guard: ({ context }) => context.plan !== undefined && context.plan.effects.length > 0,
        },
        { target: "preconditionFailed" },
      ],
    },
    applyingEffect: {
      invoke: {
        src: "applyIssuanceEffect",
        input: ({ context }) => ({ services: context.services, effect: createEffectAt(context)! }),
        onDone: [
          {
            target: "nextEffect",
            guard: ({ event }) => event.output.ok,
            actions: assign(({ context, event }) => {
              const effect = createEffectAt(context);
              if (effect === undefined) return { failure: defaultVerificationFailure("Invalid issuance effect.") };
              const evidence = event.output.ok ? event.output.evidence : undefined;
              return { attempts: appendAttempt(context, effect, "succeeded", evidence), effectFailure: undefined };
            }),
          },
          {
            target: "rereadingAfterFailure",
            actions: assign(({ context, event }) => {
              const effect = createEffectAt(context);
              if (effect === undefined) return { failure: defaultVerificationFailure("Invalid issuance effect.") };
              const failure = event.output.ok ? context.services.failureForEffect(effect) : event.output.failure;
              return {
                attempts: appendAttempt(context, effect, "failed"),
                effectFailure: failedEffectEvidence(effect, failure),
              };
            }),
          },
        ],
        onError: {
          target: "rereadingAfterFailure",
          actions: assign(({ context }) => {
            const effect = createEffectAt(context);
            if (effect === undefined) return { failure: defaultVerificationFailure("Invalid issuance effect.") };
            return {
              attempts: appendAttempt(context, effect, "failed"),
              effectFailure: failedEffectEvidence(effect, context.services.failureForEffect(effect)),
            };
          }),
        },
      },
    },
    nextEffect: {
      always: [
        {
          target: "applyingEffect",
          guard: ({ context }) => context.plan !== undefined && context.effectIndex + 1 < context.plan.effects.length,
          actions: assign({ effectIndex: ({ context }) => context.effectIndex + 1 }),
        },
        { target: "rereading" },
      ],
    },
    rereading: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "verifying",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              readInput: ({ event }) => (event.output.ok ? event.output.input : undefined),
              failure: undefined,
            }),
          },
          {
            target: "readFailed",
            actions: assign({
              failure: ({ event }) => (event.output.ok ? DEFAULT_READ_FAILURE : event.output.failure),
            }),
          },
        ],
        onError: { target: "readFailed", actions: assign({ failure: DEFAULT_READ_FAILURE }) },
      },
    },
    verifying: {
      entry: assign(({ context }) => {
        const freshInput = context.freshInput;
        const readInput = context.readInput;
        const plan = context.plan;
        if (freshInput === undefined || readInput === undefined || plan === undefined) {
          return { failure: defaultVerificationFailure() };
        }
        const projection = context.services.semantics.project(readInput);
        const verification = context.services.semantics.verify(context.services.request, freshInput, projection, plan);
        if (!verification.valid) {
          return {
            result: undefined,
            failure: {
              code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
              message: verification.message ?? "Post-effect Change issuance projection verification failed.",
              diagnostics: verification.diagnostics,
            } satisfies IssuanceExecutionFailure,
          };
        }
        const result =
          plan.effects.length === 0
            ? context.services.results.returnedExisting(projection)
            : context.services.results.verified(projection, context.attempts);
        return { result, failure: undefined };
      }),
      always: [
        { target: "succeeded", guard: ({ context }) => context.result !== undefined && context.failure === undefined },
        { target: "verificationFailed" },
      ],
    },
    rereadingAfterFailure: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "classifyingFailure",
            guard: ({ event }) => event.output.ok,
            actions: assign({ failureInput: ({ event }) => (event.output.ok ? event.output.input : undefined) }),
          },
          {
            target: "recoveryReadFailed",
            actions: assign(({ context }) =>
              context.effectFailure === undefined
                ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
                : { failure: context.services.results.recoveryReadFailure(context.attempts, context.effectFailure) },
            ),
          },
        ],
        onError: {
          target: "recoveryReadFailed",
          actions: assign(({ context }) =>
            context.effectFailure === undefined
              ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
              : { failure: context.services.results.recoveryReadFailure(context.attempts, context.effectFailure) },
          ),
        },
      },
    },
    classifyingFailure: {
      entry: assign(({ context }) => {
        const input = context.failureInput;
        return { failureProjection: input === undefined ? undefined : context.services.semantics.project(input) };
      }),
      always: [
        {
          target: "planningCompensation",
          guard: ({ context }) => context.plan !== undefined && context.attempts.length === context.plan.effects.length,
        },
        {
          target: "branchEffectFailed",
          guard: ({ context }) =>
            context.failureProjection !== undefined &&
            context.services.semantics.classifyEffectFailureProjection(context.failureProjection) ===
              "confirmed-absent",
        },
        { target: "branchRecoveryRequired" },
      ],
    },
    planningCompensation: {
      entry: assign(({ context }) => {
        const plan = context.plan;
        const input = context.failureInput;
        const failure = context.effectFailure;
        if (plan === undefined || input === undefined || failure === undefined) {
          return { compensationEffect: undefined };
        }
        const planned = context.services.semantics.planRecovery({
          issuance: plan,
          attempts: context.attempts,
          failure,
          projectionInput: input,
        });
        if (!planned.ok) return { compensationEffect: undefined };
        const effect = planned.plan.compensation.plan.effects[0];
        return { compensationEffect: effect?.kind === "DELETE_BRANCH" ? effect : undefined };
      }),
      always: [
        { target: "applyingCompensation", guard: ({ context }) => context.compensationEffect !== undefined },
        { target: "compensationUnsafeResult" },
      ],
    },
    applyingCompensation: {
      invoke: {
        src: "applyIssuanceEffect",
        input: ({ context }) => ({ services: context.services, effect: context.compensationEffect! }),
        onDone: [
          {
            target: "rereadingAfterCompensation",
            guard: ({ event }) => event.output.ok,
            actions: assign({ compensationStatus: "succeeded", compensationFailure: undefined }),
          },
          {
            target: "rereadingAfterCompensation",
            actions: assign(({ context, event }) => ({
              compensationStatus: "failed",
              compensationFailure: failedEffectEvidence(
                context.compensationEffect!,
                event.output.ok ? context.services.failureForEffect(context.compensationEffect!) : event.output.failure,
              ),
            })),
          },
        ],
        onError: {
          target: "rereadingAfterCompensation",
          actions: assign(({ context }) => ({
            compensationStatus: "failed",
            compensationFailure: failedEffectEvidence(
              context.compensationEffect!,
              context.services.failureForEffect(context.compensationEffect!),
            ),
          })),
        },
      },
    },
    rereadingAfterCompensation: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "planningRecoveryOutcome",
            guard: ({ event }) => event.output.ok,
            actions: assign({ compensationInput: ({ event }) => (event.output.ok ? event.output.input : undefined) }),
          },
          {
            target: "recoveryReadFailed",
            actions: assign(({ context }) =>
              context.effectFailure === undefined
                ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
                : {
                    failure: context.services.results.recoveryReadFailure(
                      context.attempts,
                      context.effectFailure,
                      context.compensationStatus,
                    ),
                  },
            ),
          },
        ],
        onError: {
          target: "recoveryReadFailed",
          actions: assign(({ context }) =>
            context.effectFailure === undefined
              ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
              : {
                  failure: context.services.results.recoveryReadFailure(
                    context.attempts,
                    context.effectFailure,
                    context.compensationStatus,
                  ),
                },
          ),
        },
      },
    },
    planningRecoveryOutcome: {
      entry: assign(({ context }) => {
        const plan = context.plan;
        const input = context.failureInput;
        const failure = context.effectFailure;
        const compensationInput = context.compensationInput;
        const compensationStatus = context.compensationStatus;
        if (
          plan === undefined ||
          input === undefined ||
          failure === undefined ||
          compensationInput === undefined ||
          compensationStatus === undefined
        ) {
          return { recoveryPlanOk: false };
        }
        const planned = context.services.semantics.planRecovery({
          issuance: plan,
          attempts: context.attempts,
          failure,
          projectionInput: input,
          compensation: {
            status: compensationStatus,
            projectionInput: compensationInput,
            ...(context.compensationFailure === undefined ? {} : { failure: context.compensationFailure }),
          },
        });
        return { recoveryPlanOk: planned.ok };
      }),
      always: [
        {
          target: "compensatedResult",
          guard: ({ context }) => context.recoveryPlanOk === true && context.compensationStatus === "succeeded",
        },
        { target: "recoveryRequiredAfterCompensationResult" },
      ],
    },
    compensatedResult: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => {
        const input = context.compensationInput;
        const failure = context.effectFailure;
        if (input === undefined || failure === undefined) {
          return { outcome: { kind: "failure", failure: defaultVerificationFailure() } };
        }
        const projection = context.services.semantics.project(input);
        return {
          outcome: {
            kind: "result",
            result: context.services.results.compensated(projection, context.attempts, failure),
          },
        };
      }),
    },
    recoveryRequiredAfterCompensationResult: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => {
        const input = context.compensationInput;
        const failure = context.effectFailure;
        const plan = context.plan;
        if (input === undefined || failure === undefined || plan === undefined) {
          return { outcome: { kind: "failure", failure: DEFAULT_RECOVERY_REQUIRED_FAILURE } };
        }
        const projection = context.services.semantics.project(input);
        const compensationStatus = context.compensationStatus ?? "failed";
        const result =
          context.recoveryPlanOk === true
            ? context.services.results.recoveryRequired(projection, context.attempts, failure, compensationStatus)
            : context.services.results.recoveryUnsafe(plan, projection, context.attempts, failure, compensationStatus);
        return { outcome: { kind: "result", result } };
      }),
    },
    compensationUnsafeResult: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => {
        const projection = context.failureProjection;
        const failure = context.effectFailure;
        const plan = context.plan;
        if (projection === undefined || failure === undefined || plan === undefined) {
          return { outcome: { kind: "failure", failure: DEFAULT_RECOVERY_REQUIRED_FAILURE } };
        }
        return {
          outcome: {
            kind: "result",
            result: context.services.results.recoveryUnsafe(plan, projection, context.attempts, failure, "failed"),
          },
        };
      }),
    },
    branchEffectFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => {
        const failure = context.effectFailure;
        if (failure === undefined) return { outcome: { kind: "failure", failure: defaultVerificationFailure() } };
        return {
          outcome: { kind: "failure", failure: context.services.results.effectFailed(context.attempts, failure) },
        };
      }),
    },
    branchRecoveryRequired: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => {
        const projection = context.failureProjection;
        const failure = context.effectFailure;
        const plan = context.plan;
        if (projection === undefined || failure === undefined || plan === undefined) {
          return { outcome: { kind: "failure", failure: DEFAULT_RECOVERY_REQUIRED_FAILURE } };
        }
        return {
          outcome: {
            kind: "result",
            result: context.services.results.recoveryUnsafe(plan, projection, context.attempts, failure, "failed"),
          },
        };
      }),
    },
    recoveryReadFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? DEFAULT_RECOVERY_REQUIRED_FAILURE },
      })),
    },
    succeeded: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => ({
        outcome:
          context.result === undefined
            ? { kind: "failure", failure: defaultVerificationFailure() }
            : { kind: "result", result: context.result },
      })),
    },
    readFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? DEFAULT_READ_FAILURE },
      })),
    },
    preconditionFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? defaultPreconditionFailure() },
      })),
    },
    verificationFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: IssuanceExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? defaultVerificationFailure() },
      })),
    },
  },
});

/** Execute Change issuance and its bounded compensation through the internal XState actor. */
export async function executeIssuanceWithXState(
  services: IssuanceExecutionServices,
): Promise<IssuanceExecutionOutcome> {
  const actor = createActor(issuanceExecutionMachine, { input: services });
  try {
    const result = toPromise(actor);
    actor.start();
    return (await result) as IssuanceExecutionOutcome;
  } catch {
    return {
      kind: "failure",
      failure: defaultVerificationFailure("Change issuance execution machine failed closed."),
    };
  } finally {
    actor.stop();
  }
}
