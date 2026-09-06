/**
 * Pure Core projection and planning for a materialized Semantic Artifact
 * whose kind is `branch`.
 *
 * Branch identity and source are already materialized by Core.  This module
 * only validates the transport boundary and projects those values into a
 * desired Git ref plus a declarative mutation plan.  It never derives a
 * branch name from type, Issue, or slug and it never performs GitHub I/O.
 */

import { createHash } from "node:crypto";
import { normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";

export const SEMANTIC_BRANCH_PROJECTION_VERSION = "1" as const;
export type SemanticBranchProjectionVersion = typeof SEMANTIC_BRANCH_PROJECTION_VERSION;

export const SEMANTIC_BRANCH_MUTATION_PLAN_VERSION = "1" as const;
export type SemanticBranchMutationPlanVersion = typeof SEMANTIC_BRANCH_MUTATION_PLAN_VERSION;

/** Input to the representation-independent Branch projector. */
export interface SemanticBranchProjectionInput {
  readonly artifact: SemanticArtifact;
}

/** Desired Git ref state projected from one validated Branch Semantic Artifact. */
export interface DesiredBranchProjection {
  readonly version: SemanticBranchProjectionVersion;
  readonly kind: "branch";
  /** The desired branch Git ref name, sourced from `artifact.values.name`. */
  readonly name: string;
  /** The desired source/base Git ref, sourced from `artifact.values.source`. */
  readonly source: string;
  readonly provenance: ArtifactContractProvenance;
  readonly generation: ArtifactContractProvenance;
}

export type SemanticBranchPrecondition =
  | {
      readonly kind: "GOVERNANCE_GENERATION_MATCH";
      readonly generation: ArtifactContractProvenance;
    }
  | {
      readonly kind: "BRANCH_TARGET_ABSENT";
      readonly name: string;
    };

export type SemanticBranchEffect = {
  readonly kind: "CREATE_BRANCH";
  readonly desired: DesiredBranchProjection;
};

export interface SemanticBranchArtifactIdentity {
  readonly version: SemanticArtifact["version"];
  readonly effectiveContractVersion: SemanticArtifact["effectiveContractVersion"];
  readonly artifactContractVersion: SemanticArtifact["artifactContractVersion"];
  readonly kind: "branch";
  readonly id: string;
  /** SHA-256 of the canonical validated semantic artifact payload. */
  readonly digest: string;
}

/** Versioned, transport-independent desired Branch mutation plan. */
export interface SemanticBranchMutationPlan {
  readonly version: SemanticBranchMutationPlanVersion;
  readonly kind: "branch";
  readonly artifact: SemanticBranchArtifactIdentity;
  /** Immutable governance identity used to produce and admit the plan. */
  readonly provenance: ArtifactContractProvenance;
  readonly generation: ArtifactContractProvenance;
  readonly desired: DesiredBranchProjection;
  readonly preconditions: readonly SemanticBranchPrecondition[];
  readonly effects: readonly SemanticBranchEffect[];
}

export type SemanticBranchProjectionViolationCode =
  | "PROJECTION_INPUT_INVALID"
  | "PROJECTION_INPUT_UNKNOWN_PROPERTY"
  | "SEMANTIC_ARTIFACT_INVALID"
  | "SEMANTIC_ARTIFACT_INCOMPATIBLE"
  | "SEMANTIC_ARTIFACT_PROVENANCE_INVALID"
  | "SEMANTIC_ARTIFACT_VALUE_INVALID"
  | "MUTATION_PLAN_INVALID";

export interface SemanticBranchProjectionViolation {
  readonly code: SemanticBranchProjectionViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface SemanticBranchProjectionResult {
  readonly valid: boolean;
  readonly projection?: DesiredBranchProjection;
  readonly violations: readonly SemanticBranchProjectionViolation[];
}

export interface SemanticBranchMutationPlanResult {
  readonly valid: boolean;
  readonly plan?: SemanticBranchMutationPlan;
  readonly violations: readonly SemanticBranchProjectionViolation[];
}

export class SemanticBranchProjectionError extends Error {
  readonly violations: readonly SemanticBranchProjectionViolation[];

  constructor(violations: readonly SemanticBranchProjectionViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "SemanticBranchProjectionError";
    this.violations = violations;
  }
}

type RecordValue = Record<string, unknown>;

const ARTIFACT_KEYS = new Set([
  "version",
  "effectiveContractVersion",
  "artifactContractVersion",
  "kind",
  "id",
  "values",
  "fields",
  "provenance",
  "generation",
]);
const PROJECTION_INPUT_KEYS = new Set(["artifact"]);
const BRANCH_PROPERTY_NAMES = new Set(["name", "source", "type", "issue", "slug"]);
const PLAN_ARTIFACT_IDENTITY_KEYS = new Set([
  "version",
  "effectiveContractVersion",
  "artifactContractVersion",
  "kind",
  "id",
  "digest",
]);
const DESIRED_PROJECTION_KEYS = new Set(["version", "kind", "name", "source", "provenance", "generation"]);
const GOVERNANCE_GENERATION_MATCH_KEYS = new Set(["kind", "generation"]);
const BRANCH_TARGET_ABSENT_KEYS = new Set(["kind", "name"]);
const PLAN_EFFECT_KEYS = new Set(["kind", "desired"]);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function addViolation(
  violations: SemanticBranchProjectionViolation[],
  code: SemanticBranchProjectionViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function unknownProperties(
  input: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: SemanticBranchProjectionViolation[],
  code: SemanticBranchProjectionViolationCode = "PROJECTION_INPUT_UNKNOWN_PROPERTY",
): void {
  for (const key of Object.keys(input).sort(compareStrings)) {
    if (!allowed.has(key)) addViolation(violations, code, `${path}.${key}`, `Property "${key}" is not supported.`);
  }
}

/** Stable JSON for Core values; object insertion order never affects output. */
function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers are not supported.");
    return String(value);
  }
  if (typeof value === "undefined") throw new TypeError("Undefined values are not supported.");
  if (typeof value !== "object") throw new TypeError("Only JSON-compatible values are supported.");
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
  } else if (isRecord(value)) {
    result = `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
      .join(",")}}`;
  } else {
    throw new TypeError("Only plain JSON objects are supported.");
  }
  stack.delete(value);
  return result;
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) clone[key] = cloneImmutable(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function invalidResult(violations: readonly SemanticBranchProjectionViolation[]): SemanticBranchProjectionResult {
  return { valid: false, violations };
}

function invalidPlanResult(violations: readonly SemanticBranchProjectionViolation[]): SemanticBranchMutationPlanResult {
  return { valid: false, violations };
}

function requiredString(
  value: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
  maxLength = 255,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be a bounded non-empty string.");
    return undefined;
  }
  return value;
}

