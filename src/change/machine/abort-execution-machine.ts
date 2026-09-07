import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import type {
  Change,
  ChangeDiagnostic,
  ChangeEffect,
  ChangeIssuanceEffectAttempt,
  ChangeProjectionInput,
  ChangeProjectionResult,
  ChangeTransitionPlan,
} from "../../change.js";
import type { ChangeRemoteExecutionResult, ChangeRemoteMutationRequest } from "../../change-executor.js";

export type AbortExecutionFailureCode =
  | "CHANGE_EXECUTION_READ_FAILED"
  | "CHANGE_EXECUTION_PRECONDITION_FAILED"
  | "CHANGE_EXECUTION_EFFECT_FAILED"
  | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED"
  | "CHANGE_EXECUTION_RECOVERY_REQUIRED";

export interface AbortExecutionFailure {
  readonly code: AbortExecutionFailureCode;
  readonly message: string;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly evidence?: ChangeRemoteExecutionResult["evidence"];
}

export type AbortEffect = Extract<ChangeEffect, { readonly kind: "CLOSE_PULL_REQUEST" | "DELETE_BRANCH" }>;

export interface AbortReadSuccess {
  readonly ok: true;
  readonly input: ChangeProjectionInput;
}

export interface AbortReadFailure {
  readonly ok: false;
  readonly failure: AbortExecutionFailure;
}

export type AbortReadResult = AbortReadSuccess | AbortReadFailure;

export interface AbortEffectSuccess {
  readonly ok: true;
}

export interface AbortEffectFailureResult {
  readonly ok: false;
  readonly failure: { readonly code: string; readonly message: string };
}

export type AbortEffectResult = AbortEffectSuccess | AbortEffectFailureResult;

export interface AbortEffectFailure {
  readonly effect: AbortEffect;
  readonly code: string;
  readonly message: string;
}

export interface AbortAdmissionSuccess {
  readonly ok: true;
  readonly phase: "normal" | "recovery";
}

export interface AbortAdmissionFailure {
  readonly ok: false;
  readonly failure: AbortExecutionFailure;
}

export type AbortAdmissionResult = AbortAdmissionSuccess | AbortAdmissionFailure;

export interface AbortPlanSuccess {
  readonly ok: true;
  readonly plan: ChangeTransitionPlan;
}

export interface AbortPlanFailure {
  readonly ok: false;
  readonly failure: AbortExecutionFailure;
}

export type AbortPlanResult = AbortPlanSuccess | AbortPlanFailure;

export interface AbortVerificationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly message?: string;
}

export interface AbortRecoverySuccess {
  readonly ok: true;
  readonly result: ChangeRemoteExecutionResult;
}

export interface AbortRecoveryFailure {
  readonly ok: false;
  readonly failure: AbortExecutionFailure;
}

export type AbortRecoveryResult = AbortRecoverySuccess | AbortRecoveryFailure;

export interface AbortExecutionSemantics {
  readonly project: (input: ChangeProjectionInput) => ChangeProjectionResult;
  readonly classify: (projection: ChangeProjectionResult) => AbortAdmissionResult;
  readonly plan: (request: ChangeRemoteMutationRequest, projection: ChangeProjectionResult) => AbortPlanResult;
  readonly recover: (
    request: ChangeRemoteMutationRequest,
    transition: ChangeTransitionPlan,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: AbortEffectFailure,
    input: ChangeProjectionInput,
  ) => AbortRecoveryResult;
  readonly verify: (
    request: ChangeRemoteMutationRequest,
    input: ChangeProjectionInput,
    projection: ChangeProjectionResult,
    plan: ChangeTransitionPlan,
  ) => AbortVerificationResult;
}

export interface AbortExecutionResults {
  readonly returnedExisting: (projection: ChangeProjectionResult) => ChangeRemoteExecutionResult;
  readonly verified: (
    projection: ChangeProjectionResult,
    attempts: readonly ChangeIssuanceEffectAttempt[],
  ) => ChangeRemoteExecutionResult;
  readonly recoveryRequired: (
    projection: ChangeProjectionResult,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: AbortEffectFailure,
  ) => ChangeRemoteExecutionResult;
}

