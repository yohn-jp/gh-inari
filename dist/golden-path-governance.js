/**
 * Bounded, read-only governance discovery for the Golden Path.
 *
 * This module is an agent-facing projection.  Template selection, Canon
 * resolution, compilation, and generation semantics remain owned by the
 * existing governance authorities; this layer only exposes their result as a
 * small status/next-action contract.
 */
import { compileRepositoryEffectiveArtifactContract, } from "./artifact-contract-governance.js";
import { compileRepositoryGovernedContract, GovernanceError, verifyGovernedMutationFreshness, } from "./governance.js";
import { TemplateDiscoveryError } from "./template-discovery.js";
import { TemplateResolutionError } from "./template-resolver.js";
export const GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION = "1";
const MAX_DIAGNOSTIC_CANDIDATES = 8;
/**
 * Resolve repository governance without performing a mutation.
 *
 * `native-template` delegates to `governance.ts`; `artifact-contract`
 * delegates to Artifact Contract governance.  No local checkout or recursive
 * repository scan is consulted by either path.
 */
export async function discoverGoldenPathGovernance(adapter, request) {
    const source = request.source ?? defaultSource(request.domain);
    if (!isSourceCompatible(source, request.domain)) {
        return unresolved(request, source, "REQUEST_INCOMPATIBLE", "incompatible", {
            code: "REQUEST_INCOMPATIBLE",
            message: `Governance source "${source}" cannot resolve domain "${request.domain}".`,
            candidates: [],
            candidateCount: 0,
            candidatesTruncated: false,
        });
    }
    if (request.known !== undefined) {
        const knownResult = await assessKnownGovernance(adapter, request, source);
        if (knownResult !== undefined)
            return knownResult;
    }
    try {
        const contract = await compile(adapter, request, source);
        const provenance = provenanceOf(contract);
        if (request.expectedGeneration !== undefined && provenance.treeSha !== request.expectedGeneration) {
            return unresolved(request, source, "GENERATION_STALE", "stale", generationDiagnostic("GENERATION_STALE", provenance.treeSha, request.expectedGeneration), provenance);
        }
        return resolved(request, source, contract, provenance);
    }
    catch (error) {
        return unresolvedFromError(request, source, error);
    }
}
/** Alias emphasizing that this contract is a projection rather than a workflow engine. */
export const projectGoldenPathGovernance = discoverGoldenPathGovernance;
/** Compatibility alias for callers that phrase discovery as resolution. */
export const resolveGoldenPathGovernance = discoverGoldenPathGovernance;
async function compile(adapter, request, source) {
    if (source === "native-template") {
        return compileRepositoryGovernedContract(adapter, request.domain, request.selector, {
            templateResolver: request.templateResolver,
        });
    }
    const kind = artifactKind(request.domain);
    return compileRepositoryEffectiveArtifactContract(adapter, kind, selectorString(request.selector), {
        capabilities: request.capabilities,
    });
}
async function assessKnownGovernance(adapter, request, source) {
    const known = request.known;
    if (known === undefined || known.source !== source)
        return undefined;
    if (request.expectedGeneration !== undefined && known.provenance.treeSha !== request.expectedGeneration) {
        return unresolved(request, source, "GENERATION_STALE", "stale", generationDiagnostic("GENERATION_STALE", known.provenance.treeSha, request.expectedGeneration), known.provenance);
    }
    try {
        if (source === "native-template") {
            if (!isContractProvenance(known.provenance))
                return undefined;
            await verifyGovernedMutationFreshness(adapter, known.provenance);
        }
        else {
            const tree = await adapter.getRepositoryTree(await adapter.getRepositoryDefaultBranch());
            if (tree.sha !== known.provenance.treeSha) {
                return unresolved(request, source, "GENERATION_STALE", "stale", generationDiagnostic("GENERATION_STALE", known.provenance.treeSha, tree.sha), known.provenance);
            }
        }
        return resolved(request, source, known.contract, known.provenance);
    }
    catch (error) {
        return unresolvedFromError(request, source, error, known.provenance);
    }
}
function resolved(request, source, contract, provenance) {
    const nextAction = {
        action: "direct-governed-create",
        kind: "direct-governed-create",
    };
    return {
        version: GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION,
        status: "resolved",
        domain: request.domain,
        source,
        contract,
        provenance,
        generation: provenance,
        nextAction,
    };
}
function unresolved(request, source, reason, status, diagnostic, generation) {
    const action = actionFor(status, reason, diagnostic.candidates);
    return {
        version: GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION,
        status,
        domain: request.domain,
        source,
        reason,
        nextAction: action,
        diagnostic,
        ...(generation === undefined ? {} : { generation }),
    };
}
function actionFor(status, reason, candidates) {
    const action = status === "ambiguous"
        ? "provide-template-selector"
        : status === "stale"
            ? "refresh-governance"
            : status === "incompatible"
                ? "repair-governance"
                : "inspect-governance";
    return {
        action,
        kind: action,
        reason,
        ...(candidates.length === 0 ? {} : { candidates }),
    };
}
function unresolvedFromError(request, source, error, generation) {
    const mapped = mapError(error);
    return unresolved(request, source, mapped.reason, mapped.status, mapped.diagnostic, generation);
}
function mapError(error) {
    if (error instanceof TemplateResolutionError) {
        const reason = templateReason(error.code);
        return {
            reason,
            status: templateStatus(error.code),
            diagnostic: diagnosticFromTemplateError(error),
        };
    }
    if (error instanceof TemplateDiscoveryError) {
        const reason = error.code === "TEMPLATE_NOT_FOUND" ? "NO_GOVERNANCE_CANDIDATES" : "GOVERNANCE_SOURCE_INVALID";
        const candidates = (error.details.candidates ?? []).map((candidate) => candidate.path);
        return {
            reason,
            status: error.code === "TEMPLATE_NOT_FOUND" ? "discovery-required" : "incompatible",
            diagnostic: boundedDiagnostic(error.code, error.message, candidates, error.details.path),
        };
    }
    if (error instanceof GovernanceError) {
        const reason = error.code === "GOVERNANCE_SOURCE_UNAVAILABLE"
            ? "GOVERNANCE_SOURCE_UNAVAILABLE"
            : error.code === "GOVERNANCE_GENERATION_STALE"
                ? "GENERATION_STALE"
                : "GOVERNANCE_SOURCE_INVALID";
        return {
            reason,
            status: error.code === "GOVERNANCE_SOURCE_UNAVAILABLE"
                ? "unavailable"
                : error.code === "GOVERNANCE_GENERATION_STALE"
                    ? "stale"
                    : "incompatible",
            diagnostic: boundedDiagnostic(error.code, error.message, [], error.details.path),
        };
    }
    if (isArtifactResolutionError(error)) {
        const reason = error.code;
        const status = error.code === "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS"
            ? "ambiguous"
            : error.code === "ARTIFACT_CONTRACT_NOT_FOUND"
                ? "discovery-required"
                : "incompatible";
        const candidates = candidateValues(error.details?.candidates);
        return { reason, status, diagnostic: boundedDiagnostic(error.code, error.message, candidates, error.path) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        reason: "GOVERNANCE_SOURCE_UNAVAILABLE",
        status: "unavailable",
        diagnostic: boundedDiagnostic("GOVERNANCE_SOURCE_UNAVAILABLE", message, []),
    };
}
function templateReason(code) {
    switch (code) {
        case "TEMPLATE_RESOLUTION_NO_CANDIDATES":
            return "NO_GOVERNANCE_CANDIDATES";
        case "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_INTERACTION_FAILED":
            return "SELECTOR_AMBIGUOUS";
        case "TEMPLATE_RESOLUTION_SELECTOR_NOT_FOUND":
            return "SELECTOR_NOT_FOUND";
        case "TEMPLATE_RESOLUTION_DEFAULT_INVALID":
            return "DEFAULT_INVALID";
        case "TEMPLATE_RESOLUTION_DEFAULT_UNAVAILABLE":
            return "DEFAULT_UNAVAILABLE";
        case "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS":
            return "DEFAULT_AMBIGUOUS";
        case "TEMPLATE_CONFIG_INVALID":
        case "TEMPLATE_CONFIG_UNAVAILABLE":
            return "GOVERNANCE_SOURCE_INVALID";
    }
}
function templateStatus(code) {
    switch (code) {
        case "TEMPLATE_RESOLUTION_NO_CANDIDATES":
            return "discovery-required";
        case "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_AMBIGUOUS":
        case "TEMPLATE_RESOLUTION_INTERACTION_FAILED":
            return "ambiguous";
        case "TEMPLATE_CONFIG_UNAVAILABLE":
            return "unavailable";
        default:
            return "incompatible";
    }
}
function diagnosticFromTemplateError(error) {
    return boundedDiagnostic(error.code, error.message, error.details.candidates, undefined, error.details.candidateCount);
}
function boundedDiagnostic(code, message, candidates, path, candidateCount = candidates.length) {
    const normalized = candidates.filter((candidate) => candidate.length > 0);
    return {
        code,
        message,
        ...(path === undefined ? {} : { path }),
        candidates: normalized.slice(0, MAX_DIAGNOSTIC_CANDIDATES),
        candidateCount,
        candidatesTruncated: candidateCount > MAX_DIAGNOSTIC_CANDIDATES,
    };
}
function generationDiagnostic(code, observed, expected) {
    return boundedDiagnostic(code, `Governance generation "${observed}" does not match expected generation "${expected}".`, []);
}
function candidateValues(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((candidate) => typeof candidate === "string");
}
function isArtifactResolutionError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code.startsWith("ARTIFACT_CONTRACT_") &&
        "message" in error &&
        typeof error.message === "string");
}
function provenanceOf(contract) {
    if ("generation" in contract)
        return contract.provenance;
    if (contract.provenance === undefined) {
        throw new GovernanceError("GOVERNANCE_SOURCE_INVALID", "Compiled governance did not retain provenance.");
    }
    return contract.provenance;
}
function isContractProvenance(value) {
    return "template" in value;
}
function defaultSource(domain) {
    return domain === "branch" || domain === "pull_request" ? "artifact-contract" : "native-template";
}
function isSourceCompatible(source, domain) {
    if (source === "native-template")
        return domain === "issue" || domain === "pr";
    return domain === "issue" || domain === "pr" || domain === "branch" || domain === "pull_request";
}
function artifactKind(domain) {
    return domain === "branch" ? "branch" : domain === "pull_request" || domain === "pr" ? "pull_request" : "issue";
}
function selectorString(selector) {
    return selector;
}
//# sourceMappingURL=golden-path-governance.js.map