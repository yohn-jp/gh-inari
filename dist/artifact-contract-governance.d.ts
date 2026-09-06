/**
 * Repository Canon resolution for the Semantic Artifact pipeline.
 *
 * This module is the repository-facing Core adapter boundary.  It resolves a
 * Canon v2 pull-request contract from the authoritative default branch and
 * compiles it through the shared Effective Artifact Contract compiler.  It
 * does not select semantic values, derive identities, or project GitHub
 * representations.
 */
import { type EffectiveArtifactContract } from "./contract/index.js";
import { GitHubAdapter } from "./github/index.js";
/** Canon locations accepted by the v2 repository contract resolver. */
export declare const ARTIFACT_CONTRACT_CANON_PATHS: readonly [".github/inari/canon/pull-request.json", ".github/inari/canon/pull_request.json", ".github/inari/canon/pull-requests", ".github/inari/canon/pull_requests", ".inari/canon/pull-request.json", ".inari/canon/pull_request.json", ".inari/canon/pull-requests", ".inari/canon/pull_requests"];
export type ArtifactContractResolutionErrorCode = "ARTIFACT_CONTRACT_NOT_FOUND" | "ARTIFACT_CONTRACT_SELECTOR_AMBIGUOUS" | "ARTIFACT_CONTRACT_SOURCE_INVALID" | "ARTIFACT_CONTRACT_KIND_INVALID";
export interface ArtifactContractResolutionDiagnostic {
    readonly code: ArtifactContractResolutionErrorCode;
    readonly path: string;
    readonly message: string;
}
/** Stable machine-readable failure for repository Canon resolution. */
export declare class ArtifactContractResolutionError extends Error {
    readonly code: ArtifactContractResolutionErrorCode;
    readonly path: string;
    readonly diagnostics: readonly unknown[];
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: ArtifactContractResolutionErrorCode, path: string, message: string, details?: Readonly<Record<string, unknown>>, diagnostics?: readonly unknown[]);
}
export interface RepositoryEffectiveArtifactContractOptions {
    readonly capabilities?: readonly string[];
}
/**
 * Resolve the authoritative pull-request Canon and compile its Effective
 * Artifact Contract.  All repository identity and generation fields come
 * from the adapter's default-branch/tree/blob reads.
 */
export declare function compileRepositoryEffectivePullRequestContract(adapter: GitHubAdapter, selector?: string, options?: RepositoryEffectiveArtifactContractOptions): Promise<EffectiveArtifactContract>;
