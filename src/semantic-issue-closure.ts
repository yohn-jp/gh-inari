/**
 * Pure admissibility and planning for one governed Issue close effect.
 *
 * Issue relations remain owned by the semantic Issue lifecycle projection.
 * Implementation and Change terminal state remain owned by their existing
 * authorities; this module only consumes their bounded results.  In
 * particular, an observed GitHub closed state is never treated as terminal
 * implementation evidence.
 */

import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "./contract/issue-reference.js";
import { validateChangeProjectionResult } from "./change.js";
import { tryProjectImplementationLifecycle } from "./implementation-lifecycle.js";
import {
  tryProjectSemanticIssueLifecycle,
  type SemanticIssueLifecycleIssueProjection,
  type SemanticIssueLifecycleProjection,
} from "./semantic-issue-lifecycle.js";

export const SEMANTIC_ISSUE_CLOSURE_VERSION = "1" as const;
export type SemanticIssueClosureVersion = typeof SEMANTIC_ISSUE_CLOSURE_VERSION;
export const SEMANTIC_ISSUE_CLOSURE_KIND = "issue-closure" as const;

export const SEMANTIC_ISSUE_CLOSURE_STATUSES = Object.freeze([
  "closable",
  "blocked",
  "already-closed",
  "unverifiable",
] as const);
export type SemanticIssueClosureStatus = (typeof SEMANTIC_ISSUE_CLOSURE_STATUSES)[number];

export const SEMANTIC_ISSUE_CLOSURE_TERMINAL_STATES = Object.freeze(["completed", "aborted", "merged"] as const);
export type SemanticIssueClosureTerminalState = (typeof SEMANTIC_ISSUE_CLOSURE_TERMINAL_STATES)[number];

/** Raw per-child terminal evidence, required for every tracker child before close. */
export interface SemanticIssueClosureChildEvidence {
  readonly reference: IssueReference;
  /** Raw #686 Implementation lifecycle evidence for this child, when applicable. */
  readonly implementation?: unknown;
  /** Raw #687 Change projection result for this child, when applicable. */
  readonly change?: unknown;
}

/** Evidence read from the existing lifecycle and terminal authorities. */
export interface SemanticIssueClosureEvidenceInput {
  readonly lifecycle: unknown;
  /** Raw #686 Implementation lifecycle evidence (authorization/conformance/change-identity reread), when this is a leaf. */
  readonly implementation?: unknown;
  /** Existing #687 Change projection result, when this is a leaf. */
  readonly change?: unknown;
  /** Per-child terminal evidence; every authoritative tracker child requires an entry. */
  readonly children?: readonly SemanticIssueClosureChildEvidence[];
}

/** Caller input for one explicit close-admissibility query. */
export interface SemanticIssueClosureInput extends SemanticIssueClosureEvidenceInput {
  readonly target: IssueReference;
  /** Close is intentionally not a default; callers must state it. */
  readonly intent?: "close";
}

export interface SemanticIssueClosureEffect {
  readonly kind: "CLOSE_ISSUE";
  readonly target: IssueReference;
}

export type SemanticIssueClosureTerminalEvidenceStatus = "terminal" | "active" | "absent" | "unverifiable";

export interface SemanticIssueClosureTerminalEvidenceProjection {
  readonly status: SemanticIssueClosureTerminalEvidenceStatus;
  readonly state?: SemanticIssueClosureTerminalState;
  readonly outcome?: "successful" | "aborted";
}

