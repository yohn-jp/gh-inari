/**
 * Native MCP tools for the semantic artifact and Operational Observation Core boundaries.
 *
 * This module owns only protocol translation. Repository policy, effective
 * contract compilation, materialization, projection, and planning remain in
 * the existing Core modules. The same registration function can therefore be
 * used by stdio and a future hosted transport without changing semantics.
 */

import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GoldenPathRecoverySource } from "../golden-path-recovery.js";
import {
  ArtifactContractResolutionError,
  compileRepositoryEffectiveArtifactContract,
  compileRepositoryEffectiveBranchContract,
  compileRepositoryEffectiveIssueContract,
  compileRepositoryEffectivePullRequestContract,
  type RepositoryEffectiveArtifactContractOptions,
} from "../artifact-contract-governance.js";
import {
  EffectiveArtifactContractCompilationError,
  type EffectiveArtifactContract,
} from "../contract/effective-artifact-contract.js";
import {
  SemanticArtifactMaterializationError,
  tryMaterializeSemanticArtifact,
  type SemanticArtifact,
} from "../contract/semantic-artifact.js";
import {
  SemanticBranchProjectionError,
  tryPlanSemanticBranch,
  type SemanticBranchMutationPlan,
} from "../semantic-branch-projection.js";
import { compareSemanticBranchProjection, tryObserveSemanticBranch } from "../semantic-branch-observation.js";
import {
  SemanticIssueProjectionError,
  tryPlanSemanticIssue,
  type SemanticIssueMutationPlan,
} from "../semantic-issue-projection.js";
import { compareSemanticIssueProjection, tryObserveSemanticIssue } from "../semantic-issue-observation.js";
import { tryObserveOperationalIssue, tryObserveOperationalPullRequest } from "../operational-observation.js";
import { tryDiscoverOperationalIssues, tryDiscoverOperationalPullRequests } from "../operational-discovery.js";
import {
  SemanticPullRequestProjectionError,
  tryPlanSemanticPullRequest,
  type SemanticPullRequestMutationPlan,
} from "../semantic-pr-projection.js";
import { compareSemanticPullRequestProjection, tryObserveSemanticPullRequest } from "../semantic-pr-observation.js";
import { projectGoldenPathRecovery } from "../golden-path-recovery.js";
import { tryProjectGoldenPathStatus } from "../golden-path-status.js";
import {
  createActionsChangeExecutionAdapter,
  createGitHubChangeReadAdapter,
  GitHubAdapter,
  GitHubIssueRelationObservationAdapter,
  isGitHubAdapterError,
  type GitHubAdapterOptions,
  type IssueRelationDiagnostic,
} from "../github/index.js";
import { GITHUB_ISSUE_PROJECTION_CAPABILITIES } from "../semantic-issue-projection.js";
import {
  changeReadRequest,
  ChangeExecutionPortError,
  readChangeProjection,
  type ChangeExecutionPort,
  type ChangeExecutionPortOptions,
} from "../change-execution-port.js";
import type {
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
} from "../session-authorized-change-executor.js";
import { tryProjectImplementationHandoff } from "../change-handoff.js";
import { tryProjectGoldenPathEntry } from "../golden-path-entry.js";
import { tryProjectImplementationFrontier } from "../implementation-frontier.js";
import {
  composeImplementationFrontier,
  createGitHubImplementationFrontierRepository,
} from "../implementation-frontier-composition.js";
import {
  tryVerifyImplementationAuthorization,
  validateImplementationAuthorizationRecord,
} from "../implementation-authorization.js";
import { planExistingIssueRelationReconciliation } from "../semantic-issue-relation-executor.js";
import { projectOperationalSemanticOverlay } from "../reconciliation.js";
import type { McpSessionAppBridge } from "./session-app-bridge.js";

/** Version of the Inari-owned MCP tool/input/output contract. */
export const INARI_MCP_TOOL_CONTRACT_VERSION = "1" as const;

export const INARI_MCP_TOOL_NAMES = Object.freeze([
  "inari_golden_path_status",
  "inari_issue_contract",
  "inari_issue_materialize",
  "inari_issue_plan",
  "inari_issue_observe",
  "inari_issue_view",
  "inari_issue_list",
  "inari_issue_drift",
  "inari_issue_relations_plan",
  "inari_branch_contract",
  "inari_branch_materialize",
  "inari_branch_plan",
  "inari_branch_observe",
  "inari_branch_drift",
  "inari_pr_contract",
  "inari_pr_materialize",
  "inari_pr_plan",
  "inari_pr_observe",
  "inari_pr_view",
  "inari_pr_list",
  "inari_pr_drift",
  "inari_pr_comment",
  "inari_pr_review",
  "inari_pr_merge",
  "inari_golden_path_entry",
  "inari_change_handoff",
  "inari_impl_frontier",
] as const);

/** Optional privileged catalog, enabled only by an embedding with App execution. */
export const INARI_MCP_PRIVILEGED_TOOL_NAMES = Object.freeze(["inari_change_execute"] as const);

export type InariMcpToolName = (typeof INARI_MCP_TOOL_NAMES)[number];

const MAX_STRING_LENGTH = 1_024;
const MAX_CAPABILITIES = 64;
const MAX_INPUT_PROPERTIES = 200;

function boundedString(description: string): z.ZodString {
  return z
    .string()
    .min(1)
    .max(MAX_STRING_LENGTH)
    .refine((value) => !/[\u0000\r\n]/u.test(value), { message: "String contains an unsafe control character." })
    .describe(description);
}

const repositorySchema = boundedString("Optional GitHub repository override.");
const templateSchema = boundedString("Optional repository Canon/template selector.");
const capabilitySchema = boundedString("Opaque target capability identifier.");
const artifactNumberSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647)
  .describe("GitHub Issue or pull-request number.");
const branchNameSchema = boundedString("Git branch name to observe.");
const branchSourceSchema = boundedString("Explicit Git branch source evidence.");

const inputValueSchema = z
  .record(z.string().min(1).max(MAX_STRING_LENGTH), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_INPUT_PROPERTIES, {
    message: `input must contain at most ${MAX_INPUT_PROPERTIES} properties`,
  })
  .describe("Caller-supplied semantic values. Core validates the closed-world contract.");

const commonRequestShape = {
  repository: repositorySchema.optional(),
  template: templateSchema.optional(),
  capabilities: z.array(capabilitySchema).max(MAX_CAPABILITIES).optional(),
};

/** Input schema shared by contract discovery and the two semantic operations. */
export const semanticPullRequestContractInputSchema = z.strictObject(commonRequestShape);

/** Input schema for semantic PR materialization. */
export const semanticPullRequestMaterializeInputSchema = z.strictObject({
  ...commonRequestShape,
  input: inputValueSchema,
});

/** Input schema for semantic PR plan preview. */
export const semanticPullRequestPlanInputSchema = z.strictObject({
  ...commonRequestShape,
  input: inputValueSchema,
});

/** Issue and Branch use the same closed-world request shape as PR. */
export const semanticIssueContractInputSchema = z.strictObject(commonRequestShape);
export const semanticIssueMaterializeInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
export const semanticIssuePlanInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
export const semanticBranchContractInputSchema = z.strictObject(commonRequestShape);
export const semanticBranchMaterializeInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });
export const semanticBranchPlanInputSchema = z.strictObject({ ...commonRequestShape, input: inputValueSchema });

/** Input schemas for bounded provider observation and Core drift comparison. */
export const semanticIssueObserveInputSchema = z.strictObject({
  ...commonRequestShape,
  number: artifactNumberSchema,
});
export const semanticIssueDriftInputSchema = z.strictObject({
  ...commonRequestShape,
  number: artifactNumberSchema,
  input: inputValueSchema,
});
export const semanticBranchObserveInputSchema = z.strictObject({
  ...commonRequestShape,
  name: branchNameSchema,
  source: branchSourceSchema,
});
export const semanticBranchDriftInputSchema = z.strictObject({
  ...commonRequestShape,
  input: inputValueSchema,
});

/** Input schema for the read-only Golden Path status composition. */
export const goldenPathStatusInputSchema = z.strictObject({
  input: inputValueSchema.describe("Bounded evidence consumed by the Golden Path status projector."),
  recoveryInput: inputValueSchema
    .optional()
    .describe("Optional bounded Change execution or recovery-plan evidence consumed by the recovery projector."),
});
export const semanticPullRequestObserveInputSchema = z.strictObject({
  ...commonRequestShape,
  number: artifactNumberSchema,
});

const discoveryStateSchema = z.enum(["open", "closed", "all"]);
const discoveryPageSchema = z.number().int().min(1).max(10_000).describe("Explicit bounded discovery page number.");
const discoveryLimitSchema = z.number().int().min(1).max(100).describe("Maximum results in one discovery page.");
export const operationalIssueListInputSchema = z.strictObject({
  repository: repositorySchema.optional(),
  state: discoveryStateSchema.optional(),
  page: discoveryPageSchema.optional(),
  limit: discoveryLimitSchema.optional(),
});
export const operationalPullRequestListInputSchema = z.strictObject({
  repository: repositorySchema.optional(),
  state: discoveryStateSchema.optional(),
  head: branchNameSchema.optional(),
  base: branchNameSchema.optional(),
  page: discoveryPageSchema.optional(),
  limit: discoveryLimitSchema.optional(),
});
export const semanticPullRequestDriftInputSchema = z.strictObject({
  ...commonRequestShape,
  number: artifactNumberSchema,
  input: inputValueSchema,
});

/**
 * Input schema for previewing existing-Issue native relationship
 * reconciliation. Read-only: this composes live observation with Core
 * planning but never mutates GitHub, matching the read-only MCP boundary
 * this tool and every other semantic artifact tool uses. Privileged Change
 * execution is a separate, explicitly configured Session/App bridge.
 */
export const issueRelationsPlanInputSchema = z.strictObject({
  repository: repositorySchema.optional(),
  capabilities: z.array(capabilitySchema).max(MAX_CAPABILITIES).optional(),
  number: artifactNumberSchema,
  desired: inputValueSchema,
  graph: z.unknown().optional(),
});
export type IssueRelationsPlanInput = z.infer<typeof issueRelationsPlanInputSchema>;

/**
 * Input schema for the read-only canonical implementation handoff.
 *
 * `authorization` identifies an authorization record the caller wants
 * re-verified; it is never accepted as an already-current authorization by
 * itself. The handler always reruns it through the canonical Implementation
 * authorization boundary against a fresh Issue/base reread, and only an
 * authorization that boundary confirms is still authorized and current can
 * become the handoff's authorization.
 */
