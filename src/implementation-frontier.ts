/**
 * Pure, transport-neutral readiness projection for governed implementation
 * work.  This module composes the existing Issue, Implementation, and Change
 * authorities.  It never schedules, mutates a provider, or creates execution
 * state.
 */

import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import {
  tryProjectSemanticIssueLifecycle,
  type SemanticIssueLifecycleIssueProjection,
  type SemanticIssueLifecycleNode,
  type SemanticIssueLifecycleProjection,
} from "./semantic-issue-lifecycle.js";
import { validateChangeProjectionResult, type ChangeProjectionResult } from "./change.js";
import { validateImplementationContract, type ImplementationContract } from "./implementation-contract.js";
import {
  tryVerifyImplementationAuthorization,
  type ImplementationAuthorizationInspectionResult,
} from "./implementation-authorization.js";
import { tryVerifyImplementationConformance, type ImplementationConformanceResult } from "./implementation-conformance.js";
import {
  tryParseImplementationExecutionEvidence,
  type ImplementationExecutionEvidence,
} from "./implementation-execution-evidence.js";

export const IMPLEMENTATION_FRONTIER_VERSION = 1 as const;
export type ImplementationFrontierVersion = typeof IMPLEMENTATION_FRONTIER_VERSION;
export const IMPLEMENTATION_FRONTIER_KIND = "implementation-frontier" as const;

export const IMPLEMENTATION_FRONTIER_CLASSIFICATIONS = Object.freeze([
  "READY",
  "BLOCKED",
  "ACTIVE",
  "SATISFIED",
  "INVALID",
] as const);
export type ImplementationFrontierClassification = (typeof IMPLEMENTATION_FRONTIER_CLASSIFICATIONS)[number];

export const IMPLEMENTATION_FRONTIER_LIMITS = Object.freeze({
  candidates: 1_000,
  dependencies: 1_000,
  diagnostics: 100,
  messageLength: 500,
} as const);

/** A candidate carries existing authority projections; it is not provider data. */
export interface ImplementationFrontierCandidateInput {
  readonly reference: IssueReference;
  /** A projected Semantic Issue lifecycle entry, when not supplied in `lifecycle`. */
  readonly issue?: unknown;
  readonly lifecycle?: unknown;
  /** Compatibility spelling for adapters that call the Issue evidence semantic. */
  readonly semantic?: unknown;
  /** A canonical Implementation contract and its existing evidence, if present. */
  readonly implementation?: unknown;
  /** A current Change projection, if a Change exists for this candidate. */
  readonly change?: unknown;
  readonly changeProjection?: unknown;
  /** Observed Issue state is metadata only and never establishes completion. */
  readonly state?: "open" | "closed";
}

/**
 * Input to the frontier projector. `lifecycle` may be an existing lifecycle
 * projection; `issues` may be the existing lifecycle projector's raw input.
 * Keeping both forms lets adapters pass their already-validated Core result
 * without introducing a transport-specific envelope.
 */
export interface ImplementationFrontierInput {
  readonly version?: ImplementationFrontierVersion;
  readonly kind?: "implementation-frontier-input";
  readonly scope?: "complete" | "unavailable";
  readonly lifecycle?: unknown;
  readonly issues?: unknown;
  readonly candidates: readonly ImplementationFrontierCandidateInput[];
}

export type ImplementationFrontierDiagnosticCode =
  | "FRONTIER_INPUT_INVALID"
  | "FRONTIER_INPUT_UNKNOWN_PROPERTY"
  | "FRONTIER_REFERENCE_INVALID"
  | "FRONTIER_CANDIDATE_DUPLICATE"
  | "FRONTIER_EVIDENCE_MISSING"
  | "FRONTIER_EVIDENCE_UNAVAILABLE"
  | "FRONTIER_SEMANTIC_EVIDENCE_INVALID"
  | "FRONTIER_IMPLEMENTATION_INVALID"
  | "FRONTIER_AUTHORIZATION_INVALID"
  | "FRONTIER_EXECUTION_EVIDENCE_INVALID"
  | "FRONTIER_CONFORMANCE_INVALID"
  | "FRONTIER_CHANGE_INVALID"
  | "FRONTIER_CHANGE_STALE"
  | "FRONTIER_CHANGE_TERMINAL"
  | "FRONTIER_CONTRADICTORY_EVIDENCE"
  | "FRONTIER_DEPENDENCY_MISSING"
  | "FRONTIER_DEPENDENCY_BLOCKED"
  | "FRONTIER_DEPENDENCY_CYCLE"
  | "FRONTIER_SELF_DEPENDENCY"
  | "FRONTIER_CLOSED_ISSUE_UNPROVEN";

