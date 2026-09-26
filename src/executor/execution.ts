// Private Executor module: the only code that reads and parses the Inari
// Issuer App private key, binds it to the profiled installation and
// repository, and performs authorized provider effects. App-user credentials
// and Authority signing custody are never loaded here.
import { createPrivateKey } from "node:crypto";
import {
  executeAuthorizedExecution,
  type AuthorizedExecution,
  type AuthorizedExecutionChangeFactoryResult,
  type AuthorizedExecutionDelegates,
  type AuthorizedExecutionResult,
} from "../authorized-execution.js";
import { executeBranchAdvanceEffects } from "../agent-authority/branch-advance.js";
import { projectChangeFromGitHubEvidence } from "../change.js";
import {
  changeReadRequest,
  type ChangeExecutionPort,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "../change-execution-port.js";
import { DelegatorTrustError, resolveDelegator } from "../agent-authority/delegator-trust.js";
import { validateChangeProvenanceRecord, verifyChangeProvenanceRecord } from "../change-provenance-record.js";
import { TrustedChangeExecutor } from "../change-trusted-executor.js";
import { GitHubAdapterCore as GitHubAdapter } from "../github/adapter-core.js";
import {
  GitHubAppInstallationCredentialBroker,
  type GitHubAppRepositoryReadCapability,
} from "../github/app-installation-credential-broker.js";
import { createAppRepositoryEvidenceReader } from "../github/app-repository-evidence-reader.js";
import type {
  GitHubChangeEffectRepository,
  GitHubChangeProvenanceSignerOptions,
} from "../github/change-effect-adapter.js";
import { GitHubChangeStateProjector } from "../github/change-state-projector.js";
import { createPrPublicationProvider } from "../github/pr-publication-provider.js";
import { InariEffectAuthorizer, type RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  createGitHubImplementationFrontierRepository,
  readCurrentImplementationAdmissionEvidence,
} from "../implementation-frontier-composition.js";
import { publishPullRequest } from "../pr-publication.js";
import { acquireRepositoryBranchPolicy, compileRepositoryGovernedContract } from "../governance.js";
import { parseImplementationIssueBody } from "../implementation-contract.js";
import { LocalRuntimeProfileStore } from "../local-runtime-profile.js";
import { LocalRuntimeConfigError, readAppPrivateKey } from "../relay/local-runtime-config-credentials.js";
import type { LocalExecutorEvidenceRequest } from "../local-control/executor-http.js";
import { ExecutorAppCredentialStore, issuerKeyFingerprint, type StoredAppCredential } from "./credential-store.js";
import {
  ExecutorRepositoryBindingStore,
  repositoryBindingState,
  type ExecutorRepositoryBinding,
} from "./repository-binding-store.js";
import { LocalExecutorError } from "./errors.js";
import { issuerKeyMissing, issuerKeyReference, requireLocalExecutorAppId } from "./issuer-input.js";

function issuerKeyInvalid(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_ISSUER_KEY_INVALID",
    "The Inari Issuer App private key referenced by INARI_GITHUB_APP_PRIVATE_KEY_FILE is not a readable RSA private key.",
  );
}

/**
 * Executor credential boundary: read and validate the Inari Issuer App
 * private key. Only the running Executor (serve and authorized execution)
 * calls this; the key is held in process memory and never written to
 * Executor configuration, Runtime profiles, or any diagnostic.
 */
