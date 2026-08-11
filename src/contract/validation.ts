import {
  assertCanonicalContract,
  LINKED_ISSUE_PATTERN,
  type CanonicalContract,
  type CanonicalField,
  type SupplementalFieldConstraint,
} from "./ir.js";

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
    const present = Object.prototype.hasOwnProperty.call(input, field.id);
    const rawValue = present ? input[field.id] : fieldDefault(field);
    if (!present && rawValue === undefined) {
      if (field.required === "required" || supplementalForField(contract, field.id)?.required === true) {
        violations.push({
          code: "INPUT_REQUIRED",
          path,
          message: `Required field "${field.label}" is missing.`,
        });
      }
      continue;
    }
    const fieldViolations = validateField(field, rawValue, path, supplementalForField(contract, field.id));
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

function fieldDefault(field: CanonicalField): unknown {
  return "defaultValue" in field ? field.defaultValue : undefined;
}

function validateField(
  field: CanonicalField,
  value: unknown,
  path: string,
  supplemental: SupplementalFieldConstraint | undefined,
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
    const required = field.required === "required" || supplemental?.required === true;
    if (required && value.trim().length === 0) {
      violations.push({ code: "INPUT_REQUIRED", path, message: `Required field "${field.label}" cannot be empty.` });
    }
    if (field.type === "enum" && !field.options.some((option) => option.value === value)) {
      violations.push({
        code: "INPUT_ENUM",
        path,
        message: `Field "${field.label}" must be one of: ${field.options.map((option) => option.value).join(", ")}.`,
      });
    }
    const minLength = field.constraints?.minLength ?? supplemental?.minLength;
    const maxLength = field.constraints?.maxLength ?? supplemental?.maxLength;
    const pattern = field.constraints?.pattern ?? supplemental?.pattern;
    if (minLength !== undefined && value.length < minLength) {
      violations.push({
        code: "INPUT_MIN_LENGTH",
        path,
        message: `Field "${field.label}" must contain at least ${minLength} characters.`,
      });
    }
    if (maxLength !== undefined && value.length > maxLength) {
      violations.push({
        code: "INPUT_MAX_LENGTH",
        path,
        message: `Field "${field.label}" must contain at most ${maxLength} characters.`,
      });
    }
    if (pattern !== undefined && !safeRegExpTest(pattern, value)) {
      violations.push({
        code: "INPUT_PATTERN",
        path,
        message: `Field "${field.label}" does not match the configured pattern.`,
      });
    }
    if (supplemental?.linkedIssue === true && !safeRegExpTest(LINKED_ISSUE_PATTERN, value)) {
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
  if (new Set(strings).size !== strings.length) {
    violations.push({ code: "INPUT_DUPLICATE", path, message: `Field "${field.label}" must not contain duplicates.` });
  }

  const allowed =
    field.type === "array" ? field.items.options?.map((option) => option.value) : field.items.map((item) => item.id);
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
  if (field.required === "required" || supplemental?.required === true) {
    if (strings.length === 0) {
      violations.push({ code: "INPUT_REQUIRED", path, message: `Required field "${field.label}" cannot be empty.` });
    }
  }

  const minItems = Math.max(
    field.constraints?.minItems ?? 0,
    supplemental?.minItems ?? 0,
    supplemental?.checklistMinCompleted ?? 0,
  );
  const maxItems = field.constraints?.maxItems ?? supplemental?.maxItems;
  if (strings.length < minItems) {
    violations.push({
      code: "INPUT_MIN_ITEMS",
      path,
      message: `Field "${field.label}" must contain at least ${minItems} selected item(s).`,
    });
  }
  if (maxItems !== undefined && strings.length > maxItems) {
    violations.push({
      code: "INPUT_MAX_ITEMS",
      path,
      message: `Field "${field.label}" must contain at most ${maxItems} selected item(s).`,
    });
  }
  if (field.type === "checklist") {
    for (const item of field.items) {
      if (item.required && !strings.includes(item.id)) {
        violations.push({
          code: "INPUT_CHECKLIST_REQUIRED",
          path,
          message: `Required checklist item "${item.label}" is not selected.`,
        });
      }
    }
    if (supplemental?.checklistRequireComplete === true && strings.length !== field.items.length) {
      violations.push({
        code: "INPUT_CHECKLIST_INCOMPLETE",
        path,
        message: `Checklist field "${field.label}" must be fully completed.`,
      });
    }
  }
  return violations;
}

function supplementalForField(contract: CanonicalContract, fieldId: string): SupplementalFieldConstraint | undefined {
  return contract.supplementalConstraints.fields.find((constraint) => constraint.fieldId === fieldId);
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
