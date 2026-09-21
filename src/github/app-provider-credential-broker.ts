/**
 * The narrow provider-credential port consumed by direct App execution.
 *
 * Installation-token and App-user credential brokers both implement this
 * contract.  The port deliberately contains only bounded capability
 * callbacks; bearer credentials and general GitHub clients never cross it.
 */

import type { GitHubAppRepositoryReadCapability } from "./app-installation-credential-broker.js";
import type { GitHubAppRepositoryReadPermissionSet } from "./app-installation-credential-broker.js";
import type { GitHubBranchAdvanceCapability } from "./git-data-capability.js";
import type { AppScopedMutationCapability, EffectAuthorizerCredentialRequest } from "./effect-authorizer.js";
import type { SemanticPullRequestMutationExecutionPort } from "../semantic-pr-mutation.js";
import type { RepositoryIdentity } from "./effect-authorizer.js";

/** Shared credential-bound capability surface for direct Session/App execution. */
export interface AppProviderCredentialBroker {
  withRepositoryReadCapability<T>(
    request: { readonly permissions?: GitHubAppRepositoryReadPermissionSet },
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T>;

  withScopedInstallationCredential(
    request: EffectAuthorizerCredentialRequest,
    operation: (capability: AppScopedMutationCapability) => Promise<void>,
  ): Promise<void>;

  withSemanticPullRequestMutationExecutor<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (executor: SemanticPullRequestMutationExecutionPort) => Promise<T>,
  ): Promise<T>;

  withBranchAdvanceCapability<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (capability: GitHubBranchAdvanceCapability) => Promise<T>,
  ): Promise<T>;
}

/** Compatibility alias for callers that name the implementation boundary. */
export type GitHubAppProviderCredentialBroker = AppProviderCredentialBroker;