export interface SemanticIssueClosureProjection {
  readonly version: SemanticIssueClosureVersion;
  readonly kind: typeof SEMANTIC_ISSUE_CLOSURE_KIND;
  readonly target: IssueReference;
  readonly intent: "close";
  readonly status: SemanticIssueClosureStatus;
  readonly targetState: "open" | "closed";
  readonly role: "tracker" | "leaf";
  readonly lifecycle: {
    readonly completion: SemanticIssueLifecycleIssueProjection["completion"];
    readonly children: readonly IssueReference[];
    readonly childrenEvidence: SemanticIssueLifecycleIssueProjection["childrenEvidence"];
  };
  readonly terminalEvidence: Readonly<{
    readonly implementation: SemanticIssueClosureTerminalEvidenceProjection;
    readonly change: SemanticIssueClosureTerminalEvidenceProjection;
  }>;
  /** Per-child terminal evidence for a tracker's required children. */
  readonly childTerminalEvidence?: readonly {
    readonly reference: IssueReference;
    readonly implementation: SemanticIssueClosureTerminalEvidenceProjection;
    readonly change: SemanticIssueClosureTerminalEvidenceProjection;
  }[];
  readonly finalGateRemainder?: IssueReference;
  readonly effect?: SemanticIssueClosureEffect;
}

export type SemanticIssueClosureDiagnosticCode =
  | "CLOSURE_INPUT_INVALID"
  | "CLOSURE_INPUT_UNKNOWN_PROPERTY"
  | "CLOSURE_REFERENCE_INVALID"
  | "CLOSURE_INTENT_REQUIRED"
  | "CLOSURE_LIFECYCLE_INVALID"
  | "CLOSURE_TARGET_MISSING"
  | "CLOSURE_ROLE_UNDECLARED"
  | "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE"
  | "CLOSURE_RELATION_CYCLE"
  | "CLOSURE_TERMINAL_EVIDENCE_MISSING"
  | "CLOSURE_TERMINAL_EVIDENCE_INVALID"
  | "CLOSURE_TERMINAL_EVIDENCE_STALE"
  | "CLOSURE_TERMINAL_EVIDENCE_CONTRADICTORY"
  | "CLOSURE_NOT_ADMISSIBLE";

export interface SemanticIssueClosureDiagnostic {
  readonly code: SemanticIssueClosureDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface SemanticIssueClosureResult {
  readonly valid: boolean;
  readonly projection?: SemanticIssueClosureProjection;
  readonly diagnostics: readonly SemanticIssueClosureDiagnostic[];
}

export interface SemanticIssueClosurePlan {
  readonly version: SemanticIssueClosureVersion;
  readonly kind: "issue-close-plan";
  readonly request: {
    readonly target: IssueReference;
    readonly intent: "close";
  };
  readonly evidence: SemanticIssueClosureEvidenceInput;
  readonly admissibility: SemanticIssueClosureProjection;
  readonly effect?: SemanticIssueClosureEffect;
}

export interface SemanticIssueClosurePlanResult {
  readonly valid: boolean;
  readonly plan?: SemanticIssueClosurePlan;
  readonly projection?: SemanticIssueClosureProjection;
  readonly diagnostics: readonly SemanticIssueClosureDiagnostic[];
}

export class SemanticIssueClosureError extends Error {
  readonly diagnostics: readonly SemanticIssueClosureDiagnostic[];

  constructor(diagnostics: readonly SemanticIssueClosureDiagnostic[]) {
    super(diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
    this.name = "SemanticIssueClosureError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set(["target", "intent", "lifecycle", "implementation", "change", "children"]);
const CHILD_KEYS = new Set(["reference", "implementation", "change"]);
const PLAN_KEYS = new Set(["version", "kind", "request", "evidence", "admissibility", "effect"]);
const REQUEST_KEYS = new Set(["target", "intent"]);

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneImmutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => cloneImmutable(entry))) as T;
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) copy[key] = cloneImmutable(value[key]);
    return Object.freeze(copy) as T;
  }
  return value;
}