export const implementationHandoffInputSchema = z.strictObject({
  repository: repositorySchema.optional(),
  issue: artifactNumberSchema,
  implementation: z.unknown().optional(),
  authorization: z.unknown().optional(),
  sourceIssues: z.array(z.unknown()).optional(),
  compatibility: z.enum(["implementation-native", "historical-issue-root"]).optional(),
});

/**
 * The value is intentionally opaque here. The canonical Session request
 * validator and executor own its structure, signature, freshness, and
 * repository/task bindings; MCP must not create a second envelope contract.
 */
export const sessionAuthorizedChangeInputSchema = z.strictObject({
  envelope: z.unknown().describe("Canonical signed Session request envelope; never include private credentials."),
});
export type SessionAuthorizedChangeInput = z.infer<typeof sessionAuthorizedChangeInputSchema>;

/** Compatibility name for callers that prefix the handoff with Change. */
export const changeImplementationHandoffInputSchema = implementationHandoffInputSchema;

/**
 * Input schema for the read-only Golden Path entry/action projection.
 *
 * `implementationAuthorization`/`implementationReadiness` identify evidence
 * the caller wants re-verified (e.g. a previously issued authorization
 * record); they are never accepted as an already-decided authorized/current
 * assertion. The handler always reruns them through the canonical
 * Implementation authorization boundary against a fresh Issue/base reread
 * before composing Golden Path state. Caller-supplied conformance is not
 * accepted at all: this read-only surface has no verified PR/check evidence
 * boundary to re-derive it from.
 */
export const goldenPathEntryInputSchema = z.strictObject({
  repository: repositorySchema.optional(),
  issue: artifactNumberSchema,
  sourceIssue: z.unknown().optional(),
  implementation: z.unknown().optional(),
  implementationAuthorization: z.unknown().optional(),
  implementationReadiness: z.unknown().optional(),
  compatibility: z.enum(["implementation-native", "historical-issue-root"]).optional(),
});
export type GoldenPathEntryInput = z.infer<typeof goldenPathEntryInputSchema>;

export type SemanticPullRequestContractInput = z.infer<typeof semanticPullRequestContractInputSchema>;
export type SemanticPullRequestMaterializeInput = z.infer<typeof semanticPullRequestMaterializeInputSchema>;
export type SemanticPullRequestPlanInput = z.infer<typeof semanticPullRequestPlanInputSchema>;
export type SemanticIssueContractInput = z.infer<typeof semanticIssueContractInputSchema>;
export type SemanticIssueMaterializeInput = z.infer<typeof semanticIssueMaterializeInputSchema>;
export type SemanticIssuePlanInput = z.infer<typeof semanticIssuePlanInputSchema>;
export type SemanticBranchContractInput = z.infer<typeof semanticBranchContractInputSchema>;
export type SemanticBranchMaterializeInput = z.infer<typeof semanticBranchMaterializeInputSchema>;
export type SemanticBranchPlanInput = z.infer<typeof semanticBranchPlanInputSchema>;
export type SemanticIssueObserveInput = z.infer<typeof semanticIssueObserveInputSchema>;
export type SemanticIssueViewInput = SemanticIssueObserveInput;
export type SemanticIssueDriftInput = z.infer<typeof semanticIssueDriftInputSchema>;
export type SemanticBranchObserveInput = z.infer<typeof semanticBranchObserveInputSchema>;
export type SemanticBranchDriftInput = z.infer<typeof semanticBranchDriftInputSchema>;
export type SemanticPullRequestObserveInput = z.infer<typeof semanticPullRequestObserveInputSchema>;
export type SemanticPullRequestViewInput = SemanticPullRequestObserveInput;
export type SemanticPullRequestDriftInput = z.infer<typeof semanticPullRequestDriftInputSchema>;
export type OperationalIssueListInput = z.infer<typeof operationalIssueListInputSchema>;
export type OperationalPullRequestListInput = z.infer<typeof operationalPullRequestListInputSchema>;
export type ImplementationHandoffInput = z.infer<typeof implementationHandoffInputSchema>;
export type ChangeImplementationHandoffInput = ImplementationHandoffInput;
export type GoldenPathStatusMcpInput = z.infer<typeof goldenPathStatusInputSchema>;

/** Injectable Core adapter seam used by stdio and tests. */
export interface NativeSemanticPullRequestDependencies {
  /** Local repository working directory used for GitHubAdapter resolution. */
  readonly repositoryRoot?: string;
  /** Default repository target for requests that omit `repository`. */
  readonly repository?: string;
  /** Direct adapter seam for tests or an embedding application. */
  readonly adapter?: GitHubAdapter;
  /** Factory seam for repository-scoped adapter construction. */
  readonly createAdapter?: (options: GitHubAdapterOptions) => GitHubAdapter;
}

/** Shared dependency seam for all read-only semantic artifact catalogs. */
export interface NativeSemanticArtifactDependencies extends NativeSemanticPullRequestDependencies {}

/** Injectable read boundary for Change projections exposed through MCP. */
export interface NativeChangeDependencies extends NativeSemanticPullRequestDependencies {
  /** Direct semantic executor seam for tests or embedding applications. */
  readonly changeExecutor?: ChangeExecutionPort;
  /** Factory seam for repository-scoped Change executor construction. */
  readonly createChangeExecutor?: (options: ChangeExecutionPortOptions) => ChangeExecutionPort;
  /** Existing Session-authorized App executor; absent for the read-only catalog. */
  readonly sessionExecutor?: CapabilityAuthorizedSessionExecutor;
}

const READ_ONLY: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

/**
 * Core result fields are intentionally explicit so malformed adapter output
 * fails closed. The adapter never rewrites or narrows the nested Effective
 * Contract, Artifact, or Plan.
 */
export const semanticPullRequestOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    operation: z.string().optional(),
    phase: z.enum(["contract", "materialization", "projection", "observation", "comparison"]).optional(),
    version: z.union([z.string(), z.number()]).optional(),
    artifactContractVersion: z.string().optional(),
    kind: z.string().optional(),
    id: z.string().optional(),
    contract: z.unknown().optional(),
    effectiveContract: z.unknown().optional(),
    inputSchema: z.unknown().optional(),
    properties: z.unknown().optional(),
    fields: z.unknown().optional(),
    derivations: z.unknown().optional(),
    dependencyGraph: z.unknown().optional(),
    evaluationOrder: z.unknown().optional(),
    capabilities: z.unknown().optional(),
    number: artifactNumberSchema.optional(),
    url: z.string().optional(),
    artifact: z.unknown().optional(),
    plan: z.unknown().optional(),
    outcome: z.enum(["succeeded", "idempotent", "stale", "blocked", "failed", "recovery-required"]).optional(),
    code: z.string().optional(),
    evidence: z.unknown().optional(),
    current: z.unknown().optional(),
    resource: z.unknown().optional(),
    desired: z.unknown().optional(),
    observed: z.unknown().optional(),
    semantic: z.unknown().optional(),
    comparison: z.unknown().optional(),
    drift: z.array(z.unknown()).optional(),
    observationDiagnostics: z.array(z.unknown()).optional(),
    provenance: z.unknown().optional(),
    generation: z.unknown().optional(),
    diagnostics: z.array(z.unknown()).optional(),
    violations: z.array(z.unknown()).optional(),
    preview: z.boolean().optional(),
    mutation: z.boolean().optional(),
  })
  .strict();

export type SemanticPullRequestMcpOutput = z.infer<typeof semanticPullRequestOutputSchema>;
export type SemanticIssueMcpOutput = SemanticPullRequestMcpOutput;
export type SemanticBranchMcpOutput = SemanticPullRequestMcpOutput;
export const semanticIssueOutputSchema = semanticPullRequestOutputSchema;
export const semanticBranchOutputSchema = semanticPullRequestOutputSchema;

const composedViewSemanticOutputSchema = z
  .object({
    status: z.enum([
      "valid",
      "malformed-template",
      "no-matching-template",
      "legacy-artifact",
      "ambiguous-template",
      "semantic-invalidity",
      "governance-evidence-unavailable",
      "provider-failure",
    ]),
    classification: z.enum(["valid", "semantic", "wrong-template", "unparseable", "ambiguous"]).optional(),
    result: z.unknown().optional(),
    diagnostics: z.array(z.unknown()),
    failure: z
      .object({
        kind: z.enum(["governance-evidence", "provider"]),
        code: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Dedicated contract for the composed Issue/PR view surface. */
export const composedViewOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    operation: z.enum(["issue.view", "pr.view"]),
    kind: z.enum(["issue", "pull_request"]),
    version: z.union([z.string(), z.number()]),
    number: artifactNumberSchema,
    url: z.string(),
    observed: z.unknown(),
    semantic: composedViewSemanticOutputSchema,
    mutation: z.literal(false),
    phase: z.literal("observation").optional(),
    diagnostics: z.array(z.unknown()).optional(),
    violations: z.array(z.unknown()).optional(),
  })
  .strict();

export type ComposedViewMcpOutput = z.infer<typeof composedViewOutputSchema>;

export const operationalDiscoveryOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    operation: z.enum(["issue.list", "pr.list"]).optional(),
    kind: z.enum(["issue", "pull_request"]).optional(),
    phase: z.literal("discovery").optional(),
    version: z.number().int().optional(),
    discovered: z.unknown().optional(),
    diagnostics: z.array(z.unknown()),
    violations: z.array(z.unknown()).optional(),
    mutation: z.literal(false).optional(),
  })
  .strict();

/** Structured output schema for the canonical Change implementation handoff. */
export const implementationHandoffOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    operation: z.literal("change.handoff"),
    issue: artifactNumberSchema,
    change: artifactNumberSchema.optional(),
    status: z.string().optional(),
    state: z.string().optional(),
    canonicalBranch: z.string().optional(),
    canonicalBaseBranch: z.string().optional(),
    branch: z.string().optional(),
    pullRequest: artifactNumberSchema.optional(),
    handoff: z.unknown().optional(),
    projection: z.unknown().optional(),
    diagnostics: z.array(z.unknown()),
  })
  .strict();

export const changeImplementationHandoffOutputSchema = implementationHandoffOutputSchema;

