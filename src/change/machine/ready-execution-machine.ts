import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
import type {
  Change,
  ChangeDiagnostic,
  ChangeEffect,
  ChangeProjectionInput,
  ChangeProjectionResult,
  ChangeReadyTransitionValidationResult,
  ChangeTransitionPlan,
} from "../../change.js";
import { createChangeDiagnostic } from "../../change.js";
import type { ChangeRemoteMutationRequest, ChangeRemoteExecutionResult } from "../../change-executor.js";
import { transitionChangeLifecycle } from "./lifecycle-machine.js";

export type ReadyExecutionFailureCode =
  | "CHANGE_EXECUTION_READ_FAILED"
  | "CHANGE_EXECUTION_PRECONDITION_FAILED"
  | "CHANGE_EXECUTION_EFFECT_FAILED"
  | "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED"
  | "CHANGE_EXECUTION_RECOVERY_REQUIRED";

export interface ReadyExecutionFailure {
  readonly code: ReadyExecutionFailureCode;
  readonly message: string;
  readonly diagnostics: readonly ChangeDiagnostic[];
}

export interface ReadyReadSuccess {
  readonly ok: true;
  readonly input: ChangeProjectionInput;
}

export interface ReadyReadFailure {
  readonly ok: false;
  readonly failure: ReadyExecutionFailure;
}

export type ReadyReadResult = ReadyReadSuccess | ReadyReadFailure;

export interface ReadyEffectFailure {
  readonly code: string;
  readonly message: string;
}

export interface ReadyEffectSuccess {
  readonly ok: true;
}

export interface ReadyEffectFailureResult {
  readonly ok: false;
  readonly failure: ReadyEffectFailure;
}

export type ReadyEffectResult = ReadyEffectSuccess | ReadyEffectFailureResult;

type ReadyEffect = Extract<ChangeEffect, { readonly kind: "MARK_PULL_REQUEST_READY" }>;

export interface ReadyVerificationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ChangeDiagnostic[];
  readonly message?: string;
}

export interface ReadyExecutionSemantics {
  readonly project: (input: ChangeProjectionInput) => ChangeProjectionResult;
  readonly validationInput: (
    input: ChangeProjectionInput,
    change: Change | undefined,
    requester: string | undefined,
  ) => unknown;
  readonly validate: (input: unknown) => ChangeReadyTransitionValidationResult;
  readonly plan: (input: unknown) => ChangeTransitionPlan;
  readonly verify: (
    request: ChangeRemoteMutationRequest,
    input: ChangeProjectionInput,
    projection: ChangeProjectionResult,
    plan: ChangeTransitionPlan,
  ) => ReadyVerificationResult;
}

export interface ReadyExecutionResults {
  readonly returnedExisting: (projection: ChangeProjectionResult) => ChangeRemoteExecutionResult;
  readonly verified: (projection: ChangeProjectionResult, effect: ReadyEffect) => ChangeRemoteExecutionResult;
  readonly failed: (
    projection: ChangeProjectionResult,
    effect: ReadyEffect,
    failure: ReadyEffectFailure,
  ) => ChangeRemoteExecutionResult;
}

export interface ReadyExecutionServices {
  readonly request: ChangeRemoteMutationRequest;
  /** The read actor is the only machine boundary for repository evidence I/O. */
  readonly read: (request: ChangeRemoteMutationRequest) => Promise<ReadyReadResult>;
  /** The effect actor is the only machine boundary for the privileged GitHub mutation. */
  readonly apply: (effect: ReadyEffect) => Promise<ReadyEffectResult>;
  readonly failureForEffect: (effect: ReadyEffect) => ReadyEffectFailure;
  readonly semantics: ReadyExecutionSemantics;
  readonly results: ReadyExecutionResults;
}

export type ReadyExecutionOutcome =
  | { readonly kind: "result"; readonly result: ChangeRemoteExecutionResult }
  | { readonly kind: "failure"; readonly failure: ReadyExecutionFailure };

