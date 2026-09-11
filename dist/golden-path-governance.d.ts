/**
 * Bounded, read-only governance discovery for the Golden Path.
 *
 * This module is an agent-facing projection.  Template selection, Canon
 * resolution, compilation, and generation semantics remain owned by the
 * existing governance authorities; this layer only exposes their result as a
 * small status/next-action contract.
 */
import type { ArtifactContractProvenance, CanonicalContract, ContractProvenance } from "./contract/ir.js";
import type { EffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { GitHubAdapter } from "./github/index.js";
import { type TemplateSelector } from "./template-discovery.js";
import { type TemplateResolverDependencies } from "./template-resolver.js";
export declare const GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION: "1";
export type GoldenPathGovernanceSource = "native-template" | "artifact-contract";
export type GoldenPathGovernanceDomain = "issue" | "pr" | "branch" | "pull_request";
export type GoldenPathGovernanceContract = CanonicalContract | EffectiveArtifactContract;
export type GoldenPathGovernanceProvenance = ContractProvenance | ArtifactContractProvenance;
export type GoldenPathGovernanceStatus = "resolved" | "discovery-required" | "ambiguous" | "stale" | "incompatible" | "unavailable";
export type GoldenPathGovernanceReasonCode = "RESOLVED" | "NO_GOVERNANCE_CANDIDATES" | "SELECTOR_INVALID" | "SELECTOR_NOT_FOUND" | "SELECTOR_AMBIGUOUS" | "DEFAULT_INVALID" | "DEFAULT_UNAVAILABLE" | "DEFAULT_AMBIGUOUS" | "GOVERNANCE_SOURCE_UNAVAILABLE" | "GOVERNANCE_SOURCE_INVALID" | "ARTIFACT_CONTRACT_NOT_FOUND" | "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS" | "ARTIFACT_CONTRACT_SOURCE_INVALID" | "ARTIFACT_CONTRACT_KIND_INVALID" | "GENERATION_STALE" | "REQUEST_INCOMPATIBLE";
export interface GoldenPathGovernanceDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
    readonly candidates: readonly string[];
    readonly candidateCount: number;
    readonly candidatesTruncated: boolean;
}
export interface GoldenPathGovernanceNextAction {
    /** Stable action name for agent projections. */
    readonly action: "direct-governed-create" | "inspect-governance" | "provide-template-selector" | "refresh-governance" | "repair-governance";
    /** Alias useful to callers that model actions by kind. */
    readonly kind: GoldenPathGovernanceNextAction["action"];
    readonly reason?: GoldenPathGovernanceReasonCode;
    readonly candidates?: readonly string[];
}
export interface GoldenPathKnownGovernance {
    readonly source: GoldenPathGovernanceSource;
    readonly contract: GoldenPathGovernanceContract;
}
export interface GoldenPathGovernanceDiscoveryRequest {
    readonly domain: GoldenPathGovernanceDomain;
    readonly source?: GoldenPathGovernanceSource;
    readonly selector?: string | TemplateSelector;
    /** Previously compiled evidence.  It is accepted only after freshness verification. */
    readonly known?: GoldenPathKnownGovernance;
    /** Optional caller expectation used to reject a result from another generation. */
    readonly expectedGeneration?: string;
    readonly capabilities?: readonly string[];
    readonly templateResolver?: TemplateResolverDependencies;
}
export interface GoldenPathGovernanceResolved {
    readonly version: typeof GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION;
    readonly status: "resolved";
    readonly domain: GoldenPathGovernanceDomain;
    readonly source: GoldenPathGovernanceSource;
    readonly contract: GoldenPathGovernanceContract;
    readonly provenance: GoldenPathGovernanceProvenance;
    readonly generation: GoldenPathGovernanceProvenance;
    readonly nextAction: GoldenPathGovernanceNextAction;
}
export interface GoldenPathGovernanceUnresolved {
    readonly version: typeof GOLDEN_PATH_GOVERNANCE_DISCOVERY_VERSION;
    readonly status: Exclude<GoldenPathGovernanceStatus, "resolved">;
    readonly domain: GoldenPathGovernanceDomain;
    readonly source: GoldenPathGovernanceSource;
    readonly reason: GoldenPathGovernanceReasonCode;
    readonly nextAction: GoldenPathGovernanceNextAction;
    readonly diagnostic: GoldenPathGovernanceDiagnostic;
    readonly generation?: GoldenPathGovernanceProvenance;
}
export type GoldenPathGovernanceDiscoveryResult = GoldenPathGovernanceResolved | GoldenPathGovernanceUnresolved;
/**
 * Resolve repository governance without performing a mutation.
 *
 * `native-template` delegates to `governance.ts`; `artifact-contract`
 * delegates to Artifact Contract governance.  No local checkout or recursive
 * repository scan is consulted by either path.
 */
export declare function discoverGoldenPathGovernance(adapter: GitHubAdapter, request: GoldenPathGovernanceDiscoveryRequest): Promise<GoldenPathGovernanceDiscoveryResult>;
/** Alias emphasizing that this contract is a projection rather than a workflow engine. */
export declare const projectGoldenPathGovernance: typeof discoverGoldenPathGovernance;
/** Compatibility alias for callers that phrase discovery as resolution. */
export declare const resolveGoldenPathGovernance: typeof discoverGoldenPathGovernance;
