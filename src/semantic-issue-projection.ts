/**
 * Pure Core projection and planning for a materialized Semantic Artifact
 * whose kind is `issue`.
 *
 * The Semantic Artifact is the only semantic authority in this module. In
 * particular, title, metadata, body fields, parent, and dependsOn are read
 * from the artifact and cannot be supplied as projection-time overrides. The
 * module does not know a GitHub transport and never performs a mutation.
 */

import { createHash } from "node:crypto";
import { escapeMarkdownValue, renderIssueDependencyMarker } from "./artifact.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import type { ArtifactContractProvenance } from "./contract/ir.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";

export const SEMANTIC_ISSUE_PROJECTION_VERSION = "1" as const;
export type SemanticIssueProjectionVersion = typeof SEMANTIC_ISSUE_PROJECTION_VERSION;

export const SEMANTIC_ISSUE_MUTATION_PLAN_VERSION = "1" as const;
export type SemanticIssueMutationPlanVersion = typeof SEMANTIC_ISSUE_MUTATION_PLAN_VERSION;

/** Capability identifiers understood by the first Issue projection slice. */
export const GITHUB_ISSUE_PROJECTION_CAPABILITIES = Object.freeze({
  nativeParentRelation: "github.issue.parent.native",
  /** GitHub names the semantic `dependsOn` edge `blocked_by`. */
  nativeBlockedByRelation: "github.issue.blocked-by.native",
  /** Semantic spelling retained alongside the GitHub endpoint spelling. */
  nativeDependsOnRelation: "github.issue.blocked-by.native",
  bodyRelationFallback: "github.issue.relations.body-fallback",
} as const);

/** Short alias retained for callers that name the set by its projection role. */
export const SEMANTIC_ISSUE_CAPABILITIES = GITHUB_ISSUE_PROJECTION_CAPABILITIES;
export type GitHubIssueProjectionCapability =
  (typeof GITHUB_ISSUE_PROJECTION_CAPABILITIES)[keyof typeof GITHUB_ISSUE_PROJECTION_CAPABILITIES];

/**
 * Array capabilities are the transport-neutral form used by Effective
 * Contracts. The object form is a small convenience for Core tests and
 * adapters; it is normalized to the same immutable capability array.
 */
export interface GitHubIssueProjectionCapabilityFlags {
  readonly nativeParentRelation?: boolean;
  readonly nativeDependsOnRelation?: boolean;
  readonly bodyRelationFallback?: boolean;
  /** Compatibility spellings for adapters naming the GitHub endpoint. */
  readonly nativeParent?: boolean;
  readonly nativeDependsOn?: boolean;
  readonly nativeBlockedByRelation?: boolean;
}

export type GitHubIssueProjectionCapabilities = readonly string[] | GitHubIssueProjectionCapabilityFlags;

export interface SemanticIssueProjectionInput {
  readonly artifact: SemanticArtifact;
  readonly capabilities: GitHubIssueProjectionCapabilities;
}

export type SemanticIssueProjectionRepresentation = "none" | "native" | "body-fallback";

export interface DesiredIssueParentRelationProjection {
  readonly relation: "parent";
  /** The semantic parent Issue reference, omitted when no parent is set. */
  readonly reference?: IssueReference;
  /** The strongest declared GitHub representation selected by Core. */
  readonly representation: SemanticIssueProjectionRepresentation;
}

export interface DesiredIssueDependsOnRelationProjection {
  readonly relation: "dependsOn";
  /** Semantic Issue references retained in the desired projection. */
  readonly references: readonly IssueReference[];
  /** The strongest declared GitHub representation selected by Core. */
  readonly representation: SemanticIssueProjectionRepresentation;
}

export type DesiredIssueRelationProjection =
  DesiredIssueParentRelationProjection | DesiredIssueDependsOnRelationProjection;

export interface DesiredIssueMetadataProjection {
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone?: string;
}

export interface DesiredIssueProjection {
  readonly version: SemanticIssueProjectionVersion;
  readonly kind: "issue";
  readonly title: string;
  readonly body: string;
  readonly metadata: DesiredIssueMetadataProjection;
  readonly relations: Readonly<{
    readonly parent: DesiredIssueParentRelationProjection;
    readonly dependsOn: DesiredIssueDependsOnRelationProjection;
  }>;
  readonly provenance: ArtifactContractProvenance;
  readonly generation: ArtifactContractProvenance;
}

export type SemanticIssuePrecondition = {
  readonly kind: "GOVERNANCE_GENERATION_MATCH";
  readonly generation: ArtifactContractProvenance;
};

export type SemanticIssueEffect = {
  readonly kind: "CREATE_ISSUE";
  readonly desired: DesiredIssueProjection;
};