export interface ImplementationFrontierDiagnostic {
  readonly code: ImplementationFrontierDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface ImplementationFrontierCandidateProjection {
  readonly reference: IssueReference;
  readonly classification: ImplementationFrontierClassification;
  readonly dependencies: readonly IssueReference[];
  readonly satisfiedDependencies: readonly IssueReference[];
  readonly unsatisfiedDependencies: readonly IssueReference[];
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

export interface ImplementationFrontierParallelGroup {
  readonly items: readonly IssueReference[];
}

export interface ImplementationFrontierProjection {
  readonly version: ImplementationFrontierVersion;
  readonly kind: typeof IMPLEMENTATION_FRONTIER_KIND;
  readonly valid: boolean;
  readonly candidates: readonly ImplementationFrontierCandidateProjection[];
  readonly ready: readonly IssueReference[];
  /** Dependency-only parallel groups; this does not assert write-set safety. */
  readonly parallelReadyGroups: readonly ImplementationFrontierParallelGroup[];
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

export interface ImplementationFrontierResult {
  readonly valid: boolean;
  readonly projection?: ImplementationFrontierProjection;
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

export class ImplementationFrontierError extends Error {
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];

  constructor(diagnostics: readonly ImplementationFrontierDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "ImplementationFrontierError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

type RecordValue = Record<string, unknown>;

interface LifecycleIssueEvidence {
  readonly reference: IssueReference;
  readonly dependsOn: readonly IssueReference[];
  readonly dependencyEvidence: "present" | "empty" | "unavailable";
  readonly state?: "open" | "closed";
  readonly invalid: boolean;
}

interface LifecycleEvidence {
  readonly scope: "complete" | "unavailable";
  readonly issues: ReadonlyMap<string, LifecycleIssueEvidence>;
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

interface ImplementationEvidence {
  readonly contract?: ImplementationContract;
  readonly authorizationInspection?: ImplementationAuthorizationInspectionResult;
  readonly conformance?: ImplementationConformanceResult;
  readonly executionEvidence?: ImplementationExecutionEvidence;
  readonly satisfied: boolean;
  readonly active: boolean;
  readonly invalid: boolean;
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

interface ChangeEvidence {
  readonly satisfied: boolean;
  readonly active: boolean;
  readonly invalid: boolean;
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

interface NormalizedCandidate {
  readonly reference: IssueReference;
  readonly issue?: LifecycleIssueEvidence;
  readonly implementation: ImplementationEvidence;
  readonly change: ChangeEvidence;
  readonly dependencies: readonly IssueReference[];
  readonly diagnostics: ImplementationFrontierDiagnostic[];
}

const INPUT_KEYS = new Set(["version", "kind", "scope", "lifecycle", "issues", "candidates"]);
const CANDIDATE_KEYS = new Set([
  "reference",
  "issue",
  "lifecycle",
  "semantic",
  "implementation",
  "change",
  "changeProjection",
  "state",
]);
const IMPLEMENTATION_KEYS = new Set(["contract", "authorization", "conformance", "executionEvidence"]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareReferences(left: IssueReference, right: IssueReference): number {
  return issueReferenceKey(left).localeCompare(issueReferenceKey(right), "en-US");
}

function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  return normalized.length > IMPLEMENTATION_FRONTIER_LIMITS.messageLength
    ? `${normalized.slice(0, IMPLEMENTATION_FRONTIER_LIMITS.messageLength)}…`
    : normalized;
}

function addDiagnostic(
  diagnostics: ImplementationFrontierDiagnostic[],
  code: ImplementationFrontierDiagnosticCode,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  if (diagnostics.length >= IMPLEMENTATION_FRONTIER_LIMITS.diagnostics) return;
  diagnostics.push({
    code,
    path,
    message: boundedMessage(message),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ImplementationFrontierDiagnostic[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key))
      addDiagnostic(
        diagnostics,
        "FRONTIER_INPUT_UNKNOWN_PROPERTY",
        `${path}.${key}`,
        `Property "${key}" is not supported by the Implementation Frontier projection.`,
      );
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
  diagnostics: ImplementationFrontierDiagnostic[],
): readonly IssueReference[] {
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "FRONTIER_SEMANTIC_EVIDENCE_INVALID", path, "Dependencies must be an array.");
    return [];
  }
  if (value.length > IMPLEMENTATION_FRONTIER_LIMITS.dependencies) {
    addDiagnostic(diagnostics, "FRONTIER_SEMANTIC_EVIDENCE_INVALID", path, "Dependencies exceed the bounded limit.");
    return [];
  }
  const seen = new Set<string>();
  const references: IssueReference[] = [];
  value.forEach((entry, index) => {
    const result = normalizeIssueReference(entry, `${path}[${index}]`);
    if (!result.valid || result.reference === undefined) {
      addDiagnostic(diagnostics, "FRONTIER_REFERENCE_INVALID", `${path}[${index}]`, "Dependency reference is invalid.");
      return;
    }
    const key = issueReferenceKey(result.reference);
    if (seen.has(key)) {
      addDiagnostic(
        diagnostics,
        "FRONTIER_CONTRADICTORY_EVIDENCE",
        `${path}[${index}]`,
        "Dependency references must be unique.",
      );
      return;
    }
    seen.add(key);
    references.push(result.reference);
  });
  return references.sort(compareReferences);
}

function normalizeReference(
  value: unknown,
  path: string,
  diagnostics: ImplementationFrontierDiagnostic[],
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addDiagnostic(diagnostics, "FRONTIER_REFERENCE_INVALID", path, "Issue reference is invalid.");
    return undefined;
  }
  return result.reference;
}

function sameReference(left: IssueReference, right: IssueReference): boolean {
  return issueReferenceKey(left) === issueReferenceKey(right);
}

function normalizeState(
  value: unknown,
  path: string,
  diagnostics: ImplementationFrontierDiagnostic[],
): "open" | "closed" | undefined {
  if (value === undefined) return undefined;
  if (value !== "open" && value !== "closed") {
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", path, "Observed Issue state must be open or closed.");
    return undefined;
  }
  return value;
}

function diagnosticFromForeign(diagnostics: ImplementationFrontierDiagnostic[], path: string, message: string): void {
  addDiagnostic(diagnostics, "FRONTIER_SEMANTIC_EVIDENCE_INVALID", path, message);
}

function lifecycleIssueFromProjection(
  value: unknown,
  path: string,
  diagnostics: ImplementationFrontierDiagnostic[],
  state?: "open" | "closed",
): LifecycleIssueEvidence | undefined {
  if (!isRecord(value)) {
    diagnosticFromForeign(diagnostics, path, "Semantic Issue lifecycle evidence must be an object.");
    return undefined;
  }
  const reference = normalizeReference(value.reference, `${path}.reference`, diagnostics);
  if (reference === undefined) return undefined;
  const dependencyEvidence = value.dependsOnEvidence;
  if (dependencyEvidence !== "present" && dependencyEvidence !== "empty" && dependencyEvidence !== "unavailable") {
    diagnosticFromForeign(diagnostics, `${path}.dependsOnEvidence`, "Semantic dependency evidence is invalid.");
  }
  const dependsOn = normalizeReferences(value.dependsOn, `${path}.dependsOn`, diagnostics);
  const drift = value.drift;
  if (!Array.isArray(drift)) {
    diagnosticFromForeign(diagnostics, `${path}.drift`, "Semantic lifecycle drift evidence is unavailable.");
  }
  const completion = isRecord(value.completion) ? value.completion : undefined;
  const inferredState =
    state ??
    (value.role === "leaf" && completion?.status === "complete"
      ? "closed"
      : value.role === "leaf" && completion?.status === "in-progress"
        ? "open"
        : undefined);
  return {
    reference,
    dependsOn,
    dependencyEvidence:
      dependencyEvidence === "present" || dependencyEvidence === "empty" || dependencyEvidence === "unavailable"
        ? dependencyEvidence
        : "unavailable",
    ...(inferredState === undefined ? {} : { state: inferredState }),
    invalid:
      (Array.isArray(drift) && drift.length > 0) ||
      (dependencyEvidence !== "present" && dependencyEvidence !== "empty" && dependencyEvidence !== "unavailable"),
  };
}

function lifecycleProjectionFromOutput(
  value: unknown,
  path: string,
  diagnostics: ImplementationFrontierDiagnostic[],
): LifecycleEvidence | undefined {
  if (!isRecord(value)) {
    diagnosticFromForeign(diagnostics, path, "Semantic Issue lifecycle projection must be an object.");
    return undefined;
  }
  if (value.version !== "1" || value.kind !== "issue-lifecycle" || !Array.isArray(value.issues)) {
    diagnosticFromForeign(diagnostics, path, "Semantic Issue lifecycle projection version or shape is invalid.");
    return undefined;
  }
  if (value.scope !== "complete" && value.scope !== "unavailable") {
    diagnosticFromForeign(diagnostics, `${path}.scope`, "Semantic Issue lifecycle scope is invalid.");
    return undefined;
  }
  const issues = new Map<string, LifecycleIssueEvidence>();
  value.issues.forEach((entry, index) => {
    const issue = lifecycleIssueFromProjection(entry, `${path}.issues[${index}]`, diagnostics);
    if (issue !== undefined) {
      const key = issueReferenceKey(issue.reference);
      if (issues.has(key))
        addDiagnostic(
          diagnostics,
          "FRONTIER_CANDIDATE_DUPLICATE",
          `${path}.issues[${index}].reference`,
          "Semantic lifecycle Issue references must be unique.",
        );
      else issues.set(key, issue);
    }
  });
  return { scope: value.scope, issues, diagnostics: [] };
}

function lifecycleFromRawIssues(
  value: unknown,
  scope: "complete" | "unavailable",
  path: string,
  diagnostics: ImplementationFrontierDiagnostic[],
): LifecycleEvidence | undefined {
  if (!Array.isArray(value)) {
    diagnosticFromForeign(diagnostics, path, "Semantic Issue lifecycle input must contain an Issue array.");
    return undefined;
  }
  const result = tryProjectSemanticIssueLifecycle({ scope, issues: value as readonly SemanticIssueLifecycleNode[] });
  if (result.projection === undefined) {
    for (const entry of result.diagnostics) diagnosticFromForeign(diagnostics, entry.path, entry.message);
    return undefined;
  }
  for (const entry of result.diagnostics) diagnosticFromForeign(diagnostics, entry.path, entry.message);
  const output = lifecycleProjectionFromOutput(result.projection, path, diagnostics);
  if (output === undefined) return undefined;
  const stateByKey = new Map<string, "open" | "closed">();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const reference = normalizeIssueReference(entry.reference);
    const observed = isRecord(entry.observed) ? entry.observed : undefined;
    if (
      reference.valid &&
      reference.reference !== undefined &&
      (observed?.state === "open" || observed?.state === "closed")
    )
      stateByKey.set(issueReferenceKey(reference.reference), observed.state);
  }
  const issues = new Map<string, LifecycleIssueEvidence>();
  for (const issue of output.issues.values()) {
    const state = stateByKey.get(issueReferenceKey(issue.reference));
    issues.set(issueReferenceKey(issue.reference), { ...issue, ...(state === undefined ? {} : { state }) });
  }
  return { ...output, issues };
}

function normalizeLifecycle(
  input: RecordValue,
  candidateValues: readonly RecordValue[],
  diagnostics: ImplementationFrontierDiagnostic[],
): LifecycleEvidence {
  const scope = input.scope === "unavailable" ? "unavailable" : "complete";
  const lifecycleValue = input.lifecycle;
  if (lifecycleValue !== undefined) {
    if (isRecord(lifecycleValue) && lifecycleValue.kind === "issue-lifecycle") {
      return (
        lifecycleProjectionFromOutput(lifecycleValue, "$.lifecycle", diagnostics) ?? {
          scope: "unavailable",
          issues: new Map(),
          diagnostics: [],
        }
      );
    }
    return (
      lifecycleFromRawIssues(lifecycleValue, scope, "$.lifecycle", diagnostics) ?? {
        scope: "unavailable",
        issues: new Map(),
        diagnostics: [],
      }
    );
  }
  if (input.issues !== undefined) {
    if (isRecord(input.issues) && input.issues.kind === "issue-lifecycle") {
      return (
        lifecycleProjectionFromOutput(input.issues, "$.issues", diagnostics) ?? {
          scope: "unavailable",
          issues: new Map(),
          diagnostics: [],
        }
      );
    }
    return (
      lifecycleFromRawIssues(input.issues, scope, "$.issues", diagnostics) ?? {
        scope: "unavailable",
        issues: new Map(),
        diagnostics: [],
      }
    );
  }
  const issues = new Map<string, LifecycleIssueEvidence>();
  candidateValues.forEach((candidate, index) => {
    const value = candidate.lifecycle ?? candidate.issue ?? candidate.semantic;
    if (value === undefined) return;
    const path = `$.candidates[${index}].issue`;
    const issue =
      isRecord(value) && hasOwn(value, "observed")
        ? lifecycleFromRawIssues([value], scope, path, diagnostics)?.issues.values().next().value
        : lifecycleIssueFromProjection(
            value,
            path,
            diagnostics,
            normalizeState(candidate.state, `$.candidates[${index}].state`, diagnostics),
          );
    if (issue !== undefined) issues.set(issueReferenceKey(issue.reference), issue);
  });
  return { scope, issues, diagnostics: [] };
}

/**
 * Authorization and conformance are re-derived here from the same
 * authoritative functions the CLI/MCP use, never trusted as caller-supplied
 * flags. `input.authorization` must be a raw `ImplementationAuthorizationVerificationInput`
 * (record + current body/repository/base evidence); `input.conformance` must
 * be a raw `ImplementationConformanceInput` (authorization record + current
 * Issue/PR evidence). Both are pure and reproduce currency from that
 * evidence instead of accepting an already-computed status.
 */
function normalizeImplementation(
  value: unknown,
  path: string,
  reference: IssueReference,
  diagnostics: ImplementationFrontierDiagnostic[],
): ImplementationEvidence {
  if (value === undefined) {
    return { satisfied: false, active: false, invalid: false, diagnostics: [] };
  }
  const local: ImplementationFrontierDiagnostic[] = [];
  let input: RecordValue;
  if (
    isRecord(value) &&
    (hasOwn(value, "contract") ||
      hasOwn(value, "authorization") ||
      hasOwn(value, "conformance") ||
      hasOwn(value, "executionEvidence"))
  ) {
    input = value;
    unknownProperties(input, IMPLEMENTATION_KEYS, path, local);
  } else {
    input = { contract: value };
  }
  let contract: ImplementationContract | undefined;
  if (input.contract !== undefined) {
    const result = validateImplementationContract(input.contract);
    if (!result.valid || result.contract === undefined)
      addDiagnostic(
        local,
        "FRONTIER_IMPLEMENTATION_INVALID",
        `${path}.contract`,
        "Implementation contract is invalid.",
      );
    else contract = result.contract;
  }

  let authorizationInspection: ImplementationAuthorizationInspectionResult | undefined;
  if (input.authorization !== undefined) {
    if (!isRecord(input.authorization) || input.authorization.authorization === undefined) {
      addDiagnostic(
        local,
        "FRONTIER_AUTHORIZATION_INVALID",
        `${path}.authorization`,
        "Authorization evidence must include a canonical authorization record.",
      );
    } else {
      const suppliedImplementation = input.authorization.implementation;
      if (
        suppliedImplementation !== undefined &&
        !sameReference(normalizeIssueReference(suppliedImplementation).reference ?? reference, reference)
      )
        addDiagnostic(
          local,
          "FRONTIER_CONTRADICTORY_EVIDENCE",
          `${path}.authorization.implementation`,
          "Authorization targets a different Issue than the frontier candidate.",
          reference,
          suppliedImplementation,
        );
      authorizationInspection = tryVerifyImplementationAuthorization({
        ...input.authorization,
        implementation: reference,
      });
      if (!authorizationInspection.authorized || !authorizationInspection.current)
        addDiagnostic(
          local,
          "FRONTIER_AUTHORIZATION_INVALID",
          `${path}.authorization`,
          "Authorization is not currently valid.",
        );
    }
  }

  let conformance: ImplementationConformanceResult | undefined;
  if (input.conformance !== undefined) {
    if (!isRecord(input.conformance) || input.conformance.authorization === undefined) {
      addDiagnostic(
        local,
        "FRONTIER_CONFORMANCE_INVALID",
        `${path}.conformance`,
        "Conformance evidence must include a canonical authorization record.",
      );
    } else {
      const suppliedIssue = isRecord(input.conformance.issue) ? input.conformance.issue.reference : undefined;
      if (
        suppliedIssue !== undefined &&
        !sameReference(normalizeIssueReference(suppliedIssue).reference ?? reference, reference)
      )
        addDiagnostic(
          local,
          "FRONTIER_CONTRADICTORY_EVIDENCE",
          `${path}.conformance.issue.reference`,
          "Conformance targets a different Issue than the frontier candidate.",
          reference,
          suppliedIssue,
        );
      conformance = tryVerifyImplementationConformance(input.conformance);
      if (!conformance.valid || conformance.status !== "conformant")
        addDiagnostic(
          local,
          "FRONTIER_CONFORMANCE_INVALID",
          `${path}.conformance`,
          "Conformance evidence does not prove completed work.",
        );
    }
  }

  let executionEvidence: ImplementationExecutionEvidence | undefined;
  if (input.executionEvidence !== undefined) {
    const result = tryParseImplementationExecutionEvidence(input.executionEvidence);
    if (!result.valid || result.evidence === undefined)
      addDiagnostic(
        local,
        "FRONTIER_EXECUTION_EVIDENCE_INVALID",
        `${path}.executionEvidence`,
        "Execution evidence is invalid.",
      );
    else if (!sameReference(result.evidence.implementation, reference))
      addDiagnostic(
        local,
        "FRONTIER_CONTRADICTORY_EVIDENCE",
        `${path}.executionEvidence.implementation`,
        "Execution evidence targets a different Issue than the frontier candidate.",
      );
    else if (
      authorizationInspection?.authorization !== undefined &&
      (authorizationInspection.authorization.governedBodyDigest !== result.evidence.governedBodyDigest ||
        authorizationInspection.authorization.base.revision !== result.evidence.base.revision)
    )
      addDiagnostic(
        local,
        "FRONTIER_CONTRADICTORY_EVIDENCE",
        `${path}.executionEvidence`,
        "Execution evidence does not bind to the current authorization.",
      );
    else executionEvidence = result.evidence;
  }

  // Conformance is the strongest completion evidence; a completed and
  // currently-authorized authorization inspection is the other authoritative
  // completion path. Either must be freshly re-verified, never a bare flag.
  const authorizationCompleted =
    authorizationInspection !== undefined &&
    authorizationInspection.authorized &&
    authorizationInspection.current &&
    authorizationInspection.status === "completed";
  const satisfied =
    (conformance !== undefined && conformance.valid && conformance.status === "conformant") ||
    authorizationCompleted;
  // Execution evidence alone never proves ACTIVE (checked above, it only
  // corroborates an already-current authorization); ACTIVE always requires a
  // freshly re-verified current authorization.
  const active =
    !satisfied &&
    authorizationInspection !== undefined &&
    authorizationInspection.authorized &&
    authorizationInspection.current &&
    authorizationInspection.status === "authorized";

  diagnostics.push(...local);
  return {
    ...(contract === undefined ? {} : { contract }),
    ...(authorizationInspection === undefined ? {} : { authorizationInspection }),
    ...(conformance === undefined ? {} : { conformance }),
    ...(executionEvidence === undefined ? {} : { executionEvidence }),
    satisfied,
    active,
    invalid: local.length > 0,
    diagnostics: local,
  };
}

function normalizeChange(
  value: unknown,
  path: string,
  reference: IssueReference,
  diagnostics: ImplementationFrontierDiagnostic[],
): ChangeEvidence {
  if (value === undefined) return { satisfied: false, active: false, invalid: false, diagnostics: [] };
  const local: ImplementationFrontierDiagnostic[] = [];
  const projectionValue = isRecord(value) && isRecord(value.projection) ? value.projection : value;
  const result = validateChangeProjectionResult(projectionValue);
  if (!result.valid || result.projection === undefined) {
    addDiagnostic(local, "FRONTIER_CHANGE_INVALID", path, "Change projection is invalid.");
  } else {
    const projection = result.projection;
    const change = projection.change;
    if (projection.status === "absent") {
      // An explicitly absent Change is valid evidence that no Change is active.
    } else if (projection.status !== "healthy" || change === undefined) {
      addDiagnostic(
        local,
        "FRONTIER_CHANGE_STALE",
        path,
        "Change evidence is partial, ambiguous, or unavailable and cannot admit a new start.",
      );
    } else if (
      !sameReference(
        {
          repositoryHost: change.identity.repositoryHost,
          repositoryId: change.identity.repositoryId,
          number: change.identity.rootIssue,
        },
        reference,
      )
    ) {
      addDiagnostic(
        local,
        "FRONTIER_CONTRADICTORY_EVIDENCE",
        `${path}.change.identity`,
        "Change targets a different Issue.",
      );
    } else if (change.state === "MERGED") {
      return { satisfied: true, active: false, invalid: false, diagnostics: [] };
    } else if (change.state === "ABORTED") {
      addDiagnostic(
        local,
        "FRONTIER_CHANGE_TERMINAL",
        path,
        "An aborted Change is terminal and cannot be re-admitted as READY from the same Implementation candidate.",
      );
    } else if (change.state === "DRAFT" || change.state === "REVIEW" || change.state === "ACCEPTED") {
      return { satisfied: false, active: true, invalid: false, diagnostics: [] };
    }
  }
  diagnostics.push(...local);
  return { satisfied: false, active: false, invalid: local.length > 0, diagnostics: local };
}

function unionReferences(...groups: readonly (readonly IssueReference[])[]): readonly IssueReference[] {
  const map = new Map<string, IssueReference>();
  for (const group of groups) for (const reference of group) map.set(issueReferenceKey(reference), reference);
  return [...map.values()].sort(compareReferences);
}

function normalizeInput(
  input: unknown,
  diagnostics: ImplementationFrontierDiagnostic[],
): { readonly candidates: readonly RecordValue[]; readonly lifecycle: LifecycleEvidence } | undefined {
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$", "Frontier input must be an object.");
    return undefined;
  }
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);
  if (input.version !== undefined && input.version !== IMPLEMENTATION_FRONTIER_VERSION)
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$.version", "Frontier input version is unsupported.");
  if (input.kind !== undefined && input.kind !== "implementation-frontier-input")
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$.kind", "Frontier input kind is unsupported.");
  if (input.scope !== undefined && input.scope !== "complete" && input.scope !== "unavailable")
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$.scope", "Frontier scope is invalid.");
  if (!Array.isArray(input.candidates)) {
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$.candidates", "Frontier candidates must be an array.");
    return undefined;
  }
  if (input.candidates.length > IMPLEMENTATION_FRONTIER_LIMITS.candidates)
    addDiagnostic(
      diagnostics,
      "FRONTIER_INPUT_INVALID",
      "$.candidates",
      "Frontier candidates exceed the bounded limit.",
    );
  const candidates: RecordValue[] = [];
  input.candidates.forEach((entry, index) => {
    const path = `$.candidates[${index}]`;
    if (!isRecord(entry)) {
      addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", path, "Frontier candidate must be an object.");
      return;
    }
    unknownProperties(entry, CANDIDATE_KEYS, path, diagnostics);
    if (normalizeIssueReference(entry.reference, `${path}.reference`).valid) candidates.push(entry);
    else
      addDiagnostic(diagnostics, "FRONTIER_REFERENCE_INVALID", `${path}.reference`, "Candidate reference is invalid.");
  });
  const seen = new Set<string>();
  for (const [index, entry] of candidates.entries()) {
    const reference = normalizeIssueReference(entry.reference).reference;
    if (reference === undefined) continue;
    const key = issueReferenceKey(reference);
    if (seen.has(key))
      addDiagnostic(
        diagnostics,
        "FRONTIER_CANDIDATE_DUPLICATE",
        `$.candidates[${index}].reference`,
        "Candidate references must be unique.",
      );
    seen.add(key);
  }
  const lifecycle = normalizeLifecycle(input, candidates, diagnostics);
  return { candidates, lifecycle };
}

function dependencyCycles(candidates: readonly NormalizedCandidate[]): ReadonlySet<string> {
  const byKey = new Map(candidates.map((candidate) => [issueReferenceKey(candidate.reference), candidate]));
  const colors = new Map<string, 0 | 1 | 2>();
  const cycle = new Set<string>();
  const visit = (key: string, stack: readonly string[]): void => {
    const color = colors.get(key) ?? 0;
    if (color === 2) return;
    if (color === 1) {
      const start = stack.indexOf(key);
      for (const entry of (start < 0 ? stack : stack.slice(start)).concat(key)) cycle.add(entry);
      return;
    }
    colors.set(key, 1);
    const candidate = byKey.get(key);
    if (candidate !== undefined) {
      for (const dependency of candidate.dependencies) {
        const dependencyKey = issueReferenceKey(dependency);
        if (byKey.has(dependencyKey)) visit(dependencyKey, [...stack, key]);
      }
    }
    colors.set(key, 2);
  };
  for (const candidate of candidates) visit(issueReferenceKey(candidate.reference), []);
  return cycle;
}

function parallelGroups(
  ready: readonly ImplementationFrontierCandidateProjection[],
): readonly ImplementationFrontierParallelGroup[] {
  const groups: IssueReference[][] = [];
  const readyKeys = new Set(ready.map((candidate) => issueReferenceKey(candidate.reference)));
  const dependencies = new Map(
    ready.map((candidate) => [
      issueReferenceKey(candidate.reference),
      new Set(candidate.dependencies.map((dependency) => issueReferenceKey(dependency))),
    ]),
  );
  for (const candidate of ready) {
    const key = issueReferenceKey(candidate.reference);
    let placed = false;
    for (const group of groups) {
      const conflicts = group.some((entry) => {
        const entryKey = issueReferenceKey(entry);
        return dependencies.get(key)?.has(entryKey) === true || dependencies.get(entryKey)?.has(key) === true;
      });
      if (!conflicts) {
        group.push(candidate.reference);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([candidate.reference]);
  }
  return groups.map((items) => ({ items: Object.freeze([...items].sort(compareReferences)) }));
}

/** Project the deterministic implementation readiness frontier. */
export function tryProjectImplementationFrontier(input: unknown): ImplementationFrontierResult {
  const inputDiagnostics: ImplementationFrontierDiagnostic[] = [];
  const normalized = normalizeInput(input, inputDiagnostics);
  if (normalized === undefined) return { valid: false, diagnostics: Object.freeze([...inputDiagnostics]) };

  const candidates: NormalizedCandidate[] = [];
  normalized.candidates.forEach((entry, index) => {
    const path = `$.candidates[${index}]`;
    const referenceResult = normalizeIssueReference(entry.reference, `${path}.reference`);
    if (!referenceResult.valid || referenceResult.reference === undefined) return;
    const reference = referenceResult.reference;
    const localDiagnostics: ImplementationFrontierDiagnostic[] = [];
    const globalIssue = normalized.lifecycle.issues.get(issueReferenceKey(reference));
    const candidateLocalValue = entry.lifecycle ?? entry.issue ?? entry.semantic;
    const candidateLocalIssue =
      candidateLocalValue === undefined
        ? undefined
        : lifecycleIssueFromProjection(
            candidateLocalValue,
            `${path}.issue`,
            localDiagnostics,
            normalizeState(entry.state, `${path}.state`, localDiagnostics),
          );
    if (globalIssue !== undefined && candidateLocalIssue !== undefined) {
      const sameDependencies =
        globalIssue.dependsOn.length === candidateLocalIssue.dependsOn.length &&
        globalIssue.dependsOn.every((dependency, position) =>
          sameReference(dependency, candidateLocalIssue.dependsOn[position] as IssueReference),
        );
      if (
        !sameReference(globalIssue.reference, candidateLocalIssue.reference) ||
        globalIssue.state !== candidateLocalIssue.state ||
        !sameDependencies
      )
        addDiagnostic(
          localDiagnostics,
          "FRONTIER_CONTRADICTORY_EVIDENCE",
          `${path}.issue`,
          "Candidate-local Issue evidence disagrees with the batch Semantic Issue lifecycle evidence.",
        );
    }
    const issue = globalIssue ?? candidateLocalIssue;
    if (issue === undefined) {
      addDiagnostic(
        localDiagnostics,
        "FRONTIER_EVIDENCE_MISSING",
        `${path}.issue`,
        "Semantic Issue lifecycle evidence is required.",
      );
    } else {
      if (!sameReference(issue.reference, reference))
        addDiagnostic(
          localDiagnostics,
          "FRONTIER_CONTRADICTORY_EVIDENCE",
          `${path}.issue.reference`,
          "Issue evidence targets a different candidate.",
        );
      if (issue.invalid)
        addDiagnostic(
          localDiagnostics,
          "FRONTIER_SEMANTIC_EVIDENCE_INVALID",
          `${path}.issue`,
          "Semantic Issue evidence contains drift or contradiction.",
        );
      if (issue.dependencyEvidence === "unavailable")
        addDiagnostic(
          localDiagnostics,
          "FRONTIER_EVIDENCE_UNAVAILABLE",
          `${path}.issue.dependsOn`,
          "Semantic dependency evidence is unavailable.",
        );
    }
    const implementation = normalizeImplementation(
      entry.implementation,
      `${path}.implementation`,
      reference,
      localDiagnostics,
    );
    const change = normalizeChange(
      entry.changeProjection ?? entry.change,
      `${path}.change`,
      reference,
      localDiagnostics,
    );
    const hasSemanticDependencyEvidence =
      issue !== undefined && (issue.dependencyEvidence === "present" || issue.dependencyEvidence === "empty");
    const semanticDependencies = issue?.dependsOn ?? [];
    const contractDependencies = implementation.contract?.execution.dependencies ?? [];
    const hasContractDependencyEvidence = implementation.contract !== undefined;
    if (hasSemanticDependencyEvidence && hasContractDependencyEvidence) {
      const semanticKeys = new Set(semanticDependencies.map((dependency) => issueReferenceKey(dependency)));
      const contractKeys = new Set(contractDependencies.map((dependency) => issueReferenceKey(dependency)));
      const agree =
        semanticKeys.size === contractKeys.size && [...semanticKeys].every((key) => contractKeys.has(key));
      if (!agree)
        addDiagnostic(
          localDiagnostics,
          "FRONTIER_CONTRADICTORY_EVIDENCE",
          `${path}.dependencies`,
          "Semantic Issue dependencies disagree with the canonical Implementation contract dependencies.",
        );
    }
    const dependencies = unionReferences(
      hasSemanticDependencyEvidence ? semanticDependencies : [],
      hasContractDependencyEvidence ? contractDependencies : [],
    );
    for (const dependency of dependencies)
      if (sameReference(dependency, reference))
        addDiagnostic(
          localDiagnostics,
          "FRONTIER_SELF_DEPENDENCY",
          `${path}.dependencies`,
          "A candidate cannot depend on itself.",
        );
    if (
      normalized.lifecycle.scope === "unavailable" &&
      !implementation.satisfied &&
      !implementation.active &&
      !change.satisfied &&
      !change.active
    )
      addDiagnostic(
        localDiagnostics,
        "FRONTIER_EVIDENCE_UNAVAILABLE",
        `${path}.lifecycle`,
        "Complete Issue graph evidence is required for readiness.",
      );
    candidates.push({
      reference,
      ...(issue === undefined ? {} : { issue }),
      implementation,
      change,
      dependencies,
      diagnostics: localDiagnostics,
    });
  });

  const cycleKeys = dependencyCycles(candidates);
  const byKey = new Map(candidates.map((candidate) => [issueReferenceKey(candidate.reference), candidate]));
  const classifications = new Map<string, ImplementationFrontierClassification>();
  const classify = (
    candidate: NormalizedCandidate,
    visiting: ReadonlySet<string>,
  ): ImplementationFrontierClassification => {
    const key = issueReferenceKey(candidate.reference);
    const known = classifications.get(key);
    if (known !== undefined) return known;
    if (cycleKeys.has(key)) {
      classifications.set(key, "INVALID");
      return "INVALID";
    }
    if (visiting.has(key)) return "INVALID";
    if (candidate.diagnostics.length > 0 || candidate.implementation.invalid || candidate.change.invalid) {
      classifications.set(key, "INVALID");
      return "INVALID";
    }
    if (candidate.implementation.satisfied || candidate.change.satisfied) {
      classifications.set(key, "SATISFIED");
      return "SATISFIED";
    }
    if (candidate.implementation.active || candidate.change.active) {
      classifications.set(key, "ACTIVE");
      return "ACTIVE";
    }
    if (candidate.issue?.state === "closed") {
      classifications.set(key, "INVALID");
      return "INVALID";
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(key);
    let blocked = false;
    for (const dependency of candidate.dependencies) {
      const dependencyCandidate = byKey.get(issueReferenceKey(dependency));
      if (dependencyCandidate === undefined) {
        // A dependency reference with no candidate evidence in the bounded
        // input is incomplete graph evidence, not a proven ordinary blocker.
        classifications.set(key, "INVALID");
        return "INVALID";
      }
      if (classify(dependencyCandidate, nextVisiting) !== "SATISFIED") blocked = true;
    }
    classifications.set(key, blocked ? "BLOCKED" : "READY");
    return blocked ? "BLOCKED" : "READY";
  };
  for (const candidate of candidates) classify(candidate, new Set());
  const projected: ImplementationFrontierCandidateProjection[] = [];
  for (const candidate of candidates.sort((left, right) => compareReferences(left.reference, right.reference))) {
    const key = issueReferenceKey(candidate.reference);
    const diagnostics = [...candidate.diagnostics];
    if (cycleKeys.has(key))
      addDiagnostic(
        diagnostics,
        "FRONTIER_DEPENDENCY_CYCLE",
        "$.dependencies",
        "Dependency cycles cannot produce READY work.",
      );
    const dependencyStatuses = candidate.dependencies.map((dependency) => {
      const dependencyCandidate = byKey.get(issueReferenceKey(dependency));
      return {
        dependency,
        classification:
          dependencyCandidate === undefined
            ? undefined
            : (classifications.get(issueReferenceKey(dependency)) ?? classify(dependencyCandidate, new Set())),
      };
    });
    const satisfiedDependencies = dependencyStatuses
      .filter((entry) => entry.classification === "SATISFIED")
      .map((entry) => entry.dependency);
    const unsatisfiedDependencies = dependencyStatuses
      .filter((entry) => entry.classification !== "SATISFIED")
      .map((entry) => entry.dependency);
    for (const entry of dependencyStatuses) {
      if (entry.classification === undefined)
        addDiagnostic(
          diagnostics,
          "FRONTIER_DEPENDENCY_MISSING",
          "$.dependencies",
          "Dependency candidate evidence is missing.",
        );
      else if (entry.classification !== "SATISFIED")
        addDiagnostic(diagnostics, "FRONTIER_DEPENDENCY_BLOCKED", "$.dependencies", "A prerequisite is not SATISFIED.");
    }
    const classification = classifications.get(key) ?? "INVALID";
    if (classification === "INVALID" && candidate.issue?.state === "closed" && candidate.diagnostics.length === 0) {
      addDiagnostic(
        diagnostics,
        "FRONTIER_CLOSED_ISSUE_UNPROVEN",
        "$.state",
        "Closed Issue state alone cannot prove SATISFIED or READY.",
      );
    }
    projected.push({
      reference: candidate.reference,
      classification,
      dependencies: candidate.dependencies,
      satisfiedDependencies,
      unsatisfiedDependencies,
      diagnostics: Object.freeze(
        [...diagnostics].sort(
          (left, right) => left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US"),
        ),
      ),
    });
  }

  const ready = projected.filter((candidate) => candidate.classification === "READY");
  const projectionDiagnostics = [...inputDiagnostics, ...projected.flatMap((candidate) => candidate.diagnostics)]
    .sort((left, right) => left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US"))
    .slice(0, IMPLEMENTATION_FRONTIER_LIMITS.diagnostics);
  const projection: ImplementationFrontierProjection = {
    version: IMPLEMENTATION_FRONTIER_VERSION,
    kind: IMPLEMENTATION_FRONTIER_KIND,
    valid: projected.every((candidate) => candidate.classification !== "INVALID") && inputDiagnostics.length === 0,
    candidates: projected,
    ready: ready.map((candidate) => candidate.reference),
    parallelReadyGroups: parallelGroups(ready),
    diagnostics: projectionDiagnostics,
  };
  return {
    valid: projection.valid,
    projection: cloneImmutable(projection),
    diagnostics: cloneImmutable(projectionDiagnostics),
  };
}

/** Throwing entry point for callers that require a usable frontier. */
export function projectImplementationFrontier(input: unknown): ImplementationFrontierProjection {
  const result = tryProjectImplementationFrontier(input);
  if (!result.valid || result.projection === undefined) throw new ImplementationFrontierError(result.diagnostics);
  return result.projection;
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  throw new TypeError("Frontier projections must be JSON-compatible values.");
}

/** Serialize a validated versioned frontier projection deterministically. */
export function serializeImplementationFrontierProjection(input: unknown): string {
  const result = validateImplementationFrontierProjection(input);
  if (!result.valid || result.projection === undefined) throw new ImplementationFrontierError(result.diagnostics);
  return stableSerialize(result.projection);
}

export interface ImplementationFrontierProjectionValidationResult {
  readonly valid: boolean;
  readonly projection?: ImplementationFrontierProjection;
  readonly diagnostics: readonly ImplementationFrontierDiagnostic[];
}

/** Validate a serialized frontier result at an adapter boundary. */
export function validateImplementationFrontierProjection(
  input: unknown,
): ImplementationFrontierProjectionValidationResult {
  const diagnostics: ImplementationFrontierDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$", "Frontier projection must be an object.");
    return { valid: false, diagnostics };
  }
  const allowed = new Set(["version", "kind", "valid", "candidates", "ready", "parallelReadyGroups", "diagnostics"]);
  unknownProperties(input, allowed, "$", diagnostics);
  if (
    input.version !== IMPLEMENTATION_FRONTIER_VERSION ||
    input.kind !== IMPLEMENTATION_FRONTIER_KIND ||
    typeof input.valid !== "boolean"
  )
    addDiagnostic(
      diagnostics,
      "FRONTIER_INPUT_INVALID",
      "$",
      "Frontier projection version, kind, or validity is invalid.",
    );
  if (
    !Array.isArray(input.candidates) ||
    !Array.isArray(input.ready) ||
    !Array.isArray(input.parallelReadyGroups) ||
    !Array.isArray(input.diagnostics)
  )
    addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", "$", "Frontier projection collections are invalid.");
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  const validateProjectionDiagnostics = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", path, "Projection diagnostics must be an array.");
      return;
    }
    value.forEach((entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.code !== "string" ||
        typeof entry.path !== "string" ||
        typeof entry.message !== "string"
      )
        addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", `${path}[${index}]`, "Projection diagnostic is invalid.");
    });
  };
  validateProjectionDiagnostics(input.diagnostics, "$.diagnostics");
  const candidateKeys = new Set([
    "reference",
    "classification",
    "dependencies",
    "satisfiedDependencies",
    "unsatisfiedDependencies",
    "diagnostics",
  ]);
  const seenCandidateKeys = new Set<string>();
  const candidateInfo = new Map<string, { readonly classification: ImplementationFrontierClassification }>();
  (input.candidates as readonly unknown[]).forEach((entry, index) => {
    const path = `$.candidates[${index}]`;
    if (!isRecord(entry)) {
      addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", path, "Frontier candidate projection is invalid.");
      return;
    }
    unknownProperties(entry, candidateKeys, path, diagnostics);
    const reference = normalizeIssueReference(entry.reference, `${path}.reference`);
    if (!reference.valid)
      addDiagnostic(diagnostics, "FRONTIER_REFERENCE_INVALID", `${path}.reference`, "Candidate reference is invalid.");
    const validClassification = IMPLEMENTATION_FRONTIER_CLASSIFICATIONS.includes(
      entry.classification as ImplementationFrontierClassification,
    );
    if (!validClassification)
      addDiagnostic(
        diagnostics,
        "FRONTIER_INPUT_INVALID",
        `${path}.classification`,
        "Candidate classification is invalid.",
      );
    const dependencies = normalizeReferences(entry.dependencies, `${path}.dependencies`, diagnostics);
    const satisfiedDependencies = normalizeReferences(
      entry.satisfiedDependencies,
      `${path}.satisfiedDependencies`,
      diagnostics,
    );
    const unsatisfiedDependencies = normalizeReferences(
      entry.unsatisfiedDependencies,
      `${path}.unsatisfiedDependencies`,
      diagnostics,
    );
    const dependencyKeys = new Set(dependencies.map((dependency) => issueReferenceKey(dependency)));
    const satisfiedKeys = new Set(satisfiedDependencies.map((dependency) => issueReferenceKey(dependency)));
    const unsatisfiedKeys = new Set(unsatisfiedDependencies.map((dependency) => issueReferenceKey(dependency)));
    for (const key of satisfiedKeys)
      if (unsatisfiedKeys.has(key))
        addDiagnostic(
          diagnostics,
          "FRONTIER_INPUT_INVALID",
          `${path}.satisfiedDependencies`,
          "A dependency cannot be both satisfied and unsatisfied.",
        );
    const partitionKeys = new Set([...satisfiedKeys, ...unsatisfiedKeys]);
    const partitionAgrees =
      partitionKeys.size === dependencyKeys.size && [...partitionKeys].every((key) => dependencyKeys.has(key));
    if (!partitionAgrees)
      addDiagnostic(
        diagnostics,
        "FRONTIER_INPUT_INVALID",
        `${path}.dependencies`,
        "Satisfied and unsatisfied dependencies must exactly partition the dependency set.",
      );
    const entryDiagnostics = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
    validateProjectionDiagnostics(entryDiagnostics, `${path}.diagnostics`);
    if (reference.valid && reference.reference !== undefined && validClassification) {
      const key = issueReferenceKey(reference.reference);
      if (seenCandidateKeys.has(key))
        addDiagnostic(
          diagnostics,
          "FRONTIER_CANDIDATE_DUPLICATE",
          `${path}.reference`,
          "Candidate references must be unique.",
        );
      seenCandidateKeys.add(key);
      candidateInfo.set(key, { classification: entry.classification as ImplementationFrontierClassification });
    }
  });
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  const readyReferences = normalizeReferences(input.ready, "$.ready", diagnostics);
  const readyKeys = new Set(readyReferences.map((reference) => issueReferenceKey(reference)));
  const expectedReadyKeys = new Set(
    [...candidateInfo.entries()].filter(([, info]) => info.classification === "READY").map(([key]) => key),
  );
  if (readyKeys.size !== expectedReadyKeys.size || [...readyKeys].some((key) => !expectedReadyKeys.has(key)))
    addDiagnostic(
      diagnostics,
      "FRONTIER_INPUT_INVALID",
      "$.ready",
      "The ready set must exactly equal the READY-classified candidates.",
    );

  const seenGroupKeys = new Set<string>();
  (input.parallelReadyGroups as readonly unknown[]).forEach((entry, index) => {
    const path = `$.parallelReadyGroups[${index}]`;
    if (!isRecord(entry) || !Array.isArray(entry.items)) {
      addDiagnostic(diagnostics, "FRONTIER_INPUT_INVALID", path, "Parallel group is invalid.");
      return;
    }
    const items = normalizeReferences(entry.items, `${path}.items`, diagnostics);
    for (const item of items) {
      const key = issueReferenceKey(item);
      if (candidateInfo.get(key)?.classification !== "READY")
        addDiagnostic(
          diagnostics,
          "FRONTIER_INPUT_INVALID",
          `${path}.items`,
          "Parallel groups may only contain READY candidates.",
        );
      if (seenGroupKeys.has(key))
        addDiagnostic(
          diagnostics,
          "FRONTIER_CANDIDATE_DUPLICATE",
          `${path}.items`,
          "A READY candidate may appear in only one parallel group.",
        );
      seenGroupKeys.add(key);
    }
  });
  if (seenGroupKeys.size !== expectedReadyKeys.size || [...expectedReadyKeys].some((key) => !seenGroupKeys.has(key)))
    addDiagnostic(
      diagnostics,
      "FRONTIER_INPUT_INVALID",
      "$.parallelReadyGroups",
      "Every READY candidate must appear in exactly one parallel group.",
    );

  // `valid` is false whenever any candidate is INVALID; a projection with no
  // INVALID candidates may still carry ordinary BLOCKED-dependency
  // diagnostics and remain valid (matching the projector's own definition).
  const anyInvalid = [...candidateInfo.values()].some((info) => info.classification === "INVALID");
  // A global (input-level) diagnostic is one that appears in the top-level
  // `diagnostics` but not in any single candidate's own `diagnostics` — the
  // serialized shape merges both, so this recovers the distinction.
  const candidateDiagnosticSignatures = new Set(
    (input.candidates as readonly RecordValue[]).flatMap((candidate) =>
      (Array.isArray(candidate.diagnostics) ? candidate.diagnostics : []).map((entry) => stableSerialize(entry)),
    ),
  );
  const hasGlobalDiagnostic = (input.diagnostics as readonly unknown[]).some(
    (entry) => !candidateDiagnosticSignatures.has(stableSerialize(entry)),
  );
  const expectedValid = !anyInvalid && !hasGlobalDiagnostic;
  if (input.valid !== expectedValid)
    addDiagnostic(
      diagnostics,
      "FRONTIER_INPUT_INVALID",
      "$.valid",
      "Projection validity is inconsistent with candidate classifications and input-level diagnostics.",
    );

  if (diagnostics.length > 0) return { valid: false, diagnostics };
  return {
    valid: true,
    projection: cloneImmutable(input as unknown as ImplementationFrontierProjection),
    diagnostics: [],
  };
}

export function deserializeImplementationFrontierProjection(serialized: string): ImplementationFrontierProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new ImplementationFrontierError([
      { code: "FRONTIER_INPUT_INVALID", path: "$", message: "Frontier projection JSON is invalid." },
    ]);
  }
  const result = validateImplementationFrontierProjection(parsed);
  if (!result.valid || result.projection === undefined) throw new ImplementationFrontierError(result.diagnostics);
  return result.projection;
}

export const tryProjectImplementationReadiness = tryProjectImplementationFrontier;
export const projectImplementationReadiness = projectImplementationFrontier;
