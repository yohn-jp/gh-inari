/**
 * Pure Core projection of Issue lifecycle evidence.
 *
 * This module deliberately consumes the existing Observed Issue Projection
 * and IssueReference primitives.  It does not parse Markdown, perform
 * GitHub I/O, or mutate an Issue.  The input is a bounded set of observed
 * Issues; parent/dependsOn remain the only forward relation authorities and
 * children/blocks/supersededBy are derived views.
 */

import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import type { SemanticArtifact } from "./contract/semantic-artifact.js";
import type { ObservedIssueProjection } from "./semantic-issue-observation.js";

export const SEMANTIC_ISSUE_LIFECYCLE_VERSION = "1" as const;
export type SemanticIssueLifecycleVersion = typeof SEMANTIC_ISSUE_LIFECYCLE_VERSION;

export const SEMANTIC_ISSUE_LIFECYCLE_LIMITS = Object.freeze({
  issues: 1_000,
  references: 1_000,
  diagnostics: 100,
  messageLength: 500,
} as const);

export type SemanticIssueLifecycleRole = "tracker" | "leaf";
export type SemanticIssueLifecycleEvidenceStatus = "present" | "empty" | "unavailable";
export type SemanticIssueLifecycleCompletionStatus = "complete" | "in-progress" | "unknown" | "not-declared";

/** Explicit lifecycle semantics supplied by the existing Artifact Contract. */
export interface SemanticIssueLifecycleDeclaration {
  /** Explicit role; no role is inferred from the graph or prose. */
  readonly role?: SemanticIssueLifecycleRole;
  /** Canonical forward supersession relation. */
  readonly supersedes?: readonly IssueReference[];
  /** Compatibility evidence for the derived inverse view. */
  readonly supersededBy?: readonly IssueReference[];
}

/**
 * Bounded checklist evidence.  Checklist entries are IssueReferences so a
 * checklist can be compared with the same cross-repository child identity
 * used by the relation graph.
 */
export interface SemanticIssueChecklistEvidence {
  readonly status: "present" | "unavailable";
  readonly completed: readonly IssueReference[];
  readonly remaining: readonly IssueReference[];
}

/** One observed Issue and its optional explicit lifecycle declaration. */
export interface SemanticIssueLifecycleNode {
  readonly reference: IssueReference;
  readonly observed?: ObservedIssueProjection;
  /** Optional materialized Issue Artifact carrying the declaration values. */
  readonly artifact?: SemanticArtifact;
  /** Narrow adapter input for callers that already extracted Artifact values. */
  readonly declaration?: SemanticIssueLifecycleDeclaration;
  readonly checklist?: SemanticIssueChecklistEvidence;
}

/**
 * The set itself is the bounded evidence scope.  `scope: unavailable` is
 * useful when an adapter could not establish that the set is complete; in
 * that case inverse views and completion fail closed.
 */
export interface SemanticIssueLifecycleInput {
  readonly scope?: "complete" | "unavailable";
  readonly issues: readonly SemanticIssueLifecycleNode[];
}

export interface SemanticIssueLifecycleCompletion {
  readonly status: SemanticIssueLifecycleCompletionStatus;
  readonly children: readonly IssueReference[];
  readonly completed: readonly IssueReference[];
  readonly remaining: readonly IssueReference[];
  /** Set only when exactly one authoritative child remains incomplete. */
  readonly finalGateRemainder?: IssueReference;
}

export interface SemanticIssueLifecycleIssueProjection {
  readonly reference: IssueReference;
  readonly role?: SemanticIssueLifecycleRole;
  readonly parent?: IssueReference;
  readonly parentEvidence: SemanticIssueLifecycleEvidenceStatus;
  readonly children: readonly IssueReference[];
  readonly childrenEvidence: SemanticIssueLifecycleEvidenceStatus;
  readonly dependsOn: readonly IssueReference[];
  readonly dependsOnEvidence: SemanticIssueLifecycleEvidenceStatus;
  readonly blocks: readonly IssueReference[];
  readonly blocksEvidence: SemanticIssueLifecycleEvidenceStatus;
  readonly supersedes: readonly IssueReference[];
  readonly supersededBy: readonly IssueReference[];
  readonly supersessionEvidence: SemanticIssueLifecycleEvidenceStatus;
  readonly completion: SemanticIssueLifecycleCompletion;
  readonly checklist?: SemanticIssueChecklistEvidence;
  readonly drift: readonly SemanticIssueLifecycleDiagnostic[];
}

