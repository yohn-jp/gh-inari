/**
 * Repository-bound ordinary Change branch policy (Core, transport-independent).
 *
 * The policy is acquired from the target repository's authoritative
 * default-branch generation (see `acquireRepositoryBranchPolicy` in
 * `governance.ts`) and reuses the existing PR policy `branch` rule rather than
 * a second policy file. This module only evaluates that policy against
 * explicit repository/Implementation identity and exact branch evidence:
 *
 * - An exact governed Implementation branch binding is preferred.
 * - A name is generated only from an explicitly declared bounded `format`;
 *   a pattern is never inverted into an example.
 * - Missing, non-derivable, invalid, or stale policy yields a bounded
 *   action-required or denial result, never an implicit universal convention.
 * - Branch spelling never establishes parentage or authorization; the result is
 *   naming evidence only. Reserved integration/release namespaces and the
 *   provider-resolved default branch are refused as ordinary Change branches.
 */

import { matchBranchFormat, renderBranchFormat, validateBranchSpelling } from "./branch-naming.js";
import type {
  ContractProvenanceRepository,
  ContractProvenanceSource,
  PullRequestBranchGovernance,
} from "./contract/ir.js";
import type { ImplementationRepositoryIdentity } from "./implementation-contract.js";
import { parsePullRequestPolicyOverlay } from "./pr-policy.js";

export const REPOSITORY_BRANCH_POLICY_VERSION = 1 as const;
export const REPOSITORY_BRANCH_POLICY_KIND = "repository-branch-policy" as const;
export const REPOSITORY_BRANCH_EVIDENCE_VERSION = 1 as const;
export const REPOSITORY_BRANCH_EVIDENCE_KIND = "repository-branch-evidence" as const;

/**
 * Namespaces owned by reserved Epic/Source integration and release routing.
 * Ordinary Change branches never occupy them, whatever a repository pattern says.
 */
export const RESERVED_BRANCH_NAMESPACES = Object.freeze(["epic", "issue", "release"] as const);

/** The repository-declared rule: the existing PR policy `branch` shape. */
export type RepositoryBranchPolicyRule = PullRequestBranchGovernance;

/** The authoritative repository generation the policy was read from. */
export interface RepositoryBranchPolicyGeneration {
  readonly authority: "repository-default-branch";
  readonly repository: ContractProvenanceRepository;
  /** Provider-resolved default branch name at acquisition. */
  readonly ref: string;
  /** Root tree SHA of `ref` at acquisition; the generation identity. */
  readonly treeSha: string;
  /** Fingerprint of the PR policy source, when the repository has one. */
  readonly policy?: ContractProvenanceSource;
}

export interface RepositoryBranchPolicy {
  readonly version: typeof REPOSITORY_BRANCH_POLICY_VERSION;
  readonly kind: typeof REPOSITORY_BRANCH_POLICY_KIND;
  readonly generation: RepositoryBranchPolicyGeneration;
  /** Provider-resolved default branch; equal to `generation.ref`. Never assumed to be `main`. */
  readonly defaultBranch: string;
  /** Absent when the repository declares no branch rule. */
  readonly rule?: RepositoryBranchPolicyRule;
}

/** Exact expected-branch evidence from a governed Implementation contract. */
export interface ImplementationBranchBinding {
  readonly repository: ImplementationRepositoryIdentity;
  readonly implementation: number;
  readonly branch: string;
}

/** The repository and Implementation a branch decision is being made for. */
export interface RepositoryBranchTarget {
  readonly repository: ImplementationRepositoryIdentity;
  readonly implementation: number;
}

/** A generation observed immediately before use, to detect stale policy. */
export interface RepositoryBranchObservedGeneration {
  readonly ref: string;
  readonly treeSha: string;
}

/** Semantic inputs for bounded `format` derivation only. */
export interface RepositoryBranchNamingInput {
  readonly type?: string;
  readonly slug?: string;
}

export type RepositoryBranchActionRequiredCode =
  "BRANCH_POLICY_MISSING" | "BRANCH_POLICY_NOT_DERIVABLE" | "BRANCH_NAMING_INPUT_REQUIRED";

