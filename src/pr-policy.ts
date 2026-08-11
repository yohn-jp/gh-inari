import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  assertCanonicalContract,
  type CanonicalContract,
  type CanonicalField,
  type SupplementalFieldConstraint,
} from "./contract/ir.js";
import type { TemplateIdentity } from "./template-discovery.js";

export const PULL_REQUEST_POLICY_VERSION = 1 as const;

export type PullRequestPolicyErrorCode =
  | "PR_POLICY_INVALID_YAML"
  | "PR_POLICY_INVALID_ROOT"
  | "PR_POLICY_UNSUPPORTED_VERSION"
  | "PR_POLICY_UNKNOWN_PROPERTY"
  | "PR_POLICY_INVALID_VALUE"
  | "PR_POLICY_TEMPLATE_MISMATCH"
  | "PR_POLICY_UNKNOWN_REFERENCE"
  | "PR_POLICY_AMBIGUOUS_REFERENCE"
  | "PR_POLICY_UNSUPPORTED_CONSTRAINT"
  | "PR_POLICY_CONFLICT";

export class PullRequestPolicyError extends Error {
  readonly code: PullRequestPolicyErrorCode;
  readonly path: string;

  constructor(code: PullRequestPolicyErrorCode, message: string, path = "$") {
    super(message);
    this.name = "PullRequestPolicyError";
    this.code = code;
    this.path = path;
  }

  toJSON(): { code: PullRequestPolicyErrorCode; path: string; message: string } {
    return { code: this.code, path: this.path, message: this.message };
  }
}

export interface PullRequestPolicyOverlay {
  readonly version: typeof PULL_REQUEST_POLICY_VERSION;
  readonly template?: string | PullRequestPolicyTemplateSelector;
  readonly sections?: readonly PullRequestPolicySectionRule[];
  readonly templates?: readonly PullRequestPolicyTemplateEntry[];
}

export interface PullRequestPolicyTemplateSelector {
  readonly id?: string;
  readonly path?: string;
  readonly name?: string;
}

export interface PullRequestPolicyTemplateEntry {
  readonly template?: string | PullRequestPolicyTemplateSelector;
  readonly sections: readonly PullRequestPolicySectionRule[];
}

export interface PullRequestPolicyCompileOptions {
  /** All native PR templates available in the authoritative repository. */
  readonly templateIdentities?: readonly Pick<TemplateIdentity, "id" | "path" | "name">[];
}

export interface PullRequestPolicySectionRule {
  readonly fieldId: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly linkedIssue?: boolean;
  readonly checklistMinCompleted?: number;
  readonly checklistRequireComplete?: boolean;
}

/** Compile a small, data-only PR overlay into the shared canonical contract. */
export function compilePullRequestPolicyOverlay(
  contractInput: unknown,
  source: string | PullRequestPolicyOverlay,
  options: PullRequestPolicyCompileOptions = {},
): CanonicalContract {
  assertCanonicalContract(contractInput);
  const contract = contractInput;
  if (contract.artifactKind !== "pull_request") {
    throw new PullRequestPolicyError(
      "PR_POLICY_INVALID_VALUE",
      "PR policy overlays apply only to pull request contracts.",
    );
  }
  const overlay = typeof source === "string" ? parsePullRequestPolicyOverlay(source) : source;
  assertOverlayVersion(overlay);
  const selected = selectPolicyEntry(overlay, contract, options);

  const mergedFields = [...contract.supplementalConstraints.fields];
  selected.sections.forEach((rule, ruleIndex) => {
    const field = resolveField(contract, rule.fieldId);
    const rulePath = `${selected.sectionsPath}[${ruleIndex}]`;
    const constraint = ruleToConstraint(rule, field, rulePath);
    const existingIndex = mergedFields.findIndex((entry) => entry.fieldId === field.id);
    if (existingIndex < 0) mergedFields.push(constraint);
    else
      mergedFields[existingIndex] = mergeConstraints(
        mergedFields[existingIndex] as SupplementalFieldConstraint,
        constraint,
        rulePath,
      );
  });

  const merged: CanonicalContract = {
    ...contract,
    supplementalConstraints: {
      fields: mergedFields,
    },
  };
  try {
    assertCanonicalContract(merged);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Compiled PR policy is not a valid canonical contract.";
    throw new PullRequestPolicyError("PR_POLICY_CONFLICT", message, selected.sectionsPath);
  }
  return merged;
}

