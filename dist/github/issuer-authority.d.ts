/**
 * The Inari GitHub App authority boundary.
 *
 * This module owns the identity, scope, permission, and trusted-execution
 * checks around the issuer capability. It deliberately does not derive
 * branches, validate lifecycle transitions, or implement GitHub Actions.
 *
 * A TrustedInstallationCredentialBroker is the only credential boundary. Its
 * implementation obtains an installation token inside trusted execution and
 * exposes only a repository-scoped mutation channel to this module. Neither
 * the token nor the App private key appears in any public type or result.
 */
import { type ChangeEffect, type ChangeEffectKind } from "../change.js";
import { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG, INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";
export { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG, INARI_ISSUER_PRINCIPAL, type InariIssuerPrincipal, } from "../issuer-identity.js";
export declare const ISSUER_AUTHORITY_CONTRACT_VERSION: 1;
export type IssuerAuthorityContractVersion = typeof ISSUER_AUTHORITY_CONTRACT_VERSION;
export declare const TRUSTED_EXECUTION_RUNTIME: "github-actions";
export declare const TRUSTED_EXECUTION_EVENTS: readonly ["workflow_dispatch", "workflow_call"];
export type TrustedExecutionEvent = (typeof TRUSTED_EXECUTION_EVENTS)[number];
export declare const ISSUER_PERMISSION_NAMES: readonly ["contents", "pull_requests", "metadata"];
export type IssuerPermissionName = (typeof ISSUER_PERMISSION_NAMES)[number];
export declare const ISSUER_PERMISSION_ACCESS: readonly ["read", "write"];
export type IssuerPermissionAccess = (typeof ISSUER_PERMISSION_ACCESS)[number];
/** Explicit App permissions. `metadata: read` is GitHub's automatic baseline. */
export type IssuerPermissionSet = Readonly<Partial<Record<IssuerPermissionName, IssuerPermissionAccess>>>;
/**
 * The App manifest ceiling. No Issues, administration, Actions, contents
 * administration, review, or merge permission is part of the issuer role.
 */
export declare const INARI_ISSUER_MAXIMUM_PERMISSIONS: IssuerPermissionSet;
/** Initial Change effects and their exact GitHub App permission requirement. */
export declare const INITIAL_CHANGE_EFFECT_PERMISSION_REQUIREMENTS: Readonly<Record<ChangeEffectKind, IssuerPermissionSet>>;
export declare const INITIAL_CHANGE_EFFECT_KINDS: readonly ["CREATE_BRANCH", "CREATE_PULL_REQUEST", "MARK_PULL_REQUEST_READY", "CLOSE_PULL_REQUEST", "DELETE_BRANCH"];
export type IssuerDiagnosticCode = "ISSUER_INVALID_ROOT" | "ISSUER_MISSING_PROPERTY" | "ISSUER_UNKNOWN_PROPERTY" | "ISSUER_INVALID_IDENTITY" | "ISSUER_INVALID_EXECUTION" | "ISSUER_UNTRUSTED_EXECUTION" | "ISSUER_UNSUPPORTED_EVENT" | "ISSUER_SCOPE_MISMATCH" | "ISSUER_INVALID_SCOPE" | "ISSUER_PERMISSION_MISMATCH" | "ISSUER_UNSUPPORTED_EFFECT" | "ISSUER_INVALID_EFFECT" | "ISSUER_REVIEW_AUTHORITY" | "ISSUER_CREDENTIAL_BOUNDARY" | "ISSUER_CREDENTIAL_EXPIRED" | "ISSUER_MUTATION_FAILED";
export declare const MAX_ISSUER_DIAGNOSTICS: 16;
export declare const MAX_ISSUER_DIAGNOSTIC_MESSAGE_LENGTH: 240;
export declare const MAX_ISSUER_DIAGNOSTIC_PATH_LENGTH: 160;
export declare const MAX_ISSUER_REPOSITORY_NAME_LENGTH: 255;
export declare const MAX_ISSUER_WORKFLOW_REF_LENGTH: 255;
export declare const MAX_ISSUER_REQUESTER_LENGTH: 160;
export interface IssuerDiagnostic {
    readonly version: IssuerAuthorityContractVersion;
    readonly code: IssuerDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
export interface IssuerDiagnosticReport {
    readonly version: IssuerAuthorityContractVersion;
    readonly diagnostics: readonly IssuerDiagnostic[];
}
export interface IssuerValidationResult<T> {
    readonly valid: boolean;
    readonly value?: T;
    readonly diagnostics: readonly IssuerDiagnostic[];
}
export interface IssuerRepositoryIdentity {
    /** GitHub host is part of the installation boundary. */
    readonly repositoryHost: string;
    /** Decimal REST repository database ID; owner/name alone is not authority. */
    readonly repositoryId: string;
    /** Human-readable locator retained alongside the immutable repository ID. */
    readonly nameWithOwner: string;
}
export interface InariIssuerAppIdentity {
    readonly kind: typeof INARI_ISSUER_APP_KIND;
    readonly slug: typeof INARI_ISSUER_APP_SLUG;
    readonly appId: string;
    readonly principal: typeof INARI_ISSUER_PRINCIPAL;
}
export interface IssuerInstallationIdentity {
    readonly appId: string;
    readonly installationId: string;
    readonly repositoryHost: string;
}
/**
 * Scope evidence returned by the trusted broker. It identifies the selected
 * repository and permissions of the short-lived credential, but never carries
 * the credential value itself.
 */
export interface IssuerInstallationScope {
    readonly app: InariIssuerAppIdentity;
    readonly installation: IssuerInstallationIdentity;
    readonly repository: IssuerRepositoryIdentity;
    readonly repositorySelection: "selected";
    readonly permissions: IssuerPermissionSet;
    readonly expiresAt: string;
}
export interface TrustedExecutionContext {
    readonly version: IssuerAuthorityContractVersion;
    readonly runtime: typeof TRUSTED_EXECUTION_RUNTIME;
    readonly event: TrustedExecutionEvent;
    readonly repository: IssuerRepositoryIdentity;
    /** Ref that supplied the protected workflow and trusted executable code. */
    readonly workflowRef: string;
    /** Immutable workflow commit identity used by the trusted runtime. */
    readonly workflowSha: string;
    /** Set only after repository protection has established this workflow path. */
    readonly workflowTrust: "protected";
    /** No caller-controlled repository code is executed for issuer operations. */
    readonly codeExecution: "trusted-only";
    readonly fork: false;
    readonly pullRequest: false;
    /** Optional requester identity; it is provenance, never a credential. */
    readonly requester?: string;
}
export interface IssuerMutationRequest {
    readonly version: IssuerAuthorityContractVersion;
    /** Structural role marker; reviewer/approval is not accepted here. */
    readonly authority: "issuer";
    readonly execution: TrustedExecutionContext;
    readonly target: IssuerRepositoryIdentity;
    readonly effects: readonly ChangeEffect[];
}
export interface ValidatedIssuerMutationRequest extends IssuerMutationRequest {
    readonly permissions: IssuerPermissionSet;
}
export interface IssuerCredentialRequest {
    readonly version: IssuerAuthorityContractVersion;
    readonly authority: "issuer";
    readonly app: InariIssuerAppIdentity;
    readonly execution: TrustedExecutionContext;
    readonly target: IssuerRepositoryIdentity;
    readonly permissions: IssuerPermissionSet;
}
/** The only mutation surface exposed while the broker holds an App token. */
export interface IssuerScopedMutationCapability {
    readonly scope: IssuerInstallationScope;
    /** Applies one already-authorized ChangeEffect; returns no credential data. */
    readonly apply: (effect: ChangeEffect) => Promise<void>;
}
/**
 * Implemented by trusted execution (for example, the future #218 executor).
 * The implementation obtains a fresh installation credential, wraps it in a
 * scoped mutation client, invokes `operation`, and discards the credential.
 * It must never return or include the token/private key in errors or results.
 */
export interface TrustedInstallationCredentialBroker {
    withScopedInstallationCredential(request: IssuerCredentialRequest, operation: (capability: IssuerScopedMutationCapability) => Promise<void>): Promise<void>;
}
export interface IssuerMutationReceipt {
    readonly kind: ChangeEffectKind;
    readonly status: "applied";
}
export interface IssuerMutationResult {
    readonly version: IssuerAuthorityContractVersion;
    readonly authority: "issuer";
    readonly issuer: InariIssuerAppIdentity;
    readonly repository: IssuerRepositoryIdentity;
    readonly installation: IssuerInstallationIdentity;
    readonly permissions: IssuerPermissionSet;
    readonly effects: readonly IssuerMutationReceipt[];
}
export interface IssuerInstallationScopeValidationOptions {
    readonly app?: InariIssuerAppIdentity;
    readonly target?: IssuerRepositoryIdentity;
    readonly requiredPermissions?: IssuerPermissionSet;
    readonly now?: Date;
}
export interface InariIssuerAppAuthorityOptions {
    /** Numeric GitHub App identity is deployment configuration, not caller input. */
    readonly appId: string;
    /** Trusted runtime broker; no default local credential source exists. */
    readonly broker: TrustedInstallationCredentialBroker;
    readonly now?: () => Date;
}
export declare function validateIssuerRepositoryIdentity(input: unknown, path?: string): IssuerValidationResult<IssuerRepositoryIdentity>;
export declare function createInariIssuerAppIdentity(appId: string): InariIssuerAppIdentity;
export declare function validateInariIssuerAppIdentity(input: unknown, path?: string): IssuerValidationResult<InariIssuerAppIdentity>;
export declare function validateTrustedExecutionContext(input: unknown, path?: string): IssuerValidationResult<TrustedExecutionContext>;
export declare const assertTrustedExecution: (input: unknown) => TrustedExecutionContext;
/** Derive only the permissions declared by an explicit initial effect list. */
export declare function requiredPermissionsForEffects(input: unknown): IssuerPermissionSet;
export declare function validateIssuerMutationRequest(input: unknown): IssuerValidationResult<ValidatedIssuerMutationRequest>;
export declare function validateIssuerInstallationScope(input: unknown, options?: IssuerInstallationScopeValidationOptions): IssuerValidationResult<IssuerInstallationScope>;
/**
 * Mutation authority for the Inari App. The class contains no semantic
 * transition or branch policy; it only authenticates a trusted capability and
 * applies the explicitly supplied Core effects through a scoped channel.
 */
export declare class InariIssuerAppAuthority {
    #private;
    readonly identity: InariIssuerAppIdentity;
    constructor(options: InariIssuerAppAuthorityOptions);
    applyEffects(input: unknown): Promise<IssuerMutationResult>;
    /** Alias for trusted executor integrations; it does not add semantic policy. */
    apply(input: unknown): Promise<IssuerMutationResult>;
}
export declare const IssuerAppAuthority: typeof InariIssuerAppAuthority;
export declare class IssuerAuthorityError extends Error {
    readonly code: IssuerDiagnosticCode;
    readonly path: string;
    readonly diagnostics: readonly IssuerDiagnostic[];
    constructor(diagnostics: readonly IssuerDiagnostic[]);
}
export declare function createIssuerDiagnosticReport(diagnostics: readonly IssuerDiagnostic[]): IssuerDiagnosticReport;
