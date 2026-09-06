import { VALIDATED_RENDERED_PHASE, } from "./types.js";
const trustedArtifacts = new WeakSet();
const trustedSemanticArtifacts = new WeakSet();
const trustedSemanticIssueArtifacts = new WeakSet();
/** Internal compiler-to-adapter boundary; intentionally not part of the public exports. */
export function createValidatedRenderedIssueArtifact(artifact) {
    const value = {
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
export function createValidatedRenderedPullRequestArtifact(artifact) {
    const value = {
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
export function isTrustedValidatedRenderedArtifact(value) {
    return typeof value === "object" && value !== null && trustedArtifacts.has(value);
}
/** Internal Core-to-adapter boundary for v2 Semantic PR projections. */
export function createValidatedSemanticPullRequestArtifact(artifact) {
    const value = {
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
export function isTrustedSemanticPullRequestArtifact(value) {
    return typeof value === "object" && value !== null && trustedSemanticArtifacts.has(value);
}
/** Internal Core-to-adapter boundary for v2 Semantic Issue projections. */
export function createValidatedSemanticIssueArtifact(artifact) {
    const value = {
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
export function isTrustedSemanticIssueArtifact(value) {
    return typeof value === "object" && value !== null && trustedSemanticIssueArtifacts.has(value);
}
function register(value) {
    deepFreeze(value);
    trustedArtifacts.add(value);
    return value;
}
function cloneProvenance(provenance) {
    return {
        authority: provenance.authority,
        repository: { ...provenance.repository },
        ref: provenance.ref,
        treeSha: provenance.treeSha,
        template: { ...provenance.template },
        ...(provenance.semanticSource === undefined ? {} : { semanticSource: { ...provenance.semanticSource } }),
        ...(provenance.policy === undefined ? {} : { policy: { ...provenance.policy } }),
        ...(provenance.branchGovernance === undefined ? {} : { branchGovernance: { ...provenance.branchGovernance } }),
    };
}
function cloneArtifactContractProvenance(provenance) {
    return {
        authority: provenance.authority,
        repository: { ...provenance.repository },
        ref: provenance.ref,
        treeSha: provenance.treeSha,
        source: { ...provenance.source },
    };
}
function deepFreeze(value) {
    if (typeof value !== "object" || value === null || Object.isFrozen(value))
        return value;
    Object.freeze(value);
    for (const child of Object.values(value))
        deepFreeze(child);
    return value;
}
//# sourceMappingURL=capability.js.map