/** Structured projection of the canonical Session-authorized execution result. */
export const sessionAuthorizedChangeOutputSchema = z
  .object({
    version: z.literal(1),
    operation: z
      .enum(["change.issue", "change.show", "change.ready", "change.abort", "change.merge", "branch.advance"])
      .optional(),
    status: z.enum(["succeeded", "failed"]),
    projection: z.unknown().optional(),
    execution: z.unknown().optional(),
    branchAdvance: z.unknown().optional(),
    provenance: z.unknown().optional(),
    failure: z.unknown().optional(),
  })
  .strict();

/** Structured output schema for a read-only Golden Path entry projection. */
export const goldenPathEntryOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    operation: z.literal("golden-path.entry"),
    issue: artifactNumberSchema,
    entry: z.unknown().optional(),
    diagnostics: z.array(z.unknown()),
    preview: z.literal(true),
    mutation: z.literal(false),
  })
  .strict();

/** Output schema for the transport-neutral Golden Path envelope. */
export const goldenPathStatusOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    phase: z.literal("projection").optional(),
    version: z.number().int().optional(),
    subject: z.unknown().optional(),
    status: z.unknown().optional(),
    nextAction: z.unknown().nullable().optional(),
    recovery: z.unknown().nullable().optional(),
    diagnostics: z.array(z.unknown()),
    violations: z.array(z.unknown()).optional(),
  })
  .strict();

export type GoldenPathStatusMcpOutput = z.infer<typeof goldenPathStatusOutputSchema>;

export const implementationFrontierInputSchema = z
  .strictObject({
    repository: repositorySchema.optional(),
    issue: artifactNumberSchema.optional().describe("Starting Issue number for repository-backed composition."),
    evidence: z
      .unknown()
      .optional()
      .describe("Optional existing raw frontier evidence supplied as low-level supplemental evidence."),
    frontier: z
      .unknown()
      .optional()
      .describe("Existing bounded authoritative evidence consumed directly by the Core projector."),
  })
  .refine((input) => (input.issue === undefined) === (input.frontier !== undefined), {
    message: "Provide exactly one of issue or frontier.",
    path: ["issue"],
  });

export const implementationFrontierOutputSchema = z
  .object({
    ok: z.boolean(),
    valid: z.boolean(),
    operation: z.literal("impl.frontier"),
    frontier: z.unknown().optional(),
    diagnostics: z.array(z.unknown()),
    mutation: z.literal(false),
  })
  .strict();

export type ImplementationFrontierMcpInput = z.infer<typeof implementationFrontierInputSchema>;

function adapterFor(
  requestRepository: string | undefined,
  dependencies: NativeSemanticPullRequestDependencies,
): GitHubAdapter {
  if (dependencies.adapter !== undefined) return dependencies.adapter;
  const repository = requestRepository ?? dependencies.repository;
  const options: GitHubAdapterOptions = {
    ...(dependencies.repositoryRoot === undefined ? {} : { cwd: dependencies.repositoryRoot }),
    ...(repository === undefined ? {} : { repository }),
  };
  return (dependencies.createAdapter ?? ((adapterOptions) => new GitHubAdapter(adapterOptions)))(options);
}

function changeExecutorFor(
  requestRepository: string | undefined,
  dependencies: NativeChangeDependencies,
): ChangeExecutionPort {
  if (dependencies.changeExecutor !== undefined) return dependencies.changeExecutor;
  const cwd = dependencies.repositoryRoot ?? process.cwd();
  const repository = requestRepository ?? dependencies.repository;
  const options: ChangeExecutionPortOptions = {
    cwd,
    ...(repository === undefined ? {} : { repository }),
  };
  if (dependencies.createChangeExecutor !== undefined) return dependencies.createChangeExecutor(options);
  return createActionsChangeExecutionAdapter(options);
}

function implementationReferenceNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.reference) ? value.reference : value;
  const number = candidate.number;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 1 ? number : undefined;
}

/**
 * Reread the Implementation Issue and rerun caller-supplied authorization
 * (and optional readiness) evidence through the canonical Implementation
 * authorization boundary. A caller can never assert `authorized`/`current`/
 * `status` directly: only what this reverification derives from the fresh
 * Issue body and base evidence is trustworthy Golden Path composition input.
 */
async function resolveVerifiedImplementationAuthorization(
  implementationValue: unknown,
  authorizationInput: unknown,
  readinessInput: unknown,
  requestRepository: string | undefined,
  dependencies: NativeChangeDependencies,
): Promise<unknown> {
  if (authorizationInput === undefined) return undefined;
  const number = implementationReferenceNumber(implementationValue);
  if (number === undefined) return undefined;
  try {
    const adapter = adapterFor(requestRepository, dependencies);
    const context = await adapter.getRepositoryContext();
    const issue = await adapter.getIssue(number);
    const repositoryId = issue.repositoryId ?? context.repositoryId;
    if (repositoryId === undefined) return undefined;
    const repository = {
      repositoryHost: (issue.repositoryHost ?? context.hostname).toLocaleLowerCase("en-US"),
      repositoryId,
      repository: context.nameWithOwner.toLocaleLowerCase("en-US"),
    };
    const reference = { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, number };
    const recordCandidate =
      isRecord(authorizationInput) && isRecord(authorizationInput.record)
        ? authorizationInput.record
        : authorizationInput;
    const validatedRecord = validateImplementationAuthorizationRecord(recordCandidate);
    let base: { readonly branch: string; readonly revision: string; readonly freshness: string } | undefined;
    const branchName = validatedRecord.record?.base.branch;
    if (branchName !== undefined) {
      const branch = await adapter.findBranch(branchName);
      if (branch !== undefined && branch.sha.length > 0)
        base = { branch: branch.name, revision: branch.sha, freshness: branch.sha };
    }
    return tryVerifyImplementationAuthorization({
      authorization: authorizationInput,
      issue: { reference, body: issue.body ?? "" },
      repository,
      ...(base === undefined ? {} : { base }),
      ...(readinessInput === undefined ? {} : { readiness: readinessInput }),
    });
  } catch {
    return undefined;
  }
}

/** Resolve the repository Canon through the existing repository/Core boundary. */
export async function resolveSemanticPullRequestContract(
  input: SemanticPullRequestContractInput,
  dependencies: NativeSemanticPullRequestDependencies = {},
): Promise<EffectiveArtifactContract> {
  const adapter = adapterFor(input.repository, dependencies);
  const options: RepositoryEffectiveArtifactContractOptions =
    input.capabilities === undefined ? {} : { capabilities: input.capabilities };
  return compileRepositoryEffectivePullRequestContract(adapter, input.template, options);
}

/** Resolve any supported Artifact Contract through the repository/Core boundary. */
async function resolveSemanticArtifactContract(
  kind: "issue" | "branch" | "pull_request",
  input: { readonly repository?: string; readonly template?: string; readonly capabilities?: readonly string[] },
  dependencies: NativeSemanticArtifactDependencies,
): Promise<EffectiveArtifactContract> {
  const adapter = adapterFor(input.repository, dependencies);
  return compileSemanticArtifactContract(kind, input, adapter);
}

async function compileSemanticArtifactContract(
  kind: "issue" | "branch" | "pull_request",
  input: { readonly template?: string; readonly capabilities?: readonly string[] },
  adapter: GitHubAdapter,
): Promise<EffectiveArtifactContract> {
  const options: RepositoryEffectiveArtifactContractOptions =
    input.capabilities === undefined ? {} : { capabilities: input.capabilities };
  if (kind === "issue") return compileRepositoryEffectiveIssueContract(adapter, input.template, options);
  if (kind === "branch") return compileRepositoryEffectiveBranchContract(adapter, input.template, options);
  return compileRepositoryEffectiveArtifactContract(adapter, kind, input.template, options);
}

/** Resolve the repository Canon for a semantic Issue. */
export async function resolveSemanticIssueContract(
  input: SemanticIssueContractInput,
  dependencies: NativeSemanticArtifactDependencies = {},
): Promise<EffectiveArtifactContract> {
  return resolveSemanticArtifactContract("issue", input, dependencies);
}

/** Resolve the repository Canon for a semantic Branch. */
export async function resolveSemanticBranchContract(
  input: SemanticBranchContractInput,
  dependencies: NativeSemanticArtifactDependencies = {},
): Promise<EffectiveArtifactContract> {
  return resolveSemanticArtifactContract("branch", input, dependencies);
}

