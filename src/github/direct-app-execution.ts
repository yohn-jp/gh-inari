/**
 * Deployment-agnostic composition of the frozen #465 Session-authorized
 * Change execution boundary over the #464 GitHub App installation credential
 * broker.
 *
 * This module owns wiring only: it constructs the existing #464 broker, the
 * existing #464-backed repository evidence reader (#377/#468 acquisition
 * adapter), and the existing Change Core execution/branch-advance
 * authorities, then hands the result to the existing frozen #465 executor
 * factory. It adds no Change semantics, governance policy, or transport
 * authority of its own -- the same contract #468's Worker entrypoint and any
 * other stateless direct-App host can reuse without duplicating it.
 */

import {
  GitHubAppInstallationCredentialBroker,
  type GitHubAppInstallationCredentialBrokerOptions,
  type GitHubAppRepositoryReadCapability,
} from "./app-installation-credential-broker.js";
import { createAppRepositoryEvidenceReader } from "./app-repository-evidence-reader.js";
import { GitHubActionsEvidenceReader } from "./actions-change-executor.js";
import { InariIssuerAppAuthority, type IssuerRepositoryIdentity } from "./issuer-authority.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";
import { TrustedChangeExecutor } from "../change-trusted-executor.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import {
  createCapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedChangeExecutorFactoryInput,
  type CapabilityAuthorizedChangeExecutorFactoryResult,
  type CapabilityAuthorizedSessionExecutor,
} from "../session-authorized-change-executor.js";
import { executeBranchAdvance } from "../agent-authority/branch-advance.js";
import type {
  ChangeRemoteExecutionResult,
  ChangeRemoteExecutor,
  ChangeRemoteMutationRequest,
  ChangeRemoteReadRequest,
} from "../change-executor.js";

/** Deployment configuration for one stateless direct-App Session executor. */
export interface DirectAppSessionExecutorConfig {
  /** GitHub App numeric identity. Worker secret; never caller input. */
  readonly appId: string;
  /** GitHub App installation identity. Non-secret deployment configuration. */
  readonly installationId: string;
  /** GitHub App private key (PEM). Worker secret; never caller input. */
  readonly privateKeyPem: string;
  /** Fixed target repository locator. Non-secret deployment configuration. */
  readonly repository: GitHubChangeEffectRepository;
  readonly repositoryNodeId?: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

function isMutationRequest(
  request: ChangeRemoteReadRequest | ChangeRemoteMutationRequest,
): request is ChangeRemoteMutationRequest {
  return request.operation !== "show";
}

function buildReader(
  capability: GitHubAppRepositoryReadCapability,
  config: DirectAppSessionExecutorConfig,
  identity: IssuerRepositoryIdentity,
  request: ChangeRemoteReadRequest | ChangeRemoteMutationRequest,
): GitHubActionsEvidenceReader {
  return new GitHubActionsEvidenceReader({
    repository: config.repository,
    identity: {
      repositoryHost: identity.repositoryHost,
      repositoryId: identity.repositoryId,
      rootIssue: request.issue,
    },
    transport: capability.transport,
    remoteGovernance: createAppRepositoryEvidenceReader(capability, config.repository, identity),
    ...(isMutationRequest(request) && request.semanticPullRequestPlan !== undefined
      ? { semanticPullRequestPlan: request.semanticPullRequestPlan }
      : {}),
  });
}

async function readChangeProjection(
  broker: GitHubAppInstallationCredentialBroker,
  config: DirectAppSessionExecutorConfig,
  identity: IssuerRepositoryIdentity,
  request: ChangeRemoteReadRequest | ChangeRemoteMutationRequest,
): Promise<ChangeProjectionResult> {
  return broker.withRepositoryReadCapability({}, async (capability) => {
    const reader = buildReader(capability, config, identity, request);
    return projectChangeFromGitHubEvidence(await reader.read(request));
  });
}

/**
 * Build one #465 `CapabilityAuthorizedSessionExecutor` wired entirely to the
 * existing #464 broker, #466 branch advance, and Change Core authorities for
 * the fixed repository named by `config`. The returned executor supports all
 * five frozen Epic #463 V1 operations: `change.issue`, `change.show`,
 * `change.ready`, `change.abort`, and `branch.advance`.
 */
export function createDirectAppSessionExecutor(
  config: DirectAppSessionExecutorConfig,
): CapabilityAuthorizedSessionExecutor {
  const brokerOptions: GitHubAppInstallationCredentialBrokerOptions = {
    appId: config.appId,
    installationId: config.installationId,
    privateKeyPem: config.privateKeyPem,
    repository: config.repository,
    ...(config.repositoryNodeId === undefined ? {} : { repositoryNodeId: config.repositoryNodeId }),
    ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.now === undefined ? {} : { now: config.now }),
  };
  const broker = new GitHubAppInstallationCredentialBroker(brokerOptions);

  return createCapabilityAuthorizedSessionExecutor({
    authentication: {
      broker,
      repository: config.repository,
      ...(config.now === undefined ? {} : { now: config.now }),
    },
    readExecutor: {
      read: async (request) =>
        broker.withRepositoryReadCapability({}, async (capability) => {
          const scope = capability.scope.repository;
          return readChangeProjection(broker, config, scope, request);
        }),
    },
    createChangeExecutor: async (
      input: CapabilityAuthorizedChangeExecutorFactoryInput,
    ): Promise<CapabilityAuthorizedChangeExecutorFactoryResult> => {
      const target = input.context.repository;
      const issuerAuthority = new InariIssuerAppAuthority({ appId: config.appId, broker });
      const executor: ChangeRemoteExecutor = {
        read: (request) => readChangeProjection(broker, config, target, request),
        execute: async (request): Promise<ChangeProjectionResult | ChangeRemoteExecutionResult> =>
          broker.withRepositoryReadCapability({}, async (capability) => {
            const reader = buildReader(capability, config, target, request);
            const trustedExecutor = new TrustedChangeExecutor({
              reader,
              issuerAuthority,
              execution: input.execution,
              target,
            });
            return trustedExecutor.execute(request);
          }),
      };
      return { executor };
    },
    branchAdvance: (input) =>
      executeBranchAdvance({
        context: input.context,
        broker,
        admission: input.admission,
        request: input.envelope,
        ...(config.now === undefined ? {} : { now: config.now }),
      }),
  });
}
