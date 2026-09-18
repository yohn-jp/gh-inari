/**
 * Core-owned, transport-neutral admission for Implementation dependencies.
 *
 * Adapters supply evidence already normalized by the existing lifecycle or
 * conformance authorities.  This module composes that evidence with the
 * canonical execution dependency graph; it does not inspect Issue prose or
 * treat Issue state as completion evidence.
 */

import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import {
  validateImplementationContract,
  type ImplementationContract,
  type ImplementationContractViolation,
} from "./implementation-contract.js";

export const IMPLEMENTATION_READINESS_ADMISSION_VERSION = 1 as const;
export type ImplementationReadinessAdmissionVersion = typeof IMPLEMENTATION_READINESS_ADMISSION_VERSION;
export const IMPLEMENTATION_READINESS_ADMISSION_KIND = "implementation-readiness-admission" as const;

export const IMPLEMENTATION_READINESS_CLASSIFICATIONS = Object.freeze(["READY", "BLOCKED", "INVALID"] as const);
export type ImplementationReadinessClassification = (typeof IMPLEMENTATION_READINESS_CLASSIFICATIONS)[number];

export const IMPLEMENTATION_DEPENDENCY_EVIDENCE_STATUSES = Object.freeze([
  "satisfied",
  "blocked",
  "active",
  "missing",
  "stale",
  "contradictory",
  "unavailable",
  "superseded",
] as const);
export type ImplementationDependencyEvidenceStatus = (typeof IMPLEMENTATION_DEPENDENCY_EVIDENCE_STATUSES)[number];

export const IMPLEMENTATION_DEPENDENCY_EVIDENCE_AUTHORITIES = Object.freeze([
  "implementation-conformance",
  "semantic-issue-lifecycle",
] as const);
export type ImplementationDependencyEvidenceAuthority = (typeof IMPLEMENTATION_DEPENDENCY_EVIDENCE_AUTHORITIES)[number];

export const IMPLEMENTATION_READINESS_LIMITS = Object.freeze({
  evidence: 1_000,
  diagnostics: 100,
  messageLength: 500,
} as const);

/** One dependency's normalized lifecycle/conformance evidence. */
export interface ImplementationDependencyReadinessEvidence {
  readonly reference: IssueReference;
  readonly authority: ImplementationDependencyEvidenceAuthority;
  readonly status: ImplementationDependencyEvidenceStatus;
  /** Currentness is explicit; an arbitrary Issue state is never substituted. */
  readonly freshness: "current" | "stale";
  /** Canonical execution dependencies for this dependency, or [] when it has none. */
  readonly dependencies: readonly IssueReference[];
  /** Explicit supersession evidence from the lifecycle authority. */
  readonly supersededBy?: readonly IssueReference[];
}

/** Input to the Core readiness boundary. */
export interface ImplementationReadinessAdmissionInput {
  readonly contract: ImplementationContract;
  readonly implementation: IssueReference;
  /** Omission is only admissible when the canonical contract has no dependencies. */
  readonly evidence?: readonly ImplementationDependencyReadinessEvidence[];
}

export type ImplementationReadinessDiagnosticCode =
  | "READINESS_INPUT_INVALID"
  | "READINESS_UNKNOWN_PROPERTY"
  | "READINESS_CONTRACT_INVALID"
  | "READINESS_IMPLEMENTATION_INVALID"
  | "READINESS_IMPLEMENTATION_REPOSITORY_MISMATCH"
  | "READINESS_EVIDENCE_UNAVAILABLE"
  | "READINESS_EVIDENCE_INVALID"
  | "READINESS_EVIDENCE_DUPLICATE"
  | "READINESS_EVIDENCE_EXTRA"
  | "READINESS_DEPENDENCY_EVIDENCE_MISSING"
  | "READINESS_DEPENDENCY_UNSATISFIED"
  | "READINESS_DEPENDENCY_STALE"
  | "READINESS_DEPENDENCY_CONTRADICTORY"
  | "READINESS_DEPENDENCY_SUPERSEDED"
  | "READINESS_DEPENDENCY_CYCLE"
  | "READINESS_SELF_DEPENDENCY";

