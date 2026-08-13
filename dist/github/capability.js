import { VALIDATED_RENDERED_PHASE, } from "./types.js";
const trustedArtifacts = new WeakSet();
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
        ...(provenance.policy === undefined ? {} : { policy: { ...provenance.policy } }),
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