export interface SemanticIssueArtifactIdentity {
  readonly version: SemanticArtifact["version"];
  readonly effectiveContractVersion: SemanticArtifact["effectiveContractVersion"];
  readonly artifactContractVersion: SemanticArtifact["artifactContractVersion"];
  readonly kind: "issue";
  readonly id: string;
  /** SHA-256 of the canonical validated semantic artifact payload. */
  readonly digest: string;
}

export interface SemanticIssueMutationPlan {
  readonly version: SemanticIssueMutationPlanVersion;
  readonly kind: "issue";
  readonly artifact: SemanticIssueArtifactIdentity;
  /** Immutable governance identity used to produce and admit the plan. */
  readonly provenance: ArtifactContractProvenance;
  readonly generation: ArtifactContractProvenance;
  readonly capabilities: readonly string[];
  readonly desired: DesiredIssueProjection;
  readonly preconditions: readonly SemanticIssuePrecondition[];
  readonly effects: readonly SemanticIssueEffect[];
}

export type SemanticIssueProjectionViolationCode =
  | "PROJECTION_INPUT_INVALID"
  | "PROJECTION_INPUT_UNKNOWN_PROPERTY"
  | "SEMANTIC_ARTIFACT_INVALID"
  | "SEMANTIC_ARTIFACT_INCOMPATIBLE"
  | "SEMANTIC_ARTIFACT_PROVENANCE_INVALID"
  | "SEMANTIC_ARTIFACT_VALUE_INVALID"
  | "CAPABILITIES_INVALID"
  | "RELATION_UNREPRESENTABLE"
  | "PROJECTION_BODY_INVALID"
  | "MUTATION_PLAN_INVALID";

export interface SemanticIssueProjectionViolation {
  readonly code: SemanticIssueProjectionViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface SemanticIssueProjectionResult {
  readonly valid: boolean;
  readonly projection?: DesiredIssueProjection;
  readonly violations: readonly SemanticIssueProjectionViolation[];
}

export interface SemanticIssueMutationPlanResult {
  readonly valid: boolean;
  readonly plan?: SemanticIssueMutationPlan;
  readonly violations: readonly SemanticIssueProjectionViolation[];
}

export class SemanticIssueProjectionError extends Error {
  readonly violations: readonly SemanticIssueProjectionViolation[];