function mergeConstraints(
  previous: SupplementalFieldConstraint,
  next: SupplementalFieldConstraint,
  path: string,
): SupplementalFieldConstraint {
  const keys: readonly (keyof SupplementalFieldConstraint)[] = [
    "required",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "linkedIssue",
    "checklistMinCompleted",
    "checklistRequireComplete",
  ];
  for (const key of keys) {
    if (previous[key] !== undefined && next[key] !== undefined && previous[key] !== next[key]) {
      throw new PullRequestPolicyError(
        "PR_POLICY_CONFLICT",
        `Overlay constraint for field "${previous.fieldId}" conflicts with an existing supplemental constraint.`,
        `${path}.${String(key)}`,
      );
    }
  }
  return { ...previous, ...next };
}

export function parsePullRequestPolicyOverlay(source: string): PullRequestPolicyOverlay {
  let value: unknown;
  try {
    value = parseYaml(source);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid YAML.";
    throw new PullRequestPolicyError("PR_POLICY_INVALID_YAML", message);
  }
  if (!isRecord(value)) throw new PullRequestPolicyError("PR_POLICY_INVALID_ROOT", "PR policy must be a mapping.");
  assertKeys(value, ["version", "template", "templates", "sections", "fields"], "$");

  if (value.template !== undefined && value.templates !== undefined) {
    throw new PullRequestPolicyError(
      "PR_POLICY_CONFLICT",
      "Cannot specify both 'template' and 'templates'.",
      "$.template",
    );
  }
  if (value.templates !== undefined && (value.sections !== undefined || value.fields !== undefined)) {
    throw new PullRequestPolicyError(
      "PR_POLICY_CONFLICT",
      "Cannot specify root sections together with template entries.",
      "$.templates",
    );
  }
  if (value.sections !== undefined && value.fields !== undefined) {
    throw new PullRequestPolicyError(
      "PR_POLICY_CONFLICT",
      "Cannot specify both 'sections' and 'fields'.",
      "$.sections",
    );
  }

  const version = value.version;
  if (version !== PULL_REQUEST_POLICY_VERSION) {
    throw new PullRequestPolicyError(
      "PR_POLICY_UNSUPPORTED_VERSION",
      `Only PR policy version ${PULL_REQUEST_POLICY_VERSION} is supported.`,
      "$.version",
    );
  }

  if (value.templates !== undefined) {
    if (!Array.isArray(value.templates) || value.templates.length === 0) {
      throw new PullRequestPolicyError(
        "PR_POLICY_INVALID_VALUE",
        "templates must be a non-empty array.",
        "$.templates",
      );
    }
    const templates = value.templates.map((entry, index) => parseTemplateEntry(entry, `$.templates[${index}]`));
    if (templates.length > 1 && templates.some((entry) => entry.template === undefined)) {
      const index = templates.findIndex((entry) => entry.template === undefined);
      throw new PullRequestPolicyError(
        "PR_POLICY_INVALID_VALUE",
        "Every entry in a multi-template PR policy must identify a native template.",
        `$.templates[${index}].template`,
      );
    }
    return { version: PULL_REQUEST_POLICY_VERSION, templates };
  }

  return {
    version: PULL_REQUEST_POLICY_VERSION,
    ...(value.template === undefined ? {} : { template: parseSelector(value.template, "$.template") }),
    sections: parseRules(value.sections ?? value.fields, "$.sections"),
  };
}

function parseTemplateEntry(value: unknown, path: string): PullRequestPolicyTemplateEntry {
  if (!isRecord(value)) {
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "Template entries must be objects.", path);
  }
  assertKeys(value, ["template", "sections", "fields"], path);
  if (value.sections !== undefined && value.fields !== undefined) {
    throw new PullRequestPolicyError(
      "PR_POLICY_CONFLICT",
      "Cannot specify both 'sections' and 'fields'.",
      `${path}.sections`,
    );
  }
  return {
    ...(value.template === undefined ? {} : { template: parseSelector(value.template, `${path}.template`) }),
    sections: parseRules(value.sections ?? value.fields, `${path}.sections`),
  };
}

export async function compilePullRequestPolicyFile(
  contract: unknown,
  filePath: string,
  options: PullRequestPolicyCompileOptions = {},
): Promise<CanonicalContract> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (cause: unknown) {
    const error = new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `Cannot read PR policy file "${filePath}".`);
    if (cause instanceof Error) error.cause = cause;
    throw error;
  }
  return compilePullRequestPolicyOverlay(contract, source, options);
}

function parseRules(value: unknown, path: string): readonly PullRequestPolicySectionRule[] {
  if (!Array.isArray(value))
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "sections must be an array.", path);
  return value.map((entry, index) => parseRule(entry, `${path}[${index}]`));
}

