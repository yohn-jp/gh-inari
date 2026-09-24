import { createPrivateKey, randomBytes } from "node:crypto";
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
  GitHubAppInstallationCredentialBroker,
  GitHubChangeStateProjector,
  InariEffectAuthorizer,
  createPrPublicationProvider,
  type GitHubChangeEffectRepository,
  type GitHubChangeProvenanceSignerOptions,
  type GitHubAppRepositoryReadCapability,
  type RepositoryIdentity,
} from "../github/index.js";
import { validateIssuerRepositoryIdentity } from "../github/effect-authorizer.js";
import {
  createGitHubImplementationFrontierRepository,
  readCurrentImplementationAdmissionEvidence,
} from "../implementation-frontier-composition.js";
import { publishPullRequest } from "../pr-publication.js";
import { LocalRuntimeProfileStore } from "../local-runtime-profile.js";
import { LocalRuntimeConfigError, readAppPrivateKey } from "../relay/local-runtime-config.js";
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
import { createLocalRuntimeStatusPage, isLocalRuntimeLoopbackAddress } from "./status-page.js";

export const LOCAL_EXECUTOR_DEFAULT_PORT = 0;
export const LOCAL_EXECUTOR_CREDENTIAL_PROFILE = "default";
export const LOCAL_EXECUTOR_STATUS_PATH = "/status" as const;
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

export type LocalExecutorIssuerKeyStatus = "configured" | "missing";

/**
 * Local Executor custody is a file reference only. Inline PEM variables
 * (INARI_GITHUB_APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY) would place key
 * material in CLI process environments and are not accepted here.
 */
const ISSUER_KEY_REFERENCE_VARIABLES = ["INARI_GITHUB_APP_PRIVATE_KEY_FILE", "GITHUB_APP_PRIVATE_KEY_FILE"] as const;

function issuerKeyMissing(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_ISSUER_KEY_MISSING",
    "The local Executor mints Inari Issuer App installation credentials. Set INARI_GITHUB_APP_PRIVATE_KEY_FILE to the path of the Issuer App private key (.pem) before configuring the local Executor; only the running Executor reads the key, and it is never persisted.",
  );
}

function issuerKeyInvalid(): LocalExecutorError {
  return new LocalExecutorError(
    "EXECUTOR_ISSUER_KEY_INVALID",
    "The Inari Issuer App private key referenced by INARI_GITHUB_APP_PRIVATE_KEY_FILE is not a readable RSA private key.",
  );
}

/**
 * Whether an Executor-owned Issuer App private-key reference is configured.
 * This inspects only which custody variable is set; it never opens the key
 * file or parses key material, so CLI, setup, and browser projections stay
 * outside the Executor credential boundary.
 */
export function localExecutorIssuerKeyStatus(
  environment: NodeJS.ProcessEnv = process.env,
): LocalExecutorIssuerKeyStatus {
  return ISSUER_KEY_REFERENCE_VARIABLES.some((name) => (environment[name]?.trim().length ?? 0) > 0)
    ? "configured"
    : "missing";
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
    // Pass only the file reference so inline PEM variables are never used.
    const reference: NodeJS.ProcessEnv = {};
    for (const name of ISSUER_KEY_REFERENCE_VARIABLES) {
      if (environment[name] !== undefined) reference[name] = environment[name];
    }
    pem = readAppPrivateKey(reference);
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

/** Non-secret setup prerequisites: App ID and the Issuer key reference only. */
function requireIssuerReference(environment: NodeJS.ProcessEnv): void {
  appId(environment);
  if (localExecutorIssuerKeyStatus(environment) === "missing") throw issuerKeyMissing();
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
  requireIssuerReference(environment);
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
    "The Inari Issuer App, installation, or repository does not match the Local Runtime profile for this repository.",
  );
}

/**
 * Bind the Issuer App installation credential to the canonical Local Runtime
 * profile written by repository setup. The profile supplies the repository id
 * and installation id; the App ID and private key are Executor-owned inputs.
 */