export interface SemanticIssueLifecycleProjection {
  readonly version: SemanticIssueLifecycleVersion;
  readonly kind: "issue-lifecycle";
  readonly scope: "complete" | "unavailable";
  readonly issues: readonly SemanticIssueLifecycleIssueProjection[];
}

export type SemanticIssueLifecycleDiagnosticCode =
  | "INPUT_INVALID"
  | "INPUT_UNKNOWN_PROPERTY"
  | "REFERENCE_INVALID"
  | "REFERENCE_DUPLICATE"
  | "ISSUE_DUPLICATE"
  | "OBSERVED_ISSUE_INVALID"
  | "DECLARATION_INVALID"
  | "CHECKLIST_INVALID"
  | "EVIDENCE_UNAVAILABLE"
  | "RELATION_CONFLICT"
  | "RELATION_DRIFT"
  | "SUPERSESSION_DRIFT"
  | "ROLE_RELATION_DRIFT"
  | "COMPLETION_DRIFT"
  | "CHECKLIST_RELATION_DRIFT";

export interface SemanticIssueLifecycleDiagnostic {
  readonly code: SemanticIssueLifecycleDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface SemanticIssueLifecycleResult {
  readonly valid: boolean;
  readonly projection?: SemanticIssueLifecycleProjection;
  readonly diagnostics: readonly SemanticIssueLifecycleDiagnostic[];
}

export class SemanticIssueLifecycleError extends Error {
  readonly diagnostics: readonly SemanticIssueLifecycleDiagnostic[];

  constructor(diagnostics: readonly SemanticIssueLifecycleDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "SemanticIssueLifecycleError";
    this.diagnostics = diagnostics;
  }
}

type RecordValue = Record<string, unknown>;
type RelationKind = "parent" | "dependsOn";

const INPUT_KEYS = new Set(["scope", "issues"]);
const NODE_KEYS = new Set(["reference", "observed", "artifact", "declaration", "checklist"]);
const DECLARATION_KEYS = new Set(["role", "supersedes", "supersededBy"]);
const CHECKLIST_KEYS = new Set(["status", "completed", "remaining"]);
const OBSERVED_KEYS = new Set(["version", "kind", "number", "state", "url", "title", "body", "metadata", "relations"]);
const OBSERVED_RELATIONS_KEYS = new Set(["parent", "dependsOn"]);
const OBSERVED_PARENT_KEYS = new Set(["relation", "reference", "representation", "evidence"]);
const OBSERVED_DEPENDS_ON_KEYS = new Set(["relation", "references", "representation", "evidence"]);
const REPRESENTATIONS = new Set(["none", "native", "body-fallback", "conflict"]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function compareReferences(left: IssueReference, right: IssueReference): number {
  return issueReferenceKey(left).localeCompare(issueReferenceKey(right), "en-US");
}

function sameReferences(left: readonly IssueReference[], right: readonly IssueReference[]): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => issueReferenceKey(reference) === issueReferenceKey(right[index] as IssueReference))
  );
}

function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  return normalized.length > SEMANTIC_ISSUE_LIFECYCLE_LIMITS.messageLength
    ? `${normalized.slice(0, SEMANTIC_ISSUE_LIFECYCLE_LIMITS.messageLength)}…`
    : normalized;
}

function addDiagnostic(
  diagnostics: SemanticIssueLifecycleDiagnostic[],
  code: SemanticIssueLifecycleDiagnosticCode,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  if (diagnostics.length >= SEMANTIC_ISSUE_LIFECYCLE_LIMITS.diagnostics) return;
  diagnostics.push({
    code,
    path,
    message: boundedMessage(message),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function unknownProperties(
  input: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): void {
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key))
      addDiagnostic(diagnostics, "INPUT_UNKNOWN_PROPERTY", `${path}.${key}`, `Property "${key}" is not supported.`);
  }
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) clone[key] = cloneImmutable(value[key]);
    return Object.freeze(clone) as T;
  }
  return value;
}

