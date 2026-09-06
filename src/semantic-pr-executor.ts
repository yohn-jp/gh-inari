/**
 * Bounded local Executor for the Semantic PR vertical slice.
 *
 * The Executor admits a Core-produced versioned plan, resolves the repository
 * Canon again, checks the immutable generation and current target state, then
 * hands the already-projected desired values to the existing GitHub mutation
 * adapter.  It does not derive branch/title/body values and it is deliberately
 * independent from the Change control plane.
 */

import { compileRepositoryEffectivePullRequestContract } from "./artifact-contract-governance.js";
import type { EffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { tryMaterializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { createValidatedSemanticPullRequestArtifact } from "./github/capability.js";
import { GitHubAdapter, type GitHubPullRequest } from "./github/index.js";
import {
  SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
  serializeSemanticPullRequestMutationPlan,
  tryPlanSemanticPullRequest,
  validateSemanticPullRequestMutationPlan,
  type SemanticPullRequestMutationPlan,
} from "./semantic-pr-projection.js";

export const SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION = "1" as const;
export type SemanticPullRequestExecutorContractVersion = typeof SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION;

export const SEMANTIC_PULL_REQUEST_EXECUTION_OUTCOMES = Object.freeze(["verified", "failed"] as const);
export type SemanticPullRequestExecutionOutcome = (typeof SEMANTIC_PULL_REQUEST_EXECUTION_OUTCOMES)[number];

export interface SemanticPullRequestExecutionRequest {
  readonly version: SemanticPullRequestExecutorContractVersion;
  /** Versioned Core Mutation Plan. The Executor never accepts ad-hoc PR fields. */
  readonly plan: unknown;
  /** Original caller input, when available, for execution-time Core revalidation. */
  readonly input?: unknown;
  /** Materialized artifact, when available, for a plan/artifact digest binding check. */
  readonly artifact?: unknown;
  readonly selector?: string;
  readonly capabilities?: readonly string[];
}

export interface SemanticPullRequestObservedProjection {
  readonly kind: "pull_request";
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly maintainerCanModify?: boolean;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestone?: string;
  readonly reviewers?: readonly string[];
}

export interface SemanticPullRequestExecutionEffectEvidence {
  readonly kind: "CREATE_PULL_REQUEST";
  readonly status: "succeeded" | "failed";
}

export interface SemanticPullRequestExecutionFailureEvidence {
  readonly code: string;
  readonly message: string;
}

/** Provider-independent, bounded evidence returned by local execution. */
export interface SemanticPullRequestExecutionEvidence {
  readonly version: SemanticPullRequestExecutorContractVersion;
  readonly planVersion: typeof SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION;
  readonly outcome: SemanticPullRequestExecutionOutcome;
  readonly effects: readonly SemanticPullRequestExecutionEffectEvidence[];
  readonly pullRequest?: Readonly<{ readonly number: number; readonly url: string }>;
  readonly failure?: SemanticPullRequestExecutionFailureEvidence;
}

export interface SemanticPullRequestExecutionResult {
  readonly plan: SemanticPullRequestMutationPlan;
  readonly projection: SemanticPullRequestObservedProjection;
  readonly evidence: SemanticPullRequestExecutionEvidence;
}

export interface SemanticPullRequestExecutionDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type SemanticPullRequestExecutorErrorCode =
  | "SEMANTIC_PR_EXECUTION_REQUEST_INVALID"
  | "SEMANTIC_PR_EXECUTION_PLAN_INVALID"
  | "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED"
  | "SEMANTIC_PR_EXECUTION_REVALIDATION_FAILED"
  | "SEMANTIC_PR_EXECUTION_EFFECT_FAILED"
  | "SEMANTIC_PR_EXECUTION_READ_FAILED"
  | "SEMANTIC_PR_EXECUTION_PROJECTION_VERIFICATION_FAILED";

/** Stable fail-closed error at the local Executor boundary. */
export class SemanticPullRequestExecutorError extends Error {
  readonly code: SemanticPullRequestExecutorErrorCode;
  readonly diagnostics: readonly SemanticPullRequestExecutionDiagnostic[];
  readonly evidence?: SemanticPullRequestExecutionEvidence;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: SemanticPullRequestExecutorErrorCode,
    message: string,
    diagnostics: readonly SemanticPullRequestExecutionDiagnostic[] = [],
    details?: Readonly<Record<string, unknown>>,
    evidence?: SemanticPullRequestExecutionEvidence,
  ) {
    super(message);
    this.name = "SemanticPullRequestExecutorError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
    this.details = details;
    this.evidence = evidence;
  }
}

export interface SemanticPullRequestExecutorOptions {
  /** A repository-scoped GitHub adapter. No credentials enter the plan. */
  readonly adapter: GitHubAdapter;
  readonly selector?: string;
  readonly capabilities?: readonly string[];
}

/** Adapter port used by CLI and future trusted deployments. */
export interface SemanticPullRequestExecutionPort {
  execute(request: SemanticPullRequestExecutionRequest): Promise<SemanticPullRequestExecutionResult>;
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

function diagnostic(code: string, path: string, message: string): SemanticPullRequestExecutionDiagnostic {
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
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], stack)}`)
      .join(",")}}`;
  } else {
    throw new TypeError("Only plain JSON objects are supported.");
  }
  stack.delete(value);
  return serialized;
}