export interface ImplementationReadinessDiagnostic {
  readonly code: ImplementationReadinessDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ImplementationReadinessAdmissionResult {
  readonly version: ImplementationReadinessAdmissionVersion;
  readonly kind: typeof IMPLEMENTATION_READINESS_ADMISSION_KIND;
  readonly valid: boolean;
  readonly admitted: boolean;
  readonly classification: ImplementationReadinessClassification;
  readonly implementation?: IssueReference;
  readonly evidence: readonly ImplementationDependencyReadinessEvidence[];
  /** Prose prerequisites are surfaced as asserted, never machine-satisfied. */
  readonly unverifiedPrerequisites: readonly string[];
  readonly diagnostics: readonly ImplementationReadinessDiagnostic[];
}

export class ImplementationReadinessAdmissionError extends Error {
  readonly diagnostics: readonly ImplementationReadinessDiagnostic[];
  readonly result: ImplementationReadinessAdmissionResult;

  constructor(result: ImplementationReadinessAdmissionResult) {
    super(result.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
    this.name = "ImplementationReadinessAdmissionError";
    this.diagnostics = result.diagnostics;
    this.result = result;
  }
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set(["contract", "implementation", "evidence"]);
const EVIDENCE_KEYS = new Set(["reference", "authority", "status", "freshness", "dependencies", "supersededBy"]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReferences(left: IssueReference, right: IssueReference): number {
  return issueReferenceKey(left).localeCompare(issueReferenceKey(right), "en-US");
}

function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  return normalized.length > IMPLEMENTATION_READINESS_LIMITS.messageLength
    ? `${normalized.slice(0, IMPLEMENTATION_READINESS_LIMITS.messageLength)}…`
    : normalized;
}

function addDiagnostic(
  diagnostics: ImplementationReadinessDiagnostic[],
  code: ImplementationReadinessDiagnosticCode,
  path: string,
  message: string,
): void {
  if (diagnostics.length < IMPLEMENTATION_READINESS_LIMITS.diagnostics)
    diagnostics.push({ code, path, message: boundedMessage(message) });
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ImplementationReadinessDiagnostic[],
): void {
  for (const key of Object.keys(value).sort(compareStrings))
    if (!allowed.has(key))
      addDiagnostic(diagnostics, "READINESS_UNKNOWN_PROPERTY", `${path}.${key}`, "Property is not supported.");
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

function invalidResult(
  diagnostics: readonly ImplementationReadinessDiagnostic[],
  values: {
    readonly implementation?: IssueReference;
    readonly evidence?: readonly ImplementationDependencyReadinessEvidence[];
    readonly unverifiedPrerequisites?: readonly string[];
  } = {},
): ImplementationReadinessAdmissionResult {
  return cloneImmutable({
    version: IMPLEMENTATION_READINESS_ADMISSION_VERSION,
    kind: IMPLEMENTATION_READINESS_ADMISSION_KIND,
    valid: false,
    admitted: false,
    classification: "INVALID" as const,
    ...(values.implementation === undefined ? {} : { implementation: values.implementation }),
    evidence: values.evidence ?? [],
    unverifiedPrerequisites: values.unverifiedPrerequisites ?? [],
    diagnostics: sortDiagnostics(diagnostics),
  });
}

function sortDiagnostics(
  diagnostics: readonly ImplementationReadinessDiagnostic[],
): readonly ImplementationReadinessDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en-US") ||
      left.code.localeCompare(right.code, "en-US") ||
      left.message.localeCompare(right.message, "en-US"),
  );
}

function normalizeReference(
  value: unknown,
  path: string,
  diagnostics: ImplementationReadinessDiagnostic[],
  code: ImplementationReadinessDiagnosticCode = "READINESS_EVIDENCE_INVALID",
): IssueReference | undefined {
  const result = normalizeIssueReference(value, path);
  if (!result.valid || result.reference === undefined) {
    addDiagnostic(diagnostics, code, path, "Issue reference is invalid.");
    return undefined;
  }
  return result.reference;
}

function normalizeReferenceList(
  value: unknown,
  path: string,
  diagnostics: ImplementationReadinessDiagnostic[],
): IssueReference[] | undefined {
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "READINESS_EVIDENCE_INVALID", path, "Dependency references must be an array.");
    return undefined;
  }
  const references: IssueReference[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const reference = normalizeReference(entry, `${path}[${index}]`, diagnostics);
    if (reference === undefined) return;
    const key = issueReferenceKey(reference);
    if (seen.has(key)) {
      addDiagnostic(diagnostics, "READINESS_EVIDENCE_DUPLICATE", `${path}[${index}]`, "References must be unique.");
      return;
    }
    seen.add(key);
    references.push(reference);
  });
  return references.sort(compareReferences);
}

