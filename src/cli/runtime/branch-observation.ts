/** Explicit, credential-free observation of one Implementation branch. */
import {
  createRepositoryBranchPolicy,
  evaluateRepositoryBranch,
  resolveImplementationBranch,
  type ImplementationBranchBinding,
  type RepositoryBranchEvidence,
  type RepositoryBranchObservedGeneration,
  type RepositoryBranchPolicy,
  type RepositoryBranchTarget,
} from "../../repository-branch-policy.js";
import { canonicalJsonString, type CanonicalJsonValue } from "../../agent-authority/codec.js";

export interface LocalBranchObservation {
  readonly version: 1;
  readonly kind: "local-branch-observation";
  readonly repository: RepositoryBranchTarget["repository"];
  readonly implementation: number;
  readonly observedBranch: string;
  readonly expectedBranch: string;
  readonly observedGeneration: RepositoryBranchObservedGeneration;
  readonly evidence: RepositoryBranchEvidence;
}

export interface ObserveLocalBranchInput {
  readonly policy: RepositoryBranchPolicy;
  readonly target: RepositoryBranchTarget;
  readonly observedGeneration: RepositoryBranchObservedGeneration;
  readonly observedBranch: string;
  readonly binding?: ImplementationBranchBinding;
  readonly naming?: { readonly type?: string; readonly slug?: string };
}

export function observeLocalBranch(input: ObserveLocalBranchInput): LocalBranchObservation {
  const resolved = resolveImplementationBranch(input);
  if (resolved.status !== "bound") throw new Error(`Implementation branch unavailable: ${resolved.code}`);
  const evaluated = evaluateRepositoryBranch({
    policy: input.policy,
    target: input.target,
    branch: input.observedBranch,
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    observedGeneration: input.observedGeneration,
  });
  if (evaluated.status !== "bound" || evaluated.branch !== resolved.branch)
    throw new Error("Observed branch does not match the governed Implementation branch.");
  return Object.freeze({
    version: 1,
    kind: "local-branch-observation",
    repository: input.target.repository,
    implementation: input.target.implementation,
    observedBranch: input.observedBranch,
    expectedBranch: resolved.branch,
    observedGeneration: input.observedGeneration,
    evidence: resolved.evidence,
  });
}

/** Re-evaluate untrusted serialized evidence through the canonical policy authority. */
export function validateLocalBranchObservation(value: unknown): LocalBranchObservation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "version",
          "kind",
          "repository",
          "implementation",
          "observedBranch",
          "expectedBranch",
          "observedGeneration",
          "evidence",
        ].includes(key),
    ) ||
    input.version !== 1 ||
    input.kind !== "local-branch-observation" ||
    typeof input.observedBranch !== "string" ||
    typeof input.expectedBranch !== "string" ||
    typeof input.implementation !== "number" ||
    typeof input.repository !== "object" ||
    input.repository === null ||
    typeof input.observedGeneration !== "object" ||
    input.observedGeneration === null ||
    typeof input.evidence !== "object" ||
    input.evidence === null
  )
    return undefined;
  const evidence = input.evidence as RepositoryBranchEvidence;
  const repository = input.repository as RepositoryBranchTarget["repository"];
  const observedGeneration = input.observedGeneration as RepositoryBranchObservedGeneration;
  if (
    evidence.version !== 1 ||
    evidence.kind !== "repository-branch-evidence" ||
    evidence.implementation !== input.implementation ||
    evidence.branch !== input.expectedBranch ||
    evidence.repository?.repositoryHost !== repository.repositoryHost ||
    evidence.repository?.repositoryId !== repository.repositoryId ||
    evidence.generation?.ref !== observedGeneration.ref ||
    evidence.generation?.treeSha !== observedGeneration.treeSha ||
    input.observedBranch !== input.expectedBranch
  )
    return undefined;
  const nameWithOwner = "observed/repository";
  const acquisition = createRepositoryBranchPolicy({
    generation: {
      authority: "repository-default-branch",
      repository: {
        host: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        owner: "observed",
        name: "repository",
        nameWithOwner,
      },
      ref: evidence.generation.ref,
      treeSha: evidence.generation.treeSha,
      ...(evidence.generation.policy === undefined ? {} : { policy: evidence.generation.policy }),
    },
    ...(evidence.rule === undefined ? {} : { rule: evidence.rule }),
  });
  if (acquisition.status !== "available" || acquisition.policy.defaultBranch !== evidence.defaultBranch)
    return undefined;
  const result = evaluateRepositoryBranch({
    policy: acquisition.policy,
    target: { repository, implementation: input.implementation },
    branch: input.observedBranch,
    ...(evidence.source === "exact-binding"
      ? { binding: { repository, implementation: input.implementation, branch: input.expectedBranch } }
      : {}),
    observedGeneration,
  });
  if (result.status !== "bound" || result.evidence.source !== evidence.source) return undefined;
  try {
    if (
      canonicalJsonString(result.evidence as unknown as CanonicalJsonValue) !==
      canonicalJsonString(evidence as unknown as CanonicalJsonValue)
    )
      return undefined;
  } catch {
    return undefined;
  }
  return value as LocalBranchObservation;
}