function executionEvidence(
  outcome: SemanticPullRequestExecutionOutcome,
  status: "succeeded" | "failed",
  pullRequest?: Pick<GitHubPullRequest, "number" | "url">,
  failure?: SemanticPullRequestExecutionFailureEvidence,
): SemanticPullRequestExecutionEvidence {
  return Object.freeze({
    version: SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION,
    planVersion: SEMANTIC_PULL_REQUEST_MUTATION_PLAN_VERSION,
    outcome,
    effects: Object.freeze([{ kind: "CREATE_PULL_REQUEST" as const, status }]),
    ...(pullRequest === undefined
      ? {}
      : { pullRequest: Object.freeze({ number: pullRequest.number, url: pullRequest.url }) }),
    ...(failure === undefined ? {} : { failure: Object.freeze(failure) }),
  });
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

function planGeneration(plan: SemanticPullRequestMutationPlan): Readonly<Record<string, unknown>> {
  return plan.generation as unknown as Readonly<Record<string, unknown>>;
}

function validateExecutionRequest(request: SemanticPullRequestExecutionRequest): void {
  if (!isRecord(request)) {
    throw new SemanticPullRequestExecutorError(
      "SEMANTIC_PR_EXECUTION_REQUEST_INVALID",
      "Semantic PR execution request must be an object.",
    );
  }
  const allowed = new Set(["version", "plan", "input", "artifact", "selector", "capabilities"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new SemanticPullRequestExecutorError(
      "SEMANTIC_PR_EXECUTION_REQUEST_INVALID",
      "Semantic PR execution request contains an unsupported property.",
    );
  }
  if (request.version !== SEMANTIC_PULL_REQUEST_EXECUTOR_CONTRACT_VERSION) {
    throw new SemanticPullRequestExecutorError(
      "SEMANTIC_PR_EXECUTION_REQUEST_INVALID",
      "Semantic PR execution request version is unsupported.",
      [
        diagnostic(
          "SEMANTIC_PR_EXECUTION_REQUEST_VERSION_INVALID",
          "$.version",
          "Execution request version is unsupported.",
        ),
      ],
    );
  }
  if (request.selector !== undefined && (typeof request.selector !== "string" || request.selector.length === 0)) {
    throw new SemanticPullRequestExecutorError(
      "SEMANTIC_PR_EXECUTION_REQUEST_INVALID",
      "Semantic PR execution selector is invalid.",
      [diagnostic("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "$.selector", "Selector must be a non-empty string.")],
    );
  }
  if (request.capabilities !== undefined && !validCapabilities(request.capabilities)) {
    throw new SemanticPullRequestExecutorError(
      "SEMANTIC_PR_EXECUTION_REQUEST_INVALID",
      "Semantic PR execution capabilities are invalid.",
      [diagnostic("SEMANTIC_PR_EXECUTION_REQUEST_INVALID", "$.capabilities", "Capabilities must be unique strings.")],
    );
  }
}

function planInvalid(diagnostics: readonly SemanticPullRequestExecutionDiagnostic[]): SemanticPullRequestExecutorError {
  return new SemanticPullRequestExecutorError(
    "SEMANTIC_PR_EXECUTION_PLAN_INVALID",
    "The Semantic PR mutation plan is invalid and cannot be executed.",
    diagnostics,
  );
}

function revalidationFailed(
  diagnostics: readonly SemanticPullRequestExecutionDiagnostic[],
): SemanticPullRequestExecutorError {
  return new SemanticPullRequestExecutorError(
    "SEMANTIC_PR_EXECUTION_REVALIDATION_FAILED",
    "Semantic PR execution-time Core revalidation failed.",
    diagnostics,
  );
}

function observedProjection(pullRequest: GitHubPullRequest): SemanticPullRequestObservedProjection {
  const reviewers =
    pullRequest.requestedReviewers === undefined
      ? undefined
      : [...pullRequest.requestedReviewers.users, ...pullRequest.requestedReviewers.teams].sort();
  return Object.freeze({
    kind: "pull_request" as const,
    number: pullRequest.number,
    url: pullRequest.url,
    state: pullRequest.state,
    title: pullRequest.title,
    body: pullRequest.body,
    head: pullRequest.head,
    base: pullRequest.base,
    draft: pullRequest.draft,
    ...(pullRequest.maintainerCanModify === undefined ? {} : { maintainerCanModify: pullRequest.maintainerCanModify }),
    ...(pullRequest.labels === undefined ? {} : { labels: Object.freeze([...pullRequest.labels]) }),
    ...(pullRequest.assignees === undefined ? {} : { assignees: Object.freeze([...pullRequest.assignees]) }),
    ...(pullRequest.milestone === undefined ? {} : { milestone: pullRequest.milestone.title }),
    ...(reviewers === undefined ? {} : { reviewers: Object.freeze(reviewers) }),
  });
}

function unsupportedDesiredState(
  desired: SemanticPullRequestMutationPlan["desired"],
): readonly SemanticPullRequestExecutionDiagnostic[] {
  const diagnostics: SemanticPullRequestExecutionDiagnostic[] = [];
  const metadata = desired.metadata as RecordValue;
  for (const key of ["milestone", "reviewers"] as const) {
    if (hasOwn(metadata, key)) {
      diagnostics.push(
        diagnostic(
          "SEMANTIC_PR_DESIRED_STATE_UNSUPPORTED",
          `$.desired.metadata.${key}`,
          `The local Executor cannot faithfully apply and verify desired ${key}.`,
        ),
      );
    }
  }
  if (desired.relations.implements.representation === "native") {
    diagnostics.push(
      diagnostic(
        "SEMANTIC_PR_DESIRED_STATE_UNSUPPORTED",
        "$.desired.relations.implements",
        "The local Executor cannot faithfully apply and verify a native implements relation.",
      ),
    );
  }
  return diagnostics;
}

function projectionMismatches(
  desired: SemanticPullRequestMutationPlan["desired"],
  observed: GitHubPullRequest,
): readonly SemanticPullRequestExecutionDiagnostic[] {
  const diagnostics: SemanticPullRequestExecutionDiagnostic[] = [];
  const observedReviewers =
    observed.requestedReviewers === undefined
      ? undefined
      : [...observed.requestedReviewers.users, ...observed.requestedReviewers.teams].sort();
  const compare = (path: string, expected: unknown, actual: unknown): void => {
    if (stableSerialize(expected) !== stableSerialize(actual)) {
      diagnostics.push(
        diagnostic(
          "SEMANTIC_PR_PROJECTION_MISMATCH",
          path,
          "Observed pull request differs from the desired projection.",
        ),
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
  compare("$.desired.head", desired.head, observed.head);
  compare("$.desired.base", desired.base, observed.base);
  compare("$.desired.body", desired.body, observed.body);
  if (hasOwn(desired.metadata as RecordValue, "labels"))
    compareStringSet("$.desired.metadata.labels", desired.metadata.labels ?? [], observed.labels);
  if (hasOwn(desired.metadata as RecordValue, "assignees"))
    compareStringSet("$.desired.metadata.assignees", desired.metadata.assignees ?? [], observed.assignees);
  if (hasOwn(desired.metadata as RecordValue, "milestone"))
    compare("$.desired.metadata.milestone", desired.metadata.milestone, observed.milestone?.title);
  if (hasOwn(desired.metadata as RecordValue, "reviewers"))
    compareStringSet("$.desired.metadata.reviewers", desired.metadata.reviewers ?? [], observedReviewers);
  if (hasOwn(desired.metadata as RecordValue, "draft"))
    compare("$.desired.metadata.draft", desired.metadata.draft, observed.draft);
  if (hasOwn(desired.metadata as RecordValue, "maintainerCanModify"))
    compare(
      "$.desired.metadata.maintainerCanModify",
      desired.metadata.maintainerCanModify,
      observed.maintainerCanModify,
    );
  return diagnostics;
}

function semanticMutationArtifact(plan: SemanticPullRequestMutationPlan) {
  const desired = plan.desired;
  return createValidatedSemanticPullRequestArtifact({
    kind: "pull_request",
    title: desired.title,
    body: desired.body,
    head: desired.head,
    base: desired.base,
    provenance: desired.provenance,
    ...(desired.metadata.labels === undefined ? {} : { labels: desired.metadata.labels }),
    ...(desired.metadata.assignees === undefined ? {} : { assignees: desired.metadata.assignees }),
    ...(desired.metadata.draft === undefined ? {} : { draft: desired.metadata.draft }),
    ...(desired.metadata.maintainerCanModify === undefined
      ? {}
      : { maintainerCanModify: desired.metadata.maintainerCanModify }),
  });
}

/**
 * Local/development deployment of the logical Semantic Artifact Executor.
 * The class is intentionally plan-centered and never accepts CLI-owned PR
 * title, branch, body, or relation rules.
 */
export class SemanticPullRequestExecutor implements SemanticPullRequestExecutionPort {
  readonly #adapter: GitHubAdapter;
  readonly #selector: string | undefined;
  readonly #capabilities: readonly string[] | undefined;

  constructor(options: SemanticPullRequestExecutorOptions) {
    this.#adapter = options.adapter;
    this.#selector = options.selector;
    this.#capabilities = options.capabilities;
  }

  async execute(request: SemanticPullRequestExecutionRequest): Promise<SemanticPullRequestExecutionResult> {
    validateExecutionRequest(request);
    const planResult = validateSemanticPullRequestMutationPlan(request.plan);
    if (!planResult.valid || planResult.plan === undefined) {
      throw planInvalid(planResult.violations);
    }
    const plan = planResult.plan;
    const selector = request.selector ?? this.#selector;
    const requestedCapabilities = request.capabilities ?? this.#capabilities;
    if (requestedCapabilities !== undefined && !compareCapabilities(requestedCapabilities, plan.capabilities)) {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_REQUEST_INVALID",
        "Execution capabilities do not match the versioned plan.",
        [
          diagnostic(
            "SEMANTIC_PR_EXECUTION_CAPABILITIES_MISMATCH",
            "$.capabilities",
            "Capabilities must equal the plan capabilities.",
          ),
        ],
      );
    }

    const unsupported = unsupportedDesiredState(plan.desired);
    if (unsupported.length > 0) throw planInvalid(unsupported);

    // Compile against the authoritative default branch/tree/blob immediately
    // before admission.  A successful CLI preflight is not authorization.
    const effective = await compileRepositoryEffectivePullRequestContract(this.#adapter, selector, {
      capabilities: plan.capabilities,
    });
    if (stableSerialize(planGeneration(plan)) !== stableSerialize(effectiveGeneration(effective))) {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED",
        "Repository governance changed after the plan was produced.",
        [
          diagnostic(
            "SEMANTIC_PR_GOVERNANCE_GENERATION_MISMATCH",
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
      const replanned = tryPlanSemanticPullRequest({
        artifact: materialization.artifact,
        capabilities: plan.capabilities,
      });
      if (!replanned.valid || replanned.plan === undefined) throw revalidationFailed(replanned.violations);
      if (serializeSemanticPullRequestMutationPlan(replanned.plan) !== serializeSemanticPullRequestMutationPlan(plan)) {
        throw new SemanticPullRequestExecutorError(
          "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED",
          "The supplied plan does not match execution-time Core materialization.",
          [
            diagnostic(
              "SEMANTIC_PR_PLAN_MISMATCH",
              "$.plan",
              "Versioned plan differs from the plan produced by the current Core contract.",
            ),
          ],
        );
      }
      admittedPlan = replanned.plan;
    } else if (request.artifact !== undefined) {
      const replanned = tryPlanSemanticPullRequest({ artifact: request.artifact, capabilities: plan.capabilities });
      if (!replanned.valid || replanned.plan === undefined) throw revalidationFailed(replanned.violations);
      if (serializeSemanticPullRequestMutationPlan(replanned.plan) !== serializeSemanticPullRequestMutationPlan(plan)) {
        throw new SemanticPullRequestExecutorError(
          "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED",
          "The supplied plan does not match the materialized Semantic Artifact.",
          [
            diagnostic(
              "SEMANTIC_PR_PLAN_ARTIFACT_MISMATCH",
              "$.artifact",
              "Plan artifact identity is not bound to the supplied artifact.",
            ),
          ],
        );
      }
      admittedPlan = replanned.plan;
    }

    const targetPrecondition = admittedPlan.preconditions.find(
      (precondition) => precondition.kind === "PULL_REQUEST_TARGET_ABSENT",
    );
    if (targetPrecondition === undefined) {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_PLAN_INVALID",
        "The Semantic PR plan has no target-absence precondition.",
        [
          diagnostic(
            "SEMANTIC_PR_TARGET_PRECONDITION_MISSING",
            "$.preconditions",
            "Target absence is required before creation.",
          ),
        ],
      );
    }
    let existing: readonly GitHubPullRequest[];
    try {
      existing = await this.#adapter.listPullRequests(targetPrecondition.head, targetPrecondition.base);
    } catch {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_READ_FAILED",
        "Unable to read current pull-request target state before mutation.",
        [
          diagnostic(
            "SEMANTIC_PR_TARGET_READ_FAILED",
            "$.preconditions",
            "Current target state could not be established.",
          ),
        ],
      );
    }
    if (existing.length > 0) {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_PRECONDITION_FAILED",
        "A pull request already exists for the planned head and base.",
        [diagnostic("SEMANTIC_PR_TARGET_EXISTS", "$.preconditions", "Target-absence precondition is not satisfied.")],
        { existingCount: existing.length },
      );
    }

    const artifact = semanticMutationArtifact(admittedPlan);
    let created: GitHubPullRequest;
    try {
      created = await this.#adapter.createSemanticPullRequest(artifact);
    } catch {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_EFFECT_FAILED",
        "GitHub pull-request creation failed.",
        [diagnostic("SEMANTIC_PR_EFFECT_FAILED", "$.effects[0]", "CREATE_PULL_REQUEST did not succeed.")],
        undefined,
        executionEvidence("failed", "failed", undefined, {
          code: "SEMANTIC_PR_EFFECT_FAILED",
          message: "CREATE_PULL_REQUEST did not succeed.",
        }),
      );
    }

    let after: GitHubPullRequest;
    try {
      after = await this.#adapter.getPullRequest(created.number);
    } catch {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_READ_FAILED",
        "Created pull request could not be reread for postcondition verification.",
        [
          diagnostic(
            "SEMANTIC_PR_POSTCONDITION_READ_FAILED",
            "$.projection",
            "Created pull request state could not be reread.",
          ),
        ],
        undefined,
        executionEvidence(
          "failed",
          "succeeded",
          { number: created.number, url: created.url },
          {
            code: "SEMANTIC_PR_POSTCONDITION_READ_FAILED",
            message: "Created pull request state could not be reread.",
          },
        ),
      );
    }
    const mismatches = projectionMismatches(admittedPlan.desired, after);
    if (mismatches.length > 0) {
      throw new SemanticPullRequestExecutorError(
        "SEMANTIC_PR_EXECUTION_PROJECTION_VERIFICATION_FAILED",
        "Observed pull request does not satisfy the desired Semantic PR projection.",
        mismatches,
        undefined,
        executionEvidence(
          "failed",
          "succeeded",
          { number: after.number, url: after.url },
          {
            code: "SEMANTIC_PR_PROJECTION_MISMATCH",
            message: "Observed pull request differs from the desired projection.",
          },
        ),
      );
    }

    return Object.freeze({
      plan: admittedPlan,
      projection: observedProjection(after),
      evidence: executionEvidence("verified", "succeeded", { number: after.number, url: after.url }),
    });
  }
}

/** Explicit alias for callers naming the local deployment. */
export const LocalSemanticPullRequestExecutor = SemanticPullRequestExecutor;
