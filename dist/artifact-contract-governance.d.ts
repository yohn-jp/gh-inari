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
import { type EffectiveArtifactContract } from "./contract/index.js";
import { GitHubAdapter } from "./github/index.js";
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