function issuerPrivateKey(environment: NodeJS.ProcessEnv): string {
  let pem: string;
  try {
    pem = readAppPrivateKey(issuerKeyReference(environment));
  } catch (error: unknown) {
    if (error instanceof LocalRuntimeConfigError && error.code === "LOCAL_RUNTIME_CONFIG_MISSING") {
      throw issuerKeyMissing();
    }
    throw issuerKeyInvalid();
  }
  try {
    if (createPrivateKey(pem).asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    throw issuerKeyInvalid();
  }
  return pem;
}

/**
 * Executor startup credential check: the App ID and a readable RSA Issuer
 * private key must be present before the Executor listens. The key is not
 * returned or retained by the caller.
 */
export function requireLocalExecutorIssuerCredential(environment: NodeJS.ProcessEnv): void {
  requireLocalExecutorAppId(environment);
  issuerPrivateKey(environment);
}

function providerRepository(identity: RepositoryIdentity): GitHubChangeEffectRepository {
  const parts = identity.nameWithOwner.split("/");
  if (parts.length !== 2) throw new Error("Authorized repository locator is invalid.");
  return { hostname: identity.repositoryHost, owner: parts[0] as string, name: parts[1] as string };
}

/**
 * Executor-owned Issuer App installation authority for one repository. The
 * private key stays captured in `broker`; this value carries no secret field.
 */
interface LocalExecutorIssuerBinding {
  readonly repository: RepositoryIdentity;
  readonly appId: string;
  readonly broker: (provenance?: GitHubChangeProvenanceSignerOptions) => GitHubAppInstallationCredentialBroker;
}

function issuerBindingMismatch(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_ISSUER_BINDING_MISMATCH",
    "The Inari Issuer App, installation, or repository does not match the setup binding for this repository.",
  );
}

function sameLocator(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Bind the Issuer App installation credential for one repository (#1182).
 *
 * The Executor's own repository binding (#1199) records the App, installation
 * and exact verified App credential generation the repository acts through;
 * `inari setup next` (executor.bind-repository) writes it through the Executor
 * owner. A binding whose generation is no longer the App's current verified
 * generation is stale and never satisfies execution. A legacy Local Runtime profile written by
 * `inari setup --endpoint` remains a binding source. When both exist they must
 * name the same App, installation and repository; a contradiction or a
 * half-migrated state is a bounded failure, never a silent preference. The App
 * ID and private key are Executor-owned inputs.
 */
async function localExecutorIssuerBinding(
  repository: { readonly repositoryHost: string; readonly nameWithOwner: string; readonly repositoryId?: string },
  environment: NodeJS.ProcessEnv,
): Promise<LocalExecutorIssuerBinding> {
  const configuredAppId = requireLocalExecutorAppId(environment);
  const privateKeyPem = issuerPrivateKey(environment);
  let bound: ExecutorRepositoryBinding | undefined;
  let credential: StoredAppCredential | undefined;
  let profile: Awaited<ReturnType<LocalRuntimeProfileStore["findForRepository"]>>;
  try {
    bound = new ExecutorRepositoryBindingStore(environment).find(repository.repositoryHost, repository.nameWithOwner);
    credential = bound === undefined ? undefined : new ExecutorAppCredentialStore(environment).current(bound.appId);
    profile = await new LocalRuntimeProfileStore({ environment }).findForRepository({
      repositoryHost: repository.repositoryHost,
      repositoryNameWithOwner: repository.nameWithOwner,
    });
  } catch {
    throw new LocalExecutorError(
      "EXECUTOR_REPOSITORY_BINDING_UNAVAILABLE",
      "The repository setup binding could not be read.",
    );
  }
  if (bound !== undefined && repositoryBindingState(bound, credential) !== "bound") bound = undefined;
  if (bound !== undefined) {
    if (
      profile !== undefined &&
      (profile.app.appId !== bound.appId ||
        profile.app.installationId !== bound.installationId ||
        profile.repository.repositoryId !== bound.repositoryId)
    )
      throw new LocalExecutorError(
        "EXECUTOR_REPOSITORY_BINDING_INCONSISTENT",
        "The Executor repository binding and the Local Runtime profile name different App installations.",
      );
    // The Issuer key this Executor runs with must be the exact verified generation the binding names.
    if (bound.appId === configuredAppId && issuerKeyFingerprint(Buffer.from(privateKeyPem)) !== bound.fingerprint)
      throw issuerBindingMismatch();
  }
  const source =
    bound !== undefined
      ? {
          appId: bound.appId,
          installationId: bound.installationId,
          repository: {
            repositoryHost: bound.repositoryHost,
            repositoryId: bound.repositoryId,
            nameWithOwner: bound.nameWithOwner,
          },
        }
      : profile === undefined
        ? undefined
        : {
            appId: profile.app.appId,
            installationId: profile.app.installationId,
            repository: {
              repositoryHost: profile.repository.repositoryHost,
              repositoryId: profile.repository.repositoryId,
              nameWithOwner: profile.repository.repositoryNameWithOwner,
            },
          };
  if (source === undefined) {
    throw new LocalExecutorError(
      "EXECUTOR_REPOSITORY_BINDING_MISSING",
      "No setup binding connects this repository to an Inari Issuer App installation. Run `inari setup next` in the repository to bind it.",
    );
  }
  if (
    source.appId !== configuredAppId ||
    (repository.repositoryId !== undefined && source.repository.repositoryId !== repository.repositoryId)
  ) {
    throw issuerBindingMismatch();
  }
  const identity: RepositoryIdentity = Object.freeze({ ...source.repository });
  const installationId = source.installationId;
  return Object.freeze({
    repository: identity,
    appId: configuredAppId,
    broker: (provenance?: GitHubChangeProvenanceSignerOptions) =>
      new GitHubAppInstallationCredentialBroker({
        appId: configuredAppId,
        installationId,
        privateKeyPem,
        repository: providerRepository(identity),
        ...(provenance === undefined ? {} : { provenance }),
      }),
  });
}

function sameRepositoryIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase()
  );
}

