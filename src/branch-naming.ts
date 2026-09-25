/**
 * Transport-independent Core rule for canonical repository branch identity.
 *
 * This module owns two layers:
 *
 * 1. The historical fixed `<feat|fix|docs|refactor|test|chore>/<issue>-<slug>`
 *    grammar, its derivation, Issue title normalization, and inverse-compatible
 *    recognition. These helpers are explicit compatibility adapters for
 *    historical contracts and signed records; they are not the universal rule
 *    for new ordinary Change branch naming. New callers bind repository policy
 *    through `repository-branch-policy.ts`.
 * 2. The bounded declarative branch formatter grammar (`format`/`types`) that a
 *    repository branch policy may declare. The formatter is the only supported
 *    way to generate a branch name from policy; a pattern is never inverted.
 *
 * Provider adapters may supply normalized values and repository branch
 * governance, but they do not define any part of these rules.
 */

export const CANONICAL_BRANCH_TYPES = Object.freeze(["feat", "fix", "docs", "refactor", "test", "chore"] as const);
export type CanonicalBranchType = (typeof CANONICAL_BRANCH_TYPES)[number];

/** Integration branch classes owned by the canonical Issue routing model. */
export const CANONICAL_INTEGRATION_BRANCH_TYPES = Object.freeze(["epic", "issue"] as const);
export type CanonicalIntegrationBranchType = (typeof CANONICAL_INTEGRATION_BRANCH_TYPES)[number];

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

/** The parsed identity of an Epic or source-Issue integration branch. */
export interface IntegrationBranchNameParts extends BranchNameParts {
  readonly type: CanonicalIntegrationBranchType;
}

/** The bounded branch-policy shape needed for recognition. */
export interface BranchNamingGovernance {
  readonly pattern: string;
  /** Optional bounded declarative formatter; see {@link validateBranchFormatRule}. */
  readonly format?: string;
  /** Closed `{type}` vocabulary; declared only together with a `{type}` formatter placeholder. */
  readonly types?: readonly string[];
}

export const MAX_BRANCH_TITLE_LENGTH = 255 as const;
export const DEFAULT_BRANCH_NAME = "main" as const;

const BRANCH_PATTERN = /^(feat|fix|docs|refactor|test|chore)\/(\d+)-([a-z0-9-]+)$/u;
const INTEGRATION_BRANCH_PATTERN = /^(epic|issue)\/(\d+)-([a-z0-9-]+)$/u;
const RESERVED_INTEGRATION_BRANCH_PATTERN = /^(epic|issue)\//u;
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
  if (typeof branch === "string") {
    const integrationMatch = INTEGRATION_BRANCH_PATTERN.exec(branch);
    if (integrationMatch !== null) {
      const issueNumber = Number(integrationMatch[2]);
      if (Number.isSafeInteger(issueNumber) && issueNumber >= 1) return [];
    }
    // A malformed reserved branch must not fall through a configurable
    // ordinary branch rule in a provider adapter.
    if (RESERVED_INTEGRATION_BRANCH_PATTERN.test(branch)) {
      return [`branch name "${branch}" does not match <epic|issue>/<positive-issue-number>-<slug>`];
    }
  }
  return [invalidBranchMessage(branch)];
}

/**
 * Recognize a canonical branch and return the semantic parts needed by Core.
 * The default branch is valid provider/base-branch input but is not a
 * canonical Change branch and therefore is not recognized here.
 */
export function recognizeBranchName(branch: string): BranchNameParts | undefined {
  const match = typeof branch === "string" ? BRANCH_PATTERN.exec(branch) : null;
  if (match !== null) {
    const issueNumber = Number(match[2]);
    if (!Number.isSafeInteger(issueNumber)) return undefined;
    return {
      type: match[1] as CanonicalBranchType,
      issueNumber,
      slug: match[3] as string,
    };
  }

  const integrationMatch = typeof branch === "string" ? INTEGRATION_BRANCH_PATTERN.exec(branch) : null;
  if (integrationMatch === null) return undefined;

  const issueNumber = Number(integrationMatch[2]);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return undefined;
  return {
    type: integrationMatch[1] as CanonicalIntegrationBranchType,
    issueNumber,
    slug: integrationMatch[3] as string,
  };
}

