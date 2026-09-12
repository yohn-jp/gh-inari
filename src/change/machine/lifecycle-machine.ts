import { assign, createActor, setup } from "xstate";
import type { ChangeState, ChangeTransition } from "../../change.js";

type LifecycleEvent = { readonly type: "ISSUE" } | { readonly type: "READY" } | { readonly type: "ABORT" };

interface LifecycleContext {
  initialState: ChangeState;
  lastAcceptedEvent?: LifecycleEvent["type"];
}

interface LifecycleInput {
  readonly state: ChangeState;
}

const LIFECYCLE_STATES: readonly ChangeState[] = [
  "DEFINED",
  "DRAFT",
  "REVIEW",
  "ACCEPTED",
  "MERGED",
  "ABORTED",
  "RECOVERY_REQUIRED",
];

/** @internal Test-only access to the production graph; not re-exported publicly. */
export const lifecycleMachine = setup({
  types: {
    context: {} as LifecycleContext,
    events: {} as LifecycleEvent,
    input: {} as LifecycleInput,
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

export interface ChangeLifecycleTransitionResult {
  readonly operation: ChangeTransition;
  readonly from: ChangeState;
  readonly to: ChangeState;
  readonly accepted: boolean;
  readonly idempotent: boolean;
  readonly rejection?: "not-allowed" | "unsupported";
}

export interface ChangeLifecycleMachine {
  readonly state: ChangeState;
  transition(operation: ChangeTransition): ChangeLifecycleTransitionResult;
}

function assertLifecycleState(state: ChangeState): void {
  if (!LIFECYCLE_STATES.includes(state)) {
    throw new TypeError(`Unknown Change lifecycle state: ${String(state)}`);
  }
}

function stateFromSnapshot(snapshot: { readonly value: unknown }): ChangeState {
  if (typeof snapshot.value !== "string" || !LIFECYCLE_STATES.includes(snapshot.value as ChangeState)) {
    throw new Error("Change lifecycle machine reached an invalid public state.");
  }
  return snapshot.value as ChangeState;
}

function eventForOperation(operation: ChangeTransition): LifecycleEvent | undefined {
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

function rejectedTransition(
  operation: ChangeTransition,
  state: ChangeState,
  rejection: "not-allowed" | "unsupported",
): ChangeLifecycleTransitionResult {
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
export function transitionChangeLifecycle(
  state: ChangeState,
  operation: ChangeTransition,
): ChangeLifecycleTransitionResult {
  assertLifecycleState(state);
  const event = eventForOperation(operation);
  if (event === undefined) return rejectedTransition(operation, state, "unsupported");

  const actor = createActor(lifecycleMachine, { input: { state } });
  try {
    actor.start();
    actor.send(event);
    const snapshot = actor.getSnapshot();
    const to = stateFromSnapshot(snapshot);
    const accepted = snapshot.context.lastAcceptedEvent === event.type;
    if (!accepted) return rejectedTransition(operation, state, "not-allowed");
    return {
      operation,
      from: state,
      to,
      accepted: true,
      idempotent: state === to,
    };
  } finally {
    actor.stop();
  }
}

/** Create a stateful domain-only facade over the internal XState machine. */
export function createChangeLifecycleMachine(initialState: ChangeState): ChangeLifecycleMachine {
  assertLifecycleState(initialState);
  let state = initialState;
  return {
    get state(): ChangeState {
      return state;
    },
    transition(operation: ChangeTransition): ChangeLifecycleTransitionResult {
      const result = transitionChangeLifecycle(state, operation);
      state = result.to;
      return result;
    },
  };
}

/** Resolve the executable lifecycle edge without exposing XState types. */
export function resolveChangeLifecycleTransition(
  operation: ChangeTransition,
  state: ChangeState,
): { readonly transition: ChangeTransition; readonly from: ChangeState; readonly to: ChangeState } | undefined {
  const result = transitionChangeLifecycle(state, operation);
  return result.accepted ? { transition: operation, from: result.from, to: result.to } : undefined;
}