function normalizeEvidence(
  value: unknown,
  diagnostics: ImplementationReadinessDiagnostic[],
): ImplementationDependencyReadinessEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addDiagnostic(diagnostics, "READINESS_EVIDENCE_INVALID", "$.evidence", "Readiness evidence must be an array.");
    return undefined;
  }
  if (value.length > IMPLEMENTATION_READINESS_LIMITS.evidence)
    addDiagnostic(
      diagnostics,
      "READINESS_EVIDENCE_INVALID",
      "$.evidence",
      "Readiness evidence exceeds the bounded limit.",
    );
  const seen = new Set<string>();
  const evidence: ImplementationDependencyReadinessEvidence[] = [];
  value.forEach((entry, index) => {
    const path = `$.evidence[${index}]`;
    if (!isRecord(entry)) {
      addDiagnostic(diagnostics, "READINESS_EVIDENCE_INVALID", path, "Dependency evidence must be an object.");
      return;
    }
    unknownProperties(entry, EVIDENCE_KEYS, path, diagnostics);
    const reference = normalizeReference(entry.reference, `${path}.reference`, diagnostics);
    const authority = entry.authority;
    if (
      !IMPLEMENTATION_DEPENDENCY_EVIDENCE_AUTHORITIES.includes(authority as ImplementationDependencyEvidenceAuthority)
    )
      addDiagnostic(
        diagnostics,
        "READINESS_EVIDENCE_INVALID",
        `${path}.authority`,
        "Evidence authority is unsupported.",
      );
    const status = entry.status;
    if (!IMPLEMENTATION_DEPENDENCY_EVIDENCE_STATUSES.includes(status as ImplementationDependencyEvidenceStatus))
      addDiagnostic(diagnostics, "READINESS_EVIDENCE_INVALID", `${path}.status`, "Evidence status is unsupported.");
    const freshness = entry.freshness;
    if (freshness !== "current" && freshness !== "stale")
      addDiagnostic(
        diagnostics,
        "READINESS_EVIDENCE_INVALID",
        `${path}.freshness`,
        "Evidence freshness must be current or stale.",
      );
    const dependencies = normalizeReferenceList(entry.dependencies, `${path}.dependencies`, diagnostics);
    const supersededBy =
      entry.supersededBy === undefined
        ? undefined
        : normalizeReferenceList(entry.supersededBy, `${path}.supersededBy`, diagnostics);
    if (reference === undefined || dependencies === undefined) return;
    const key = issueReferenceKey(reference);
    if (seen.has(key)) {
      addDiagnostic(
        diagnostics,
        "READINESS_EVIDENCE_DUPLICATE",
        `${path}.reference`,
        "Dependency evidence must be unique.",
      );
      return;
    }
    seen.add(key);
    if (
      !IMPLEMENTATION_DEPENDENCY_EVIDENCE_AUTHORITIES.includes(
        authority as ImplementationDependencyEvidenceAuthority,
      ) ||
      !IMPLEMENTATION_DEPENDENCY_EVIDENCE_STATUSES.includes(status as ImplementationDependencyEvidenceStatus) ||
      (freshness !== "current" && freshness !== "stale")
    )
      return;
    evidence.push({
      reference,
      authority: authority as ImplementationDependencyEvidenceAuthority,
      status: status as ImplementationDependencyEvidenceStatus,
      freshness,
      dependencies,
      ...(supersededBy === undefined ? {} : { supersededBy }),
    });
  });
  return evidence.sort((left, right) => compareReferences(left.reference, right.reference));
}

