import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { Readable } from "node:stream";
import path from "node:path";
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
import { resolveDelegator } from "../agent-authority/delegator-trust.js";
import { validateChangeProvenanceRecord, verifyChangeProvenanceRecord } from "../change-provenance-record.js";
import { TrustedChangeExecutor } from "../change-trusted-executor.js";
import {
  GitHubAdapter,
  createAppRepositoryEvidenceReader,
  GitHubAppUserCredentialBroker,
  FileAppUserCredentialStore,
  GitHubChangeStateProjector,
  InariEffectAuthorizer,
  createPrPublicationProvider,
  type GitHubChangeEffectRepository,
  type GitHubChangeProvenanceSignerOptions,
  type GitHubAppRepositoryReadCapability,
  type RepositoryIdentity,
} from "../github/index.js";
import { validateIssuerRepositoryIdentity } from "../github/effect-authorizer.js";
import { GitHubNativeHttpTransport, githubRestBaseUrl } from "../github/native-http-transport.js";
import {
  createGitHubImplementationFrontierRepository,
  readCurrentImplementationAdmissionEvidence,
} from "../implementation-frontier-composition.js";
import { publishPullRequest } from "../pr-publication.js";
import {
  LocalControlError,
  LOCAL_CONFIG_VERSION,
  readLocalJson,
  resolveConfigHome,
  validateLocalAdmissionConfig,
  validateLocalExecutorConfig,
  configuredLocalRuntimeBindHost,
  writeLocalJson,
  type LocalExecutorConfig,
} from "./config.js";
import {
  LocalTransportSecurityError,
  loadLocalMtlsIdentity,
  verifyLocalMtlsPeerIdentity,
} from "./transport-security.js";
import {
  createLocalExecutorHttpHandler,
  type LocalExecutorEvidenceRequest,
  type LocalExecutorHttpHandlerOptions,
} from "./executor-http.js";
import {
  clearLocalRuntimeEndpoint,
  publishLocalRuntimeEndpoint,
  type LocalRuntimeEndpoint,
} from "./runtime-discovery.js";

export const LOCAL_EXECUTOR_DEFAULT_PORT = 0;
export const LOCAL_EXECUTOR_CREDENTIAL_PROFILE = "default";
const LOCAL_EXECUTOR_HISTORICAL_PORT = 8765;
const EXECUTOR_CONFIG_PATH = "config.json";

export class LocalExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalExecutorError";
    this.code = code;
  }
}

export interface LocalExecutorSetupResult {
  readonly config: LocalExecutorConfig;
  readonly configPath: string;
}

function configuredListenPort(port: number): number {
  return port === LOCAL_EXECUTOR_HISTORICAL_PORT ? LOCAL_EXECUTOR_DEFAULT_PORT : port;
}

export function localExecutorCredentialPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.INARI_GITHUB_APP_USER_CREDENTIAL_FILE ?? environment.INARI_APP_USER_CREDENTIAL_FILE;
  return configured === undefined
    ? path.join(resolveConfigHome(environment), "app-user-credential.json")
    : path.resolve(configured);
}

export function localExecutorAppId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.INARI_GITHUB_APP_ID ?? environment.GITHUB_APP_ID;
  if (value === undefined || !/^[1-9][0-9]{0,19}$/u.test(value.trim())) return undefined;
  return value.trim();
}

function appId(environment: NodeJS.ProcessEnv): string {
  const value = localExecutorAppId(environment);
  if (value === undefined) {
    throw new LocalExecutorError(
      "EXECUTOR_PROVIDER_CONFIGURATION_MISSING",
      "Set INARI_GITHUB_APP_ID (or GITHUB_APP_ID) to the numeric App ID shown by `inari setup` before configuring the local Executor.",
    );
  }
  return value;
}

