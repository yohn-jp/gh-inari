/**
 * Versioned Artifact Contract IR (Core authority model).
 *
 * Authority: `docs/SEMANTIC_ARTIFACT_CONTRACTS.md` (#279 / PR #280) for the
 * authority/cardinality/derivation model, refined by the closed Canon v2
 * vocabulary frozen in #287.
 *
 * Canon v2 is a closed-world model. There are exactly three governed
 * artifact kinds (`issue`, `branch`, `pull_request`), and each kind accepts
 * exactly the Core-owned semantic properties fixed by #287 below. A
 * repository contract may only select, per recognized property:
 *
 * - `presence`   — `required | optional | unused`
 * - `authority`  — `supplied | derived | fixed | platform`
 * - Core-owned, shape-appropriate constraints
 * - a bounded Core-owned derivation, only when `authority = derived`
 *
 * Cardinality is intrinsic Core vocabulary (e.g. `parent` is always
 * zero-or-one, `dependsOn` is always many); repositories choose `presence`,
 * not multiplicity. This module never accepts an arbitrary top-level
 * property name, an arbitrary field primitive, or a freely-chosen
 * type/cardinality: unknown properties, unknown field primitives, unknown
 * authority kinds, and invalid derivations all fail closed.
 *
 * The only repository-specific extension point is `fields`: an ordered
 * list of body fields limited to four Core-owned primitives (`text`,
 * `choice`, `checklist`, `attachment`). Raw GitHub Markdown and Issue Form
 * widget types (`input`/`textarea`/`dropdown`/`checkboxes`/`upload`/
 * `markdown`) are projections of this vocabulary, not Canon semantics, and
 * are therefore out of scope for this module.
 *
 * This module is representation-independent: no GitHub Markdown, Actions,
 * MCP, or CLI concerns. It parses and validates repository-owned Artifact
 * Contract data into one normalized Core IR. It deliberately does not
 * compile an Effective Contract/input schema, materialize a Semantic
 * Artifact, or project GitHub state; those remain separate follow-up
 * leaves per the architecture document's decomposition (section 18).
 *
 * `src/semantic-template.ts` (v1) is untouched and remains the executable
 * compatibility authority. v1's `SemanticInputType` maps onto the `fields`
 * primitives here: `string` -> `text`; a plain or multi-select `array` ->
 * `choice`; `checklist` -> `checklist`. v1 has no attachment field today.
 */

import { normalizeIssueReference, type IssueReference } from "./issue-reference.js";

export const ARTIFACT_CONTRACT_VERSION = "1" as const;
export type ArtifactContractVersion = typeof ARTIFACT_CONTRACT_VERSION;

export const ARTIFACT_CONTRACT_KINDS = ["issue", "branch", "pull_request"] as const;
export type ArtifactContractKind = (typeof ARTIFACT_CONTRACT_KINDS)[number];

export type Presence = "required" | "optional" | "unused";
const PRESENCE_VALUES: readonly Presence[] = ["required", "optional", "unused"];

export type Multiplicity = "single" | "many";

export interface Cardinality {
  readonly min: number;
  readonly max: number | "many";
}

/** Core-owned closed vocabulary for what shape of value a property/field holds. */
export const VALUE_SHAPES = [
  "text",
  "classification",
  "label",
  "actor",
  "milestone_reference",
  "issue_reference",
  "boolean",
] as const;
export type ValueShape = (typeof VALUE_SHAPES)[number];

/** Scalar members exposed by a value shape for derivation placeholders such as `{issue.number}`. */
const VALUE_SHAPE_MEMBERS: Partial<Record<ValueShape, readonly string[]>> = {
  issue_reference: ["number"],
};

export const FIELD_PRIMITIVES = ["text", "choice", "checklist", "attachment"] as const;
export type FieldPrimitive = (typeof FIELD_PRIMITIVES)[number];

export type DerivationSpec =
  | { readonly op: "copy"; readonly from: string }
  | { readonly op: "format"; readonly template: string }
  | { readonly op: "slug"; readonly from: string };

export type FixedScalarValue = string | boolean | IssueReference;
export type FixedValue = FixedScalarValue | readonly FixedScalarValue[];

export type ValueAuthority =
  | { readonly kind: "supplied" }
  | { readonly kind: "platform" }
  | { readonly kind: "derived"; readonly derive: DerivationSpec }
  | { readonly kind: "fixed"; readonly value: FixedValue };

export interface PropertyConstraints {
  /** Closed value set for `classification` (required) and `label` (optional). */
  readonly values?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  /** List-length bounds for many-valued properties. */
  readonly minItems?: number;
  readonly maxItems?: number;
}

export type PropertyValueDeclaration =
  | { readonly presence: "unused"; readonly shape: ValueShape; readonly cardinality: Cardinality }
  | {
      readonly presence: "required" | "optional";
      readonly shape: ValueShape;
      readonly cardinality: Cardinality;
      readonly authority: ValueAuthority;
      readonly constraints?: PropertyConstraints;
    };

export interface ChecklistItemDeclaration {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
}

export interface FieldContentConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  /** Closed option set for `choice`. */
  readonly values?: readonly string[];
  /** Selection/attachment count bounds for `choice` and `attachment`. */
  readonly minItems?: number;
  readonly maxItems?: number;
  /** Ordered items for `checklist`. */
  readonly items?: readonly ChecklistItemDeclaration[];
}