/**
 * Prove before any provider effect that the minted installation credential is
 * the configured Issuer App, the profiled installation, and the bound repository.
 */
async function verifyIssuerBinding(binding: LocalExecutorIssuerBinding): Promise<RepositoryIdentity> {
  return binding.broker().withRepositoryReadCapability({}, async (capability) => {
    if (
      capability.scope.app.appId !== binding.appId ||
      !sameRepositoryIdentity(capability.scope.repository, binding.repository)
    ) {
      throw issuerBindingMismatch();
    }
    return binding.repository;
  });
}

function buildReader(
  capability: GitHubAppRepositoryReadCapability,
  repository: GitHubChangeEffectRepository,
  identity: RepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
): GitHubChangeStateProjector {
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
    ...(request.operation === "show" || request.semanticPullRequestPlan === undefined
      ? {}
      : { semanticPullRequestPlan: request.semanticPullRequestPlan }),
  });
}

async function projectChange(
  broker: GitHubAppInstallationCredentialBroker,
  repository: GitHubChangeEffectRepository,
  identity: RepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
) {
  return broker.withRepositoryReadCapability({}, async (capability) =>
    projectChangeFromGitHubEvidence(await buildReader(capability, repository, identity, request).read(request)),
  );
}

/**
 * The installation broker deliberately replaces every callback error with a
 * generic credential-stage failure so a token can never escape. Owner
 * failures raised by Executor code inside the callback (protected-ref trust
 * resolution, Implementation contract checks) carry only a fixed code; they
 * are kept here so the bounded Runtime diagnostic names the real owner stage
 * instead of reporting a provider outage (#1180).
 */
async function withOwnerFailures<T>(
  run: (keep: <R>(operation: () => Promise<R>) => Promise<R>) => Promise<T>,
): Promise<T> {
  let owner: DelegatorTrustError | LocalExecutorError | undefined;
  const keep = async <R>(operation: () => Promise<R>): Promise<R> => {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof DelegatorTrustError || error instanceof LocalExecutorError) owner = error;
      throw error;
    }
  };
  try {
    return await run(keep);
  } catch (error: unknown) {
    if (owner !== undefined) throw owner;
    throw error;
  }
}

