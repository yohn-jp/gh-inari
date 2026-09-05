import type { CanonicalContract } from "./ir.js";
import type { JsonSchema } from "./schema.js";

/** Canonical pull-request/Issue title policy retained as artifact metadata. */
export interface TitleGovernance {
  /** GitHub artifact creation always requires a caller-provided title. */
  readonly required: boolean;
  /** A fixed native prefix; the prefix alone is not meaningful title content. */
  readonly prefix?: string;
  /** A fixed native template/scaffold; the scaffold alone is not meaningful title content. */
  readonly template?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** Source-level title metadata. `required` defaults to true. */
export type TitleGovernanceInput = Omit<TitleGovernance, "required"> & { readonly required?: boolean };

export type TitleGovernanceViolationCode =
  | "TITLE_REQUIRED"
  | "TITLE_TYPE"
  | "TITLE_PREFIX_ONLY"
  | "TITLE_TEMPLATE_ONLY"
  | "TITLE_MIN_LENGTH"
  | "TITLE_MAX_LENGTH"
  | "TITLE_PATTERN";

export interface TitleGovernanceViolation {
  readonly code: TitleGovernanceViolationCode;
  readonly path: "$.title";
  readonly message: string;
}

export interface TitleGovernanceValidationResult {
  readonly valid: boolean;
  readonly violations: readonly TitleGovernanceViolation[];
}

/** Resolve the effective title policy, including legacy native title prefixes. */
export function effectiveTitleGovernance(contract: CanonicalContract): TitleGovernance {
  return contract.titleGovernance ?? defaultTitleGovernance(contract.nativeMetadata.title);
}

/** Build the default policy preserved by contracts compiled before title governance was explicit. */
export function defaultTitleGovernance(nativeTitle?: string): TitleGovernance {
  return {
    required: true,
    ...(nativeTitle === undefined || nativeTitle.trim().length === 0 ? {} : { prefix: nativeTitle }),
  };
}

/** Complete source-level title metadata into the compiled policy representation. */
export function completeTitleGovernance(
  input: TitleGovernanceInput | undefined,
  nativeTitle?: string,
): TitleGovernance {
  if (input === undefined) return defaultTitleGovernance(nativeTitle);
  return {
    required: input.required ?? true,
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
    ...(input.minLength === undefined ? {} : { minLength: input.minLength }),
    ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
  };
}

/** Validate one artifact title against the compiled policy. */
export function validateTitleGovernance(
  policy: TitleGovernance,
  value: unknown,
): TitleGovernanceValidationResult {
  const violations: TitleGovernanceViolation[] = [];
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
    if (policy.required) {
      violations.push({
        code: "TITLE_REQUIRED",
        path: "$.title",
        message: "title must be a non-empty string.",
      });
    }
    return { valid: violations.length === 0, violations };
  }
  if (typeof value !== "string") {
    violations.push({
      code: "TITLE_TYPE",
      path: "$.title",
      message: "title must be a string.",
    });
    return { valid: false, violations };
  }

  const normalized = value.trim();
  for (const fixed of [
    ["TITLE_PREFIX_ONLY", policy.prefix, "title must contain content beyond the fixed native template prefix."],
    ["TITLE_TEMPLATE_ONLY", policy.template, "title must contain content beyond the fixed native title template."],
  ] as const) {
    const [code, marker, message] = fixed;
    if (marker !== undefined && normalized === marker.trim()) {
      violations.push({ code, path: "$.title", message });
    }
  }
  const length = Array.from(value).length;
  if (policy.minLength !== undefined && length < policy.minLength) {
    violations.push({
      code: "TITLE_MIN_LENGTH",
      path: "$.title",
      message: `title must contain at least ${policy.minLength} characters.`,
    });
  }
  if (policy.maxLength !== undefined && length > policy.maxLength) {
    violations.push({
      code: "TITLE_MAX_LENGTH",
      path: "$.title",
      message: `title must contain at most ${policy.maxLength} characters.`,
    });
  }
  if (policy.pattern !== undefined) {
    let matches = false;
    try {
      matches = new RegExp(policy.pattern, "u").test(value);
    } catch {
      // Canonical IR validation rejects invalid patterns before this boundary.
    }
    if (!matches) {
      violations.push({
        code: "TITLE_PATTERN",
        path: "$.title",
        message: "title does not satisfy the compiled title pattern.",
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

/** Project title constraints as a JSON Schema property while keeping title outside semantic fields. */
export function projectTitleSchema(policy: TitleGovernance): JsonSchema {
  const patterns: { readonly pattern: string }[] = [];
  if (policy.pattern !== undefined) patterns.push({ pattern: policy.pattern });
  if (policy.prefix !== undefined) patterns.push({ pattern: fixedOnlyExclusionPattern(policy.prefix) });
  if (policy.template !== undefined) patterns.push({ pattern: fixedOnlyExclusionPattern(policy.template) });
  const requiredPattern = policy.required ? { pattern: "\\S" } : undefined;
  const allPatterns = [...patterns, ...(requiredPattern === undefined ? [] : [requiredPattern])];
  return {
    title: "Title",
    type: "string",
    ...(policy.minLength === undefined ? {} : { minLength: policy.minLength }),
    ...(policy.maxLength === undefined ? {} : { maxLength: policy.maxLength }),
    ...(allPatterns.length === 0
      ? {}
      : allPatterns.length === 1
        ? { pattern: allPatterns[0]?.pattern }
        : { pattern: allPatterns[0]?.pattern, allOf: allPatterns.slice(1) }),
  };
}

/** Produce a deterministic valid-looking title for schema examples. */
export function minimalTitle(policy: TitleGovernance): string {
  const fixed = policy.prefix ?? policy.template ?? "";
  const candidate = `${fixed}example`;
  if (validateTitleGovernance(policy, candidate).valid) return candidate;
  if (policy.pattern === undefined && policy.minLength === undefined) return "Example pull request";
  const minimum = Math.max(policy.minLength ?? 1, policy.required ? 1 : 0);
  const fallback = "x".repeat(Math.min(minimum, policy.maxLength ?? minimum));
  return fallback;
}

function fixedOnlyExclusionPattern(value: string): string {
  const fixed = value.trim();
  return `^(?!${escapeRegExp(fixed)}[\\t ]*$)[\\s\\S]*$`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\$&");
}
