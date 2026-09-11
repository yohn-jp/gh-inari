/**
 * Pure implementation-handoff projection for an issued Change.
 *
 * The handoff is deliberately narrower than the Change projection it
 * consumes.  It gives a worker the canonical remote identity it needs to
 * establish its own local execution context; it never carries a worktree,
 * session, process, checkout, or other local-runtime fact.
 */
import { CHANGE_CONTRACT_VERSION, type ChangeDiagnostic } from "./change.js";
/** Independent version for the transport-neutral handoff envelope. */
export declare const IMPLEMENTATION_HANDOFF_CONTRACT_VERSION: 1;
export type ImplementationHandoffContractVersion = typeof IMPLEMENTATION_HANDOFF_CONTRACT_VERSION;
/** Explicit discriminator for the worker-facing projection. */
export declare const IMPLEMENTATION_HANDOFF_KIND: "implementation-handoff";
/**
 * The bounded identity needed by a worker runtime.
 *
 * `repositoryHost`, `repositoryId`, and `rootIssue` are copied from the
 * validated Change identity.  `changeVersion` and `state` describe the
 * existing Change contract; they do not create a second lifecycle.
 */
export interface ImplementationHandoff {
    readonly version: ImplementationHandoffContractVersion;
    readonly kind: typeof IMPLEMENTATION_HANDOFF_KIND;
    readonly repositoryHost: string;
    readonly repositoryId: string;
    readonly rootIssue: number;
    readonly changeVersion: typeof CHANGE_CONTRACT_VERSION;
    readonly state: "DRAFT";
    readonly branch: string;
    readonly baseBranch: string;
    readonly pullRequest: number;
}
/** Compatibility name for callers that name the projection by its Change. */
export type ChangeImplementationHandoff = ImplementationHandoff;
export interface ImplementationHandoffProjectionResult {
    readonly valid: boolean;
    readonly handoff?: ImplementationHandoff;
    readonly diagnostics: readonly ChangeDiagnostic[];
}
/** Compatibility name for callers that use the Change-prefixed result. */
export type ChangeImplementationHandoffResult = ImplementationHandoffProjectionResult;
export declare class ImplementationHandoffProjectionError extends Error {
    readonly diagnostics: readonly ChangeDiagnostic[];
    constructor(diagnostics: readonly ChangeDiagnostic[]);
}
/** Compatibility name for callers that use the Change-prefixed error. */
export declare class ChangeImplementationHandoffError extends ImplementationHandoffProjectionError {
    constructor(diagnostics: readonly ChangeDiagnostic[]);
}
/** Validate a serialized handoff at a transport/package boundary. */
export declare function validateImplementationHandoff(input: unknown): ImplementationHandoffProjectionResult;
/** Alias named after the Change-owned projection. */
export declare const validateChangeImplementationHandoff: typeof validateImplementationHandoff;
/**
 * Project a worker handoff from one already-validated Change projection.
 *
 * No GitHub I/O occurs here.  Callers acquire fresh evidence through the
 * existing Change read/executor boundary before invoking this function.
 */
export declare function tryProjectImplementationHandoff(input: unknown): ImplementationHandoffProjectionResult;
/** Alias named after the Change-owned projection. */
export declare const tryProjectChangeImplementationHandoff: typeof tryProjectImplementationHandoff;
/** Throwing Core entry point for callers that require an admissible handoff. */
export declare function projectImplementationHandoff(input: unknown): ImplementationHandoff;
/** Alias named after the Change-owned projection. */
export declare const projectChangeImplementationHandoff: typeof projectImplementationHandoff;