async function localExecutorIssuerBinding(
  repository: { readonly repositoryHost: string; readonly nameWithOwner: string; readonly repositoryId?: string },
  environment: NodeJS.ProcessEnv,
): Promise<LocalExecutorIssuerBinding> {
  const configuredAppId = appId(environment);
  const privateKeyPem = issuerPrivateKey(environment);
  let profile: Awaited<ReturnType<LocalRuntimeProfileStore["findForRepository"]>>;
  try {
    profile = await new LocalRuntimeProfileStore({ environment }).findForRepository({
      repositoryHost: repository.repositoryHost,
      repositoryNameWithOwner: repository.nameWithOwner,
    });
  } catch {
    throw new LocalExecutorError(
      "EXECUTOR_REPOSITORY_BINDING_UNAVAILABLE",
      "The Local Runtime profile for this repository could not be read.",
    );
  }
  if (profile === undefined) {
    throw new LocalExecutorError(
      "EXECUTOR_REPOSITORY_BINDING_MISSING",
      "No Local Runtime profile binds this repository to an Inari Issuer App installation. Run `inari setup --endpoint <endpoint-url>` in the repository first.",
    );
  }
  if (
    profile.app.appId !== configuredAppId ||
    (repository.repositoryId !== undefined && profile.repository.repositoryId !== repository.repositoryId)
  ) {
    throw issuerBindingMismatch();
  }
  const identity: RepositoryIdentity = Object.freeze({
    repositoryHost: profile.repository.repositoryHost,
    repositoryId: profile.repository.repositoryId,
    nameWithOwner: profile.repository.repositoryNameWithOwner,
  });
  const installationId = profile.app.installationId;
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

async function resolveLocalExecutorRepository(
  repositoryNameWithOwner: string,
  environment: NodeJS.ProcessEnv,
): Promise<RepositoryIdentity> {
  if (repositoryNameWithOwner.split("/").length !== 2)
    throw new LocalExecutorError("EXECUTOR_REPOSITORY_UNAVAILABLE", "Repository identity is invalid.");
  const binding = await localExecutorIssuerBinding(
    { repositoryHost: "github.com", nameWithOwner: repositoryNameWithOwner },
    environment,
  );
  try {
    return await verifyIssuerBinding(binding);
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
  const binding = await localExecutorIssuerBinding(identity, environment);
  await verifyIssuerBinding(binding);
  const broker = binding.broker();
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
  let server: Server;
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
        const pathname = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname === LOCAL_EXECUTOR_STATUS_PATH) {
          if (nonLoopback && !isLocalRuntimeLoopbackAddress(incoming.socket.remoteAddress)) {
            outgoing.statusCode = 404;
            outgoing.end();
            return;
          }
          if (incoming.method !== "GET") {
            outgoing.statusCode = 405;
            outgoing.setHeader("allow", "GET");
            outgoing.setHeader("content-type", "text/plain; charset=utf-8");
            outgoing.end("Only GET is supported.\n");
            return;
          }
          const address = server.address();
          const boundPort = typeof address === "object" && address !== null ? address.port : undefined;
          if (boundPort === undefined) {
            outgoing.statusCode = 503;
            outgoing.end();
            return;
          }
          await writeResponse(
            createLocalRuntimeStatusPage({
              component: "executor",
              id: options.executorId,
              readiness: options.ready?.() === false ? "not-ready" : "ready",
              endpoint: `${options.transport === undefined ? "http" : "https"}://127.0.0.1:${boundPort}`,
            }),
            outgoing,
          );
          return;
        }
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
    server = createHttpsServer(
      {
        key: transport.privateKey,
        cert: transport.certificate,
        ca: transport.caCertificate,
        requestCert: true,
        rejectUnauthorized: true,
      },
      handle,
    ).listen(port, options.config.listen.host);
  } else {
    server = createServer(handle).listen(port, options.config.listen.host);
  }
  return server;
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
  // Executor startup is the credential boundary: read and validate the key now.
  appId(environment);
  issuerPrivateKey(environment);
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