export type RepositoryBranchDenialCode =
  | "BRANCH_POLICY_INVALID"
  | "BRANCH_POLICY_STALE"
  | "BRANCH_REPOSITORY_UNBOUND"
  | "BRANCH_REPOSITORY_MISMATCH"
  | "BRANCH_IMPLEMENTATION_MISMATCH"
  | "BRANCH_BINDING_MISMATCH"
  | "BRANCH_NAME_INVALID"
  | "BRANCH_NAME_RESERVED"
  | "BRANCH_NAMING_INVALID"
  | "BRANCH_POLICY_MISMATCH";

/** What the operator must supply to continue. */
export type RepositoryBranchRequirement = "exact-branch" | "branch-policy" | "naming-input";

/** Additive, versioned naming evidence. It is not authorization. */
export interface RepositoryBranchEvidence {
  readonly version: typeof REPOSITORY_BRANCH_EVIDENCE_VERSION;
  readonly kind: typeof REPOSITORY_BRANCH_EVIDENCE_KIND;
  readonly repository: ImplementationRepositoryIdentity;
  readonly implementation: number;
  readonly branch: string;
  readonly source: "exact-binding" | "policy-format";
  readonly defaultBranch: string;
  readonly generation: {
    readonly ref: string;
    readonly treeSha: string;
    readonly policy?: ContractProvenanceSource;
  };
  readonly rule?: RepositoryBranchPolicyRule;
}

export interface RepositoryBranchBound {
  readonly status: "bound";
  readonly branch: string;
  readonly evidence: RepositoryBranchEvidence;
}

export interface RepositoryBranchActionRequired {
  readonly status: "action-required";
  readonly code: RepositoryBranchActionRequiredCode;
  readonly requirement: RepositoryBranchRequirement;
  readonly message: string;
}

export interface RepositoryBranchDenied {
  readonly status: "denied";
  readonly code: RepositoryBranchDenialCode;
  readonly message: string;
  readonly path?: string;
}

export type RepositoryBranchDecision = RepositoryBranchBound | RepositoryBranchActionRequired | RepositoryBranchDenied;

export type RepositoryBranchPolicyAcquisition =
  { readonly status: "available"; readonly policy: RepositoryBranchPolicy } | RepositoryBranchDenied;

export interface ResolveImplementationBranchInput {
  readonly policy: RepositoryBranchPolicy;
  readonly target: RepositoryBranchTarget;
  readonly binding?: ImplementationBranchBinding;
  readonly naming?: RepositoryBranchNamingInput;
  readonly observedGeneration?: RepositoryBranchObservedGeneration;
}

export interface EvaluateRepositoryBranchInput {
  readonly policy: RepositoryBranchPolicy;
  readonly target: RepositoryBranchTarget;
  readonly branch: string;
  readonly binding?: ImplementationBranchBinding;
  readonly observedGeneration?: RepositoryBranchObservedGeneration;
}

function denied(code: RepositoryBranchDenialCode, message: string, path?: string): RepositoryBranchDenied {
  return { status: "denied", code, message, ...(path === undefined ? {} : { path }) };
}