function diagnostic(
  code: SemanticIssueClosureDiagnosticCode,
  path: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): SemanticIssueClosureDiagnostic {
  return {
    code,
    path,
    message: message.replace(/\s+/gu, " ").trim(),
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

function unknownProperties(
  value: RecordValue,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: SemanticIssueClosureDiagnostic[],
): void {
  for (const key of Object.keys(value).sort())
    if (!allowed.has(key))
      diagnostics.push(
        diagnostic("CLOSURE_INPUT_UNKNOWN_PROPERTY", `${path}.${key}`, `Property "${key}" is not supported.`),
      );
}

function reference(
  value: unknown,
  path: string,
  diagnostics: SemanticIssueClosureDiagnostic[],
): IssueReference | undefined {
  const normalized = normalizeIssueReference(value, path);
  if (!normalized.valid || normalized.reference === undefined) {
    diagnostics.push(diagnostic("CLOSURE_REFERENCE_INVALID", path, "IssueReference is invalid."));
    return undefined;
  }
  return normalized.reference;
}

function sameReference(left: IssueReference, right: IssueReference): boolean {
  return issueReferenceKey(left) === issueReferenceKey(right);
}

function issueMap(
  projection: SemanticIssueLifecycleProjection,
): ReadonlyMap<string, SemanticIssueLifecycleIssueProjection> {
  return new Map(projection.issues.map((issue) => [issueReferenceKey(issue.reference), issue]));
}

function hasCycle(
  projection: SemanticIssueLifecycleProjection,
  edges: (issue: SemanticIssueLifecycleIssueProjection) => readonly IssueReference[],
): boolean {
  const known = issueMap(projection);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (reference: IssueReference): boolean => {
    const key = issueReferenceKey(reference);
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    const issue = known.get(key);
    if (issue === undefined) return false;
    visiting.add(key);
    for (const next of edges(issue)) if (visit(next)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  return projection.issues.some((issue) => visit(issue.reference));
}

function terminalEvidence(
  value: unknown,
  kind: "implementation" | "change",
  target: IssueReference,
  diagnostics: SemanticIssueClosureDiagnostic[],
  pathPrefix = "$",
): SemanticIssueClosureTerminalEvidenceProjection {
  if (value === undefined) return { status: "absent" };
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(
        "CLOSURE_TERMINAL_EVIDENCE_INVALID",
        `${pathPrefix}.${kind}`,
        `${kind} terminal evidence must be an object.`,
      ),
    );
    return { status: "unverifiable" };
  }

  if (kind === "implementation") {
    const result = tryProjectImplementationLifecycle(value);
    const implementation =
      result.authorization === undefined
        ? undefined
        : reference(
            result.authorization.implementation,
            `${pathPrefix}.implementation.authorization.implementation`,
            diagnostics,
          );
    if (implementation !== undefined && !sameReference(implementation, target)) {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_CONTRADICTORY",
          `${pathPrefix}.implementation.authorization.implementation`,
          "Implementation terminal evidence targets a different Issue.",
          target,
          implementation,
        ),
      );
      return { status: "unverifiable" };
    }
    if (
      result.valid !== true ||
      result.status === undefined ||
      result.authorization === undefined ||
      implementation === undefined
    ) {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_INVALID",
          `${pathPrefix}.implementation`,
          "Implementation lifecycle evidence is not a complete authoritative result.",
        ),
      );
      return { status: "unverifiable" };
    }
    if (result.violations.length > 0) {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_STALE",
          `${pathPrefix}.implementation.violations`,
          "Implementation terminal evidence contains violations.",
        ),
      );
      return { status: "unverifiable" };
    }
    if (result.status === "completed") {
      if (result.current !== true || result.authorized !== true) {
        diagnostics.push(
          diagnostic(
            "CLOSURE_TERMINAL_EVIDENCE_STALE",
            `${pathPrefix}.implementation`,
            "Completed Implementation evidence is not current and authorized.",
          ),
        );
        return { status: "unverifiable" };
      }
      return { status: "terminal", state: "completed", outcome: "successful" };
    }
    if (result.status === "aborted") {
      if (result.current !== false || result.authorized !== false) {
        diagnostics.push(
          diagnostic(
            "CLOSURE_TERMINAL_EVIDENCE_STALE",
            `${pathPrefix}.implementation`,
            "Aborted Implementation evidence has an inconsistent authority state.",
          ),
        );
        return { status: "unverifiable" };
      }
      return { status: "terminal", state: "aborted", outcome: "aborted" };
    }
    if (result.current !== true || result.authorized !== true) {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_STALE",
          `${pathPrefix}.implementation`,
          "Non-terminal Implementation evidence is not current and authorized.",
        ),
      );
      return { status: "unverifiable" };
    }
    return { status: "active" };
  }

  const changeResult = validateChangeProjectionResult(value);
  if (!changeResult.valid || changeResult.projection === undefined) {
    diagnostics.push(
      diagnostic(
        "CLOSURE_TERMINAL_EVIDENCE_INVALID",
        `${pathPrefix}.change`,
        "Change evidence is not a valid #687 projection result.",
      ),
    );
    return { status: "unverifiable" };
  }
  const projection = changeResult.projection;
  if (projection.status === "absent") return { status: "absent" };
  if (projection.status !== "healthy" || projection.change === undefined || projection.valid !== true) {
    diagnostics.push(
      diagnostic(
        "CLOSURE_TERMINAL_EVIDENCE_STALE",
        `${pathPrefix}.change`,
        "Change evidence is incomplete or unavailable.",
      ),
    );
    return { status: "unverifiable" };
  }
  const changeReference: IssueReference = {
    repositoryHost: projection.change.identity.repositoryHost,
    repositoryId: projection.change.identity.repositoryId,
    number: projection.change.identity.rootIssue,
  };
  if (!sameReference(changeReference, target)) {
    diagnostics.push(
      diagnostic(
        "CLOSURE_TERMINAL_EVIDENCE_CONTRADICTORY",
        `${pathPrefix}.change.change.identity`,
        "Change terminal evidence targets a different Issue.",
        target,
        changeReference,
      ),
    );
    return { status: "unverifiable" };
  }
  if (projection.change.state === "MERGED") return { status: "terminal", state: "merged", outcome: "successful" };
  if (projection.change.state === "ABORTED") return { status: "terminal", state: "aborted", outcome: "aborted" };
  return { status: "active" };
}