export type FieldDeclaration =
  | {
      readonly id: string;
      readonly primitive: FieldPrimitive;
      readonly presence: "unused";
      readonly cardinality: Cardinality;
    }
  | {
      readonly id: string;
      readonly primitive: FieldPrimitive;
      readonly presence: "required" | "optional";
      readonly cardinality: Cardinality;
      readonly authority: ValueAuthority;
      readonly constraints?: FieldContentConstraints;
    };

export interface ArtifactContract {
  readonly version: ArtifactContractVersion;
  readonly kind: ArtifactContractKind;
  readonly id: string;
  readonly properties: Readonly<Record<string, PropertyValueDeclaration>>;
  /** Only present for `issue` and `pull_request`; `branch` has no body fields. */
  readonly fields?: readonly FieldDeclaration[];
}

export type ArtifactContractViolationCode =
  | "ARTIFACT_CONTRACT_INVALID_JSON"
  | "ARTIFACT_CONTRACT_NOT_OBJECT"
  | "ARTIFACT_CONTRACT_MISSING_PROPERTY"
  | "ARTIFACT_CONTRACT_UNKNOWN_PROPERTY"
  | "ARTIFACT_CONTRACT_INVALID_VALUE"
  | "ARTIFACT_CONTRACT_UNSUPPORTED_VERSION"
  | "ARTIFACT_CONTRACT_UNSUPPORTED_KIND"
  | "ARTIFACT_CONTRACT_INVALID_IDENTIFIER"
  | "ARTIFACT_CONTRACT_UNKNOWN_SEMANTIC_PROPERTY"
  | "ARTIFACT_CONTRACT_UNSUPPORTED_FIELD_PRIMITIVE"
  | "ARTIFACT_CONTRACT_UNKNOWN_AUTHORITY"
  | "ARTIFACT_CONTRACT_INVALID_CONSTRAINT"
  | "ARTIFACT_CONTRACT_MISSING_FIXED_VALUE"
  | "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE"
  | "ARTIFACT_CONTRACT_INVALID_DERIVATION"
  | "ARTIFACT_CONTRACT_UNDECLARED_DEPENDENCY"
  | "ARTIFACT_CONTRACT_DERIVATION_CYCLE";

export interface ArtifactContractViolation {
  readonly code: ArtifactContractViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface ArtifactContractValidationResult {
  readonly valid: boolean;
  readonly violations: readonly ArtifactContractViolation[];
}

export class ArtifactContractValidationError extends Error {
  readonly violations: readonly ArtifactContractViolation[];

  constructor(violations: readonly ArtifactContractViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "ArtifactContractValidationError";
    this.violations = violations;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function addViolation(
  violations: ArtifactContractViolation[],
  code: ArtifactContractViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function checkUnknownKeys(
  record: UnknownRecord,
  allowedKeys: readonly string[],
  path: string,
  violations: ArtifactContractViolation[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        `Property "${key}" is not supported.`,
      );
    }
  }
}

function requiredString(
  record: UnknownRecord,
  key: string,
  path: string,
  violations: ArtifactContractViolation[],
): string | undefined {
  if (!hasOwn(record, key)) {
    addViolation(violations, "ARTIFACT_CONTRACT_MISSING_PROPERTY", `${path}.${key}`, `Property "${key}" is required.`);
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_VALUE",
      `${path}.${key}`,
      `Property "${key}" must be a non-empty string.`,
    );
    return undefined;
  }
  return value;
}

function optionalNonNegativeInteger(
  record: UnknownRecord,
  key: string,
  path: string,
  violations: ArtifactContractViolation[],
): number | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      `${path}.${key}`,
      `Property "${key}" must be a non-negative safe integer.`,
    );
    return undefined;
  }
  return value;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u;

function validateIdentifier(value: string, path: string, violations: ArtifactContractViolation[]): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_IDENTIFIER",
      path,
      "Identifiers must be non-empty and contain only letters, numbers, hyphens, or underscores.",
    );
  }
}

interface ParsedReference {
  readonly name: string;
  readonly member?: string;
}

function parseReference(raw: string): ParsedReference | undefined {
  if (!REFERENCE_PATTERN.test(raw)) return undefined;
  const separator = raw.indexOf(".");
  return separator === -1 ? { name: raw } : { name: raw.slice(0, separator), member: raw.slice(separator + 1) };
}

/** Extracts `{name}` / `{name.member}` placeholder bodies, or `undefined` for unbalanced braces. */
function extractPlaceholders(template: string): readonly string[] | undefined {
  const openCount = (template.match(/\{/gu) ?? []).length;
  const closeCount = (template.match(/\}/gu) ?? []).length;
  const matches = [...template.matchAll(/\{([^{}]*)\}/gu)];
  if (openCount !== matches.length || closeCount !== matches.length) return undefined;
  return matches.map((match) => match[1] ?? "");
}

/** Core-owned property registry: recognized property name -> intrinsic shape/multiplicity. Closed per #287. */
interface PropertyDescriptor {
  readonly shape: ValueShape;
  readonly multiplicity: Multiplicity;
}