function contractProjection(effectiveContract: EffectiveArtifactContract): SemanticPullRequestMcpOutput {
  return {
    ok: true,
    valid: true,
    version: effectiveContract.version,
    artifactContractVersion: effectiveContract.artifactContractVersion,
    kind: effectiveContract.kind,
    id: effectiveContract.id,
    contract: effectiveContract.contract,
    effectiveContract,
    inputSchema: effectiveContract.inputSchema,
    properties: effectiveContract.properties,
    ...(effectiveContract.fields === undefined ? {} : { fields: effectiveContract.fields }),
    derivations: effectiveContract.derivations,
    dependencyGraph: effectiveContract.dependencyGraph,
    evaluationOrder: effectiveContract.evaluationOrder,
    provenance: effectiveContract.provenance,
    generation: effectiveContract.generation,
    capabilities: effectiveContract.capabilities,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Semantic PR Core operation failed.";
  return message.length > 4_096 ? `${message.slice(0, 4_096)}…` : message;
}

function boundedDiagnostics(diagnostics: readonly unknown[]): unknown[] {
  return diagnostics.slice(0, 64).map((diagnostic) => {
    if (!isRecord(diagnostic)) return diagnostic;
    const message = diagnostic.message;
    if (typeof message !== "string" || message.length <= 4_096) return diagnostic;
    return { ...diagnostic, message: `${message.slice(0, 4_096)}…` };
  });
}

function diagnosticsForError(error: unknown): unknown[] {
  if (error instanceof ArtifactContractResolutionError) return boundedDiagnostics(error.diagnostics);
  if (error instanceof SemanticArtifactMaterializationError) return boundedDiagnostics(error.violations);
  if (error instanceof SemanticPullRequestProjectionError) return boundedDiagnostics(error.violations);
  if (error instanceof SemanticIssueProjectionError) return boundedDiagnostics(error.violations);
  if (error instanceof SemanticBranchProjectionError) return boundedDiagnostics(error.violations);
  if (isGitHubAdapterError(error)) {
    return [
      {
        code: error.code,
        path: typeof error.details.path === "string" ? error.details.path : "$",
        message: boundedErrorMessage(error),
      },
    ];
  }
  if (error instanceof EffectiveArtifactContractCompilationError) {
    return [{ code: "EFFECTIVE_CONTRACT_INVALID", path: "$", message: boundedErrorMessage(error) }];
  }
  if (error instanceof ChangeExecutionPortError) {
    const diagnostics = error.diagnostics === undefined ? [] : boundedDiagnostics(error.diagnostics);
    return diagnostics.length > 0
      ? diagnostics
      : [{ code: error.code, path: "$", message: boundedErrorMessage(error) }];
  }
  return [{ code: "CORE_OPERATION_FAILED", path: "$", message: boundedErrorMessage(error) }];
}

function failure(
  phase: "contract" | "materialization" | "projection" | "observation" | "comparison",
  diagnostics: readonly unknown[] | unknown,
): SemanticPullRequestMcpOutput {
  const normalized = Array.isArray(diagnostics) ? boundedDiagnostics(diagnostics) : diagnosticsForError(diagnostics);
  return {
    ok: false,
    valid: false,
    phase,
    diagnostics: normalized,
    violations: normalized,
  };
}

function result<T extends Record<string, unknown>>(data: T, summary: string): CallToolResult {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
}

function operationalViewFailure(
  domain: "issue" | "pr",
  number: number,
  diagnostics: readonly unknown[],
): Readonly<Record<string, unknown>> {
  const bounded = boundedDiagnostics(diagnostics);
  return {
    ok: false,
    valid: false,
    operation: `${domain}.view`,
    kind: domain === "issue" ? "issue" : "pull_request",
    version: 1,
    number,
    url: "",
    observed: null,
    semantic: { status: "provider-failure", diagnostics: bounded },
    mutation: false,
    phase: "observation",
    diagnostics: bounded,
    violations: bounded,
  };
}

function projectChangeHandoffResult(
  issue: number,
  projection: Awaited<ReturnType<typeof readChangeProjection>>,
  options: {
    readonly repositoryNameWithOwner?: string;
    readonly implementation?: unknown;
    readonly authorization?: unknown;
    readonly sourceIssues?: readonly unknown[];
    readonly compatibility?: "implementation-native" | "historical-issue-root";
  } = {},
): Record<string, unknown> {
  const change = projection.change;
  const changeProjection = change?.projection;
  const handoff = tryProjectImplementationHandoff(projection, options);
  return {
    ok: handoff.valid,
    valid: handoff.valid,
    operation: "change.handoff",
    issue,
    change: change?.identity.rootIssue ?? issue,
    status: projection.status,
    ...(change === undefined ? {} : { state: change.state }),
    ...(projection.canonicalBranch === undefined ? {} : { canonicalBranch: projection.canonicalBranch }),
    ...(projection.canonicalBaseBranch === undefined ? {} : { canonicalBaseBranch: projection.canonicalBaseBranch }),
    ...(changeProjection?.branch === undefined ? {} : { branch: changeProjection.branch }),
    ...(changeProjection?.pullRequest === undefined ? {} : { pullRequest: changeProjection.pullRequest }),
    diagnostics: handoff.diagnostics,
    ...(handoff.handoff === undefined ? {} : { handoff: handoff.handoff }),
    projection,
  };
}

async function handleImplementationHandoff(
  input: ImplementationHandoffInput,
  dependencies: NativeChangeDependencies,
): Promise<CallToolResult> {
  try {
    const executor = changeExecutorFor(input.repository, dependencies);
    const projection = await readChangeProjection(executor, changeReadRequest(input.issue));
    let repositoryNameWithOwner: string | undefined;
    // Resolve a locator only when an adapter is actually available: either the
    // caller injected one directly, or no changeExecutor override exists (the
    // default path already builds a real adapter). Avoids a spurious `gh`
    // call when a caller/test stubs only the Change transport.
    if (
      dependencies.adapter !== undefined ||
      dependencies.createAdapter !== undefined ||
      dependencies.changeExecutor === undefined
    ) {
      try {
        const context = await adapterFor(input.repository, dependencies).getRepositoryContext();
        repositoryNameWithOwner = context.nameWithOwner;
      } catch {
        repositoryNameWithOwner = undefined;
      }
    }
    // The caller may identify which authorization to hand off, but it never
    // chooses or asserts the authorization record that becomes handoff
    // authority: only an authorization this reverification confirms is
    // still authorized and current against a fresh Issue/base reread can
    // become the handoff's authorization.
    const verifiedAuthorization = await resolveVerifiedImplementationAuthorization(
      input.implementation,
      input.authorization,
      undefined,
      input.repository,
      dependencies,
    );
    const currentAuthorizationRecord =
      isRecord(verifiedAuthorization) &&
      verifiedAuthorization.authorized === true &&
      verifiedAuthorization.current === true
        ? verifiedAuthorization.authorization
        : undefined;
    return result(
      projectChangeHandoffResult(input.issue, projection, {
        repositoryNameWithOwner,
        ...(input.implementation === undefined ? {} : { implementation: input.implementation }),
        ...(currentAuthorizationRecord === undefined ? {} : { authorization: currentAuthorizationRecord }),
        ...(input.sourceIssues === undefined ? {} : { sourceIssues: input.sourceIssues }),
        ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
      }),
      "Read the canonical implementation handoff through the Change Core boundary.",
    );
  } catch (error: unknown) {
    return result(
      {
        ok: false,
        valid: false,
        operation: "change.handoff",
        issue: input.issue,
        diagnostics: diagnosticsForError(error),
      },
      "Implementation handoff is unavailable; see diagnostics.",
    );
  }
}

/**
 * Read the existing Change projection and expose the shared Golden Path
 * entry/action result without allowing the read-only MCP surface to issue a
 * Change. A missing Change remains fail-closed because this adapter cannot
 * establish governed root-Issue evidence for a create action.
 */
async function handleGoldenPathEntry(
  input: GoldenPathEntryInput,
  dependencies: NativeChangeDependencies,
): Promise<CallToolResult> {
  try {
    const executor = changeExecutorFor(input.repository, dependencies);
    const projection = await readChangeProjection(executor, changeReadRequest(input.issue));
    // Caller-supplied authorization/readiness evidence is never composed
    // directly: it is rerun through the canonical Implementation
    // authorization boundary against a fresh Issue/base reread first, so a
    // caller can never assert `authorized`/`current`/`status` by itself.
    const verifiedAuthorization = await resolveVerifiedImplementationAuthorization(
      input.implementation,
      input.implementationAuthorization,
      input.implementationReadiness,
      input.repository,
      dependencies,
    );
    const entry = tryProjectGoldenPathEntry({
      projection,
      requireGovernedIssue: false,
      ...(input.sourceIssue === undefined ? {} : { sourceIssue: input.sourceIssue }),
      ...(input.implementation === undefined ? {} : { implementation: input.implementation }),
      ...(verifiedAuthorization === undefined ? {} : { implementationAuthorization: verifiedAuthorization }),
      ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
    });
    return result(
      {
        ok: entry.valid,
        valid: entry.valid,
        operation: "golden-path.entry",
        issue: input.issue,
        entry,
        diagnostics: entry.diagnostics,
        preview: true,
        mutation: false,
      },
      entry.valid
        ? "Read the Golden Path entry and existing Change action through Core."
        : "Golden Path entry is not actionable; see diagnostics.",
    );
  } catch (error: unknown) {
    return result(
      {
        ok: false,
        valid: false,
        operation: "golden-path.entry",
        issue: input.issue,
        diagnostics: diagnosticsForError(error),
        preview: true,
        mutation: false,
      },
      "Golden Path entry is unavailable; see diagnostics.",
    );
  }
}

function goldenPathResult(data: GoldenPathStatusMcpOutput, summary: string): CallToolResult {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
}

function goldenPathFailure(diagnostics: readonly unknown[]): GoldenPathStatusMcpOutput {
  const bounded = boundedDiagnostics(diagnostics);
  return {
    ok: false,
    valid: false,
    phase: "projection",
    diagnostics: bounded,
    violations: bounded,
  };
}

const PUBLIC_GOLDEN_PATH_STATUS_NATIVE_AUTHORITY_KEYS = Object.freeze([
  "sourceIssue",
  "implementationAuthorization",
  "implementationReadiness",
  "implementationConformance",
  "compatibility",
] as const);

const PUBLIC_GOLDEN_PATH_STATUS_NATIVE_IMPLEMENTATION_KEYS = Object.freeze([
  "reference",
  "sourceIssue",
  "contract",
  "authorization",
  "readiness",
  "conformance",
  "change",
  "compatibility",
  "repositoryHost",
  "repositoryId",
  "number",
] as const);

function publicGoldenPathStatusAuthorityDiagnostics(input: Record<string, unknown>): readonly unknown[] {
  const diagnostics: Array<{ readonly code: string; readonly path: string; readonly message: string }> = [];
  for (const key of PUBLIC_GOLDEN_PATH_STATUS_NATIVE_AUTHORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key))
      diagnostics.push({
        code: "GOLDEN_PATH_AUTHORITY_INPUT_FORBIDDEN",
        path: `$.${key}`,
        message: "Public Golden Path status cannot accept caller-supplied Implementation authority evidence.",
      });
  }
  const implementation = input.implementation;
  if (
    isRecord(implementation) &&
    PUBLIC_GOLDEN_PATH_STATUS_NATIVE_IMPLEMENTATION_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(implementation, key),
    )
  )
    diagnostics.push({
      code: "GOLDEN_PATH_AUTHORITY_INPUT_FORBIDDEN",
      path: "$.implementation",
      message: "Public Golden Path status cannot accept a caller-supplied native Implementation authority projection.",
    });
  return diagnostics;
}