function normalizeReferences(
  value: unknown,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): readonly IssueReference[] | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "REFERENCE_INVALID", path, "Issue references must be an array.");
    return undefined;
  }
  if (value.length > SEMANTIC_ISSUE_LIFECYCLE_LIMITS.references) {
    addDiagnostic(diagnostics, "REFERENCE_INVALID", path, "Issue references exceed the bounded item limit.");
    return undefined;
  }
  const seen = new Set<string>();
  const result: IssueReference[] = [];
  value.forEach((entry, index) => {
    const normalized = normalizeIssueReference(entry, `${path}[${index}]`);
    if (!normalized.valid || normalized.reference === undefined) {
      addDiagnostic(diagnostics, "REFERENCE_INVALID", `${path}[${index}]`, "IssueReference is invalid.");
      return;
    }
    const key = issueReferenceKey(normalized.reference);
    if (seen.has(key)) {
      addDiagnostic(diagnostics, "REFERENCE_DUPLICATE", `${path}[${index}]`, "Issue references must be unique.");
      return;
    }
    seen.add(key);
    result.push(normalized.reference);
  });
  return result.sort(compareReferences);
}

function normalizeSingleReference(
  value: unknown,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): IssueReference | undefined {
  const normalized = normalizeIssueReference(value, path);
  if (!normalized.valid || normalized.reference === undefined) {
    addDiagnostic(diagnostics, "REFERENCE_INVALID", path, "IssueReference is invalid.");
    return undefined;
  }
  return normalized.reference;
}

function observedRelation(
  observed: RecordValue,
  kind: RelationKind,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): { readonly status: SemanticIssueLifecycleEvidenceStatus; readonly references: readonly IssueReference[] } {
  if (!isRecord(observed.relations)) {
    addDiagnostic(diagnostics, "OBSERVED_ISSUE_INVALID", `${path}.relations`, "Observed relations must be an object.");
    return { status: "unavailable", references: [] };
  }
  const relation = observed.relations[kind];
  if (!isRecord(relation)) {
    addDiagnostic(diagnostics, "OBSERVED_ISSUE_INVALID", `${path}.relations.${kind}`, "Observed relation is invalid.");
    return { status: "unavailable", references: [] };
  }
  const allowed = kind === "parent" ? OBSERVED_PARENT_KEYS : OBSERVED_DEPENDS_ON_KEYS;
  unknownProperties(relation, allowed, `${path}.relations.${kind}`, diagnostics);
  const representation = relation.representation;
  if (typeof representation !== "string" || !REPRESENTATIONS.has(representation)) {
    addDiagnostic(
      diagnostics,
      "OBSERVED_ISSUE_INVALID",
      `${path}.relations.${kind}.representation`,
      "Relation representation is invalid.",
    );
    return { status: "unavailable", references: [] };
  }
  if (representation === "conflict") {
    addDiagnostic(
      diagnostics,
      "RELATION_CONFLICT",
      `${path}.relations.${kind}`,
      "Conflicting relation evidence cannot be used for lifecycle derivation.",
    );
    return { status: "unavailable", references: [] };
  }
  if (kind === "parent") {
    if (!hasOwn(relation, "reference")) return { status: "empty", references: [] };
    if (representation === "none") {
      addDiagnostic(
        diagnostics,
        "OBSERVED_ISSUE_INVALID",
        `${path}.relations.parent.reference`,
        "A parent reference cannot use the none representation.",
      );
      return { status: "unavailable", references: [] };
    }
    const reference = normalizeSingleReference(relation.reference, `${path}.relations.parent.reference`, diagnostics);
    return reference === undefined
      ? { status: "unavailable", references: [] }
      : { status: "present", references: [reference] };
  }
  if (!Array.isArray(relation.references)) {
    addDiagnostic(
      diagnostics,
      "OBSERVED_ISSUE_INVALID",
      `${path}.relations.dependsOn.references`,
      "dependsOn references must be an array.",
    );
    return { status: "unavailable", references: [] };
  }
  const references = normalizeReferences(relation.references, `${path}.relations.dependsOn.references`, diagnostics);
  if (references === undefined) return { status: "unavailable", references: [] };
  return references.length === 0 ? { status: "empty", references } : { status: "present", references };
}

