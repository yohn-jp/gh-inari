import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
const readEvidence = fromPromise(({ input }) => input.read(input.request));
const applyAbortEffect = fromPromise(({ input }) => input.services.apply(input.effect));
const DEFAULT_READ_FAILURE = {
    code: "CHANGE_EXECUTION_READ_FAILED",
    message: "Trusted Change evidence read failed closed.",
    diagnostics: [],
};
function defaultPreconditionFailure(message = "Abort transition preconditions failed.") {
    return { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message, diagnostics: [] };
}
function defaultVerificationFailure(message = "Post-effect Abort projection verification failed.") {
    return {
        code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        message,
        diagnostics: [],
    };
}
function effectAt(context) {
    const effect = context.plan?.effects[context.effectIndex];
    return effect?.kind === "CLOSE_PULL_REQUEST" || effect?.kind === "DELETE_BRANCH" ? effect : undefined;
}
function appendAttempt(context, effect, status) {
    return [...context.attempts, { effect, status }];
}
function failedEffect(context, effect, failure) {
    return { effect, code: failure.code, message: failure.message };
}
function recoveryReadFailure(context) {
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
        context: {},
        input: {},
    },
    actors: {
        readEvidence,
        applyAbortEffect,
    },
}).createMachine({
    id: "change-abort-execution",
    initial: "reading",
    context: ({ input }) => ({ services: input, effectIndex: 0, attempts: [] }),
    output: ({ context }) => context.outcome ?? {
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
                }
                catch {
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
                    guard: ({ context }) => context.readStage === "reread" && context.rereadMode === "recover" && context.projection !== undefined,
                },
                {
                    target: "verifying",
                    guard: ({ context }) => context.readStage === "reread" && context.rereadMode === "verify" && context.projection !== undefined,
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
                if (context.projection === undefined)
                    return { failure: DEFAULT_READ_FAILURE };
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
                if (context.projection === undefined)
                    return { plan: undefined, failure: defaultPreconditionFailure() };
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
                input: ({ context }) => ({ services: context.services, effect: effectAt(context) }),
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
                if (context.input === undefined ||
                    context.plan === undefined ||
                    context.effectFailure === undefined ||
                    context.projection === undefined) {
                    return {
                        failure: {
                            code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                            message: "A failed Change transition could not produce a bounded recovery plan.",
                            diagnostics: [],
                        },
                    };
                }
                const recovered = context.services.semantics.recover(context.services.request, context.plan, context.attempts, context.effectFailure, context.input);
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
                const verification = context.services.semantics.verify(context.services.request, context.input, context.projection, context.plan);
                if (!verification.valid) {
                    return {
                        failure: {
                            code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
                            message: verification.message ?? "Post-effect Abort projection verification failed.",
                            diagnostics: verification.diagnostics,
                        },
                    };
                }
                const result = context.plan.effects.length === 0
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
            entry: assign(({ context }) => ({
                outcome: context.result === undefined
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
                    entry: assign(({ context }) => ({
                        outcome: context.result === undefined
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
            entry: assign(({ context }) => ({
                outcome: { kind: "failure", failure: context.failure ?? DEFAULT_READ_FAILURE },
            })),
        },
        preconditionFailed: {
            type: "final",
            entry: assign(({ context }) => ({
                outcome: { kind: "failure", failure: context.failure ?? defaultPreconditionFailure() },
            })),
        },
        verificationFailed: {
            type: "final",
            entry: assign(({ context }) => ({
                outcome: { kind: "failure", failure: context.failure ?? defaultVerificationFailure() },
            })),
        },
        recoveryFailed: {
            type: "final",
            entry: assign(({ context }) => ({
                outcome: {
                    kind: "failure",
                    failure: context.failure ??
                        {
                            code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
                            message: "A failed Change transition could not be bounded for recovery.",
                            diagnostics: [],
                        },
                },
            })),
        },
    },
});
/** Execute Abort and cleanup recovery through the internal XState actor. */
export async function executeAbortWithXState(services) {
    const actor = createActor(abortExecutionMachine, { input: services });
    try {
        const result = toPromise(actor);
        actor.start();
        return (await result);
    }
    catch {
        return {
            kind: "failure",
            failure: defaultVerificationFailure("Abort execution machine failed closed."),
        };
    }
    finally {
        actor.stop();
    }
}
//# sourceMappingURL=abort-execution-machine.js.map