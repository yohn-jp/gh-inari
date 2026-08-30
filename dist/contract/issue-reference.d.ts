/**
 * Representation-independent Issue identity and dependency semantics.
 *
 * Dependency values intentionally live beside template fields.  They are a
 * generic Issue primitive, rather than a template field or a Portal model,
 * so later consumers can reuse them without learning a repository's Markdown
 * layout.
 *
 * For GitHub, repositoryHost + repositoryId is the identity tuple, where
 * repositoryId is the decimal REST repository database ID returned by
 * `gh api repos/{owner}/{repo}`. Rename/transfer within one host changes the
 * repository locator, but not the identity key; migration across hosts is a
 * different identity. The locator is never used for equality, sorting,
 * duplicate detection, or self checks.
 */
export interface IssueReference {
    /** Normalized GitHub host/install boundary of the repository identity. */
    readonly repositoryHost: string;
    /** Decimal REST repository database identity within repositoryHost. */
    readonly repositoryId: string;
    /** Current owner/name locator for display and transport only; never an identity key. */
    readonly repository?: string;
    readonly number: number;
}
export interface IssueDependencies {
    readonly blockedBy: readonly IssueReference[];
    readonly blocks: readonly IssueReference[];
}
export type IssueDependencyViolationCode = "DEPENDENCIES_NOT_OBJECT" | "DEPENDENCIES_UNKNOWN_PROPERTY" | "DEPENDENCIES_NOT_ARRAY" | "REFERENCE_NOT_OBJECT" | "REFERENCE_UNKNOWN_PROPERTY" | "REFERENCE_AMBIGUOUS" | "REFERENCE_REPOSITORY_HOST_INVALID" | "REFERENCE_REPOSITORY_ID_INVALID" | "REFERENCE_REPOSITORY_INVALID" | "REFERENCE_NUMBER_INVALID" | "REFERENCE_DUPLICATE" | "REFERENCE_SELF" | "REFERENCE_CONTRADICTORY";
export interface IssueDependencyViolation {
    readonly code: IssueDependencyViolationCode;
    readonly path: string;
    readonly message: string;
}
export interface IssueDependencyValidationResult {
    readonly valid: boolean;
    /** Canonical sorted values are returned only when validation succeeds. */
    readonly dependencies: IssueDependencies;
    readonly violations: readonly IssueDependencyViolation[];
}
export declare const EMPTY_ISSUE_DEPENDENCIES: IssueDependencies;
/**
 * Normalize one generic Issue reference.  String shorthand and URLs are
 * deliberately rejected: accepting both would make repository identity
 * parsing ambiguous and would create multiple spellings for one reference.
 */
export declare function normalizeIssueReference(input: unknown, path?: string): IssueReferenceValidationResult;
export interface IssueReferenceValidationResult {
    readonly valid: boolean;
    readonly reference?: IssueReference;
    readonly violations: readonly IssueDependencyViolation[];
}
/** Canonical validation and projection for Issue dependency declarations. */
export declare function validateIssueDependencies(input: unknown, subject?: IssueReference): IssueDependencyValidationResult;
export declare const normalizeIssueDependencies: typeof validateIssueDependencies;
export declare const projectIssueDependencies: typeof validateIssueDependencies;
/** Stable key useful to adapters without exposing parsing rules. */
export declare function issueReferenceKey(reference: IssueReference): string;
