import { assertCanonicalContract, LINKED_ISSUE_PATTERN, type CanonicalContract, type CanonicalField } from "./ir.js";
import { effectiveFieldConstraints, REQUIRED_STRING_PATTERN, type EffectiveFieldConstraints } from "./constraints.js";
import { normalizeFieldValue } from "./normalization.js";
import {
  createArtifactDiagnostic,
  createArtifactDiagnosticReport,
  createFieldEvidence,
  serializeArtifactDiagnosticReport,
  type ArtifactDiagnostic,
  type ArtifactDiagnosticReport,
  type ArtifactDiagnosticReason,
} from "../diagnostics.js";

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
  | "INPUT_CHECKLIST_INCOMPLETE"
  | "INPUT_UNSAFE_CONTENT";

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

/** Compact identity retained by a partial result for a later repair merge. */
export interface PartialArtifactIdentity {
  readonly artifactKind: CanonicalContract["artifactKind"];
  readonly irVersion: CanonicalContract["irVersion"];
  readonly schemaVersion: CanonicalContract["schemaVersion"];
  readonly templateIdentity: CanonicalContract["templateIdentity"];
}

/** Field-local constraints projected without defaults or the complete schema. */
export interface PartialFieldConstraintProjection {
  readonly field: string;
  readonly path: string;
  readonly type: CanonicalField["type"];
  readonly required: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly linkedIssue?: true;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly allowedValues?: readonly string[];
  readonly requiredItems?: readonly string[];
  readonly checklistRequireComplete?: true;
}

export interface PartialFieldIssue {
  readonly field: string;
  readonly path: string;
  readonly reason: ArtifactDiagnosticReason;
  readonly message: string;
  /** Only unresolved fields carry projected constraints. */
  readonly constraints?: PartialFieldConstraintProjection;
}

/**
 * Stateless classification of a supplied field map. `values` contains only
 * supplied values that passed validation; defaults are deliberately excluded.
 */
export interface PartialSemanticValidationResult {
  readonly valid: boolean;
  /** True only when every declared field was supplied and accepted. */
  readonly complete: boolean;
  readonly artifactKind: CanonicalContract["artifactKind"];
  readonly templateIdentity: CanonicalContract["templateIdentity"];
  readonly identity: PartialArtifactIdentity;
  readonly acceptedFields: readonly string[];
  readonly missingFields: readonly PartialFieldIssue[];
  readonly invalidFields: readonly PartialFieldIssue[];
  readonly values: Readonly<Record<string, unknown>>;
  /** Projections are present only for fields in missingFields/invalidFields. */
  readonly projectedConstraints: readonly PartialFieldConstraintProjection[];
  readonly diagnostics: ArtifactDiagnosticReport;
}

/**
 * The immutable state a caller carries between partial repair attempts.
 *
 * This deliberately contains accepted semantic values only.  Missing and
 * invalid values are not carried forward, so a repair cannot accidentally
 * turn an earlier diagnostic into candidate state.
 */
export interface PartialSemanticRepairContext {
  readonly identity: PartialArtifactIdentity;
  readonly acceptedFields: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

/** Result of merging one bounded repair patch into an accepted candidate. */
export interface PartialSemanticRepairResult {
  /** True only when the patch and the complete merged candidate are valid. */
  readonly valid: boolean;
  /** True when the merged candidate can be rendered by the canonical path. */
  readonly complete: boolean;
  readonly artifactKind: CanonicalContract["artifactKind"];
  readonly templateIdentity: CanonicalContract["templateIdentity"];
  readonly identity: PartialArtifactIdentity;
  /** Accepted values after this attempt; invalid patch values are excluded. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Values after canonical defaults are materialized, when complete is true. */
  readonly canonicalValues: Readonly<Record<string, unknown>>;
  readonly acceptedFields: readonly string[];
  readonly changedFields: readonly string[];
  /** True when no patch value changed accepted semantic state. */
  readonly noOp: boolean;
  readonly context: PartialSemanticRepairContext;
  readonly missingFields: readonly PartialFieldIssue[];
  readonly invalidFields: readonly PartialFieldIssue[];
  readonly projectedConstraints: readonly PartialFieldConstraintProjection[];
  readonly diagnostics: ArtifactDiagnosticReport;
  /** The reclassified candidate, useful for the next stateless attempt. */
  readonly partial: PartialSemanticValidationResult;
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
    const normalization = present ? normalizeFieldValue(field, rawValue) : { ok: true as const, value: rawValue };
    if (!normalization.ok) {
      violations.push({ code: normalization.violation.code, path, message: normalization.violation.message });
      continue;
    }
    const value = normalization.value;
    const fieldViolations = validateField(field, value, path, constraints);
    violations.push(...fieldViolations);
    if (fieldViolations.length === 0) values[field.id] = value;
  }