async function requireCredential(environment: NodeJS.ProcessEnv): Promise<FileAppUserCredentialStore> {
  const store = new FileAppUserCredentialStore({ path: localExecutorCredentialPath(environment) });
  try {
    if ((await store.load()) === undefined) {
      throw new LocalExecutorError(
        "EXECUTOR_CREDENTIALS_MISSING",
        "GitHub App user authorization is missing. Run `inari setup --endpoint <endpoint-url>` to complete Device Flow before configuring the local Executor.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof LocalExecutorError) throw error;
    throw new LocalExecutorError(
      "EXECUTOR_CREDENTIALS_UNAVAILABLE",
      "GitHub App user credentials could not be loaded from the configured credential store.",
    );
  }
  return store;
}

function requireSupportedCredentialProfile(config: LocalExecutorConfig): LocalExecutorConfig {
  if (config.provider.credentialProfile !== LOCAL_EXECUTOR_CREDENTIAL_PROFILE) {
    throw new LocalExecutorError(
      "EXECUTOR_CREDENTIAL_PROFILE_UNSUPPORTED",
      "Executor configuration references an unsupported GitHub credential profile.",
    );
  }
  return config;
}

export async function setupLocalExecutor(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalExecutorSetupResult> {
  await requireCredential(environment);
  appId(environment);
  const configPath = path.join(resolveConfigHome(environment), "executor", EXECUTOR_CONFIG_PATH);
  const existing = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
  const bindHost = configuredLocalRuntimeBindHost(environment);
  if (existing !== undefined) requireSupportedCredentialProfile(existing);
  if (existing !== undefined && existing.listen.host !== bindHost) {
    throw new LocalExecutorError(
      "EXECUTOR_BIND_POLICY_CONFLICT",
      "Executor bind policy conflicts with existing setup. Select the bind policy before setting up local components.",
    );
  }
  if (existing !== undefined) return { config: existing, configPath };

  const config: LocalExecutorConfig = {
    version: LOCAL_CONFIG_VERSION,
    id: `exec_${randomBytes(24).toString("base64url")}`,
    listen: { host: bindHost, port: LOCAL_EXECUTOR_DEFAULT_PORT },
    provider: { kind: "github", credentialProfile: LOCAL_EXECUTOR_CREDENTIAL_PROFILE },
  };
  try {
    return {
      config: writeLocalJson("executor", EXECUTOR_CONFIG_PATH, config, validateLocalExecutorConfig, environment),
      configPath,
    };
  } catch (error: unknown) {
    if (!(error instanceof LocalControlError) || error.code !== "LOCAL_CONTROL_CONFIG_CONFLICT") throw error;
    const raced = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
    if (raced !== undefined) return { config: raced, configPath };
    throw error;
  }
}

function configuredLocalExecutor(environment: NodeJS.ProcessEnv): LocalExecutorConfig {
  const config = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
  if (config === undefined) {
    throw new LocalExecutorError(
      "EXECUTOR_NOT_SETUP",
      "Local Executor is not set up. Run `inari executor setup` first.",
    );
  }
  return requireSupportedCredentialProfile(config);
}

function providerRepository(identity: RepositoryIdentity): GitHubChangeEffectRepository {
  const parts = identity.nameWithOwner.split("/");
  if (parts.length !== 2) throw new Error("Authorized repository locator is invalid.");
  return { hostname: identity.repositoryHost, owner: parts[0] as string, name: parts[1] as string };
}

function createBroker(
  identity: RepositoryIdentity,
  environment: NodeJS.ProcessEnv,
  credentialStore: FileAppUserCredentialStore,
  provenance?: GitHubChangeProvenanceSignerOptions,
): GitHubAppUserCredentialBroker {
  return new GitHubAppUserCredentialBroker({
    appId: appId(environment),
    repository: providerRepository(identity),
    repositoryId: identity.repositoryId,
    credentialStore,
    ...(provenance === undefined ? {} : { provenance }),
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
  broker: GitHubAppUserCredentialBroker,
  repository: GitHubChangeEffectRepository,
  identity: RepositoryIdentity,
  request: ChangeReadRequest | ChangeMutationRequest,
) {
  return broker.withRepositoryReadCapability({}, async (capability) =>
    projectChangeFromGitHubEvidence(await buildReader(capability, repository, identity, request).read(request)),
  );
}

async function resolveLocalExecutorRepository(
  repositoryNameWithOwner: string,
  environment: NodeJS.ProcessEnv,
): Promise<RepositoryIdentity> {
  const parts = repositoryNameWithOwner.split("/");
  if (parts.length !== 2)
    throw new LocalExecutorError("EXECUTOR_REPOSITORY_UNAVAILABLE", "Repository identity is invalid.");
  const [owner, name] = parts as [string, string];
  const store = await requireCredential(environment);
  const credential = await store.load();
  if (credential === undefined) {
    throw new LocalExecutorError("EXECUTOR_CREDENTIALS_MISSING", "GitHub App user credentials are missing.");
  }
  try {
    const response = await credential.withAccessToken((token) =>
      new GitHubNativeHttpTransport({ token, apiUrl: githubRestBaseUrl("github.com") }).request({
        hostname: "github.com",
        method: "GET",
        path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      }),
    );
    if (
      response.status !== 200 ||
      typeof response.body !== "object" ||
      response.body === null ||
      Array.isArray(response.body)
    ) {
      throw new Error();
    }
    const body = response.body as Record<string, unknown>;
    const id = typeof body.id === "number" && Number.isSafeInteger(body.id) ? String(body.id) : body.id;
    const fullName = body.full_name;
    const candidate = {
      repositoryHost: "github.com",
      repositoryId: id,
      nameWithOwner: fullName,
    };
    const validation = validateIssuerRepositoryIdentity(candidate);
    if (
      !validation.valid ||
      validation.value === undefined ||
      validation.value.nameWithOwner.toLocaleLowerCase("en-US") !== repositoryNameWithOwner.toLocaleLowerCase("en-US")
    ) {
      throw new Error();
    }
    return validation.value;
  } catch {
    throw new LocalExecutorError("EXECUTOR_REPOSITORY_UNAVAILABLE", "Repository identity could not be resolved.");
  }
}

async function readLocalExecutorEvidence(
  request: LocalExecutorEvidenceRequest,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  const identity: RepositoryIdentity = {
    repositoryHost: "github.com",
    repositoryId: request.repository.id,
    nameWithOwner: request.repository.name,
  };
  const repository = providerRepository(identity);
  const broker = createBroker(identity, environment, await requireCredential(environment));
  return broker.withRepositoryReadCapability({}, async (capability) => {
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
    const runtime = await resolveDelegator(adapter, request.authorityId);
    const authority = Object.freeze({ ref: `refs/heads/${runtime.provenance.ref}`, sha: runtime.provenance.policySha });
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
  });
}

function createDelegates(
  input: AuthorizedExecution,
  environment: NodeJS.ProcessEnv,
  credentialStore: FileAppUserCredentialStore,
): AuthorizedExecutionDelegates {
  const readBroker = createBroker(input.repository, environment, credentialStore);
  const readRepository = providerRepository(input.repository);
  const readExecutor = {
    read: (request: ChangeReadRequest) => projectChange(readBroker, readRepository, input.repository, request),
  };
  const executionBroker = createBroker(input.repository, environment, credentialStore);
  const effectAuthorizer = new InariEffectAuthorizer({ appId: appId(environment), broker: executionBroker });

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
      const repository = providerRepository(target);
      let executionBroker = createBroker(target, environment, credentialStore);
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
        executionBroker = createBroker(target, environment, credentialStore, signer);
      }

      const effectAuthorizer = new InariEffectAuthorizer({ appId: appId(environment), broker: executionBroker });
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
  const credentialStore = await requireCredential(environment);
  return executeAuthorizedExecution(input, createDelegates(input, environment, credentialStore));
}

export interface LocalExecutorHttpServerOptions extends LocalExecutorHttpHandlerOptions {
  readonly config: LocalExecutorConfig;
  readonly listenPort?: number;
  readonly transport?: ReturnType<typeof loadLocalMtlsIdentity>;
}

function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  return response.arrayBuffer().then((body) => {
    outgoing.end(Buffer.from(body));
  });
}

function requestFromIncoming(request: IncomingMessage): Request {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const method = request.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
    duplex: "half",
  } as RequestInit & { readonly duplex: "half" });
}

export function createLocalExecutorHttpServer(options: LocalExecutorHttpServerOptions): Server {
  const handler = createLocalExecutorHttpHandler(options);
  const port = options.listenPort ?? configuredListenPort(options.config.listen.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError("Local Executor listen port is invalid.");
  const nonLoopback = options.config.listen.host === "0.0.0.0";
  if (
    nonLoopback !== (options.transport !== undefined) ||
    (options.transport !== undefined && options.transport.peerRole !== "admission")
  ) {
    throw new TypeError("Local Executor non-loopback bind requires a configured mTLS identity.");
  }
  const handle = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    if (nonLoopback) {
      const socket = incoming.socket as TLSSocket;
      const peer = socket.getPeerCertificate();
      if (
        !socket.authorized ||
        options.transport === undefined ||
        !verifyLocalMtlsPeerIdentity(peer, "admission", options.transport.peerId)
      ) {
        socket.destroy();
        return;
      }
    }
    void (async () => {
      try {
        await writeResponse(await handler(requestFromIncoming(incoming)), outgoing);
      } catch {
        if (!outgoing.headersSent) {
          outgoing.statusCode = 400;
          outgoing.setHeader("content-type", "application/json; charset=utf-8");
        }
        outgoing.end(
          JSON.stringify({ ok: false, error: { code: "MALFORMED_REQUEST", message: "Request could not be handled." } }),
        );
      }
    })();
  };
  if (nonLoopback) {
    const transport = options.transport;
    if (transport === undefined) throw new TypeError("Local Executor mTLS identity is missing.");
    return createHttpsServer(
      {
        key: transport.privateKey,
        cert: transport.certificate,
        ca: transport.caCertificate,
        requestCert: true,
        rejectUnauthorized: true,
      },
      handle,
    ).listen(port, options.config.listen.host);
  }
  return createServer(handle).listen(port, options.config.listen.host);
}

export async function startConfiguredLocalExecutor(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  readonly server: Server;
  readonly config: LocalExecutorConfig;
  readonly announcement: LocalRuntimeEndpoint;
}> {
  const config = configuredLocalExecutor(environment);
  await requireCredential(environment);
  appId(environment);
  let transport: ReturnType<typeof loadLocalMtlsIdentity> | undefined;
  if (config.listen.host === "0.0.0.0") {
    const admission = readLocalJson("admission", "config.json", validateLocalAdmissionConfig, environment);
    if (admission === undefined) {
      throw new LocalExecutorError(
        "EXECUTOR_ADMISSION_IDENTITY_MISSING",
        "Non-loopback Executor requires configured local Admission identity and mTLS custody.",
      );
    }
    try {
      transport = loadLocalMtlsIdentity("executor", config.id, admission.id, environment);
    } catch (error: unknown) {
      if (error instanceof LocalTransportSecurityError) {
        throw new LocalExecutorError(error.code, error.message);
      }
      throw error;
    }
  }
  const server = createLocalExecutorHttpServer({
    config,
    version,
    executorId: config.id,
    execute: (execution) => executeLocalAuthorizedExecution(execution, environment),
    resolveRepository: (repositoryNameWithOwner) =>
      resolveLocalExecutorRepository(repositoryNameWithOwner, environment),
    readEvidence: (request) => readLocalExecutorEvidence(request, environment),
    ready: () => true,
    ...(transport === undefined ? {} : { transport }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch {
    server.close();
    throw new LocalExecutorError("EXECUTOR_LISTEN_FAILED", "Local Executor could not bind its configured endpoint.");
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  if (port === undefined) {
    server.close();
    throw new LocalExecutorError("EXECUTOR_LISTEN_FAILED", "Local Executor did not acquire a listening port.");
  }
  let announcement: LocalRuntimeEndpoint;
  try {
    announcement = publishLocalRuntimeEndpoint(
      "executor",
      config.id,
      port,
      environment,
      config.listen.host === "0.0.0.0" ? "https" : "http",
    );
  } catch {
    server.close();
    throw new LocalExecutorError("EXECUTOR_DISCOVERY_FAILED", "Local Executor endpoint could not be published safely.");
  }
  server.once("close", () => {
    try {
      clearLocalRuntimeEndpoint(announcement, environment);
    } catch {
      // A shutdown cleanup failure must not change the process close behavior.
    }
  });
  return { server, config, announcement };
}