/** Compose the existing recovery and status projectors without adding policy. */
async function handleGoldenPathStatus(input: GoldenPathStatusMcpInput): Promise<CallToolResult> {
  try {
    // A caller cannot supply a precomputed recovery object as status evidence;
    // recovery must cross the #410 projector boundary first.
    const statusInput = { ...input.input };
    delete statusInput.recovery;
    // The pure status projector is also used by trusted in-process callers and
    // can compose canonical Implementation projections. The public MCP
    // boundary must not let an untrusted caller manufacture those authority
    // results, so native Implementation authority-bearing evidence is rejected
    // before it reaches the projector.
    const authorityDiagnostics = publicGoldenPathStatusAuthorityDiagnostics(statusInput);
    if (authorityDiagnostics.length > 0)
      return goldenPathResult(
        goldenPathFailure(authorityDiagnostics),
        "Golden Path status rejected caller-supplied Implementation authority evidence.",
      );
    const recovery =
      input.recoveryInput === undefined
        ? null
        : projectGoldenPathRecovery(input.recoveryInput as GoldenPathRecoverySource);
    const projected = tryProjectGoldenPathStatus({
      ...statusInput,
      recovery,
    });
    if (!projected.valid || projected.projection === undefined) {
      return goldenPathResult(
        goldenPathFailure(projected.diagnostics),
        "Golden Path status projection failed; see diagnostics.",
      );
    }
    return goldenPathResult(
      { ok: true, valid: true, ...projected.projection, diagnostics: [...projected.projection.diagnostics] },
      "Projected Golden Path status through the bounded Core projectors.",
    );
  } catch (error: unknown) {
    return goldenPathResult(
      goldenPathFailure(diagnosticsForError(error)),
      "Golden Path status projection failed; see diagnostics.",
    );
  }
}

function unavailableSessionExecution(): CapabilityAuthorizedSessionExecutionResult {
  return {
    version: 1,
    status: "failed",
    failure: {
      code: "SESSION_EXECUTION_FAILED",
      phase: "execution",
      message: "Session-authorized App execution failed closed.",
    },
  };
}

async function handleSessionAuthorizedChange(
  input: SessionAuthorizedChangeInput,
  bridge: McpSessionAppBridge,
): Promise<CallToolResult> {
  let execution: CapabilityAuthorizedSessionExecutionResult;
  try {
    execution = await bridge.execute(input.envelope);
  } catch {
    // The transport boundary must not expose executor/provider errors or
    // credential-bearing details. The canonical executor normally returns a
    // bounded result; this is only the unexpected adapter-failure fallback.
    execution = unavailableSessionExecution();
  }
  return result(
    execution as unknown as Record<string, unknown>,
    execution.status === "succeeded"
      ? "Completed through the canonical Session-authorized App execution path."
      : "Session-authorized App execution failed closed; see the bounded result.",
  );
}

const PRIVILEGED_CHANGE: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
});

/** Register the optional privileged bridge without adding an MCP authority. */
export function registerSessionAuthorizedChangeTools(
  server: McpServer,
  bridge: McpSessionAppBridge,
): readonly RegisteredTool[] {
  const execute = server.registerTool(
    "inari_change_execute",
    {
      title: "Execute Session-authorized Change",
      description:
        "Forward the canonical signed Session request envelope to the existing Session-authorized App executor. Session proof-of-possession, capability admission, trusted Change/Core/XState execution, and App effects remain outside MCP; never provide gh auth, PATs, Runtime private keys, App keys/JWTs, or installation tokens.",
      inputSchema: sessionAuthorizedChangeInputSchema,
      outputSchema: sessionAuthorizedChangeOutputSchema,
      annotations: PRIVILEGED_CHANGE,
    },
    async (input: SessionAuthorizedChangeInput) => handleSessionAuthorizedChange(input, bridge),
  );
  return Object.freeze([execute]);
}

function observationRepository(
  context: Awaited<ReturnType<GitHubAdapter["resolveRepositoryContext"]>>,
): Record<string, string> {
  return {
    host: context.hostname,
    ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
    repository: context.nameWithOwner,
  };
}

function issueRelationCapabilities(effectiveContract: EffectiveArtifactContract): {
  readonly parent: boolean;
  readonly blockedBy: boolean;
} {
  const capabilities = new Set(effectiveContract.capabilities);
  return {
    parent: capabilities.has(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeParentRelation),
    blockedBy:
      capabilities.has(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeBlockedByRelation) ||
      capabilities.has(GITHUB_ISSUE_PROJECTION_CAPABILITIES.nativeDependsOnRelation),
  };
}

interface IssueObservationEnvelope {
  readonly result: ReturnType<typeof tryObserveSemanticIssue>;
  readonly observationDiagnostics: readonly IssueRelationDiagnostic[];
}

async function observeIssueFromGitHub(
  adapter: GitHubAdapter,
  effectiveContract: EffectiveArtifactContract,
  number: number,
): Promise<IssueObservationEnvelope> {
  const [issue, context] = await Promise.all([adapter.readIssue(number), adapter.resolveRepositoryContext()]);
  const relations = new GitHubIssueRelationObservationAdapter(
    adapter,
    context,
    issueRelationCapabilities(effectiveContract),
  );
  const [parent, dependsOn] = await Promise.all([relations.observeParent(number), relations.observeBlockedBy(number)]);
  const nativeRelations: Record<string, unknown> = {};
  if (parent.kind === "present" && parent.reference !== undefined)
    nativeRelations.parent = { native: parent.reference };
  if (dependsOn.kind === "present") nativeRelations.dependsOn = { native: dependsOn.references };
  const observed = tryObserveSemanticIssue({
    issue,
    repository: observationRepository(context),
    ...(Object.keys(nativeRelations).length === 0 ? {} : { relations: nativeRelations }),
  });
  return {
    result: observed,
    observationDiagnostics: [...parent.diagnostics, ...dependsOn.diagnostics],
  };
}

interface PullRequestObservationEnvelope {
  readonly result: ReturnType<typeof tryObserveSemanticPullRequest>;
}

async function observePullRequestFromGitHub(
  adapter: GitHubAdapter,
  number: number,
): Promise<PullRequestObservationEnvelope> {
  const [pullRequest, context] = await Promise.all([
    adapter.readPullRequest(number),
    adapter.resolveRepositoryContext(),
  ]);
  return {
    result: tryObserveSemanticPullRequest({
      pullRequest,
      repository: observationRepository(context),
    }),
  };
}

interface OperationalObserveEnvelope {
  readonly evidence:
    | import("../github/types.js").GitHubOperationalIssueEvidence
    | import("../github/types.js").GitHubOperationalPullRequestEvidence;
  readonly observation:
    ReturnType<typeof tryObserveOperationalIssue> | ReturnType<typeof tryObserveOperationalPullRequest>;
}

async function observeOperationalIssueFromGitHub(
  adapter: GitHubAdapter,
  number: number,
): Promise<OperationalObserveEnvelope> {
  const evidence = await adapter.observeIssue(number);
  return { evidence, observation: tryObserveOperationalIssue({ issue: evidence }) };
}

async function observeOperationalPullRequestFromGitHub(
  adapter: GitHubAdapter,
  number: number,
): Promise<OperationalObserveEnvelope> {
  const evidence = await adapter.observePullRequest(number);
  return {
    evidence,
    observation: tryObserveOperationalPullRequest({ pullRequest: evidence }),
  };
}

async function handleIssueObserve(
  input: SemanticIssueObserveInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  let effectiveContract: EffectiveArtifactContract | undefined;
  try {
    // Contract resolution is attempted only as a semantic overlay. A missing,
    // legacy, or wrong template must not prevent provider observation.
    try {
      effectiveContract = await compileSemanticArtifactContract("issue", input, adapter);
    } catch {
      effectiveContract = undefined;
    }
    const envelope = await observeOperationalIssueFromGitHub(adapter, input.number);
    if (!envelope.observation.valid || envelope.observation.observation === undefined) {
      return result(
        {
          ...failure("observation", envelope.observation.violations),
          ...(effectiveContract === undefined ? {} : { effectiveContract }),
        },
        "Operational Issue observation failed; see diagnostics.",
      );
    }
    const semantic = await projectOperationalSemanticOverlay(adapter, "issue", envelope.evidence);
    return result(
      {
        ok: true,
        valid: true,
        operation: "issue.observe",
        number: input.number,
        version: envelope.observation.observation.version,
        ...(effectiveContract === undefined ? {} : { effectiveContract }),
        observed: envelope.observation.observation,
        semantic,
        mutation: false,
      },
      "Observed the Issue runtime state through the bounded GitHub adapter.",
    );
  } catch (error: unknown) {
    return result(
      { ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) },
      "Operational Issue observation failed; see diagnostics.",
    );
  }
}

async function handleOperationalView(
  domain: "issue" | "pr",
  input: Readonly<{ readonly repository?: string; readonly number: number }>,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  try {
    const envelope =
      domain === "issue"
        ? await observeOperationalIssueFromGitHub(adapter, input.number)
        : await observeOperationalPullRequestFromGitHub(adapter, input.number);
    if (!envelope.observation.valid || envelope.observation.observation === undefined) {
      return result(
        operationalViewFailure(domain, input.number, envelope.observation.violations),
        `${domain === "issue" ? "Issue" : "PR"} view provider observation failed; see diagnostics.`,
      );
    }
    const observed = envelope.observation.observation;
    const semantic = await projectOperationalSemanticOverlay(adapter, domain, envelope.evidence, true);
    return result(
      {
        ok: true,
        valid: true,
        operation: `${domain}.view`,
        kind: domain === "issue" ? "issue" : "pull_request",
        number: input.number,
        url: observed.url,
        version: observed.version,
        observed,
        semantic,
        mutation: false,
      },
      `Viewed the ${domain === "issue" ? "Issue" : "pull-request"} through the bounded provider observation and semantic overlay.`,
    );
  } catch (error: unknown) {
    return result(
      operationalViewFailure(domain, input.number, diagnosticsForError(error)),
      `${domain === "issue" ? "Issue" : "PR"} view provider observation failed; see diagnostics.`,
    );
  }
}

async function handleIssueView(
  input: SemanticIssueViewInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  return handleOperationalView("issue", input, dependencies);
}

