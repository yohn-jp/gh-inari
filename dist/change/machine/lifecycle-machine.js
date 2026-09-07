import { assign, createActor, setup } from "xstate";
const LIFECYCLE_STATES = [
    "DEFINED",
    "DRAFT",
    "REVIEW",
    "ACCEPTED",
    "MERGED",
    "ABORTED",
    "RECOVERY_REQUIRED",
];
const lifecycleMachine = setup({
    types: {
        context: {},
        events: {},
        input: {},
    },
    actions: {
        recordAcceptedEvent: assign({
            lastAcceptedEvent: ({ event }) => event.type,
        }),
    },
}).createMachine({
    id: "change-lifecycle",
    initial: "admit",
    context: ({ input }) => ({ initialState: input.state }),
    states: {
        // Admission is intentionally transient. The caller supplies the
        // authoritative projected state; the machine does not rehydrate a
        // persisted actor snapshot or read repository state.
        admit: {
            always: [
                { target: "DEFINED", guard: ({ context }) => context.initialState === "DEFINED" },
                { target: "DRAFT", guard: ({ context }) => context.initialState === "DRAFT" },
                { target: "REVIEW", guard: ({ context }) => context.initialState === "REVIEW" },
                { target: "ACCEPTED", guard: ({ context }) => context.initialState === "ACCEPTED" },
                { target: "MERGED", guard: ({ context }) => context.initialState === "MERGED" },
                { target: "ABORTED", guard: ({ context }) => context.initialState === "ABORTED" },
                { target: "RECOVERY_REQUIRED", guard: ({ context }) => context.initialState === "RECOVERY_REQUIRED" },
            ],
        },
        DEFINED: {
            on: {
                ISSUE: { target: "DRAFT", actions: "recordAcceptedEvent" },
            },
        },
        DRAFT: {
            on: {
                READY: { target: "REVIEW", actions: "recordAcceptedEvent" },
                ABORT: { target: "ABORTED", actions: "recordAcceptedEvent" },
            },
        },
        REVIEW: {
            on: {
                READY: { target: "REVIEW", actions: "recordAcceptedEvent" },
                ABORT: { target: "ABORTED", actions: "recordAcceptedEvent" },
            },
        },
        ACCEPTED: {},
        MERGED: {},
        ABORTED: {
            on: {
                ABORT: { target: "ABORTED", actions: "recordAcceptedEvent" },
            },
        },
        RECOVERY_REQUIRED: {
            on: {
                ABORT: { target: "ABORTED", actions: "recordAcceptedEvent" },
            },
        },
    },
});
function assertLifecycleState(state) {
    if (!LIFECYCLE_STATES.includes(state)) {
        throw new TypeError(`Unknown Change lifecycle state: ${String(state)}`);
    }
}
function stateFromSnapshot(snapshot) {
    if (typeof snapshot.value !== "string" || !LIFECYCLE_STATES.includes(snapshot.value)) {
        throw new Error("Change lifecycle machine reached an invalid public state.");
    }
    return snapshot.value;
}
function eventForOperation(operation) {
    switch (operation) {
        case "issue":
            return { type: "ISSUE" };
        case "ready":
            return { type: "READY" };
        case "abort":
            return { type: "ABORT" };
        case "merge":
            return undefined;
    }
}
function rejectedTransition(operation, state, rejection) {
    return {
        operation,
        from: state,
        to: state,
        accepted: false,
        idempotent: false,
        rejection,
    };
}
/**
 * Run one lifecycle event from an authoritative public Change state.
 *
 * The XState actor is deliberately scoped to this pure transition operation;
 * its snapshot is execution state only and is never used as repository truth.
 */
export function transitionChangeLifecycle(state, operation) {
    assertLifecycleState(state);
    const event = eventForOperation(operation);
    if (event === undefined)
        return rejectedTransition(operation, state, "unsupported");
    const actor = createActor(lifecycleMachine, { input: { state } });
    try {
        actor.start();
        actor.send(event);
        const snapshot = actor.getSnapshot();
        const to = stateFromSnapshot(snapshot);
        const accepted = snapshot.context.lastAcceptedEvent === event.type;
        if (!accepted)
            return rejectedTransition(operation, state, "not-allowed");
        return {
            operation,
            from: state,
            to,
            accepted: true,
            idempotent: state === to,
        };
    }
    finally {
        actor.stop();
    }
}
/** Create a stateful domain-only facade over the internal XState machine. */
export function createChangeLifecycleMachine(initialState) {
    assertLifecycleState(initialState);
    let state = initialState;
    return {
        get state() {
            return state;
        },
        transition(operation) {
            const result = transitionChangeLifecycle(state, operation);
            state = result.to;
            return result;
        },
    };
}
/** Resolve the executable lifecycle edge without exposing XState types. */
export function resolveChangeLifecycleTransition(operation, state) {
    const result = transitionChangeLifecycle(state, operation);
    return result.accepted ? { transition: operation, from: result.from, to: result.to } : undefined;
}
//# sourceMappingURL=lifecycle-machine.js.map