  constructor(violations: readonly SemanticIssueProjectionViolation[]) {
    super(violations.map((violation) => `${violation.path}: ${violation.message}`).join("\n"));
    this.name = "SemanticIssueProjectionError";
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
const PROJECTION_INPUT_KEYS = new Set(["artifact", "capabilities"]);
const CAPABILITY_FLAG_KEYS = new Set([
  "nativeParentRelation",
  "nativeDependsOnRelation",
  "bodyRelationFallback",
  "nativeParent",
  "nativeDependsOn",
  "nativeBlockedByRelation",
]);
const ISSUE_PROPERTY_NAMES = new Set(["title", "type", "labels", "assignees", "milestone", "parent", "dependsOn"]);
const PLAN_ARTIFACT_IDENTITY_KEYS = new Set([
  "version",
  "effectiveContractVersion",
  "artifactContractVersion",
  "kind",
  "id",
  "digest",
]);
const DESIRED_PROJECTION_KEYS = new Set([
  "version",
  "kind",
  "title",
  "body",
  "metadata",
  "relations",
  "provenance",
  "generation",
]);
const DESIRED_METADATA_KEYS = new Set(["labels", "assignees", "milestone"]);
const DESIRED_RELATIONS_KEYS = new Set(["parent", "dependsOn"]);
const DESIRED_PARENT_RELATION_KEYS = new Set(["relation", "reference", "representation"]);
const DESIRED_DEPENDS_ON_RELATION_KEYS = new Set(["relation", "references", "representation"]);
const RELATION_REPRESENTATIONS = new Set<SemanticIssueProjectionRepresentation>(["none", "native", "body-fallback"]);
const GOVERNANCE_GENERATION_MATCH_KEYS = new Set(["kind", "generation"]);
const PLAN_EFFECT_KEYS = new Set(["kind", "desired"]);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

const CAPABILITY_ALIASES = {
  nativeParent: new Set([
    GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation,
    "github.issue.parent.native",
    "issue.parent.native",
  ]),
  nativeDependsOn: new Set([
    GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation,
    GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeBlockedByRelation,
    "github.issue.blocked-by.native",
    "github.issue.blocked_by.native",
    "github.issue.dependencies.native",
    "issue.depends-on.native",
  ]),
  fallback: new Set([
    GITHUB_ISSUE_PROJECTION_CAPABILITIES.bodyRelationFallback,
    "github.issue.relations.body-fallback",
    "github.issue.parent.body-fallback",
    "github.issue.depends-on.body-fallback",
    "issue.relations.body-fallback",
  ]),
} as const;

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
  violations: SemanticIssueProjectionViolation[],
  code: SemanticIssueProjectionViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function unknownProperties(
  input: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  violations: SemanticIssueProjectionViolation[],
  code: SemanticIssueProjectionViolationCode = "PROJECTION_INPUT_UNKNOWN_PROPERTY",
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

function invalidResult(violations: readonly SemanticIssueProjectionViolation[]): SemanticIssueProjectionResult {
  return { valid: false, violations };
}

function invalidPlanResult(violations: readonly SemanticIssueProjectionViolation[]): SemanticIssueMutationPlanResult {
  return { valid: false, violations };
}

function requiredString(
  value: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
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

function nonEmptyStringArray(
  value: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be an array of strings.");
    return undefined;
  }
  const values: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const parsed = requiredString(entry, `${path}[${index}]`, violations, 512);
    if (parsed === undefined) return;
    if (seen.has(parsed)) {
      addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", `${path}[${index}]`, "Values must be unique.");
      return;
    }
    seen.add(parsed);
    values.push(parsed);
  });
  return values;
}

function provenanceIsValid(value: unknown): value is ArtifactContractProvenance {
  if (!isRecord(value) || value.authority !== "repository-default-branch") return false;
  if (!isRecord(value.repository) || !isRecord(value.source)) return false;
  const repository = value.repository;
  const source = value.source;
  if (
    ["host", "owner", "name", "nameWithOwner"].some(
      (key) => typeof repository[key] !== "string" || (repository[key] as string).length === 0,
    )
  ) {
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
    ["path", "ref", "sha", "digest"].every(
      (key) => typeof source[key] === "string" && (source[key] as string).length > 0,
    )
  );
}

function validateProvenance(
  value: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): ArtifactContractProvenance | undefined {
  if (!provenanceIsValid(value)) {
    addViolation(violations, "SEMANTIC_ARTIFACT_PROVENANCE_INVALID", path, "Governance provenance is invalid.");
    return undefined;
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
  return value;
}

function normalizeCapabilities(
  input: unknown,
  violations: SemanticIssueProjectionViolation[],
): readonly string[] | undefined {
  const values: string[] = [];
  if (Array.isArray(input)) {
    input.forEach((entry, index) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        addViolation(
          violations,
          "CAPABILITIES_INVALID",
          `$.capabilities[${index}]`,
          "Capability must be a non-empty string.",
        );
        return;
      }
      values.push(entry);
    });
  } else if (isRecord(input)) {
    unknownProperties(input, CAPABILITY_FLAG_KEYS, "$.capabilities", violations, "CAPABILITIES_INVALID");
    for (const key of [...CAPABILITY_FLAG_KEYS].sort(compareStrings)) {
      if (hasOwn(input, key) && typeof input[key] !== "boolean") {
        addViolation(violations, "CAPABILITIES_INVALID", `$.capabilities.${key}`, "Capability flag must be boolean.");
      }
    }
    if (input.nativeParentRelation === true || input.nativeParent === true)
      values.push(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation);
    if (
      input.nativeDependsOnRelation === true ||
      input.nativeDependsOn === true ||
      input.nativeBlockedByRelation === true
    )
      values.push(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation);
    if (input.bodyRelationFallback === true) values.push(GITHUB_ISSUE_PROJECTION_CAPABILITIES.bodyRelationFallback);
  } else {
    addViolation(
      violations,
      "CAPABILITIES_INVALID",
      "$.capabilities",
      "Capabilities must be an array or flags object.",
    );
    return undefined;
  }
  return [...new Set(values)].sort(compareStrings);
}

function hasCapability(capabilities: readonly string[], kind: keyof typeof CAPABILITY_ALIASES): boolean {
  const aliases = CAPABILITY_ALIASES[kind];
  return capabilities.some((capability) => aliases.has(capability));
}

function validateJsonValue(
  value: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
  stack = new WeakSet<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be JSON-compatible.");
    return;
  }
  if (stack.has(value)) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must not contain cycles.");
    return;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "Value must be a plain JSON value.");
    return;
  }
  stack.add(value);
  if (Array.isArray(value))
    value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, violations, stack));
  else Object.keys(value).forEach((key) => validateJsonValue(value[key], `${path}.${key}`, violations, stack));
  stack.delete(value);
}

function normalizeParent(
  value: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", path, "IssueReference is invalid.");
    return undefined;
  }
  return result.reference;
}