async function handleIssueDrift(
  input: SemanticIssueDriftInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  let effectiveContract: EffectiveArtifactContract | undefined;
  try {
    effectiveContract = await compileSemanticArtifactContract("issue", input, adapter);
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined)
      return result(
        { ...failure("materialization", materialization.violations), effectiveContract },
        "Semantic Issue materialization failed; see diagnostics.",
      );
    const planned = tryPlanSemanticIssue({
      artifact: materialization.artifact,
      capabilities: effectiveContract.capabilities,
    });
    if (!planned.valid || planned.plan === undefined)
      return result(
        { ...failure("projection", planned.violations), effectiveContract, artifact: materialization.artifact },
        "Semantic Issue projection failed; see diagnostics.",
      );
    const envelope = await observeIssueFromGitHub(adapter, effectiveContract, input.number);
    if (!envelope.result.valid || envelope.result.projection === undefined)
      return result(
        {
          ...failure("observation", envelope.result.violations),
          effectiveContract,
          desired: planned.plan.desired,
          artifact: materialization.artifact,
          ...(envelope.observationDiagnostics.length === 0
            ? {}
            : { observationDiagnostics: [...envelope.observationDiagnostics] }),
        },
        "Semantic Issue observation failed; see diagnostics.",
      );
    const comparison = compareSemanticIssueProjection(planned.plan.desired, envelope.result.projection);
    return result(
      {
        ok: comparison.valid,
        valid: comparison.valid,
        phase: "comparison",
        effectiveContract,
        artifact: materialization.artifact,
        desired: planned.plan.desired,
        observed: envelope.result.projection,
        comparison,
        drift: [...comparison.drift],
        ...(envelope.observationDiagnostics.length === 0
          ? {}
          : { observationDiagnostics: [...envelope.observationDiagnostics] }),
      },
      comparison.valid ? "Semantic Issue has no observed drift." : "Semantic Issue drift detected; see comparison.",
    );
  } catch (error: unknown) {
    return result(
      { ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) },
      "Semantic Issue drift observation failed; see diagnostics.",
    );
  }
}

async function handlePullRequestObserve(
  input: SemanticPullRequestObserveInput,
  dependencies: NativeSemanticPullRequestDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  let effectiveContract: EffectiveArtifactContract | undefined;
  try {
    try {
      effectiveContract = await compileSemanticArtifactContract("pull_request", input, adapter);
    } catch {
      effectiveContract = undefined;
    }
    const envelope = await observeOperationalPullRequestFromGitHub(adapter, input.number);
    if (!envelope.observation.valid || envelope.observation.observation === undefined)
      return result(
        {
          ...failure("observation", envelope.observation.violations),
          ...(effectiveContract === undefined ? {} : { effectiveContract }),
        },
        "Operational PR observation failed; see diagnostics.",
      );
    const semantic = await projectOperationalSemanticOverlay(adapter, "pr", envelope.evidence);
    return result(
      {
        ok: true,
        valid: true,
        operation: "pr.observe",
        number: input.number,
        version: envelope.observation.observation.version,
        ...(effectiveContract === undefined ? {} : { effectiveContract }),
        observed: envelope.observation.observation,
        semantic,
        mutation: false,
      },
      "Observed the pull-request runtime state through the bounded GitHub adapter.",
    );
  } catch (error: unknown) {
    return result(
      { ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) },
      "Operational PR observation failed; see diagnostics.",
    );
  }
}

async function handlePullRequestView(
  input: SemanticPullRequestViewInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  return handleOperationalView("pr", input, dependencies);
}

async function handleOperationalIssueList(
  input: OperationalIssueListInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  try {
    const adapter = adapterFor(input.repository, dependencies);
    const page = await adapter.listOperationalIssues({
      state: input.state ?? "open",
      page: input.page ?? 1,
      limit: input.limit ?? 30,
    });
    const discovered = tryDiscoverOperationalIssues({ discovery: page });
    if (!discovered.valid || discovered.discovery === undefined)
      return result(
        {
          ok: false,
          valid: false,
          operation: "issue.list",
          kind: "issue",
          phase: "discovery",
          diagnostics: discovered.violations,
          violations: discovered.violations,
        },
        "Operational Issue discovery failed; see diagnostics.",
      );
    return result(
      {
        ok: true,
        valid: true,
        operation: "issue.list",
        kind: "issue",
        version: discovered.discovery.version,
        discovered: discovered.discovery,
        mutation: false,
        diagnostics: [],
      },
      "Discovered bounded Issue summaries through the native GitHub adapter.",
    );
  } catch (error: unknown) {
    const diagnostics = diagnosticsForError(error);
    return result(
      { ok: false, valid: false, operation: "issue.list", kind: "issue", phase: "discovery", diagnostics },
      "Operational Issue discovery failed; see diagnostics.",
    );
  }
}

async function handleOperationalPullRequestList(
  input: OperationalPullRequestListInput,
  dependencies: NativeSemanticPullRequestDependencies,
): Promise<CallToolResult> {
  try {
    const adapter = adapterFor(input.repository, dependencies);
    const page = await adapter.listOperationalPullRequests({
      state: input.state ?? "open",
      ...(input.head === undefined ? {} : { head: input.head }),
      ...(input.base === undefined ? {} : { base: input.base }),
      page: input.page ?? 1,
      limit: input.limit ?? 30,
    });
    const discovered = tryDiscoverOperationalPullRequests({ discovery: page });
    if (!discovered.valid || discovered.discovery === undefined)
      return result(
        {
          ok: false,
          valid: false,
          operation: "pr.list",
          kind: "pull_request",
          phase: "discovery",
          diagnostics: discovered.violations,
          violations: discovered.violations,
        },
        "Operational pull-request discovery failed; see diagnostics.",
      );
    return result(
      {
        ok: true,
        valid: true,
        operation: "pr.list",
        kind: "pull_request",
        version: discovered.discovery.version,
        discovered: discovered.discovery,
        mutation: false,
        diagnostics: [],
      },
      "Discovered bounded pull-request summaries through the native GitHub adapter.",
    );
  } catch (error: unknown) {
    const diagnostics = diagnosticsForError(error);
    return result(
      { ok: false, valid: false, operation: "pr.list", kind: "pull_request", phase: "discovery", diagnostics },
      "Operational pull-request discovery failed; see diagnostics.",
    );
  }
}

async function handlePullRequestDrift(
  input: SemanticPullRequestDriftInput,
  dependencies: NativeSemanticPullRequestDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  let effectiveContract: EffectiveArtifactContract | undefined;
  try {
    effectiveContract = await compileSemanticArtifactContract("pull_request", input, adapter);
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined)
      return result(
        { ...failure("materialization", materialization.violations), effectiveContract },
        "Semantic PR materialization failed; see diagnostics.",
      );
    const planned = tryPlanSemanticPullRequest({
      artifact: materialization.artifact,
      capabilities: effectiveContract.capabilities,
    });
    if (!planned.valid || planned.plan === undefined)
      return result(
        { ...failure("projection", planned.violations), effectiveContract, artifact: materialization.artifact },
        "Semantic PR projection failed; see diagnostics.",
      );
    const envelope = await observePullRequestFromGitHub(adapter, input.number);
    if (!envelope.result.valid || envelope.result.projection === undefined)
      return result(
        {
          ...failure("observation", envelope.result.violations),
          effectiveContract,
          desired: planned.plan.desired,
          artifact: materialization.artifact,
        },
        "Semantic PR observation failed; see diagnostics.",
      );
    const comparison = compareSemanticPullRequestProjection(planned.plan.desired, envelope.result.projection);
    return result(
      {
        ok: comparison.valid,
        valid: comparison.valid,
        phase: "comparison",
        effectiveContract,
        artifact: materialization.artifact,
        desired: planned.plan.desired,
        observed: envelope.result.projection,
        comparison,
        drift: [...comparison.drift],
      },
      comparison.valid ? "Semantic PR has no observed drift." : "Semantic PR drift detected; see comparison.",
    );
  } catch (error: unknown) {
    return result(
      { ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) },
      "Semantic PR drift observation failed; see diagnostics.",
    );
  }
}

async function handleBranchObserve(
  input: SemanticBranchObserveInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  let effectiveContract: EffectiveArtifactContract | undefined;
  try {
    effectiveContract = await compileSemanticArtifactContract("branch", input, adapter);
    const branch = await adapter.findBranch(input.name);
    if (branch === undefined)
      return result(
        {
          ...failure("observation", new Error(`Branch "${input.name}" was not found.`)),
          effectiveContract,
        },
        "Semantic Branch observation failed; see diagnostics.",
      );
    const observed = tryObserveSemanticBranch({
      ref: { ref: branch.ref, object: { type: "commit", sha: branch.sha } },
      source: input.source,
      generation: effectiveContract.generation,
    });
    if (!observed.valid || observed.projection === undefined)
      return result(
        { ...failure("observation", observed.violations), effectiveContract },
        "Semantic Branch observation failed; see diagnostics.",
      );
    return result(
      { ok: true, valid: true, effectiveContract, observed: observed.projection },
      "Observed the semantic Branch through the bounded GitHub adapter.",
    );
  } catch (error: unknown) {
    return result(
      { ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) },
      "Semantic Branch observation failed; see diagnostics.",
    );
  }
}

async function handleBranchDrift(
  input: SemanticBranchDriftInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  let effectiveContract: EffectiveArtifactContract | undefined;
  try {
    effectiveContract = await compileSemanticArtifactContract("branch", input, adapter);
    const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
    if (!materialization.valid || materialization.artifact === undefined)
      return result(
        { ...failure("materialization", materialization.violations), effectiveContract },
        "Semantic Branch materialization failed; see diagnostics.",
      );
    const planned = tryPlanSemanticBranch({ artifact: materialization.artifact });
    if (!planned.valid || planned.plan === undefined)
      return result(
        { ...failure("projection", planned.violations), effectiveContract, artifact: materialization.artifact },
        "Semantic Branch projection failed; see diagnostics.",
      );
    const branch = await adapter.findBranch(planned.plan.desired.name);
    if (branch === undefined)
      return result(
        {
          ...failure("observation", new Error(`Branch "${planned.plan.desired.name}" was not found.`)),
          effectiveContract,
          artifact: materialization.artifact,
          desired: planned.plan.desired,
        },
        "Semantic Branch observation failed; see diagnostics.",
      );
    const observed = tryObserveSemanticBranch({
      ref: { ref: branch.ref, object: { type: "commit", sha: branch.sha } },
      source: planned.plan.desired.source,
      generation: effectiveContract.generation,
    });
    if (!observed.valid || observed.projection === undefined)
      return result(
        {
          ...failure("observation", observed.violations),
          effectiveContract,
          artifact: materialization.artifact,
          desired: planned.plan.desired,
        },
        "Semantic Branch observation failed; see diagnostics.",
      );
    const comparison = compareSemanticBranchProjection(planned.plan.desired, observed.projection);
    return result(
      {
        ok: comparison.valid,
        valid: comparison.valid,
        phase: "comparison",
        effectiveContract,
        artifact: materialization.artifact,
        desired: planned.plan.desired,
        observed: observed.projection,
        comparison,
        drift: [...comparison.drift],
      },
      comparison.valid ? "Semantic Branch has no observed drift." : "Semantic Branch drift detected; see comparison.",
    );
  } catch (error: unknown) {
    return result(
      { ...failure("observation", error), ...(effectiveContract === undefined ? {} : { effectiveContract }) },
      "Semantic Branch drift observation failed; see diagnostics.",
    );
  }
}