interface ReadyMachineContext {
  readonly services: ReadyExecutionServices;
  readonly readStage?: "initial" | "reread";
  readonly rereadMode?: "verify" | "effect-failed";
  readonly input?: ChangeProjectionInput;
  readonly projection?: ChangeProjectionResult;
  readonly validationInput?: unknown;
  readonly plan?: ChangeTransitionPlan;
  readonly effect?: ReadyEffect;
  readonly effectFailure?: ReadyEffectFailure;
  readonly failure?: ReadyExecutionFailure;
  readonly result?: ChangeRemoteExecutionResult;
  readonly outcome?: ReadyExecutionOutcome;
}

const readEvidence = fromPromise<ReadyReadResult, ReadyExecutionServices>(({ input }) => input.read(input.request));

const applyReadyEffect = fromPromise<
  ReadyEffectResult,
  { readonly services: ReadyExecutionServices; readonly effect: ReadyEffect }
>(({ input }) => input.services.apply(input.effect));

const DEFAULT_READ_FAILURE: ReadyExecutionFailure = {
  code: "CHANGE_EXECUTION_READ_FAILED",
  message: "Trusted Change evidence read failed closed.",
  diagnostics: [],
};

function defaultVerificationFailure(
  message = "Post-effect Ready projection verification failed.",
): ReadyExecutionFailure {
  return {
    code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
    message,
    diagnostics: [],
  };
}

function rereadFailure(context: ReadyMachineContext, failure: ReadyExecutionFailure): ReadyExecutionFailure {
  return context.rereadMode === "effect-failed"
    ? {
        code: "CHANGE_EXECUTION_READ_FAILED",
        message: "Trusted Change evidence read failed after the Ready effect failed.",
        diagnostics: [],
      }
    : failure;
}

function lifecyclePreconditionFailure(state: Change["state"]): ReadyExecutionFailure {
  const message = `Ready lifecycle transition is not allowed from state "${state}".`;
  return {
    code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
    message,
    diagnostics: [
      createChangeDiagnostic({
        code: "CHANGE_TRANSITION_NOT_ALLOWED",
        path: "$.change.state",
        message,
      }),
    ],
  };
}

