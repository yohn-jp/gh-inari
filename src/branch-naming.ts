/**
 * Transport-independent Core rule for canonical repository branch identity.
 *
 * This module owns the branch grammar, deterministic naming derivation, Issue
 * title normalization, and inverse-compatible branch recognition. Provider
 * adapters may supply normalized values and repository branch governance, but
 * they do not define any part of the canonical branch rule.
 */

export const CANONICAL_BRANCH_TYPES = Object.freeze(["feat", "fix", "docs", "refactor", "test", "chore"] as const);
export type CanonicalBranchType = (typeof CANONICAL_BRANCH_TYPES)[number];

/** Compatibility spelling for callers that describe the supported kinds as a vocabulary. */
export const BRANCH_TYPES = CANONICAL_BRANCH_TYPES;
export type BranchType = CanonicalBranchType;

/** Repository-governed branch classification and slug, without the Issue number. */
export interface BranchNaming {
  readonly type: string;
  readonly slug: string;
}

/** The complete parse result for a canonical branch name. */
export interface BranchNameParts extends BranchNaming {
  readonly issueNumber: number;
}

/** The bounded branch-policy shape needed for recognition. */
export interface BranchNamingGovernance {
  readonly pattern: string;
}

export const MAX_BRANCH_TITLE_LENGTH = 255 as const;
export const DEFAULT_BRANCH_NAME = "main" as const;

const BRANCH_PATTERN = /^(feat|fix|docs|refactor|test|chore)\/(\d+)-([a-z0-9-]+)$/u;
const ISSUE_TITLE_PATTERN = /^(feat|fix|docs|refactor|test|chore):\s*(.+)$/iu;

function invalidBranchMessage(branch: unknown): string {
  return (
    `branch name "${String(branch)}" does not match <type>/<issue-number>-<slug>` +
    ' (e.g. "feat/42-add-init-command"); type must be one of feat, fix, docs, refactor, test, chore'
  );
}

/** Validate a branch reference against the repository's canonical grammar. */
export function validateBranchName(branch: string): readonly string[] {
  if (branch === DEFAULT_BRANCH_NAME) return [];
  if (typeof branch === "string" && BRANCH_PATTERN.test(branch)) return [];
  return [invalidBranchMessage(branch)];
}

/**
 * Recognize a canonical branch and return the semantic parts needed by Core.
 * The default branch is valid provider/base-branch input but is not a
 * canonical Change branch and therefore is not recognized here.
 */
export function recognizeBranchName(branch: string): BranchNameParts | undefined {
  const match = typeof branch === "string" ? BRANCH_PATTERN.exec(branch) : null;
  if (match === null) return undefined;

  const issueNumber = Number(match[2]);
  if (!Number.isSafeInteger(issueNumber)) return undefined;
  return {
    type: match[1] as CanonicalBranchType,
    issueNumber,
    slug: match[3] as string,
  };
}

/** Recognize branch naming parts only when the branch belongs to one root Issue. */
export function recognizeBranchNamingForIssue(branch: string, rootIssue: number): BranchNaming | undefined {
  const parts = recognizeBranchName(branch);
  if (parts === undefined || parts.issueNumber !== rootIssue) return undefined;
  return { type: parts.type, slug: parts.slug };
}

/**
 * Determine whether a branch is a canonical candidate for a root Issue,
 * optionally applying the repository's independently governed branch policy.
 */
export function branchBelongsToRootIssue(
  branch: string,
  rootIssue: number,
  branchGovernance?: BranchNamingGovernance,
): boolean {
  if (!Number.isSafeInteger(rootIssue) || rootIssue < 1) return false;
  if (recognizeBranchNamingForIssue(branch, rootIssue) === undefined) return false;
  if (branchGovernance === undefined) return true;

  try {
    return new RegExp(branchGovernance.pattern, "u").test(branch);
  } catch {
    return false;
  }
}

/** Normalize one governed Issue title into the naming parts used by derivation. */
export function deriveBranchNamingFromIssueTitle(title: string): BranchNaming {
  // Bound the input before the regex runs so every deployment uses the same
  // safe input boundary as the Core rule.
  if (typeof title !== "string" || title.length > MAX_BRANCH_TITLE_LENGTH) {
    throw new TypeError("Issue title is invalid.");
  }
  const match = ISSUE_TITLE_PATTERN.exec(title);
  if (match === null) throw new TypeError("Issue title does not contain a supported branch type.");

  const type = match[1]?.toLowerCase();
  const slug = match[2]
    ?.normalize("NFKD")
    .replace(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (type === undefined || slug === undefined || slug.length === 0) {
    throw new TypeError("Issue title does not contain a usable branch slug.");
  }
  return { type, slug };
}

/** Compatibility spelling for callers that describe this as title parsing. */
export const deriveNamingFromIssueTitle = deriveBranchNamingFromIssueTitle;

/** Derive one canonical branch identity from validated semantic naming parts. */
export function deriveBranchName({ type, issueNumber, slug }: BranchNameParts): string {
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError("Branch type must be a non-empty string.");
  }
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new TypeError("Branch issue number must be a positive safe integer.");
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new TypeError("Branch slug must be a non-empty string.");
  }

  const branch = `${type}/${issueNumber}-${slug}`;
  const errors = validateBranchName(branch);
  if (errors.length > 0) throw new TypeError(errors[0]);
  return branch;
}

/** Explicit Core spelling for callers that need to distinguish derivation from validation. */
export const deriveCanonicalBranchName = deriveBranchName;

/** Explicit Core spelling for callers that need to distinguish recognition from provider parsing. */
export const recognizeCanonicalBranchName = recognizeBranchName;
