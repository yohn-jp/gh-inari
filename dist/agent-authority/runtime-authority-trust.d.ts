/**
 * Repository-native Runtime Authority trust artifacts.
 *
 * The repository is the trust-policy authority for these records. This module
 * only reads the configured authoritative protected ref (the repository's
 * default branch in V1), validates every authority artifact found there, and
 * returns bounded provenance for the immutable snapshot that was used. It
 * never reads the caller's checkout or accepts a caller-supplied working ref.
 *
 * Runtime registration, rotation/revocation workflow, and delegated writes to
 * this directory belong to later governance slices. A disabled or expired
 * record remains representable in a snapshot for that governance, but cannot
 * be resolved as active authorization.
 */
import { type RuntimeAuthority } from "./runtime-authority.js";
import type { RepositoryGovernanceSourceReader } from "../governance.js";
import type { GitHubBranch } from "../github/types.js";
/** The structural seam used to read repository authority without consulting a local checkout. */
export interface RuntimeAuthoritySourceReader extends RepositoryGovernanceSourceReader {
    /** Resolve the default branch to its immutable commit before reading its tree. */
    findBranch(branch: string): Promise<GitHubBranch | undefined>;
}
export declare const RUNTIME_AUTHORITY_MAX_RECORDS: 256;
export type RuntimeAuthorityTrustErrorCode = "RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE" | "RUNTIME_AUTHORITY_SOURCE_INVALID" | "RUNTIME_AUTHORITY_REPOSITORY_ID_UNAVAILABLE" | "RUNTIME_AUTHORITY_NOT_FOUND" | "RUNTIME_AUTHORITY_INACTIVE" | "RUNTIME_AUTHORITY_AMBIGUOUS";
export interface RuntimeAuthorityTrustErrorDetails {
    readonly operation?: string;
    readonly repository?: string;
    readonly ref?: string;
    readonly path?: string;
    readonly authorityId?: string;
    readonly policySha?: string;
    readonly status?: string;
    readonly reason?: string;
    readonly [key: string]: unknown;
}
/** Stable fail-closed failure for repository Runtime Authority resolution. */
export declare class RuntimeAuthorityTrustError extends Error {
    readonly code: RuntimeAuthorityTrustErrorCode;
    readonly details: Readonly<RuntimeAuthorityTrustErrorDetails>;
    readonly diagnostics: readonly unknown[];
    constructor(code: RuntimeAuthorityTrustErrorCode, message: string, details?: RuntimeAuthorityTrustErrorDetails, diagnostics?: readonly unknown[], options?: ErrorOptions);
}
export interface RuntimeAuthorityRepositoryIdentity {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly nameWithOwner: string;
    readonly repositoryId: string;
}
export interface RuntimeAuthorityArtifactSource {
    readonly path: string;
    readonly ref: string;
    /** Git blob SHA selected from the authoritative tree. */
    readonly sha: string;
    /** SHA-256 of the decoded artifact content. */
    readonly digest: string;
}
/** Provenance for the exact protected-ref trust snapshot used for admission. */
export interface RuntimeAuthorityTrustProvenance {
    readonly authority: "repository-default-branch";
    readonly repository: RuntimeAuthorityRepositoryIdentity;
    readonly ref: string;
    /** Immutable commit SHA resolved from the canonical protected ref. */
    readonly policySha: string;
    readonly treeSha: string;
    readonly source: RuntimeAuthorityArtifactSource;
}
export interface LoadedRuntimeAuthority {
    readonly authority: RuntimeAuthority;
    readonly path: string;
    readonly provenance: RuntimeAuthorityTrustProvenance;
}
/** All structurally valid records observed in one authoritative protected-ref generation. */
export interface RuntimeAuthorityTrustSnapshot {
    readonly repository: RuntimeAuthorityRepositoryIdentity;
    readonly ref: string;
    /** Immutable commit SHA resolved from `ref` for this policy snapshot. */
    readonly policySha: string;
    readonly treeSha: string;
    readonly authorities: readonly LoadedRuntimeAuthority[];
}
export interface RuntimeAuthorityLookupOptions {
    /** Clock used for active-window evaluation; injectable for deterministic admission/tests. */
    readonly now?: Date;
}
export interface RenderedRuntimeAuthorityArtifact {
    readonly path: string;
    readonly content: string;
    readonly authority: RuntimeAuthority;
}
/** Return the only repository path at which an authority record may live. */
export declare function runtimeAuthorityArtifactPath(authorityId: string): string;
/** Render one validated public trust record into its canonical repository artifact. */
export declare function renderRuntimeAuthorityArtifact(input: unknown): RenderedRuntimeAuthorityArtifact;
/** Render only the canonical JSON content for a Runtime Authority artifact. */
export declare function renderRuntimeAuthority(input: unknown): string;
/**
 * Load every Runtime Authority record from one authoritative protected-ref
 * generation. Inactive records are retained in the snapshot so revocation and
 * rotation state remains observable, but resolution below rejects them.
 */
export declare function loadRuntimeAuthorityTrust(reader: RuntimeAuthoritySourceReader): Promise<RuntimeAuthorityTrustSnapshot>;
/**
 * Resolve one active Runtime Authority by its repository-local identifier.
 * The complete directory is validated first, so malformed or ambiguous
 * neighboring records cannot be hidden by selecting a healthy record.
 */
export declare function resolveRuntimeAuthority(reader: RuntimeAuthoritySourceReader, authorityId: string, options?: RuntimeAuthorityLookupOptions): Promise<LoadedRuntimeAuthority>;
/** Explicit alias for callers that name the operation by its key identifier. */
export declare const loadRuntimeAuthority: typeof resolveRuntimeAuthority;
