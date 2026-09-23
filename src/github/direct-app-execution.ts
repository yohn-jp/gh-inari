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
import {
  GitHubAppUserCredentialBroker,
  type GitHubAppUserCredentialBrokerOptions,
} from "./app-user-credential-broker.js";
import type { AppProviderCredentialBroker } from "./app-provider-credential-broker.js";
import { createAppRepositoryEvidenceReader } from "./app-repository-evidence-reader.js";
import { resolveDelegator } from "../agent-authority/delegator-trust.js";
import { GitHubChangeStateProjector } from "./change-state-projector.js";
import {
  InariEffectAuthorizer,
  type DirectAppTrustedExecutionContext,
  type RepositoryIdentity,
  type SessionTrustedExecutionContext,
} from "./effect-authorizer.js";
import type { GitHubChangeEffectRepository, GitHubChangeProvenanceSignerOptions } from "./change-effect-adapter.js";
import { validateChangeProvenanceRecord, verifyChangeProvenanceRecord } from "../change-provenance-record.js";
import { TrustedChangeExecutor } from "../change-trusted-executor.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import {
  publishPullRequest,
  type PrPublicationCreateInput,
  type PrPublicationListQuery,
  type PrPublicationProvider,
  type PrPublicationRecord,
  type PrPublicationRepositoryIdentity,
} from "../pr-publication.js";
import {
  createCapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedChangeExecutorFactoryInput,
  type CapabilityAuthorizedChangeExecutorFactoryResult,
  type CapabilityAuthorizedSessionExecutor,
} from "../session-authorized-change-executor.js";
import { executeBranchAdvanceEffects } from "../agent-authority/branch-advance.js";
import type { ImplementationAuthorizationVerificationInput } from "../implementation-authorization.js";
import {
  changeReadRequest,
  type ChangeExecutionResult,
  type ChangeExecutionPort,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "../change-execution-port.js";
import { publishRuntimeAuthority, type RuntimeAuthorityPublicationResult } from "../runtime-authority-publication.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Provider response invalid.");
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 1_048_576 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Provider response invalid.");
  }
  return value;
}

function positiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Provider response invalid.");
  }
  return value;
}

function optionalSha(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) throw new Error("Provider response invalid.");
  return value.toLowerCase();
}

function publicationRecord(value: unknown, repository: PrPublicationRepositoryIdentity): PrPublicationRecord {
  const candidate = record(value);
  const head = record(candidate.head);
  const base = record(candidate.base);
  return {
    number: positiveNumber(candidate.number),
    url: boundedText(candidate.html_url ?? candidate.url),
    title: boundedText(candidate.title),
    body: candidate.body === null ? null : boundedText(candidate.body, true),
    head: boundedText(head.ref),
    base: boundedText(base.ref),
    ...(optionalSha(head.sha) === undefined ? {} : { headRevision: optionalSha(head.sha) }),
    repository,
    ...(candidate.draft === undefined ? {} : { draft: candidate.draft === true }),
  };
}

function publicationRepositoryPath(repository: { readonly nameWithOwner: string }): string {
  return `repos/${repository.nameWithOwner}`;
}

function publicationRepositoryMatches(
  left: PrPublicationRepositoryIdentity,
  right: { readonly repositoryHost: string; readonly repositoryId: string },
): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() && left.repositoryId === right.repositoryId
  );
}

/**
 * Canonical GitHub App adapter for governed PR publication. Local Executor
 * composition and direct-App compatibility share this provider/effect seam.
 */