  return { valid: violations.length === 0, violations, values };
}

/**
 * Classify a partial semantic field map without applying contract defaults.
 * This is intentionally stateless: the returned identity and accepted values
 * are sufficient for a caller to merge a later repair patch locally.
 */
export function validatePartialSemanticInput(contractInput: unknown, input: unknown): PartialSemanticValidationResult {
  assertCanonicalContract(contractInput);
  const contract = contractInput;
  const fields = flattenFields(contract);
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const supplied = isRecord(input) ? input : undefined;
  const acceptedFields: string[] = [];
  const missingFields: PartialFieldIssue[] = [];
  const invalidFields: PartialFieldIssue[] = [];
  const unresolved = new Map<string, PartialFieldConstraintProjection>();
  const values: Record<string, unknown> = {};
  const diagnostics = [];

  if (supplied === undefined) {
    const diagnostic = createArtifactDiagnostic({
      state: "invalid",
      code: "FIELD_INVALID",
      detailCode: "FIELD_INVALID",
      reason: "constraint",
      message: "Partial semantic input must be a JSON object.",
      recovery: [{ action: "replace", hint: "Provide a JSON object containing semantic fields." }],
    });
    diagnostics.push(diagnostic);
  } else {
    for (const key of Object.keys(supplied).sort(compareStrings)) {
      if (fieldById.has(key)) continue;
      diagnostics.push(
        createArtifactDiagnostic({
          state: "invalid",
          code: "FIELD_INVALID",
          detailCode: "FIELD_INVALID",
          reason: "constraint",
          path: partialFieldPath(key),
          message: "Field is not declared by the compiled contract.",
          actual: createFieldEvidence(partialFieldPath(key), supplied[key]),
          recovery: [{ action: "replace", path: partialFieldPath(key), hint: "Remove the undeclared field." }],
        }),
      );
      invalidFields.push({
        field: key,
        path: partialFieldPath(key),
        reason: "constraint",
        message: "Field is not declared by the compiled contract.",
      });
    }

    for (const field of fields) {
      const path = partialFieldPath(field.id);
      const constraints = projectPartialFieldConstraints(contract, field);
      const present = Object.prototype.hasOwnProperty.call(supplied, field.id);
      if (!present) {
        // Defaults are a complete-input concern. A repair loop must receive
        // an explicit value even when the full validator could materialize one.
        if (constraints.required) {
          const message = "A required field is missing.";
          const issue: PartialFieldIssue = {
            field: field.id,
            path,
            reason: "required",
            message,
            constraints,
          };
          missingFields.push(issue);
          unresolved.set(field.id, constraints);
          diagnostics.push(
            createArtifactDiagnostic({
              state: "missing",
              code: "FIELD_MISSING",
              detailCode: "FIELD_REQUIRED",
              path,
              message,
              recovery: [{ action: "provide", path, hint: "Provide a value for this field." }],
            }),
          );
        }
        continue;
      }

      const rawValue = supplied[field.id];
      const normalization = normalizeFieldValue(field, rawValue);
      if (!normalization.ok) {
        // A normalization rejection is a parse-boundary failure, not a
        // semantic constraint violation: it must stay distinguishable in the
        // #118 diagnostics contract (state/code/reason "unsupported") from
        // the FIELD_INVALID/"constraint" shape validateField produces below.
        const message = normalization.violation.message;
        const issue: PartialFieldIssue = { field: field.id, path, reason: "unsupported", message, constraints };
        invalidFields.push(issue);
        unresolved.set(field.id, constraints);
        diagnostics.push(
          createArtifactDiagnostic({
            state: "unsupported",
            code: "FIELD_UNSUPPORTED",
            detailCode: "FIELD_UNSUPPORTED",
            reason: "unsupported",
            path,
            message,
            actual: createFieldEvidence(path, rawValue),
            recovery: [{ action: "retry", path, hint: "Resubmit the field with supported content." }],
          }),
        );
        continue;
      }
      const normalizedValue = normalization.value;
      const violations = validateField(field, normalizedValue, path, effectiveFieldConstraints(contract, field));
      if (violations.length === 0) {
        acceptedFields.push(path);
        values[field.id] = normalizedValue;
        continue;
      }

      const first = violations[0] as SemanticViolation;
      const reason = violationReason(first.code);
      const message = partialViolationMessage(first.code);
      const issue: PartialFieldIssue = {
        field: field.id,
        path,
        reason,
        message,
        constraints,
      };
      invalidFields.push(issue);
      unresolved.set(field.id, constraints);
      for (const violation of violations) {
        const detailCode = violation.code === "INPUT_TYPE" ? "FIELD_TYPE_MISMATCH" : "FIELD_CONSTRAINT_VIOLATION";
        diagnostics.push(
          createArtifactDiagnostic({
            state: "invalid",
            code: "FIELD_INVALID",
            detailCode,
            reason: violationReason(violation.code),
            path: pathFromSemanticViolation(violation.path, field.id),
            message: partialViolationMessage(violation.code),
            actual: createFieldEvidence(path, rawValue),
            recovery: [{ action: "replace", path, hint: "Provide a valid value for this field." }],
          }),
        );
      }
    }
  }

  const accepted = acceptedFields.sort(compareStrings);
  const missing = missingFields.sort(comparePartialIssues);
  const invalid = invalidFields.sort(comparePartialIssues);
  const projectedConstraints = [...unresolved.values()].sort(compareConstraints);
  const report = createArtifactDiagnosticReport(diagnostics, accepted);
  const complete =
    supplied !== undefined &&
    accepted.length === fields.length &&
    missing.length === 0 &&
    invalid.length === 0 &&
    Object.keys(supplied).length === fields.length;
  return {
    valid: missing.length === 0 && invalid.length === 0 && supplied !== undefined,
    complete,
    artifactKind: contract.artifactKind,
    templateIdentity: contract.templateIdentity,
    identity: {
      artifactKind: contract.artifactKind,
      irVersion: contract.irVersion,
      schemaVersion: contract.schemaVersion,
      templateIdentity: contract.templateIdentity,
    },
    acceptedFields: accepted,
    missingFields: missing,
    invalidFields: invalid,
    values,
    projectedConstraints,
    diagnostics: report,
  };
}