/** Owner-supplied branch-policy observation input for one governed Implementation (#1179). */
export type LocalBranchPolicyInput = Omit<ObserveLocalBranchInput, "observedBranch">;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryTarget(value: unknown): RepositoryBranchTarget["repository"] | undefined {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !["repositoryHost", "repositoryId"].includes(key)) ||
    value.repositoryHost !== "github.com" ||
    typeof value.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.repositoryId)
  )
    return undefined;
  return { repositoryHost: value.repositoryHost, repositoryId: value.repositoryId };
}

/**
 * Re-validate an owner-supplied branch-policy input (the Executor wire result
 * Admission forwards to the CLI) through the canonical policy authority. The
 * policy is rebuilt from its generation and rule; anything else is refused.
 */
export function validateLocalBranchPolicyInput(value: unknown): LocalBranchPolicyInput | undefined {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some(
      (key) => !["version", "kind", "policy", "target", "observedGeneration", "binding"].includes(key),
    ) ||
    value.version !== 1 ||
    value.kind !== "local-branch-policy-input" ||
    !isPlainRecord(value.policy) ||
    !isPlainRecord(value.target) ||
    !isPlainRecord(value.observedGeneration)
  )
    return undefined;
  const policy = value.policy;
  const acquisition = createRepositoryBranchPolicy({
    generation: policy.generation as RepositoryBranchPolicy["generation"],
    ...(policy.rule === undefined ? {} : { rule: policy.rule }),
  });
  if (acquisition.status !== "available") return undefined;
  try {
    if (
      canonicalJsonString(acquisition.policy as unknown as CanonicalJsonValue) !==
      canonicalJsonString(policy as unknown as CanonicalJsonValue)
    )
      return undefined;
  } catch {
    return undefined;
  }
  const target = value.target;
  const repository = repositoryTarget(target.repository);
  if (
    repository === undefined ||
    Object.keys(target).some((key) => !["repository", "implementation"].includes(key)) ||
    !Number.isSafeInteger(target.implementation) ||
    (target.implementation as number) < 1
  )
    return undefined;
  const generation = value.observedGeneration;
  if (
    Object.keys(generation).some((key) => !["ref", "treeSha"].includes(key)) ||
    typeof generation.ref !== "string" ||
    typeof generation.treeSha !== "string"
  )
    return undefined;
  let binding: ImplementationBranchBinding | undefined;
  if (value.binding !== undefined) {
    const candidate = value.binding;
    const bindingRepository = isPlainRecord(candidate) ? repositoryTarget(candidate.repository) : undefined;
    if (
      !isPlainRecord(candidate) ||
      bindingRepository === undefined ||
      Object.keys(candidate).some((key) => !["repository", "implementation", "branch"].includes(key)) ||
      bindingRepository.repositoryId !== repository.repositoryId ||
      candidate.implementation !== target.implementation ||
      typeof candidate.branch !== "string"
    )
      return undefined;
    binding = {
      repository: bindingRepository,
      implementation: candidate.implementation as number,
      branch: candidate.branch,
    };
  }
  return Object.freeze({
    policy: acquisition.policy,
    target: { repository, implementation: target.implementation as number },
    observedGeneration: { ref: generation.ref, treeSha: generation.treeSha },
    ...(binding === undefined ? {} : { binding }),
  });
}
