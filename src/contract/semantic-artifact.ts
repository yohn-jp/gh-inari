/**
 * Core materialization for a compiled Effective Artifact Contract.
 *
 * This module is deliberately below every representation adapter.  It only
 * accepts the values allowed by the Effective Contract, applies repository
 * fixed values, and evaluates the already-parsed bounded derivation plans.
 * It does not parse Markdown, render a body/title, or access a transport.
 */

import {
  compileEffectiveArtifactContract,
  type EffectiveArtifactContract,
  type EffectiveArtifactContractVersion,
} from "./effective-artifact-contract.js";
import {
  parseArtifactContract,
  serializeArtifactContract,
  type ArtifactContract,
  type ArtifactContractDerivation,
  type ArtifactContractKind,
  type DerivationFormatPart,
  type DerivationReference,
  type FieldContentConstraints,
  type FieldDeclaration,
  type PropertyConstraints,
  type PropertyValueDeclaration,
  type ValueShape,
} from "./artifact-contract.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./issue-reference.js";
import type { ArtifactContractProvenance } from "./ir.js";

export const SEMANTIC_ARTIFACT_VERSION = "1" as const;
export type SemanticArtifactVersion = typeof SEMANTIC_ARTIFACT_VERSION;

/** Stable failures at the Effective Contract and caller-input boundaries. */
export type SemanticArtifactMaterializationViolationCode =
  | "EFFECTIVE_CONTRACT_INVALID"
  | "INPUT_NOT_OBJECT"
  | "INPUT_UNKNOWN_FIELD"
  | "INPUT_AUTHORITY"
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
  | "INPUT_PLATFORM_UNRESOLVED"
  | "DERIVATION_UNRESOLVED"
  | "DERIVATION_INVALID"
  | "DERIVATION_UNSUPPORTED"
  | "OUTPUT_INVALID";

export interface SemanticArtifactMaterializationViolation {
  readonly code: SemanticArtifactMaterializationViolationCode;
  readonly path: string;
  readonly message: string;
}

/** A fully materialized semantic instance, independent of GitHub or Markdown. */
export interface SemanticArtifact {
  readonly version: SemanticArtifactVersion;
  readonly effectiveContractVersion: EffectiveArtifactContractVersion;
  readonly artifactContractVersion: ArtifactContract["version"];
  readonly kind: ArtifactContractKind;
  readonly id: string;
  /** Materialized Core semantic properties, including Issue-valued relations. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Materialized Core body-field values, when the contract declares fields. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly provenance: ArtifactContractProvenance;
  readonly generation: ArtifactContractProvenance;
  /** Non-enumerable view of the Issue-valued relation properties. */
  readonly relations?: Readonly<Record<string, unknown>>;
  /** Non-enumerable alias for callers that name semantic properties directly. */
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface SemanticArtifactMaterializationResult {
  readonly valid: boolean;
  readonly artifact?: SemanticArtifact;
  readonly violations: readonly SemanticArtifactMaterializationViolation[];
}

export class SemanticArtifactMaterializationError extends Error {
  readonly violations: readonly SemanticArtifactMaterializationViolation[];