export async function resolveLocalExecutorRepository(
  repositoryNameWithOwner: string,
  environment: NodeJS.ProcessEnv,
): Promise<RepositoryIdentity> {
  if (repositoryNameWithOwner.split("/").length !== 2)
    throw new LocalExecutorError("EXECUTOR_REPOSITORY_UNAVAILABLE", "Repository identity is invalid.");
  const binding = await localExecutorIssuerBinding(
    { repositoryHost: "github.com", nameWithOwner: repositoryNameWithOwner },
    environment,
  );
  // The owner failure (binding mismatch or the Issuer credential stage) is kept
  // so the bounded wire diagnostic can name it; no provider detail is exposed.
  return verifyIssuerBinding(binding);
}

export async function readLocalExecutorEvidence(
  request: LocalExecutorEvidenceRequest,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const identity: RepositoryIdentity = {
    repositoryHost: "github.com",
    repositoryId: request.repository.id,
    nameWithOwner: request.repository.name,
  };
  const repository = providerRepository(identity);
  const binding = await localExecutorIssuerBinding(identity, environment);
  await verifyIssuerBinding(binding);
  const broker = binding.broker();
  return withOwnerFailures((keep) =>
    broker.withRepositoryReadCapability({}, async (capability) => {
      const adapter = new GitHubAdapter({
        repository: identity.nameWithOwner,
        hostname: identity.repositoryHost,
        transport: {
          request: async (providerRequest) => {
            if (providerRequest.method !== "GET") throw new Error("Executor evidence reads cannot perform mutation.");
            const response = await capability.transport.request({
              hostname: providerRequest.hostname,
              method: "GET",
              path: providerRequest.path,
            });
            return { ...response, body: response.body ?? null };
          },
        },
      });
      const runtime = await keep(() => resolveDelegator(adapter, request.authorityId));
      const authority = Object.freeze({
        ref: `refs/heads/${runtime.provenance.ref}`,
        sha: runtime.provenance.policySha,
      });
      if (request.issue === undefined || request.implementationIssue === undefined) {
        return Object.freeze({
          repository: identity,
          authority,
          runtimeAuthority: runtime.authority,
        });
      }
      const frontierRepository = createGitHubImplementationFrontierRepository({
        adapter,
        cwd: process.cwd(),
        changeReader: {
          read: (changeRequest) => projectChange(broker, repository, identity, changeRequest),
        },
      });
      const implementation = await readCurrentImplementationAdmissionEvidence(
        frontierRepository,
        request.implementationIssue,
      );
      const change = await projectChange(broker, repository, identity, changeReadRequest(request.issue));
      const pullRequestNumber = change.change?.projection?.pullRequest;
      const reviewEvidence =
        typeof pullRequestNumber === "number"
          ? await frontierRepository.observePullRequest(pullRequestNumber)
          : undefined;
      return Object.freeze({
        repository: identity,
        authority,
        runtimeAuthority: runtime.authority,
        change,
        implementation,
        ...(reviewEvidence === undefined ? {} : { reviewEvidence }),
      });
    }),
  );
}

/** Request for the current repository branch policy of one governed Implementation (#1179). */
export interface LocalExecutorBranchPolicyRequest {
  readonly version: 1;
  readonly repository: { readonly id: string; readonly name: string };
  readonly implementation: number;
}

function branchPolicyDenied(code: string, message: string): LocalExecutorError {
  return new LocalExecutorError(code, message);
}

/**
 * Current repository branch-policy observation input for one governed
 * Implementation (#1179): the policy acquired from the repository's
 * provider-resolved default branch through the Issuer read capability, the
 * Implementation's exact contract branch binding, and the generation observed
 * for staleness. It is public data only; no credential leaves the Executor.
 * A non-Implementation Issue (for example a Source bug Issue) or an
 * unavailable/invalid policy is a bounded denial, never a fixed-grammar guess.
 */
