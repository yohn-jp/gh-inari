import { createHash } from "node:crypto";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import { type JsonSchema, type JsonSchemaDocument } from "./contract/schema.js";
import { JSON_SCHEMA_DIALECT } from "./contract/ir.js";

/**
 * The representation-independent execution contract for one implementation
 * session.  A GitHub Issue is only one adapter for this value; it is not the
 * domain object itself.
 */
export const IMPLEMENTATION_CONTRACT_VERSION = 1 as const;
export type ImplementationContractVersion = typeof IMPLEMENTATION_CONTRACT_VERSION;

export const IMPLEMENTATION_SCHEMA_VERSION = "1.0.0" as const;
export type ImplementationSchemaVersion = typeof IMPLEMENTATION_SCHEMA_VERSION;

export const IMPLEMENTATION_KIND = "implementation" as const;
export const IMPLEMENTATION_DOMAIN_NAME = "Implementation" as const;
export const IMPLEMENTATION_CLI_NAMESPACE = "impl" as const;
export const IMPLEMENTATION_TEMPLATE_ID = "implementation" as const;
export const IMPLEMENTATION_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/implementation.yml" as const;

export interface ImplementationRepositoryIdentity {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  /** Current owner/name locator; identity is repositoryHost + repositoryId. */
  readonly repository?: string;
}

export interface ImplementationArchitecture {
  readonly decision: string;
  readonly affectedComponents: readonly string[];
  readonly invariants: readonly string[];
  readonly compatibilityConstraints: readonly string[];
}

export interface ImplementationScope {
  /** Readable paths. This does not grant any write operation. */
  readonly readOnly: readonly string[];
  /** Explicitly writable paths. Omission is normalized to an empty allowlist. */
  readonly write: readonly string[];
  /** Paths that may be created; never inferred from WRITE. */
  readonly create: readonly string[];
  /** Paths that may be deleted; never inferred from WRITE. */
  readonly delete: readonly string[];
  /** Explicit exclusions. A matching DENY always overrides an allowlist. */
  readonly deny: readonly string[];
}

export interface ImplementationConstraints {
  readonly prohibitedOperations: readonly string[];
  readonly immutableAreas: readonly string[];
  readonly prerequisites: readonly string[];
}

export interface ImplementationVerification {
  readonly acceptanceCriteria: readonly string[];
  readonly targetedTests: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly postconditions: readonly string[];
}

export interface ImplementationExecutionBinding {
  readonly baseBranch: string;
  /** A revision may be unknown while planning, so it is represented but optional. */
  readonly baseRevision?: string;
  /** A provider-specific freshness claim, kept as data until authorization. */
  readonly baseFreshness?: string;
  /** The intended implementation branch, when already decided. */
  readonly branch?: string;
  readonly dependencies: readonly IssueReference[];
}

export interface ImplementationContract {
  readonly version: ImplementationContractVersion;
  readonly kind: typeof IMPLEMENTATION_KIND;
  readonly repository: ImplementationRepositoryIdentity;
  readonly sources: readonly IssueReference[];
  readonly objective: string;
  readonly nonGoals: readonly string[];
  readonly architecture: ImplementationArchitecture;
  readonly scope: ImplementationScope;
  readonly constraints: ImplementationConstraints;
  readonly verification: ImplementationVerification;
  readonly execution: ImplementationExecutionBinding;
}

export type ImplementationScopeOperation = "READONLY" | "WRITE" | "CREATE" | "DELETE";

export type ImplementationContractViolationCode =
  | "IMPLEMENTATION_INVALID_ROOT"
  | "IMPLEMENTATION_UNKNOWN_PROPERTY"
  | "IMPLEMENTATION_VERSION_UNSUPPORTED"
  | "IMPLEMENTATION_KIND_INVALID"
  | "IMPLEMENTATION_MISSING_FIELD"
  | "IMPLEMENTATION_INVALID_VALUE"
  | "IMPLEMENTATION_AMBIGUOUS_FIELD"
  | "IMPLEMENTATION_REFERENCE_INVALID"
  | "IMPLEMENTATION_REFERENCE_DUPLICATE"
  | "IMPLEMENTATION_SCOPE_INVALID_PATH"
  | "IMPLEMENTATION_SCOPE_DUPLICATE"
  | "IMPLEMENTATION_SCOPE_LIMIT"
  | "IMPLEMENTATION_TEXT_LIMIT"
  | "IMPLEMENTATION_BODY_INVALID"
  | "IMPLEMENTATION_BODY_UNKNOWN_HEADING"
  | "IMPLEMENTATION_BODY_DUPLICATE_FIELD"
  | "IMPLEMENTATION_BODY_MISSING_FIELD";

export interface ImplementationContractViolation {
  readonly code: ImplementationContractViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationContractValidationResult {
  readonly valid: boolean;
  readonly contract?: ImplementationContract;
  readonly violations: readonly ImplementationContractViolation[];
}

export class ImplementationContractError extends Error {
  readonly code: ImplementationContractViolationCode;
  readonly path: string;
  readonly violations: readonly ImplementationContractViolation[];

  constructor(violations: readonly ImplementationContractViolation[], options?: ErrorOptions) {
    const first = violations[0];
    if (first === undefined) throw new Error("Implementation contract errors require at least one violation.");
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"), options);
    this.name = "ImplementationContractError";
    this.code = first.code;
    this.path = first.path;
    this.violations = Object.freeze([...violations]);
  }