function validateProvenance(
  value: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
): ArtifactContractProvenance | undefined {
  if (!isRecord(value) || value.authority !== "repository-default-branch") {
    addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is invalid.");
    return undefined;
  }
  if (!isRecord(value.repository) || !isRecord(value.source)) {
    addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is invalid.");
    return undefined;
  }
  const repository = value.repository;
  const source = value.source;
  unknownProperties(
    value,
    new Set(["authority", "repository", "ref", "treeSha", "source"]),
    path,
    violations,
    "SEMANTIC_ARTIFACT_PROVENANCE_INVALID",
  );
  unknownProperties(
    repository,
    new Set(["host", "owner", "name", "nameWithOwner", "repositoryId"]),
    `${path}.repository`,
    violations,
    "SEMANTIC_ARTIFACT_PROVENANCE_INVALID",
  );
  unknownProperties(
    source,
    new Set(["path", "ref", "sha", "digest"]),
    `${path}.source`,
    violations,
    "SEMANTIC_ARTIFACT_PROVENANCE_INVALID",
  );
  if (
    ["host", "owner", "name", "nameWithOwner"].some(
      (key) => typeof repository[key] !== "string" || (repository[key] as string).length === 0,
    )
  ) {
    addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is invalid.");
  }
  if (
    repository.repositoryId !== undefined &&
    (typeof repository.repositoryId !== "string" || !/^[1-9][0-9]{0,19}$/u.test(repository.repositoryId))
  ) {
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_PROVENANCE_INVALID",
      `${path}.repository.repositoryId`,
      "Repository identity is invalid.",
    );
  }
  if (
    typeof value.ref !== "string" ||
    value.ref.length === 0 ||
    typeof value.treeSha !== "string" ||
    value.treeSha.length === 0 ||
    ["path", "ref", "sha", "digest"].some(
      (key) => typeof source[key] !== "string" || (source[key] as string).length === 0,
    )
  ) {
    addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is invalid.");
  }
  try {
    stableSerialize(value);
  } catch {
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_PROVENANCE_INVALID",
      path,
      "Governance provenance is not JSON-compatible.",
    );
    return undefined;
  }
  return violations.some((violation) => violation.path === path || violation.path.startsWith(`${path}.`))
    ? undefined
    : (value as unknown as ArtifactContractProvenance);
}