function validateObserved(
  input: unknown,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): ObservedIssueProjection | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "OBSERVED_ISSUE_INVALID", path, "Observed Issue must be an object.");
    return undefined;
  }
  unknownProperties(input, OBSERVED_KEYS, path, diagnostics);
  if (input.version !== "1" || input.kind !== "issue") {
    addDiagnostic(diagnostics, "OBSERVED_ISSUE_INVALID", path, "Observed Issue projection version or kind is invalid.");
  }
  if (input.state !== undefined && input.state !== "open" && input.state !== "closed")
    addDiagnostic(diagnostics, "OBSERVED_ISSUE_INVALID", `${path}.state`, "Observed Issue state is invalid.");
  if (!isRecord(input.relations))
    addDiagnostic(diagnostics, "OBSERVED_ISSUE_INVALID", `${path}.relations`, "Observed relations are required.");
  else {
    unknownProperties(input.relations, OBSERVED_RELATIONS_KEYS, `${path}.relations`, diagnostics);
  }
  return input as unknown as ObservedIssueProjection;
}

function validateDeclaration(
  input: unknown,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): SemanticIssueLifecycleDeclaration | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "DECLARATION_INVALID", path, "Lifecycle declaration must be an object.");
    return undefined;
  }
  unknownProperties(input, DECLARATION_KEYS, path, diagnostics);
  let role: SemanticIssueLifecycleRole | undefined;
  if (input.role !== undefined) {
    if (input.role !== "tracker" && input.role !== "leaf")
      addDiagnostic(diagnostics, "DECLARATION_INVALID", `${path}.role`, "Lifecycle role must be tracker or leaf.");
    else role = input.role;
  }
  const supersedes = hasOwn(input, "supersedes")
    ? normalizeReferences(input.supersedes, `${path}.supersedes`, diagnostics)
    : undefined;
  const supersededBy = hasOwn(input, "supersededBy")
    ? normalizeReferences(input.supersededBy, `${path}.supersededBy`, diagnostics)
    : undefined;
  return {
    ...(role === undefined ? {} : { role }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}

function validateChecklist(
  input: unknown,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): SemanticIssueChecklistEvidence | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "CHECKLIST_INVALID", path, "Checklist evidence must be an object.");
    return undefined;
  }
  unknownProperties(input, CHECKLIST_KEYS, path, diagnostics);
  if (input.status !== "present" && input.status !== "unavailable") {
    addDiagnostic(
      diagnostics,
      "CHECKLIST_INVALID",
      `${path}.status`,
      "Checklist status must be present or unavailable.",
    );
    return undefined;
  }
  const completed = normalizeReferences(input.completed, `${path}.completed`, diagnostics);
  const remaining = normalizeReferences(input.remaining, `${path}.remaining`, diagnostics);
  if (completed === undefined || remaining === undefined) return undefined;
  const completedKeys = new Set(completed.map(issueReferenceKey));
  if (remaining.some((reference) => completedKeys.has(issueReferenceKey(reference))))
    addDiagnostic(
      diagnostics,
      "CHECKLIST_INVALID",
      path,
      "Checklist references cannot be both completed and remaining.",
    );
  return { status: input.status, completed, remaining };
}