  toJSON(): {
    code: ImplementationContractViolationCode;
    path: string;
    message: string;
    violations: readonly ImplementationContractViolation[];
  } {
    return {
      code: this.code,
      path: this.path,
      message: this.message,
      violations: this.violations,
    };
  }
}

export interface ImplementationIssueFields {
  readonly repository: string;
  readonly sources: string;
  readonly objective: string;
  readonly non_goals: string;
  readonly architecture_decision: string;
  readonly affected_components?: string;
  readonly invariants: string;
  readonly compatibility_constraints?: string;
  readonly readonly_scope: string;
  readonly write_scope?: string;
  readonly create_scope?: string;
  readonly delete_scope?: string;
  readonly deny_scope?: string;
  readonly prohibited_operations?: string;
  readonly immutable_areas?: string;
  readonly prerequisites?: string;
  readonly acceptance_criteria: string;
  readonly targeted_tests: string;
  readonly required_checks: string;
  readonly postconditions: string;
  readonly base_branch: string;
  readonly base_revision?: string;
  readonly base_freshness?: string;
  readonly implementation_branch?: string;
  readonly dependencies?: string;
}

export const IMPLEMENTATION_TEMPLATE_FIELD_IDS = Object.freeze({
  repository: "repository",
  sources: "sources",
  objective: "objective",
  nonGoals: "non_goals",
  architectureDecision: "architecture_decision",
  affectedComponents: "affected_components",
  invariants: "invariants",
  compatibilityConstraints: "compatibility_constraints",
  readOnlyScope: "readonly_scope",
  writeScope: "write_scope",
  createScope: "create_scope",
  deleteScope: "delete_scope",
  denyScope: "deny_scope",
  prohibitedOperations: "prohibited_operations",
  immutableAreas: "immutable_areas",
  prerequisites: "prerequisites",
  acceptanceCriteria: "acceptance_criteria",
  targetedTests: "targeted_tests",
  requiredChecks: "required_checks",
  postconditions: "postconditions",
  baseBranch: "base_branch",
  baseRevision: "base_revision",
  baseFreshness: "base_freshness",
  implementationBranch: "implementation_branch",
  dependencies: "dependencies",
} as const);

export type ImplementationTemplateFieldId =
  (typeof IMPLEMENTATION_TEMPLATE_FIELD_IDS)[keyof typeof IMPLEMENTATION_TEMPLATE_FIELD_IDS];
export type ImplementationTemplateFieldKey = keyof typeof IMPLEMENTATION_TEMPLATE_FIELD_IDS;

export const IMPLEMENTATION_TEMPLATE_FIELD_LABELS = Object.freeze({
  repository: "Repository identity",
  sources: "Source Issues",
  objective: "Objective",
  non_goals: "Non-goals",
  architecture_decision: "Architecture decision",
  affected_components: "Affected components",
  invariants: "Invariants",
  compatibility_constraints: "Compatibility constraints",
  readonly_scope: "READONLY scope",
  write_scope: "WRITE scope",
  create_scope: "CREATE scope",
  delete_scope: "DELETE scope",
  deny_scope: "DENY / exclusions",
  prohibited_operations: "Prohibited operations",
  immutable_areas: "Immutable areas",
  prerequisites: "Prerequisites",
  acceptance_criteria: "Acceptance criteria",
  targeted_tests: "Targeted tests",
  required_checks: "Required checks",
  postconditions: "Observable postconditions",
  base_branch: "Base branch",
  base_revision: "Base revision",
  base_freshness: "Base freshness",
  implementation_branch: "Implementation branch",
  dependencies: "Execution dependencies",
} as const);

export interface ImplementationIssueBodyParseResult {
  readonly valid: boolean;
  readonly contract?: ImplementationContract;
  readonly fields?: ImplementationIssueFields;
  readonly violations: readonly ImplementationContractViolation[];
}

const MAX_TEXT_LENGTH = 16_384;
const MAX_PATH_LENGTH = 1_024;
const MAX_LIST_ITEMS = 256;
const MAX_SOURCES = 64;
const MAX_BODY_LENGTH = 1_000_000;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const IMPLEMENTATION_MARKER = "<!-- inari:implementation v1 -->";

const ROOT_KEYS = new Set([
  "version",
  "kind",
  "repository",
  "sources",
  "objective",
  "nonGoals",
  "architecture",
  "scope",
  "constraints",
  "verification",
  "execution",
]);
const REPOSITORY_KEYS = new Set(["repositoryHost", "repositoryId", "repository"]);
const ARCHITECTURE_KEYS = new Set(["decision", "affectedComponents", "invariants", "compatibilityConstraints"]);
const SCOPE_KEYS = new Set(["readOnly", "write", "create", "delete", "deny"]);
const CONSTRAINT_KEYS = new Set(["prohibitedOperations", "immutableAreas", "prerequisites"]);
const VERIFICATION_KEYS = new Set(["acceptanceCriteria", "targetedTests", "requiredChecks", "postconditions"]);
const EXECUTION_KEYS = new Set(["baseBranch", "baseRevision", "baseFreshness", "branch", "dependencies"]);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function addViolation(
  violations: ImplementationContractViolation[],
  code: ImplementationContractViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function checkUnknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: ImplementationContractViolation[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key))
      addViolation(
        violations,
        "IMPLEMENTATION_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        `Property "${key}" is not supported.`,
      );
  }
}

function normalizeText(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
  required = true,
): string | undefined {
  if (typeof value !== "string") {
    if (required) addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Value must be a string.");
    return undefined;
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    if (required) addViolation(violations, "IMPLEMENTATION_MISSING_FIELD", path, "Value must not be empty.");
    return undefined;
  }
  if (normalized.length > MAX_TEXT_LENGTH) {
    addViolation(violations, "IMPLEMENTATION_TEXT_LIMIT", path, `Value exceeds ${MAX_TEXT_LENGTH} characters.`);
    return undefined;
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
    addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Value contains a control character.");
    return undefined;
  }
  return normalized;
}

function requireProperty(
  value: RecordValue,
  key: string,
  path: string,
  violations: ImplementationContractViolation[],
): unknown {
  if (!hasOwn(value, key)) {
    addViolation(violations, "IMPLEMENTATION_MISSING_FIELD", `${path}.${key}`, "Required property is missing.");
    return undefined;
  }
  return value[key];
}

