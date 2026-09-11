/**
 * Bounded local Executor for the Semantic Issue vertical slice.
 *
 * The Executor admits a Core-produced versioned plan, resolves the Issue
 * Canon again, checks its immutable generation, and hands the already
 * projected desired values to the trusted GitHub adapter. It never derives
 * title, body, metadata, or relations from CLI/MCP input.
 */

import { compileRepositoryEffectiveIssueContract } from "./artifact-contract-governance.js";
import type { EffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { tryMaterializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { createValidatedSemanticIssueArtifact } from "./github/capability.js";
import {
  GitHubAdapter,
  GitHubIssueRelationMutationAdapter,
  type GitHubIssue,
  type IssueRelationCapabilities,
} from "./github/index.js";
import {
  GITHUB_ISSUE_PROJECTION_CAPABILITIES,
  SEMANTIC_ISSUE_MUTATION_PLAN_VERSION,
  serializeSemanticIssueMutationPlan,
  tryPlanSemanticIssue,
  validateSemanticIssueMutationPlan,
  type SemanticIssueMutationPlan,
} from "./semantic-issue-projection.js";
import {
  compareSemanticIssueProjection,
  tryObserveSemanticIssue,
  type ObservedIssueProjection,
  type SemanticIssueRelationEvidenceInput,
} from "./semantic-issue-observation.js";
import type { SemanticIssueRelationEffect } from "./semantic-issue-relations.js";
import type { IssueReference } from "./contract/issue-reference.js";

export const SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION = "1" as const;
export type SemanticIssueExecutorContractVersion = typeof SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION;

export const SEMANTIC_ISSUE_EXECUTION_OUTCOMES = Object.freeze(["verified", "failed"] as const);
export type SemanticIssueExecutionOutcome = (typeof SEMANTIC_ISSUE_EXECUTION_OUTCOMES)[number];

export interface SemanticIssueExecutionRequest {
  readonly version: SemanticIssueExecutorContractVersion;
  /** Versioned Core Mutation Plan. The Executor never accepts ad-hoc Issue fields. */
  readonly plan: unknown;
  /** Original caller input, when available, for execution-time Core revalidation. */
  readonly input?: unknown;
  /** Materialized artifact, when available, for a plan/artifact binding check. */
  readonly artifact?: unknown;
  readonly selector?: string;
  readonly capabilities?: readonly string[];
}

export interface SemanticIssueObservedProjection {
  readonly kind: "issue";
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestone?: string;
  /** Native/body relation evidence when relation capabilities were observed. */
  readonly relations?: ObservedIssueProjection["relations"];
}

export interface SemanticIssueExecutionEffectEvidence {
  readonly kind: "CREATE_ISSUE" | SemanticIssueRelationEffect["kind"];
  readonly status: "succeeded" | "failed";
}

export interface SemanticIssueExecutionFailureEvidence {
  readonly code: string;
  readonly message: string;
}

/** Provider-independent, bounded evidence returned by local execution. */
export interface SemanticIssueExecutionEvidence {
  readonly version: SemanticIssueExecutorContractVersion;
  readonly planVersion: typeof SEMANTIC_ISSUE_MUTATION_PLAN_VERSION;
  readonly outcome: SemanticIssueExecutionOutcome;
  readonly effects: readonly SemanticIssueExecutionEffectEvidence[];
  readonly issue?: Readonly<{ readonly number: number; readonly url: string }>;
  readonly failure?: SemanticIssueExecutionFailureEvidence;
}

export interface SemanticIssueExecutionResult {
  readonly plan: SemanticIssueMutationPlan;
  readonly projection: SemanticIssueObservedProjection;
  readonly evidence: SemanticIssueExecutionEvidence;
}

export interface SemanticIssueExecutionDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type SemanticIssueExecutorErrorCode =
  | "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID"
  | "SEMANTIC_ISSUE_EXECUTION_PLAN_INVALID"
  | "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED"
  | "SEMANTIC_ISSUE_EXECUTION_REVALIDATION_FAILED"
  | "SEMANTIC_ISSUE_EXECUTION_EFFECT_FAILED"
  | "SEMANTIC_ISSUE_EXECUTION_READ_FAILED"
  | "SEMANTIC_ISSUE_EXECUTION_PROJECTION_VERIFICATION_FAILED";

/** Stable fail-closed error at the local Executor boundary. */
export class SemanticIssueExecutorError extends Error {
  readonly code: SemanticIssueExecutorErrorCode;
  readonly diagnostics: readonly SemanticIssueExecutionDiagnostic[];
  readonly evidence?: SemanticIssueExecutionEvidence;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: SemanticIssueExecutorErrorCode,
    message: string,
    diagnostics: readonly SemanticIssueExecutionDiagnostic[] = [],
    details?: Readonly<Record<string, unknown>>,
    evidence?: SemanticIssueExecutionEvidence,
  ) {
    super(message);
    this.name = "SemanticIssueExecutorError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.details = details;
    this.evidence = evidence;
  }
}

export interface SemanticIssueExecutorOptions {
  /** A repository-scoped GitHub adapter. No credentials enter the plan. */
  readonly adapter: GitHubAdapter;
  readonly selector?: string;
  readonly capabilities?: readonly string[];
}

/** Adapter port used by CLI and future trusted deployments. */
export interface SemanticIssueExecutionPort {
  execute(request: SemanticIssueExecutionRequest): Promise<SemanticIssueExecutionResult>;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function diagnostic(code: string, path: string, message: string): SemanticIssueExecutionDiagnostic {
  return { code, path, message };
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
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => stableSerialize(entry, stack)).join(",")}]`;
  } else if (isRecord(value)) {
    serialized = `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
      .join(",")}}`;
  } else {
    throw new TypeError("Only plain JSON objects are supported.");
  }
  stack.delete(value);
  return serialized;
}

function executionEvidence(
  outcome: SemanticIssueExecutionOutcome,
  status: "succeeded" | "failed",
  issue?: Pick<GitHubIssue, "number" | "url">,
  failure?: SemanticIssueExecutionFailureEvidence,
  effects?: readonly SemanticIssueExecutionEffectEvidence[],
): SemanticIssueExecutionEvidence {
  return Object.freeze({
    version: SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION,
    planVersion: SEMANTIC_ISSUE_MUTATION_PLAN_VERSION,
    outcome,
    effects: Object.freeze(effects === undefined ? [{ kind: "CREATE_ISSUE" as const, status }] : [...effects]),
    ...(issue === undefined ? {} : { issue: Object.freeze({ number: issue.number, url: issue.url }) }),
    ...(failure === undefined ? {} : { failure: Object.freeze(failure) }),
  });
}

function relationCapabilities(capabilities: readonly string[]): IssueRelationCapabilities {
  return {
    parent: capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation),
    blockedBy:
      capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeBlockedByRelation) ||
      capabilities.includes(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation),
  };
}

function relationEffectEvidence(
  effects: readonly SemanticIssueRelationEffect[],
  statuses: readonly ("succeeded" | "failed")[],
): readonly SemanticIssueExecutionEffectEvidence[] {
  return effects.map((effect, index) => ({
    kind: effect.kind,
    status: statuses[index] ?? "failed",
  }));
}

function issueExecutionEffectEvidence(
  relationEffects: readonly SemanticIssueRelationEffect[],
  statuses: readonly ("succeeded" | "failed")[],
): readonly SemanticIssueExecutionEffectEvidence[] {
  return [{ kind: "CREATE_ISSUE", status: "succeeded" }, ...relationEffectEvidence(relationEffects, statuses)];
}

function issueReferenceFor(
  issue: Pick<GitHubIssue, "number">,
  context: Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>,
): IssueReference {
  if (context.repositoryId === undefined)
    throw new SemanticIssueExecutorError(
      "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED",
      "A repository database identity is required for native Issue relations.",
      [
        diagnostic(
          "SEMANTIC_ISSUE_RELATION_REPOSITORY_ID_MISSING",
          "$.repository.repositoryId",
          "Repository identity is unavailable.",
        ),
      ],
    );
  return {
    repositoryHost: context.hostname,
    repositoryId: context.repositoryId,
    repository: context.nameWithOwner,
    number: issue.number,
  };
}

function validCapabilities(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((capability) => typeof capability === "string" && capability.length > 0) &&
    new Set(value).size === value.length
  );
}

function compareCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return stableSerialize([...left].sort()) === stableSerialize([...right].sort());
}

function effectiveGeneration(effective: EffectiveArtifactContract): Readonly<Record<string, unknown>> {
  return effective.generation as unknown as Readonly<Record<string, unknown>>;
}

function planGeneration(plan: SemanticIssueMutationPlan): Readonly<Record<string, unknown>> {
  return plan.generation as unknown as Readonly<Record<string, unknown>>;
}

function validateExecutionRequest(request: SemanticIssueExecutionRequest): void {
  if (!isRecord(request)) {
    throw new SemanticIssueExecutorError(
      "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
      "Semantic Issue execution request must be an object.",
    );
  }
  const allowed = new Set(["version", "plan", "input", "artifact", "selector", "capabilities"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new SemanticIssueExecutorError(
      "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
      "Semantic Issue execution request contains an unsupported property.",
    );
  }
  if (request.version !== SEMANTIC_ISSUE_EXECUTOR_CONTRACT_VERSION) {
    throw new SemanticIssueExecutorError(
      "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
      "Semantic Issue execution request version is unsupported.",
      [
        diagnostic(
          "SEMANTIC_ISSUE_EXECUTION_REQUEST_VERSION_INVALID",
          "$.version",
          "Execution request version is unsupported.",
        ),
      ],
    );
  }
  if (request.selector !== undefined && (typeof request.selector !== "string" || request.selector.length === 0)) {
    throw new SemanticIssueExecutorError(
      "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
      "Semantic Issue execution selector is invalid.",
      [diagnostic("SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID", "$.selector", "Selector must be a non-empty string.")],
    );
  }
  if (request.capabilities !== undefined && !validCapabilities(request.capabilities)) {
    throw new SemanticIssueExecutorError(
      "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
      "Semantic Issue execution capabilities are invalid.",
      [
        diagnostic(
          "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
          "$.capabilities",
          "Capabilities must be unique strings.",
        ),
      ],
    );
  }
}

function planInvalid(diagnostics: readonly SemanticIssueExecutionDiagnostic[]): SemanticIssueExecutorError {
  return new SemanticIssueExecutorError(
    "SEMANTIC_ISSUE_EXECUTION_PLAN_INVALID",
    "The Semantic Issue mutation plan is invalid and cannot be executed.",
    diagnostics,
  );
}

function revalidationFailed(diagnostics: readonly SemanticIssueExecutionDiagnostic[]): SemanticIssueExecutorError {
  return new SemanticIssueExecutorError(
    "SEMANTIC_ISSUE_EXECUTION_REVALIDATION_FAILED",
    "Semantic Issue execution-time Core revalidation failed.",
    diagnostics,
  );
}

function observedProjection(
  issue: GitHubIssue,
  relations?: ObservedIssueProjection["relations"],
): SemanticIssueObservedProjection {
  return Object.freeze({
    kind: "issue" as const,
    number: issue.number,
    url: issue.url,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    labels: Object.freeze([...issue.labels]),
    assignees: Object.freeze([...issue.assignees]),
    ...(issue.milestone === undefined ? {} : { milestone: issue.milestone.title }),
    ...(relations === undefined ? {} : { relations }),
  });
}

function unsupportedDesiredState(
  desired: SemanticIssueMutationPlan["desired"],
): readonly SemanticIssueExecutionDiagnostic[] {
  const diagnostics: SemanticIssueExecutionDiagnostic[] = [];
  const metadata = desired.metadata as RecordValue;
  if (hasOwn(metadata, "milestone")) {
    diagnostics.push(
      diagnostic(
        "SEMANTIC_ISSUE_DESIRED_STATE_UNSUPPORTED",
        "$.desired.metadata.milestone",
        "The local Executor cannot faithfully apply and verify desired milestone state.",
      ),
    );
  }
  return diagnostics;
}

function relationObservationInput(
  relationAdapter: GitHubIssueRelationMutationAdapter,
  issueNumber: number,
  capabilities: IssueRelationCapabilities,
): Promise<{
  readonly relations: Readonly<{
    readonly parent?: SemanticIssueRelationEvidenceInput;
    readonly dependsOn?: SemanticIssueRelationEvidenceInput;
  }>;
  readonly diagnostics: readonly SemanticIssueExecutionDiagnostic[];
}> {
  return Promise.all([
    capabilities.parent ? relationAdapter.observeParent(issueNumber) : Promise.resolve(undefined),
    capabilities.blockedBy ? relationAdapter.observeBlockedBy(issueNumber) : Promise.resolve(undefined),
  ]).then(([parent, dependsOn]) => {
    const diagnostics: SemanticIssueExecutionDiagnostic[] = [];
    const relations: {
      parent?: SemanticIssueRelationEvidenceInput;
      dependsOn?: SemanticIssueRelationEvidenceInput;
    } = {};
    if (parent !== undefined) {
      diagnostics.push(
        ...parent.diagnostics.map((entry) =>
          diagnostic(`SEMANTIC_ISSUE_${entry.code}`, `$.relations.parent`, entry.message),
        ),
      );
      if (parent.kind === "present" && parent.reference !== undefined) relations.parent = { native: parent.reference };
      else if (parent.kind === "empty") relations.parent = { native: [] };
    }
    if (dependsOn !== undefined) {
      diagnostics.push(
        ...dependsOn.diagnostics.map((entry) =>
          diagnostic(`SEMANTIC_ISSUE_${entry.code}`, `$.relations.dependsOn`, entry.message),
        ),
      );
      if (dependsOn.kind === "present" || dependsOn.kind === "empty")
        relations.dependsOn = { native: dependsOn.references };
    }
    return { relations, diagnostics };
  });
}

function relationMismatches(
  desired: SemanticIssueMutationPlan["desired"],
  observed: ObservedIssueProjection,
): readonly SemanticIssueExecutionDiagnostic[] {
  const comparison = compareSemanticIssueProjection(desired, observed);
  return comparison.diagnostics
    .filter((entry) => entry.path.startsWith("$.relations"))
    .map((entry) => diagnostic(`SEMANTIC_ISSUE_${entry.code}`, entry.path, entry.message));
}

function projectionMismatches(
  desired: SemanticIssueMutationPlan["desired"],
  observed: GitHubIssue,
): readonly SemanticIssueExecutionDiagnostic[] {
  const diagnostics: SemanticIssueExecutionDiagnostic[] = [];
  const compare = (path: string, expected: unknown, actual: unknown): void => {
    if (stableSerialize(expected) !== stableSerialize(actual)) {
      diagnostics.push(
        diagnostic("SEMANTIC_ISSUE_PROJECTION_MISMATCH", path, "Observed Issue differs from the desired projection."),
      );
    }
  };
  const compareStringSet = (path: string, expected: readonly string[], actual: unknown): void => {
    compare(
      path,
      [...expected].sort(compareStrings),
      Array.isArray(actual) ? [...actual].sort(compareStrings) : actual,
    );
  };
  compare("$.desired.title", desired.title, observed.title);
  compare("$.desired.body", desired.body, observed.body);
  if (hasOwn(desired.metadata as RecordValue, "labels"))
    compareStringSet("$.desired.metadata.labels", desired.metadata.labels ?? [], observed.labels);
  if (hasOwn(desired.metadata as RecordValue, "assignees"))
    compareStringSet("$.desired.metadata.assignees", desired.metadata.assignees ?? [], observed.assignees);
  if (hasOwn(desired.metadata as RecordValue, "milestone"))
    compare("$.desired.metadata.milestone", desired.metadata.milestone, observed.milestone?.title);
  return diagnostics;
}

function semanticMutationArtifact(plan: SemanticIssueMutationPlan) {
  const desired = plan.desired;
  return createValidatedSemanticIssueArtifact({
    kind: "issue",
    title: desired.title,
    body: desired.body,
    provenance: desired.provenance,
    ...(desired.metadata.labels === undefined ? {} : { labels: desired.metadata.labels }),
    ...(desired.metadata.assignees === undefined ? {} : { assignees: desired.metadata.assignees }),
  });
}

/**
 * Local/development deployment of the logical Semantic Artifact Executor.
 * The class is plan-centered and never accepts CLI-owned Issue projection or
 * repository-policy rules.
 */
export class SemanticIssueExecutor implements SemanticIssueExecutionPort {
  readonly #adapter: GitHubAdapter;
  readonly #selector: string | undefined;
  readonly #capabilities: readonly string[] | undefined;

  constructor(options: SemanticIssueExecutorOptions) {
    this.#adapter = options.adapter;
    this.#selector = options.selector;
    this.#capabilities = options.capabilities;
  }

  async execute(request: SemanticIssueExecutionRequest): Promise<SemanticIssueExecutionResult> {
    validateExecutionRequest(request);
    const planResult = validateSemanticIssueMutationPlan(request.plan);
    if (!planResult.valid || planResult.plan === undefined) {
      throw planInvalid(planResult.violations);
    }
    const plan = planResult.plan;
    const selector = request.selector ?? this.#selector;
    const requestedCapabilities = request.capabilities ?? this.#capabilities;
    if (requestedCapabilities !== undefined && !compareCapabilities(requestedCapabilities, plan.capabilities)) {
      throw new SemanticIssueExecutorError(
        "SEMANTIC_ISSUE_EXECUTION_REQUEST_INVALID",
        "Execution capabilities do not match the versioned plan.",
        [
          diagnostic(
            "SEMANTIC_ISSUE_EXECUTION_CAPABILITIES_MISMATCH",
            "$.capabilities",
            "Capabilities must equal the plan capabilities.",
          ),
        ],
      );
    }

    // Reject semantics the adapter cannot faithfully apply and reread before
    // any Canon or GitHub mutation call. Unsupported values are never dropped.
    const unsupported = unsupportedDesiredState(plan.desired);
    if (unsupported.length > 0) throw planInvalid(unsupported);

    // Compile against the authoritative default branch/tree/blob immediately
    // before admission. A successful CLI preflight is not authorization.
    let effective: EffectiveArtifactContract;
    try {
      effective = await compileRepositoryEffectiveIssueContract(this.#adapter, selector, {
        capabilities: plan.capabilities,
      });
    } catch (error: unknown) {
      throw revalidationFailed([
        diagnostic(
          "SEMANTIC_ISSUE_CANON_RESOLUTION_FAILED",
          "$.generation",
          error instanceof Error ? error.message : "Authoritative Issue Canon could not be resolved.",
        ),
      ]);
    }
    if (stableSerialize(planGeneration(plan)) !== stableSerialize(effectiveGeneration(effective))) {
      throw new SemanticIssueExecutorError(
        "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED",
        "Repository governance changed after the plan was produced.",
        [
          diagnostic(
            "SEMANTIC_ISSUE_GOVERNANCE_GENERATION_MISMATCH",
            "$.generation",
            "Plan generation does not match the current repository Canon generation.",
          ),
        ],
        {
          expectedTreeSha: planGeneration(plan).treeSha,
          actualTreeSha: effectiveGeneration(effective).treeSha,
        },
      );
    }

    let admittedPlan = plan;
    if (request.input !== undefined) {
      const materialization = tryMaterializeSemanticArtifact(effective, request.input);
      if (!materialization.valid || materialization.artifact === undefined) {
        throw revalidationFailed(materialization.violations);
      }
      const replanned = tryPlanSemanticIssue({ artifact: materialization.artifact, capabilities: plan.capabilities });
      if (!replanned.valid || replanned.plan === undefined) throw revalidationFailed(replanned.violations);
      if (serializeSemanticIssueMutationPlan(replanned.plan) !== serializeSemanticIssueMutationPlan(plan)) {
        throw new SemanticIssueExecutorError(
          "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED",
          "The supplied plan does not match execution-time Core materialization.",
          [
            diagnostic(
              "SEMANTIC_ISSUE_PLAN_MISMATCH",
              "$.plan",
              "Versioned plan differs from the plan produced by the current Core contract.",
            ),
          ],
        );
      }
      admittedPlan = replanned.plan;
    }
    if (request.artifact !== undefined) {
      const replanned = tryPlanSemanticIssue({ artifact: request.artifact, capabilities: plan.capabilities });
      if (!replanned.valid || replanned.plan === undefined) throw revalidationFailed(replanned.violations);
      if (serializeSemanticIssueMutationPlan(replanned.plan) !== serializeSemanticIssueMutationPlan(plan)) {
        throw new SemanticIssueExecutorError(
          "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED",
          "The supplied plan does not match the materialized Semantic Artifact.",
          [
            diagnostic(
              "SEMANTIC_ISSUE_PLAN_ARTIFACT_MISMATCH",
              "$.artifact",
              "Plan artifact identity is not bound to the supplied artifact.",
            ),
          ],
        );
      }
      admittedPlan = replanned.plan;
    }

    const generationPrecondition = admittedPlan.preconditions.find(
      (precondition) => precondition.kind === "GOVERNANCE_GENERATION_MATCH",
    );
    if (
      generationPrecondition === undefined ||
      stableSerialize(generationPrecondition.generation) !== stableSerialize(effectiveGeneration(effective))
    ) {
      throw new SemanticIssueExecutorError(
        "SEMANTIC_ISSUE_EXECUTION_PRECONDITION_FAILED",
        "The Semantic Issue plan governance precondition is not satisfied.",
        [
          diagnostic(
            "SEMANTIC_ISSUE_GOVERNANCE_PRECONDITION_FAILED",
            "$.preconditions",
            "Current repository state does not satisfy the plan generation precondition.",
          ),
        ],
      );
    }

    const artifact = semanticMutationArtifact(admittedPlan);
    let created: GitHubIssue;
    try {
      created = await this.#adapter.createSemanticIssue(artifact);
    } catch {
      throw new SemanticIssueExecutorError(
        "SEMANTIC_ISSUE_EXECUTION_EFFECT_FAILED",
        "GitHub Issue creation failed.",
        [diagnostic("SEMANTIC_ISSUE_EFFECT_FAILED", "$.effects[0]", "CREATE_ISSUE did not succeed.")],
        undefined,
        executionEvidence("failed", "failed", undefined, {
          code: "SEMANTIC_ISSUE_EFFECT_FAILED",
          message: "CREATE_ISSUE did not succeed.",
        }),
      );
    }

    const relationEffects = admittedPlan.effects.slice(1) as readonly SemanticIssueRelationEffect[];
    const nativeCapabilities = relationCapabilities(admittedPlan.capabilities);
    const relationVerificationRequired =
      relationEffects.length > 0 ||
      admittedPlan.desired.relations.parent.representation === "native" ||
      admittedPlan.desired.relations.dependsOn.representation === "native";
    let relationAdapter: GitHubIssueRelationMutationAdapter | undefined;
    let relationContext: Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>> | undefined;
    const relationStatuses: Array<"succeeded" | "failed"> = [];

    if (relationEffects.length > 0 || relationVerificationRequired) {
      try {
        relationContext = await this.#adapter.getRepositoryContext();
        relationAdapter = new GitHubIssueRelationMutationAdapter(this.#adapter, relationContext, nativeCapabilities);
      } catch {
        if (relationEffects.length > 0) {
          relationStatuses.push(...relationEffects.map(() => "failed" as const));
          throw new SemanticIssueExecutorError(
            "SEMANTIC_ISSUE_EXECUTION_EFFECT_FAILED",
            "Native Issue relation effects could not be admitted after Issue creation.",
            [
              diagnostic(
                "SEMANTIC_ISSUE_RELATION_EFFECT_FAILED",
                "$.effects[1]",
                "Native Issue relation effect admission failed.",
              ),
            ],
            undefined,
            executionEvidence(
              "failed",
              "succeeded",
              { number: created.number, url: created.url },
              {
                code: "SEMANTIC_ISSUE_RELATION_EFFECT_FAILED",
                message: "Native Issue relation effect admission failed.",
              },
              issueExecutionEffectEvidence(relationEffects, relationStatuses),
            ),
          );
        }
        throw new SemanticIssueExecutorError(
          "SEMANTIC_ISSUE_EXECUTION_READ_FAILED",
          "Native Issue relation observation could not be admitted after Issue creation.",
          [
            diagnostic(
              "SEMANTIC_ISSUE_RELATION_READ_FAILED",
              "$.relations",
              "Native Issue relation observation setup failed.",
            ),
          ],
          undefined,
          executionEvidence(
            "failed",
            "succeeded",
            { number: created.number, url: created.url },
            {
              code: "SEMANTIC_ISSUE_RELATION_READ_FAILED",
              message: "Native Issue relation observation setup failed.",
            },
          ),
        );
      }
    }

    if (relationEffects.length > 0) {
      const subject = issueReferenceFor(
        created,
        relationContext as Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>,
      );
      for (const [index, effect] of relationEffects.entries()) {
        try {
          await (relationAdapter as GitHubIssueRelationMutationAdapter).execute(effect, subject);
          relationStatuses.push("succeeded");
        } catch {
          relationStatuses.push("failed");
          throw new SemanticIssueExecutorError(
            "SEMANTIC_ISSUE_EXECUTION_EFFECT_FAILED",
            "A native Issue relation effect failed after Issue creation.",
            [
              diagnostic(
                "SEMANTIC_ISSUE_RELATION_EFFECT_FAILED",
                `$.effects[${index + 1}]`,
                "Native Issue relation effect did not succeed.",
              ),
            ],
            undefined,
            executionEvidence(
              "failed",
              "succeeded",
              { number: created.number, url: created.url },
              {
                code: "SEMANTIC_ISSUE_RELATION_EFFECT_FAILED",
                message: "Native Issue relation effect did not succeed.",
              },
              issueExecutionEffectEvidence(relationEffects, relationStatuses),
            ),
          );
        }
      }
    }

    let after: GitHubIssue;
    try {
      after = await this.#adapter.getIssue(created.number);
    } catch {
      throw new SemanticIssueExecutorError(
        "SEMANTIC_ISSUE_EXECUTION_READ_FAILED",
        "Created Issue could not be reread for postcondition verification.",
        [
          diagnostic(
            "SEMANTIC_ISSUE_POSTCONDITION_READ_FAILED",
            "$.projection",
            "Created Issue state could not be reread.",
          ),
        ],
        undefined,
        executionEvidence(
          "failed",
          "succeeded",
          { number: created.number, url: created.url },
          {
            code: "SEMANTIC_ISSUE_POSTCONDITION_READ_FAILED",
            message: "Created Issue state could not be reread.",
          },
          issueExecutionEffectEvidence(relationEffects, relationStatuses),
        ),
      );
    }

    let observedRelations: ObservedIssueProjection["relations"] | undefined;
    if (relationVerificationRequired) {
      const context = relationContext as Awaited<ReturnType<GitHubAdapter["getRepositoryContext"]>>;
      const relationEvidence = await relationObservationInput(
        relationAdapter as GitHubIssueRelationMutationAdapter,
        after.number,
        nativeCapabilities,
      );
      if (relationEvidence.diagnostics.length > 0) {
        throw new SemanticIssueExecutorError(
          "SEMANTIC_ISSUE_EXECUTION_READ_FAILED",
          "Native Issue relation state could not be reread for postcondition verification.",
          relationEvidence.diagnostics,
          undefined,
          executionEvidence(
            "failed",
            "succeeded",
            { number: after.number, url: after.url },
            {
              code: "SEMANTIC_ISSUE_RELATION_READ_FAILED",
              message: "Native Issue relation state could not be reread.",
            },
            issueExecutionEffectEvidence(relationEffects, relationStatuses),
          ),
        );
      }
      const semanticObserved = tryObserveSemanticIssue({
        issue: after,
        repository: {
          host: context.hostname,
          repositoryId: context.repositoryId,
          repository: context.nameWithOwner,
        },
        relations: relationEvidence.relations,
      });
      if (!semanticObserved.valid || semanticObserved.projection === undefined) {
        throw new SemanticIssueExecutorError(
          "SEMANTIC_ISSUE_EXECUTION_READ_FAILED",
          "Native Issue relation state was malformed during postcondition verification.",
          semanticObserved.violations.map((entry) =>
            diagnostic("SEMANTIC_ISSUE_RELATION_OBSERVATION_INVALID", entry.path, entry.message),
          ),
          undefined,
          executionEvidence(
            "failed",
            "succeeded",
            { number: after.number, url: after.url },
            {
              code: "SEMANTIC_ISSUE_RELATION_READ_FAILED",
              message: "Native Issue relation state was malformed during postcondition verification.",
            },
            issueExecutionEffectEvidence(relationEffects, relationStatuses),
          ),
        );
      }
      observedRelations = semanticObserved.projection.relations;
    }

    const mismatches = projectionMismatches(admittedPlan.desired, after);
    const relationDrift =
      observedRelations === undefined
        ? []
        : relationMismatches(admittedPlan.desired, {
            version: "1",
            kind: "issue",
            number: after.number,
            state: after.state,
            url: after.url,
            title: after.title,
            body: after.body ?? "",
            metadata: {
              labels: after.labels,
              assignees: after.assignees,
              ...(after.milestone === undefined ? {} : { milestone: after.milestone.title }),
            },
            relations: observedRelations,
          });
    const allMismatches = [...mismatches, ...relationDrift];
    if (allMismatches.length > 0) {
      throw new SemanticIssueExecutorError(
        "SEMANTIC_ISSUE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Observed Issue does not satisfy the desired Semantic Issue projection.",
        allMismatches,
        undefined,
        executionEvidence(
          "failed",
          "succeeded",
          { number: after.number, url: after.url },
          {
            code: "SEMANTIC_ISSUE_PROJECTION_MISMATCH",
            message: "Observed Issue differs from the desired projection.",
          },
          issueExecutionEffectEvidence(relationEffects, relationStatuses),
        ),
      );
    }

    return Object.freeze({
      plan: admittedPlan,
      projection: observedProjection(after, observedRelations),
      evidence: executionEvidence(
        "verified",
        "succeeded",
        { number: after.number, url: after.url },
        undefined,
        issueExecutionEffectEvidence(
          relationEffects,
          relationEffects.map(() => "succeeded" as const),
        ),
      ),
    });
  }
}

/** Explicit alias for callers naming the local deployment. */
export const LocalSemanticIssueExecutor = SemanticIssueExecutor;
