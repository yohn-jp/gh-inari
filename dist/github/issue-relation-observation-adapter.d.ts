/**
 * GitHub-native Issue relation observation adapter (#288).
 *
 * Reads the native `parent` and `blocked_by` relationships for one Issue and
 * normalizes each related Issue into the existing {@link IssueReference}
 * identity primitive. This module owns no repository policy: it does not
 * infer `children`/`blocks`, tracker state, supersession, or completion
 * semantics, does not parse Markdown/body markers, and never mutates
 * relationships. Canon vocabulary, Effective Contract, materialization,
 * projection policy, and #161 lifecycle interpretation remain out of scope.
 *
 * Depending on the full `GitHubAdapter` surface here would recreate the
 * coupling #288 is meant to avoid, so this module consumes only the bounded
 * `requestRepositoryApi` read seam through a narrow interface.
 */
import type { GitHubApiResponse } from "./adapter.js";
import type { RepositoryContext } from "./types.js";
import { type IssueReference } from "../contract/issue-reference.js";
/** Narrow read seam this module needs from `GitHubAdapter`. */
export interface IssueRelationApiReader {
    requestRepositoryApi(repositoryPath: string): Promise<GitHubApiResponse>;
}
/**
 * Whether the target GitHub capability set is known to support each native
 * relation for the observed repository. A GitHub host that predates, or has
 * not enabled, sub-issues/issue-dependencies answers a relation's endpoint
 * with the same bare 404 whether an Issue has no relation set or the
 * endpoint does not exist at all, so this module cannot infer support from
 * a response alone. The caller — which already knows the target host/plan —
 * must state support explicitly; declaring `false` short-circuits to
 * `unavailable` without a network call instead of guessing.
 */
export interface IssueRelationCapabilities {
    readonly parent: boolean;
    readonly blockedBy: boolean;
}
/**
 * `empty` — GitHub confirmed zero relations (404 on a supported capability,
 *   or a present-but-empty set).
 * `present` — every related Issue resolved to a stable identity.
 * `unavailable` — evidence exists (or a read/capability precondition failed)
 *   but a complete, stable identity set could not be established, e.g. the
 *   read seam cannot resolve a cross-repository relation's repository
 *   database ID, the result set could not be confirmed complete within the
 *   bounded page limit, the target capability is not supported, or the read
 *   itself failed.
 * `malformed` — GitHub returned a response that does not match the expected
 *   Issue relation shape.
 */
export type IssueRelationEvidenceKind = "empty" | "present" | "unavailable" | "malformed";
export type IssueRelationDiagnosticCode = "RELATION_CAPABILITY_UNSUPPORTED" | "RELATION_READ_FAILED" | "RELATION_RESPONSE_MALFORMED" | "RELATION_ENTRY_MALFORMED" | "RELATION_REPOSITORY_UNRESOLVED" | "RELATION_RESULT_TRUNCATED";
export interface IssueRelationDiagnostic {
    readonly code: IssueRelationDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export interface IssueParentObservation {
    readonly kind: IssueRelationEvidenceKind;
    readonly reference: IssueReference | undefined;
    readonly diagnostics: readonly IssueRelationDiagnostic[];
}
export interface IssueBlockedByObservation {
    readonly kind: IssueRelationEvidenceKind;
    readonly references: readonly IssueReference[];
    readonly diagnostics: readonly IssueRelationDiagnostic[];
}
/**
 * Observes GitHub-native Issue `parent` and `blocked_by` relationships for
 * one repository context and normalizes them into bounded, deterministic
 * evidence rather than raw GitHub payloads.
 */
export declare class GitHubIssueRelationObservationAdapter {
    private readonly reader;
    private readonly context;
    private readonly capabilities;
    constructor(reader: IssueRelationApiReader, context: RepositoryContext, capabilities: IssueRelationCapabilities);
    /** Observe the native parent relationship for one Issue. */
    observeParent(issueNumber: number): Promise<IssueParentObservation>;
    /**
     * Observe the native `blocked_by` dependency set for one Issue.
     *
     * Pages through the bounded read seam up to {@link BLOCKED_BY_MAX_PAGES};
     * hitting that bound with a still-full page means completeness cannot be
     * confirmed, so the result is reported `unavailable` rather than returned
     * as a silently truncated `present` set.
     */
    observeBlockedBy(issueNumber: number): Promise<IssueBlockedByObservation>;
}