function normalizeReferences(
  value: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): readonly IssueReference[] | undefined {
  if (!Array.isArray(value)) {
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_VALUE_INVALID",
      path,
      "dependsOn must be an array of IssueReference values.",
    );
    return undefined;
  }
  const references: IssueReference[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const result = normalizeIssueReference(entry, `${path}[${index}]`);
    if (!result.valid || result.reference === undefined) {
      addViolation(violations, "SEMANTIC_ARTIFACT_VALUE_INVALID", `${path}[${index}]`, "IssueReference is invalid.");
      return;
    }
    const key = issueReferenceKey(result.reference);
    if (seen.has(key)) {
      addViolation(
        violations,
        "SEMANTIC_ARTIFACT_VALUE_INVALID",
        `${path}[${index}]`,
        "Issue references must be unique.",
      );
      return;
    }
    seen.add(key);
    references.push(result.reference);
  });
  return references.sort((left, right) => compareStrings(issueReferenceKey(left), issueReferenceKey(right)));
}

interface ValidatedSemanticIssue {
  readonly artifact: SemanticArtifact;
  readonly title: string;
  readonly references: {
    readonly parent?: IssueReference;
    readonly dependsOn: readonly IssueReference[];
  };
  readonly metadata: DesiredIssueMetadataProjection;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly provenance: ArtifactContractProvenance;
}

interface SemanticArtifactValidationResult {
  readonly artifact?: ValidatedSemanticIssue;
  readonly violations: readonly SemanticIssueProjectionViolation[];
}

function validateSemanticArtifact(input: unknown): SemanticArtifactValidationResult {
  const violations: SemanticIssueProjectionViolation[] = [];
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
  if (input.kind !== "issue")
    addViolation(
      violations,
      "SEMANTIC_ARTIFACT_INCOMPATIBLE",
      "$.artifact.kind",
      "An issue Semantic Artifact is required.",
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
  unknownProperties(values, ISSUE_PROPERTY_NAMES, "$.artifact.values", violations, "SEMANTIC_ARTIFACT_VALUE_INVALID");
  for (const [key, value] of Object.entries(fields)) validateJsonValue(value, `$.artifact.fields.${key}`, violations);

  const title = requiredString(values.title, "$.artifact.values.title", violations);
  let parent: IssueReference | undefined;
  if (hasOwn(values, "parent")) parent = normalizeParent(values.parent, "$.artifact.values.parent", violations);
  let dependsOn: readonly IssueReference[] = [];
  if (hasOwn(values, "dependsOn")) {
    const parsed = normalizeReferences(values.dependsOn, "$.artifact.values.dependsOn", violations);
    if (parsed !== undefined) dependsOn = parsed;
  }
  const metadata: Record<string, unknown> = {};
  for (const key of ["labels", "assignees"] as const) {
    if (!hasOwn(values, key)) continue;
    const parsed = nonEmptyStringArray(values[key], `$.artifact.values.${key}`, violations);
    if (parsed !== undefined) metadata[key] = [...parsed].sort(compareStrings);
  }
  if (hasOwn(values, "milestone")) {
    const milestone = requiredString(values.milestone, "$.artifact.values.milestone", violations, 512);
    if (milestone !== undefined) metadata.milestone = milestone;
  }

  if (
    violations.length > 0 ||
    id === undefined ||
    title === undefined ||
    provenance === undefined ||
    !isRecord(input.fields)
  )
    return { violations };
  return {
    artifact: {
      artifact: input as unknown as SemanticArtifact,
      title,
      references: { ...(parent === undefined ? {} : { parent }), dependsOn },
      metadata: metadata as DesiredIssueMetadataProjection,
      fields,
      provenance,
    },
    violations: [],
  };
}

function relationFallbackMarker(parent: IssueReference | undefined, dependsOn: readonly IssueReference[]): string {
  const payload: Record<string, unknown> = { version: "1" };
  if (parent !== undefined) payload.parent = parent;
  if (dependsOn.length > 0) payload.dependsOn = dependsOn;
  return `<!-- inari:semantic-relation ${stableSerialize(payload)} -->`;
}

function renderFieldValue(value: unknown): string {
  if (typeof value === "string") return escapeMarkdownValue(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((entry) => typeof entry === "string")) {
      return value.map((entry) => `- ${escapeMarkdownValue(entry as string)}`).join("\n");
    }
  }
  return escapeMarkdownValue(stableSerialize(value));
}