function appendContractDiagnostics(
  diagnostics: ImplementationReadinessDiagnostic[],
  violations: readonly ImplementationContractViolation[],
): void {
  for (const violation of violations)
    addDiagnostic(diagnostics, "READINESS_CONTRACT_INVALID", violation.path, violation.message);
}

function sameRepository(left: IssueReference, right: ImplementationContract): boolean {
  return left.repositoryHost === right.repository.repositoryHost && left.repositoryId === right.repository.repositoryId;
}

function dependencyPath(
  reference: IssueReference,
  evidence: readonly ImplementationDependencyReadinessEvidence[],
  contract: ImplementationContract,
): string {
  const index = evidence.findIndex((entry) => issueReferenceKey(entry.reference) === issueReferenceKey(reference));
  if (index >= 0) return `$.evidence[${index}]`;
  const contractIndex = contract.execution.dependencies.findIndex(
    (entry) => issueReferenceKey(entry) === issueReferenceKey(reference),
  );
  return contractIndex >= 0 ? `$.contract.execution.dependencies[${contractIndex}]` : "$.evidence";
}

function classifyDependencyStatuses(
  reachable: readonly IssueReference[],
  evidenceByKey: ReadonlyMap<string, ImplementationDependencyReadinessEvidence>,
  diagnostics: ImplementationReadinessDiagnostic[],
  contract: ImplementationContract,
  evidence: readonly ImplementationDependencyReadinessEvidence[],
): { readonly blocked: boolean; readonly invalid: boolean } {
  let blocked = false;
  let invalid = false;
  for (const reference of reachable) {
    const item = evidenceByKey.get(issueReferenceKey(reference));
    const path = dependencyPath(reference, evidence, contract);
    if (item === undefined) {
      addDiagnostic(
        diagnostics,
        "READINESS_DEPENDENCY_EVIDENCE_MISSING",
        path,
        "Current dependency lifecycle or conformance evidence is required.",
      );
      invalid = true;
      continue;
    }
    if (item.freshness === "stale" || item.status === "stale") {
      addDiagnostic(diagnostics, "READINESS_DEPENDENCY_STALE", path, "Dependency evidence is stale.");
      invalid = true;
    } else if (item.status === "contradictory") {
      addDiagnostic(diagnostics, "READINESS_DEPENDENCY_CONTRADICTORY", path, "Dependency evidence is contradictory.");
      invalid = true;
    } else if (item.status === "superseded" || (item.supersededBy?.length ?? 0) > 0) {
      addDiagnostic(diagnostics, "READINESS_DEPENDENCY_SUPERSEDED", path, "Dependency evidence is superseded.");
      invalid = true;
    } else if (item.status === "missing" || item.status === "unavailable") {
      addDiagnostic(diagnostics, "READINESS_DEPENDENCY_EVIDENCE_MISSING", path, "Dependency evidence is unavailable.");
      invalid = true;
    } else if (item.status === "blocked" || item.status === "active") {
      addDiagnostic(diagnostics, "READINESS_DEPENDENCY_UNSATISFIED", path, "Dependency is not satisfied.");
      blocked = true;
    }
  }
  return { blocked, invalid };
}