export async function readLocalExecutorBranchPolicy(
  request: LocalExecutorBranchPolicyRequest,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const identity: RepositoryIdentity = {
    repositoryHost: "github.com",
    repositoryId: request.repository.id,
    nameWithOwner: request.repository.name,
  };
  const binding = await localExecutorIssuerBinding(identity, environment);
  await verifyIssuerBinding(binding);
  return withOwnerFailures((keep) =>
    binding.broker().withRepositoryReadCapability({}, (capability) =>
      keep(async () => {
        const adapter = new GitHubAdapter({
          repository: identity.nameWithOwner,
          hostname: identity.repositoryHost,
          transport: {
            request: async (providerRequest) => {
              if (providerRequest.method !== "GET") throw new Error("Executor policy reads cannot perform mutation.");
              const response = await capability.transport.request({
                hostname: providerRequest.hostname,
                method: "GET",
                path: providerRequest.path,
              });
              return { ...response, body: response.body ?? null };
            },
          },
        });
        const issue = await adapter.getIssue(request.implementation);
        const parsed = typeof issue.body === "string" ? parseImplementationIssueBody(issue.body) : undefined;
        if (parsed === undefined || !parsed.valid || parsed.contract === undefined)
          throw branchPolicyDenied(
            "EXECUTOR_IMPLEMENTATION_CONTRACT_REQUIRED",
            "The selected Issue is not a governed Implementation contract.",
          );
        const repository = { repositoryHost: identity.repositoryHost, repositoryId: identity.repositoryId };
        if (
          parsed.contract.repository.repositoryHost !== repository.repositoryHost ||
          parsed.contract.repository.repositoryId !== repository.repositoryId
        )
          throw branchPolicyDenied(
            "EXECUTOR_IMPLEMENTATION_REPOSITORY_MISMATCH",
            "The Implementation contract names a different repository.",
          );
        const acquisition = await acquireRepositoryBranchPolicy(adapter);
        if (acquisition.status !== "available")
          throw branchPolicyDenied(
            "EXECUTOR_BRANCH_POLICY_UNAVAILABLE",
            "The repository branch policy is unavailable.",
          );
        const branch = parsed.contract.execution.branch;
        return Object.freeze({
          version: 1,
          kind: "local-branch-policy-input",
          policy: acquisition.policy,
          target: { repository, implementation: request.implementation },
          observedGeneration: {
            ref: acquisition.policy.generation.ref,
            treeSha: acquisition.policy.generation.treeSha,
          },
          ...(branch === undefined ? {} : { binding: { repository, implementation: request.implementation, branch } }),
        });
      }),
    ),
  );
}

/** Request for the repository-governed pull-request contract (#1181). */
export interface LocalExecutorGovernedContractRequest {
  readonly version: 1;
  readonly repository: { readonly id: string; readonly name: string };
  readonly domain: "pr";
  readonly template: string;
}

/**
 * Compile the repository-governed pull-request contract from the protected
 * default branch through the Issuer read capability (#1181), so template
 * discovery, materialization and validation need no CLI provider credential.
 * The result is the public canonical contract only.
 */
export async function readLocalExecutorGovernedContract(
  request: LocalExecutorGovernedContractRequest,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const identity: RepositoryIdentity = {
    repositoryHost: "github.com",
    repositoryId: request.repository.id,
    nameWithOwner: request.repository.name,
  };
  const binding = await localExecutorIssuerBinding(identity, environment);
  await verifyIssuerBinding(binding);
  return binding.broker().withRepositoryReadCapability({}, async (capability) => {
    const adapter = new GitHubAdapter({
      repository: identity.nameWithOwner,
      hostname: identity.repositoryHost,
      transport: {
        request: async (providerRequest) => {
          if (providerRequest.method !== "GET") throw new Error("Executor contract reads cannot perform mutation.");
          const response = await capability.transport.request({
            hostname: providerRequest.hostname,
            method: "GET",
            path: providerRequest.path,
          });
          return { ...response, body: response.body ?? null };
        },
      },
    });
    return compileRepositoryGovernedContract(adapter, request.domain, request.template);
  });
}