/** Recognize only an Epic or source-Issue integration branch. */
export function recognizeIntegrationBranchName(branch: string): IntegrationBranchNameParts | undefined {
  const parts = recognizeBranchName(branch);
  if (parts === undefined || !CANONICAL_INTEGRATION_BRANCH_TYPES.includes(parts.type as CanonicalIntegrationBranchType))
    return undefined;
  return parts as IntegrationBranchNameParts;
}

export const recognizeCanonicalIntegrationBranchName = recognizeIntegrationBranchName;

/** Derive a strict source-Issue integration branch from explicit identity data. */
export function deriveIssueIntegrationBranchName(issueNumber: number, slug: string): string {
  return deriveIntegrationBranchName("issue", issueNumber, slug);
}

/** Derive a strict Epic integration branch from explicit identity data. */
export function deriveEpicIntegrationBranchName(issueNumber: number, slug: string): string {
  return deriveIntegrationBranchName("epic", issueNumber, slug);
}

export const deriveIssueBranchName = deriveIssueIntegrationBranchName;
export const deriveEpicBranchName = deriveEpicIntegrationBranchName;

function deriveIntegrationBranchName(type: CanonicalIntegrationBranchType, issueNumber: number, slug: string): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1)
    throw new TypeError("Integration branch issue number must be a positive safe integer.");
  if (typeof slug !== "string" || slug.length === 0)
    throw new TypeError("Integration branch slug must be a non-empty string.");
  const branch = `${type}/${issueNumber}-${slug}`;
  if (validateBranchName(branch).length > 0) throw new TypeError(invalidBranchMessage(branch));
  return branch;
}