/**
 * Merge a targeted repair into a prior partial result without retaining any
 * process-local state.  `previous` may be a partial validation result or the
 * compact `PartialSemanticRepairContext` returned by an earlier attempt.
 * `patch` may be a bare field map or an envelope containing `fields`/`patch`
 * and an optional identity which is checked against the prior context.
 *
 * A patch is validated before it is merged.  An invalid replacement therefore
 * cannot erase a previously accepted value, while its bounded diagnostic is
 * still returned to the caller for the next retry.
 */
export function repairPartialSemanticInput(
  contractInput: unknown,
  previous: unknown,
  patch?: unknown,
): PartialSemanticRepairResult {
  assertCanonicalContract(contractInput);
  const contract = contractInput;
  const identity = createPartialArtifactIdentity(contract);
  const contextResult = readRepairContext(previous, identity);
  const context = contextResult.context;
  const contextDiagnostics = [...contextResult.diagnostics];
  const contextSemantic = validatePartialSemanticInput(contract, context.values);
  const contextFieldIds = context.acceptedFields
    .map(fieldPathToId)
    .filter((field): field is string => field !== undefined);
  let contextValid = contextResult.valid;
  if (
    contextSemantic.invalidFields.length > 0 ||
    !sameStringSet(contextFieldIds, Object.keys(contextSemantic.values))
  ) {
    contextDiagnostics.push(
      repairDiagnostic("repair.values", "Repair context contains values rejected by the contract."),
    );
    contextValid = false;
  }
  const embeddedPatch =
    patch === undefined && isRecord(previous) && Object.prototype.hasOwnProperty.call(previous, "patch")
      ? previous.patch
      : patch;
  const patchResult = readRepairPatch(embeddedPatch, identity);
  contextDiagnostics.push(...patchResult.diagnostics);

  const accepted = { ...context.values };
  const changedFields: string[] = [];
  const patchFields = patchResult.fields;
  const validatedPatch = validatePartialSemanticInput(contract, patchFields);

  // Only field values accepted by the canonical validator enter candidate
  // state.  This makes retry behavior deterministic even when the caller
  // resubmits a malformed correction for an already accepted field.
  for (const fieldPath of contextValid && patchResult.valid ? validatedPatch.acceptedFields : []) {
    const field = fieldPath.slice("$.fields.".length);
    if (!Object.prototype.hasOwnProperty.call(patchFields, field)) continue;
    if (!sameSemanticValue(accepted[field], patchFields[field])) changedFields.push(field);
    accepted[field] = patchFields[field];
  }

  const partial = validatePartialSemanticInput(contract, accepted);
  const completeValidation = validateSemanticInput(contract, accepted);
  const patchInvalid = validatedPatch.invalidFields.length > 0 || !patchResult.valid;
  const diagnostics = createArtifactDiagnosticReport(
    [
      ...contextDiagnostics,
      // A patch is intentionally sparse: fields omitted from it are not
      // missing repair values.  Carry only patch-local invalid diagnostics;
      // unresolved candidate fields are reported by `partial` below.
      ...validatedPatch.diagnostics.diagnostics.filter((diagnostic) => diagnostic.state === "invalid"),
      ...partial.diagnostics.diagnostics,
    ],
    partial.acceptedFields,
  );
  const valid = contextValid && patchResult.valid && !patchInvalid && completeValidation.valid;
  const complete = valid && completeValidation.valid;
  const normalizedChanged = [...new Set(changedFields)].sort(compareStrings);
  const noOp = normalizedChanged.length === 0;
  const nextContext: PartialSemanticRepairContext = {
    identity,
    acceptedFields: partial.acceptedFields,
    values: partial.values,
  };

  return {
    valid,
    complete,
    artifactKind: contract.artifactKind,
    templateIdentity: contract.templateIdentity,
    identity,
    values: partial.values,
    canonicalValues: completeValidation.values,
    acceptedFields: partial.acceptedFields,
    changedFields: normalizedChanged,
    noOp,
    context: nextContext,
    missingFields: partial.missingFields,
    invalidFields: [...validatedPatch.invalidFields, ...partial.invalidFields].sort(comparePartialIssues),
    projectedConstraints: partial.projectedConstraints,
    diagnostics,
    partial,
  };
}