function graphDiagnostics(
  contract: ImplementationContract,
  implementation: IssueReference,
  evidence: readonly ImplementationDependencyReadinessEvidence[],
  evidenceByKey: ReadonlyMap<string, ImplementationDependencyReadinessEvidence>,
  diagnostics: ImplementationReadinessDiagnostic[],
): { readonly reachable: readonly IssueReference[]; readonly invalid: boolean } {
  const rootKey = issueReferenceKey(implementation);
  const reachable = new Map<string, IssueReference>();
  const adjacency = new Map<string, readonly IssueReference[]>();
  adjacency.set(rootKey, contract.execution.dependencies);
  const queue = [...contract.execution.dependencies];
  for (const dependency of contract.execution.dependencies) reachable.set(issueReferenceKey(dependency), dependency);
  let invalid = false;
  for (const dependency of contract.execution.dependencies) {
    if (issueReferenceKey(dependency) === rootKey) {
      addDiagnostic(
        diagnostics,
        "READINESS_SELF_DEPENDENCY",
        "$.contract.execution.dependencies",
        "An Implementation cannot depend on itself.",
      );
      invalid = true;
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as IssueReference;
    const currentKey = issueReferenceKey(current);
    const item = evidenceByKey.get(currentKey);
    if (item === undefined) continue;
    adjacency.set(currentKey, item.dependencies);
    for (const dependency of item.dependencies) {
      if (issueReferenceKey(dependency) === currentKey) {
        addDiagnostic(
          diagnostics,
          "READINESS_SELF_DEPENDENCY",
          `${dependencyPath(current, evidence, contract)}.dependencies`,
          "A dependency cannot depend on itself.",
        );
        invalid = true;
      }
      if (issueReferenceKey(dependency) === rootKey) {
        addDiagnostic(
          diagnostics,
          "READINESS_DEPENDENCY_CYCLE",
          `${dependencyPath(current, evidence, contract)}.dependencies`,
          "Dependency graph contains a cycle back to the Implementation.",
        );
        invalid = true;
      }
      const key = issueReferenceKey(dependency);
      if (!reachable.has(key)) {
        reachable.set(key, dependency);
        queue.push(dependency);
      }
    }
  }

  for (const item of evidence) {
    const key = issueReferenceKey(item.reference);
    if (!reachable.has(key)) {
      addDiagnostic(
        diagnostics,
        "READINESS_EVIDENCE_EXTRA",
        "$.evidence",
        "Evidence is not part of the canonical dependency graph.",
      );
      invalid = true;
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reported = new Set<string>();
  const visit = (key: string, path: readonly string[]): void => {
    if (visiting.has(key)) {
      const cycleStart = path.indexOf(key);
      const cycle = [...path.slice(cycleStart < 0 ? 0 : cycleStart), key].join("->");
      if (!reported.has(cycle)) {
        reported.add(cycle);
        addDiagnostic(diagnostics, "READINESS_DEPENDENCY_CYCLE", "$.evidence", "Dependency graph contains a cycle.");
      }
      invalid = true;
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const edges = adjacency.get(key) ?? [];
    for (const edge of edges) {
      const edgeKey = issueReferenceKey(edge);
      if (edgeKey === key) {
        addDiagnostic(
          diagnostics,
          "READINESS_SELF_DEPENDENCY",
          "$.evidence",
          "Dependency graph contains a self-dependency.",
        );
        invalid = true;
      } else visit(edgeKey, [...path, edgeKey]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  visit(rootKey, [rootKey]);
  for (const key of [...reachable.keys()].sort(compareStrings)) visit(key, [key]);
  return { reachable: [...reachable.values()].sort(compareReferences), invalid };
}

/** Return a deterministic, fail-closed readiness result. */
export function tryAdmitImplementationReadiness(input: unknown): ImplementationReadinessAdmissionResult {
  const diagnostics: ImplementationReadinessDiagnostic[] = [];
  if (!isRecord(input)) {
    addDiagnostic(diagnostics, "READINESS_INPUT_INVALID", "$", "Readiness admission input must be an object.");
    return invalidResult(diagnostics);
  }
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);

  const contractResult = validateImplementationContract(input.contract);
  if (!contractResult.valid || contractResult.contract === undefined) {
    appendContractDiagnostics(diagnostics, contractResult.violations);
    return invalidResult(diagnostics);
  }
  const contract = contractResult.contract;
  const implementation = normalizeReference(
    input.implementation,
    "$.implementation",
    diagnostics,
    "READINESS_IMPLEMENTATION_INVALID",
  );
  if (implementation !== undefined && !sameRepository(implementation, contract))
    addDiagnostic(
      diagnostics,
      "READINESS_IMPLEMENTATION_REPOSITORY_MISMATCH",
      "$.implementation",
      "Implementation identity belongs to a different repository than the contract.",
    );
  const unverifiedPrerequisites = [...contract.constraints.prerequisites];
  const evidence = normalizeEvidence(input.evidence, diagnostics);
  const canonicalDependencies = contract.execution.dependencies;
  if (evidence === undefined && canonicalDependencies.length > 0)
    addDiagnostic(
      diagnostics,
      "READINESS_EVIDENCE_UNAVAILABLE",
      "$.evidence",
      "Dependency evidence is required before Implementation authorization.",
    );
  const normalizedEvidence = evidence ?? [];
  const evidenceByKey = new Map(normalizedEvidence.map((item) => [issueReferenceKey(item.reference), item]));
  const graph =
    implementation === undefined
      ? { reachable: [] as readonly IssueReference[], invalid: true }
      : graphDiagnostics(contract, implementation, normalizedEvidence, evidenceByKey, diagnostics);
  const reachableEvidence = normalizedEvidence.filter((item) =>
    graph.reachable.some((reference) => issueReferenceKey(reference) === issueReferenceKey(item.reference)),
  );
  const statuses = classifyDependencyStatuses(
    graph.reachable,
    evidenceByKey,
    diagnostics,
    contract,
    normalizedEvidence,
  );
  if (
    implementation === undefined ||
    diagnostics.some((diagnostic) => diagnostic.code === "READINESS_UNKNOWN_PROPERTY")
  )
    return invalidResult(diagnostics, { implementation, evidence: reachableEvidence, unverifiedPrerequisites });
  const hasNonBlockingDiagnostics = diagnostics.some(
    (diagnostic) => diagnostic.code !== "READINESS_DEPENDENCY_UNSATISFIED",
  );
  if (graph.invalid || statuses.invalid || hasNonBlockingDiagnostics)
    return invalidResult(diagnostics, { implementation, evidence: reachableEvidence, unverifiedPrerequisites });
  if (statuses.blocked)
    return cloneImmutable({
      version: IMPLEMENTATION_READINESS_ADMISSION_VERSION,
      kind: IMPLEMENTATION_READINESS_ADMISSION_KIND,
      valid: false,
      admitted: false,
      classification: "BLOCKED" as const,
      implementation,
      evidence: reachableEvidence,
      unverifiedPrerequisites,
      diagnostics: sortDiagnostics(diagnostics),
    });
  return cloneImmutable({
    version: IMPLEMENTATION_READINESS_ADMISSION_VERSION,
    kind: IMPLEMENTATION_READINESS_ADMISSION_KIND,
    valid: true,
    admitted: true,
    classification: "READY" as const,
    implementation,
    evidence: reachableEvidence,
    unverifiedPrerequisites,
    diagnostics: sortDiagnostics(diagnostics),
  });
}

/** Throw when the dependency graph is not currently admissible. */
export function admitImplementationReadiness(input: unknown): ImplementationReadinessAdmissionResult {
  const result = tryAdmitImplementationReadiness(input);
  if (!result.admitted) throw new ImplementationReadinessAdmissionError(result);
  return result;
}

export const tryProjectImplementationReadiness = tryAdmitImplementationReadiness;
export const projectImplementationReadiness = admitImplementationReadiness;