function combineTerminalEvidence(
  implementation: SemanticIssueClosureTerminalEvidenceProjection,
  change: SemanticIssueClosureTerminalEvidenceProjection,
  diagnostics: SemanticIssueClosureDiagnostic[],
): SemanticIssueClosureTerminalEvidenceStatus {
  if (implementation.status === "unverifiable" || change.status === "unverifiable") return "unverifiable";
  if (
    (implementation.status === "terminal" && change.status === "active") ||
    (implementation.status === "active" && change.status === "terminal")
  ) {
    diagnostics.push(
      diagnostic(
        "CLOSURE_TERMINAL_EVIDENCE_CONTRADICTORY",
        "$.terminalEvidence",
        "Implementation and Change evidence disagree about terminality.",
      ),
    );
    return "unverifiable";
  }
  if (implementation.status === "terminal" && change.status === "terminal") {
    if (implementation.outcome !== change.outcome) {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_CONTRADICTORY",
          "$.terminalEvidence",
          "Implementation and Change terminal outcomes disagree.",
        ),
      );
      return "unverifiable";
    }
    return "terminal";
  }
  if (implementation.status === "terminal" || change.status === "terminal") return "terminal";
  if (implementation.status === "active" || change.status === "active") return "active";
  return "absent";
}

function projectionResult(
  diagnostics: readonly SemanticIssueClosureDiagnostic[],
  projection: SemanticIssueClosureProjection,
): SemanticIssueClosureResult {
  return {
    valid: diagnostics.length === 0 && projection.status !== "unverifiable",
    projection: cloneImmutable(projection),
    diagnostics: Object.freeze([...diagnostics]),
  };
}