export function createPrPublicationProvider(input: {
  readonly broker: AppProviderCredentialBroker;
  readonly authorizer: InariEffectAuthorizer;
  readonly execution: SessionTrustedExecutionContext;
  readonly target: RepositoryIdentity;
}): PrPublicationProvider {
  const { broker, authorizer, execution, target } = input;
  const identity = (scope: GitHubAppRepositoryReadCapability["scope"]): PrPublicationRepositoryIdentity => ({
    repositoryHost: scope.repository.repositoryHost,
    repositoryId: scope.repository.repositoryId,
    repository: scope.repository.nameWithOwner,
  });
  const read = async (path: string): Promise<{ readonly body?: unknown; readonly status: number }> =>
    broker.withRepositoryReadCapability({}, async (capability) =>
      capability.transport.request({
        hostname: capability.scope.repository.repositoryHost,
        method: "GET",
        path,
      }),
    );
  const list = async (query: PrPublicationListQuery): Promise<readonly PrPublicationRecord[]> => {
    if (!publicationRepositoryMatches(query.repository, target)) throw new Error("Publication repository mismatch.");
    const owner = target.nameWithOwner.split("/", 1)[0];
    const path =
      `${publicationRepositoryPath(target)}/pulls?head=${encodeURIComponent(`${owner}:${query.head}`)}` +
      `&base=${encodeURIComponent(query.base)}&state=all&per_page=100`;
    const response = await read(path);
    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.body)) {
      throw new Error("Pull-request list failed.");
    }
    const repository = query.repository;
    return response.body.map((entry) => publicationRecord(entry, repository));
  };
  const readOne = async (number: number): Promise<PrPublicationRecord> => {
    const response = await read(`${publicationRepositoryPath(target)}/pulls/${number}`);
    if (response.status < 200 || response.status >= 300) throw new Error("Pull-request read failed.");
    return publicationRecord(response.body, {
      repositoryHost: target.repositoryHost,
      repositoryId: target.repositoryId,
      repository: target.nameWithOwner,
    });
  };
  return {
    getRepositoryIdentity: async () =>
      broker.withRepositoryReadCapability({}, async (capability) => identity(capability.scope)),
    listPullRequests: list,
    readPullRequest: readOne,
    createPullRequest: async (input: PrPublicationCreateInput) => {
      if (!publicationRepositoryMatches(input.repository, target)) throw new Error("Publication repository mismatch.");
      const result = await authorizer.applyEffects({
        version: 1,
        authority: "issuer",
        execution,
        target,
        effects: [
          {
            kind: "CREATE_PULL_REQUEST",
            branch: input.head,
            baseBranch: input.base,
            rootIssue: input.workIdentity.implementation.number,
            title: input.title,
            body: input.body,
            draft: true,
          },
        ],
      });
      const evidence = result.effects[0]?.evidence;
      if (evidence === undefined || evidence.kind !== "CREATE_PULL_REQUEST") {
        throw new Error("Pull-request creation evidence is unavailable.");
      }
      return readOne(evidence.pullRequest);
    },
  };
}

/** Deployment configuration for one stateless direct-App Session executor. */
export interface DirectAppSessionExecutorConfig {
  /** GitHub App numeric identity. Worker secret; never caller input. */
  readonly appId: string;
  /** GitHub App installation identity. Non-secret deployment configuration. */
  readonly installationId?: string;
  /** GitHub App private key (PEM). Worker secret; never caller input. */
  readonly privateKeyPem?: string;
  /** Fixed target repository locator. Non-secret deployment configuration. */
  readonly repository: GitHubChangeEffectRepository;
  readonly repositoryNodeId?: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** Bounded deadline applied to every GitHub provider request. Defaults to 10s; hard ceiling 30s. */
  readonly requestTimeoutMs?: number;
  /** Current repository-verified Implementation evidence for bound Sessions. */
  readonly implementationAuthorization?: ImplementationAuthorizationVerificationInput;
  /** Injected provider broker, primarily for a Runtime-owned App credential. */
  readonly credentialBroker?: AppProviderCredentialBroker;
  /** Local App-user broker configuration; no App private key is accepted. */
  readonly appUser?: Omit<GitHubAppUserCredentialBrokerOptions, "appId" | "repository"> & {
    readonly appId?: string;
    readonly repository?: GitHubChangeEffectRepository;
  };
}

function isMutationRequest(request: ChangeReadRequest | ChangeMutationRequest): request is ChangeMutationRequest {
  return request.operation !== "show";
}

function buildReader(
  capability: GitHubAppRepositoryReadCapability,
  config: DirectAppSessionExecutorConfig,
  identity: RepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
): GitHubChangeStateProjector {
  const [owner, name] = capability.scope.repository.nameWithOwner.split("/");
  const repository = { hostname: capability.scope.repository.repositoryHost, owner, name };
  return new GitHubChangeStateProjector({
    repository,
    identity: {
      repositoryHost: identity.repositoryHost,
      repositoryId: identity.repositoryId,
      rootIssue: request.issue,
    },
    transport: capability.transport,
    providerPrincipal: capability.providerPrincipal,
    remoteGovernance: createAppRepositoryEvidenceReader(capability, repository, identity),
    ...(isMutationRequest(request) && request.semanticPullRequestPlan !== undefined
      ? { semanticPullRequestPlan: request.semanticPullRequestPlan }
      : {}),
  });
}