function actionRequired(
  code: RepositoryBranchActionRequiredCode,
  requirement: RepositoryBranchRequirement,
  message: string,
): RepositoryBranchActionRequired {
  return { status: "action-required", code, requirement, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate a declared branch rule through the canonical PR policy parser, so
 * pattern safety and formatter grammar have exactly one authority.
 */
export function validateRepositoryBranchPolicyRule(
  rule: unknown,
): { readonly status: "valid"; readonly rule: RepositoryBranchPolicyRule } | RepositoryBranchDenied {
  if (!isRecord(rule)) return denied("BRANCH_POLICY_INVALID", "Branch policy rule must be an object.", "$.rule");
  try {
    const parsed = parsePullRequestPolicyOverlay(JSON.stringify({ version: 1, sections: [], branch: rule })).branch;
    if (parsed === undefined) return denied("BRANCH_POLICY_INVALID", "Branch policy rule is missing.", "$.rule");
    return { status: "valid", rule: parsed };
  } catch (error: unknown) {
    const path =
      isRecord(error) && typeof error.path === "string" ? error.path.replace(/^\$\.branch/u, "$.rule") : "$.rule";
    return denied(
      "BRANCH_POLICY_INVALID",
      `Branch policy rule is invalid: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

/** Build a validated repository branch policy from an acquired generation. */
export function createRepositoryBranchPolicy(input: {
  readonly generation: RepositoryBranchPolicyGeneration;
  readonly rule?: unknown;
}): RepositoryBranchPolicyAcquisition {
  const problem = validateGeneration(input.generation);
  if (problem !== undefined) return problem;
  let rule: RepositoryBranchPolicyRule | undefined;
  if (input.rule !== undefined) {
    const validated = validateRepositoryBranchPolicyRule(input.rule);
    if (validated.status === "denied") return validated;
    rule = validated.rule;
  }
  return {
    status: "available",
    policy: {
      version: REPOSITORY_BRANCH_POLICY_VERSION,
      kind: REPOSITORY_BRANCH_POLICY_KIND,
      generation: input.generation,
      defaultBranch: input.generation.ref,
      ...(rule === undefined ? {} : { rule }),
    },
  };
}

function validateGeneration(generation: unknown): RepositoryBranchDenied | undefined {
  if (
    !isRecord(generation) ||
    generation.authority !== "repository-default-branch" ||
    !isRecord(generation.repository) ||
    !nonEmptyString(generation.repository.host) ||
    !nonEmptyString(generation.repository.nameWithOwner) ||
    !nonEmptyString(generation.ref) ||
    !nonEmptyString(generation.treeSha) ||
    validateBranchSpelling(generation.ref).length > 0
  ) {
    return denied(
      "BRANCH_POLICY_INVALID",
      "Branch policy must be bound to a repository default-branch generation.",
      "$.generation",
    );
  }
  return undefined;
}

function validatePolicy(policy: unknown): RepositoryBranchDenied | undefined {
  if (
    !isRecord(policy) ||
    policy.version !== REPOSITORY_BRANCH_POLICY_VERSION ||
    policy.kind !== REPOSITORY_BRANCH_POLICY_KIND
  ) {
    return denied("BRANCH_POLICY_INVALID", "Branch policy has an unsupported version or kind.", "$.policy");
  }
  const generationProblem = validateGeneration(policy.generation);
  if (generationProblem !== undefined) return generationProblem;
  if (policy.defaultBranch !== (policy.generation as RepositoryBranchPolicyGeneration).ref) {
    return denied(
      "BRANCH_POLICY_INVALID",
      "Branch policy default branch does not match its generation ref.",
      "$.policy.defaultBranch",
    );
  }
  if (policy.rule !== undefined) {
    const validated = validateRepositoryBranchPolicyRule(policy.rule);
    if (validated.status === "denied") return validated;
  }
  return undefined;
}

function sameRepository(left: ImplementationRepositoryIdentity, right: ImplementationRepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function isValidRepositoryIdentity(value: unknown): value is ImplementationRepositoryIdentity {
  return isRecord(value) && nonEmptyString(value.repositoryHost) && nonEmptyString(value.repositoryId);
}

function isValidImplementation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Common preconditions: valid policy, fresh generation, and exact repository binding. */
function checkPreconditions(
  policy: RepositoryBranchPolicy,
  target: RepositoryBranchTarget,
  binding: ImplementationBranchBinding | undefined,
  observed: RepositoryBranchObservedGeneration | undefined,
): RepositoryBranchDenied | undefined {
  const policyProblem = validatePolicy(policy);
  if (policyProblem !== undefined) return policyProblem;
  if (
    observed !== undefined &&
    (observed.ref !== policy.generation.ref || observed.treeSha !== policy.generation.treeSha)
  ) {
    return denied(
      "BRANCH_POLICY_STALE",
      "Branch policy was acquired from a different repository generation than the one observed before use.",
      "$.observedGeneration",
    );
  }
  if (
    !isRecord(target) ||
    !isValidRepositoryIdentity(target.repository) ||
    !isValidImplementation(target.implementation)
  ) {
    return denied(
      "BRANCH_REPOSITORY_UNBOUND",
      "Target repository and Implementation identity are required.",
      "$.target",
    );
  }
  const policyRepository = policy.generation.repository;
  if (policyRepository.repositoryId === undefined) {
    return denied(
      "BRANCH_REPOSITORY_UNBOUND",
      "Branch policy generation does not carry a repository ID and cannot be bound to the target repository.",
      "$.policy.generation.repository.repositoryId",
    );
  }
  if (
    !sameRepository(
      { repositoryHost: policyRepository.host, repositoryId: policyRepository.repositoryId },
      target.repository,
    )
  ) {
    return denied(
      "BRANCH_REPOSITORY_MISMATCH",
      "Branch policy belongs to a different repository than the target.",
      "$.target.repository",
    );
  }
  if (binding !== undefined) {
    if (!isRecord(binding) || !isValidRepositoryIdentity(binding.repository) || !nonEmptyString(binding.branch)) {
      return denied("BRANCH_BINDING_MISMATCH", "Implementation branch binding is malformed.", "$.binding");
    }
    if (!sameRepository(binding.repository, target.repository)) {
      return denied(
        "BRANCH_REPOSITORY_MISMATCH",
        "Implementation branch binding belongs to a different repository than the target.",
        "$.binding.repository",
      );
    }
    if (binding.implementation !== target.implementation) {
      return denied(
        "BRANCH_IMPLEMENTATION_MISMATCH",
        "Implementation branch binding belongs to a different Implementation than the target.",
        "$.binding.implementation",
      );
    }
  }
  return undefined;
}

function reservedNamespace(branch: string): string | undefined {
  const head = branch.split("/")[0];
  return RESERVED_BRANCH_NAMESPACES.find((namespace) => namespace === head);
}

/** Spelling, reserved-namespace, default-branch, and declared-pattern checks on one candidate. */
function checkCandidate(
  policy: RepositoryBranchPolicy,
  branch: string,
  path: string,
): RepositoryBranchDenied | undefined {
  const spelling = validateBranchSpelling(branch);
  if (spelling.length > 0) return denied("BRANCH_NAME_INVALID", spelling[0] as string, path);
  if (branch === policy.defaultBranch) {
    return denied("BRANCH_NAME_RESERVED", `Branch "${branch}" is the repository default branch.`, path);
  }
  const namespace = reservedNamespace(branch);
  if (namespace !== undefined) {
    return denied(
      "BRANCH_NAME_RESERVED",
      `Branch "${branch}" is in the reserved "${namespace}/" integration or release namespace.`,
      path,
    );
  }
  if (policy.rule !== undefined && !new RegExp(policy.rule.pattern, "u").test(branch)) {
    return denied(
      "BRANCH_POLICY_MISMATCH",
      `Branch "${branch}" does not satisfy the repository branch policy.`,
      "$.policy.rule.pattern",
    );
  }
  return undefined;
}

function bound(
  policy: RepositoryBranchPolicy,
  target: RepositoryBranchTarget,
  branch: string,
  source: RepositoryBranchEvidence["source"],
): RepositoryBranchBound {
  const { generation } = policy;
  return {
    status: "bound",
    branch,
    evidence: {
      version: REPOSITORY_BRANCH_EVIDENCE_VERSION,
      kind: REPOSITORY_BRANCH_EVIDENCE_KIND,
      repository: { repositoryHost: target.repository.repositoryHost, repositoryId: target.repository.repositoryId },
      implementation: target.implementation,
      branch,
      source,
      defaultBranch: policy.defaultBranch,
      generation: {
        ref: generation.ref,
        treeSha: generation.treeSha,
        ...(generation.policy === undefined ? {} : { policy: generation.policy }),
      },
      ...(policy.rule === undefined ? {} : { rule: policy.rule }),
    },
  };
}

/**
 * Resolve the ordinary Change branch for one Implementation.
 *
 * Order: exact Implementation branch binding, then bounded `format`
 * derivation. A pattern-only policy cannot produce a name, and a repository
 * with no rule and no exact binding requires configuration or input.
 */
export function resolveImplementationBranch(input: ResolveImplementationBranchInput): RepositoryBranchDecision {
  const { policy, target, binding, naming, observedGeneration } = input;
  const precondition = checkPreconditions(policy, target, binding, observedGeneration);
  if (precondition !== undefined) return precondition;

  if (binding !== undefined) {
    const problem = checkCandidate(policy, binding.branch, "$.binding.branch");
    return problem ?? bound(policy, target, binding.branch, "exact-binding");
  }

  const rule = policy.rule;
  if (rule === undefined) {
    return actionRequired(
      "BRANCH_POLICY_MISSING",
      "exact-branch",
      "The repository declares no branch policy; supply the Implementation's exact branch or declare a branch rule.",
    );
  }
  if (rule.format === undefined) {
    return actionRequired(
      "BRANCH_POLICY_NOT_DERIVABLE",
      "exact-branch",
      "The repository branch policy validates names but declares no format; supply the Implementation's exact branch.",
    );
  }
  if (
    (rule.format.includes("{slug}") && naming?.slug === undefined) ||
    (rule.format.includes("{type}") && naming?.type === undefined)
  ) {
    return actionRequired(
      "BRANCH_NAMING_INPUT_REQUIRED",
      "naming-input",
      "The repository branch format requires naming input that was not supplied.",
    );
  }
  let branch: string;
  try {
    branch = renderBranchFormat(
      { format: rule.format, ...(rule.types === undefined ? {} : { types: rule.types }) },
      {
        issueNumber: target.implementation,
        ...(naming?.slug === undefined ? {} : { slug: naming.slug }),
        ...(naming?.type === undefined ? {} : { type: naming.type }),
      },
    );
  } catch (error: unknown) {
    return denied("BRANCH_NAMING_INVALID", error instanceof Error ? error.message : String(error), "$.naming");
  }
  const problem = checkCandidate(policy, branch, "$.naming");
  return problem ?? bound(policy, target, branch, "policy-format");
}

/**
 * Evaluate a supplied branch name for one Implementation. An exact binding
 * must match exactly; without one, the declared pattern must accept the name
 * and the declared format must render it for this Implementation. With
 * neither, no convention is assumed and configuration is required.
 */
export function evaluateRepositoryBranch(input: EvaluateRepositoryBranchInput): RepositoryBranchDecision {
  const { policy, target, branch, binding, observedGeneration } = input;
  const precondition = checkPreconditions(policy, target, binding, observedGeneration);
  if (precondition !== undefined) return precondition;
  if (typeof branch !== "string") return denied("BRANCH_NAME_INVALID", "Branch name must be a string.", "$.branch");

  if (binding !== undefined) {
    if (binding.branch !== branch) {
      return denied(
        "BRANCH_BINDING_MISMATCH",
        `Branch "${branch}" is not the Implementation's exact governed branch.`,
        "$.branch",
      );
    }
    const problem = checkCandidate(policy, branch, "$.branch");
    return problem ?? bound(policy, target, branch, "exact-binding");
  }
  if (policy.rule === undefined) {
    return actionRequired(
      "BRANCH_POLICY_MISSING",
      "branch-policy",
      "The repository declares no branch policy and no exact Implementation branch was supplied.",
    );
  }
  const problem = checkCandidate(policy, branch, "$.branch");
  if (problem !== undefined) return problem;
  const { format, types } = policy.rule;
  if (
    format === undefined ||
    matchBranchFormat({ format, ...(types === undefined ? {} : { types }) }, branch, target.implementation) ===
      undefined
  ) {
    // A pattern accepts the spelling but does not bind it to this Implementation.
    return actionRequired(
      "BRANCH_POLICY_NOT_DERIVABLE",
      "exact-branch",
      "The repository branch policy accepts this spelling but cannot bind it to the Implementation; supply the exact branch.",
    );
  }
  return bound(policy, target, branch, "policy-format");
}