/** Project one bounded close-admissibility result without provider I/O. */
export function tryProjectSemanticIssueClosure(input: unknown): SemanticIssueClosureResult {
  const diagnostics: SemanticIssueClosureDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [diagnostic("CLOSURE_INPUT_INVALID", "$", "Issue closure input must be an object.")],
    };
  }
  unknownProperties(input, INPUT_KEYS, "$", diagnostics);
  const target = reference(input.target, "$.target", diagnostics);
  if (input.intent !== "close")
    diagnostics.push(
      diagnostic("CLOSURE_INTENT_REQUIRED", "$.intent", 'Issue closure requires explicit intent "close".'),
    );
  const lifecycleResult = tryProjectSemanticIssueLifecycle(input.lifecycle);
  diagnostics.push(
    ...lifecycleResult.diagnostics.map((entry) =>
      diagnostic("CLOSURE_LIFECYCLE_INVALID", entry.path, `Lifecycle evidence is invalid: ${entry.message}`),
    ),
  );
  const lifecycle = lifecycleResult.projection;
  if (lifecycle === undefined) {
    diagnostics.push(diagnostic("CLOSURE_LIFECYCLE_INVALID", "$.lifecycle", "Lifecycle projection is unavailable."));
    return { valid: false, diagnostics: Object.freeze(diagnostics) };
  }
  if (lifecycle.scope !== "complete")
    diagnostics.push(
      diagnostic(
        "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE",
        "$.lifecycle.scope",
        "Complete authoritative Issue lifecycle evidence is required before close.",
      ),
    );
  if (hasCycle(lifecycle, (issue) => (issue.parent === undefined ? [] : [issue.parent])))
    diagnostics.push(
      diagnostic("CLOSURE_RELATION_CYCLE", "$.lifecycle", "Parent relationship evidence contains a cycle."),
    );
  if (hasCycle(lifecycle, (issue) => issue.dependsOn))
    diagnostics.push(
      diagnostic("CLOSURE_RELATION_CYCLE", "$.lifecycle", "Dependency relationship evidence contains a cycle."),
    );
  if (target === undefined) return { valid: false, diagnostics: Object.freeze(diagnostics) };
  const byReference = issueMap(lifecycle);
  const targetIssue = byReference.get(issueReferenceKey(target));
  if (targetIssue === undefined) {
    diagnostics.push(
      diagnostic("CLOSURE_TARGET_MISSING", "$.target", "Target Issue is absent from lifecycle evidence."),
    );
    return { valid: false, diagnostics: Object.freeze(diagnostics) };
  }
  if (targetIssue.parentEvidence === "unavailable" || targetIssue.dependsOnEvidence === "unavailable")
    diagnostics.push(
      diagnostic(
        "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE",
        "$.lifecycle",
        "Target relationship evidence is unavailable or contradictory.",
      ),
    );
  if (targetIssue.role === undefined)
    diagnostics.push(
      diagnostic(
        "CLOSURE_ROLE_UNDECLARED",
        "$.lifecycle.target.role",
        "Issue closure requires an explicit tracker or leaf role.",
      ),
    );
  const childEvidenceByKey = new Map<string, RecordValue>();
  if (input.children !== undefined) {
    if (!Array.isArray(input.children))
      diagnostics.push(
        diagnostic("CLOSURE_INPUT_INVALID", "$.children", "Closure children evidence must be an array."),
      );
    else
      input.children.forEach((entry, index) => {
        const path = `$.children[${index}]`;
        if (!isRecord(entry)) {
          diagnostics.push(diagnostic("CLOSURE_INPUT_INVALID", path, "Child evidence must be an object."));
          return;
        }
        unknownProperties(entry, CHILD_KEYS, path, diagnostics);
        const childReference = reference(entry.reference, `${path}.reference`, diagnostics);
        if (childReference !== undefined) childEvidenceByKey.set(issueReferenceKey(childReference), entry);
      });
  }
  let childrenTerminalConfirmed = true;
  const childTerminalEvidence: {
    readonly reference: IssueReference;
    readonly implementation: SemanticIssueClosureTerminalEvidenceProjection;
    readonly change: SemanticIssueClosureTerminalEvidenceProjection;
  }[] = [];
  if (targetIssue.role === "tracker") {
    for (const child of targetIssue.children) {
      const childIssue = byReference.get(issueReferenceKey(child));
      if (childIssue === undefined || childIssue.observedState === undefined) {
        diagnostics.push(
          diagnostic(
            "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE",
            "$.lifecycle.target.children",
            "Every authoritative tracker child must have complete observed state evidence.",
          ),
        );
        childrenTerminalConfirmed = false;
        continue;
      }
      if (childIssue.observedState !== "closed") continue;
      const childKey = issueReferenceKey(child);
      const childEntry = childEvidenceByKey.get(childKey);
      const childPath = `$.children[${childKey}]`;
      if (childEntry === undefined) {
        diagnostics.push(
          diagnostic(
            "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE",
            childPath,
            "Every authoritative tracker child requires terminal evidence.",
          ),
        );
        childrenTerminalConfirmed = false;
        continue;
      }
      const childImplementation = terminalEvidence(
        childEntry.implementation,
        "implementation",
        child,
        diagnostics,
        childPath,
      );
      const childChange = terminalEvidence(childEntry.change, "change", child, diagnostics, childPath);
      childTerminalEvidence.push({ reference: child, implementation: childImplementation, change: childChange });
      const childCombined = combineTerminalEvidence(childImplementation, childChange, diagnostics);
      if (childCombined === "absent") {
        diagnostics.push(
          diagnostic(
            "CLOSURE_TERMINAL_EVIDENCE_MISSING",
            childPath,
            "Tracker child requires authoritative Implementation or Change terminal evidence.",
          ),
        );
        childrenTerminalConfirmed = false;
      } else if (
        childCombined !== "terminal" ||
        (childImplementation.outcome ?? childChange.outcome) !== "successful"
      ) {
        childrenTerminalConfirmed = false;
      }
    }
  }
  const implementation = terminalEvidence(input.implementation, "implementation", target, diagnostics);
  const change = terminalEvidence(input.change, "change", target, diagnostics);
  const combinedTerminalStatus = combineTerminalEvidence(implementation, change, diagnostics);
  const targetState = targetIssue.observedState;
  if (targetState === undefined) {
    diagnostics.push(
      diagnostic(
        "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE",
        "$.lifecycle.target.state",
        "Target Issue state is unavailable.",
      ),
    );
  }
  const role = targetIssue.role ?? "leaf";
  let status: SemanticIssueClosureStatus = "unverifiable";
  if (diagnostics.length === 0 && targetState !== undefined) {
    if (role === "tracker") {
      if (targetIssue.completion.status === "complete")
        status = childrenTerminalConfirmed ? (targetState === "closed" ? "already-closed" : "closable") : "blocked";
      else if (targetIssue.completion.status === "in-progress") status = "blocked";
      else {
        diagnostics.push(
          diagnostic(
            "CLOSURE_RELATION_EVIDENCE_UNAVAILABLE",
            "$.lifecycle.target.completion",
            "Tracker completion is not authoritative.",
          ),
        );
      }
    } else if (combinedTerminalStatus === "terminal") {
      status = targetState === "closed" ? "already-closed" : "closable";
    } else if (combinedTerminalStatus === "active") {
      status = "blocked";
    } else if (combinedTerminalStatus === "absent") {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_MISSING",
          "$.terminalEvidence",
          "Leaf closure requires authoritative Implementation or Change terminal evidence.",
        ),
      );
    }
    if (targetState === "closed" && status === "blocked") {
      diagnostics.push(
        diagnostic(
          "CLOSURE_TERMINAL_EVIDENCE_STALE",
          "$.lifecycle.target.state",
          "Closed Issue state is incompatible with incomplete closure evidence.",
        ),
      );
    }
  }
  const projection: SemanticIssueClosureProjection = {
    version: SEMANTIC_ISSUE_CLOSURE_VERSION,
    kind: SEMANTIC_ISSUE_CLOSURE_KIND,
    target,
    intent: "close",
    status: diagnostics.length === 0 ? status : "unverifiable",
    targetState: targetState ?? "open",
    role,
    lifecycle: {
      completion: targetIssue.completion,
      children: targetIssue.children,
      childrenEvidence: targetIssue.childrenEvidence,
    },
    terminalEvidence: { implementation, change },
    ...(role === "tracker" ? { childTerminalEvidence: Object.freeze(childTerminalEvidence) } : {}),
    ...(targetIssue.completion.finalGateRemainder === undefined
      ? {}
      : { finalGateRemainder: targetIssue.completion.finalGateRemainder }),
    ...(diagnostics.length === 0 && status === "closable" ? { effect: { kind: "CLOSE_ISSUE" as const, target } } : {}),
  };
  return projectionResult(diagnostics, projection);
}

