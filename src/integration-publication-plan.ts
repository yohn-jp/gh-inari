/**
 * Pure Core planning for one Source or Epic integration branch and Draft PR.
 *
 * This module composes the existing branch, integration-routing, rendered
 * artifact, and PR-publication contracts. It returns an inert, versioned
 * handoff; it has no provider, Admission, Executor, or authority dependency.
 */

import { artifactContractProvenanceFromTemplate, type ArtifactContractProvenance } from "./contract/ir.js";
import { preparePullRequestArtifact, type ArtifactInputDocument } from "./artifact.js";
import {
  tryProjectIntegrationRouting,
  type IntegrationRoutingProjection,
  type IntegrationRoutingRole,
} from "./integration-routing.js";
import {
  tryValidatePrPublicationRequest,
  type NormalizedPrPublicationRequest,
  type PrPublicationRepositoryIdentity,
  type PrPublicationSourceIntegrationWorkIdentity,
  type PrPublicationEpicIntegrationWorkIdentity,
} from "./pr-publication.js";
import {
  validateSemanticBranchMutationPlan,
  type SemanticBranchArtifactIdentity,
} from "./semantic-branch-projection.js";

export const INTEGRATION_PUBLICATION_PLAN_VERSION = 1 as const;
export const INTEGRATION_PUBLICATION_PLAN_KIND = "integration-publication-plan" as const;

export type IntegrationPublicationRole = Extract<IntegrationRoutingRole, "issue-integration" | "epic-integration">;

export interface IntegrationPublicationGovernanceGeneration {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly ref: string;
  readonly treeSha: string;
  readonly branchSource: ArtifactContractProvenance["source"];
  readonly pullRequestSource: ArtifactContractProvenance["source"];
}

export interface IntegrationPublicationBranchCreation {
  /** Parent integration/default ref from which the role branch is created. */
  readonly source: string;
  /** Canonical Source or Epic integration ref created by the later consumer. */
  readonly target: string;
  /** Exact observed source commit used as the target branch's initial head. */
  readonly sourceSha: string;
  readonly artifact: SemanticBranchArtifactIdentity;
}

export type IntegrationPublicationWorkIdentity =
  PrPublicationSourceIntegrationWorkIdentity | PrPublicationEpicIntegrationWorkIdentity;

/** Inert handoff data only; this plan does not create a branch or pull request. */
export interface IntegrationPublicationPlan {
  readonly version: typeof INTEGRATION_PUBLICATION_PLAN_VERSION;
  readonly kind: typeof INTEGRATION_PUBLICATION_PLAN_KIND;
  readonly repository: PrPublicationRepositoryIdentity;
  readonly role: IntegrationPublicationRole;
  readonly workIdentity: IntegrationPublicationWorkIdentity;
  readonly routing: IntegrationRoutingProjection;
  readonly branchCreation: IntegrationPublicationBranchCreation;
  readonly governanceGeneration: IntegrationPublicationGovernanceGeneration;
  /** Existing PR-publication kernel output with rendered title/body and draft=true. */
  readonly publication: NormalizedPrPublicationRequest;
}

export type IntegrationPublicationPlanViolationCode =
  | "INPUT_INVALID"
  | "INPUT_UNKNOWN_PROPERTY"
  | "VERSION_UNSUPPORTED"
  | "KIND_INVALID"
  | "ROUTING_INVALID"
  | "ROLE_REQUIRED"
  | "ROLE_INVALID"
  | "BRANCH_PLAN_INVALID"
  | "BRANCH_ROUTE_MISMATCH"
  | "SOURCE_SHA_INVALID"
  | "HEAD_REVISION_INVALID"
  | "HEAD_REVISION_MISMATCH"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_ROUTE_MISMATCH"
  | "DRAFT_REQUIRED"
  | "REPOSITORY_MISMATCH"
  | "GOVERNANCE_GENERATION_MISMATCH"
  | "PUBLICATION_INVALID";

export interface IntegrationPublicationPlanViolation {
  readonly code: IntegrationPublicationPlanViolationCode;
  readonly path: string;
  readonly message: string;
}

export interface IntegrationPublicationPlanResult {
  readonly valid: boolean;
  readonly plan?: IntegrationPublicationPlan;
  readonly violations: readonly IntegrationPublicationPlanViolation[];
}

export class IntegrationPublicationPlanError extends Error {
  readonly violations: readonly IntegrationPublicationPlanViolation[];

  constructor(violations: readonly IntegrationPublicationPlanViolation[]) {
    super(violations.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
    this.name = "IntegrationPublicationPlanError";
    this.violations = violations;
  }
}

type RecordValue = Record<string, unknown>;

const INPUT_KEYS = new Set([
  "version",
  "kind",
  "repository",
  "routing",
  "workIdentity",
  "branchPlan",
  "sourceSha",
  "headRevision",
  "pullRequestContract",
  "pullRequestDocument",
]);
const REVISION_PATTERN = /^[0-9a-f]{40}$/iu;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeDeep(entry))) as T;
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = freezeDeep(value[key]);
    return Object.freeze(result) as T;
  }
  return value;
}