/** Terminology alias for callers that describe the operation as a merge. */
export const mergePartialSemanticInput = repairPartialSemanticInput;

/** Build a transport-safe context from a partial validation result. */
export function createPartialSemanticRepairContext(
  result: PartialSemanticValidationResult,
): PartialSemanticRepairContext {
  return {
    identity: result.identity,
    acceptedFields: [...result.acceptedFields].sort(compareStrings),
    values: Object.fromEntries(
      Object.keys(result.values)
        .sort(compareStrings)
        .map((field) => [field, result.values[field]]),
    ),
  };
}

function createPartialArtifactIdentity(contract: CanonicalContract): PartialArtifactIdentity {
  return {
    artifactKind: contract.artifactKind,
    irVersion: contract.irVersion,
    schemaVersion: contract.schemaVersion,
    templateIdentity: contract.templateIdentity,
  };
}

interface ContextReadResult {
  readonly context: PartialSemanticRepairContext;
  readonly valid: boolean;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

interface PatchReadResult {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly valid: boolean;
  readonly diagnostics: readonly ArtifactDiagnostic[];
}

function readRepairContext(input: unknown, expected: PartialArtifactIdentity): ContextReadResult {
  const diagnostics: ArtifactDiagnostic[] = [];
  const empty: PartialSemanticRepairContext = { identity: expected, acceptedFields: [], values: {} };
  if (!isRecord(input)) {
    diagnostics.push(repairDiagnostic("repair.context", "Repair context must be an object."));
    return { context: empty, valid: false, diagnostics };
  }
  const source = isRecord(input.context) ? input.context : input;
  const identity = source.identity;
  if (!matchesPartialIdentity(identity, expected)) {
    diagnostics.push(repairDiagnostic("repair.identity", "Repair context does not match the supplied contract."));
  }
  const values = source.values ?? source.acceptedValues ?? source.accepted;
  const acceptedFields = source.acceptedFields;
  if (!isRecord(values)) {
    diagnostics.push(repairDiagnostic("repair.values", "Repair context accepted values must be an object."));
    return { context: empty, valid: false, diagnostics };
  }
  if (acceptedFields !== undefined && (!Array.isArray(acceptedFields) || !acceptedFields.every(isString))) {
    diagnostics.push(repairDiagnostic("repair.acceptedFields", "Repair context accepted fields are invalid."));
  }
  const suppliedFields = Object.keys(values).sort(compareStrings);
  const declaredFields = Array.isArray(acceptedFields)
    ? acceptedFields
        .filter(isString)
        .map(fieldPathToId)
        .filter((field): field is string => field !== undefined)
    : suppliedFields;
  if (new Set(declaredFields).size !== declaredFields.length || !sameStringSet(declaredFields, suppliedFields)) {
    diagnostics.push(
      repairDiagnostic("repair.acceptedFields", "Repair context accepted fields do not match its values."),
    );
  }
  const context: PartialSemanticRepairContext = {
    identity: expected,
    acceptedFields: suppliedFields.map((field) => `$.fields.${field}`),
    values: Object.fromEntries(suppliedFields.map((field) => [field, values[field]])),
  };
  return { context, valid: diagnostics.length === 0, diagnostics };
}

function readRepairPatch(input: unknown, expected: PartialArtifactIdentity): PatchReadResult {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (input === undefined) return { fields: {}, valid: true, diagnostics };
  if (!isRecord(input)) {
    diagnostics.push(repairDiagnostic("repair.patch", "Repair patch must be an object."));
    return { fields: {}, valid: false, diagnostics };
  }
  const patchIdentity = input.identity;
  if (patchIdentity !== undefined && !matchesPartialIdentity(patchIdentity, expected)) {
    diagnostics.push(repairDiagnostic("repair.identity", "Repair patch does not match the supplied contract."));
  }
  let fields: unknown = input;
  if (Object.prototype.hasOwnProperty.call(input, "patch")) fields = input.patch;
  else if (Object.prototype.hasOwnProperty.call(input, "fields")) fields = input.fields;
  if (!isRecord(fields)) {
    diagnostics.push(repairDiagnostic("repair.patch", "Repair patch fields must be an object."));
    return { fields: {}, valid: false, diagnostics };
  }
  // Envelopes are the only form in which identity is allowed.  Bare semantic
  // field maps must not silently smuggle context properties into validation.
  if (fields === input) {
    const envelopeKeys = ["identity", "acceptedFields", "values", "context"];
    const contextKeys = Object.keys(input).filter((key) => envelopeKeys.includes(key));
    if (contextKeys.length > 0) {
      diagnostics.push(repairDiagnostic("repair.patch", "Repair patch envelope must provide fields or patch."));
      return { fields: {}, valid: false, diagnostics };
    }
  }
  return { fields, valid: diagnostics.length === 0, diagnostics };
}

function matchesPartialIdentity(input: unknown, expected: PartialArtifactIdentity): boolean {
  if (!isRecord(input)) return false;
  if (
    input.artifactKind !== expected.artifactKind ||
    input.irVersion !== expected.irVersion ||
    input.schemaVersion !== expected.schemaVersion ||
    !isRecord(input.templateIdentity)
  ) {
    return false;
  }
  const template = input.templateIdentity;
  const expectedTemplate = expected.templateIdentity;
  return (
    template.id === expectedTemplate.id &&
    template.name === expectedTemplate.name &&
    template.path === expectedTemplate.path &&
    template.source === expectedTemplate.source
  );
}

function repairDiagnostic(path: string, message: string): ArtifactDiagnostic {
  return createArtifactDiagnostic({
    state: "invalid",
    code: "FIELD_INVALID",
    detailCode: "FIELD_CONSTRAINT_VIOLATION",
    reason: "constraint",
    path,
    message,
    recovery: [{ action: "repair", path, hint: "Use the identity and accepted values from the prior result." }],
  });
}

function fieldPathToId(path: string): string | undefined {
  if (!path.startsWith("$.fields.")) return undefined;
  const field = path.slice("$.fields.".length);
  return field.length === 0 || field.includes(".") || field.includes("[") ? undefined : field;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Compact, canonical JSON projection for transport between repair attempts. */
export function serializePartialSemanticValidationResult(result: PartialSemanticValidationResult): string {
  const normalized = validatePartialResultShape(result);
  return JSON.stringify({
    valid: normalized.valid,
    complete: normalized.complete,
    artifactKind: normalized.artifactKind,
    templateIdentity: normalized.templateIdentity,
    identity: normalized.identity,
    acceptedFields: normalized.acceptedFields,
    missingFields: normalized.missingFields,
    invalidFields: normalized.invalidFields,
    values: Object.fromEntries(
      Object.keys(normalized.values)
        .sort(compareStrings)
        .map((key) => [key, normalized.values[key]]),
    ),
    projectedConstraints: normalized.projectedConstraints,
    diagnostics: JSON.parse(serializeArtifactDiagnosticReport(normalized.diagnostics)),
  });
}

/** Terminology aliases for callers that treat validation as classification. */
export const classifyPartialSemanticInput = validatePartialSemanticInput;

export function assertSemanticInput(contractInput: unknown, input: unknown): Readonly<Record<string, unknown>> {
  const result = validateSemanticInput(contractInput, input);
  if (!result.valid) throw new SemanticValidationError(result.violations);
  return result.values;
}

function flattenFields(contract: CanonicalContract): readonly CanonicalField[] {
  return contract.sections.flatMap((section) => [...section.fields]);
}

function projectPartialFieldConstraints(
  contract: CanonicalContract,
  field: CanonicalField,
): PartialFieldConstraintProjection {
  const constraints = effectiveFieldConstraints(contract, field);
  return {
    field: field.id,
    path: partialFieldPath(field.id),
    type: field.type,
    required: constraints.required,
    ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }),
    ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
    ...(constraints.pattern === undefined ? {} : { pattern: constraints.pattern }),
    ...(constraints.linkedIssue ? { linkedIssue: true as const } : {}),
    ...(constraints.minItems === undefined ? {} : { minItems: constraints.minItems }),
    ...(constraints.maxItems === undefined ? {} : { maxItems: constraints.maxItems }),
    uniqueItems: constraints.uniqueItems,
    ...(constraints.allowedValues === undefined ? {} : { allowedValues: [...constraints.allowedValues] }),
    ...(constraints.requiredItems.length === 0 ? {} : { requiredItems: [...constraints.requiredItems] }),
    ...(constraints.checklistRequireComplete ? { checklistRequireComplete: true as const } : {}),
  };
}