const ISSUE_PROPERTIES: Readonly<Record<string, PropertyDescriptor>> = {
  title: { shape: "text", multiplicity: "single" },
  type: { shape: "classification", multiplicity: "single" },
  labels: { shape: "label", multiplicity: "many" },
  assignees: { shape: "actor", multiplicity: "many" },
  milestone: { shape: "milestone_reference", multiplicity: "single" },
  parent: { shape: "issue_reference", multiplicity: "single" },
  dependsOn: { shape: "issue_reference", multiplicity: "many" },
};

const BRANCH_PROPERTIES: Readonly<Record<string, PropertyDescriptor>> = {
  name: { shape: "text", multiplicity: "single" },
  source: { shape: "text", multiplicity: "single" },
  type: { shape: "classification", multiplicity: "single" },
  issue: { shape: "issue_reference", multiplicity: "single" },
  slug: { shape: "text", multiplicity: "single" },
};

const PULL_REQUEST_PROPERTIES: Readonly<Record<string, PropertyDescriptor>> = {
  title: { shape: "text", multiplicity: "single" },
  head: { shape: "text", multiplicity: "single" },
  base: { shape: "text", multiplicity: "single" },
  type: { shape: "classification", multiplicity: "single" },
  labels: { shape: "label", multiplicity: "many" },
  assignees: { shape: "actor", multiplicity: "many" },
  milestone: { shape: "milestone_reference", multiplicity: "single" },
  reviewers: { shape: "actor", multiplicity: "many" },
  draft: { shape: "boolean", multiplicity: "single" },
  maintainerCanModify: { shape: "boolean", multiplicity: "single" },
  implements: { shape: "issue_reference", multiplicity: "many" },
};

const PROPERTY_REGISTRY: Readonly<Record<ArtifactContractKind, Readonly<Record<string, PropertyDescriptor>>>> = {
  issue: ISSUE_PROPERTIES,
  branch: BRANCH_PROPERTIES,
  pull_request: PULL_REQUEST_PROPERTIES,
};

/** Only `issue` and `pull_request` accept the `fields` body-content extension point. */
const KINDS_WITH_FIELDS: ReadonlySet<ArtifactContractKind> = new Set(["issue", "pull_request"]);

function cardinalityFor(multiplicity: Multiplicity, presence: Presence): Cardinality {
  if (presence === "unused") return { min: 0, max: 0 };
  return { min: presence === "required" ? 1 : 0, max: multiplicity === "many" ? "many" : 1 };
}

function validatePresence(value: unknown, path: string, violations: ArtifactContractViolation[]): Presence | undefined {
  if (typeof value !== "string" || !PRESENCE_VALUES.includes(value as Presence)) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_VALUE",
      path,
      `Presence "${String(value)}" is not supported; expected required, optional, or unused.`,
    );
    return undefined;
  }
  return value as Presence;
}

const STRING_LIKE_SHAPES: readonly ValueShape[] = ["text", "classification", "label"];

