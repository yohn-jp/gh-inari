import type { ArtifactContractProvenance, ContractProvenance } from "../contract/ir.js";
import {
  VALIDATED_RENDERED_PHASE,
  type ValidatedRenderedIssueArtifact,
  type ValidatedRenderedPullRequestArtifact,
  type ValidatedSemanticPullRequestArtifact,
  type ValidatedSemanticIssueArtifact,
} from "./types.js";

const trustedArtifacts = new WeakSet<object>();
const trustedSemanticArtifacts = new WeakSet<object>();
const trustedSemanticIssueArtifacts = new WeakSet<object>();

/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export function createValidatedRenderedIssueArtifact(
  artifact: Omit<ValidatedRenderedIssueArtifact, "phase">,
): ValidatedRenderedIssueArtifact {
  const value: ValidatedRenderedIssueArtifact = {
    phase: VALIDATED_RENDERED_PHASE,
    kind: "issue",
    title: artifact.title,
    body: artifact.body,
    provenance: cloneProvenance(artifact.provenance),
    ...(artifact.labels === undefined ? {} : { labels: [...artifact.labels] }),
    ...(artifact.assignees === undefined ? {} : { assignees: [...artifact.assignees] }),
  };
  return register(value);
}

/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export function createValidatedRenderedPullRequestArtifact(
  artifact: Omit<ValidatedRenderedPullRequestArtifact, "phase">,
): ValidatedRenderedPullRequestArtifact {
  const value: ValidatedRenderedPullRequestArtifact = {
    phase: VALIDATED_RENDERED_PHASE,
    kind: "pull_request",
    title: artifact.title,
    body: artifact.body,
    provenance: cloneProvenance(artifact.provenance),
    head: artifact.head,
    base: artifact.base,
    ...(artifact.draft === undefined ? {} : { draft: artifact.draft }),
    ...(artifact.maintainerCanModify === undefined ? {} : { maintainerCanModify: artifact.maintainerCanModify }),
  };
  return register(value);
}

export function isTrustedValidatedRenderedArtifact(
  value: unknown,
): value is ValidatedRenderedIssueArtifact | ValidatedRenderedPullRequestArtifact {
  return typeof value === "object" && value !== null && trustedArtifacts.has(value);
}

/** Internal Core-to-adapter boundary for v2 Semantic PR projections. */
export function createValidatedSemanticPullRequestArtifact(
  artifact: Omit<ValidatedSemanticPullRequestArtifact, "phase">,
): ValidatedSemanticPullRequestArtifact {
  const value: ValidatedSemanticPullRequestArtifact = {
    phase: "validated-semantic",
    kind: "pull_request",
    title: artifact.title,
    body: artifact.body,
    provenance: cloneArtifactContractProvenance(artifact.provenance),
    head: artifact.head,
    base: artifact.base,
    ...(artifact.labels === undefined ? {} : { labels: [...artifact.labels] }),
    ...(artifact.assignees === undefined ? {} : { assignees: [...artifact.assignees] }),
    ...(artifact.draft === undefined ? {} : { draft: artifact.draft }),
    ...(artifact.maintainerCanModify === undefined ? {} : { maintainerCanModify: artifact.maintainerCanModify }),
  };
  deepFreeze(value);
  trustedSemanticArtifacts.add(value);
  return value;
}

export function isTrustedSemanticPullRequestArtifact(value: unknown): value is ValidatedSemanticPullRequestArtifact {
  return typeof value === "object" && value !== null && trustedSemanticArtifacts.has(value);
}

/** Internal Core-to-adapter boundary for v2 Semantic Issue projections. */
export function createValidatedSemanticIssueArtifact(
  artifact: Omit<ValidatedSemanticIssueArtifact, "phase">,
): ValidatedSemanticIssueArtifact {
  const value: ValidatedSemanticIssueArtifact = {
    phase: "validated-semantic",
    kind: "issue",
    title: artifact.title,
    body: artifact.body,
    provenance: cloneArtifactContractProvenance(artifact.provenance),
    ...(artifact.labels === undefined ? {} : { labels: [...artifact.labels] }),
    ...(artifact.assignees === undefined ? {} : { assignees: [...artifact.assignees] }),
  };
  deepFreeze(value);
  trustedSemanticIssueArtifacts.add(value);
  return value;
}

export function isTrustedSemanticIssueArtifact(value: unknown): value is ValidatedSemanticIssueArtifact {
  return typeof value === "object" && value !== null && trustedSemanticIssueArtifacts.has(value);
}

function register<T extends object>(value: T): T {
  deepFreeze(value);
  trustedArtifacts.add(value);
  return value;
}

function cloneProvenance(provenance: ContractProvenance): ContractProvenance {
  return {
    authority: provenance.authority,
    repository: { ...provenance.repository },
    ref: provenance.ref,
    treeSha: provenance.treeSha,
    template: { ...provenance.template },
    ...(provenance.policy === undefined ? {} : { policy: { ...provenance.policy } }),
    ...(provenance.branchGovernance === undefined ? {} : { branchGovernance: { ...provenance.branchGovernance } }),
  };
}

function cloneArtifactContractProvenance(provenance: ArtifactContractProvenance): ArtifactContractProvenance {
  return {
    authority: provenance.authority,
    repository: { ...provenance.repository },
    ref: provenance.ref,
    treeSha: provenance.treeSha,
    source: { ...provenance.source },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