async function handleContract(
  input: SemanticPullRequestContractInput,
  dependencies: NativeSemanticPullRequestDependencies,
): Promise<CallToolResult> {
  try {
    return result(
      contractProjection(await resolveSemanticPullRequestContract(input, dependencies)),
      "Resolved the Effective PR Artifact Contract.",
    );
  } catch (error: unknown) {
    return result(failure("contract", error), "Semantic PR contract resolution failed; see diagnostics.");
  }
}

async function handleMaterialize(
  input: SemanticPullRequestMaterializeInput,
  dependencies: NativeSemanticPullRequestDependencies,
): Promise<CallToolResult> {
  let effectiveContract: EffectiveArtifactContract;
  try {
    effectiveContract = await resolveSemanticPullRequestContract(input, dependencies);
  } catch (error: unknown) {
    return result(failure("contract", error), "Semantic PR contract resolution failed; see diagnostics.");
  }

  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
  if (!materialization.valid || materialization.artifact === undefined) {
    return result(
      { ...failure("materialization", materialization.violations), effectiveContract },
      "Semantic PR materialization failed; see diagnostics.",
    );
  }
  const artifact: SemanticArtifact = materialization.artifact;
  return result(
    {
      ok: true,
      valid: true,
      effectiveContract,
      artifact,
      provenance: artifact.provenance,
      generation: artifact.generation,
    },
    "Materialized the semantic PR artifact.",
  );
}

async function handlePlan(
  input: SemanticPullRequestPlanInput,
  dependencies: NativeSemanticPullRequestDependencies,
): Promise<CallToolResult> {
  let effectiveContract: EffectiveArtifactContract;
  try {
    effectiveContract = await resolveSemanticPullRequestContract(input, dependencies);
  } catch (error: unknown) {
    return result(failure("contract", error), "Semantic PR contract resolution failed; see diagnostics.");
  }

  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
  if (!materialization.valid || materialization.artifact === undefined) {
    return result(
      { ...failure("materialization", materialization.violations), effectiveContract },
      "Semantic PR materialization failed; see diagnostics.",
    );
  }
  const planResult = tryPlanSemanticPullRequest({
    artifact: materialization.artifact,
    capabilities: effectiveContract.capabilities,
  });
  if (!planResult.valid || planResult.plan === undefined) {
    return result(
      { ...failure("projection", planResult.violations), effectiveContract },
      "Semantic PR projection failed; see diagnostics.",
    );
  }
  const plan: SemanticPullRequestMutationPlan = planResult.plan;
  return result(
    {
      ok: true,
      valid: true,
      effectiveContract,
      artifact: materialization.artifact,
      plan,
      provenance: plan.provenance,
      generation: plan.generation,
      preview: true,
      mutation: false,
    },
    "Produced a deterministic read-only semantic PR plan preview.",
  );
}

/** Register the read-only Golden Path status/next-action/recovery projection. */
export function registerGoldenPathTools(server: McpServer): readonly RegisteredTool[] {
  const status = server.registerTool(
    "inari_golden_path_status",
    {
      title: "Project Golden Path status",
      description:
        "Project bounded Golden Path status, next action, and recovery from supplied normalized evidence through the existing #409/#410 Core projectors. This tool performs no lifecycle or GitHub mutation.",
      inputSchema: goldenPathStatusInputSchema,
      outputSchema: goldenPathStatusOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: GoldenPathStatusMcpInput) => handleGoldenPathStatus(input),
  );
  return Object.freeze([status]);
}

/** Register the shared read-only Operational Discovery catalog on any MCP transport. */
export function registerOperationalDiscoveryTools(
  server: McpServer,
  dependencies: NativeSemanticArtifactDependencies = {},
): readonly RegisteredTool[] {
  const issues = server.registerTool(
    "inari_issue_list",
    {
      title: "Discover Issues",
      description:
        "Discover one bounded page of provider-normalized GitHub Issue summaries through the versioned Operational Discovery Core.",
      inputSchema: operationalIssueListInputSchema,
      outputSchema: operationalDiscoveryOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: OperationalIssueListInput) => handleOperationalIssueList(input, dependencies),
  );
  const pullRequests = server.registerTool(
    "inari_pr_list",
    {
      title: "Discover pull requests",
      description:
        "Discover one bounded page of provider-normalized pull-request summaries with exact state, head, and base filters through the versioned Operational Discovery Core.",
      inputSchema: operationalPullRequestListInputSchema,
      outputSchema: operationalDiscoveryOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: OperationalPullRequestListInput) => handleOperationalPullRequestList(input, dependencies),
  );
  return Object.freeze([issues, pullRequests]);
}

/** Register the read-only semantic PR contract/materialize/plan/observe/drift catalog on any MCP transport. */
export function registerSemanticPullRequestTools(
  server: McpServer,
  dependencies: NativeSemanticPullRequestDependencies = {},
): readonly RegisteredTool[] {
  const contract = server.registerTool(
    "inari_pr_contract",
    {
      title: "Resolve semantic PR contract",
      description:
        "Resolve the repository's effective semantic pull-request contract and caller input schema through Inari Core. Repository Canon and Core remain authoritative.",
      inputSchema: semanticPullRequestContractInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticPullRequestContractInput) => handleContract(input, dependencies),
  );
  const materialize = server.registerTool(
    "inari_pr_materialize",
    {
      title: "Materialize semantic PR",
      description:
        "Materialize caller input into a validated semantic pull-request artifact through Inari Core. Contract-declared values are evaluated by Core.",
      inputSchema: semanticPullRequestMaterializeInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticPullRequestMaterializeInput) => handleMaterialize(input, dependencies),
  );
  const plan = server.registerTool(
    "inari_pr_plan",
    {
      title: "Preview semantic PR plan",
      description:
        "Preview the deterministic semantic pull-request projection and mutation plan through Inari Core without performing GitHub mutation.",
      inputSchema: semanticPullRequestPlanInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticPullRequestPlanInput) => handlePlan(input, dependencies),
  );
  const observe = server.registerTool(
    "inari_pr_observe",
    {
      title: "Observe PR runtime state",
      description:
        "Observe one GitHub pull request through the bounded adapter and normalize provider runtime state with the versioned Operational Observation Core.",
      inputSchema: semanticPullRequestObserveInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticPullRequestObserveInput) => handlePullRequestObserve(input, dependencies),
  );
  const view = server.registerTool(
    "inari_pr_view",
    {
      title: "View PR with semantic status",
      description:
        "View bounded pull-request provider content and place the existing semantic projection beside it; semantic failure never suppresses readable provider evidence.",
      inputSchema: semanticPullRequestObserveInputSchema,
      outputSchema: composedViewOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticPullRequestViewInput) => handlePullRequestView(input, dependencies),
  );
  const drift = server.registerTool(
    "inari_pr_drift",
    {
      title: "Compare semantic PR drift",
      description:
        "Materialize and project semantic PR input, observe the bounded GitHub state, and compare both through Inari Core without mutation.",
      inputSchema: semanticPullRequestDriftInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticPullRequestDriftInput) => handlePullRequestDrift(input, dependencies),
  );
  return Object.freeze([contract, materialize, plan, observe, view, drift]);
}

type SemanticArtifactKind = "issue" | "branch";
type SemanticArtifactContractRequest = SemanticIssueContractInput | SemanticBranchContractInput;
type SemanticArtifactMaterializeRequest = SemanticIssueMaterializeInput | SemanticBranchMaterializeInput;
type SemanticArtifactPlanRequest = SemanticIssuePlanInput | SemanticBranchPlanInput;

function kindLabel(kind: SemanticArtifactKind): string {
  return kind === "issue" ? "Issue" : "Branch";
}

async function handleArtifactContract(
  kind: SemanticArtifactKind,
  input: SemanticArtifactContractRequest,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  try {
    return result(
      contractProjection(await resolveSemanticArtifactContract(kind, input, dependencies)),
      `Resolved the Effective ${kindLabel(kind)} Artifact Contract.`,
    );
  } catch (error: unknown) {
    return result(
      failure("contract", error),
      `Semantic ${kindLabel(kind)} contract resolution failed; see diagnostics.`,
    );
  }
}

async function handleArtifactMaterialize(
  kind: SemanticArtifactKind,
  input: SemanticArtifactMaterializeRequest,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  let effectiveContract: EffectiveArtifactContract;
  try {
    effectiveContract = await resolveSemanticArtifactContract(kind, input, dependencies);
  } catch (error: unknown) {
    return result(
      failure("contract", error),
      `Semantic ${kindLabel(kind)} contract resolution failed; see diagnostics.`,
    );
  }
  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
  if (!materialization.valid || materialization.artifact === undefined) {
    return result(
      { ...failure("materialization", materialization.violations), effectiveContract },
      `Semantic ${kindLabel(kind)} materialization failed; see diagnostics.`,
    );
  }
  return result(
    {
      ok: true,
      valid: true,
      effectiveContract,
      artifact: materialization.artifact,
      provenance: materialization.artifact.provenance,
      generation: materialization.artifact.generation,
    },
    `Materialized the semantic ${kindLabel(kind)} artifact.`,
  );
}

async function handleArtifactPlan(
  kind: SemanticArtifactKind,
  input: SemanticArtifactPlanRequest,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  let effectiveContract: EffectiveArtifactContract;
  try {
    effectiveContract = await resolveSemanticArtifactContract(kind, input, dependencies);
  } catch (error: unknown) {
    return result(
      failure("contract", error),
      `Semantic ${kindLabel(kind)} contract resolution failed; see diagnostics.`,
    );
  }
  const materialization = tryMaterializeSemanticArtifact(effectiveContract, input.input);
  if (!materialization.valid || materialization.artifact === undefined) {
    return result(
      { ...failure("materialization", materialization.violations), effectiveContract },
      `Semantic ${kindLabel(kind)} materialization failed; see diagnostics.`,
    );
  }
  const planResult =
    kind === "issue"
      ? tryPlanSemanticIssue({ artifact: materialization.artifact, capabilities: effectiveContract.capabilities })
      : tryPlanSemanticBranch({ artifact: materialization.artifact });
  if (!planResult.valid || planResult.plan === undefined) {
    return result(
      { ...failure("projection", planResult.violations), effectiveContract },
      `Semantic ${kindLabel(kind)} projection failed; see diagnostics.`,
    );
  }
  const plan: SemanticIssueMutationPlan | SemanticBranchMutationPlan = planResult.plan;
  return result(
    {
      ok: true,
      valid: true,
      effectiveContract,
      artifact: materialization.artifact,
      plan,
      provenance: plan.provenance,
      generation: plan.generation,
      preview: true,
      mutation: false,
    },
    `Produced a deterministic read-only semantic ${kindLabel(kind)} plan preview.`,
  );
}

