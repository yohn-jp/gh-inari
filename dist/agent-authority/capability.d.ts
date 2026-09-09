/**
 * The semantic capability vocabulary usable inside a Runtime Authority
 * `capabilityCeiling` and a Session Certificate `capabilities` claim list.
 *
 * Per `docs/AGENT_CAPABILITY_AUTHORIZATION.md` section 11.2, agent-facing
 * capabilities are bounded repository/Change semantics, never raw GitHub
 * provider permissions (`contents: write`, `pull_requests: write`, ...).
 * This module is the single allow-list: a capability kind not listed here
 * cannot be expressed by either record, which is also how trust-root and
 * other non-delegable operations (section 11.6) stay structurally
 * unreachable from ordinary delegated authority -- there is no capability
 * kind for them to begin with.
 *
 * Branch and pull-request-head identity reuses the repository's one branch
 * grammar (`branch-naming-authority.mjs`) instead of a second parallel
 * pattern.
 */
export declare const CAPABILITY_KINDS: readonly ["change.implement", "change.ready", "change.abort", "branch.create", "branch.advance", "pullRequest.create"];
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
export declare const MAX_ISSUE_NUMBER: 999999999;
export declare const MAX_PATH_POLICY_LENGTH: 160;
/** Architecture doc 11.2/11.4 examples bound branch/PR creation to exactly one. */
export declare const CAPABILITY_CREATE_MAX: 1;
export interface ChangeCapabilityClaim {
    readonly kind: "change.implement" | "change.ready" | "change.abort";
    readonly issue: number;
}
export interface BranchCreateCapabilityClaim {
    readonly kind: "branch.create";
    readonly branch: string;
    readonly max: typeof CAPABILITY_CREATE_MAX;
}
export interface BranchAdvanceCapabilityClaim {
    readonly kind: "branch.advance";
    readonly branch: string;
    readonly pathPolicy?: string;
}
export interface PullRequestCreateCapabilityClaim {
    readonly kind: "pullRequest.create";
    readonly head: string;
    readonly base: string;
    readonly max: typeof CAPABILITY_CREATE_MAX;
}
export type CapabilityClaim = ChangeCapabilityClaim | BranchCreateCapabilityClaim | BranchAdvanceCapabilityClaim | PullRequestCreateCapabilityClaim;
export type CapabilityDiagnosticCode = "CAPABILITY_INVALID_ROOT" | "CAPABILITY_MISSING_PROPERTY" | "CAPABILITY_UNKNOWN_PROPERTY" | "CAPABILITY_UNSUPPORTED_KIND" | "CAPABILITY_INVALID_CLAIM";
export interface CapabilityDiagnostic {
    readonly code: CapabilityDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export interface CapabilityClaimValidationResult {
    readonly valid: boolean;
    readonly value?: CapabilityClaim;
    readonly diagnostics: readonly CapabilityDiagnostic[];
}
export declare function isCapabilityKind(value: unknown): value is CapabilityKind;
/** Validate one capability claim (a Session Certificate `capabilities[i]` entry). */
export declare function validateCapabilityClaim(input: unknown, path?: string): CapabilityClaimValidationResult;
/** `EffectiveAuthority` intersection (architecture doc 7.3/11.1): a claim's kind must be within the delegating Runtime's ceiling. */
export declare function capabilityClaimWithinCeiling(claim: CapabilityClaim, ceiling: readonly CapabilityKind[]): boolean;
/** The Issue number a change.* claim is scoped to, for task-binding consistency checks. */
export declare function capabilityClaimIssueNumber(claim: CapabilityClaim): number | undefined;
