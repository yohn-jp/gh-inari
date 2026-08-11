import { assertCanonicalContract, LINKED_ISSUE_PATTERN, type CanonicalContract, type CanonicalField } from "./ir.js";
import { effectiveFieldConstraints, REQUIRED_STRING_PATTERN, type EffectiveFieldConstraints } from "./constraints.js";

/** Stable machine-readable semantic input diagnostics. */
export type SemanticViolationCode =
  | "INPUT_NOT_OBJECT"
  | "INPUT_UNKNOWN_FIELD"
  | "INPUT_REQUIRED"
  | "INPUT_TYPE"
  | "INPUT_ENUM"
  | "INPUT_OPTION"
  | "INPUT_DUPLICATE"
  | "INPUT_MIN_LENGTH"
  | "INPUT_MAX_LENGTH"
  | "INPUT_PATTERN"
  | "INPUT_MIN_ITEMS"
  | "INPUT_MAX_ITEMS"
  | "INPUT_CHECKLIST_REQUIRED"
  | "INPUT_CHECKLIST_INCOMPLETE";

export interface SemanticViolation {
  readonly code: SemanticViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface SemanticValidationResult {
  readonly valid: boolean;
  readonly violations: readonly SemanticViolation[];
  /** Defaults are materialized here only after all input values are validated. */
  readonly values: Readonly<Record<string, unknown>>;
}

export class SemanticValidationError extends Error {
  readonly violations: readonly SemanticViolation[];

  constructor(violations: readonly SemanticViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "SemanticValidationError";
    this.violations = violations;
  }
}

interface RecordValue {
  readonly [key: string]: unknown;
}

/**
 * Validate the semantic field map for a compiled contract. This is the one
 * validator used by preview, mutation preparation, and existing-artifact
 * reconstruction.
 */
export function validateSemanticInput(contractInput: unknown, input: unknown): SemanticValidationResult {
  assertCanonicalContract(contractInput);
  const contract = contractInput;
  const violations: SemanticViolation[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      violations: [{ code: "INPUT_NOT_OBJECT", path: "$", message: "Semantic input must be a JSON object." }],
      values: {},
    };
  }

  const fields = flattenFields(contract);
  const knownIds = new Set(fields.map((field) => field.id));
  for (const key of Object.keys(input).sort(compareStrings)) {
    if (!knownIds.has(key)) {
      violations.push({
        code: "INPUT_UNKNOWN_FIELD",
        path: fieldPath(key),
        message: `Field "${key}" is not declared by the compiled contract.`,
      });
    }
  }

  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const path = fieldPath(field.id);
    const constraints = effectiveFieldConstraints(contract, field);
    const present = Object.prototype.hasOwnProperty.call(input, field.id);
    const rawValue = present ? input[field.id] : constraints.defaultValue;
    if (!present && rawValue === undefined) {
      if (constraints.required) {
        violations.push({
          code: "INPUT_REQUIRED",
          path,
          message: `Required field "${field.label}" is missing.`,
        });
      }
      continue;
    }
    const fieldViolations = validateField(field, rawValue, path, constraints);
    violations.push(...fieldViolations);
    if (fieldViolations.length === 0) values[field.id] = rawValue;
  }

  return { valid: violations.length === 0, violations, values };
}

export function assertSemanticInput(contractInput: unknown, input: unknown): Readonly<Record<string, unknown>> {
  const result = validateSemanticInput(contractInput, input);
  if (!result.valid) throw new SemanticValidationError(result.violations);
  return result.values;
}

function flattenFields(contract: CanonicalContract): readonly CanonicalField[] {
  return contract.sections.flatMap((section) => [...section.fields]);
}

