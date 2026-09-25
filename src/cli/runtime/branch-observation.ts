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