function normalizeTextList(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
  options: { readonly required?: boolean; readonly sort?: boolean; readonly allowEmpty?: boolean } = {},
): readonly string[] | undefined {
  const required = options.required ?? true;
  if (!Array.isArray(value)) {
    if (required) addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Value must be an array of strings.");
    return undefined;
  }
  if (value.length > MAX_LIST_ITEMS) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_LIMIT", path, `List exceeds ${MAX_LIST_ITEMS} items.`);
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const normalized = normalizeText(entry, `${path}[${index}]`, violations);
    if (normalized === undefined) return;
    if (seen.has(normalized)) {
      addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", `${path}[${index}]`, "Values must be unique.");
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  if (result.length === 0 && required && !(options.allowEmpty ?? false))
    addViolation(violations, "IMPLEMENTATION_MISSING_FIELD", path, "At least one value is required.");
  if (options.sort === true) result.sort(compareStrings);
  return result;
}

function normalizePath(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
): string | undefined {
  const raw = normalizeText(value, path, violations);
  if (raw === undefined) return undefined;
  const normalized = raw.replaceAll("\\", "/").replace(/\/{2,}/gu, "/");
  const segments = normalized.split("/");
  if (
    normalized.length > MAX_PATH_LENGTH ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment.length === 0) ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    addViolation(
      violations,
      "IMPLEMENTATION_SCOPE_INVALID_PATH",
      path,
      "Scope paths must be bounded repository-relative paths or globs without parent traversal.",
    );
    return undefined;
  }
  return normalized;
}

function normalizePathList(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
  required: boolean,
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    if (required) addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Scope must be an array of paths.");
    return undefined;
  }
  if (value.length > MAX_LIST_ITEMS) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_LIMIT", path, `Scope exceeds ${MAX_LIST_ITEMS} paths.`);
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const normalized = normalizePath(entry, `${path}[${index}]`, violations);
    if (normalized === undefined) return;
    if (seen.has(normalized)) {
      addViolation(violations, "IMPLEMENTATION_SCOPE_DUPLICATE", `${path}[${index}]`, "Scope paths must be unique.");
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result.sort(compareStrings);
}

function normalizeRepository(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
): ImplementationRepositoryIdentity | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Repository identity must be an object.");
    return undefined;
  }
  checkUnknownProperties(value, REPOSITORY_KEYS, path, violations);
  const host = normalizeText(
    requireProperty(value, "repositoryHost", path, violations),
    `${path}.repositoryHost`,
    violations,
  );
  const id = normalizeText(
    requireProperty(value, "repositoryId", path, violations),
    `${path}.repositoryId`,
    violations,
  );
  const repository = normalizeText(value.repository, `${path}.repository`, violations, false);
  if (host !== undefined && /[\s/]/u.test(host))
    addViolation(
      violations,
      "IMPLEMENTATION_INVALID_VALUE",
      `${path}.repositoryHost`,
      "repositoryHost must not contain whitespace or path separators.",
    );
  if (id !== undefined && !REPOSITORY_ID_PATTERN.test(id))
    addViolation(
      violations,
      "IMPLEMENTATION_INVALID_VALUE",
      `${path}.repositoryId`,
      "repositoryId must be a positive decimal ID.",
    );
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository))
    addViolation(
      violations,
      "IMPLEMENTATION_INVALID_VALUE",
      `${path}.repository`,
      "repository must be an owner/name locator.",
    );
  if (host === undefined || id === undefined) return undefined;
  return {
    repositoryHost: host.toLocaleLowerCase("en-US"),
    repositoryId: id,
    ...(repository === undefined ? {} : { repository: repository.toLocaleLowerCase("en-US") }),
  };
}

function normalizeReferences(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
  required: boolean,
): readonly IssueReference[] | undefined {
  if (!Array.isArray(value)) {
    if (required) addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Issue references must be an array.");
    return undefined;
  }
  if (value.length > MAX_SOURCES) {
    addViolation(violations, "IMPLEMENTATION_SCOPE_LIMIT", path, `Issue references exceed ${MAX_SOURCES} items.`);
    return undefined;
  }
  const result: IssueReference[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const normalized = normalizeIssueReference(entry, `${path}[${index}]`);
    if (!normalized.valid || normalized.reference === undefined) {
      addViolation(violations, "IMPLEMENTATION_REFERENCE_INVALID", `${path}[${index}]`, "Issue reference is invalid.");
      return;
    }
    const key = issueReferenceKey(normalized.reference);
    if (seen.has(key)) {
      addViolation(
        violations,
        "IMPLEMENTATION_REFERENCE_DUPLICATE",
        `${path}[${index}]`,
        "Issue references must be unique.",
      );
      return;
    }
    seen.add(key);
    result.push(normalized.reference);
  });
  if (result.length === 0 && required)
    addViolation(violations, "IMPLEMENTATION_MISSING_FIELD", path, "At least one source Issue is required.");
  return result.sort(
    (left, right) =>
      left.repositoryHost.localeCompare(right.repositoryHost, "en-US") ||
      left.repositoryId.localeCompare(right.repositoryId, "en-US") ||
      left.number - right.number,
  );
}

function normalizeObject(
  value: unknown,
  path: string,
  keys: ReadonlySet<string>,
  violations: ImplementationContractViolation[],
): RecordValue | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "IMPLEMENTATION_INVALID_VALUE", path, "Value must be an object.");
    return undefined;
  }
  checkUnknownProperties(value, keys, path, violations);
  return value;
}