function validateIssueReference(
  value: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "IssueReference is invalid.");
    return undefined;
  }
  return result.reference;
}

interface ValidatedSemanticBranch {
  readonly artifact: SemanticArtifact;
  readonly name: string;
  readonly source: string;
  readonly provenance: ArtifactContractProvenance;
}

interface SemanticArtifactValidationResult {
  readonly artifact?: ValidatedSemanticBranch;
  readonly violations: readonly SemanticBranchProjectionViolation[];
}

function validateSemanticArtifact(input: unknown): SemanticArtifactValidationResult {
  const violations: SemanticBranchProjectionViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "SEMANTIC_ARTIFACT_INVALID", "$.artifact", "Semantic Artifact must be an object.");
    return { violations };
  }
  unknownProperties(input, ARTIFACT_KEYS, "$.artifact", violations, "SEMANTIC_ARTIFACT_INVALID");
  if (input.version !== "1")
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_INCOMPATIBLE",
      "$.artifact.version",
      "Semantic Artifact version is unsupported.",
    );
  if (input.effectiveContractVersion !== "1")
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_INCOMPATIBLE",
      "$.artifact.effectiveContractVersion",
      "Effective Contract version is unsupported.",
    );
  if (input.artifactContractVersion !== "1")
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_INCOMPATIBLE",
      "$.artifact.artifactContractVersion",
      "Artifact Contract version is unsupported.",
    );
  if (input.kind !== "branch")
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_INCOMPATIBLE",
      "$.artifact.kind",
      "A branch Semantic Artifact is required.",
    );
  const id = requiredString(input.id, "$.artifact.id", violations, 512);
  if (!isRecord(input.values))
    addViolation(violations, "SEMANTIC_ARTIFACT_INVALID", "$.artifact.values", "Semantic values must be an object.");
  if (!isRecord(input.fields))
    addViolation(violations, "SEMANTIC_ARTIFACT_INVALID", "$.artifact.fields", "Semantic fields must be an object.");
  const provenance = validateProvenance(input.provenance, "$.artifact.provenance", violations);
  const generation = validateProvenance(input.generation, "$.artifact.generation", violations);
  if (
    provenance !== undefined &&
    generation !== undefined &&
    stableSerialize(provenance) !== stableSerialize(generation)
  ) {
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_PROVENANCE_INVALID",
      "$.artifact.generation",
      "Generation must equal provenance.",
    );
  }
  const values = isRecord(input.values) ? input.values : {};
  const fields = isRecord(input.fields) ? input.fields : {};
  unknownProperties(values, BRANCH_PROPERTY_NAMES, "$.artifact.values", violations, "SEMANTIC_ARTIFACT_VALUE_INVALID");
  if (Object.keys(fields).length > 0) {
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_INCOMPATIBLE",
      "$.artifact.fields",
      "Branch Semantic Artifacts do not support body fields.",
    );
  }
  const name = requiredString(values.name, "$.artifact.values.name", violations);
  const source = requiredString(values.source, "$.artifact.values.source", violations);
  for (const key of ["type", "slug"] as const) {
    if (hasOwn(values, key)) requiredString(values[key], `$.artifact.values.${key}`, violations, 255);
  }
  if (hasOwn(values, "issue")) validateIssueReference(values.issue, "$.artifact.values.issue", violations);

  if (
    violations.length > 0 ||
    id === undefined ||
    name === undefined ||
    source === undefined ||
    provenance === undefined ||
    !isRecord(input.fields)
  ) {
    return { violations };
  }
  return { artifact: { artifact: input as unknown as SemanticArtifact, name, source, provenance }, violations: [] };
}