function parseRule(value: unknown, path: string): PullRequestPolicySectionRule {
  if (!isRecord(value))
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "Section rules must be objects.", path);
  assertKeys(
    value,
    [
      "id",
      "fieldId",
      "section",
      "sectionId",
      "required",
      "minLength",
      "maxLength",
      "pattern",
      "minItems",
      "maxItems",
      "linkedIssue",
      "checklistMinCompleted",
      "checklistRequireComplete",
      "checklist",
    ],
    path,
  );
  const references = ["id", "fieldId", "section", "sectionId"].filter((key) => value[key] !== undefined);
  if (references.length !== 1 || typeof value[references[0] as string] !== "string") {
    throw new PullRequestPolicyError(
      "PR_POLICY_INVALID_VALUE",
      "Each rule must contain exactly one string field identity using id, fieldId, section, or sectionId.",
      path,
    );
  }
  const fieldId = value[references[0] as string] as string;
  const required = optionalBoolean(value, "required", path);
  const minLength = optionalInteger(value, "minLength", path);
  const maxLength = optionalInteger(value, "maxLength", path);
  const directPattern = optionalString(value, "pattern", path);
  const minItems = optionalInteger(value, "minItems", path);
  const maxItems = optionalInteger(value, "maxItems", path);
  const linkedIssue = optionalBoolean(value, "linkedIssue", path);
  let checklistMinCompleted = optionalInteger(value, "checklistMinCompleted", path);
  let checklistRequireComplete = optionalBoolean(value, "checklistRequireComplete", path);
  if (value.checklist !== undefined) {
    if (!isRecord(value.checklist))
      throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "checklist must be an object.", `${path}.checklist`);
    assertKeys(value.checklist, ["minCompleted", "requireComplete"], `${path}.checklist`);
    if (checklistMinCompleted !== undefined || checklistRequireComplete !== undefined) {
      throw new PullRequestPolicyError(
        "PR_POLICY_CONFLICT",
        "Use either checklist shorthand or checklist object, not both.",
        path,
      );
    }
    checklistMinCompleted = optionalInteger(value.checklist, "minCompleted", `${path}.checklist`);
    checklistRequireComplete = optionalBoolean(value.checklist, "requireComplete", `${path}.checklist`);
  }
  if (linkedIssue === true && directPattern !== undefined) {
    throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "linkedIssue cannot be combined with pattern.", path);
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "minLength cannot exceed maxLength.", path);
  }
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "minItems cannot exceed maxItems.", path);
  }
  return {
    fieldId,
    ...(required === undefined ? {} : { required }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(directPattern === undefined ? {} : { pattern: directPattern }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(linkedIssue === undefined ? {} : { linkedIssue }),
    ...(checklistMinCompleted === undefined ? {} : { checklistMinCompleted }),
    ...(checklistRequireComplete === undefined ? {} : { checklistRequireComplete }),
  };
}

function ruleToConstraint(
  rule: PullRequestPolicySectionRule,
  field: CanonicalField,
  path: string,
): SupplementalFieldConstraint {
  if (rule.linkedIssue === true && field.type !== "string" && field.type !== "enum") {
    throw new PullRequestPolicyError(
      "PR_POLICY_UNSUPPORTED_CONSTRAINT",
      "linkedIssue requires a string-like section.",
      path,
    );
  }
  if (
    (rule.checklistMinCompleted !== undefined || rule.checklistRequireComplete !== undefined) &&
    field.type !== "checklist"
  ) {
    throw new PullRequestPolicyError(
      "PR_POLICY_UNSUPPORTED_CONSTRAINT",
      "Checklist constraints require a checklist section.",
      path,
    );
  }
  if (rule.pattern !== undefined) {
    try {
      new RegExp(rule.pattern, "u");
    } catch {
      throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "pattern must be a valid regular expression.", path);
    }
  }
  if (rule.linkedIssue === true && rule.required === false) {
    throw new PullRequestPolicyError("PR_POLICY_CONFLICT", "linkedIssue cannot be combined with required=false.", path);
  }
  return {
    fieldId: field.id,
    ...(rule.required === undefined && rule.linkedIssue !== true ? {} : { required: rule.required ?? true }),
    ...(rule.minLength === undefined ? {} : { minLength: rule.minLength }),
    ...(rule.maxLength === undefined ? {} : { maxLength: rule.maxLength }),
    ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }),
    ...(rule.minItems === undefined ? {} : { minItems: rule.minItems }),
    ...(rule.maxItems === undefined ? {} : { maxItems: rule.maxItems }),
    ...(rule.linkedIssue === undefined ? {} : { linkedIssue: rule.linkedIssue }),
    ...(rule.checklistMinCompleted === undefined ? {} : { checklistMinCompleted: rule.checklistMinCompleted }),
    ...(rule.checklistRequireComplete === undefined ? {} : { checklistRequireComplete: rule.checklistRequireComplete }),
  };
}