function addViolation(
  violations: IntegrationPublicationPlanViolation[],
  code: IntegrationPublicationPlanViolationCode,
  path: string,
  message: string,
): void {
  violations.push({ code, path, message });
}

function invalidResult(violations: IntegrationPublicationPlanViolation[]): IntegrationPublicationPlanResult {
  return {
    valid: false,
    violations: Object.freeze(
      [...violations].sort(
        (left, right) => left.path.localeCompare(right.path, "en-US") || left.code.localeCompare(right.code, "en-US"),
      ),
    ),
  };
}

function sameRepositoryGeneration(left: ArtifactContractProvenance, right: ArtifactContractProvenance): boolean {
  return (
    left.repository.host.toLowerCase() === right.repository.host.toLowerCase() &&
    left.repository.repositoryId !== undefined &&
    left.repository.repositoryId === right.repository.repositoryId &&
    left.ref === right.ref &&
    left.treeSha === right.treeSha
  );
}

function provenanceMatchesRepository(
  provenance: ArtifactContractProvenance,
  repository: PrPublicationRepositoryIdentity,
): boolean {
  return (
    provenance.repository.host.toLowerCase() === repository.repositoryHost.toLowerCase() &&
    provenance.repository.repositoryId === repository.repositoryId
  );
}

/** Build an immutable initial-branch and Draft PR plan without provider I/O. */
export function tryPlanIntegrationPublication(input: unknown): IntegrationPublicationPlanResult {
  const violations: IntegrationPublicationPlanViolation[] = [];
  if (!isRecord(input)) {
    addViolation(violations, "INPUT_INVALID", "$", "Integration publication input must be an object.");
    return invalidResult(violations);
  }
  for (const key of Object.keys(input).sort())
    if (!INPUT_KEYS.has(key))
      addViolation(violations, "INPUT_UNKNOWN_PROPERTY", `$.${key}`, "Property is not supported.");
  if (input.version !== INTEGRATION_PUBLICATION_PLAN_VERSION)
    addViolation(
      violations,
      "VERSION_UNSUPPORTED",
      "$.version",
      "Only integration publication plan version 1 is supported.",
    );
  if (input.kind !== INTEGRATION_PUBLICATION_PLAN_KIND)
    addViolation(violations, "KIND_INVALID", "$.kind", `kind must be "${INTEGRATION_PUBLICATION_PLAN_KIND}".`);

  const routingInput = isRecord(input.routing) ? input.routing : undefined;
  const declaredRole = routingInput?.role;
  if (routingInput === undefined) {
    addViolation(violations, "ROUTING_INVALID", "$.routing", "Canonical routing input is required.");
    return invalidResult(violations);
  }
  if (declaredRole === undefined)
    addViolation(violations, "ROLE_REQUIRED", "$.routing.role", "Source or Epic integration role must be explicit.");
  else if (declaredRole !== "issue-integration" && declaredRole !== "epic-integration")
    addViolation(violations, "ROLE_INVALID", "$.routing.role", "Only Source and Epic integration roles are supported.");

  const routeResult = tryProjectIntegrationRouting(routingInput);
  if (!routeResult.valid || routeResult.projection === undefined) {
    for (const entry of routeResult.diagnostics)
      addViolation(
        violations,
        "ROUTING_INVALID",
        `$.routing${entry.path === "$" ? "" : entry.path.slice(1)}`,
        entry.message,
      );
    return invalidResult(violations);
  }
  const routing = routeResult.projection;
  if (routing.role !== "issue-integration" && routing.role !== "epic-integration")
    addViolation(
      violations,
      "ROLE_INVALID",
      "$.routing.role",
      "Only Source and Epic integration routes can be planned.",
    );

  const branchResult = validateSemanticBranchMutationPlan(input.branchPlan);
  if (!branchResult.valid || branchResult.plan === undefined) {
    for (const entry of branchResult.violations)
      addViolation(
        violations,
        "BRANCH_PLAN_INVALID",
        `$.branchPlan${entry.path === "$" ? "" : entry.path.slice(1)}`,
        entry.message,
      );
    return invalidResult(violations);
  }
  const branchPlan = branchResult.plan;
  if (
    routing.expectedHead === undefined ||
    branchPlan.desired.name !== routing.expectedHead ||
    branchPlan.desired.source !== routing.expectedBase
  )
    addViolation(
      violations,
      "BRANCH_ROUTE_MISMATCH",
      "$.branchPlan.desired",
      "Branch creation source and target must match the canonical integration route.",
    );

  if (typeof input.sourceSha !== "string" || !REVISION_PATTERN.test(input.sourceSha))
    addViolation(
      violations,
      "SOURCE_SHA_INVALID",
      "$.sourceSha",
      "Source SHA must be a full 40-character Git commit SHA.",
    );
  if (typeof input.headRevision !== "string" || !REVISION_PATTERN.test(input.headRevision))
    addViolation(
      violations,
      "HEAD_REVISION_INVALID",
      "$.headRevision",
      "Head revision must be a full 40-character Git commit SHA.",
    );
  if (
    typeof input.sourceSha === "string" &&
    typeof input.headRevision === "string" &&
    input.sourceSha !== input.headRevision
  )
    addViolation(
      violations,
      "HEAD_REVISION_MISMATCH",
      "$.headRevision",
      "A new integration branch starts at the exact observed source SHA.",
    );

  let preparedPullRequest;
  try {
    preparedPullRequest = preparePullRequestArtifact(
      input.pullRequestContract,
      input.pullRequestDocument as ArtifactInputDocument,
    );
  } catch (error) {
    addViolation(
      violations,
      "ARTIFACT_INVALID",
      "$.pullRequestDocument",
      error instanceof Error ? error.message : "Pull request artifact could not be rendered.",
    );
    return invalidResult(violations);
  }
  const renderedPullRequest = preparedPullRequest.artifact;
  if (renderedPullRequest.head !== routing.expectedHead || renderedPullRequest.base !== routing.expectedBase)
    addViolation(
      violations,
      "ARTIFACT_ROUTE_MISMATCH",
      "$.pullRequestDocument.metadata",
      "Rendered pull request head and base must match canonical routing.",
    );
  if (renderedPullRequest.draft !== true)
    addViolation(
      violations,
      "DRAFT_REQUIRED",
      "$.pullRequestDocument.metadata.draft",
      "Integration publication plans require draft=true.",
    );

  const pullRequestGeneration = artifactContractProvenanceFromTemplate(renderedPullRequest.provenance);

  const publicationResult = tryValidatePrPublicationRequest({
    version: 1,
    kind: "pr-publication",
    repository: input.repository,
    workIdentity: input.workIdentity,
    routing,
    expectedHead: routing.expectedHead,
    expectedBase: routing.expectedBase,
    headRevision: input.headRevision,
    title: renderedPullRequest.title,
    body: renderedPullRequest.body,
    draft: renderedPullRequest.draft,
    ...(renderedPullRequest.maintainerCanModify === undefined
      ? {}
      : { maintainerCanModify: renderedPullRequest.maintainerCanModify }),
  });
  if (!publicationResult.valid || publicationResult.request === undefined) {
    for (const entry of publicationResult.diagnostics)
      addViolation(
        violations,
        "PUBLICATION_INVALID",
        `$.publication${entry.path === "$" ? "" : entry.path.slice(1)}`,
        entry.message,
      );
  }
  const publication = publicationResult.request;
  const repository = publication?.repository;
  if (
    repository !== undefined &&
    (!sameRepositoryGeneration(branchPlan.generation, pullRequestGeneration) ||
      !provenanceMatchesRepository(branchPlan.generation, repository) ||
      !provenanceMatchesRepository(pullRequestGeneration, repository))
  )
    addViolation(
      violations,
      "GOVERNANCE_GENERATION_MISMATCH",
      "$.governanceGeneration",
      "Branch and pull request artifacts must come from the same repository governance generation.",
    );
  if (
    repository !== undefined &&
    (branchPlan.generation.repository.host.toLowerCase() !== repository.repositoryHost ||
      branchPlan.generation.repository.repositoryId !== repository.repositoryId ||
      pullRequestGeneration.repository.host.toLowerCase() !== repository.repositoryHost ||
      pullRequestGeneration.repository.repositoryId !== repository.repositoryId)
  )
    addViolation(
      violations,
      "REPOSITORY_MISMATCH",
      "$.repository",
      "Branch and pull request governance must match the publication repository.",
    );

  if (violations.length > 0 || publication === undefined || repository === undefined) return invalidResult(violations);

  const role = routing.role as IntegrationPublicationRole;
  const workIdentity = publication.workIdentity as IntegrationPublicationWorkIdentity;
  const plan: IntegrationPublicationPlan = {
    version: INTEGRATION_PUBLICATION_PLAN_VERSION,
    kind: INTEGRATION_PUBLICATION_PLAN_KIND,
    repository,
    role,
    workIdentity,
    routing,
    branchCreation: {
      source: branchPlan.desired.source,
      target: branchPlan.desired.name,
      sourceSha: input.sourceSha as string,
      artifact: branchPlan.artifact,
    },
    governanceGeneration: {
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      ref: branchPlan.generation.ref,
      treeSha: branchPlan.generation.treeSha,
      branchSource: branchPlan.generation.source,
      pullRequestSource: pullRequestGeneration.source,
    },
    publication,
  };
  return { valid: true, plan: freezeDeep(plan), violations: [] };
}

export function planIntegrationPublication(input: unknown): IntegrationPublicationPlan {
  const result = tryPlanIntegrationPublication(input);
  if (!result.valid || result.plan === undefined) throw new IntegrationPublicationPlanError(result.violations);
  return result.plan;
}