function validatePropertyConstraints(
  value: unknown,
  path: string,
  shape: ValueShape,
  multiplicity: Multiplicity,
  violations: ArtifactContractViolation[],
): PropertyConstraints | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", path, "Constraints must be an object.");
    return undefined;
  }
  checkUnknownKeys(value, ["values", "minLength", "maxLength", "pattern", "minItems", "maxItems"], path, violations);
  const minLength = optionalNonNegativeInteger(value, "minLength", path, violations);
  const maxLength = optionalNonNegativeInteger(value, "maxLength", path, violations);
  const pattern = validateOptionalPattern(value, path, violations);
  const minItems = optionalNonNegativeInteger(value, "minItems", path, violations);
  const maxItems = optionalNonNegativeInteger(value, "maxItems", path, violations);
  const values = validateClosedValueSet(value, path, shape === "classification" || shape === "label", violations);
  if (shape !== "text" && (minLength !== undefined || maxLength !== undefined || pattern !== undefined)) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      path,
      "String constraints are only supported for the text value shape.",
    );
  }
  if (multiplicity !== "many" && (minItems !== undefined || maxItems !== undefined)) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      path,
      "Item-count constraints are only supported for many-valued properties.",
    );
  }
  if (shape !== "classification" && shape !== "label" && values !== undefined) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      `${path}.values`,
      "A closed value set is only supported for classification and label value shapes.",
    );
  }
  if (shape === "classification" && values === undefined) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.values`,
      "A classification value requires a closed values set.",
    );
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      path,
      "minLength cannot be greater than maxLength.",
    );
  }
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", path, "minItems cannot be greater than maxItems.");
  }
  return {
    ...(values === undefined ? {} : { values }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

function validateOptionalPattern(
  record: UnknownRecord,
  path: string,
  violations: ArtifactContractViolation[],
): string | undefined {
  if (!hasOwn(record, "pattern")) return undefined;
  const pattern = record.pattern;
  if (typeof pattern !== "string") {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", `${path}.pattern`, "pattern must be a string.");
    return undefined;
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      `${path}.pattern`,
      "pattern must be a valid regular expression.",
    );
  }
  return pattern;
}

function validateClosedValueSet(
  record: UnknownRecord,
  path: string,
  supported: boolean,
  violations: ArtifactContractViolation[],
): readonly string[] | undefined {
  if (!hasOwn(record, "values")) return undefined;
  const rawValues = record.values;
  if (!supported) return undefined; // reported by the caller against the correct shape-specific message
  if (
    !Array.isArray(rawValues) ||
    rawValues.length === 0 ||
    rawValues.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      `${path}.values`,
      "values must be a non-empty array of non-empty strings.",
    );
    return undefined;
  }
  if (new Set(rawValues).size !== rawValues.length) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", `${path}.values`, "values must be unique.");
    return undefined;
  }
  return rawValues as readonly string[];
}

function validateFixedScalar(
  value: unknown,
  path: string,
  shape: ValueShape,
  constraints: PropertyConstraints | FieldContentConstraints | undefined,
  violations: ArtifactContractViolation[],
): FixedScalarValue | undefined {
  if (shape === "boolean") {
    if (typeof value !== "boolean") {
      addViolation(violations, "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE", path, "Fixed value must be a boolean.");
      return undefined;
    }
    return value;
  }
  if (shape === "issue_reference") {
    const result = normalizeIssueReference(value, path);
    if (!result.valid || result.reference === undefined) {
      for (const violation of result.violations) {
        addViolation(violations, "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE", violation.path, violation.message);
      }
      return undefined;
    }
    return result.reference;
  }
  if (typeof value !== "string" || value.length === 0) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE", path, "Fixed value must be a non-empty string.");
    return undefined;
  }
  if ((shape === "classification" || shape === "label") && constraints?.values !== undefined) {
    if (!constraints.values.includes(value)) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE",
        path,
        "Fixed value must be one of the declared values.",
      );
    }
  }
  if (shape === "text" && constraints?.pattern !== undefined) {
    try {
      if (!new RegExp(constraints.pattern, "u").test(value)) {
        addViolation(
          violations,
          "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE",
          path,
          "Fixed value does not satisfy pattern.",
        );
      }
    } catch {
      // The invalid pattern itself is already reported by the constraint validator.
    }
  }
  if (shape === "text" && constraints?.minLength !== undefined && Array.from(value).length < constraints.minLength) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE", path, "Fixed value does not satisfy minLength.");
  }
  if (shape === "text" && constraints?.maxLength !== undefined && Array.from(value).length > constraints.maxLength) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE", path, "Fixed value does not satisfy maxLength.");
  }
  return value;
}

function validateFixedValue(
  value: unknown,
  path: string,
  shape: ValueShape,
  multiplicity: Multiplicity,
  constraints: PropertyConstraints | FieldContentConstraints | undefined,
  violations: ArtifactContractViolation[],
): FixedValue | undefined {
  if (multiplicity !== "many") return validateFixedScalar(value, path, shape, constraints, violations);
  if (!Array.isArray(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE", path, "Fixed value must be an array.");
    return undefined;
  }
  const items: FixedScalarValue[] = [];
  let ok = true;
  value.forEach((entry, index) => {
    const item = validateFixedScalar(entry, `${path}[${index}]`, shape, constraints, violations);
    if (item === undefined) ok = false;
    else items.push(item);
  });
  return ok ? items : undefined;
}

interface DerivationParseResult {
  readonly spec: DerivationSpec;
  readonly dependencies: readonly ParsedReference[];
}

function validateDerivation(
  value: unknown,
  path: string,
  violations: ArtifactContractViolation[],
): DerivationParseResult | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_DERIVATION", path, "Derivation must be an object.");
    return undefined;
  }
  const op = value.op;
  if (op === "copy" || op === "slug") {
    checkUnknownKeys(value, ["op", "from"], path, violations);
    const from = value.from;
    if (typeof from !== "string" || from.length === 0) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_DERIVATION",
        `${path}.from`,
        `A ${op} derivation requires a non-empty from reference.`,
      );
      return undefined;
    }
    const reference = parseReference(from);
    if (reference === undefined) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_DERIVATION",
        `${path}.from`,
        `Reference "${from}" is not a valid value/member path.`,
      );
      return undefined;
    }
    return { spec: { op, from }, dependencies: [reference] };
  }
  if (op === "format") {
    checkUnknownKeys(value, ["op", "template"], path, violations);
    const template = value.template;
    if (typeof template !== "string" || template.length === 0) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_DERIVATION",
        `${path}.template`,
        "A format derivation requires a non-empty template.",
      );
      return undefined;
    }
    const placeholders = extractPlaceholders(template);
    if (placeholders === undefined) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_DERIVATION",
        `${path}.template`,
        "Template placeholder braces are unbalanced.",
      );
      return undefined;
    }
    const dependencies: ParsedReference[] = [];
    let ok = true;
    for (const placeholder of placeholders) {
      const reference = parseReference(placeholder);
      if (reference === undefined) {
        addViolation(
          violations,
          "ARTIFACT_CONTRACT_INVALID_DERIVATION",
          `${path}.template`,
          `Placeholder "{${placeholder}}" is not a valid value/member reference.`,
        );
        ok = false;
        continue;
      }
      dependencies.push(reference);
    }
    return ok ? { spec: { op: "format", template }, dependencies } : undefined;
  }
  addViolation(
    violations,
    "ARTIFACT_CONTRACT_INVALID_DERIVATION",
    `${path}.op`,
    `Derivation operation "${String(op)}" is not supported.`,
  );
  return undefined;
}

interface AuthorityParseResult {
  readonly authority: ValueAuthority;
  readonly dependencies: readonly ParsedReference[];
}

/**
 * Shared `supplied` / `platform` / `derived` handling. `fixed` differs by
 * caller because a property's fixed-value shape is Core-owned per `shape`,
 * while a field's fixed-value shape depends on its (also Core-owned)
 * `primitive`; callers supply the appropriate fixed-value validator.
 */
function validateAuthority(
  value: unknown,
  path: string,
  validateFixed: (value: unknown, path: string) => FixedValue | undefined,
  violations: ArtifactContractViolation[],
): AuthorityParseResult | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_VALUE", path, "Authority must be an object.");
    return undefined;
  }
  const kind = value.kind;
  if (kind === "supplied" || kind === "platform") {
    checkUnknownKeys(value, ["kind"], path, violations);
    return { authority: { kind }, dependencies: [] };
  }
  if (kind === "derived") {
    checkUnknownKeys(value, ["kind", "derive"], path, violations);
    if (!hasOwn(value, "derive")) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_MISSING_PROPERTY",
        `${path}.derive`,
        'Derived authority requires "derive".',
      );
      return undefined;
    }
    const derivation = validateDerivation(value.derive, `${path}.derive`, violations);
    if (derivation === undefined) return undefined;
    return { authority: { kind: "derived", derive: derivation.spec }, dependencies: derivation.dependencies };
  }
  if (kind === "fixed") {
    checkUnknownKeys(value, ["kind", "value"], path, violations);
    if (!hasOwn(value, "value")) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_MISSING_FIXED_VALUE",
        `${path}.value`,
        'Fixed authority requires "value".',
      );
      return undefined;
    }
    const fixed = validateFixed(value.value, `${path}.value`);
    if (fixed === undefined) return undefined;
    return { authority: { kind: "fixed", value: fixed }, dependencies: [] };
  }
  addViolation(
    violations,
    "ARTIFACT_CONTRACT_UNKNOWN_AUTHORITY",
    `${path}.kind`,
    `Authority kind "${String(kind)}" is not supported.`,
  );
  return undefined;
}

interface PropertyParseResult {
  readonly declaration: PropertyValueDeclaration;
  readonly dependencies: readonly ParsedReference[];
}

function validatePropertyDeclaration(
  value: unknown,
  path: string,
  descriptor: PropertyDescriptor,
  violations: ArtifactContractViolation[],
): PropertyParseResult | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_VALUE", path, "Property declarations must be objects.");
    return undefined;
  }
  if (!hasOwn(value, "presence")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.presence`,
      'Property "presence" is required.',
    );
    return undefined;
  }
  const presence = validatePresence(value.presence, `${path}.presence`, violations);
  if (presence === undefined) return undefined;
  const cardinality = cardinalityFor(descriptor.multiplicity, presence);
  if (presence === "unused") {
    checkUnknownKeys(value, ["presence"], path, violations);
    return { declaration: { presence, shape: descriptor.shape, cardinality }, dependencies: [] };
  }
  checkUnknownKeys(value, ["presence", "authority", "constraints"], path, violations);
  const constraints = hasOwn(value, "constraints")
    ? validatePropertyConstraints(
        value.constraints,
        `${path}.constraints`,
        descriptor.shape,
        descriptor.multiplicity,
        violations,
      )
    : descriptor.shape === "classification"
      ? (addViolation(
          violations,
          "ARTIFACT_CONTRACT_MISSING_PROPERTY",
          `${path}.constraints`,
          "A classification property requires a closed values set.",
        ),
        undefined)
      : undefined;
  if (!hasOwn(value, "authority")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.authority`,
      'Property "authority" is required.',
    );
    return undefined;
  }
  const authority = validateAuthority(
    value.authority,
    `${path}.authority`,
    (fixedValue, fixedPath) =>
      validateFixedValue(fixedValue, fixedPath, descriptor.shape, descriptor.multiplicity, constraints, violations),
    violations,
  );
  if (authority === undefined) return undefined;
  return {
    declaration: {
      presence,
      shape: descriptor.shape,
      cardinality,
      authority: authority.authority,
      ...(constraints === undefined ? {} : { constraints }),
    },
    dependencies: authority.dependencies,
  };
}

const FIELD_PRIMITIVE_MULTIPLICITY: Readonly<Record<FieldPrimitive, Multiplicity>> = {
  text: "single",
  choice: "many",
  checklist: "single",
  attachment: "many",
};

function validateChecklistItems(
  value: unknown,
  path: string,
  violations: ArtifactContractViolation[],
): readonly ChecklistItemDeclaration[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", path, "items must be a non-empty array.");
    return undefined;
  }
  const items: ChecklistItemDeclaration[] = [];
  const ids = new Set<string>();
  let ok = true;
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", itemPath, "Checklist items must be objects.");
      ok = false;
      return;
    }
    checkUnknownKeys(entry, ["id", "label", "required"], itemPath, violations);
    const id = requiredString(entry, "id", itemPath, violations);
    const label = requiredString(entry, "label", itemPath, violations);
    const required = entry.required;
    if (typeof required !== "boolean") {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_VALUE",
        `${itemPath}.required`,
        "Checklist item required must be a boolean.",
      );
    }
    if (id !== undefined) {
      validateIdentifier(id, `${itemPath}.id`, violations);
      if (ids.has(id))
        addViolation(
          violations,
          "ARTIFACT_CONTRACT_INVALID_VALUE",
          `${itemPath}.id`,
          `Duplicate checklist item "${id}".`,
        );
      ids.add(id);
    }
    if (id === undefined || label === undefined || typeof required !== "boolean") {
      ok = false;
      return;
    }
    items.push({ id, label, required });
  });
  return ok ? items : undefined;
}

function validateFieldConstraints(
  value: unknown,
  path: string,
  primitive: FieldPrimitive,
  violations: ArtifactContractViolation[],
): FieldContentConstraints | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", path, "Constraints must be an object.");
    return undefined;
  }
  const allowedKeys =
    primitive === "text"
      ? ["minLength", "maxLength", "pattern"]
      : primitive === "choice"
        ? ["values", "minItems", "maxItems"]
        : primitive === "checklist"
          ? ["items"]
          : ["minItems", "maxItems"];
  checkUnknownKeys(value, allowedKeys, path, violations);
  const minLength = optionalNonNegativeInteger(value, "minLength", path, violations);
  const maxLength = optionalNonNegativeInteger(value, "maxLength", path, violations);
  const pattern = validateOptionalPattern(value, path, violations);
  const minItems = optionalNonNegativeInteger(value, "minItems", path, violations);
  const maxItems = optionalNonNegativeInteger(value, "maxItems", path, violations);
  const values = primitive === "choice" ? validateClosedValueSet(value, path, true, violations) : undefined;
  const items =
    primitive === "checklist" && hasOwn(value, "items")
      ? validateChecklistItems(value.items, `${path}.items`, violations)
      : undefined;
  if (primitive === "choice" && values === undefined) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.values`,
      "A choice field requires a closed values set.",
    );
  }
  if (primitive === "checklist" && !hasOwn(value, "items")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.items`,
      "A checklist field requires items.",
    );
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_CONSTRAINT",
      path,
      "minLength cannot be greater than maxLength.",
    );
  }
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_CONSTRAINT", path, "minItems cannot be greater than maxItems.");
  }
  return {
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(values === undefined ? {} : { values }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(items === undefined ? {} : { items }),
  };
}

interface FieldParseResult {
  readonly declaration: FieldDeclaration;
  readonly dependencies: readonly ParsedReference[];
}

function validateFieldDeclaration(
  value: unknown,
  path: string,
  fieldIds: Set<string>,
  reservedNames: ReadonlySet<string>,
  violations: ArtifactContractViolation[],
): FieldParseResult | undefined {
  if (!isRecord(value)) {
    addViolation(violations, "ARTIFACT_CONTRACT_INVALID_VALUE", path, "Field declarations must be objects.");
    return undefined;
  }
  const id = requiredString(value, "id", path, violations);
  if (id !== undefined) {
    validateIdentifier(id, `${path}.id`, violations);
    if (fieldIds.has(id))
      addViolation(violations, "ARTIFACT_CONTRACT_INVALID_VALUE", `${path}.id`, `Duplicate field id "${id}".`);
    if (reservedNames.has(id)) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_INVALID_VALUE",
        `${path}.id`,
        `Field id "${id}" collides with a Core-owned property name of this artifact kind.`,
      );
    }
    fieldIds.add(id);
  }
  const primitiveValue = requiredString(value, "primitive", path, violations);
  if (primitiveValue !== undefined && !(FIELD_PRIMITIVES as readonly string[]).includes(primitiveValue)) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_UNSUPPORTED_FIELD_PRIMITIVE",
      `${path}.primitive`,
      `Field primitive "${primitiveValue}" is not supported.`,
    );
  }
  const primitive =
    primitiveValue !== undefined && (FIELD_PRIMITIVES as readonly string[]).includes(primitiveValue)
      ? (primitiveValue as FieldPrimitive)
      : undefined;
  if (!hasOwn(value, "presence")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.presence`,
      'Property "presence" is required.',
    );
    return undefined;
  }
  const presence = validatePresence(value.presence, `${path}.presence`, violations);
  if (id === undefined || primitive === undefined || presence === undefined) return undefined;
  const cardinality = cardinalityFor(FIELD_PRIMITIVE_MULTIPLICITY[primitive], presence);
  if (presence === "unused") {
    checkUnknownKeys(value, ["id", "primitive", "presence"], path, violations);
    return { declaration: { id, primitive, presence, cardinality }, dependencies: [] };
  }
  checkUnknownKeys(value, ["id", "primitive", "presence", "authority", "constraints"], path, violations);
  const constraints = hasOwn(value, "constraints")
    ? validateFieldConstraints(value.constraints, `${path}.constraints`, primitive, violations)
    : primitive === "choice" || primitive === "checklist"
      ? (addViolation(
          violations,
          "ARTIFACT_CONTRACT_MISSING_PROPERTY",
          `${path}.constraints`,
          `A ${primitive} field requires constraints.`,
        ),
        undefined)
      : undefined;
  if (!hasOwn(value, "authority")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      `${path}.authority`,
      'Property "authority" is required.',
    );
    return undefined;
  }
  const authority = validateAuthority(
    value.authority,
    `${path}.authority`,
    (fixedValue, fixedPath) => {
      if (primitive !== "text") {
        addViolation(
          violations,
          "ARTIFACT_CONTRACT_INVALID_FIXED_VALUE",
          fixedPath,
          `Fixed authority is only supported for text fields, not "${primitive}".`,
        );
        return undefined;
      }
      return validateFixedScalar(fixedValue, fixedPath, "text", constraints, violations);
    },
    violations,
  );
  if (authority === undefined) return undefined;
  return {
    declaration: {
      id,
      primitive,
      presence,
      cardinality,
      authority: authority.authority,
      ...(constraints === undefined ? {} : { constraints }),
    },
    dependencies: authority.dependencies,
  };
}