async function handleIssueRelationsPlan(
  input: IssueRelationsPlanInput,
  dependencies: NativeSemanticArtifactDependencies,
): Promise<CallToolResult> {
  const adapter = adapterFor(input.repository, dependencies);
  const planResult = await planExistingIssueRelationReconciliation(adapter, {
    subjectNumber: input.number,
    desired: input.desired,
    ...(input.graph === undefined ? {} : { graph: input.graph }),
    capabilities: input.capabilities ?? [],
  });
  if (!planResult.valid || planResult.plan === undefined) {
    const diagnostics = boundedDiagnostics(planResult.diagnostics);
    return result(
      { ok: false, valid: false, diagnostics, violations: diagnostics },
      "Existing-Issue relationship plan preview failed; see diagnostics.",
    );
  }
  return result(
    { ok: true, valid: true, plan: planResult.plan, preview: true, mutation: false },
    "Produced a deterministic read-only existing-Issue relationship plan preview.",
  );
}

/** Register the typed Issue semantic artifact catalog without adding policy. */
export function registerSemanticIssueTools(
  server: McpServer,
  dependencies: NativeSemanticArtifactDependencies = {},
): readonly RegisteredTool[] {
  const contract = server.registerTool(
    "inari_issue_contract",
    {
      title: "Resolve semantic Issue contract",
      description: "Resolve the repository's effective semantic Issue contract and caller schema through Inari Core.",
      inputSchema: semanticIssueContractInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticIssueContractInput) => handleArtifactContract("issue", input, dependencies),
  );
  const materialize = server.registerTool(
    "inari_issue_materialize",
    {
      title: "Materialize semantic Issue",
      description: "Materialize caller input into a validated semantic Issue artifact through Inari Core.",
      inputSchema: semanticIssueMaterializeInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticIssueMaterializeInput) => handleArtifactMaterialize("issue", input, dependencies),
  );
  const plan = server.registerTool(
    "inari_issue_plan",
    {
      title: "Preview semantic Issue plan",
      description: "Preview a deterministic semantic Issue projection and mutation plan without GitHub mutation.",
      inputSchema: semanticIssuePlanInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticIssuePlanInput) => handleArtifactPlan("issue", input, dependencies),
  );
  const observe = server.registerTool(
    "inari_issue_observe",
    {
      title: "Observe Issue runtime state",
      description:
        "Observe one GitHub Issue through the bounded adapter and normalize provider runtime state with the versioned Operational Observation Core.",
      inputSchema: semanticIssueObserveInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticIssueObserveInput) => handleIssueObserve(input, dependencies),
  );
  const view = server.registerTool(
    "inari_issue_view",
    {
      title: "View Issue with semantic status",
      description:
        "View bounded Issue provider content and place the existing semantic projection beside it; semantic failure never suppresses readable provider evidence.",
      inputSchema: semanticIssueObserveInputSchema,
      outputSchema: composedViewOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticIssueViewInput) => handleIssueView(input, dependencies),
  );
  const drift = server.registerTool(
    "inari_issue_drift",
    {
      title: "Compare semantic Issue drift",
      description:
        "Materialize and project semantic Issue input, observe the bounded GitHub state, and compare both through Inari Core without mutation.",
      inputSchema: semanticIssueDriftInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticIssueDriftInput) => handleIssueDrift(input, dependencies),
  );
  const relationsPlan = server.registerTool(
    "inari_issue_relations_plan",
    {
      title: "Preview existing-Issue relationship plan",
      description:
        "Compose live native parent/dependency observation with Core planning to preview an existing Issue's relationship reconciliation, without GitHub mutation.",
      inputSchema: issueRelationsPlanInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: IssueRelationsPlanInput) => handleIssueRelationsPlan(input, dependencies),
  );
  return Object.freeze([contract, materialize, plan, observe, view, drift, relationsPlan]);
}

/** Register the typed Branch semantic artifact catalog without adding policy. */
export function registerSemanticBranchTools(
  server: McpServer,
  dependencies: NativeSemanticArtifactDependencies = {},
): readonly RegisteredTool[] {
  const contract = server.registerTool(
    "inari_branch_contract",
    {
      title: "Resolve semantic Branch contract",
      description: "Resolve the repository's effective semantic Branch contract and caller schema through Inari Core.",
      inputSchema: semanticBranchContractInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticBranchContractInput) => handleArtifactContract("branch", input, dependencies),
  );
  const materialize = server.registerTool(
    "inari_branch_materialize",
    {
      title: "Materialize semantic Branch",
      description: "Materialize caller input into a validated semantic Branch artifact through Inari Core.",
      inputSchema: semanticBranchMaterializeInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticBranchMaterializeInput) => handleArtifactMaterialize("branch", input, dependencies),
  );
  const plan = server.registerTool(
    "inari_branch_plan",
    {
      title: "Preview semantic Branch plan",
      description: "Preview a deterministic semantic Branch projection and mutation plan without GitHub mutation.",
      inputSchema: semanticBranchPlanInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticBranchPlanInput) => handleArtifactPlan("branch", input, dependencies),
  );
  const observe = server.registerTool(
    "inari_branch_observe",
    {
      title: "Observe semantic Branch",
      description:
        "Observe one GitHub branch ref through the bounded adapter and normalize it with the Core semantic observer.",
      inputSchema: semanticBranchObserveInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticBranchObserveInput) => handleBranchObserve(input, dependencies),
  );
  const drift = server.registerTool(
    "inari_branch_drift",
    {
      title: "Compare semantic Branch drift",
      description:
        "Materialize and project semantic Branch input, observe the bounded GitHub ref, and compare both through Inari Core without mutation.",
      inputSchema: semanticBranchDriftInputSchema,
      outputSchema: semanticPullRequestOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: SemanticBranchDriftInput) => handleBranchDrift(input, dependencies),
  );
  return Object.freeze([contract, materialize, plan, observe, drift]);
}

/** Register the transport-neutral Implementation Frontier projection. */
export function registerImplementationTools(
  server: McpServer,
  dependencies: NativeChangeDependencies = {},
): readonly RegisteredTool[] {
  const frontier = server.registerTool(
    "inari_impl_frontier",
    {
      title: "Project Implementation Frontier",
      description:
        "Compose a starting Issue's bounded repository dependency closure and project READY, BLOCKED, ACTIVE, SATISFIED, and INVALID Implementation candidates through the single Core frontier authority without mutation; explicit raw frontier evidence remains available as a low-level path.",
      inputSchema: implementationFrontierInputSchema,
      outputSchema: implementationFrontierOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: ImplementationFrontierMcpInput) => {
      try {
        const projected =
          input.frontier !== undefined
            ? tryProjectImplementationFrontier(input.frontier)
            : await (async () => {
                const adapter = adapterFor(input.repository, dependencies);
                const cwd = dependencies.repositoryRoot ?? process.cwd();
                const changeReader =
                  dependencies.changeExecutor ??
                  (dependencies.createChangeExecutor === undefined
                    ? createGitHubChangeReadAdapter({ cwd, api: adapter })
                    : dependencies.createChangeExecutor({
                        cwd,
                        ...(input.repository === undefined ? {} : { repository: input.repository }),
                      }));
                return composeImplementationFrontier(
                  createGitHubImplementationFrontierRepository({ adapter, cwd, changeReader }),
                  input.issue as number,
                  { evidence: input.evidence },
                );
              })();
        return result(
          {
            ok: projected.valid,
            valid: projected.valid,
            operation: "impl.frontier",
            ...(projected.projection === undefined ? {} : { frontier: projected.projection }),
            diagnostics: projected.diagnostics,
            mutation: false,
          },
          projected.valid ? "Projected the current Implementation Frontier." : "Implementation Frontier failed closed.",
        );
      } catch (error: unknown) {
        const diagnostics = diagnosticsForError(error);
        return result(
          { ok: false, valid: false, operation: "impl.frontier", diagnostics, mutation: false },
          "Implementation Frontier repository evidence was unavailable; the projection failed closed.",
        );
      }
    },
  );
  return Object.freeze([frontier]);
}

/** Register the read-only worker handoff projection over the existing Change read boundary. */
export function registerChangeTools(
  server: McpServer,
  dependencies: NativeChangeDependencies = {},
): readonly RegisteredTool[] {
  const goldenPathEntry = server.registerTool(
    "inari_golden_path_entry",
    {
      title: "Read Golden Path entry",
      description:
        "Read the existing Change projection and expose the shared Golden Path entry/action result. This MCP tool is read-only; Change issuance remains owned by the existing CLI/Actions executor boundary.",
      inputSchema: goldenPathEntryInputSchema,
      outputSchema: goldenPathEntryOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: GoldenPathEntryInput) => handleGoldenPathEntry(input, dependencies),
  );
  const handoff = server.registerTool(
    "inari_change_handoff",
    {
      title: "Read implementation handoff",
      description:
        "Read the bounded canonical implementation handoff for a healthy DRAFT Change. Inari owns remote identity only; the worker owns local worktree and session state.",
      inputSchema: implementationHandoffInputSchema,
      outputSchema: implementationHandoffOutputSchema,
      annotations: READ_ONLY,
    },
    async (input: ImplementationHandoffInput) => handleImplementationHandoff(input, dependencies),
  );
  return Object.freeze([goldenPathEntry, handoff]);
}

/** Publicly expose the protocol annotations without allowing mutation. */
export const SEMANTIC_PULL_REQUEST_MCP_ANNOTATIONS = READ_ONLY;
export const SEMANTIC_ISSUE_MCP_ANNOTATIONS = READ_ONLY;
export const SEMANTIC_BRANCH_MCP_ANNOTATIONS = READ_ONLY;
export const GOLDEN_PATH_ENTRY_MCP_ANNOTATIONS = READ_ONLY;