function projectionRequest(input: unknown, violations: SemanticBranchProjectionViolation[]): unknown | undefined {
  if (!isRecord(input)) {
    addViolation(violations, "PROJECTION_INPUT_INVALID", "$", "Projection input must be an object.");
    return undefined;
  }
  // The wrapper form is the public machine contract.  Accepting a direct
  // artifact as a convenience keeps this Core helper representation-neutral;
  // both forms still pass through the same artifact validation boundary.
  if (hasOwn(input, "artifact")) {
    unknownProperties(input, PROJECTION_INPUT_KEYS, "$", violations);
    if (!hasOwn(input, "artifact"))
      addViolation(violations, "PROJECTION_INPUT_INVALID", "$.artifact", "Semantic Artifact is required.");
    return input.artifact;
  }
  return input;
}

function buildProjection(input: unknown): SemanticBranchProjectionResult {
  const violations: SemanticBranchProjectionViolation[] = [];
  const artifactInput = projectionRequest(input, violations);
  if (artifactInput === undefined) return invalidResult(violations);
  const artifactResult = validateSemanticArtifact(artifactInput);
  violations.push(...artifactResult.violations);
  const artifact = artifactResult.artifact;
  if (artifact === undefined || violations.length > 0) return invalidResult(violations);

  // `name` and `source` are already Core-materialized values.  In
  // particular, do not call deriveBranchName or inspect type/issue/slug here:
  // doing so would create a second authority for a derived or caller-supplied
  // branch contract.
  const desired: DesiredBranchProjection = {
    version: SEMANTIC_BRANCH_PROJECTION_VERSION,
    kind: "branch",
    name: artifact.name,
    source: artifact.source,
    provenance: artifact.provenance,
    generation: artifact.provenance,
  };
  return { valid: true, projection: cloneImmutable(desired), violations: [] };
}

/** Project a Branch Semantic Artifact without performing GitHub mutation. */
export function tryProjectSemanticBranch(input: unknown): SemanticBranchProjectionResult {
  return buildProjection(input);
}

/** Throwing projection entry point for Core callers. */
export function projectSemanticBranch(input: unknown): DesiredBranchProjection {
  const result = tryProjectSemanticBranch(input);
  if (!result.valid || result.projection === undefined) throw new SemanticBranchProjectionError(result.violations);
  return result.projection;
}

export const projectSemanticBranchArtifact = projectSemanticBranch;
export const projectBranchSemanticArtifact = projectSemanticBranch;

function artifactDigest(artifact: SemanticArtifact): string {
  const payload = {
    version: artifact.version,
    effectiveContractVersion: artifact.effectiveContractVersion,
    artifactContractVersion: artifact.artifactContractVersion,
    kind: artifact.kind,
    id: artifact.id,
    values: artifact.values,
    fields: artifact.fields,
    provenance: artifact.provenance,
    generation: artifact.generation,
  };
  return createHash("sha256").update(stableSerialize(payload), "utf8").digest("hex");
}

