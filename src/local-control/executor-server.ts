import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import {
  executeAuthorizedExecution,
  createAuthorizedExecution,
  type AuthorizedExecution,
  type AuthorizedExecutionChangeFactoryResult,
  type AuthorizedExecutionDelegates,
  type AuthorizedExecutionResult,
} from "../authorized-execution.js";
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
  createAppRepositoryEvidenceReader,
  GitHubAppUserCredentialBroker,
  FileAppUserCredentialStore,
  GitHubChangeStateProjector,
  InariEffectAuthorizer,
  type GitHubChangeEffectRepository,
  type GitHubChangeProvenanceSignerOptions,
  type GitHubAppRepositoryReadCapability,
  type RepositoryIdentity,
} from "../github/index.js";
import {
  LocalControlError,
  LOCAL_CONFIG_VERSION,
  readLocalJson,
  resolveConfigHome,
  validateLocalExecutorConfig,
  writeLocalJson,
  type LocalExecutorConfig,
} from "./config.js";
import { createLocalExecutorHttpHandler, type LocalExecutorHttpHandlerOptions } from "./executor-http.js";

export const LOCAL_EXECUTOR_DEFAULT_PORT = 8765;
export const LOCAL_EXECUTOR_CREDENTIAL_PROFILE = "default";
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

function providerCredentialPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment.INARI_GITHUB_APP_USER_CREDENTIAL_FILE ?? environment.INARI_APP_USER_CREDENTIAL_FILE;
  return configured === undefined
    ? path.join(resolveConfigHome(environment), "app-user-credential.json")
    : path.resolve(configured);
}

function appId(environment: NodeJS.ProcessEnv): string {
  const value = environment.INARI_GITHUB_APP_ID ?? environment.GITHUB_APP_ID;
  if (value === undefined || !/^[1-9][0-9]{0,19}$/u.test(value.trim())) {
    throw new LocalExecutorError(
      "EXECUTOR_PROVIDER_CONFIGURATION_MISSING",
      "GitHub App credentials are not configured for the local Executor.",
    );
  }
  return value.trim();
}

async function requireCredential(environment: NodeJS.ProcessEnv): Promise<FileAppUserCredentialStore> {
  const store = new FileAppUserCredentialStore({ path: providerCredentialPath(environment) });
  try {
    if ((await store.load()) === undefined) {
      throw new LocalExecutorError(
        "EXECUTOR_CREDENTIALS_MISSING",
        "GitHub App user credentials are missing. Complete local App setup before using the Executor.",
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
  appId(environment);
  await requireCredential(environment);
  const configPath = path.join(resolveConfigHome(environment), "executor", EXECUTOR_CONFIG_PATH);
  const existing = readLocalJson("executor", EXECUTOR_CONFIG_PATH, validateLocalExecutorConfig, environment);
  if (existing !== undefined) requireSupportedCredentialProfile(existing);
  if (existing !== undefined) return { config: existing, configPath };

  const config: LocalExecutorConfig = {
    version: LOCAL_CONFIG_VERSION,
    id: `exec_${randomBytes(24).toString("base64url")}`,
    listen: { host: "127.0.0.1", port: LOCAL_EXECUTOR_DEFAULT_PORT },
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

  return {
    readExecutor,
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
  const branded = createAuthorizedExecution(input);
  return executeAuthorizedExecution(branded, createDelegates(branded, environment, credentialStore));
}

export interface LocalExecutorHttpServerOptions extends LocalExecutorHttpHandlerOptions {
  readonly config: LocalExecutorConfig;
  readonly listenPort?: number;
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
  const port = options.listenPort ?? options.config.listen.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError("Local Executor listen port is invalid.");
  return createServer((incoming, outgoing) => {
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
  }).listen(port, options.config.listen.host);
}

export async function startConfiguredLocalExecutor(
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly server: Server; readonly config: LocalExecutorConfig }> {
  const config = configuredLocalExecutor(environment);
  await requireCredential(environment);
  appId(environment);
  const server = createLocalExecutorHttpServer({
    config,
    version,
    executorId: config.id,
    execute: (execution) => executeLocalAuthorizedExecution(execution, environment),
    ready: () => true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch {
    server.close();
    throw new LocalExecutorError(
      "EXECUTOR_LISTEN_FAILED",
      "Local Executor could not bind its configured loopback endpoint.",
    );
  }
  return { server, config };
}