function resolveField(contract: CanonicalContract, reference: string): CanonicalField {
  const matches = contract.sections
    .flatMap((section) => [...section.fields])
    .filter((field) => field.id === reference || field.nativeMetadata.sourceId === reference);
  if (matches.length === 0) {
    throw new PullRequestPolicyError(
      "PR_POLICY_UNKNOWN_REFERENCE",
      `No native PR section matches "${reference}".`,
      reference,
    );
  }
  if (matches.length > 1) {
    throw new PullRequestPolicyError(
      "PR_POLICY_AMBIGUOUS_REFERENCE",
      `Multiple native PR sections match "${reference}".`,
      reference,
    );
  }
  return matches[0] as CanonicalField;
}

function assertOverlayVersion(overlay: PullRequestPolicyOverlay): void {
  if (overlay.version !== PULL_REQUEST_POLICY_VERSION) {
    throw new PullRequestPolicyError("PR_POLICY_UNSUPPORTED_VERSION", "Unsupported PR policy version.", "$.version");
  }
}

interface SelectedPolicyEntry {
  readonly template: string | PullRequestPolicyTemplateSelector | undefined;
  readonly sections: readonly PullRequestPolicySectionRule[];
  readonly sectionsPath: string;
}

function selectPolicyEntry(
  overlay: PullRequestPolicyOverlay,
  contract: CanonicalContract,
  options: PullRequestPolicyCompileOptions,
): SelectedPolicyEntry {
  validatePolicyTemplateBindings(overlay, contract, options.templateIdentities);
  if (overlay.templates !== undefined) {
    if (overlay.templates.length === 0) {
      throw new PullRequestPolicyError(
        "PR_POLICY_INVALID_VALUE",
        "templates must be a non-empty array.",
        "$.templates",
      );
    }
    const matches = overlay.templates
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.template === undefined ||
          policySelectorMatchesContract(entry.template, contract, options.templateIdentities),
      );
    if (matches.length === 0) {
      throw new PullRequestPolicyError(
        "PR_POLICY_TEMPLATE_MISMATCH",
        "No PR policy entry targets the selected native template.",
        "$.templates",
      );
    }
    if (matches.length > 1) {
      throw new PullRequestPolicyError(
        "PR_POLICY_AMBIGUOUS_REFERENCE",
        "Multiple PR policy entries target the selected native template.",
        "$.templates",
      );
    }
    const match = matches[0] as { entry: PullRequestPolicyTemplateEntry; index: number };
    return {
      template: match.entry.template,
      sections: match.entry.sections,
      sectionsPath: `$.templates[${match.index}].sections`,
    };
  }
  assertTemplateMatch(overlay.template, contract, options.templateIdentities);
  return {
    template: overlay.template,
    sections: overlay.sections ?? [],
    sectionsPath: "$.sections",
  };
}

function validatePolicyTemplateBindings(
  overlay: PullRequestPolicyOverlay,
  contract: CanonicalContract,
  templateIdentities: readonly Pick<TemplateIdentity, "id" | "path" | "name">[] | undefined,
): void {
  if (templateIdentities === undefined) return;
  if (!templateIdentities.some((identity) => identityMatchesContract(identity, contract))) {
    throw new PullRequestPolicyError(
      "PR_POLICY_TEMPLATE_MISMATCH",
      "PR policy contract is not bound to an available native template.",
      "$.template",
    );
  }
  const entries =
    overlay.templates === undefined
      ? overlay.template === undefined
        ? []
        : [{ template: overlay.template, path: "$.template" }]
      : overlay.templates.map((entry, index) => ({
          template: entry.template,
          path: `$.templates[${index}].template`,
        }));
  entries.forEach(({ template, path }) => {
    if (template === undefined) return;
    const matches = templateIdentities.filter((identity) => templateSelectorMatchesIdentity(template, identity));
    if (matches.length === 0) {
      throw new PullRequestPolicyError(
        "PR_POLICY_TEMPLATE_MISMATCH",
        "PR policy does not target an available native template.",
        path,
      );
    }
    if (matches.length > 1) {
      throw new PullRequestPolicyError(
        "PR_POLICY_AMBIGUOUS_REFERENCE",
        "PR policy template selector matches multiple native templates.",
        path,
      );
    }
  });
}