/** Produce a declarative, versioned plan; this function has no GitHub I/O. */
export function tryPlanSemanticBranch(input: unknown): SemanticBranchMutationPlanResult {
  const projectionResult = tryProjectSemanticBranch(input);
  if (!projectionResult.valid || projectionResult.projection === undefined)
    return invalidPlanResult(projectionResult.violations);
  const artifactInput = projectionRequest(input, []);
  if (artifactInput === undefined) {
    return invalidPlanResult([
      { code: "MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan input could not be resolved." },
    ]);
  }
  const artifactResult = validateSemanticArtifact(artifactInput);
  if (artifactResult.artifact === undefined) {
    return invalidPlanResult([
      { code: "MUTATION_PLAN_INVALID", path: "$.artifact", message: "Validated Semantic Artifact is required." },
    ]);
  }
  const generation = cloneImmutable(artifactResult.artifact.provenance);
  const desired = projectionResult.projection;
  const plan: SemanticBranchMutationPlan = {
    version: SEMANTIC_BRANCH_MUTATION_PLAN_VERSION,
    kind: "branch",
    artifact: {
      version: artifactResult.artifact.artifact.version,
      effectiveContractVersion: artifactResult.artifact.artifact.effectiveContractVersion,
      artifactContractVersion: artifactResult.artifact.artifact.artifactContractVersion,
      kind: "branch",
      id: artifactResult.artifact.artifact.id,
      digest: artifactDigest(artifactResult.artifact.artifact),
    },
    provenance: cloneImmutable(artifactResult.artifact.provenance),
    generation,
    desired,
    preconditions: [
      { kind: "GOVERNANCE_GENERATION_MATCH", generation },
      { kind: "BRANCH_TARGET_ABSENT", name: desired.name },
    ],
    effects: [{ kind: "CREATE_BRANCH", desired }],
  };
  return { valid: true, plan: cloneImmutable(plan), violations: [] };
}

export function planSemanticBranch(input: unknown): SemanticBranchMutationPlan {
  const result = tryPlanSemanticBranch(input);
  if (!result.valid || result.plan === undefined) throw new SemanticBranchProjectionError(result.violations);
  return result.plan;
}

export const planSemanticBranchMutation = planSemanticBranch;
export const createSemanticBranchMutationPlan = planSemanticBranch;

