/**
 * Native MCP tools for the semantic pull-request Core boundary.
 *
 * This module owns only protocol translation. Repository policy, effective
 * contract compilation, materialization, projection, and planning remain in
 * the existing Core modules. The same registration function can therefore be
 * used by stdio and a future hosted transport without changing semantics.
 */

import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ArtifactContractResolutionError,
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
  SemanticPullRequestProjectionError,
  tryPlanSemanticPullRequest,
  type SemanticPullRequestMutationPlan,
} from "../semantic-pr-projection.js";
import { GitHubAdapter, isGitHubAdapterError, type GitHubAdapterOptions } from "../github/index.js";

/** Version of the Inari-owned MCP tool/input/output contract. */
export const INARI_MCP_TOOL_CONTRACT_VERSION = "1" as const;

export const INARI_MCP_TOOL_NAMES = Object.freeze([
  "inari_pr_contract",
  "inari_pr_materialize",
  "inari_pr_plan",
] as const);

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

export type SemanticPullRequestContractInput = z.infer<typeof semanticPullRequestContractInputSchema>;
export type SemanticPullRequestMaterializeInput = z.infer<typeof semanticPullRequestMaterializeInputSchema>;
export type SemanticPullRequestPlanInput = z.infer<typeof semanticPullRequestPlanInputSchema>;

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
    phase: z.enum(["contract", "materialization", "projection"]).optional(),
    version: z.string().optional(),
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
    artifact: z.unknown().optional(),
    plan: z.unknown().optional(),
    provenance: z.unknown().optional(),
    generation: z.unknown().optional(),
    diagnostics: z.array(z.unknown()).optional(),
    violations: z.array(z.unknown()).optional(),
    preview: z.boolean().optional(),
    mutation: z.boolean().optional(),
  })
  .strict();

export type SemanticPullRequestMcpOutput = z.infer<typeof semanticPullRequestOutputSchema>;

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
  return [{ code: "CORE_OPERATION_FAILED", path: "$", message: boundedErrorMessage(error) }];
}

function failure(
  phase: "contract" | "materialization" | "projection",
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

function result(data: SemanticPullRequestMcpOutput, summary: string): CallToolResult {
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
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

/** Register the canonical semantic PR tool catalog on any MCP transport. */
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
  return Object.freeze([contract, materialize, plan]);
}

/** Publicly expose the protocol annotations without allowing mutation. */
export const SEMANTIC_PULL_REQUEST_MCP_ANNOTATIONS = READ_ONLY;