function normalizeContract(input: unknown): ImplementationContractValidationResult {
  const violations: ImplementationContractViolation[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      violations: [{ code: "IMPLEMENTATION_INVALID_ROOT", path: "$", message: "Contract must be a JSON object." }],
    };
  }
  checkUnknownProperties(input, ROOT_KEYS, "$", violations);
  if (input.version !== IMPLEMENTATION_CONTRACT_VERSION && input.version !== String(IMPLEMENTATION_CONTRACT_VERSION))
    addViolation(
      violations,
      "IMPLEMENTATION_VERSION_UNSUPPORTED",
      "$.version",
      "Only Implementation contract version 1 is supported.",
    );
  if (input.kind !== IMPLEMENTATION_KIND)
    addViolation(violations, "IMPLEMENTATION_KIND_INVALID", "$.kind", 'kind must be "implementation".');

  const repository = normalizeRepository(
    requireProperty(input, "repository", "$", violations),
    "$.repository",
    violations,
  );
  const sources = normalizeReferences(
    requireProperty(input, "sources", "$", violations),
    "$.sources",
    violations,
    true,
  );
  const objective = normalizeText(requireProperty(input, "objective", "$", violations), "$.objective", violations);
  const nonGoals = normalizeTextList(requireProperty(input, "nonGoals", "$", violations), "$.nonGoals", violations, {
    required: true,
    sort: true,
  });

  const architectureInput = normalizeObject(
    requireProperty(input, "architecture", "$", violations),
    "$.architecture",
    ARCHITECTURE_KEYS,
    violations,
  );
  const decision =
    architectureInput === undefined
      ? undefined
      : normalizeText(
          requireProperty(architectureInput, "decision", "$.architecture", violations),
          "$.architecture.decision",
          violations,
        );
  const affectedComponents =
    architectureInput === undefined
      ? undefined
      : normalizeTextList(architectureInput.affectedComponents ?? [], "$.architecture.affectedComponents", violations, {
          required: true,
          sort: true,
          allowEmpty: true,
        });
  const invariants =
    architectureInput === undefined
      ? undefined
      : normalizeTextList(
          requireProperty(architectureInput, "invariants", "$.architecture", violations),
          "$.architecture.invariants",
          violations,
          { required: true, sort: true },
        );
  const compatibilityConstraints =
    architectureInput === undefined
      ? undefined
      : normalizeTextList(
          architectureInput.compatibilityConstraints ?? [],
          "$.architecture.compatibilityConstraints",
          violations,
          { required: true, sort: true, allowEmpty: true },
        );

  const scopeInput = normalizeObject(
    requireProperty(input, "scope", "$", violations),
    "$.scope",
    SCOPE_KEYS,
    violations,
  );
  const readOnly =
    scopeInput === undefined
      ? undefined
      : normalizePathList(
          requireProperty(scopeInput, "readOnly", "$.scope", violations),
          "$.scope.readOnly",
          violations,
          true,
        );
  const write =
    scopeInput === undefined ? undefined : normalizePathList(scopeInput.write ?? [], "$.scope.write", violations, true);
  const create =
    scopeInput === undefined
      ? undefined
      : normalizePathList(scopeInput.create ?? [], "$.scope.create", violations, true);
  const deleteScope =
    scopeInput === undefined
      ? undefined
      : normalizePathList(scopeInput.delete ?? [], "$.scope.delete", violations, true);
  const deny =
    scopeInput === undefined ? undefined : normalizePathList(scopeInput.deny ?? [], "$.scope.deny", violations, true);

  const constraintsInput = normalizeObject(
    requireProperty(input, "constraints", "$", violations),
    "$.constraints",
    CONSTRAINT_KEYS,
    violations,
  );
  const prohibitedOperations =
    constraintsInput === undefined
      ? undefined
      : normalizeTextList(
          constraintsInput.prohibitedOperations ?? [],
          "$.constraints.prohibitedOperations",
          violations,
          { required: true, sort: true, allowEmpty: true },
        );
  const immutableAreas =
    constraintsInput === undefined
      ? undefined
      : normalizeTextList(constraintsInput.immutableAreas ?? [], "$.constraints.immutableAreas", violations, {
          required: true,
          sort: true,
          allowEmpty: true,
        });
  const prerequisites =
    constraintsInput === undefined
      ? undefined
      : normalizeTextList(constraintsInput.prerequisites ?? [], "$.constraints.prerequisites", violations, {
          required: true,
          sort: true,
          allowEmpty: true,
        });

  const verificationInput = normalizeObject(
    requireProperty(input, "verification", "$", violations),
    "$.verification",
    VERIFICATION_KEYS,
    violations,
  );
  const acceptanceCriteria =
    verificationInput === undefined
      ? undefined
      : normalizeTextList(
          requireProperty(verificationInput, "acceptanceCriteria", "$.verification", violations),
          "$.verification.acceptanceCriteria",
          violations,
          { required: true, sort: false },
        );
  const targetedTests =
    verificationInput === undefined
      ? undefined
      : normalizeTextList(
          requireProperty(verificationInput, "targetedTests", "$.verification", violations),
          "$.verification.targetedTests",
          violations,
          { required: true, sort: false, allowEmpty: true },
        );
  const requiredChecks =
    verificationInput === undefined
      ? undefined
      : normalizeTextList(
          requireProperty(verificationInput, "requiredChecks", "$.verification", violations),
          "$.verification.requiredChecks",
          violations,
          { required: true, sort: true, allowEmpty: true },
        );
  const postconditions =
    verificationInput === undefined
      ? undefined
      : normalizeTextList(
          requireProperty(verificationInput, "postconditions", "$.verification", violations),
          "$.verification.postconditions",
          violations,
          { required: true, sort: false, allowEmpty: true },
        );

  const executionInput = normalizeObject(
    requireProperty(input, "execution", "$", violations),
    "$.execution",
    EXECUTION_KEYS,
    violations,
  );
  const baseBranch =
    executionInput === undefined
      ? undefined
      : normalizeText(
          requireProperty(executionInput, "baseBranch", "$.execution", violations),
          "$.execution.baseBranch",
          violations,
        );
  const baseRevision =
    executionInput === undefined
      ? undefined
      : normalizeText(executionInput.baseRevision, "$.execution.baseRevision", violations, false);
  const baseFreshness =
    executionInput === undefined
      ? undefined
      : normalizeText(executionInput.baseFreshness, "$.execution.baseFreshness", violations, false);
  const branch =
    executionInput === undefined
      ? undefined
      : normalizeText(executionInput.branch, "$.execution.branch", violations, false);
  const dependencies =
    executionInput === undefined
      ? undefined
      : normalizeReferences(executionInput.dependencies ?? [], "$.execution.dependencies", violations, true);
  if (baseBranch !== undefined && !BRANCH_PATTERN.test(baseBranch))
    addViolation(
      violations,
      "IMPLEMENTATION_INVALID_VALUE",
      "$.execution.baseBranch",
      "baseBranch is not a valid branch name.",
    );
  if (branch !== undefined && !BRANCH_PATTERN.test(branch))
    addViolation(
      violations,
      "IMPLEMENTATION_INVALID_VALUE",
      "$.execution.branch",
      "branch is not a valid branch name.",
    );

  if (
    repository === undefined ||
    sources === undefined ||
    objective === undefined ||
    nonGoals === undefined ||
    decision === undefined ||
    affectedComponents === undefined ||
    invariants === undefined ||
    compatibilityConstraints === undefined ||
    readOnly === undefined ||
    write === undefined ||
    create === undefined ||
    deleteScope === undefined ||
    deny === undefined ||
    prohibitedOperations === undefined ||
    immutableAreas === undefined ||
    prerequisites === undefined ||
    acceptanceCriteria === undefined ||
    targetedTests === undefined ||
    requiredChecks === undefined ||
    postconditions === undefined ||
    baseBranch === undefined ||
    dependencies === undefined
  )
    return { valid: false, violations };

  if (violations.length > 0) return { valid: false, violations };
  const contract: ImplementationContract = freezeDeep({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources,
    objective,
    nonGoals,
    architecture: { decision, affectedComponents, invariants, compatibilityConstraints },
    scope: { readOnly, write, create, delete: deleteScope, deny },
    constraints: { prohibitedOperations, immutableAreas, prerequisites },
    verification: { acceptanceCriteria, targetedTests, requiredChecks, postconditions },
    execution: {
      baseBranch,
      ...(baseRevision === undefined ? {} : { baseRevision }),
      ...(baseFreshness === undefined ? {} : { baseFreshness }),
      ...(branch === undefined ? {} : { branch }),
      dependencies,
    },
  });
  return { valid: true, contract, violations: [] };
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeDeep(entry))) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) result[key] = freezeDeep(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are not supported.");
    return String(value);
  }
  if (typeof value !== "object" || value === undefined)
    throw new TypeError("Only JSON-compatible values are supported.");
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort(compareStrings)
          .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
          .join(",")}}`
      : (() => {
          throw new TypeError("Only plain JSON objects are supported.");
        })();
  stack.delete(value);
  return result;
}

export function validateImplementationContract(input: unknown): ImplementationContractValidationResult {
  return normalizeContract(input);
}

export function isImplementationContract(input: unknown): input is ImplementationContract {
  return normalizeContract(input).valid;
}

export function parseImplementationContract(input: unknown): ImplementationContract {
  const result = normalizeContract(input);
  if (!result.valid || result.contract === undefined) throw new ImplementationContractError(result.violations);
  return result.contract;
}

export function assertImplementationContract(input: unknown): asserts input is ImplementationContract {
  parseImplementationContract(input);
}

/** Canonical JSON used for equality, digesting, and later authorization. */
export function serializeImplementationContract(input: unknown): string {
  return stableSerialize(parseImplementationContract(input));
}

export function deserializeImplementationContract(serialized: string): ImplementationContract {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (cause: unknown) {
    throw new ImplementationContractError(
      [{ code: "IMPLEMENTATION_INVALID_VALUE", path: "$", message: "Serialized contract must contain valid JSON." }],
      { cause },
    );
  }
  return parseImplementationContract(value);
}

export function implementationContractDigest(input: unknown): string {
  return createHash("sha256").update(serializeImplementationContract(input), "utf8").digest("hex");
}

function listValue(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `- ${value}`).join("\n");
}

function referenceValue(reference: IssueReference): string {
  return stableSerialize(reference);
}

function repositoryValue(repository: ImplementationRepositoryIdentity): string {
  return stableSerialize(repository);
}

export function implementationIssueFieldsFromContract(input: unknown): ImplementationIssueFields {
  const contract = parseImplementationContract(input);
  return {
    repository: repositoryValue(contract.repository),
    sources: contract.sources.map(referenceValue).join("\n"),
    objective: contract.objective,
    non_goals: listValue(contract.nonGoals),
    architecture_decision: contract.architecture.decision,
    affected_components: listValue(contract.architecture.affectedComponents),
    invariants: listValue(contract.architecture.invariants),
    compatibility_constraints: listValue(contract.architecture.compatibilityConstraints),
    readonly_scope: listValue(contract.scope.readOnly),
    write_scope: listValue(contract.scope.write),
    create_scope: listValue(contract.scope.create),
    delete_scope: listValue(contract.scope.delete),
    deny_scope: listValue(contract.scope.deny),
    prohibited_operations: listValue(contract.constraints.prohibitedOperations),
    immutable_areas: listValue(contract.constraints.immutableAreas),
    prerequisites: listValue(contract.constraints.prerequisites),
    acceptance_criteria: listValue(contract.verification.acceptanceCriteria),
    targeted_tests: listValue(contract.verification.targetedTests),
    required_checks: listValue(contract.verification.requiredChecks),
    postconditions: listValue(contract.verification.postconditions),
    base_branch: contract.execution.baseBranch,
    ...(contract.execution.baseRevision === undefined ? {} : { base_revision: contract.execution.baseRevision }),
    ...(contract.execution.baseFreshness === undefined ? {} : { base_freshness: contract.execution.baseFreshness }),
    ...(contract.execution.branch === undefined ? {} : { implementation_branch: contract.execution.branch }),
    ...(contract.execution.dependencies.length === 0
      ? {}
      : { dependencies: contract.execution.dependencies.map(referenceValue).join("\n") }),
  };
}

function parseListField(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
  required: boolean,
): string[] | undefined {
  if (value === undefined) {
    if (required)
      addViolation(violations, "IMPLEMENTATION_BODY_MISSING_FIELD", path, "Required Issue Form field is missing.");
    return required ? undefined : [];
  }
  if (typeof value !== "string") {
    addViolation(violations, "IMPLEMENTATION_BODY_INVALID", path, "Issue Form field must be text.");
    return undefined;
  }
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (
    normalized.length === 0 ||
    normalized.toLocaleLowerCase("en-US") === "none" ||
    normalized.toLocaleLowerCase("en-US") === "_no response_"
  )
    return [];
  const entries = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .replace(/^[-+*]\s+/u, "")
        .replace(/^\[[ xX]\]\s+/u, "")
        .trim(),
    );
  return entries;
}

function parseJsonValue(value: unknown, path: string, violations: ImplementationContractViolation[]): unknown {
  if (typeof value !== "string") {
    addViolation(violations, "IMPLEMENTATION_BODY_INVALID", path, "Issue Form field must contain JSON text.");
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    addViolation(violations, "IMPLEMENTATION_BODY_INVALID", path, "Issue Form field contains invalid JSON.");
    return undefined;
  }
}

function parseReferencesField(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
  required: boolean,
): readonly IssueReference[] | undefined {
  if (value === undefined) {
    if (required)
      addViolation(violations, "IMPLEMENTATION_BODY_MISSING_FIELD", path, "At least one source Issue is required.");
    return required ? undefined : [];
  }
  if (typeof value !== "string") {
    if (required) addViolation(violations, "IMPLEMENTATION_BODY_MISSING_FIELD", path, "Source Issues must be text.");
    return undefined;
  }
  const text = value.trim();
  if (
    text.length === 0 ||
    text.toLocaleLowerCase("en-US") === "none" ||
    text.toLocaleLowerCase("en-US") === "_no response_"
  ) {
    if (required)
      addViolation(violations, "IMPLEMENTATION_BODY_MISSING_FIELD", path, "At least one source Issue is required.");
    return [];
  }
  const parsed: unknown[] = [];
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const valueFromJson = parseJsonValue(line, path, violations);
      if (valueFromJson !== undefined) parsed.push(valueFromJson);
    });
  return parsed.length === 0 && !required ? [] : normalizeReferences(parsed, path, violations, required);
}

function parseRepositoryField(
  value: unknown,
  path: string,
  violations: ImplementationContractViolation[],
): ImplementationRepositoryIdentity | undefined {
  const parsed = parseJsonValue(value, path, violations);
  return parsed === undefined ? undefined : normalizeRepository(parsed, path, violations);
}

export function implementationContractFromIssueFields(input: unknown): ImplementationContractValidationResult {
  const violations: ImplementationContractViolation[] = [];
  if (!isRecord(input))
    return {
      valid: false,
      violations: [{ code: "IMPLEMENTATION_BODY_INVALID", path: "$", message: "Issue Form fields must be an object." }],
    };
  const allowed = new Set(Object.values(IMPLEMENTATION_TEMPLATE_FIELD_IDS));
  checkUnknownProperties(input, allowed, "$", violations);
  const field = (key: ImplementationTemplateFieldKey): unknown => input[IMPLEMENTATION_TEMPLATE_FIELD_IDS[key]];
  const repository = parseRepositoryField(field("repository"), "$.repository", violations);
  const sources = parseReferencesField(field("sources"), "$.sources", violations, true);
  const objective = normalizeText(field("objective"), "$.objective", violations);
  const nonGoals = parseListField(field("nonGoals"), "$.non_goals", violations, true);
  const decision = normalizeText(field("architectureDecision"), "$.architecture_decision", violations);
  const affectedComponents = parseListField(field("affectedComponents"), "$.affected_components", violations, false);
  const invariants = parseListField(field("invariants"), "$.invariants", violations, true);
  const compatibilityConstraints = parseListField(
    field("compatibilityConstraints"),
    "$.compatibility_constraints",
    violations,
    false,
  );
  const readOnly = parseListField(field("readOnlyScope"), "$.readonly_scope", violations, true);
  const write = parseListField(field("writeScope"), "$.write_scope", violations, false);
  const create = parseListField(field("createScope"), "$.create_scope", violations, false);
  const deleteScope = parseListField(field("deleteScope"), "$.delete_scope", violations, false);
  const deny = parseListField(field("denyScope"), "$.deny_scope", violations, false);
  const prohibitedOperations = parseListField(
    field("prohibitedOperations"),
    "$.prohibited_operations",
    violations,
    false,
  );
  const immutableAreas = parseListField(field("immutableAreas"), "$.immutable_areas", violations, false);
  const prerequisites = parseListField(field("prerequisites"), "$.prerequisites", violations, false);
  const acceptanceCriteria = parseListField(field("acceptanceCriteria"), "$.acceptance_criteria", violations, true);
  const targetedTests = parseListField(field("targetedTests"), "$.targeted_tests", violations, true);
  const requiredChecks = parseListField(field("requiredChecks"), "$.required_checks", violations, true);
  const postconditions = parseListField(field("postconditions"), "$.postconditions", violations, true);
  const baseBranch = normalizeText(field("baseBranch"), "$.base_branch", violations);
  const baseRevision = normalizeText(field("baseRevision"), "$.base_revision", violations, false);
  const baseFreshness = normalizeText(field("baseFreshness"), "$.base_freshness", violations, false);
  const branch = normalizeText(field("implementationBranch"), "$.implementation_branch", violations, false);
  const dependencies = parseReferencesField(field("dependencies"), "$.dependencies", violations, false);
  if (
    violations.length > 0 ||
    repository === undefined ||
    sources === undefined ||
    objective === undefined ||
    nonGoals === undefined ||
    decision === undefined ||
    affectedComponents === undefined ||
    invariants === undefined ||
    compatibilityConstraints === undefined ||
    readOnly === undefined ||
    write === undefined ||
    create === undefined ||
    deleteScope === undefined ||
    deny === undefined ||
    prohibitedOperations === undefined ||
    immutableAreas === undefined ||
    prerequisites === undefined ||
    acceptanceCriteria === undefined ||
    targetedTests === undefined ||
    requiredChecks === undefined ||
    postconditions === undefined ||
    baseBranch === undefined ||
    dependencies === undefined
  )
    return { valid: false, violations };
  return validateImplementationContract({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources,
    objective,
    nonGoals,
    architecture: { decision, affectedComponents, invariants, compatibilityConstraints },
    scope: { readOnly, write, create, delete: deleteScope, deny },
    constraints: { prohibitedOperations, immutableAreas, prerequisites },
    verification: { acceptanceCriteria, targetedTests, requiredChecks, postconditions },
    execution: {
      baseBranch,
      ...(baseRevision === undefined ? {} : { baseRevision }),
      ...(baseFreshness === undefined ? {} : { baseFreshness }),
      ...(branch === undefined ? {} : { branch }),
      dependencies,
    },
  });
}

function bodyFieldLines(fields: ImplementationIssueFields): readonly [string, string | undefined][] {
  return [
    ["repository", fields.repository],
    ["sources", fields.sources],
    ["objective", fields.objective],
    ["non_goals", fields.non_goals],
    ["architecture_decision", fields.architecture_decision],
    ["affected_components", fields.affected_components],
    ["invariants", fields.invariants],
    ["compatibility_constraints", fields.compatibility_constraints],
    ["readonly_scope", fields.readonly_scope],
    ["write_scope", fields.write_scope],
    ["create_scope", fields.create_scope],
    ["delete_scope", fields.delete_scope],
    ["deny_scope", fields.deny_scope],
    ["prohibited_operations", fields.prohibited_operations],
    ["immutable_areas", fields.immutable_areas],
    ["prerequisites", fields.prerequisites],
    ["acceptance_criteria", fields.acceptance_criteria],
    ["targeted_tests", fields.targeted_tests],
    ["required_checks", fields.required_checks],
    ["postconditions", fields.postconditions],
    ["base_branch", fields.base_branch],
    ["base_revision", fields.base_revision],
    ["base_freshness", fields.base_freshness],
    ["implementation_branch", fields.implementation_branch],
    ["dependencies", fields.dependencies],
  ];
}

export function renderImplementationIssueBody(input: unknown): string {
  const fields = implementationIssueFieldsFromContract(input);
  const blocks = bodyFieldLines(fields)
    .map(([id, value]) => {
      const label = IMPLEMENTATION_TEMPLATE_FIELD_LABELS[id as keyof typeof IMPLEMENTATION_TEMPLATE_FIELD_LABELS];
      return value === undefined ? undefined : `### ${label}\n\n${value}`;
    })
    .filter((value): value is string => value !== undefined);
  return `${IMPLEMENTATION_MARKER}\n\n${blocks.join("\n\n")}\n`;
}