function detectDerivationCycles(
  derived: ReadonlySet<string>,
  dependenciesByName: ReadonlyMap<string, readonly ParsedReference[]>,
  violations: ArtifactContractViolation[],
): void {
  const state = new Map<string, "visiting" | "done">();
  const reportedCycles = new Set<string>();
  const stack: string[] = [];

  const visit = (name: string): void => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      const cycleStart = stack.indexOf(name);
      const cycle = [...stack.slice(cycleStart === -1 ? 0 : cycleStart), name];
      const key = [...cycle].sort().join(",");
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        addViolation(
          violations,
          "ARTIFACT_CONTRACT_DERIVATION_CYCLE",
          `$.${name}`,
          `Derivation cycle detected: ${cycle.join(" -> ")}.`,
        );
      }
      return;
    }
    if (!derived.has(name)) {
      state.set(name, "done");
      return;
    }
    state.set(name, "visiting");
    stack.push(name);
    for (const reference of dependenciesByName.get(name) ?? []) {
      if (derived.has(reference.name) || dependenciesByName.has(reference.name)) visit(reference.name);
    }
    stack.pop();
    state.set(name, "done");
  };

  for (const name of dependenciesByName.keys()) visit(name);
}

interface CompileResult {
  readonly violations: readonly ArtifactContractViolation[];
  /** Present only when `violations` is empty. */
  readonly contract?: ArtifactContract;
}