async function projectChangeFromCapability(
  capability: GitHubAppRepositoryReadCapability,
  config: DirectAppSessionExecutorConfig,
  identity: RepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
): Promise<ChangeProjectionResult> {
  const reader = buildReader(capability, config, identity, request);
  return projectChangeFromGitHubEvidence(await reader.read(request));
}

async function readChangeProjection(
  broker: AppProviderCredentialBroker,
  config: DirectAppSessionExecutorConfig,
  identity: RepositoryIdentity,
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
  const installationOptions: GitHubAppInstallationCredentialBrokerOptions | undefined =
    config.appUser === undefined && config.credentialBroker === undefined
      ? config.privateKeyPem === undefined || config.installationId === undefined
        ? undefined
        : {
            appId: config.appId,
            installationId: config.installationId,
            privateKeyPem: config.privateKeyPem,
            repository: config.repository,
            ...(config.repositoryNodeId === undefined ? {} : { repositoryNodeId: config.repositoryNodeId }),
            ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
            ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
            ...(config.now === undefined ? {} : { now: config.now }),
            ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
          }
      : undefined;
  const createBroker = (provenance?: GitHubChangeProvenanceSignerOptions): AppProviderCredentialBroker => {
    if (config.credentialBroker !== undefined) return config.credentialBroker;
    if (config.appUser !== undefined) {
      const appUserOptions: GitHubAppUserCredentialBrokerOptions = {
        ...config.appUser,
        appId: config.appUser.appId ?? config.appId,
        repository: config.appUser.repository ?? config.repository,
        ...(config.repositoryNodeId === undefined ? {} : { repositoryNodeId: config.repositoryNodeId }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        ...(config.now === undefined ? {} : { now: config.now }),
        ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
        ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
        ...(provenance === undefined ? {} : { provenance }),
      };
      return new GitHubAppUserCredentialBroker(appUserOptions);
    }
    if (installationOptions === undefined) throw new Error("Direct App credential broker configuration is required.");
    return new GitHubAppInstallationCredentialBroker({
      ...installationOptions,
      ...(provenance === undefined ? {} : { provenance }),
    });
  };
  const broker = createBroker();
  let establishedApp: CapabilityAuthorizedChangeExecutorFactoryResult["app"];

  return createCapabilityAuthorizedSessionExecutor({
    authentication: {
      broker,
      repository: config.repository,
      ...(config.implementationAuthorization === undefined
        ? {}
        : { implementationAuthorization: config.implementationAuthorization }),
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
    reviewEvidenceReader: ({ issue, pullRequest }) =>
      broker.withRepositoryReadCapability({}, async (capability) => {
        establishedApp = Object.freeze({
          ...capability.scope.app,
          installationId: capability.scope.installation.installationId,
        });
        const reader = buildReader(capability, config, capability.scope.repository, changeReadRequest(issue));
        return reader.readOperationalPullRequestEvidence(pullRequest);
      }),
    createChangeExecutor: async (
      input: CapabilityAuthorizedChangeExecutorFactoryInput,
    ): Promise<CapabilityAuthorizedChangeExecutorFactoryResult> => {
      const target = input.context.repository;
      let executionBroker = broker;
      if (input.request.operation === "issue") {
        if (input.request.signedProvenanceRecord === undefined) {
          throw new Error("A caller-produced Delegator signed provenance record is required.");
        }
        const validation = validateChangeProvenanceRecord(input.request.signedProvenanceRecord);
        if (!validation.valid || validation.record === undefined) {
          throw new Error("The Delegator signed provenance record is invalid.");
        }
        const signedProvenanceRecord = validation.record;
        const provenance = await broker.withRepositoryReadCapability({}, async (capability) => {
          const runtimeReader = createAppRepositoryEvidenceReader(capability, config.repository, target);
          const loaded = await resolveDelegator(runtimeReader, signedProvenanceRecord.signature.kid, {
            ...(config.now === undefined ? {} : { now: config.now() }),
          });
          // The App/executor never imports or holds the Runtime private key.
          // It only verifies the already-signed record against the
          // repository-trusted Runtime public key.
          const payload = verifyChangeProvenanceRecord(signedProvenanceRecord, loaded.authority);
          if (payload.rootIssue !== input.request.issue || payload.operation !== "change.issue") {
            throw new Error("The Delegator signed provenance record does not match the Change request.");
          }
          const signer: GitHubChangeProvenanceSignerOptions = {
            runtimeAuthority: loaded.authority,
            signedRecord: signedProvenanceRecord,
          };
          return signer;
        });
        executionBroker = createBroker(provenance);
      }
      const effectAuthorizer = new InariEffectAuthorizer({
        appId: config.appId,
        broker: executionBroker,
        ...(config.now === undefined ? {} : { now: config.now }),
      });
      const executor: ChangeExecutionPort = {
        read: (request) => readChangeProjection(executionBroker, config, target, request),
        execute: async (request): Promise<ChangeProjectionResult | ChangeExecutionResult> =>
          request.operation === "merge"
            ? executionBroker.withSemanticPullRequestMutationExecutor({ target }, async (semanticExecutor) =>
                executionBroker.withRepositoryReadCapability({}, async (capability) => {
                  const reader = buildReader(capability, config, target, request);
                  const trustedExecutor = new TrustedChangeExecutor({
                    reader,
                    effectAuthorizer,
                    execution: input.execution,
                    target,
                    semanticPullRequestMutationExecutor: semanticExecutor,
                  });
                  return trustedExecutor.execute(request);
                }),
              )
            : executionBroker.withRepositoryReadCapability({}, async (capability) => {
                const reader = buildReader(capability, config, target, request);
                const trustedExecutor = new TrustedChangeExecutor({
                  reader,
                  effectAuthorizer,
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
    publishPullRequest: async (input) => {
      const target = input.context.repository;
      const authorizer = new InariEffectAuthorizer({
        appId: config.appId,
        broker,
        ...(config.now === undefined ? {} : { now: config.now }),
      });
      const publication = await publishPullRequest(
        input.request,
        createPrPublicationProvider({ broker, authorizer, execution: input.execution, target }),
      );
      return { publication, ...(establishedApp === undefined ? {} : { app: establishedApp }) };
    },
    branchAdvance: (input) =>
      executeBranchAdvanceEffects({
        repository: input.context.repository,
        provenance: input.provenance,
        broker,
        request: input.request,
        authorization: input.branchAuthorization,
        ...(config.now === undefined ? {} : { now: config.now }),
      }),
  });
}

/**
 * Deployment configuration for the stateless direct-App Runtime Authority
 * publisher (#1066 correction). Unlike `DirectAppSessionExecutorConfig`, this
 * composition never accepts an App-user broker, Session provenance, or
 * caller-supplied target repository: bootstrap publication precedes any
 * established Runtime Authority, so there is no Session to authorize it, and
 * the target repository is fixed deployment configuration exactly like
 * #468's Worker deployment profile.
 */
export interface DirectAppRuntimeAuthorityPublisherConfig {
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
  /** Test/composition seam; production always mints a fresh #464 installation broker from the fields above. */
  readonly credentialBroker?: Pick<
    GitHubAppInstallationCredentialBroker,
    "withRepositoryReadCapability" | "withRuntimeAuthorityPublicationCapability"
  >;
}

/** Publishes only the validated public Runtime Authority record; never accepts private-key material. */
export interface DirectAppRuntimeAuthorityPublisher {
  publish(request: unknown): Promise<RuntimeAuthorityPublicationResult>;
}

/**
 * Build the centrally custodied Runtime Authority publisher (#1066) for one
 * fixed target repository. The caller supplies only the validated public
 * Runtime Authority request/artifact; this composition owns the bounded
 * mutation -- centrally custodied Issuer installation credential, dedicated
 * branch, exactly one public Authority artifact commit, governed PR -- and
 * never merges or approves the PR it opens.
 */
export function createDirectAppRuntimeAuthorityPublisher(
  config: DirectAppRuntimeAuthorityPublisherConfig,
): DirectAppRuntimeAuthorityPublisher {
  const broker =
    config.credentialBroker ??
    new GitHubAppInstallationCredentialBroker({
      appId: config.appId,
      installationId: config.installationId,
      privateKeyPem: config.privateKeyPem,
      repository: config.repository,
      ...(config.repositoryNodeId === undefined ? {} : { repositoryNodeId: config.repositoryNodeId }),
      ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      ...(config.now === undefined ? {} : { now: config.now }),
      ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
    });
  return Object.freeze({
    publish: async (request: unknown): Promise<RuntimeAuthorityPublicationResult> => {
      const target = await broker.withRepositoryReadCapability({}, async (capability) => capability.scope.repository);
      return publishRuntimeAuthority(request, target, broker);
    },
  });
}