function declarationFromArtifact(
  input: unknown,
  path: string,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
): SemanticIssueLifecycleDeclaration | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "DECLARATION_INVALID", path, "Semantic Artifact must be an object.");
    return undefined;
  }
  if (input.kind !== "issue" || input.version !== "1" || !isRecord(input.values)) {
    addDiagnostic(
      diagnostics,
      "DECLARATION_INVALID",
      path,
      "Lifecycle declarations require a materialized Issue Semantic Artifact.",
    );
    return undefined;
  }
  const values = input.values;
  const declaration: Record<string, unknown> = {};
  for (const key of ["role", "supersedes", "supersededBy"] as const)
    if (hasOwn(values, key)) declaration[key] = values[key];
  return Object.keys(declaration).length === 0
    ? undefined
    : validateDeclaration(declaration, `${path}.values`, diagnostics);
}

interface NormalizedNode {
  readonly reference: IssueReference;
  readonly observed?: ObservedIssueProjection;
  readonly declaration?: SemanticIssueLifecycleDeclaration;
  readonly checklist?: SemanticIssueChecklistEvidence;
  readonly parent: {
    readonly status: SemanticIssueLifecycleEvidenceStatus;
    readonly references: readonly IssueReference[];
  };
  readonly dependsOn: {
    readonly status: SemanticIssueLifecycleEvidenceStatus;
    readonly references: readonly IssueReference[];
  };
}

function normalizeInput(
  input: unknown,
  diagnostics: SemanticIssueLifecycleDiagnostic[],
):
  | {
      readonly scope: "complete" | "unavailable";
      readonly nodes: readonly NormalizedNode[];
    }
  | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "INPUT_INVALID", "$", "Lifecycle input must be an object.");
    return undefined;
  }
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);
  const scope = input.scope === undefined ? "complete" : input.scope;
  if (scope !== "complete" && scope !== "unavailable")
    addDiagnostic(diagnostics, "INPUT_INVALID", "$.scope", "Lifecycle scope must be complete or unavailable.");
  if (!Array.isArray(input.issues)) {
    addDiagnostic(diagnostics, "INPUT_INVALID", "$.issues", "Lifecycle issues must be an array.");
    return undefined;
  }
  if (input.issues.length > SEMANTIC_ISSUE_LIFECYCLE_LIMITS.issues)
    addDiagnostic(diagnostics, "INPUT_INVALID", "$.issues", "Lifecycle issues exceed the bounded item limit.");
  const seen = new Set<string>();
  const nodes: NormalizedNode[] = [];
  input.issues.forEach((entry, index) => {
    const path = `$.issues[${index}]`;
    if (!isRecord(entry)) {
      addDiagnostic(diagnostics, "INPUT_INVALID", path, "Lifecycle issue must be an object.");
      return;
    }
    unknownProperties(entry, NODE_KEYS, path, diagnostics);
    const reference = normalizeSingleReference(entry.reference, `${path}.reference`, diagnostics);
    if (reference === undefined) return;
    const key = issueReferenceKey(reference);
    if (seen.has(key)) {
      addDiagnostic(diagnostics, "ISSUE_DUPLICATE", `${path}.reference`, "Lifecycle Issue references must be unique.");
      return;
    }
    seen.add(key);
    const observed =
      entry.observed === undefined ? undefined : validateObserved(entry.observed, `${path}.observed`, diagnostics);
    if (observed === undefined)
      addDiagnostic(
        diagnostics,
        "EVIDENCE_UNAVAILABLE",
        `${path}.observed`,
        "Observed Issue evidence is required to derive lifecycle relations.",
      );
    const artifactDeclaration =
      entry.artifact === undefined
        ? undefined
        : declarationFromArtifact(entry.artifact, `${path}.artifact`, diagnostics);
    const directDeclaration =
      entry.declaration === undefined
        ? undefined
        : validateDeclaration(entry.declaration, `${path}.declaration`, diagnostics);
    if (artifactDeclaration !== undefined && directDeclaration !== undefined) {
      addDiagnostic(
        diagnostics,
        "DECLARATION_INVALID",
        path,
        "Supply lifecycle declaration through the Semantic Artifact or the adapter field, not both.",
      );
    }
    const declaration = artifactDeclaration ?? directDeclaration;
    const checklist =
      entry.checklist === undefined ? undefined : validateChecklist(entry.checklist, `${path}.checklist`, diagnostics);
    const parent =
      observed === undefined
        ? { status: "unavailable" as const, references: [] }
        : observedRelation(observed as unknown as RecordValue, "parent", `${path}.observed`, diagnostics);
    const dependsOn =
      observed === undefined
        ? { status: "unavailable" as const, references: [] }
        : observedRelation(observed as unknown as RecordValue, "dependsOn", `${path}.observed`, diagnostics);
    if (observed?.number !== undefined && observed.number !== reference.number)
      addDiagnostic(
        diagnostics,
        "OBSERVED_ISSUE_INVALID",
        `${path}.observed.number`,
        "Observed Issue number must match its stable IssueReference.",
      );
    nodes.push({ reference, observed, declaration, checklist, parent, dependsOn });
  });
  return {
    scope: scope === "unavailable" || nodes.some((node) => node.observed === undefined) ? "unavailable" : "complete",
    nodes: [...nodes].sort((left, right) => compareReferences(left.reference, right.reference)),
  };
}

