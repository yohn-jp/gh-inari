import type { ChangeState, ChangeTransition } from "../../change.js";
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
/**
 * Run one lifecycle event from an authoritative public Change state.
 *
 * The XState actor is deliberately scoped to this pure transition operation;
 * its snapshot is execution state only and is never used as repository truth.
 */
export declare function transitionChangeLifecycle(state: ChangeState, operation: ChangeTransition): ChangeLifecycleTransitionResult;
/** Create a stateful domain-only facade over the internal XState machine. */
export declare function createChangeLifecycleMachine(initialState: ChangeState): ChangeLifecycleMachine;
/** Resolve the executable lifecycle edge without exposing XState types. */
export declare function resolveChangeLifecycleTransition(operation: ChangeTransition, state: ChangeState): {
    readonly transition: ChangeTransition;
    readonly from: ChangeState;
    readonly to: ChangeState;
} | undefined;
