/**
 * Repository Canon resolution for the Semantic Artifact pipeline.
 *
 * This module is the repository-facing Core adapter boundary.  It resolves a
 * Canon v2 pull-request contract from the authoritative default branch and
 * compiles it through the shared Effective Artifact Contract compiler.  It
 * does not select semantic values, derive identities, or project GitHub
 * representations, and it does not define its own Canon location or
 * selector policy: discovery and template-resolution precedence are
 * delegated to the same repository governance authority every other
 * governed artifact uses (`governance.ts`, `template-resolver.ts`).
 */
import { createHash } from "node:crypto";
import { ArtifactContractValidationError, parseArtifactContract, compileEffectiveArtifactContract, } from "./contract/index.js";
import { createRemoteSemanticIdentities } from "./governance.js";
import { resolveTemplate, semanticTemplateResolutionCandidate, TemplateResolutionError } from "./template-resolver.js";
/** Stable machine-readable failure for repository Canon resolution. */
export class ArtifactContractResolutionError extends Error {
    code;
    path;
    diagnostics;
    details;
    constructor(code, path, message, details, diagnostics = [{ code, path, message }]) {
        super(message);
        this.name = "ArtifactContractResolutionError";
        this.code = code;
        this.path = path;
        this.diagnostics = Object.freeze([...diagnostics]);
        this.details = details;
    }
}
/**
 * Resolve the authoritative pull-request Canon identity using the same
 * repository governance discovery and template-resolution precedence as
 * every other governed artifact. This module does not define a second
 * location/selector policy: `.github/inari/pull-request.json` and
 * `.github/inari/pull-requests/<id>.json` are the only recognized sources.
 */
async function selectCanonIdentity(tree, selector, context, ref) {
    const candidates = createRemoteSemanticIdentities(tree).filter((identity) => identity.kind === "pull_request");
    try {
        return await resolveTemplate({
            candidates: candidates.map(semanticTemplateResolutionCandidate),
            selector,
        });
    }
    catch (error) {
        if (!(error instanceof TemplateResolutionError))
            throw error;
        throw artifactContractResolutionErrorFromTemplateResolution(error, context, ref);
    }
}
function artifactContractResolutionErrorFromTemplateResolution(error, context, ref) {
    const details = { repository: context.nameWithOwner, ref, ...error.details };
    switch (error.code) {
        case "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_AMBIGUOUS":
            return new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS", "$.selector", error.message, details);
        default:
            return new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", "$.selector", error.message, details);
    }
}
function findCanonEntry(tree, identity, context, ref) {
    const entry = tree.find((candidate) => candidate.path === identity.sourcePath && candidate.type === "blob");
    if (entry === undefined) {
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", "$.source", `Artifact Contract Canon "${identity.sourcePath}" was not found for ${context.nameWithOwner} at ref "${ref}".`, { repository: context.nameWithOwner, ref, path: identity.sourcePath });
    }
    return entry;
}
function sourceProvenance(context, ref, treeSha, entry, source) {
    return {
        authority: "repository-default-branch",
        repository: {
            host: context.hostname,
            owner: context.owner,
            name: context.name,
            nameWithOwner: context.nameWithOwner,
            ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
        },
        ref,
        treeSha,
        source: {
            path: entry.path,
            ref,
            sha: entry.sha,
            digest: createHash("sha256").update(source, "utf8").digest("hex"),
        },
    };
}
function parseCanonSource(source, path) {
    let raw;
    try {
        raw = JSON.parse(source);
    }
    catch (error) {
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SOURCE_INVALID", path, `Artifact Contract Canon "${path}" is not valid JSON.`, { reason: error instanceof Error ? error.message : "invalid JSON" });
    }
    try {
        const contract = parseArtifactContract(raw);
        if (contract.kind !== "pull_request") {
            throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_KIND_INVALID", "$.kind", `Artifact Contract Canon "${path}" must declare kind "pull_request".`, { kind: contract.kind });
        }
        return contract;
    }
    catch (error) {
        if (error instanceof ArtifactContractResolutionError)
            throw error;
        if (error instanceof ArtifactContractValidationError) {
            throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SOURCE_INVALID", path, `Artifact Contract Canon "${path}" failed Core validation.`, { violations: error.violations }, error.violations);
        }
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SOURCE_INVALID", path, `Artifact Contract Canon "${path}" failed Core validation.`, { reason: error instanceof Error ? error.message : "invalid contract" });
    }
}
/**
 * Resolve the authoritative pull-request Canon and compile its Effective
 * Artifact Contract.  All repository identity and generation fields come
 * from the adapter's default-branch/tree/blob reads.
 */
export async function compileRepositoryEffectivePullRequestContract(adapter, selector, options = {}) {
    const context = await adapter.resolveRepositoryContext();
    const ref = await adapter.getRepositoryDefaultBranch();
    const tree = await adapter.getRepositoryTree(ref);
    const identity = await selectCanonIdentity(tree.entries, selector, context, ref);
    const entry = findCanonEntry(tree.entries, identity, context, ref);
    const source = await adapter.getRepositoryBlob(entry.sha);
    const contract = parseCanonSource(source, entry.path);
    const provenance = sourceProvenance(context, ref, tree.sha, entry, source);
    return compileEffectiveArtifactContract(contract, { provenance, capabilities: options.capabilities });
}
//# sourceMappingURL=artifact-contract-governance.js.map