export interface AbortExecutionServices {
  readonly request: ChangeRemoteMutationRequest;
  /** Evidence I/O is isolated behind the operation actor boundary. */
  readonly read: (request: ChangeRemoteMutationRequest) => Promise<AbortReadResult>;
  /** Privileged effects are isolated behind the operation actor boundary. */
  readonly apply: (effect: AbortEffect) => Promise<AbortEffectResult>;
  readonly failureForEffect: (effect: AbortEffect) => { readonly code: string; readonly message: string };
  /** Builds the bounded failure returned when recovery evidence cannot be read. */
  readonly recoveryReadFailure: (
    request: ChangeRemoteMutationRequest,
    attempts: readonly ChangeIssuanceEffectAttempt[],
    failure: AbortEffectFailure,
  ) => AbortExecutionFailure;
  readonly semantics: AbortExecutionSemantics;
  readonly results: AbortExecutionResults;
}

export type AbortExecutionOutcome =
  | { readonly kind: "result"; readonly result: ChangeRemoteExecutionResult }
  | { readonly kind: "failure"; readonly failure: AbortExecutionFailure };

interface AbortMachineContext {
  readonly services: AbortExecutionServices;
  readonly phase?: "normal" | "recovery";
  readonly readStage?: "initial" | "reread";
  readonly rereadMode?: "verify" | "recover";
  readonly input?: ChangeProjectionInput;
  readonly projection?: ChangeProjectionResult;
  readonly plan?: ChangeTransitionPlan;
  readonly effectIndex: number;
  readonly attempts: readonly ChangeIssuanceEffectAttempt[];
  readonly effectFailure?: AbortEffectFailure;
  readonly failure?: AbortExecutionFailure;
  readonly result?: ChangeRemoteExecutionResult;
  readonly outcome?: AbortExecutionOutcome;
}

const readEvidence = fromPromise<AbortReadResult, AbortExecutionServices>(({ input }) => input.read(input.request));

const applyAbortEffect = fromPromise<
  AbortEffectResult,
  { readonly services: AbortExecutionServices; readonly effect: AbortEffect }
>(({ input }) => input.services.apply(input.effect));

const DEFAULT_READ_FAILURE: AbortExecutionFailure = {
  code: "CHANGE_EXECUTION_READ_FAILED",
  message: "Trusted Change evidence read failed closed.",
  diagnostics: [],
};

function defaultPreconditionFailure(message = "Abort transition preconditions failed."): AbortExecutionFailure {
  return { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message, diagnostics: [] };
}

function defaultVerificationFailure(
  message = "Post-effect Abort projection verification failed.",
): AbortExecutionFailure {
  return {
    code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
    message,
    diagnostics: [],
  };
}

function effectAt(context: AbortMachineContext): AbortEffect | undefined {
  const effect = context.plan?.effects[context.effectIndex];
  return effect?.kind === "CLOSE_PULL_REQUEST" || effect?.kind === "DELETE_BRANCH" ? effect : undefined;
}

function appendAttempt(
  context: AbortMachineContext,
  effect: AbortEffect,
  status: "succeeded" | "failed",
): readonly ChangeIssuanceEffectAttempt[] {
  return [...context.attempts, { effect, status }];
}

function failedEffect(context: AbortMachineContext, effect: AbortEffect, failure: { code: string; message: string }) {
  return { effect, code: failure.code, message: failure.message } satisfies AbortEffectFailure;
}

function recoveryReadFailure(context: AbortMachineContext): AbortExecutionFailure {
  return context.effectFailure === undefined
    ? {
        code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        message: "A failed Change transition could not be bounded for recovery.",
        diagnostics: [],
      }
    : context.services.recoveryReadFailure(context.services.request, context.attempts, context.effectFailure);
}