/** Throwing pure entry point for callers that require admissibility. */
export function projectSemanticIssueClosure(input: unknown): SemanticIssueClosureProjection {
  const result = tryProjectSemanticIssueClosure(input);
  if (!result.valid || result.projection === undefined) throw new SemanticIssueClosureError(result.diagnostics);
  return result.projection;
}

/** Create an explicit close plan from a pure admissibility input. */
export function tryPlanSemanticIssueClosure(input: unknown): SemanticIssueClosurePlanResult {
  const result = tryProjectSemanticIssueClosure(input);
  if (!result.valid || result.projection === undefined) {
    return {
      valid: false,
      ...(result.projection === undefined ? {} : { projection: result.projection }),
      diagnostics: result.diagnostics,
    };
  }
  if (result.projection.status !== "closable" && result.projection.status !== "already-closed") {
    const diagnostics = [
      ...result.diagnostics,
      diagnostic(
        "CLOSURE_NOT_ADMISSIBLE",
        "$.status",
        "Issue is not admissible for a close plan.",
        ["closable", "already-closed"],
        result.projection.status,
      ),
    ];
    return { valid: false, projection: result.projection, diagnostics };
  }
  if (!isRecord(input)) return { valid: false, projection: result.projection, diagnostics: result.diagnostics };
  const target = result.projection.target;
  const evidence: SemanticIssueClosureEvidenceInput = {
    lifecycle: input.lifecycle,
    ...(input.implementation === undefined ? {} : { implementation: input.implementation }),
    ...(input.change === undefined ? {} : { change: input.change }),
    ...(input.children === undefined
      ? {}
      : { children: input.children as SemanticIssueClosureEvidenceInput["children"] }),
  };
  const plan: SemanticIssueClosurePlan = {
    version: SEMANTIC_ISSUE_CLOSURE_VERSION,
    kind: "issue-close-plan",
    request: { target, intent: "close" },
    evidence,
    admissibility: result.projection,
    ...(result.projection.effect === undefined ? {} : { effect: result.projection.effect }),
  };
  return { valid: true, plan: cloneImmutable(plan), projection: result.projection, diagnostics: [] };
}