function bodyHeadingMap(): ReadonlyMap<string, ImplementationTemplateFieldId> {
  return new Map(
    (Object.entries(IMPLEMENTATION_TEMPLATE_FIELD_LABELS) as [ImplementationTemplateFieldId, string][]).map(
      ([id, label]) => [label, id],
    ),
  );
}

export function parseImplementationIssueBody(body: string): ImplementationIssueBodyParseResult {
  const violations: ImplementationContractViolation[] = [];
  if (typeof body !== "string" || body.length > MAX_BODY_LENGTH)
    return {
      valid: false,
      violations: [
        {
          code: "IMPLEMENTATION_BODY_INVALID",
          path: "$",
          message: `Issue body exceeds ${MAX_BODY_LENGTH} characters.`,
        },
      ],
    };
  const source = body
    .replace(/<!--[^>]*-->\s*/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim();
  const lines = source.split("\n");
  const headings = bodyHeadingMap();
  const fields: Record<string, string> = {};
  let current: ImplementationTemplateFieldId | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    if (Object.hasOwn(fields, current)) {
      addViolation(
        violations,
        "IMPLEMENTATION_BODY_DUPLICATE_FIELD",
        `$.${current}`,
        "Issue body field appears more than once.",
      );
    } else {
      fields[current] = buffer.join("\n").trim();
    }
  };
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      const id = headings.get(heading[1] as string);
      if (id === undefined) {
        addViolation(
          violations,
          "IMPLEMENTATION_BODY_UNKNOWN_HEADING",
          "$",
          `Unknown Implementation heading "${heading[1]}".`,
        );
        current = undefined;
      } else {
        current = id;
      }
      buffer = [];
      continue;
    }
    if (current !== undefined) buffer.push(line);
    else if (line.trim().length > 0)
      addViolation(
        violations,
        "IMPLEMENTATION_BODY_INVALID",
        "$",
        "Content must be inside a canonical Implementation field.",
      );
  }
  flush();
  if (violations.length > 0) return { valid: false, violations };
  const result = implementationContractFromIssueFields(fields);
  return result.valid
    ? { valid: true, contract: result.contract, fields: fields as unknown as ImplementationIssueFields, violations: [] }
    : { valid: false, violations: result.violations };
}