function identityMatchesContract(
  identity: Pick<TemplateIdentity, "id" | "path" | "name">,
  contract: CanonicalContract,
): boolean {
  return identity.path === contract.templateIdentity.path && identity.name === contract.templateIdentity.name;
}

function assertTemplateMatch(
  selector: string | PullRequestPolicyTemplateSelector | undefined,
  contract: CanonicalContract,
  templateIdentities?: readonly Pick<TemplateIdentity, "id" | "path" | "name">[],
  path = "$.template",
): void {
  if (selector === undefined) return;
  if (!policySelectorMatchesContract(selector, contract, templateIdentities)) {
    throw new PullRequestPolicyError(
      "PR_POLICY_TEMPLATE_MISMATCH",
      "PR policy does not target the selected native template.",
      path,
    );
  }
}

function policySelectorMatchesContract(
  selector: string | PullRequestPolicyTemplateSelector,
  contract: CanonicalContract,
  templateIdentities: readonly Pick<TemplateIdentity, "id" | "path" | "name">[] | undefined,
): boolean {
  if (templateSelectorMatches(selector, contract)) return true;
  return (
    templateIdentities?.some(
      (identity) => identityMatchesContract(identity, contract) && templateSelectorMatchesIdentity(selector, identity),
    ) ?? false
  );
}

function templateSelectorMatches(
  selector: string | PullRequestPolicyTemplateSelector,
  contract: CanonicalContract,
): boolean {
  return typeof selector === "string"
    ? selector === contract.templateIdentity.id ||
        selector === contract.templateIdentity.path ||
        selector.toLocaleLowerCase("en-US") === contract.templateIdentity.name.toLocaleLowerCase("en-US")
    : (selector.id === undefined || selector.id === contract.templateIdentity.id) &&
        (selector.path === undefined || selector.path === contract.templateIdentity.path) &&
        (selector.name === undefined ||
          selector.name.toLocaleLowerCase("en-US") === contract.templateIdentity.name.toLocaleLowerCase("en-US"));
}

function templateSelectorMatchesIdentity(
  selector: string | PullRequestPolicyTemplateSelector,
  identity: Pick<TemplateIdentity, "id" | "path" | "name">,
): boolean {
  return typeof selector === "string"
    ? selector === identity.id ||
        selector === identity.path ||
        selector.toLocaleLowerCase("en-US") === identity.name.toLocaleLowerCase("en-US")
    : (selector.id === undefined || selector.id === identity.id) &&
        (selector.path === undefined || selector.path === identity.path) &&
        (selector.name === undefined ||
          selector.name.toLocaleLowerCase("en-US") === identity.name.toLocaleLowerCase("en-US"));
}

function parseSelector(value: unknown, path: string): string | PullRequestPolicyTemplateSelector {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (!isRecord(value))
    throw new PullRequestPolicyError(
      "PR_POLICY_INVALID_VALUE",
      "template must be a non-empty string or selector object.",
      path,
    );
  assertKeys(value, ["id", "path", "name"], path);
  const selector: PullRequestPolicyTemplateSelector = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
  if (Object.keys(selector).length === 0)
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", "template selector must not be empty.", path);
  return selector;
}

function assertKeys(record: RecordValue, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new PullRequestPolicyError(
      "PR_POLICY_UNKNOWN_PROPERTY",
      `Unknown property "${unknown[0]}".`,
      `${path}.${unknown[0]}`,
    );
  }
}

function optionalString(record: RecordValue, key: string, path: string): string | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== "string")
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `${key} must be a string.`, `${path}.${key}`);
  return record[key] as string;
}

function optionalBoolean(record: RecordValue, key: string, path: string): boolean | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== "boolean")
    throw new PullRequestPolicyError("PR_POLICY_INVALID_VALUE", `${key} must be a boolean.`, `${path}.${key}`);
  return record[key] as boolean;
}

function optionalInteger(record: RecordValue, key: string, path: string): number | undefined {
  if (record[key] === undefined) return undefined;
  if (!Number.isSafeInteger(record[key]) || typeof record[key] !== "number" || (record[key] as number) < 0) {
    throw new PullRequestPolicyError(
      "PR_POLICY_INVALID_VALUE",
      `${key} must be a non-negative integer.`,
      `${path}.${key}`,
    );
  }
  return record[key] as number;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