interface DerivedRelations {
  readonly children: ReadonlyMap<string, readonly IssueReference[]>;
  readonly blocks: ReadonlyMap<string, readonly IssueReference[]>;
  readonly supersedes: ReadonlyMap<string, readonly IssueReference[]>;
  readonly supersededBy: ReadonlyMap<string, readonly IssueReference[]>;
  readonly explicitSupersededBy: ReadonlyMap<string, readonly IssueReference[]>;
}

function addToMap(map: Map<string, IssueReference[]>, key: string, reference: IssueReference): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [reference]);
  else values.push(reference);
}

function freezeReferenceMap(map: Map<string, IssueReference[]>): ReadonlyMap<string, readonly IssueReference[]> {
  const frozen = new Map<string, readonly IssueReference[]>();
  for (const [key, values] of map) {
    const unique = [...new Map(values.map((reference) => [issueReferenceKey(reference), reference])).values()].sort(
      compareReferences,
    );
    frozen.set(key, Object.freeze(unique));
  }
  return frozen;
}

function deriveRelations(nodes: readonly NormalizedNode[], scope: "complete" | "unavailable"): DerivedRelations {
  const children = new Map<string, IssueReference[]>();
  const blocks = new Map<string, IssueReference[]>();
  const supersedesMap = new Map<string, IssueReference[]>();
  const supersededBy = new Map<string, IssueReference[]>();
  const explicitSupersededBy = new Map<string, readonly IssueReference[]>();
  for (const node of nodes) {
    const key = issueReferenceKey(node.reference);
    children.set(key, []);
    blocks.set(key, []);
    supersedesMap.set(key, []);
    supersededBy.set(key, []);
  }
  for (const node of nodes) {
    const key = issueReferenceKey(node.reference);
    const supersedesReferences = node.declaration?.supersedes ?? [];
    const declaredInverse = node.declaration?.supersededBy ?? [];
    explicitSupersededBy.set(key, declaredInverse);
    if (scope === "complete") {
      for (const reference of supersedesReferences) addToMap(supersedesMap, key, reference);
      for (const reference of supersedesReferences)
        addToMap(supersededBy, issueReferenceKey(reference), node.reference);
      for (const reference of declaredInverse) {
        addToMap(supersedesMap, issueReferenceKey(reference), node.reference);
        addToMap(supersededBy, issueReferenceKey(node.reference), reference);
      }
    }
  }
  if (scope === "complete") {
    for (const node of nodes) {
      if (node.parent.status === "present")
        for (const parent of node.parent.references) addToMap(children, issueReferenceKey(parent), node.reference);
      if (node.dependsOn.status === "present")
        for (const dependency of node.dependsOn.references)
          addToMap(blocks, issueReferenceKey(dependency), node.reference);
    }
  }
  return {
    children: freezeReferenceMap(children),
    blocks: freezeReferenceMap(blocks),
    supersedes: freezeReferenceMap(supersedesMap),
    supersededBy: freezeReferenceMap(supersededBy),
    explicitSupersededBy,
  };
}

function stateFor(node: NormalizedNode): "open" | "closed" | undefined {
  return node.observed?.state;
}