/**
 * Return the canonical governed representation of an Issue body.
 *
 * Issue metadata and discussion are deliberately outside this function.  The
 * body is parsed through the canonical Implementation adapter first, so
 * equivalent field formatting receives the same representation and invalid
 * bodies cannot acquire an authorization identity.
 */
export function canonicalizeImplementationIssueBody(body: string): string {
  const parsed = parseImplementationIssueBody(body);
  if (!parsed.valid || parsed.contract === undefined) throw new ImplementationContractError(parsed.violations);
  return serializeImplementationContract(parsed.contract);
}

/** SHA-256 identity of the canonical governed Implementation body. */
export function implementationIssueBodyDigest(body: string): string {
  return createHash("sha256").update(canonicalizeImplementationIssueBody(body), "utf8").digest("hex");
}

/** Compatibility spelling for callers that name the governed body directly. */
export const implementationGovernedBodyDigest = implementationIssueBodyDigest;

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

export function implementationScopePaths(input: unknown, operation: ImplementationScopeOperation): readonly string[] {
  const contract = parseImplementationContract(input);
  if (operation === "READONLY") return contract.scope.readOnly;
  if (operation === "WRITE") return contract.scope.write;
  if (operation === "CREATE") return contract.scope.create;
  return contract.scope.delete;
}