/** Recognize branch naming parts only when the branch belongs to one root Issue. */
export function recognizeBranchNamingForIssue(branch: string, rootIssue: number): BranchNaming | undefined {
  const parts = recognizeBranchName(branch);
  if (
    parts === undefined ||
    parts.issueNumber !== rootIssue ||
    CANONICAL_INTEGRATION_BRANCH_TYPES.includes(parts.type as CanonicalIntegrationBranchType)
  )
    return undefined;
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

/**
 * Normalize free text into a lowercase ASCII hyphenated slug. Returns an empty
 * string when nothing usable remains; callers decide whether that is an error.
 */
export function normalizeBranchSlug(text: string): string {
  if (typeof text !== "string" || text.length > MAX_BRANCH_TITLE_LENGTH) {
    throw new TypeError("Branch slug source text is invalid.");
  }
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
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
  const slug = match[2] === undefined ? undefined : normalizeBranchSlug(match[2]);
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
  if (!CANONICAL_BRANCH_TYPES.includes(type as CanonicalBranchType)) {
    throw new TypeError("Branch type must be an ordinary Change branch type.");
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

/**
 * Explicit compatibility adapter: the historical fixed ordinary Change branch
 * convention expressed as a repository branch policy rule. It is never applied
 * implicitly; a caller that needs the historical convention must pass it
 * deliberately (for example, for a historical record or a repository that
 * declares exactly this rule).
 */
export const LEGACY_CHANGE_BRANCH_RULE: Readonly<Required<BranchNamingGovernance>> = Object.freeze({
  pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$",
  format: "{type}/{issueNumber}-{slug}",
  types: CANONICAL_BRANCH_TYPES,
});

// ---------------------------------------------------------------------------
// Bounded declarative branch formatter grammar
// ---------------------------------------------------------------------------

/** Placeholders a repository branch formatter may reference. */
export const BRANCH_FORMAT_PLACEHOLDERS = Object.freeze(["issueNumber", "slug", "type"] as const);
export type BranchFormatPlaceholder = (typeof BRANCH_FORMAT_PLACEHOLDERS)[number];

export const MAX_BRANCH_FORMAT_LENGTH = 200 as const;
export const MAX_BRANCH_FORMAT_TYPES = 32 as const;
export const MAX_BRANCH_FORMAT_TYPE_LENGTH = 32 as const;
export const MAX_BRANCH_SLUG_LENGTH = 100 as const;
export const MAX_BRANCH_NAME_LENGTH = 255 as const;

export interface BranchFormatRule {
  readonly format: string;
  readonly types?: readonly string[];
}

export interface BranchFormatViolation {
  readonly path: "format" | "types";
  readonly message: string;
}

export interface BranchFormatValues {
  readonly issueNumber: number;
  readonly slug?: string;
  readonly type?: string;
}

const FORMAT_TOKEN_PATTERN = /\{([^{}]*)\}/gu;
const FORMAT_LITERAL_PATTERN = /^[A-Za-z0-9._/-]*$/u;
const FORMAT_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const FORMAT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BRANCH_SPELLING_PATTERN = /^[A-Za-z0-9._/-]+$/u;

function formatPlaceholders(format: string): string[] {
  return [...format.matchAll(FORMAT_TOKEN_PATTERN)].map((match) => match[1] as string);
}

/**
 * Validate a declarative branch formatter without evaluating any repository
 * code. The grammar is literal text drawn from `[A-Za-z0-9._/-]` plus the
 * placeholders `{issueNumber}` (required, once), `{slug}` and `{type}` (each at
 * most once). `{type}` requires a closed `types` vocabulary and `types`
 * requires `{type}`.
 */
export function validateBranchFormatRule(rule: {
  readonly format?: unknown;
  readonly types?: unknown;
}): readonly BranchFormatViolation[] {
  const violations: BranchFormatViolation[] = [];
  const { format, types } = rule;
  if (format === undefined) {
    if (types !== undefined) violations.push({ path: "types", message: "types requires a format with {type}." });
    return violations;
  }
  if (typeof format !== "string" || format.length === 0 || format.length > MAX_BRANCH_FORMAT_LENGTH) {
    violations.push({
      path: "format",
      message: `format must be a non-empty string of at most ${MAX_BRANCH_FORMAT_LENGTH} characters.`,
    });
    return violations;
  }
  const literal = format.replace(FORMAT_TOKEN_PATTERN, "");
  if (!FORMAT_LITERAL_PATTERN.test(literal)) {
    violations.push({
      path: "format",
      message: "format literals must use only A-Z, a-z, 0-9, '.', '_', '/', '-' and supported {placeholders}.",
    });
  }
  const placeholders = formatPlaceholders(format);
  for (const placeholder of placeholders) {
    if (!BRANCH_FORMAT_PLACEHOLDERS.includes(placeholder as BranchFormatPlaceholder)) {
      violations.push({ path: "format", message: `format placeholder {${placeholder}} is not supported.` });
    }
  }
  for (const placeholder of BRANCH_FORMAT_PLACEHOLDERS) {
    if (placeholders.filter((entry) => entry === placeholder).length > 1) {
      violations.push({ path: "format", message: `format placeholder {${placeholder}} must appear at most once.` });
    }
  }
  if (!placeholders.includes("issueNumber")) {
    violations.push({ path: "format", message: "format must include {issueNumber}." });
  }
  const usesType = placeholders.includes("type");
  if (types === undefined) {
    if (usesType) violations.push({ path: "types", message: "format {type} requires a declared types list." });
    return violations;
  }
  if (!usesType) violations.push({ path: "types", message: "types requires a format with {type}." });
  if (!Array.isArray(types) || types.length === 0 || types.length > MAX_BRANCH_FORMAT_TYPES) {
    violations.push({
      path: "types",
      message: `types must be a non-empty array of at most ${MAX_BRANCH_FORMAT_TYPES} entries.`,
    });
    return violations;
  }
  const seen = new Set<string>();
  for (const entry of types as unknown[]) {
    if (
      typeof entry !== "string" ||
      entry.length > MAX_BRANCH_FORMAT_TYPE_LENGTH ||
      !FORMAT_TYPE_PATTERN.test(entry) ||
      seen.has(entry)
    ) {
      violations.push({
        path: "types",
        message: "types entries must be unique lowercase [a-z0-9-] words starting with a letter or digit.",
      });
      break;
    }
    seen.add(entry);
  }
  return violations;
}

/**
 * Validate generic Git-safe branch spelling without applying any naming
 * convention: no six-prefix vocabulary, Issue-number shape, or default-branch
 * name is assumed.
 */
export function validateBranchSpelling(branch: unknown): readonly string[] {
  if (typeof branch !== "string" || branch.length === 0 || branch.length > MAX_BRANCH_NAME_LENGTH) {
    return [`branch name must be a non-empty string of at most ${MAX_BRANCH_NAME_LENGTH} characters`];
  }
  if (!BRANCH_SPELLING_PATTERN.test(branch)) {
    return [`branch name "${branch}" must use only A-Z, a-z, 0-9, '.', '_', '/', '-'`];
  }
  const segments = branch.split("/");
  if (
    branch.includes("..") ||
    branch.endsWith(".lock") ||
    branch.endsWith(".") ||
    segments.some((segment) => segment.length === 0 || segment.startsWith(".") || segment.startsWith("-"))
  ) {
    return [`branch name "${branch}" is not a safe Git branch name`];
  }
  return [];
}

/**
 * Render a validated declarative branch formatter. Throws a TypeError when
 * the rule is invalid or a required value is missing, malformed, or outside
 * the declared `types` vocabulary. Never consults a regular expression rule.
 */
export function renderBranchFormat(rule: BranchFormatRule, values: BranchFormatValues): string {
  const violations = validateBranchFormatRule(rule);
  if (violations.length > 0) throw new TypeError(violations[0]?.message);
  const placeholders = formatPlaceholders(rule.format);
  if (!Number.isSafeInteger(values.issueNumber) || values.issueNumber < 1) {
    throw new TypeError("Branch issue number must be a positive safe integer.");
  }
  if (placeholders.includes("slug")) {
    if (
      typeof values.slug !== "string" ||
      values.slug.length > MAX_BRANCH_SLUG_LENGTH ||
      !FORMAT_SLUG_PATTERN.test(values.slug)
    ) {
      throw new TypeError(
        `Branch slug must be lowercase [a-z0-9] words joined by single hyphens, at most ${MAX_BRANCH_SLUG_LENGTH} characters.`,
      );
    }
  }
  if (placeholders.includes("type")) {
    if (typeof values.type !== "string" || !(rule.types ?? []).includes(values.type)) {
      throw new TypeError("Branch type must be one of the repository-declared types.");
    }
  }
  const branch = rule.format.replace(FORMAT_TOKEN_PATTERN, (_token, name: string) => {
    if (name === "issueNumber") return String(values.issueNumber);
    if (name === "slug") return values.slug as string;
    return values.type as string;
  });
  const errors = validateBranchSpelling(branch);
  if (errors.length > 0) throw new TypeError(errors[0]);
  return branch;
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/**
 * Recognize whether a supplied branch is exactly what a declarative formatter
 * renders for one Issue/Implementation number. The matcher is built from the
 * bounded formatter grammar only (never from a repository pattern), fixes the
 * number, and returns the recovered `slug`/`type` values, or undefined.
 */
export function matchBranchFormat(
  rule: BranchFormatRule,
  branch: string,
  issueNumber: number,
): { readonly slug?: string; readonly type?: string } | undefined {
  if (validateBranchFormatRule(rule).length > 0) return undefined;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return undefined;
  if (typeof branch !== "string" || validateBranchSpelling(branch).length > 0) return undefined;
  let source = "^";
  let cursor = 0;
  for (const match of rule.format.matchAll(FORMAT_TOKEN_PATTERN)) {
    source += escapeRegExpLiteral(rule.format.slice(cursor, match.index));
    const name = match[1];
    if (name === "issueNumber") source += String(issueNumber);
    else if (name === "slug") source += "(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)";
    else source += `(?<type>${(rule.types ?? []).map(escapeRegExpLiteral).join("|")})`;
    cursor = (match.index as number) + match[0].length;
  }
  source += `${escapeRegExpLiteral(rule.format.slice(cursor))}$`;
  const result = new RegExp(source, "u").exec(branch);
  if (result === null) return undefined;
  const slug = result.groups?.slug;
  const type = result.groups?.type;
  if (slug !== undefined && slug.length > MAX_BRANCH_SLUG_LENGTH) return undefined;
  return { ...(slug === undefined ? {} : { slug }), ...(type === undefined ? {} : { type }) };
}