export function planSemanticIssueClosure(input: unknown): SemanticIssueClosurePlan {
  const result = tryPlanSemanticIssueClosure(input);
  if (!result.valid || result.plan === undefined) throw new SemanticIssueClosureError(result.diagnostics);
  return result.plan;
}

/** Validate a serialized or caller-supplied close plan by recomputing its authority. */
export function validateSemanticIssueClosurePlan(input: unknown): SemanticIssueClosurePlanResult {
  if (!isRecord(input))
    return { valid: false, diagnostics: [diagnostic("CLOSURE_INPUT_INVALID", "$", "Close plan must be an object.")] };
  const diagnostics: SemanticIssueClosureDiagnostic[] = [];
  unknownProperties(input, PLAN_KEYS, "$", diagnostics);
  if (input.version !== SEMANTIC_ISSUE_CLOSURE_VERSION || input.kind !== "issue-close-plan")
    diagnostics.push(diagnostic("CLOSURE_INPUT_INVALID", "$", "Close plan version or kind is unsupported."));
  if (!isRecord(input.request))
    diagnostics.push(diagnostic("CLOSURE_INPUT_INVALID", "$.request", "Close plan request is required."));
  if (!isRecord(input.evidence))
    diagnostics.push(diagnostic("CLOSURE_INPUT_INVALID", "$.evidence", "Close plan evidence is required."));
  if (!isRecord(input.admissibility))
    diagnostics.push(diagnostic("CLOSURE_INPUT_INVALID", "$.admissibility", "Close plan admissibility is required."));
  if (diagnostics.length > 0 || !isRecord(input.request) || !isRecord(input.evidence) || !isRecord(input.admissibility))
    return { valid: false, diagnostics: Object.freeze(diagnostics) };
  unknownProperties(input.request, REQUEST_KEYS, "$.request", diagnostics);
  const target = reference(input.request.target, "$.request.target", diagnostics);
  if (input.request.intent !== "close")
    diagnostics.push(diagnostic("CLOSURE_INTENT_REQUIRED", "$.request.intent", 'Close plan intent must be "close".'));
  const fresh = tryPlanSemanticIssueClosure({
    target: input.request.target,
    intent: input.request.intent,
    lifecycle: input.evidence.lifecycle,
    ...(input.evidence.implementation === undefined ? {} : { implementation: input.evidence.implementation }),
    ...(input.evidence.change === undefined ? {} : { change: input.evidence.change }),
    ...(input.evidence.children === undefined ? {} : { children: input.evidence.children }),
  });
  diagnostics.push(...fresh.diagnostics);
  if (target !== undefined && fresh.plan !== undefined) {
    if (input.effect !== undefined) {
      if (!isRecord(input.effect) || input.effect.kind !== "CLOSE_ISSUE")
        diagnostics.push(diagnostic("CLOSURE_INPUT_INVALID", "$.effect", "Close plan effect is invalid."));
      else {
        const effectTarget = reference(input.effect.target, "$.effect.target", diagnostics);
        if (effectTarget !== undefined && !sameReference(effectTarget, target))
          diagnostics.push(
            diagnostic("CLOSURE_INPUT_INVALID", "$.effect.target", "Close effect target differs from request target."),
          );
      }
    }
    if (stableSerialize(input.admissibility) !== stableSerialize(fresh.plan.admissibility))
      diagnostics.push(
        diagnostic("CLOSURE_INPUT_INVALID", "$.admissibility", "Close plan authority does not recompute identically."),
      );
    const plan = fresh.plan;
    if (diagnostics.length === 0) return { valid: true, plan, projection: plan.admissibility, diagnostics: [] };
  }
  return {
    valid: false,
    diagnostics: Object.freeze(diagnostics),
    ...(fresh.projection === undefined ? {} : { projection: fresh.projection }),
  };
}

function stableSerialize(value: unknown, stack = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (stack.has(value)) throw new TypeError("Cyclic JSON data is not supported.");
  stack.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`
    : `{${Object.keys(value as RecordValue)
        .sort(compareStrings)
        .map((key) => `${JSON.stringify(key)}:${stableSerialize((value as RecordValue)[key], stack)}`)
        .join(",")}}`;
  stack.delete(value);
  return serialized;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

export const tryProjectIssueClosure = tryProjectSemanticIssueClosure;
export const projectIssueClosure = projectSemanticIssueClosure;
export const tryPlanIssueClosure = tryPlanSemanticIssueClosure;
export const planIssueClosure = planSemanticIssueClosure;