function partialFieldPath(field: string): string {
  return `$.fields.${field}`;
}

function pathFromSemanticViolation(path: string, field: string): string {
  if (path === `$.${field}`) return partialFieldPath(field);
  if (path.startsWith(`$.${field}`)) return `$.fields.${path.slice(`$.${field}`.length)}`;
  return partialFieldPath(field);
}

function violationReason(code: SemanticViolationCode): ArtifactDiagnosticReason {
  return code === "INPUT_TYPE" ? "type" : "constraint";
}

/** SemanticViolation messages may echo user values; diagnostics must not. */
function partialViolationMessage(code: SemanticViolationCode): string {
  return code === "INPUT_TYPE" ? "Field value has an unsupported type." : "Field value violates a compiled constraint.";
}

function comparePartialIssues(left: PartialFieldIssue, right: PartialFieldIssue): number {
  return compareStrings(left.path, right.path);
}

function compareConstraints(left: PartialFieldConstraintProjection, right: PartialFieldConstraintProjection): number {
  return compareStrings(left.path, right.path);
}

function validatePartialResultShape(result: PartialSemanticValidationResult): PartialSemanticValidationResult {
  const diagnostics = createArtifactDiagnosticReport(result.diagnostics.diagnostics, result.acceptedFields);
  return {
    ...result,
    acceptedFields: [...new Set(result.acceptedFields)].sort(compareStrings),
    missingFields: [...result.missingFields].sort(comparePartialIssues),
    invalidFields: [...result.invalidFields].sort(comparePartialIssues),
    projectedConstraints: [...result.projectedConstraints].sort(compareConstraints),
    diagnostics,
  };
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