/**
 * Validates repository-owned Artifact Contract data and, only when it is
 * fully valid, builds the normalized Core IR (Core-computed `shape` and
 * `cardinality` included). The authored JSON is deliberately a reduced
 * form — repositories select `presence`/`authority`/`constraints` only —
 * so enrichment is a real transformation, not a cast of the input.
 */
function compileArtifactContract(input: unknown): CompileResult {
  const violations: ArtifactContractViolation[] = [];
  if (!isRecord(input)) {
    return {
      violations: [
        { code: "ARTIFACT_CONTRACT_NOT_OBJECT", path: "$", message: "Artifact Contract must be a JSON object." },
      ],
    };
  }
  const version = requiredString(input, "version", "$", violations);
  if (version !== undefined && version !== ARTIFACT_CONTRACT_VERSION) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_UNSUPPORTED_VERSION",
      "$.version",
      `Only Artifact Contract version ${ARTIFACT_CONTRACT_VERSION} is supported.`,
    );
  }
  const kindValue = requiredString(input, "kind", "$", violations);
  const kind =
    kindValue !== undefined && (ARTIFACT_CONTRACT_KINDS as readonly string[]).includes(kindValue)
      ? (kindValue as ArtifactContractKind)
      : undefined;
  if (kindValue !== undefined && kind === undefined) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_UNSUPPORTED_KIND",
      "$.kind",
      `Artifact kind "${kindValue}" is not supported.`,
    );
  }
  const id = requiredString(input, "id", "$", violations);
  if (id !== undefined) validateIdentifier(id, "$.id", violations);
  checkUnknownKeys(
    input,
    kind === undefined || KINDS_WITH_FIELDS.has(kind)
      ? ["version", "kind", "id", "properties", "fields"]
      : ["version", "kind", "id", "properties"],
    "$",
    violations,
  );
  if (kind === undefined) return { violations };

  const registry = PROPERTY_REGISTRY[kind];
  if (!hasOwn(input, "properties")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_MISSING_PROPERTY",
      "$.properties",
      'Property "properties" is required.',
    );
    return { violations };
  }
  const propertiesInput = input.properties;
  if (!isRecord(propertiesInput)) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_INVALID_VALUE",
      "$.properties",
      'Property "properties" must be an object.',
    );
    return { violations };
  }

  const dependenciesByName = new Map<string, readonly ParsedReference[]>();
  const derived = new Set<string>();
  const declaredNames = new Set<string>(Object.keys(registry));
  const properties: Record<string, PropertyValueDeclaration> = {};

  for (const key of Object.keys(propertiesInput)) {
    const path = `$.properties.${key}`;
    const descriptor = registry[key];
    if (descriptor === undefined) {
      addViolation(
        violations,
        "ARTIFACT_CONTRACT_UNKNOWN_SEMANTIC_PROPERTY",
        path,
        `"${key}" is not a Core-owned semantic property of artifact kind "${kind}".`,
      );
      continue;
    }
    const result = validatePropertyDeclaration(propertiesInput[key], path, descriptor, violations);
    if (result !== undefined) {
      properties[key] = result.declaration;
      if (result.declaration.presence !== "unused") {
        dependenciesByName.set(key, result.dependencies);
        if (result.declaration.authority.kind === "derived") derived.add(key);
      }
    }
  }

  let fields: FieldDeclaration[] | undefined;
  if (KINDS_WITH_FIELDS.has(kind) && hasOwn(input, "fields")) {
    const fieldsInput = input.fields;
    if (!Array.isArray(fieldsInput)) {
      addViolation(violations, "ARTIFACT_CONTRACT_INVALID_VALUE", "$.fields", 'Property "fields" must be an array.');
    } else {
      const fieldIds = new Set<string>();
      fields = [];
      fieldsInput.forEach((entry, index) => {
        const path = `$.fields[${index}]`;
        const result = validateFieldDeclaration(entry, path, fieldIds, declaredNames, violations);
        if (result !== undefined) {
          fields?.push(result.declaration);
          if (result.declaration.presence !== "unused") {
            dependenciesByName.set(result.declaration.id, result.dependencies);
            if (result.declaration.authority.kind === "derived") derived.add(result.declaration.id);
          }
        }
      });
    }
  } else if (!KINDS_WITH_FIELDS.has(kind) && hasOwn(input, "fields")) {
    addViolation(
      violations,
      "ARTIFACT_CONTRACT_UNKNOWN_PROPERTY",
      "$.fields",
      `Artifact kind "${kind}" does not support fields.`,
    );
  }

  for (const [name, dependencies] of dependenciesByName) {
    for (const reference of dependencies) {
      if (!dependenciesByName.has(reference.name)) {
        addViolation(
          violations,
          "ARTIFACT_CONTRACT_UNDECLARED_DEPENDENCY",
          `$.${name}`,
          `Derivation references undeclared or unused value "${reference.name}".`,
        );
        continue;
      }
      if (reference.member !== undefined) {
        const shape = registry[reference.name]?.shape;
        const members = shape === undefined ? [] : (VALUE_SHAPE_MEMBERS[shape] ?? []);
        if (!members.includes(reference.member)) {
          addViolation(
            violations,
            "ARTIFACT_CONTRACT_INVALID_DERIVATION",
            `$.${name}`,
            `"${reference.name}.${reference.member}" is not a declared scalar member of the referenced value's shape.`,
          );
        }
      }
    }
  }

  detectDerivationCycles(derived, dependenciesByName, violations);

  if (violations.length > 0 || id === undefined) return { violations };
  return {
    violations,
    contract: { version: ARTIFACT_CONTRACT_VERSION, kind, id, properties, ...(fields === undefined ? {} : { fields }) },
  };
}

