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
import { resolveRuntimeAuthority } from "../agent-authority/runtime-authority-trust.js";
import { GitHubChangeStateProjector } from "./change-state-projector.js";
import { InariIssuerAppAuthority, type IssuerRepositoryIdentity } from "./issuer-authority.js";
import type { GitHubChangeEffectRepository, GitHubChangeProvenanceSignerOptions } from "./change-effect-adapter.js";
import { validateChangeProvenanceRecord, verifyChangeProvenanceRecord } from "../change-provenance-record.js";
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
  ChangeExecutionResult,
  ChangeExecutionPort,
  ChangeMutationRequest,
  ChangeReadRequest,
} from "../change-execution-port.js";

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
  /** Bounded deadline applied to every GitHub provider request. Defaults to 10s; hard ceiling 30s. */
  readonly requestTimeoutMs?: number;
}

function isMutationRequest(request: ChangeReadRequest | ChangeMutationRequest): request is ChangeMutationRequest {
  return request.operation !== "show";
}

function buildReader(
  capability: GitHubAppRepositoryReadCapability,
  config: DirectAppSessionExecutorConfig,
  identity: IssuerRepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
): GitHubChangeStateProjector {
  return new GitHubChangeStateProjector({
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

async function projectChangeFromCapability(
  capability: GitHubAppRepositoryReadCapability,
  config: DirectAppSessionExecutorConfig,
  identity: IssuerRepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
): Promise<ChangeProjectionResult> {
  const reader = buildReader(capability, config, identity, request);
  return projectChangeFromGitHubEvidence(await reader.read(request));
}

async function readChangeProjection(
  broker: GitHubAppInstallationCredentialBroker,
  config: DirectAppSessionExecutorConfig,
  identity: IssuerRepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
): Promise<ChangeProjectionResult> {
  return broker.withRepositoryReadCapability({}, async (capability) => {
    return projectChangeFromCapability(capability, config, identity, request);
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
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
  };
  const broker = new GitHubAppInstallationCredentialBroker(brokerOptions);
  let establishedApp: CapabilityAuthorizedChangeExecutorFactoryResult["app"];

  return createCapabilityAuthorizedSessionExecutor({
    authentication: {
      broker,
      repository: config.repository,
      ...(config.now === undefined ? {} : { now: config.now }),
    },
    readExecutor: {
      read: async (request) =>
        broker.withRepositoryReadCapability({}, async (capability) => {
          establishedApp = Object.freeze({
            ...capability.scope.app,
            installationId: capability.scope.installation.installationId,
          });
          return projectChangeFromCapability(capability, config, capability.scope.repository, request);
        }),
    },
    createChangeExecutor: async (
      input: CapabilityAuthorizedChangeExecutorFactoryInput,
    ): Promise<CapabilityAuthorizedChangeExecutorFactoryResult> => {
      const target = input.context.repository;
      let executionBroker = broker;
      if (input.request.operation === "issue") {
        if (input.request.signedProvenanceRecord === undefined) {
          throw new Error("A caller-produced Runtime Authority signed provenance record is required.");
        }
        const validation = validateChangeProvenanceRecord(input.request.signedProvenanceRecord);
        if (!validation.valid || validation.record === undefined) {
          throw new Error("The Runtime Authority signed provenance record is invalid.");
        }
        const signedProvenanceRecord = validation.record;
        const provenance = await broker.withRepositoryReadCapability({}, async (capability) => {
          const runtimeReader = createAppRepositoryEvidenceReader(capability, config.repository, target);
          const loaded = await resolveRuntimeAuthority(runtimeReader, signedProvenanceRecord.signature.kid, {
            ...(config.now === undefined ? {} : { now: config.now() }),
          });
          // The App/executor never imports or holds the Runtime private key.
          // It only verifies the already-signed record against the
          // repository-trusted Runtime public key.
          const payload = verifyChangeProvenanceRecord(signedProvenanceRecord, loaded.authority);
          if (payload.rootIssue !== input.request.issue || payload.operation !== "change.issue") {
            throw new Error("The Runtime Authority signed provenance record does not match the Change request.");
          }
          const signer: GitHubChangeProvenanceSignerOptions = {
            runtimeAuthority: loaded.authority,
            signedRecord: signedProvenanceRecord,
          };
          return signer;
        });
        executionBroker = new GitHubAppInstallationCredentialBroker({
          ...brokerOptions,
          provenance,
        });
      }
      const issuerAuthority = new InariIssuerAppAuthority({
        appId: config.appId,
        broker: executionBroker,
        ...(config.now === undefined ? {} : { now: config.now }),
      });
      const executor: ChangeExecutionPort = {
        read: (request) => readChangeProjection(executionBroker, config, target, request),
        execute: async (request): Promise<ChangeProjectionResult | ChangeExecutionResult> =>
          executionBroker.withRepositoryReadCapability({}, async (capability) => {
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
      if (establishedApp === undefined) {
        throw new Error("The App installation identity was not established by the broker.");
      }
      return { executor, app: establishedApp };
    },
    branchAdvance: (input) =>
      executeBranchAdvance({
        context: input.context,
        broker,
        admission: input.admission,
        request: input.request,
        ...(config.now === undefined ? {} : { now: config.now }),
      }),
  });
}