function createDelegates(
  input: AuthorizedExecution,
  binding: LocalExecutorIssuerBinding,
): AuthorizedExecutionDelegates {
  const readBroker = binding.broker();
  const readRepository = providerRepository(input.repository);
  const readExecutor = {
    read: (request: ChangeReadRequest) => projectChange(readBroker, readRepository, input.repository, request),
  };
  const executionBroker = binding.broker();
  const effectAuthorizer = new InariEffectAuthorizer({ appId: binding.appId, broker: executionBroker });

  return {
    readExecutor,
    branchAdvance: ({ request, branchAuthorization, provenance }) =>
      executeBranchAdvanceEffects({
        repository: input.repository,
        provenance,
        broker: executionBroker,
        request,
        authorization: branchAuthorization,
      }),
    publishPullRequest: async ({ execution, request }) => {
      const app = await executionBroker.withRepositoryReadCapability({}, async (capability) => ({
        ...capability.scope.app,
        installationId: capability.scope.installation.installationId,
      }));
      const publication = await publishPullRequest(
        request,
        createPrPublicationProvider({
          broker: executionBroker,
          authorizer: effectAuthorizer,
          execution,
          target: input.repository,
        }),
      );
      return { publication, app };
    },
    createChangeExecutor: async ({ execution, request }) => {
      const target = execution.repository;
      if (!sameRepositoryIdentity(target, binding.repository)) throw issuerBindingMismatch();
      const repository = providerRepository(target);
      let executionBroker = binding.broker();
      if (request.operation === "issue") {
        if (request.signedProvenanceRecord === undefined) throw new Error("Signed Change provenance is required.");
        const validation = validateChangeProvenanceRecord(request.signedProvenanceRecord);
        if (!validation.valid || validation.record === undefined)
          throw new Error("Signed Change provenance is invalid.");
        const signedRecord = validation.record;
        const signer = await executionBroker.withRepositoryReadCapability({}, async (capability) => {
          const reader = createAppRepositoryEvidenceReader(capability, repository, target);
          const loaded = await resolveDelegator(reader, signedRecord.signature.kid);
          const payload = verifyChangeProvenanceRecord(signedRecord, loaded.authority);
          if (payload.rootIssue !== request.issue || payload.operation !== "change.issue") {
            throw new Error("Signed Change provenance does not match the request.");
          }
          return { runtimeAuthority: loaded.authority, signedRecord } satisfies GitHubChangeProvenanceSignerOptions;
        });
        executionBroker = binding.broker(signer);
      }

      const effectAuthorizer = new InariEffectAuthorizer({ appId: binding.appId, broker: executionBroker });
      let establishedApp: AuthorizedExecutionChangeFactoryResult["app"];
      await executionBroker.withRepositoryReadCapability({}, async (capability) => {
        establishedApp = {
          ...capability.scope.app,
          installationId: capability.scope.installation.installationId,
        };
      });

      const executor: ChangeExecutionPort = {
        read: (changeRequest) => projectChange(executionBroker, repository, target, changeRequest),
        execute: (changeRequest) =>
          changeRequest.operation === "merge"
            ? executionBroker.withSemanticPullRequestMutationExecutor({ target }, (semanticExecutor) =>
                executionBroker.withRepositoryReadCapability({}, async (capability) =>
                  new TrustedChangeExecutor({
                    reader: buildReader(capability, repository, target, changeRequest),
                    effectAuthorizer,
                    execution,
                    target,
                    semanticPullRequestMutationExecutor: semanticExecutor,
                  }).execute(changeRequest),
                ),
              )
            : executionBroker.withRepositoryReadCapability({}, async (capability) =>
                new TrustedChangeExecutor({
                  reader: buildReader(capability, repository, target, changeRequest),
                  effectAuthorizer,
                  execution,
                  target,
                }).execute(changeRequest),
              ),
      };
      if (establishedApp === undefined) throw new Error("GitHub App installation identity is unavailable.");
      return { executor, app: establishedApp };
    },
  };
}

export async function executeLocalAuthorizedExecution(
  input: AuthorizedExecution,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AuthorizedExecutionResult> {
  const binding = await localExecutorIssuerBinding(input.repository, environment);
  await verifyIssuerBinding(binding);
  return executeAuthorizedExecution(input, createDelegates(input, binding));
}