/** @internal Test-only access to the production graph; not re-exported publicly. */
export const readyExecutionMachine = setup({
  types: {
    context: {} as ReadyMachineContext,
    input: {} as ReadyExecutionServices,
  },
  actors: {
    readEvidence,
    applyReadyEffect,
  },
}).createMachine({
  id: "change-ready-execution",
  initial: "reading",
  context: ({ input }) => ({ services: input }),
  output: ({ context }): ReadyExecutionOutcome =>
    context.outcome ?? {
      kind: "failure",
      failure: defaultVerificationFailure("Ready execution machine failed closed."),
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
              failure: undefined,
              projection: undefined,
            }),
          },
          {
            target: "readFailed",
            actions: assign({
              failure: ({ event }) => (event.output.ok ? DEFAULT_READ_FAILURE : event.output.failure),
            }),
          },
        ],
        onError: {
          target: "readFailed",
          actions: assign({ failure: DEFAULT_READ_FAILURE }),
        },
      },
    },
    projecting: {
      entry: assign(({ context }) => {
        const input = context.input;
        if (input === undefined) return { failure: DEFAULT_READ_FAILURE, projection: undefined };
        try {
          const projection = context.services.semantics.project(input);
          if (projection.change?.identity.rootIssue !== context.services.request.issue) {
            return {
              projection: undefined,
              failure: {
                code: "CHANGE_EXECUTION_READ_FAILED",
                message: "Trusted Change evidence identity does not match the semantic request.",
                diagnostics: [],
              } satisfies ReadyExecutionFailure,
            };
          }
          return { projection, failure: undefined };
        } catch {
          return { projection: undefined, failure: DEFAULT_READ_FAILURE };
        }
      }),
      always: [
        {
          target: "validating",
          guard: ({ context }) =>
            context.readStage === "initial" && context.projection !== undefined && context.failure === undefined,
        },
        {
          target: "effectFailedResult",
          guard: ({ context }) =>
            context.readStage === "reread" &&
            context.rereadMode === "effect-failed" &&
            context.projection !== undefined &&
            context.failure === undefined,
        },
        {
          target: "verifying",
          guard: ({ context }) =>
            context.readStage === "reread" &&
            context.rereadMode === "verify" &&
            context.projection !== undefined &&
            context.failure === undefined,
        },
        { target: "readFailed" },
      ],
    },
    validating: {
      entry: assign(({ context }) => {
        const input = context.input;
        const projection = context.projection;
        if (input === undefined || projection?.change === undefined) {
          return {
            validationInput: undefined,
            failure: {
              code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
              message: "Ready transition preconditions failed.",
              diagnostics: [],
            } satisfies ReadyExecutionFailure,
          };
        }
        try {
          const lifecycle = transitionChangeLifecycle(projection.change.state, "ready");
          if (!lifecycle.accepted) {
            return {
              validationInput: undefined,
              failure: lifecyclePreconditionFailure(projection.change.state),
            };
          }
          const validationInput = context.services.semantics.validationInput(
            input,
            projection.change,
            context.services.request.requester,
          );
          const validation = context.services.semantics.validate(validationInput);
          return validation.valid
            ? { validationInput, failure: undefined }
            : {
                validationInput,
                failure: {
                  code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                  message: "Ready transition preconditions failed.",
                  diagnostics: validation.diagnostics,
                } satisfies ReadyExecutionFailure,
              };
        } catch {
          return {
            validationInput: undefined,
            failure: {
              code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
              message: "Ready transition preconditions failed.",
              diagnostics: [],
            } satisfies ReadyExecutionFailure,
          };
        }
      }),
      always: [
        {
          target: "planning",
          guard: ({ context }) => context.validationInput !== undefined && context.failure === undefined,
        },
        { target: "preconditionFailed" },
      ],
    },
    planning: {
      entry: assign(({ context }) => {
        if (context.validationInput === undefined) return { plan: undefined, effect: undefined };
        try {
          const plan = context.services.semantics.plan(context.validationInput);
          if (
            plan.effects.length > 1 ||
            (plan.effects[0] !== undefined && plan.effects[0].kind !== "MARK_PULL_REQUEST_READY")
          ) {
            return {
              plan: undefined,
              effect: undefined,
              failure: defaultVerificationFailure("Ready transition produced an invalid effect plan."),
            };
          }
          const effect = plan.effects[0];
          return {
            plan,
            effect: effect?.kind === "MARK_PULL_REQUEST_READY" ? effect : undefined,
            failure: undefined,
            rereadMode: "verify",
          };
        } catch {
          return {
            plan: undefined,
            effect: undefined,
            failure: defaultVerificationFailure("Ready transition produced an invalid effect plan."),
          };
        }
      }),
      always: [
        {
          target: "rereading",
          guard: ({ context }) => context.plan !== undefined && context.plan.effects.length === 0,
        },
        {
          target: "markingReady",
          guard: ({ context }) => context.effect?.kind === "MARK_PULL_REQUEST_READY",
        },
        { target: "verificationFailed" },
      ],
    },
    markingReady: {
      invoke: {
        src: "applyReadyEffect",
        input: ({ context }) => ({
          services: context.services,
          effect: context.effect!,
        }),
        onDone: [
          {
            target: "rereading",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              rereadMode: "verify",
              effectFailure: undefined,
            }),
          },
          {
            target: "rereading",
            actions: assign({
              rereadMode: "effect-failed",
              effectFailure: ({ event }) => (event.output.ok ? undefined : event.output.failure),
            }),
          },
        ],
        onError: {
          target: "rereading",
          actions: assign({
            rereadMode: "effect-failed",
            effectFailure: ({ context }) =>
              context.effect === undefined ? undefined : context.services.failureForEffect(context.effect),
          }),
        },
      },
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
              failure: ({ context, event }) =>
                event.output.ok ? undefined : rereadFailure(context, event.output.failure),
              projection: undefined,
            }),
          },
          {
            target: "readFailed",
            actions: assign({
              failure: ({ context, event }) =>
                event.output.ok ? DEFAULT_READ_FAILURE : rereadFailure(context, event.output.failure),
            }),
          },
        ],
        onError: {
          target: "readFailed",
          actions: assign({
            failure: ({ context }) =>
              context.rereadMode === "effect-failed"
                ? {
                    code: "CHANGE_EXECUTION_READ_FAILED",
                    message: "Trusted Change evidence read failed after the Ready effect failed.",
                    diagnostics: [],
                  }
                : DEFAULT_READ_FAILURE,
          }),
        },
      },
    },
    verifying: {
      entry: assign(({ context }) => {
        const input = context.input;
        const projection = context.projection;
        const plan = context.plan;
        if (input === undefined || projection === undefined || plan === undefined) {
          return { failure: defaultVerificationFailure() };
        }
        try {
          const verification = context.services.semantics.verify(context.services.request, input, projection, plan);
          if (!verification.valid) {
            return {
              result: undefined,
              failure: {
                code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                message: verification.message ?? "Post-effect Ready projection verification failed.",
                diagnostics: verification.diagnostics,
              } satisfies ReadyExecutionFailure,
            };
          }
          const effect = plan.effects[0];
          return {
            result:
              effect?.kind === "MARK_PULL_REQUEST_READY"
                ? context.services.results.verified(projection, effect)
                : context.services.results.returnedExisting(projection),
            failure: undefined,
          };
        } catch {
          return { result: undefined, failure: defaultVerificationFailure() };
        }
      }),
      always: [
        { target: "succeeded", guard: ({ context }) => context.result !== undefined && context.failure === undefined },
        { target: "verificationFailed" },
      ],
    },
    effectFailedResult: {
      type: "final",
      entry: assign({
        outcome: ({ context }): ReadyExecutionOutcome => {
          if (context.projection !== undefined && context.effect !== undefined && context.effectFailure !== undefined) {
            return {
              kind: "result",
              result: context.services.results.failed(context.projection, context.effect, context.effectFailure),
            };
          }
          return { kind: "failure", failure: defaultVerificationFailure() };
        },
      }),
    },
    succeeded: {
      type: "final",
      entry: assign({
        outcome: ({ context }): ReadyExecutionOutcome =>
          context.result === undefined
            ? { kind: "failure", failure: defaultVerificationFailure() }
            : { kind: "result", result: context.result },
      }),
    },
    readFailed: {
      type: "final",
      entry: assign({
        outcome: ({ context }): ReadyExecutionOutcome => ({
          kind: "failure",
          failure: context.failure ?? DEFAULT_READ_FAILURE,
        }),
      }),
    },
    preconditionFailed: {
      type: "final",
      entry: assign({
        outcome: ({ context }): ReadyExecutionOutcome => ({
          kind: "failure",
          failure: context.failure ?? {
            code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
            message: "Ready transition preconditions failed.",
            diagnostics: [],
          },
        }),
      }),
    },
    verificationFailed: {
      type: "final",
      entry: assign({
        outcome: ({ context }): ReadyExecutionOutcome => ({
          kind: "failure",
          failure: context.failure ?? defaultVerificationFailure(),
        }),
      }),
    },
  },
});

/** Execute the Ready operation through the internal XState actor. */
export async function executeReadyWithXState(services: ReadyExecutionServices): Promise<ReadyExecutionOutcome> {
  const actor = createActor(readyExecutionMachine, { input: services });
  try {
    const result = toPromise(actor);
    actor.start();
    return (await result) as ReadyExecutionOutcome;
  } catch {
    return { kind: "failure", failure: defaultVerificationFailure("Ready execution machine failed closed.") };
  } finally {
    actor.stop();
  }
}