function validatePlanArtifactIdentity(
  input: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
): void {
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Artifact identity must be an object.");
    return;
  }
  unknownProperties(input, PLAN_ARTIFACT_IDENTITY_KEYS, path, violations, "MUTATION_PLAN_INVALID");
  if (input.version !== "1")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.version`, "Artifact version is unsupported.");
  if (input.effectiveContractVersion !== "1")
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      `${path}.effectiveContractVersion`,
      "Effective Contract version is unsupported.",
    );
  if (input.artifactContractVersion !== "1")
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      `${path}.artifactContractVersion`,
      "Artifact Contract version is unsupported.",
    );
  if (input.kind !== "branch")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.kind`, "Artifact identity kind is invalid.");
  requiredString(input.id, `${path}.id`, violations, 512);
  if (typeof input.digest !== "string" || !SHA256_HEX_PATTERN.test(input.digest))
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.digest`, "Artifact digest must be a SHA-256 hex value.");
}

function validateDesiredProjectionShape(
  input: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
): void {
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Desired branch projection must be an object.");
    return;
  }
  unknownProperties(input, DESIRED_PROJECTION_KEYS, path, violations, "MUTATION_PLAN_INVALID");
  if (input.version !== SEMANTIC_BRANCH_PROJECTION_VERSION)
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.version`, "Desired projection version is unsupported.");
  if (input.kind !== "branch")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.kind`, "Desired projection kind is invalid.");
  requiredString(input.name, `${path}.name`, violations);
  requiredString(input.source, `${path}.source`, violations);
  const provenance = input.provenance;
  const generation = input.generation;
  if (!isValidProvenance(provenance))
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.provenance`, "Desired provenance is invalid.");
  if (!isValidProvenance(generation))
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.generation`, "Desired generation is invalid.");
  if (
    isValidProvenance(provenance) &&
    isValidProvenance(generation) &&
    stableSerialize(provenance) !== stableSerialize(generation)
  )
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      `${path}.generation`,
      "Desired generation must equal desired provenance.",
    );
}

function isValidProvenance(value: unknown): value is ArtifactContractProvenance {
  if (!isRecord(value) || value.authority !== "repository-default-branch") return false;
  if (!isRecord(value.repository) || !isRecord(value.source)) return false;
  const repository = value.repository;
  const source = value.source;
  return (
    ["host", "owner", "name", "nameWithOwner"].every(
      (key) => typeof repository[key] === "string" && (repository[key] as string).length > 0,
    ) &&
    (repository.repositoryId === undefined ||
      (typeof repository.repositoryId === "string" && /^[1-9][0-9]{0,19}$/u.test(repository.repositoryId))) &&
    typeof value.ref === "string" &&
    value.ref.length > 0 &&
    typeof value.treeSha === "string" &&
    value.treeSha.length > 0 &&
    ["path", "ref", "sha", "digest"].every(
      (key) => typeof source[key] === "string" && (source[key] as string).length > 0,
    )
  );
}

function validatePreconditions(
  input: unknown,
  planGeneration: unknown,
  desired: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
): void {
  if (!Array.isArray(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Preconditions must be an array.");
    return;
  }
  const seenKinds = new Set<string>();
  const requiredKinds = ["GOVERNANCE_GENERATION_MATCH", "BRANCH_TARGET_ABSENT"];
  const desiredName = isRecord(desired) ? desired.name : undefined;
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      addViolation(violations, "MUTATION_PLAN_INVALID", entryPath, "Precondition must be an object.");
      return;
    }
    const kind = entry.kind;
    if (typeof kind !== "string" || !requiredKinds.includes(kind)) {
      addViolation(violations, "MUTATION_PLAN_INVALID", `${entryPath}.kind`, "Precondition kind is unknown.");
      return;
    }
    if (seenKinds.has(kind)) {
      addViolation(violations, "MUTATION_PLAN_INVALID", entryPath, `Duplicate precondition "${kind}".`);
      return;
    }
    seenKinds.add(kind);
    if (kind === "GOVERNANCE_GENERATION_MATCH") {
      unknownProperties(entry, GOVERNANCE_GENERATION_MATCH_KEYS, entryPath, violations, "MUTATION_PLAN_INVALID");
      if (!isValidProvenance(entry.generation)) {
        addViolation(
          violations,
          "MUTATION_PLAN_INVALID",
          `${entryPath}.generation`,
          "Precondition generation is invalid.",
        );
      } else if (
        !isValidProvenance(planGeneration) ||
        stableSerialize(entry.generation) !== stableSerialize(planGeneration)
      ) {
        addViolation(
          violations,
          "MUTATION_PLAN_INVALID",
          `${entryPath}.generation`,
          "Precondition generation must equal plan generation.",
        );
      }
    } else {
      unknownProperties(entry, BRANCH_TARGET_ABSENT_KEYS, entryPath, violations, "MUTATION_PLAN_INVALID");
      const name = requiredString(entry.name, `${entryPath}.name`, violations);
      if (name !== undefined && typeof desiredName === "string" && name !== desiredName)
        addViolation(
          violations,
          "MUTATION_PLAN_INVALID",
          `${entryPath}.name`,
          "Precondition name must equal desired name.",
        );
    }
  });
  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind))
      addViolation(violations, "MUTATION_PLAN_INVALID", path, `Required precondition "${kind}" is missing.`);
  }
}

function validateEffects(
  input: unknown,
  planDesired: unknown,
  path: string,
  violations: SemanticBranchProjectionViolation[],
): void {
  if (!Array.isArray(input) || input.length !== 1) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "A branch plan requires exactly one explicit effect.");
    return;
  }
  const effect = input[0];
  const effectPath = `${path}[0]`;
  if (!isRecord(effect)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", effectPath, "Effect must be an object.");
    return;
  }
  unknownProperties(effect, PLAN_EFFECT_KEYS, effectPath, violations, "MUTATION_PLAN_INVALID");
  if (effect.kind !== "CREATE_BRANCH")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${effectPath}.kind`, "Effect kind is invalid.");
  validateDesiredProjectionShape(effect.desired, `${effectPath}.desired`, violations);
  if (violations.length === 0 && stableSerialize(effect.desired) !== stableSerialize(planDesired)) {
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      `${effectPath}.desired`,
      "Effect desired projection must equal plan desired projection.",
    );
  }
}

