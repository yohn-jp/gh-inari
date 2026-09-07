/**
 * GitHub Actions trusted runtime for Change plans.
 *
 * The workflow supplies only a semantic request. This module resolves bounded
 * GitHub evidence, invokes Core planning, applies explicit effects through the
 * #217 issuer authority, and verifies a fresh #213 projection.
 */
import { type CanonicalBranchNamingInput, type ChangeDiagnostic, type ChangeProjectionInput } from "../change.js";
import { type ChangeRemoteExecutor, type ChangeRemoteExecutionEvidence, type ChangeRemoteMutationRequest, type ChangeRemoteReadRequest } from "../change-executor.js";
import { type ChangeTrustedExecutorErrorCode, type ChangeTrustedEvidenceReader } from "../change-trusted-executor.js";
import { type GitHubChangeEffectCompareAndDeleteOutcome, type GitHubChangeEffectRepository, type GitHubChangeEffectRequest, type GitHubChangeEffectResponse, type GitHubChangeEffectTransport } from "./change-effect-adapter.js";
import { type IssuerCredentialRequest, type IssuerScopedMutationCapability, type TrustedInstallationCredentialBroker, type IssuerRepositoryIdentity } from "./issuer-authority.js";
import type { PullRequestBranchGovernance } from "../contract/ir.js";
/** Stable, non-secret boundaries exposed for trusted Actions runtime failures. */
export declare const TRUSTED_ACTIONS_FAILURE_STAGES: readonly ["repository-evidence", "trusted-execution", "branch-governance", "issuer-configuration", "installation-token", "installation-scope", "projection-execution"];
export type TrustedActionsFailureStage = (typeof TRUSTED_ACTIONS_FAILURE_STAGES)[number];
/**
 * Bounded, secret-safe reasons within the `repository-evidence` stage. Fixed at the
 * exact repository-bootstrap boundary that failed so #239-class dogfood failures no
 * longer collapse into one undifferentiated stage (issue #244).
 */