function fieldHeading(name: string): string {
  return name
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .replace(/^#+(?=\s|$)/u, "\\#");
}

function renderCanonicalBody(
  fields: Readonly<Record<string, unknown>>,
  parent: IssueReference | undefined,
  dependsOn: readonly IssueReference[],
  parentRepresentation: SemanticIssueProjectionRepresentation,
  dependsOnRepresentation: SemanticIssueProjectionRepresentation,
): string | undefined {
  const blocks: string[] = [];
  for (const key of Object.keys(fields).sort(compareStrings)) {
    blocks.push(`## ${fieldHeading(key)}\n\n${renderFieldValue(fields[key])}`);
  }

  if (parent !== undefined && parentRepresentation === "body-fallback") {
    blocks.push(relationFallbackMarker(parent, []));
  }
  if (dependsOn.length > 0 && dependsOnRepresentation === "body-fallback") {
    blocks.push(renderIssueDependencyMarker({ blockedBy: dependsOn, blocks: [] }));
  }
  if (blocks.length === 0) return "";
  return `${blocks.join("\n\n")}\n`;
}

function projectionRequest(
  input: unknown,
  secondCapabilities: unknown,
  violations: SemanticIssueProjectionViolation[],
): { readonly artifact: unknown; readonly capabilities: unknown } | undefined {
  if (secondCapabilities !== undefined) return { artifact: input, capabilities: secondCapabilities };
  if (!isRecord(input)) {
    addViolation(violations, "PROJECTION_INPUT_INVALID", "$", "Projection input must be an object.");
    return undefined;
  }
  unknownProperties(input, PROJECTION_INPUT_KEYS, "$", violations);
  if (!hasOwn(input, "artifact"))
    addViolation(violations, "PROJECTION_INPUT_INVALID", "$.artifact", "Semantic Artifact is required.");
  if (!hasOwn(input, "capabilities"))
    addViolation(violations, "PROJECTION_INPUT_INVALID", "$.capabilities", "Declared capabilities are required.");
  return { artifact: input.artifact, capabilities: input.capabilities };
}

function buildProjection(input: unknown, secondCapabilities?: unknown): SemanticIssueProjectionResult {
  const violations: SemanticIssueProjectionViolation[] = [];
  const request = projectionRequest(input, secondCapabilities, violations);
  if (request === undefined) return invalidResult(violations);
  const artifactResult = validateSemanticArtifact(request.artifact);
  violations.push(...artifactResult.violations);
  const artifact = artifactResult.artifact;
  const capabilities = normalizeCapabilities(request.capabilities, violations);
  if (artifact === undefined || capabilities === undefined || violations.length > 0) return invalidResult(violations);

  let parentRepresentation: SemanticIssueProjectionRepresentation = "none";
  if (artifact.references.parent !== undefined) {
    if (hasCapability(capabilities, "nativeParent")) parentRepresentation = "native";
    else if (hasCapability(capabilities, "fallback")) parentRepresentation = "body-fallback";
    else {
      addViolation(
        violations,
        "RELATION_UNREPRESENTABLE",
        "$.capabilities",
        "No declared GitHub capability can represent the semantic parent relation.",
      );
    }
  }

  let dependsOnRepresentation: SemanticIssueProjectionRepresentation = "none";
  if (artifact.references.dependsOn.length > 0) {
    if (hasCapability(capabilities, "nativeDependsOn")) dependsOnRepresentation = "native";
    else if (hasCapability(capabilities, "fallback")) dependsOnRepresentation = "body-fallback";
    else {
      addViolation(
        violations,
        "RELATION_UNREPRESENTABLE",
        "$.capabilities",
        "No declared GitHub capability can represent the semantic dependsOn relation.",
      );
    }
  }

  const body = renderCanonicalBody(
    artifact.fields,
    artifact.references.parent,
    artifact.references.dependsOn,
    parentRepresentation,
    dependsOnRepresentation,
  );
  if (body === undefined) {
    if (violations.length === 0)
      addViolation(violations, "PROJECTION_BODY_INVALID", "$.desired.body", "Canonical body could not be rendered.");
    return invalidResult(violations);
  }
  if (violations.length > 0) return invalidResult(violations);

  const desired: DesiredIssueProjection = {
    version: SEMANTIC_ISSUE_PROJECTION_VERSION,
    kind: "issue",
    title: artifact.title,
    body,
    metadata: artifact.metadata,
    relations: {
      parent: {
        relation: "parent",
        ...(artifact.references.parent === undefined ? {} : { reference: artifact.references.parent }),
        representation: parentRepresentation,
      },
      dependsOn: {
        relation: "dependsOn",
        references: artifact.references.dependsOn,
        representation: dependsOnRepresentation,
      },
    },
    provenance: artifact.provenance,
    generation: artifact.provenance,
  };
  return { valid: true, projection: cloneImmutable(desired), violations: [] };
}

/** Project an Issue Semantic Artifact. No title/metadata/relation override exists. */
export function tryProjectSemanticIssue(input: unknown, capabilities?: unknown): SemanticIssueProjectionResult {
  return buildProjection(input, capabilities);
}

/** Throwing projection entry point for Core callers. */
export function projectSemanticIssue(input: unknown, capabilities?: unknown): DesiredIssueProjection {
  const result = tryProjectSemanticIssue(input, capabilities);
  if (!result.valid || result.projection === undefined) throw new SemanticIssueProjectionError(result.violations);
  return result.projection;
}

export const projectSemanticIssueArtifact = projectSemanticIssue;
export const projectIssueSemanticArtifact = projectSemanticIssue;

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
export function tryPlanSemanticIssue(input: unknown, capabilities?: unknown): SemanticIssueMutationPlanResult {
  const projectionResult = tryProjectSemanticIssue(input, capabilities);
  if (!projectionResult.valid || projectionResult.projection === undefined)
    return invalidPlanResult(projectionResult.violations);
  const request = projectionRequest(input, capabilities, []);
  if (request === undefined) {
    return invalidPlanResult([
      { code: "MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan input could not be resolved." },
    ]);
  }
  const artifactResult = validateSemanticArtifact(request.artifact);
  if (artifactResult.artifact === undefined) {
    return invalidPlanResult([
      { code: "MUTATION_PLAN_INVALID", path: "$.artifact", message: "Validated Semantic Artifact is required." },
    ]);
  }
  const generation = cloneImmutable(artifactResult.artifact.provenance);
  const desired = projectionResult.projection;
  const plan: SemanticIssueMutationPlan = {
    version: SEMANTIC_ISSUE_MUTATION_PLAN_VERSION,
    kind: "issue",
    artifact: {
      version: artifactResult.artifact.artifact.version,
      effectiveContractVersion: artifactResult.artifact.artifact.effectiveContractVersion,
      artifactContractVersion: artifactResult.artifact.artifact.artifactContractVersion,
      kind: "issue",
      id: artifactResult.artifact.artifact.id,
      digest: artifactDigest(artifactResult.artifact.artifact),
    },
    provenance: cloneImmutable(artifactResult.artifact.provenance),
    generation,
    capabilities: cloneImmutable(normalizeCapabilities(request.capabilities, []) ?? []),
    desired,
    preconditions: [{ kind: "GOVERNANCE_GENERATION_MATCH", generation }],
    effects: [{ kind: "CREATE_ISSUE", desired }],
  };
  return { valid: true, plan: cloneImmutable(plan), violations: [] };
}

export function planSemanticIssue(input: unknown, capabilities?: unknown): SemanticIssueMutationPlan {
  const result = tryPlanSemanticIssue(input, capabilities);
  if (!result.valid || result.plan === undefined) throw new SemanticIssueProjectionError(result.violations);
  return result.plan;
}

export const planSemanticIssueMutation = planSemanticIssue;
export const createSemanticIssueMutationPlan = planSemanticIssue;

/** Stable transport representation for the versioned plan. */
export function serializeSemanticIssueMutationPlan(input: unknown): string {
  const result = validateSemanticIssueMutationPlan(input);
  if (!result.valid || result.plan === undefined) throw new SemanticIssueProjectionError(result.violations);
  return stableSerialize(result.plan);
}

function validatePlanArtifactIdentity(
  input: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
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
  if (input.kind !== "issue")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.kind`, "Artifact identity kind is invalid.");
  requiredString(input.id, `${path}.id`, violations, 512);
  if (typeof input.digest !== "string" || !SHA256_HEX_PATTERN.test(input.digest))
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.digest`, "Artifact digest must be a SHA-256 hex value.");
}