  constructor(violations: readonly SemanticArtifactMaterializationViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "SemanticArtifactMaterializationError";
    this.violations = violations;
  }
}

type RecordValue = Record<string, unknown>;
type Declaration = PropertyValueDeclaration | FieldDeclaration;

interface ValueValidationResult {
  readonly valid: boolean;
  readonly value?: unknown;
}

interface EffectiveContractValidationResult {
  readonly effective?: EffectiveArtifactContract;
  readonly violations: readonly SemanticArtifactMaterializationViolation[];
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function addViolation(
  violations: SemanticArtifactMaterializationViolation[],
  code: SemanticArtifactMaterializationViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

/** Clone JSON-shaped semantic data while making the result independent and immutable. */
function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) clone[key] = cloneImmutable(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

/** Stable comparison that does not depend on object insertion order. */
function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (stack.has(value)) throw new TypeError("Cyclic JSON data.");
  stack.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
  } else {
    const record = value as RecordValue;
    result = `{${Object.keys(record)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], stack)}`)
      .join(",")}}`;
  }
  stack.delete(value);
  return result;
}

function invalidEffectiveContract(message: string, path = "$"): EffectiveContractValidationResult {
  return {
    violations: [{ code: "EFFECTIVE_CONTRACT_INVALID", path, message }],
  };
}

function provenanceIsValid(value: unknown): value is ArtifactContractProvenance {
  if (!isRecord(value) || value.authority !== "repository-default-branch") return false;
  if (!isRecord(value.repository) || !isRecord(value.source)) return false;
  const repository = value.repository;
  const source = value.source;
  const repositoryStrings = ["host", "owner", "name", "nameWithOwner"];
  const sourceStrings = ["path", "ref", "sha", "digest"];
  if (repositoryStrings.some((key) => typeof repository[key] !== "string" || repository[key].length === 0)) {
    return false;
  }
  if (
    repository.repositoryId !== undefined &&
    (typeof repository.repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(repository.repositoryId))
  ) {
    return false;
  }
  return (
    typeof value.ref === "string" &&
    value.ref.length > 0 &&
    typeof value.treeSha === "string" &&
    value.treeSha.length > 0 &&
    sourceStrings.every((key) => typeof source[key] === "string" && source[key].length > 0)
  );
}

function declarationEntries(effective: EffectiveArtifactContract): readonly [string, Declaration][] {
  const entries: [string, Declaration][] = [];
  for (const name of Object.keys(effective.contract.properties).sort(compareStrings)) {
    const declaration = effective.contract.properties[name];
    if (declaration !== undefined) entries.push([name, declaration]);
  }
  for (const field of effective.contract.fields ?? []) entries.push([field.id, field]);
  return entries;
}

/**
 * Validate the compiler product itself before consuming it.  The expected
 * value is rebuilt by the #282 compiler for consistency checking only; the
 * materializer evaluates the supplied compiled plans and never parses their
 * grammar or recomputes their order.
 */
function validateEffectiveContract(input: unknown): EffectiveContractValidationResult {
  if (!isRecord(input)) return invalidEffectiveContract("Effective Artifact Contract must be an object.");
  if (input.version !== "1")
    return invalidEffectiveContract("Unsupported Effective Artifact Contract version.", "$.version");
  if (!isRecord(input.contract))
    return invalidEffectiveContract("Effective Contract source IR is missing.", "$.contract");
  if (!provenanceIsValid(input.provenance)) {
    return invalidEffectiveContract("Effective Contract provenance is invalid.", "$.provenance");
  }
  if (!provenanceIsValid(input.generation)) {
    return invalidEffectiveContract("Effective Contract generation is invalid.", "$.generation");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.some((capability) => typeof capability !== "string")) {
    return invalidEffectiveContract("Effective Contract capabilities are invalid.", "$.capabilities");
  }
  try {
    const effective = input as unknown as EffectiveArtifactContract;
    const expected = compileEffectiveArtifactContract(effective.contract, {
      provenance: effective.provenance,
      capabilities: effective.capabilities,
    });
    const fieldsMatch =
      (Object.hasOwn(input, "fields") ? input.fields : undefined) === undefined
        ? !Object.hasOwn(expected, "fields")
        : stableSerialize(input.fields) === stableSerialize(expected.fields);
    const metadataMatches =
      input.version === expected.version &&
      input.artifactContractVersion === expected.artifactContractVersion &&
      input.kind === expected.kind &&
      input.id === expected.id &&
      stableSerialize(input.contract) === stableSerialize(expected.contract) &&
      stableSerialize(input.properties) === stableSerialize(expected.properties) &&
      fieldsMatch &&
      stableSerialize(input.inputSchema) === stableSerialize(expected.inputSchema) &&
      stableSerialize(input.derivations) === stableSerialize(expected.derivations) &&
      stableSerialize(input.dependencyGraph) === stableSerialize(expected.dependencyGraph) &&
      stableSerialize(input.evaluationOrder) === stableSerialize(expected.evaluationOrder) &&
      stableSerialize(input.provenance) === stableSerialize(expected.provenance) &&
      stableSerialize(input.generation) === stableSerialize(expected.generation) &&
      stableSerialize(input.capabilities) === stableSerialize(expected.capabilities);
    if (!metadataMatches)
      return invalidEffectiveContract("Effective Contract metadata is inconsistent with its source IR.");

    if (!isRecord(input.properties) || !isRecord(input.inputSchema) || !Array.isArray(input.derivations)) {
      return invalidEffectiveContract("Effective Contract compiled metadata is incomplete.");
    }
    if (stableSerialize(input.generation) !== stableSerialize(input.provenance)) {
      return invalidEffectiveContract("Effective Contract generation must equal provenance.", "$.generation");
    }

    const entries = declarationEntries(effective);
    const names = new Set<string>();
    for (const [name, declaration] of entries) {
      if (names.has(name)) return invalidEffectiveContract(`Duplicate semantic declaration "${name}".`, `$.${name}`);
      names.add(name);
      if (!isRecord(declaration)) return invalidEffectiveContract(`Declaration "${name}" is invalid.`, `$.${name}`);
      if (declaration.presence === "unused") {
        if (declaration.cardinality.min !== 0 || declaration.cardinality.max !== 0) {
          return invalidEffectiveContract(`Unused declaration "${name}" has non-zero cardinality.`, `$.${name}`);
        }
      } else if (
        declaration.authority === undefined ||
        !isRecord(declaration.authority) ||
        !["supplied", "derived", "fixed", "platform"].includes(String(declaration.authority.kind))
      ) {
        return invalidEffectiveContract(`Declaration "${name}" has invalid authority.`, `$.${name}`);
      }
    }

    const derivations = new Map<string, ArtifactContractDerivation>();
    for (const derivation of effective.derivations) {
      if (!isRecord(derivation) || typeof derivation.target !== "string" || derivations.has(derivation.target)) {
        return invalidEffectiveContract(
          "Effective Contract derivations contain a duplicate or invalid target.",
          "$.derivations",
        );
      }
      derivations.set(derivation.target, derivation);
      const declaration = entries.find(([name]) => name === derivation.target)?.[1];
      if (declaration === undefined || declaration.presence === "unused" || declaration.authority.kind !== "derived") {
        return invalidEffectiveContract(
          `Derivation target "${derivation.target}" is not a derived declaration.`,
          "$.derivations",
        );
      }
      if (stableSerialize(derivation.operation) !== stableSerialize(declaration.authority.derive)) {
        return invalidEffectiveContract(
          `Derivation "${derivation.target}" does not match its declaration.`,
          "$.derivations",
        );
      }
      if (!Array.isArray(derivation.dependencies)) {
        return invalidEffectiveContract(`Derivation "${derivation.target}" dependencies are invalid.`, "$.derivations");
      }
      if (derivation.operation.op === "format") {
        if (!Array.isArray(derivation.formatParts)) {
          return invalidEffectiveContract(
            `Format derivation "${derivation.target}" is missing format parts.`,
            "$.derivations",
          );
        }
        const references = derivation.formatParts
          .filter(
            (part): part is Extract<DerivationFormatPart, { readonly kind: "reference" }> =>
              isRecord(part) && part.kind === "reference" && isRecord(part.reference),
          )
          .map((part) => part.reference);
        if (stableSerialize(references) !== stableSerialize(derivation.dependencies)) {
          return invalidEffectiveContract(
            `Format derivation "${derivation.target}" metadata is inconsistent.`,
            "$.derivations",
          );
        }
      } else if (Object.hasOwn(derivation, "formatParts")) {
        return invalidEffectiveContract(
          `Non-format derivation "${derivation.target}" has format parts.`,
          "$.derivations",
        );
      }
    }
    for (const [name, declaration] of entries) {
      const isDerived = declaration.presence !== "unused" && declaration.authority.kind === "derived";
      if (isDerived !== derivations.has(name)) {
        return invalidEffectiveContract(`Derivation coverage for "${name}" is incomplete.`, "$.derivations");
      }
    }
    if (
      !Array.isArray(effective.evaluationOrder) ||
      new Set(effective.evaluationOrder).size !== effective.evaluationOrder.length ||
      effective.evaluationOrder.length !== derivations.size ||
      effective.evaluationOrder.some((name) => !derivations.has(name))
    ) {
      return invalidEffectiveContract("Effective Contract evaluation order is invalid.", "$.evaluationOrder");
    }
    const positions = new Map(effective.evaluationOrder.map((name, index) => [name, index]));
    for (const [name, derivation] of derivations) {
      for (const dependency of derivation.dependencies) {
        if (!isRecord(dependency) || typeof dependency.name !== "string") {
          return invalidEffectiveContract(`Derivation "${name}" has an invalid dependency.`, "$.derivations");
        }
        const dependencyPosition = positions.get(dependency.name);
        if (dependencyPosition !== undefined && dependencyPosition >= (positions.get(name) as number)) {
          return invalidEffectiveContract(
            "Effective Contract evaluation order violates dependency order.",
            "$.evaluationOrder",
          );
        }
      }
      const graphEntry = isRecord(input.dependencyGraph) ? input.dependencyGraph[name] : undefined;
      if (stableSerialize(graphEntry) !== stableSerialize(derivation.dependencies)) {
        return invalidEffectiveContract(`Dependency graph entry for "${name}" is inconsistent.`, "$.dependencyGraph");
      }
    }

    // Reuse the Artifact Contract parser as the boundary check for a
    // hand-assembled/malformed Effective Contract.  No derivation grammar is
    // implemented here; evaluation below consumes only compiled metadata.
    const reparsed = parseArtifactContract(JSON.parse(serializeArtifactContract(effective.contract)) as unknown);
    if (stableSerialize(reparsed) !== stableSerialize(effective.contract)) {
      return invalidEffectiveContract(
        "Effective Contract source IR is not a normalized Artifact Contract.",
        "$.contract",
      );
    }
    return { effective, violations: [] };
  } catch {
    return invalidEffectiveContract("Effective Contract failed closed validation.");
  }
}

function cloneInputValue(
  value: unknown,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
  stack = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) {
    addViolation(violations, "INPUT_TYPE", path, "Value must be JSON-compatible.");
    return undefined;
  }
  if (stack.has(value)) {
    addViolation(violations, "INPUT_TYPE", path, "Value must not contain cycles.");
    return undefined;
  }
  stack.add(value);
  let cloned: unknown;
  if (Array.isArray(value)) {
    cloned = value.map((entry, index) => cloneInputValue(entry, `${path}[${index}]`, violations, stack));
  } else {
    const record: Record<string, unknown> = {};
    const source = value as RecordValue;
    for (const key of Object.keys(source).sort(compareStrings)) {
      record[key] = cloneInputValue(source[key], `${path}.${key}`, violations, stack);
    }
    cloned = record;
  }
  stack.delete(value);
  return cloned;
}

function validateStringConstraints(
  value: string,
  constraints: PropertyConstraints | FieldContentConstraints | undefined,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
  enumCode: "INPUT_ENUM" | "INPUT_OPTION" = "INPUT_ENUM",
): void {
  if (constraints?.values !== undefined && !constraints.values.includes(value)) {
    addViolation(violations, enumCode, path, "Value is not declared by the contract.");
  }
  const length = Array.from(value).length;
  if (constraints?.minLength !== undefined && length < constraints.minLength) {
    addViolation(
      violations,
      "INPUT_MIN_LENGTH",
      path,
      `Value must contain at least ${constraints.minLength} characters.`,
    );
  }
  if (constraints?.maxLength !== undefined && length > constraints.maxLength) {
    addViolation(
      violations,
      "INPUT_MAX_LENGTH",
      path,
      `Value must contain at most ${constraints.maxLength} characters.`,
    );
  }
  if (constraints?.pattern !== undefined) {
    let matches = false;
    try {
      matches = new RegExp(constraints.pattern, "u").test(value);
    } catch {
      matches = false;
    }
    if (!matches) addViolation(violations, "INPUT_PATTERN", path, "Value does not match the contract pattern.");
  }
}

function validateIssueReferenceValue(
  value: unknown,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addViolation(violations, "INPUT_TYPE", path, "Value must be a valid IssueReference.");
    return undefined;
  }
  return result.reference;
}

function validatePropertyScalar(
  shape: ValueShape,
  value: unknown,
  constraints: PropertyConstraints | undefined,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
): unknown {
  if (shape === "boolean") {
    if (typeof value !== "boolean") addViolation(violations, "INPUT_TYPE", path, "Value must be a boolean.");
    return typeof value === "boolean" ? value : undefined;
  }
  if (shape === "issue_reference") return validateIssueReferenceValue(value, path, violations);
  if (typeof value !== "string") {
    addViolation(violations, "INPUT_TYPE", path, "Value must be a string.");
    return undefined;
  }
  validateStringConstraints(value, constraints, path, violations);
  return value;
}

function validatePropertyValue(
  declaration: Exclude<PropertyValueDeclaration, { readonly presence: "unused" }>,
  rawValue: unknown,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
  output = false,
): ValueValidationResult {
  const local: SemanticArtifactMaterializationViolation[] = [];
  const constraints = declaration.constraints;
  if (declaration.cardinality.max === "many") {
    if (!Array.isArray(rawValue)) {
      addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_TYPE", path, "Value must be an array.");
    } else {
      const minimum = Math.max(declaration.cardinality.min, constraints?.minItems ?? 0);
      if (rawValue.length < minimum)
        addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_MIN_ITEMS", path, "Value has too few items.");
      if (constraints?.maxItems !== undefined && rawValue.length > constraints.maxItems)
        addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_MAX_ITEMS", path, "Value has too many items.");
      const values: unknown[] = [];
      const identities = new Set<string>();
      rawValue.forEach((entry, index) => {
        const itemPath = `${path}[${index}]`;
        const value = validatePropertyScalar(declaration.shape, entry, constraints, itemPath, local);
        if (value !== undefined || declaration.shape === "boolean") values.push(value);
        if (declaration.shape === "issue_reference" && value !== undefined) {
          const identity = issueReferenceKey(value as IssueReference);
          if (identities.has(identity))
            addViolation(
              local,
              output ? "OUTPUT_INVALID" : "INPUT_DUPLICATE",
              itemPath,
              "Issue references must be unique.",
            );
          identities.add(identity);
        } else if (declaration.shape !== "issue_reference" && typeof value === "string") {
          if (identities.has(value))
            addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_DUPLICATE", itemPath, "Values must be unique.");
          identities.add(value);
        }
      });
      if (local.length === 0) {
        violations.push(...local);
        return { valid: true, value: values };
      }
      violations.push(...local);
      return { valid: false };
    }
  } else {
    const value = validatePropertyScalar(declaration.shape, rawValue, constraints, path, local);
    if (local.length === 0) {
      violations.push(...local);
      return { valid: true, value };
    }
  }
  violations.push(...local);
  return { valid: false };
}

function fieldItems(field: FieldDeclaration): readonly { readonly id: string; readonly required: boolean }[] {
  return "constraints" in field ? (field.constraints?.items ?? []) : [];
}

function validateFieldValue(
  declaration: Exclude<FieldDeclaration, { readonly presence: "unused" }>,
  rawValue: unknown,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
  output = false,
): ValueValidationResult {
  const local: SemanticArtifactMaterializationViolation[] = [];
  const code = output ? "OUTPUT_INVALID" : "INPUT_TYPE";
  const constraints = "constraints" in declaration ? declaration.constraints : undefined;
  if (declaration.primitive === "text") {
    if (typeof rawValue !== "string") addViolation(local, code, path, "Field value must be a string.");
    else validateStringConstraints(rawValue, constraints, path, local, "INPUT_OPTION");
    violations.push(...local);
    return local.length === 0 ? { valid: true, value: rawValue } : { valid: false };
  }
  if (!Array.isArray(rawValue)) {
    addViolation(local, code, path, "Field value must be an array.");
    violations.push(...local);
    return { valid: false };
  }
  const minimum = Math.max(declaration.cardinality.min, constraints?.minItems ?? 0);
  if (rawValue.length < minimum)
    addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_MIN_ITEMS", path, "Field has too few items.");
  if (constraints?.maxItems !== undefined && rawValue.length > constraints.maxItems) {
    addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_MAX_ITEMS", path, "Field has too many items.");
  }
  const values: unknown[] = [];
  const identities = new Set<string>();
  const items = fieldItems(declaration);
  const allowed = declaration.primitive === "choice" ? (constraints?.values ?? []) : items.map((item) => item.id);
  rawValue.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (declaration.primitive === "attachment") {
      const cloned = cloneInputValue(entry, itemPath, local);
      values.push(cloned);
      return;
    }
    if (typeof entry !== "string") {
      addViolation(local, code, itemPath, "Field items must be strings.");
      return;
    }
    if (!allowed.includes(entry))
      addViolation(
        local,
        output ? "OUTPUT_INVALID" : "INPUT_OPTION",
        itemPath,
        "Item is not declared by the contract.",
      );
    if (identities.has(entry))
      addViolation(local, output ? "OUTPUT_INVALID" : "INPUT_DUPLICATE", itemPath, "Field items must be unique.");
    identities.add(entry);
    values.push(entry);
  });
  if (declaration.primitive === "checklist") {
    for (const item of items) {
      if (item.required && !values.includes(item.id)) {
        addViolation(
          local,
          output ? "OUTPUT_INVALID" : "INPUT_CHECKLIST_REQUIRED",
          path,
          `Required checklist item "${item.id}" is missing.`,
        );
      }
    }
  }
  violations.push(...local);
  return local.length === 0 ? { valid: true, value: values } : { valid: false };
}

function declarationValue(
  declaration: Declaration,
  rawValue: unknown,
  path: string,
  violations: SemanticArtifactMaterializationViolation[],
  output = false,
): ValueValidationResult {
  if (declaration.presence === "unused") {
    addViolation(
      violations,
      output ? "OUTPUT_INVALID" : "INPUT_AUTHORITY",
      path,
      "Unused values cannot be materialized.",
    );
    return { valid: false };
  }
  if ("primitive" in declaration) return validateFieldValue(declaration, rawValue, path, violations, output);
  return validatePropertyValue(declaration, rawValue, path, violations, output);
}

function readReference(values: Readonly<Record<string, unknown>>, reference: DerivationReference): unknown {
  const source = values[reference.name];
  if (source === undefined) return undefined;
  if (reference.member === undefined) return source;
  if (reference.member === "number" && isRecord(source) && typeof source.number === "number") return source.number;
  return undefined;
}

function derivationString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function evaluateDerivation(
  derivation: ArtifactContractDerivation,
  values: Readonly<Record<string, unknown>>,
  violations: SemanticArtifactMaterializationViolation[],
): { readonly resolved: boolean; readonly value?: unknown } {
  if (derivation.operation.op === "copy") {
    const reference = derivation.dependencies[0];
    if (reference === undefined) {
      addViolation(
        violations,
        "DERIVATION_INVALID",
        `$.${derivation.target}`,
        "Copy derivation metadata is incomplete.",
      );
      return { resolved: false };
    }
    const source = readReference(values, reference);
    if (source === undefined) return { resolved: false };
    return { resolved: true, value: source };
  }
  if (derivation.operation.op === "slug") {
    const reference = derivation.dependencies[0];
    if (reference === undefined) {
      addViolation(
        violations,
        "DERIVATION_INVALID",
        `$.${derivation.target}`,
        "Slug derivation metadata is incomplete.",
      );
      return { resolved: false };
    }
    const source = readReference(values, reference);
    const text = derivationString(source);
    if (text === undefined) return { resolved: false };
    return { resolved: true, value: slugify(text) };
  }
  const parts = derivation.formatParts;
  if (parts === undefined) {
    addViolation(
      violations,
      "DERIVATION_INVALID",
      `$.${derivation.target}`,
      "Format derivation metadata is incomplete.",
    );
    return { resolved: false };
  }
  let result = "";
  for (const part of parts) {
    if (part.kind === "literal") {
      result += part.value;
      continue;
    }
    const value = readReference(values, part.reference);
    const text = derivationString(value);
    if (text === undefined) return { resolved: false };
    result += text;
  }
  return { resolved: true, value: result };
}

function authorityOf(declaration: Declaration): string | undefined {
  return declaration.presence === "unused" ? undefined : declaration.authority.kind;
}

function relationValues(
  kind: ArtifactContractKind,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const names = kind === "issue" ? ["parent", "dependsOn"] : kind === "pull_request" ? ["implements"] : [];
  const relations: Record<string, unknown> = {};
  for (const name of names) if (Object.hasOwn(values, name)) relations[name] = values[name];
  return Object.freeze(relations);
}

function buildArtifact(
  effective: EffectiveArtifactContract,
  values: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>,
): SemanticArtifact {
  const provenance = cloneImmutable(effective.provenance);
  const immutableValues = cloneImmutable(values);
  const artifact = {
    version: SEMANTIC_ARTIFACT_VERSION,
    effectiveContractVersion: effective.version,
    artifactContractVersion: effective.artifactContractVersion,
    kind: effective.kind,
    id: effective.id,
    values: immutableValues,
    fields: cloneImmutable(fields),
    provenance,
    generation: provenance,
  } as SemanticArtifact & { readonly relations?: Readonly<Record<string, unknown>>; readonly properties?: unknown };
  // These are non-enumerable compatibility views.  The canonical artifact
  // remains the `values` + `fields` pair and JSON output stays minimal.
  Object.defineProperties(artifact, {
    properties: { value: artifact.values, enumerable: false },
    relations: { value: relationValues(effective.kind, immutableValues), enumerable: false },
  });
  return Object.freeze(artifact);
}

function materializeResult(effectiveInput: unknown, input: unknown): SemanticArtifactMaterializationResult {
  const effectiveResult = validateEffectiveContract(effectiveInput);
  if (effectiveResult.effective === undefined) return { valid: false, violations: effectiveResult.violations };
  const effective = effectiveResult.effective;
  const violations: SemanticArtifactMaterializationViolation[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      violations: [{ code: "INPUT_NOT_OBJECT", path: "$", message: "Caller input must be a JSON object." }],
    };
  }

  const entries = declarationEntries(effective);
  const declarations = new Map(entries);
  for (const key of Object.keys(input).sort(compareStrings)) {
    const declaration = declarations.get(key);
    if (declaration === undefined) {
      addViolation(
        violations,
        "INPUT_UNKNOWN_FIELD",
        `$.${key}`,
        `Value "${key}" is not declared by the Effective Contract.`,
      );
    } else if (declaration.presence === "unused" || authorityOf(declaration) !== "supplied") {
      addViolation(
        violations,
        "INPUT_AUTHORITY",
        `$.${key}`,
        `Caller cannot supply ${authorityOf(declaration) ?? "unused"} value "${key}".`,
      );
    }
  }

  const values: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  const materialized: Record<string, unknown> = {};
  const assign = (name: string, declaration: Declaration, value: unknown): void => {
    ("primitive" in declaration ? fields : values)[name] = value;
    materialized[name] = value;
  };
  for (const [name, declaration] of entries) {
    const path = `$.${name}`;
    if (declaration.presence === "unused") continue;
    const authority = declaration.authority;
    if (authority.kind === "platform") {
      if (declaration.presence === "required" && !hasOwn(input, name)) {
        addViolation(
          violations,
          "INPUT_PLATFORM_UNRESOLVED",
          path,
          `Required platform value "${name}" is unavailable to Core.`,
        );
      }
      continue;
    }
    if (authority.kind === "fixed") {
      const result = declarationValue(declaration, authority.value, path, violations, true);
      if (result.valid) assign(name, declaration, result.value);
      continue;
    }
    if (authority.kind !== "supplied") continue;
    if (!hasOwn(input, name)) {
      if (declaration.presence === "required")
        addViolation(violations, "INPUT_REQUIRED", path, `Required supplied value "${name}" is missing.`);
      continue;
    }
    const result = declarationValue(declaration, input[name], path, violations);
    if (result.valid) assign(name, declaration, result.value);
  }

  const derivations = new Map(effective.derivations.map((derivation) => [derivation.target, derivation]));
  for (const name of effective.evaluationOrder) {
    const derivation = derivations.get(name);
    const declaration = declarations.get(name);
    if (derivation === undefined || declaration === undefined || declaration.presence === "unused") {
      addViolation(violations, "DERIVATION_INVALID", `$.${name}`, "Evaluation order references an invalid derivation.");
      continue;
    }
    const evaluated = evaluateDerivation(derivation, materialized, violations);
    if (!evaluated.resolved) {
      if (declaration.presence === "required") {
        addViolation(
          violations,
          "DERIVATION_UNRESOLVED",
          `$.${name}`,
          `Required derivation "${name}" cannot be resolved.`,
        );
      }
      continue;
    }
    const result = declarationValue(declaration, evaluated.value, `$.${name}`, violations, true);
    if (result.valid) assign(name, declaration, result.value);
  }

  if (violations.length > 0) return { valid: false, violations };
  return { valid: true, artifact: buildArtifact(effective, values, fields), violations: [] };
}

/** Materialize a complete Semantic Artifact or throw stable diagnostics. */
export function materializeSemanticArtifact(effectiveContract: unknown, input: unknown): SemanticArtifact {
  const result = materializeResult(effectiveContract, input);
  if (!result.valid || result.artifact === undefined) throw new SemanticArtifactMaterializationError(result.violations);
  return result.artifact;
}

/** Non-throwing companion for callers that need structured preflight diagnostics. */
export function tryMaterializeSemanticArtifact(
  effectiveContract: unknown,
  input: unknown,
): SemanticArtifactMaterializationResult {
  return materializeResult(effectiveContract, input);
}

/** Explicit result-named alias for Core callers that prefer result terminology. */
export const materializeSemanticArtifactResult = tryMaterializeSemanticArtifact;