function lifecycleResult(
  diagnostics: readonly SemanticIssueLifecycleDiagnostic[],
  projection: SemanticIssueLifecycleProjection,
): SemanticIssueLifecycleResult {
  return {
    valid: diagnostics.length === 0,
    projection: cloneImmutable(projection),
    diagnostics: [...diagnostics],
  };
}

/** Project bounded Issue observations into lifecycle and inverse relation views. */
export function tryProjectSemanticIssueLifecycle(input: unknown): SemanticIssueLifecycleResult {
  const diagnostics: SemanticIssueLifecycleDiagnostic[] = [];
  const normalized = normalizeInput(input, diagnostics);
  if (normalized === undefined) return { valid: false, diagnostics };
  const derived = deriveRelations(normalized.nodes, normalized.scope);
  const issues: SemanticIssueLifecycleIssueProjection[] = [];
  for (const node of normalized.nodes) {
    const key = issueReferenceKey(node.reference);
    const declaration = node.declaration;
    const children = derived.children.get(key) ?? [];
    const blocks = derived.blocks.get(key) ?? [];
    const supersededBy = derived.supersededBy.get(key) ?? [];
    const explicitInverse = derived.explicitSupersededBy.get(key) ?? [];
    const supersedes =
      normalized.scope === "unavailable" ? (declaration?.supersedes ?? []) : (derived.supersedes.get(key) ?? []);
    const supersededByEffective = [
      ...new Map(
        [...supersededBy, ...explicitInverse].map((reference) => [issueReferenceKey(reference), reference]),
      ).values(),
    ].sort(compareReferences);
    const issueDiagnostics: SemanticIssueLifecycleDiagnostic[] = [];
    if (declaration?.supersededBy !== undefined && !sameReferences(explicitInverse, supersededBy))
      addDiagnostic(
        issueDiagnostics,
        "SUPERSESSION_DRIFT",
        `$.issues[${normalized.nodes.indexOf(node)}].declaration.supersededBy`,
        "Explicit supersededBy evidence disagrees with the derived supersession inverse.",
        supersededBy,
        explicitInverse,
      );
    const childrenEvidence =
      normalized.scope === "unavailable" ? "unavailable" : children.length === 0 ? "empty" : "present";
    const blocksEvidence =
      normalized.scope === "unavailable" ? "unavailable" : blocks.length === 0 ? "empty" : "present";
    const parentEvidence = node.parent.status;
    const dependsOnEvidence = node.dependsOn.status;
    const role = declaration?.role;
    const completed: IssueReference[] = [];
    const remaining: IssueReference[] = [];
    let completionStatus: SemanticIssueLifecycleCompletionStatus = "not-declared";
    if (role === "tracker") {
      if (childrenEvidence === "unavailable") {
        completionStatus = "unknown";
        addDiagnostic(
          issueDiagnostics,
          "EVIDENCE_UNAVAILABLE",
          `$.issues[${normalized.nodes.indexOf(node)}].children`,
          "Complete child relation evidence is unavailable.",
        );
      } else if (children.length === 0) {
        completionStatus = "unknown";
        addDiagnostic(
          issueDiagnostics,
          "EVIDENCE_UNAVAILABLE",
          `$.issues[${normalized.nodes.indexOf(node)}].children`,
          "A tracker requires at least one observed child to derive completion.",
        );
      } else {
        for (const child of children) {
          const childNode = normalized.nodes.find(
            (candidate) => issueReferenceKey(candidate.reference) === issueReferenceKey(child),
          );
          const childState = childNode === undefined ? undefined : stateFor(childNode);
          if (childState === "closed") completed.push(child);
          else if (childState === "open") remaining.push(child);
          else
            addDiagnostic(
              issueDiagnostics,
              "EVIDENCE_UNAVAILABLE",
              `$.issues[${normalized.nodes.indexOf(node)}].children`,
              "A child Issue state is unavailable for completion derivation.",
            );
        }
        if (completed.length + remaining.length !== children.length) completionStatus = "unknown";
        else completionStatus = remaining.length === 0 ? "complete" : "in-progress";
      }
    } else if (role === "leaf") {
      const state = stateFor(node);
      if (state === undefined) {
        completionStatus = "unknown";
        addDiagnostic(
          issueDiagnostics,
          "EVIDENCE_UNAVAILABLE",
          `$.issues[${normalized.nodes.indexOf(node)}].observed.state`,
          "Leaf completion requires observed Issue state.",
        );
      } else completionStatus = state === "closed" ? "complete" : "in-progress";
      if (children.length > 0)
        addDiagnostic(
          issueDiagnostics,
          "ROLE_RELATION_DRIFT",
          `$.issues[${normalized.nodes.indexOf(node)}].declaration.role`,
          "A leaf Issue cannot have derived children.",
          [],
          children,
        );
    }
    if (node.checklist?.status === "present" && role === "tracker" && completionStatus !== "unknown") {
      if (!sameReferences(node.checklist.completed, completed) || !sameReferences(node.checklist.remaining, remaining))
        addDiagnostic(
          issueDiagnostics,
          "CHECKLIST_RELATION_DRIFT",
          `$.issues[${normalized.nodes.indexOf(node)}].checklist`,
          "Checklist completion disagrees with authoritative child state.",
          { completed, remaining },
          node.checklist,
        );
    } else if (node.checklist?.status === "unavailable") {
      addDiagnostic(
        issueDiagnostics,
        "EVIDENCE_UNAVAILABLE",
        `$.issues[${normalized.nodes.indexOf(node)}].checklist`,
        "Checklist evidence is unavailable.",
      );
    }
    if (node.observed?.state === "closed" && completionStatus === "in-progress")
      addDiagnostic(
        issueDiagnostics,
        "COMPLETION_DRIFT",
        `$.issues[${normalized.nodes.indexOf(node)}].observed.state`,
        "Issue is closed while authoritative child state still has a remainder.",
        "open",
        "closed",
      );
    for (const diagnostic of issueDiagnostics)
      addDiagnostic(
        diagnostics,
        diagnostic.code,
        diagnostic.path,
        diagnostic.message,
        diagnostic.expected,
        diagnostic.actual,
      );
    issues.push({
      reference: node.reference,
      ...(role === undefined ? {} : { role }),
      ...(node.parent.references[0] === undefined ? {} : { parent: node.parent.references[0] }),
      parentEvidence,
      children,
      childrenEvidence,
      dependsOn: node.dependsOn.references,
      dependsOnEvidence,
      blocks,
      blocksEvidence,
      supersedes,
      supersededBy: supersededByEffective,
      supersessionEvidence:
        normalized.scope === "unavailable" ? "unavailable" : supersededByEffective.length === 0 ? "empty" : "present",
      completion: {
        status: completionStatus,
        children,
        completed: completed.sort(compareReferences),
        remaining: remaining.sort(compareReferences),
        ...(remaining.length === 1 ? { finalGateRemainder: remaining[0] } : {}),
      },
      ...(node.checklist === undefined ? {} : { checklist: node.checklist }),
      drift: issueDiagnostics,
    });
  }
  const projection: SemanticIssueLifecycleProjection = {
    version: SEMANTIC_ISSUE_LIFECYCLE_VERSION,
    kind: "issue-lifecycle",
    scope: normalized.scope,
    issues,
  };
  return lifecycleResult(diagnostics, projection);
}

/** Throwing lifecycle projection entry point for Core callers. */
export function projectSemanticIssueLifecycle(input: unknown): SemanticIssueLifecycleProjection {
  const result = tryProjectSemanticIssueLifecycle(input);
  if (!result.valid || result.projection === undefined) throw new SemanticIssueLifecycleError(result.diagnostics);
  return result.projection;
}

export const tryProjectIssueLifecycle = tryProjectSemanticIssueLifecycle;
export const projectIssueLifecycle = projectSemanticIssueLifecycle;
export const observeSemanticIssueLifecycle = projectSemanticIssueLifecycle;
export const tryObserveSemanticIssueLifecycle = tryProjectSemanticIssueLifecycle;
