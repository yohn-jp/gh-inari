import { assign, createActor, fromPromise, setup, toPromise } from "xstate";
const readEvidence = fromPromise(({ input }) => input.read(input.request));
const applyIssuanceEffect = fromPromise(({ input }) => input.services.apply(input.effect));
const DEFAULT_READ_FAILURE = {
    code: "CHANGE_EXECUTION_READ_FAILED",
    message: "Trusted Change evidence read failed closed.",
    diagnostics: [],
};
const DEFAULT_RECOVERY_REQUIRED_FAILURE = {
    code: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
    message: "A failed Change issuance could not be bounded for recovery.",
    diagnostics: [],
};
function defaultVerificationFailure(message = "Post-effect Change issuance projection verification failed.") {
    return { code: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", message, diagnostics: [] };
}
function defaultPreconditionFailure(message = "Change issuance preconditions failed.") {
    return { code: "CHANGE_EXECUTION_PRECONDITION_FAILED", message, diagnostics: [] };
}
/** A read boundary check, not semantic classification: evidence must describe the requested Change. */
function identityMismatchFailure(context, input) {
    const projection = context.services.semantics.project(input);
    return projection.change?.identity.rootIssue === context.services.request.issue
        ? undefined
        : {
            code: "CHANGE_EXECUTION_READ_FAILED",
            message: "Trusted Change evidence identity does not match the semantic request.",
            diagnostics: [],
        };
}
function createEffectAt(context) {
    const effect = context.plan?.effects[context.effectIndex];
    return effect?.kind === "CREATE_BRANCH" || effect?.kind === "CREATE_PULL_REQUEST" ? effect : undefined;
}
function appendAttempt(context, effect, status, evidence) {
    return [...context.attempts, { effect, status, ...(evidence === undefined ? {} : { evidence }) }];
}
function failedEffectEvidence(effect, failure) {
    return { effect, code: failure.code, message: failure.message };
}
const issuanceExecutionMachine = setup({
    types: {
        context: {},
        input: {},
    },
    actors: {
        readEvidence,
        applyIssuanceEffect,
    },
}).createMachine({
    id: "change-issuance-execution",
    initial: "readingInitial",
    context: ({ input }) => ({ services: input, effectIndex: 0, attempts: [] }),
    output: ({ context }) => context.outcome ?? {
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
                if (input === undefined)
                    return { failure: DEFAULT_READ_FAILURE };
                const identityFailure = identityMismatchFailure(context, input);
                if (identityFailure !== undefined)
                    return { failure: identityFailure };
                const diagnostics = context.services.semantics.validateGovernance(input);
                return diagnostics.length > 0
                    ? {
                        failure: {
                            code: "CHANGE_EXECUTION_PRECONDITION_FAILED",
                            message: "Governed root Issue validation failed before Change issuance planning.",
                            diagnostics,
                        },
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
                if (fresh === undefined || initial === undefined)
                    return { failure: DEFAULT_READ_FAILURE };
                const identityFailure = identityMismatchFailure(context, fresh);
                if (identityFailure !== undefined)
                    return { failure: identityFailure };
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
                        },
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
                if (fresh === undefined)
                    return { plan: undefined, failure: DEFAULT_READ_FAILURE };
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
                input: ({ context }) => ({ services: context.services, effect: createEffectAt(context) }),
                onDone: [
                    {
                        target: "nextEffect",
                        guard: ({ event }) => event.output.ok,
                        actions: assign(({ context, event }) => {
                            const effect = createEffectAt(context);
                            if (effect === undefined)
                                return { failure: defaultVerificationFailure("Invalid issuance effect.") };
                            const evidence = event.output.ok ? event.output.evidence : undefined;
                            return { attempts: appendAttempt(context, effect, "succeeded", evidence), effectFailure: undefined };
                        }),
                    },
                    {
                        target: "rereadingAfterFailure",
                        actions: assign(({ context, event }) => {
                            const effect = createEffectAt(context);
                            if (effect === undefined)
                                return { failure: defaultVerificationFailure("Invalid issuance effect.") };
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
                        if (effect === undefined)
                            return { failure: defaultVerificationFailure("Invalid issuance effect.") };
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
                        },
                    };
                }
                const result = plan.effects.length === 0
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
                        actions: assign(({ context }) => context.effectFailure === undefined
                            ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
                            : { failure: context.services.results.recoveryReadFailure(context.attempts, context.effectFailure) }),
                    },
                ],
                onError: {
                    target: "recoveryReadFailed",
                    actions: assign(({ context }) => context.effectFailure === undefined
                        ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
                        : { failure: context.services.results.recoveryReadFailure(context.attempts, context.effectFailure) }),
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
                    guard: ({ context }) => context.failureProjection !== undefined &&
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
                if (!planned.ok)
                    return { compensationEffect: undefined };
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
                input: ({ context }) => ({ services: context.services, effect: context.compensationEffect }),
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
                            compensationFailure: failedEffectEvidence(context.compensationEffect, event.output.ok ? context.services.failureForEffect(context.compensationEffect) : event.output.failure),
                        })),
                    },
                ],
                onError: {
                    target: "rereadingAfterCompensation",
                    actions: assign(({ context }) => ({
                        compensationStatus: "failed",
                        compensationFailure: failedEffectEvidence(context.compensationEffect, context.services.failureForEffect(context.compensationEffect)),
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
                        actions: assign(({ context }) => context.effectFailure === undefined
                            ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
                            : {
                                failure: context.services.results.recoveryReadFailure(context.attempts, context.effectFailure, context.compensationStatus),
                            }),
                    },
                ],
                onError: {
                    target: "recoveryReadFailed",
                    actions: assign(({ context }) => context.effectFailure === undefined
                        ? { failure: DEFAULT_RECOVERY_REQUIRED_FAILURE }
                        : {
                            failure: context.services.results.recoveryReadFailure(context.attempts, context.effectFailure, context.compensationStatus),
                        }),
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
                if (plan === undefined ||
                    input === undefined ||
                    failure === undefined ||
                    compensationInput === undefined ||
                    compensationStatus === undefined) {
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
            entry: assign(({ context }) => {
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
            entry: assign(({ context }) => {
                const input = context.compensationInput;
                const failure = context.effectFailure;
                const plan = context.plan;
                if (input === undefined || failure === undefined || plan === undefined) {
                    return { outcome: { kind: "failure", failure: DEFAULT_RECOVERY_REQUIRED_FAILURE } };
                }
                const projection = context.services.semantics.project(input);
                const compensationStatus = context.compensationStatus ?? "failed";
                const result = context.recoveryPlanOk === true
                    ? context.services.results.recoveryRequired(projection, context.attempts, failure, compensationStatus)
                    : context.services.results.recoveryUnsafe(plan, projection, context.attempts, failure, compensationStatus);
                return { outcome: { kind: "result", result } };
            }),
        },
        compensationUnsafeResult: {
            type: "final",
            entry: assign(({ context }) => {
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
            entry: assign(({ context }) => {
                const failure = context.effectFailure;
                if (failure === undefined)
                    return { outcome: { kind: "failure", failure: defaultVerificationFailure() } };
                return {
                    outcome: { kind: "failure", failure: context.services.results.effectFailed(context.attempts, failure) },
                };
            }),
        },
        branchRecoveryRequired: {
            type: "final",
            entry: assign(({ context }) => {
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
            entry: assign(({ context }) => ({
                outcome: { kind: "failure", failure: context.failure ?? DEFAULT_RECOVERY_REQUIRED_FAILURE },
            })),
        },
        succeeded: {
            type: "final",
            entry: assign(({ context }) => ({
                outcome: context.result === undefined
                    ? { kind: "failure", failure: defaultVerificationFailure() }
                    : { kind: "result", result: context.result },
            })),
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
    },
});
/** Execute Change issuance and its bounded compensation through the internal XState actor. */
export async function executeIssuanceWithXState(services) {
    const actor = createActor(issuanceExecutionMachine, { input: services });
    try {
        const result = toPromise(actor);
        actor.start();
        return (await result);
    }
    catch {
        return {
            kind: "failure",
            failure: defaultVerificationFailure("Change issuance execution machine failed closed."),
        };
    }
    finally {
        actor.stop();
    }
}
//# sourceMappingURL=issuance-execution-machine.js.map