/**
 * Evaluate one path against the explicit Core scope.  This helper is
 * intentionally fail-closed and does not infer CREATE/DELETE from WRITE.
 */
export function isImplementationPathAllowed(
  input: unknown,
  operation: ImplementationScopeOperation,
  path: string,
): boolean {
  const contract = parseImplementationContract(input);
  const pathValue = normalizePath(path, "$.path", []);
  const normalized = pathValue?.replace(/^\.\//u, "");
  if (normalized === undefined || contract.scope.deny.some((entry) => globRegex(entry).test(normalized))) return false;
  return implementationScopePaths(contract, operation).some((entry) => globRegex(entry).test(normalized));
}

export interface ImplementationSchemaDocument extends JsonSchemaDocument {
  readonly $id: "urn:inari:implementation-contract:1.0.0";
}

const stringSchema: JsonSchema = { type: "string", minLength: 1 };
const stringArraySchema: JsonSchema = { type: "array", items: stringSchema, uniqueItems: true };
const pathArraySchema: JsonSchema = { type: "array", items: stringSchema, uniqueItems: true };
const referenceSchema: JsonSchema = {
  type: "object",
  properties: {
    repositoryHost: stringSchema,
    repositoryId: stringSchema,
    repository: stringSchema,
    number: { type: "integer", minimum: 1 },
  },
  required: ["repositoryHost", "repositoryId", "number"],
  additionalProperties: false,
};

export const IMPLEMENTATION_CONTRACT_SCHEMA: ImplementationSchemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: "urn:inari:implementation-contract:1.0.0",
  title: IMPLEMENTATION_DOMAIN_NAME,
  description: "Versioned execution contract for exactly one implementation session.",
  type: "object",
  properties: {
    version: { type: "integer", const: IMPLEMENTATION_CONTRACT_VERSION },
    kind: { type: "string", const: IMPLEMENTATION_KIND },
    repository: {
      type: "object",
      properties: { repositoryHost: stringSchema, repositoryId: stringSchema, repository: stringSchema },
      required: ["repositoryHost", "repositoryId"],
      additionalProperties: false,
    },
    sources: { type: "array", items: referenceSchema, minItems: 1, uniqueItems: true },
    objective: stringSchema,
    nonGoals: stringArraySchema,
    architecture: {
      type: "object",
      properties: {
        decision: stringSchema,
        affectedComponents: stringArraySchema,
        invariants: stringArraySchema,
        compatibilityConstraints: stringArraySchema,
      },
      required: ["decision", "affectedComponents", "invariants", "compatibilityConstraints"],
      additionalProperties: false,
    },
    scope: {
      type: "object",
      properties: {
        readOnly: pathArraySchema,
        write: pathArraySchema,
        create: pathArraySchema,
        delete: pathArraySchema,
        deny: pathArraySchema,
      },
      /**
       * WRITE/CREATE/DELETE/DENY are omissible at the schema boundary; the
       * production parser normalizes an omitted mutation list to an empty
       * allowlist (fail-closed). Only READONLY is required so schema
       * validation and normalizeContract() accept the same documents.
       */
      required: ["readOnly"],
      additionalProperties: false,
    },
    constraints: {
      type: "object",
      properties: {
        prohibitedOperations: stringArraySchema,
        immutableAreas: stringArraySchema,
        prerequisites: stringArraySchema,
      },
      required: ["prohibitedOperations", "immutableAreas", "prerequisites"],
      additionalProperties: false,
    },
    verification: {
      type: "object",
      properties: {
        acceptanceCriteria: stringArraySchema,
        targetedTests: stringArraySchema,
        requiredChecks: stringArraySchema,
        postconditions: stringArraySchema,
      },
      required: ["acceptanceCriteria", "targetedTests", "requiredChecks", "postconditions"],
      additionalProperties: false,
    },
    execution: {
      type: "object",
      properties: {
        baseBranch: stringSchema,
        baseRevision: stringSchema,
        baseFreshness: stringSchema,
        branch: stringSchema,
        dependencies: { type: "array", items: referenceSchema, uniqueItems: true },
      },
      required: ["baseBranch", "dependencies"],
      additionalProperties: false,
    },
  },
  required: [
    "version",
    "kind",
    "repository",
    "sources",
    "objective",
    "nonGoals",
    "architecture",
    "scope",
    "constraints",
    "verification",
    "execution",
  ],
  additionalProperties: false,
};

export function projectImplementationSchema(): ImplementationSchemaDocument {
  return structuredClone(IMPLEMENTATION_CONTRACT_SCHEMA) as ImplementationSchemaDocument;
}

/** Compatibility aliases for callers that use schema/parse terminology. */
export const parseImplementation = parseImplementationContract;
export const serializeImplementation = serializeImplementationContract;
export const deserializeImplementation = deserializeImplementationContract;
export const validateImplementation = validateImplementationContract;