function validateField(
  field: CanonicalField,
  value: unknown,
  path: string,
  constraints: EffectiveFieldConstraints,
): readonly SemanticViolation[] {
  const violations: SemanticViolation[] = [];
  if (value === null || value === undefined) {
    violations.push({ code: "INPUT_TYPE", path, message: `Field "${field.label}" cannot be null or undefined.` });
    return violations;
  }

  if (field.type === "string" || field.type === "enum") {
    if (typeof value !== "string") {
      violations.push({ code: "INPUT_TYPE", path, message: `Field "${field.label}" must be a string.` });
      return violations;
    }
    if (constraints.required && !safeRegExpTest(REQUIRED_STRING_PATTERN, value)) {
      violations.push({ code: "INPUT_REQUIRED", path, message: `Required field "${field.label}" cannot be empty.` });
    }
    if (field.type === "enum" && !constraints.allowedValues?.includes(value)) {
      violations.push({
        code: "INPUT_ENUM",
        path,
        message: `Field "${field.label}" must be one of: ${constraints.allowedValues?.join(", ") ?? ""}.`,
      });
    }
    const length = Array.from(value).length;
    if (constraints.minLength !== undefined && length < constraints.minLength) {
      violations.push({
        code: "INPUT_MIN_LENGTH",
        path,
        message: `Field "${field.label}" must contain at least ${constraints.minLength} characters.`,
      });
    }
    if (constraints.maxLength !== undefined && length > constraints.maxLength) {
      violations.push({
        code: "INPUT_MAX_LENGTH",
        path,
        message: `Field "${field.label}" must contain at most ${constraints.maxLength} characters.`,
      });
    }
    if (constraints.pattern !== undefined && !safeRegExpTest(constraints.pattern, value)) {
      violations.push({
        code: "INPUT_PATTERN",
        path,
        message: `Field "${field.label}" does not match the configured pattern.`,
      });
    }
    if (constraints.linkedIssue && !safeRegExpTest(LINKED_ISSUE_PATTERN, value)) {
      violations.push({
        code: "INPUT_PATTERN",
        path,
        message: `Field "${field.label}" must contain a closing, fixing, or resolving Issue reference.`,
      });
    }
    return violations;
  }

  if (!Array.isArray(value)) {
    violations.push({ code: "INPUT_TYPE", path, message: `Field "${field.label}" must be an array of strings.` });
    return violations;
  }
  const values = value as readonly unknown[];
  if (values.some((entry) => typeof entry !== "string")) {
    violations.push({ code: "INPUT_TYPE", path, message: `Field "${field.label}" must contain only strings.` });
    return violations;
  }
  const strings = values as readonly string[];
  if (constraints.uniqueItems && new Set(strings).size !== strings.length) {
    violations.push({ code: "INPUT_DUPLICATE", path, message: `Field "${field.label}" must not contain duplicates.` });
  }

  const allowed = constraints.allowedValues;
  if (allowed !== undefined) {
    strings.forEach((entry, index) => {
      if (!allowed.includes(entry)) {
        violations.push({
          code: "INPUT_OPTION",
          path: `${path}[${index}]`,
          message: `Value "${entry}" is not declared for field "${field.label}".`,
        });
      }
    });
  }
  if (constraints.required) {
    if (strings.length === 0) {
      violations.push({ code: "INPUT_REQUIRED", path, message: `Required field "${field.label}" cannot be empty.` });
    }
  }

  if (constraints.minItems !== undefined && strings.length < constraints.minItems) {
    violations.push({
      code: "INPUT_MIN_ITEMS",
      path,
      message: `Field "${field.label}" must contain at least ${constraints.minItems} selected item(s).`,
    });
  }
  if (constraints.maxItems !== undefined && strings.length > constraints.maxItems) {
    violations.push({
      code: "INPUT_MAX_ITEMS",
      path,
      message: `Field "${field.label}" must contain at most ${constraints.maxItems} selected item(s).`,
    });
  }
  if (field.type === "checklist") {
    for (const itemId of constraints.requiredItems) {
      const item = field.items.find((candidate) => candidate.id === itemId);
      if (item !== undefined && !strings.includes(item.id)) {
        violations.push({
          code: "INPUT_CHECKLIST_REQUIRED",
          path,
          message: `Required checklist item "${item.label}" is not selected.`,
        });
      }
    }
    if (constraints.checklistRequireComplete && strings.length !== field.items.length) {
      violations.push({
        code: "INPUT_CHECKLIST_INCOMPLETE",
        path,
        message: `Checklist field "${field.label}" must be fully completed.`,
      });
    }
  }
  return violations;
}

function fieldPath(id: string): string {
  return `$.${id}`;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRegExpTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return false;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