const abortExecutionMachine = setup({
  types: {
    context: {} as AbortMachineContext,
    input: {} as AbortExecutionServices,
  },
  actors: {
    readEvidence,
    applyAbortEffect,
  },
}).createMachine({
  id: "change-abort-execution",
  initial: "reading",
  context: ({ input }) => ({ services: input, effectIndex: 0, attempts: [] }),
  output: ({ context }): AbortExecutionOutcome =>
    context.outcome ?? {
      kind: "failure",
      failure: defaultVerificationFailure("Abort execution machine failed closed."),
    },
  states: {
    reading: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "projecting",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              input: ({ event }) => (event.output.ok ? event.output.input : undefined),
              readStage: "initial",
              rereadMode: undefined,
              projection: undefined,
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
    projecting: {
      entry: assign(({ context }) => {
        const input = context.input;
        const recoveryReread = context.readStage === "reread" && context.rereadMode === "recover";
        if (input === undefined) {
          return {
            projection: undefined,
            failure: recoveryReread ? recoveryReadFailure(context) : DEFAULT_READ_FAILURE,
          };
        }
        try {
          const projection = context.services.semantics.project(input);
          if (projection.change?.identity.rootIssue !== context.services.request.issue) {
            return {
              projection: undefined,
              failure: recoveryReread
                ? recoveryReadFailure(context)
                : {
                    code: "CHANGE_EXECUTION_READ_FAILED",
                    message: "Trusted Change evidence identity does not match the semantic request.",
                    diagnostics: [],
                  },
            };
          }
          return { projection, failure: undefined };
        } catch {
          return {
            projection: undefined,
            failure: recoveryReread ? recoveryReadFailure(context) : DEFAULT_READ_FAILURE,
          };
        }
      }),
      always: [
        {
          target: "classifyingAbort",
          guard: ({ context }) => context.readStage === "initial" && context.projection !== undefined,
        },
        {
          target: "recoveryPlanning",
          guard: ({ context }) =>
            context.readStage === "reread" && context.rereadMode === "recover" && context.projection !== undefined,
        },
        {
          target: "verifying",
          guard: ({ context }) =>
            context.readStage === "reread" && context.rereadMode === "verify" && context.projection !== undefined,
        },
        {
          target: "recoveryFailed",
          guard: ({ context }) => context.readStage === "reread" && context.rereadMode === "recover",
        },
        { target: "readFailed" },
      ],
    },
    classifyingAbort: {
      entry: assign(({ context }) => {
        if (context.projection === undefined) return { failure: DEFAULT_READ_FAILURE };
        const admission = context.services.semantics.classify(context.projection);
        return admission.ok ? { phase: admission.phase, failure: undefined } : { failure: admission.failure };
      }),
      always: [
        { target: "planning", guard: ({ context }) => context.phase !== undefined && context.failure === undefined },
        { target: "preconditionFailed" },
      ],
    },
    planning: {
      entry: assign(({ context }) => {
        if (context.projection === undefined) return { plan: undefined, failure: defaultPreconditionFailure() };
        const planned = context.services.semantics.plan(context.services.request, context.projection);
        return planned.ok
          ? { plan: planned.plan, failure: undefined, effectIndex: 0, rereadMode: "verify" }
          : { failure: planned.failure };
      }),
      always: [
        {
          target: "rereading",
          guard: ({ context }) => context.plan !== undefined && context.plan.effects.length === 0,
        },
        {
          target: "applying",
          guard: ({ context }) => context.plan !== undefined && context.plan.effects.length > 0,
        },
        { target: "preconditionFailed" },
      ],
    },
    applying: {
      invoke: {
        src: "applyAbortEffect",
        input: ({ context }) => ({ services: context.services, effect: effectAt(context)! }),
        onDone: [
          {
            target: "nextEffect",
            guard: ({ event }) => event.output.ok,
            actions: assign(({ context }) => {
              const effect = effectAt(context);
              return effect === undefined
                ? { failure: defaultVerificationFailure("Abort execution produced an invalid effect.") }
                : { attempts: appendAttempt(context, effect, "succeeded"), effectFailure: undefined };
            }),
          },
          {
            target: "rereading",
            actions: assign(({ context, event }) => {
              const effect = effectAt(context);
              if (effect === undefined)
                return { failure: defaultVerificationFailure("Abort execution produced an invalid effect.") };
              const failure = event.output.ok ? context.services.failureForEffect(effect) : event.output.failure;
              const recorded = failedEffect(context, effect, failure);
              return {
                rereadMode: "recover",
                effectFailure: recorded,
                attempts: appendAttempt(context, effect, "failed"),
              };
            }),
          },
        ],
        onError: {
          target: "rereading",
          actions: assign(({ context }) => {
            const effect = effectAt(context);
            if (effect === undefined)
              return { failure: defaultVerificationFailure("Abort execution produced an invalid effect.") };
            const recorded = failedEffect(context, effect, context.services.failureForEffect(effect));
            return {
              rereadMode: "recover",
              effectFailure: recorded,
              attempts: appendAttempt(context, effect, "failed"),
            };
          }),
        },
      },
    },
    nextEffect: {
      always: [
        {
          target: "applying",
          guard: ({ context }) => context.plan !== undefined && context.effectIndex + 1 < context.plan.effects.length,
          actions: assign({ effectIndex: ({ context }) => context.effectIndex + 1 }),
        },
        { target: "rereading", actions: assign({ rereadMode: "verify" }) },
      ],
    },
    rereading: {
      invoke: {
        src: "readEvidence",
        input: ({ context }) => context.services,
        onDone: [
          {
            target: "projecting",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              input: ({ event }) => (event.output.ok ? event.output.input : undefined),
              readStage: "reread",
              failure: undefined,
            }),
          },
          {
            target: "recoveryFailed",
            guard: ({ context }) => context.rereadMode === "recover",
            actions: assign(({ context }) => ({ failure: recoveryReadFailure(context) })),
          },
          {
            target: "readFailed",
            actions: assign({
              failure: ({ event }) => (event.output.ok ? DEFAULT_READ_FAILURE : event.output.failure),
            }),
          },
        ],
        onError: [
          {
            target: "recoveryFailed",
            guard: ({ context }) => context.rereadMode === "recover",
            actions: assign(({ context }) => ({ failure: recoveryReadFailure(context) })),
          },
          { target: "readFailed", actions: assign({ failure: DEFAULT_READ_FAILURE }) },
        ],
      },
    },
    recoveryPlanning: {
      entry: assign(({ context }) => {
        if (
          context.input === undefined ||
          context.plan === undefined ||
          context.effectFailure === undefined ||
          context.projection === undefined
        ) {
          return {
            failure: {
              code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
              message: "A failed Change transition could not produce a bounded recovery plan.",
              diagnostics: [],
            } satisfies AbortExecutionFailure,
          };
        }
        const recovered = context.services.semantics.recover(
          context.services.request,
          context.plan,
          context.attempts,
          context.effectFailure,
          context.input,
        );
        return recovered.ok ? { result: recovered.result, failure: undefined } : { failure: recovered.failure };
      }),
      always: [
        { target: "recoveryRequired", guard: ({ context }) => context.result !== undefined },
        { target: "recoveryFailed" },
      ],
    },
    verifying: {
      entry: assign(({ context }) => {
        if (context.input === undefined || context.projection === undefined || context.plan === undefined) {
          return { failure: defaultVerificationFailure() };
        }
        const verification = context.services.semantics.verify(
          context.services.request,
          context.input,
          context.projection,
          context.plan,
        );
        if (!verification.valid) {
          return {
            failure: {
              code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
              message: verification.message ?? "Post-effect Abort projection verification failed.",
              diagnostics: verification.diagnostics,
            } satisfies AbortExecutionFailure,
          };
        }
        const result =
          context.plan.effects.length === 0
            ? context.services.results.returnedExisting(context.projection)
            : context.services.results.verified(context.projection, context.attempts);
        return { result, failure: undefined };
      }),
      always: [
        { target: "completed", guard: ({ context }) => context.result !== undefined && context.failure === undefined },
        { target: "verificationFailed" },
      ],
    },
    completed: {
      type: "final",
      entry: assign(({ context }): { outcome: AbortExecutionOutcome } => ({
        outcome:
          context.result === undefined
            ? { kind: "failure", failure: defaultVerificationFailure() }
            : { kind: "result", result: context.result },
      })),
    },
    recoveryRequired: {
      // The public lifecycle remains RECOVERY_REQUIRED while this internal
      // compound state keeps cleanup-pending recovery explicit.
      initial: "cleanupPending",
      onDone: "completed",
      states: {
        cleanupPending: {
          type: "final",
          entry: assign(({ context }): { outcome: AbortExecutionOutcome } => ({
            outcome:
              context.result === undefined
                ? {
                    kind: "failure",
                    failure: {
                      code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                      message: "A failed Change transition requires governed recovery.",
                      diagnostics: [],
                    },
                  }
                : { kind: "result", result: context.result },
          })),
        },
      },
    },
    readFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: AbortExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? DEFAULT_READ_FAILURE },
      })),
    },
    preconditionFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: AbortExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? defaultPreconditionFailure() },
      })),
    },
    verificationFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: AbortExecutionOutcome } => ({
        outcome: { kind: "failure", failure: context.failure ?? defaultVerificationFailure() },
      })),
    },
    recoveryFailed: {
      type: "final",
      entry: assign(({ context }): { outcome: AbortExecutionOutcome } => ({
        outcome: {
          kind: "failure",
          failure:
            context.failure ??
            ({
              code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
              message: "A failed Change transition could not be bounded for recovery.",
              diagnostics: [],
            } satisfies AbortExecutionFailure),
        },
      })),
    },
  },
});

/** Execute Abort and cleanup recovery through the internal XState actor. */
export async function executeAbortWithXState(services: AbortExecutionServices): Promise<AbortExecutionOutcome> {
  const actor = createActor(abortExecutionMachine, { input: services });
  try {
    const result = toPromise(actor);
    actor.start();
    return (await result) as AbortExecutionOutcome;
  } catch {
    return {
      kind: "failure",
      failure: defaultVerificationFailure("Abort execution machine failed closed."),
    };
  } finally {
    actor.stop();
  }
}