/** Validate a transported Branch mutation plan without executing it. */
export function validateSemanticBranchMutationPlan(input: unknown): SemanticBranchMutationPlanResult {
  const violations: SemanticBranchProjectionViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", "$", "Mutation plan must be an object.");
    return invalidPlanResult(violations);
  }
  const required = ["version", "kind", "artifact", "provenance", "generation", "desired", "preconditions", "effects"];
  unknownProperties(input, new Set(required), "$", violations, "MUTATION_PLAN_INVALID");
  if (input.version !== SEMANTIC_BRANCH_MUTATION_PLAN_VERSION)
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.version", "Mutation plan version is unsupported.");
  if (input.kind !== "branch")
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.kind", "Mutation plan kind is invalid.");
  validatePlanArtifactIdentity(input.artifact, "$.artifact", violations);
  if (!isValidProvenance(input.provenance))
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.provenance", "Plan provenance is invalid.");
  if (!isValidProvenance(input.generation))
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.generation", "Plan generation is invalid.");
  if (
    isValidProvenance(input.provenance) &&
    isValidProvenance(input.generation) &&
    stableSerialize(input.provenance) !== stableSerialize(input.generation)
  )
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.generation", "Plan generation must equal provenance.");
  validateDesiredProjectionShape(input.desired, "$.desired", violations);
  if (
    isRecord(input.desired) &&
    isValidProvenance(input.desired.generation) &&
    isValidProvenance(input.generation) &&
    stableSerialize(input.desired.generation) !== stableSerialize(input.generation)
  ) {
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      "$.desired.generation",
      "Desired generation must equal plan generation.",
    );
  }
  validatePreconditions(input.preconditions, input.generation, input.desired, "$.preconditions", violations);
  validateEffects(input.effects, input.desired, "$.effects", violations);
  if (violations.length > 0) return invalidPlanResult(violations);
  return { valid: true, plan: cloneImmutable(input as unknown as SemanticBranchMutationPlan), violations: [] };
}

export function deserializeSemanticBranchMutationPlan(serialized: string): SemanticBranchMutationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new SemanticBranchProjectionError([
      { code: "MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan must be valid JSON." },
    ]);
  }
  const result = validateSemanticBranchMutationPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new SemanticBranchProjectionError(result.violations);
  return result.plan;
}

/** Stable transport representation for the versioned plan. */
export function serializeSemanticBranchMutationPlan(input: unknown): string {
  const result = validateSemanticBranchMutationPlan(input);
  if (!result.valid || result.plan === undefined) throw new SemanticBranchProjectionError(result.violations);
  return stableSerialize(result.plan);
}

export const serializeSemanticBranchPlan = serializeSemanticBranchMutationPlan;
export const parseSemanticBranchMutationPlan = deserializeSemanticBranchMutationPlan;
export const parseSemanticBranchPlan = deserializeSemanticBranchMutationPlan;

// Naming aliases keep the public surface parallel with the PR projection
// module while retaining the explicit Branch terminology in the canonical API.
export type DesiredSemanticBranchProjection = DesiredBranchProjection;
export type SemanticBranchPlan = SemanticBranchMutationPlan;