function validateDesiredMetadata(input: unknown, path: string, violations: SemanticIssueProjectionViolation[]): void {
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Desired metadata must be an object.");
    return;
  }
  unknownProperties(input, DESIRED_METADATA_KEYS, path, violations, "MUTATION_PLAN_INVALID");
  for (const key of ["labels", "assignees"] as const) {
    if (hasOwn(input, key)) nonEmptyStringArray(input[key], `${path}.${key}`, violations);
  }
  if (hasOwn(input, "milestone")) requiredString(input.milestone, `${path}.milestone`, violations, 512);
}

function validateDesiredRelations(input: unknown, path: string, violations: SemanticIssueProjectionViolation[]): void {
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Desired relations must be an object.");
    return;
  }
  unknownProperties(input, DESIRED_RELATIONS_KEYS, path, violations, "MUTATION_PLAN_INVALID");

  const parent = input.parent;
  if (!isRecord(parent)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.parent`, "Desired parent relation must be an object.");
  } else {
    unknownProperties(parent, DESIRED_PARENT_RELATION_KEYS, `${path}.parent`, violations, "MUTATION_PLAN_INVALID");
    if (parent.relation !== "parent")
      addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.parent.relation`, 'Relation kind must be "parent".');
    if (!RELATION_REPRESENTATIONS.has(parent.representation as SemanticIssueProjectionRepresentation))
      addViolation(
        violations,
        "MUTATION_PLAN_INVALID",
        `${path}.parent.representation`,
        "Relation representation is invalid.",
      );
    if (hasOwn(parent, "reference")) {
      const result = normalizeIssueReference(parent.reference, `${path}.parent.reference`);
      if (!result.valid)
        addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.parent.reference`, "IssueReference is invalid.");
    }
  }

  const dependsOn = input.dependsOn;
  if (!isRecord(dependsOn)) {
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      `${path}.dependsOn`,
      "Desired dependsOn relation must be an object.",
    );
  } else {
    unknownProperties(
      dependsOn,
      DESIRED_DEPENDS_ON_RELATION_KEYS,
      `${path}.dependsOn`,
      violations,
      "MUTATION_PLAN_INVALID",
    );
    if (dependsOn.relation !== "dependsOn")
      addViolation(
        violations,
        "MUTATION_PLAN_INVALID",
        `${path}.dependsOn.relation`,
        'Relation kind must be "dependsOn".',
      );
    if (!RELATION_REPRESENTATIONS.has(dependsOn.representation as SemanticIssueProjectionRepresentation))
      addViolation(
        violations,
        "MUTATION_PLAN_INVALID",
        `${path}.dependsOn.representation`,
        "Relation representation is invalid.",
      );
    if (!Array.isArray(dependsOn.references)) {
      addViolation(
        violations,
        "MUTATION_PLAN_INVALID",
        `${path}.dependsOn.references`,
        "Relation references must be an array.",
      );
    } else {
      const seen = new Set<string>();
      dependsOn.references.forEach((entry, index) => {
        const result = normalizeIssueReference(entry, `${path}.dependsOn.references[${index}]`);
        if (!result.valid || result.reference === undefined) {
          addViolation(
            violations,
            "MUTATION_PLAN_INVALID",
            `${path}.dependsOn.references[${index}]`,
            "IssueReference is invalid.",
          );
          return;
        }
        const key = issueReferenceKey(result.reference);
        if (seen.has(key))
          addViolation(
            violations,
            "MUTATION_PLAN_INVALID",
            `${path}.dependsOn.references[${index}]`,
            "Issue references must be unique.",
          );
        seen.add(key);
      });
    }
  }
}

function validateDesiredProjectionShape(
  input: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): void {
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Desired Issue projection must be an object.");
    return;
  }
  unknownProperties(input, DESIRED_PROJECTION_KEYS, path, violations, "MUTATION_PLAN_INVALID");
  if (input.version !== SEMANTIC_ISSUE_PROJECTION_VERSION)
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.version`, "Desired projection version is unsupported.");
  if (input.kind !== "issue")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.kind`, "Desired projection kind is invalid.");
  requiredString(input.title, `${path}.title`, violations);
  if (typeof input.body !== "string")
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.body`, "Desired body must be a string.");
  validateDesiredMetadata(input.metadata, `${path}.metadata`, violations);
  validateDesiredRelations(input.relations, `${path}.relations`, violations);
  if (!provenanceIsValid(input.provenance))
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.provenance`, "Desired provenance is invalid.");
  if (!provenanceIsValid(input.generation))
    addViolation(violations, "MUTATION_PLAN_INVALID", `${path}.generation`, "Desired generation is invalid.");
  if (
    provenanceIsValid(input.provenance) &&
    provenanceIsValid(input.generation) &&
    stableSerialize(input.provenance) !== stableSerialize(input.generation)
  )
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      `${path}.generation`,
      "Desired generation must equal desired provenance.",
    );
}

function validatePreconditions(
  input: unknown,
  planGeneration: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): void {
  if (!Array.isArray(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "Preconditions must be an array.");
    return;
  }
  const seenKinds = new Set<string>();
  input.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      addViolation(violations, "MUTATION_PLAN_INVALID", entryPath, "Precondition must be an object.");
      return;
    }
    if (entry.kind !== "GOVERNANCE_GENERATION_MATCH") {
      addViolation(violations, "MUTATION_PLAN_INVALID", `${entryPath}.kind`, "Precondition kind is unknown.");
      return;
    }
    if (seenKinds.has(entry.kind)) {
      addViolation(violations, "MUTATION_PLAN_INVALID", entryPath, `Duplicate precondition "${entry.kind}".`);
      return;
    }
    seenKinds.add(entry.kind);
    unknownProperties(entry, GOVERNANCE_GENERATION_MATCH_KEYS, entryPath, violations, "MUTATION_PLAN_INVALID");
    if (!provenanceIsValid(entry.generation)) {
      addViolation(
        violations,
        "MUTATION_PLAN_INVALID",
        `${entryPath}.generation`,
        "Precondition generation is invalid.",
      );
    } else if (
      !provenanceIsValid(planGeneration) ||
      stableSerialize(entry.generation) !== stableSerialize(planGeneration)
    ) {
      addViolation(
        violations,
        "MUTATION_PLAN_INVALID",
        `${entryPath}.generation`,
        "Precondition generation must equal plan generation.",
      );
    }
  });
  if (!seenKinds.has("GOVERNANCE_GENERATION_MATCH"))
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      path,
      'Required precondition "GOVERNANCE_GENERATION_MATCH" is missing.',
    );
}

function validateEffects(
  input: unknown,
  planDesired: unknown,
  path: string,
  violations: SemanticIssueProjectionViolation[],
): void {
  if (!Array.isArray(input) || input.length !== 1) {
    addViolation(violations, "MUTATION_PLAN_INVALID", path, "An Issue plan requires exactly one explicit effect.");
    return;
  }
  const effect = input[0];
  const effectPath = `${path}[0]`;
  if (!isRecord(effect)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", effectPath, "Effect must be an object.");
    return;
  }
  unknownProperties(effect, PLAN_EFFECT_KEYS, effectPath, violations, "MUTATION_PLAN_INVALID");
  if (effect.kind !== "CREATE_ISSUE")
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

/** Validate the bounded shape of a transported plan without executing it. */
export function validateSemanticIssueMutationPlan(input: unknown): SemanticIssueMutationPlanResult {
  const violations: SemanticIssueProjectionViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "MUTATION_PLAN_INVALID", "$", "Mutation plan must be an object.");
    return invalidPlanResult(violations);
  }
  const required = [
    "version",
    "kind",
    "artifact",
    "provenance",
    "generation",
    "capabilities",
    "desired",
    "preconditions",
    "effects",
  ];
  unknownProperties(input, new Set(required), "$", violations, "MUTATION_PLAN_INVALID");
  if (input.version !== SEMANTIC_ISSUE_MUTATION_PLAN_VERSION)
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.version", "Mutation plan version is unsupported.");
  if (input.kind !== "issue")
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.kind", "Mutation plan kind is invalid.");
  validatePlanArtifactIdentity(input.artifact, "$.artifact", violations);
  if (!provenanceIsValid(input.provenance))
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.provenance", "Plan provenance is invalid.");
  if (!provenanceIsValid(input.generation))
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.generation", "Plan generation is invalid.");
  if (
    provenanceIsValid(input.provenance) &&
    provenanceIsValid(input.generation) &&
    stableSerialize(input.provenance) !== stableSerialize(input.generation)
  )
    addViolation(violations, "MUTATION_PLAN_INVALID", "$.generation", "Plan generation must equal provenance.");
  const capabilities = normalizeCapabilities(input.capabilities, violations);
  validateDesiredProjectionShape(input.desired, "$.desired", violations);
  if (
    isRecord(input.desired) &&
    provenanceIsValid(input.desired.generation) &&
    provenanceIsValid(input.generation) &&
    stableSerialize(input.desired.generation) !== stableSerialize(input.generation)
  ) {
    addViolation(
      violations,
      "MUTATION_PLAN_INVALID",
      "$.desired.generation",
      "Desired generation must equal plan generation.",
    );
  }
  validatePreconditions(input.preconditions, input.generation, "$.preconditions", violations);
  validateEffects(input.effects, input.desired, "$.effects", violations);
  if (violations.length > 0 || capabilities === undefined) return invalidPlanResult(violations);
  return { valid: true, plan: cloneImmutable(input as unknown as SemanticIssueMutationPlan), violations: [] };
}

export function deserializeSemanticIssueMutationPlan(serialized: string): SemanticIssueMutationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new SemanticIssueProjectionError([
      { code: "MUTATION_PLAN_INVALID", path: "$", message: "Mutation plan must be valid JSON." },
    ]);
  }
  const result = validateSemanticIssueMutationPlan(parsed);
  if (!result.valid || result.plan === undefined) throw new SemanticIssueProjectionError(result.violations);
  return result.plan;
}

export const serializeSemanticIssuePlan = serializeSemanticIssueMutationPlan;
export const parseSemanticIssueMutationPlan = deserializeSemanticIssueMutationPlan;