export declare const REPOSITORY_EVIDENCE_FAILURE_REASONS: readonly ["repository-configuration", "repository-request", "repository-status", "repository-body", "repository-id", "repository-fork"];
export type RepositoryEvidenceFailureReason = (typeof REPOSITORY_EVIDENCE_FAILURE_REASONS)[number];
export declare function isRepositoryEvidenceFailureReason(value: unknown): value is RepositoryEvidenceFailureReason;
export interface TrustedActionsFailureDiagnostic {
    readonly stage: TrustedActionsFailureStage;
    readonly reason?: RepositoryEvidenceFailureReason;
    readonly trustedCode?: ChangeTrustedExecutorErrorCode;
    readonly diagnostics?: readonly ChangeDiagnostic[];
    readonly evidence?: ChangeRemoteExecutionEvidence;
}
export declare function isTrustedActionsFailureStage(value: unknown): value is TrustedActionsFailureStage;
export declare class GitHubActionsChangeExecutorError extends Error {
    readonly code: "CHANGE_ACTIONS_RUNTIME_INVALID";
    readonly details?: TrustedActionsFailureDiagnostic;
    constructor(message?: string, stage?: TrustedActionsFailureStage, reason?: RepositoryEvidenceFailureReason, fields?: Omit<TrustedActionsFailureDiagnostic, "stage" | "reason">);
}
export interface GitHubActionsApiTransportOptions {
    readonly apiUrl?: string;
    readonly token: string;
    /** GraphQL repository node ID used by the atomic conditional ref update. */
    readonly repositoryNodeId?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly failureStage?: TrustedActionsFailureStage;
}
/** A bounded credential-bound transport. The bearer never appears in results. */
export declare class GitHubActionsApiTransport implements GitHubChangeEffectTransport {
    #private;
    constructor(options: GitHubActionsApiTransportOptions);
    request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse>;
    private requestAt;
    /**
     * Delete only when GitHub's GraphQL ref update still points at the expected
     * OID. A missing node ID or any GraphQL error is a safe mismatch; callers
     * must not emulate this with a REST GET followed by DELETE.
     */
    compareAndDeleteBranch(request: {
        readonly branch: string;
        readonly expectedCommitSha: string;
    }): Promise<GitHubChangeEffectCompareAndDeleteOutcome>;
}
export interface GitHubActionsCredentialBrokerOptions {
    readonly appId: string;
    readonly installationId: string;
    readonly privateKeyPem: string;
    readonly repository: GitHubChangeEffectRepository;
    readonly target: IssuerRepositoryIdentity;
    readonly repositoryNodeId?: string;
    readonly apiUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
}
/** #217 broker implementation used only inside the protected Actions job. */
export declare class GitHubActionsCredentialBroker implements TrustedInstallationCredentialBroker {
    #private;
    constructor(options: GitHubActionsCredentialBrokerOptions);
    withScopedInstallationCredential(request: IssuerCredentialRequest, operation: (capability: IssuerScopedMutationCapability) => Promise<void>): Promise<void>;
    private issueInstallationToken;
}
declare function deriveNaming(title: string): CanonicalBranchNamingInput;
export declare const deriveChangeNamingFromIssueTitle: typeof deriveNaming;
export interface GitHubActionsEvidenceReaderOptions {
    readonly repository: GitHubChangeEffectRepository;
    readonly identity: {
        readonly repositoryHost: string;
        readonly repositoryId: string;
        readonly rootIssue: number;
    };
    /**
     * Pull request currently being evaluated at a repository merge boundary.
     * The target PR is retained even when its head is not a Change-shaped branch
     * so the admission adapter cannot silently classify it as unrelated.
     */
    readonly pullRequestNumber?: number;
    /** Absent when the repository's PR policy declares no branch rule; the canonical branch grammar still applies. */
    readonly branchGovernance?: PullRequestBranchGovernance;
    readonly transport: GitHubChangeEffectTransport;
    /** Trusted checkout containing the repository's default-branch governance. */
    readonly cwd?: string;
    /**
     * Core-produced PR plan supplied by the semantic preparation boundary.
     * Omitted only while the explicit v1 Change payload remains in compatibility mode.
     */
    readonly semanticPullRequestPlan?: unknown;
}
/** Converts only bounded GitHub fields into the #213 Core evidence contract. */
export declare class GitHubActionsEvidenceReader implements ChangeTrustedEvidenceReader {
    #private;
    readonly requiresGovernedIssueValidation: boolean;
    constructor(options: GitHubActionsEvidenceReaderOptions);
    read(request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest): Promise<ChangeProjectionInput>;
    private readInternal;
    private readReadyEvidence;
    /**
     * Resolve the root Issue against every authoritative Issue template when no
     * marker is present, or against the marker's exact identity when present.
     * Selection and validation remain delegated to the shared artifact parser.
     */
    private readGovernedIssue;
    private issueTemplateSelectors;
    private assertGovernedIssue;
    private assertCanonicalIssueBody;
    private readPullRequestBody;
    private readGovernanceTree;
    private readGovernedContract;
    private readLocalGovernanceFile;
    private readMatchingGovernanceFile;
    private readBranch;
    private readBranches;
    private readPullRequests;
    private request;
}
export declare function loadBranchGovernance(cwd: string): Promise<PullRequestBranchGovernance | undefined>;
export declare function asTrustedActionsFailure(error: unknown, issuerStage: TrustedActionsFailureStage | undefined): GitHubActionsChangeExecutorError;
export interface GitHubActionsRuntimeOptions {
    readonly cwd: string;
    readonly request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest;
    readonly environment?: NodeJS.ProcessEnv;
    readonly fetch?: typeof globalThis.fetch;
}
/** Build the trusted executor from GitHub Actions runtime claims and secrets. */
export declare function createGitHubActionsChangeExecutor(options: GitHubActionsRuntimeOptions): Promise<ChangeRemoteExecutor>;
/** Workflow entrypoint. It emits one bounded JSON result and never logs secrets. */
export declare function runGitHubActionsChangeExecutor(environment?: NodeJS.ProcessEnv, cwd?: string): Promise<number>;
export {};
