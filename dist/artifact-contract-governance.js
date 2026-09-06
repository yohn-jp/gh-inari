/**
 * Repository Canon resolution for the Semantic Artifact pipeline.
 *
 * This module is the repository-facing Core adapter boundary.  It resolves a
 * Canon v2 pull-request contract from the authoritative default branch and
 * compiles it through the shared Effective Artifact Contract compiler.  It
 * does not select semantic values, derive identities, or project GitHub
 * representations.
 */
import { createHash } from "node:crypto";
import { ArtifactContractValidationError, parseArtifactContract, compileEffectiveArtifactContract, } from "./contract/index.js";
/** Canon locations accepted by the v2 repository contract resolver. */
export const ARTIFACT_CONTRACT_CANON_PATHS = Object.freeze([
    ".github/inari/canon/pull-request.json",
    ".github/inari/canon/pull_request.json",
    ".github/inari/canon/pull-requests",
    ".github/inari/canon/pull_requests",
    ".inari/canon/pull-request.json",
    ".inari/canon/pull_request.json",
    ".inari/canon/pull-requests",
    ".inari/canon/pull_requests",
]);
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
function compareStrings(left, right) {
    return left.localeCompare(right, "en-US");
}
function isPullRequestCanonPath(value) {
    if (!value.endsWith(".json"))
        return false;
    return (value === ".github/inari/canon/pull-request.json" ||
        value === ".github/inari/canon/pull_request.json" ||
        value === ".inari/canon/pull-request.json" ||
        value === ".inari/canon/pull_request.json" ||
        /^\.github\/inari\/canon\/pull[-_]requests\/[A-Za-z0-9_-]+\.json$/u.test(value) ||
        /^\.inari\/canon\/pull[-_]requests\/[A-Za-z0-9_-]+\.json$/u.test(value));
}
function candidateId(path) {
    const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/u, "");
    if (base === "pull-request" || base === "pull_request")
        return "default";
    return base;
}
function canonCandidates(tree) {
    return tree
        .filter((entry) => entry.type === "blob" && isPullRequestCanonPath(entry.path))
        .map((entry) => ({ entry, id: candidateId(entry.path) }))
        .sort((left, right) => compareStrings(left.entry.path, right.entry.path));
}
function selectCandidate(candidates, selector, context, ref) {
    if (candidates.length === 0) {
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", "$.source", `No pull_request Artifact Contract Canon was found for ${context.nameWithOwner} at ref "${ref}".`, { repository: context.nameWithOwner, ref, attemptedPaths: ARTIFACT_CONTRACT_CANON_PATHS });
    }
    const requested = selector?.trim();
    const matches = requested === undefined || requested === ""
        ? candidates.length === 1
            ? candidates
            : candidates.filter((candidate) => candidate.id === "default")
        : candidates.filter((candidate) => candidate.id === requested ||
            candidate.entry.path === requested ||
            candidate.entry.path.replace(/\.json$/u, "") === requested);
    if (matches.length === 1)
        return matches[0];
    if (matches.length > 1) {
        throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS", "$.selector", `Artifact Contract selector "${requested ?? "default"}" matches multiple Canon sources.`, { selector: requested ?? "default", matches: matches.map((candidate) => candidate.entry.path) });
    }
    throw new ArtifactContractResolutionError("ARTIFACT_CONTRACT_NOT_FOUND", "$.selector", `No pull_request Artifact Contract Canon matches selector "${requested ?? "default"}".`, { selector: requested ?? "default", candidates: candidates.map((candidate) => candidate.entry.path) });
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
    const candidate = selectCandidate(canonCandidates(tree.entries), selector, context, ref);
    const source = await adapter.getRepositoryBlob(candidate.entry.sha);
    const contract = parseCanonSource(source, candidate.entry.path);
    const provenance = sourceProvenance(context, ref, tree.sha, candidate.entry, source);
    return compileEffectiveArtifactContract(contract, { provenance, capabilities: options.capabilities });
}
//# sourceMappingURL=artifact-contract-governance.js.map