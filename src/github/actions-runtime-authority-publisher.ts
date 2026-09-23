import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import {
  GitHubAppInstallationCredentialBroker,
  resolveGitHubRepository,
} from "./app-installation-credential-broker.js";
import { GitHubActionsApiTransport } from "./actions-change-executor.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";
import {
  RUNTIME_AUTHORITY_PUBLICATION_EVENT,
  publishRuntimeAuthority,
  validateRuntimeAuthorityPublicationRequest,
} from "../runtime-authority-publication.js";
import type { RepositoryIdentity } from "./effect-authorizer.js";

const WORKFLOW_PATH = ".github/workflows/inari-runtime-authority-publisher.yml";
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const CORRELATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_EVENT_BYTES = 128 * 1024;

export class GitHubActionsRuntimeAuthorityPublisherError extends Error {
  constructor() {
    super("Trusted Runtime Authority publication failed closed.");
    this.name = "GitHubActionsRuntimeAuthorityPublisherError";
  }
}

interface RuntimeAuthorityDispatchEvent {
  readonly correlation: string;
  readonly request: ReturnType<typeof validateRuntimeAuthorityPublicationRequest>;
}

function required(environment: NodeJS.ProcessEnv, key: string, maximum = 16_384): string {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000\u007F]/u.test(value)) {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
  return value;
}

function parseRepository(value: string, hostname: string): GitHubChangeEffectRepository {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || part.length > 255 || !/^[A-Za-z0-9_.-]+$/u.test(part)) ||
    hostname.length === 0 ||
    hostname.length > 255 ||
    /[\u0000-\u0020\u007F/]/u.test(hostname)
  ) {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
  return Object.freeze({ hostname: hostname.toLowerCase(), owner: parts[0] as string, name: parts[1] as string });
}

function assertTrustedWorkflow(environment: NodeJS.ProcessEnv, repository: GitHubChangeEffectRepository): void {
  const repositoryName = `${repository.owner}/${repository.name}`;
  const ref = required(environment, "GITHUB_REF", 512);
  if (!ref.startsWith("refs/heads/")) throw new GitHubActionsRuntimeAuthorityPublisherError();
  const workflowRef = required(environment, "GITHUB_WORKFLOW_REF", 1_024);
  if (workflowRef !== `${repositoryName}/${WORKFLOW_PATH}@${ref}`) {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
  const workflowSha = required(environment, "GITHUB_WORKFLOW_SHA", 64);
  if (!COMMIT_SHA.test(workflowSha)) throw new GitHubActionsRuntimeAuthorityPublisherError();
  let checkedOutSha: string;
  try {
    checkedOutSha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
  if (!COMMIT_SHA.test(checkedOutSha) || checkedOutSha.toLowerCase() !== workflowSha.toLowerCase()) {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
}

async function readDispatchEvent(environment: NodeJS.ProcessEnv): Promise<RuntimeAuthorityDispatchEvent> {
  const eventName = required(environment, "GITHUB_EVENT_NAME", 64);
  if (eventName !== "repository_dispatch") throw new GitHubActionsRuntimeAuthorityPublisherError();
  const eventPath = required(environment, "GITHUB_EVENT_PATH", 4_096);
  let handle;
  try {
    handle = await open(eventPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_EVENT_BYTES) {
      throw new GitHubActionsRuntimeAuthorityPublisherError();
    }
    const source = await handle.readFile("utf8");
    const event = parseRecord(JSON.parse(source) as unknown);
    if (event.action !== RUNTIME_AUTHORITY_PUBLICATION_EVENT) throw new Error();
    const payload = parseRecord(event.client_payload);
    if (Object.keys(payload).some((key) => !["correlation", "request"].includes(key))) throw new Error();
    if (typeof payload.correlation !== "string" || !CORRELATION.test(payload.correlation)) throw new Error();
    return Object.freeze({
      correlation: payload.correlation,
      request: validateRuntimeAuthorityPublicationRequest(payload.request),
    });
  } catch {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
  return value as Record<string, unknown>;
}

async function assertDefaultBranchRef(
  environment: NodeJS.ProcessEnv,
  repository: GitHubChangeEffectRepository,
  bootstrap: GitHubActionsApiTransport,
): Promise<void> {
  const response = await bootstrap.request({
    hostname: repository.hostname,
    method: "GET",
    path: `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
  });
  if (response.status !== 200) throw new GitHubActionsRuntimeAuthorityPublisherError();
  const body = parseRecord(response.body);
  if (
    typeof body.default_branch !== "string" ||
    required(environment, "GITHUB_REF", 512) !== `refs/heads/${body.default_branch}`
  ) {
    throw new GitHubActionsRuntimeAuthorityPublisherError();
  }
}

export async function runGitHubActionsRuntimeAuthorityPublisher(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const event = await readDispatchEvent(environment);
    const repositoryName = required(environment, "GITHUB_REPOSITORY", 512);
    const serverUrl = required(environment, "GITHUB_SERVER_URL", 2_048);
    const hostname = new URL(serverUrl).hostname;
    const repository = parseRepository(repositoryName, hostname);
    assertTrustedWorkflow(environment, repository);
    const bootstrap = new GitHubActionsApiTransport({
      apiUrl: environment.GITHUB_API_URL ?? "https://api.github.com",
      token: required(environment, "GITHUB_TOKEN", 4_096),
      failureStage: "repository-evidence",
    });
    await assertDefaultBranchRef(environment, repository, bootstrap);
    const resolved = await resolveGitHubRepository(repository, bootstrap);
    if (resolved.fork) throw new GitHubActionsRuntimeAuthorityPublisherError();
    const target: RepositoryIdentity = resolved.target;
    const broker = new GitHubAppInstallationCredentialBroker({
      appId: required(environment, "INARI_ISSUER_APP_ID", 64),
      installationId: required(environment, "INARI_ISSUER_INSTALLATION_ID", 64),
      privateKeyPem: required(environment, "INARI_ISSUER_APP_PRIVATE_KEY", 16_384),
      repository,
      ...(resolved.repositoryNodeId === undefined ? {} : { repositoryNodeId: resolved.repositoryNodeId }),
      apiUrl: environment.GITHUB_API_URL ?? "https://api.github.com",
    });
    const result = await publishRuntimeAuthority(event.request, target, broker);
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return 0;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "RUNTIME_AUTHORITY_PUBLICATION_RUNTIME_FAILED", message: "Trusted Runtime Authority publication failed closed." } })}\n`,
    );
    return 1;
  }
}

if (process.env.GITHUB_ACTIONS === "true") {
  runGitHubActionsRuntimeAuthorityPublisher().then((status) => {
    process.exitCode = status;
  });
}