export function validateArtifactContract(input: unknown): ArtifactContractValidationResult {
  const { violations } = compileArtifactContract(input);
  return { valid: violations.length === 0, violations };
}

export function isArtifactContract(input: unknown): boolean {
  return compileArtifactContract(input).contract !== undefined;
}

/** Validates and builds repository-owned Artifact Contract data into normalized Core IR. */
export function parseArtifactContract(input: unknown): ArtifactContract {
  const { violations, contract } = compileArtifactContract(input);
  if (contract === undefined) throw new ArtifactContractValidationError(violations);
  return contract;
}

function canonicalizeAuthority(authority: ValueAuthority): UnknownRecord {
  if (authority.kind === "supplied" || authority.kind === "platform") return { kind: authority.kind };
  if (authority.kind === "derived") return { kind: "derived", derive: { ...authority.derive } };
  return { kind: "fixed", value: authority.value };
}

function canonicalizeProperty(declaration: PropertyValueDeclaration): UnknownRecord {
  if (declaration.presence === "unused") return { presence: "unused" };
  return {
    presence: declaration.presence,
    authority: canonicalizeAuthority(declaration.authority),
    ...(declaration.constraints === undefined ? {} : { constraints: { ...declaration.constraints } }),
  };
}

function canonicalizeField(declaration: FieldDeclaration): UnknownRecord {
  if (declaration.presence === "unused")
    return { id: declaration.id, primitive: declaration.primitive, presence: "unused" };
  return {
    id: declaration.id,
    primitive: declaration.primitive,
    presence: declaration.presence,
    authority: canonicalizeAuthority(declaration.authority),
    ...(declaration.constraints === undefined ? {} : { constraints: { ...declaration.constraints } }),
  };
}

function canonicalizeContract(contract: ArtifactContract): UnknownRecord {
  const properties: UnknownRecord = {};
  for (const key of Object.keys(contract.properties)) {
    const declaration = contract.properties[key];
    if (declaration !== undefined) properties[key] = canonicalizeProperty(declaration);
  }
  return {
    version: contract.version,
    kind: contract.kind,
    id: contract.id,
    properties,
    ...(contract.fields === undefined ? {} : { fields: contract.fields.map(canonicalizeField) }),
  };
}

/**
 * Projects an already-normalized Core IR object back to the minimal
 * canonical authoring JSON (`presence`/`authority`/`constraints` only —
 * Core-computed `shape`/`cardinality` are not re-serialized). Callers with
 * raw, unvalidated repository data should call `parseArtifactContract`
 * first; this function trusts its typed input rather than re-validating it.
 */
export function serializeArtifactContract(contract: ArtifactContract): string {
  return JSON.stringify(canonicalizeContract(contract));
}

export function deserializeArtifactContract(serialized: string): ArtifactContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";
    throw new ArtifactContractValidationError([{ code: "ARTIFACT_CONTRACT_INVALID_JSON", path: "$", message }]);
  }
  return parseArtifactContract(parsed);
}
