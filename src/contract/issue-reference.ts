/**
 * Representation-independent Issue identity and dependency semantics.
 *
 * Dependency values intentionally live beside template fields.  They are a
 * generic Issue primitive, rather than a template field or a Portal model,
 * so later consumers can reuse them without learning a repository's Markdown
 * layout.
 */

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

export interface IssueReference {
  /** Canonical, case-folded owner/name repository identity. */
  readonly repository: string;
  readonly number: number;
}

export interface IssueDependencies {
  readonly blockedBy: readonly IssueReference[];
  readonly blocks: readonly IssueReference[];
}

export type IssueDependencyViolationCode =
  | "DEPENDENCIES_NOT_OBJECT"
  | "DEPENDENCIES_UNKNOWN_PROPERTY"
  | "DEPENDENCIES_NOT_ARRAY"
  | "REFERENCE_NOT_OBJECT"
  | "REFERENCE_UNKNOWN_PROPERTY"
  | "REFERENCE_AMBIGUOUS"
  | "REFERENCE_REPOSITORY_INVALID"
  | "REFERENCE_NUMBER_INVALID"
  | "REFERENCE_DUPLICATE"
  | "REFERENCE_SELF"
  | "REFERENCE_CONTRADICTORY";

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

export const EMPTY_ISSUE_DEPENDENCIES: IssueDependencies = Object.freeze({ blockedBy: [], blocks: [] });

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function repositoryKey(reference: IssueReference): string {
  return `${reference.repository}#${reference.number}`;
}

function compareReferences(left: IssueReference, right: IssueReference): number {
  return left.repository.localeCompare(right.repository, "en-US") || left.number - right.number;
}

function invalidResult(violations: readonly IssueDependencyViolation[]): IssueDependencyValidationResult {
  return { valid: false, dependencies: EMPTY_ISSUE_DEPENDENCIES, violations };
}

function referenceViolation(
  code: IssueDependencyViolationCode,
  path: string,
  message: string,
): IssueDependencyViolation {
  return { code, path, message };
}

/**
 * Normalize one generic Issue reference.  String shorthand and URLs are
 * deliberately rejected: accepting both would make repository identity
 * parsing ambiguous and would create multiple spellings for one reference.
 */
export function normalizeIssueReference(input: unknown, path = "$"): IssueReferenceValidationResult {
  if (!isRecord(input)) {
    return {
      valid: false,
      reference: undefined,
      violations: [
        referenceViolation(
          typeof input === "string" || Array.isArray(input) ? "REFERENCE_AMBIGUOUS" : "REFERENCE_NOT_OBJECT",
          path,
          "Issue references must be objects containing repository and number.",
        ),
      ],
    };
  }
  const violations: IssueDependencyViolation[] = [];
  for (const key of Object.keys(input)) {
    if (key !== "repository" && key !== "number") {
      violations.push(
        referenceViolation(
          "REFERENCE_UNKNOWN_PROPERTY",
          `${path}.${key}`,
          `Reference property "${key}" is not supported.`,
        ),
      );
    }
  }
  const repository = input.repository;
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    violations.push(
      referenceViolation(
        repository === "" || typeof repository !== "string" ? "REFERENCE_REPOSITORY_INVALID" : "REFERENCE_AMBIGUOUS",
        `${path}.repository`,
        "Repository must be an owner/name identity without a host, URL, or issue suffix.",
      ),
    );
  }
  const number = input.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    violations.push(
      referenceViolation("REFERENCE_NUMBER_INVALID", `${path}.number`, "Issue number must be a positive safe integer."),
    );
  }
  if (violations.length > 0) return { valid: false, reference: undefined, violations };
  return {
    valid: true,
    reference: { repository: (repository as string).toLocaleLowerCase("en-US"), number: number as number },
    violations: [],
  };
}

export interface IssueReferenceValidationResult {
  readonly valid: boolean;
  readonly reference?: IssueReference;
  readonly violations: readonly IssueDependencyViolation[];
}

/** Canonical validation and projection for Issue dependency declarations. */
export function validateIssueDependencies(input: unknown, subject?: IssueReference): IssueDependencyValidationResult {
  if (input === undefined) return { valid: true, dependencies: EMPTY_ISSUE_DEPENDENCIES, violations: [] };
  if (!isRecord(input)) {
    return invalidResult([referenceViolation("DEPENDENCIES_NOT_OBJECT", "$", "Issue dependencies must be an object.")]);
  }
  const violations: IssueDependencyViolation[] = [];
  const subjectKey = subject === undefined ? undefined : issueReferenceKey(subject);
  for (const key of Object.keys(input)) {
    if (key !== "blockedBy" && key !== "blocks") {
      violations.push(
        referenceViolation(
          "DEPENDENCIES_UNKNOWN_PROPERTY",
          `$.${key}`,
          `Dependency property "${key}" is not supported.`,
        ),
      );
    }
  }

  const parseDirection = (direction: "blockedBy" | "blocks"): IssueReference[] => {
    const raw = input[direction];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      violations.push(
        referenceViolation(
          "DEPENDENCIES_NOT_ARRAY",
          `$.${direction}`,
          `${direction} must be an array of Issue references.`,
        ),
      );
      return [];
    }
    const parsed: IssueReference[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const result = normalizeIssueReference(entry, `$.${direction}[${index}]`);
      violations.push(...result.violations);
      if (!result.valid || result.reference === undefined) return;
      const key = repositoryKey(result.reference);
      if (seen.has(key)) {
        violations.push(
          referenceViolation(
            "REFERENCE_DUPLICATE",
            `$.${direction}[${index}]`,
            `Duplicate ${direction} reference "${key}".`,
          ),
        );
        return;
      }
      seen.add(key);
      if (subjectKey !== undefined && key === subjectKey) {
        violations.push(
          referenceViolation("REFERENCE_SELF", `$.${direction}[${index}]`, "An Issue cannot depend on itself."),
        );
      }
      parsed.push(result.reference);
    });
    return parsed;
  };

  const blockedBy = parseDirection("blockedBy");
  const blocks = parseDirection("blocks");
  const blockedKeys = new Set(blockedBy.map(repositoryKey));
  blocks.forEach((reference, index) => {
    if (blockedKeys.has(repositoryKey(reference))) {
      violations.push(
        referenceViolation(
          "REFERENCE_CONTRADICTORY",
          `$.blocks[${index}]`,
          `The same reference cannot appear in both blockedBy and blocks (${repositoryKey(reference)}).`,
        ),
      );
    }
  });
  if (violations.length > 0) return invalidResult(violations);
  return {
    valid: true,
    dependencies: {
      blockedBy: [...blockedBy].sort(compareReferences),
      blocks: [...blocks].sort(compareReferences),
    },
    violations: [],
  };
}

export const normalizeIssueDependencies = validateIssueDependencies;
export const projectIssueDependencies = validateIssueDependencies;

/** Stable key useful to adapters without exposing parsing rules. */
export function issueReferenceKey(reference: IssueReference): string {
  return repositoryKey({ repository: reference.repository.toLocaleLowerCase("en-US"), number: reference.number });
}
