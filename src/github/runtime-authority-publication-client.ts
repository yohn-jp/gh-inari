import { renderDelegatorArtifact } from "../agent-authority/delegator-trust.js";
import type { Delegator } from "../agent-authority/delegator.js";
import {
  createRuntimeAuthorityPublicationRequest,
  runtimeAuthorityPublicationBody,
  runtimeAuthorityPublicationBranch,
  runtimeAuthorityPublicationTitle,
  RuntimeAuthorityPublicationError,
  type RuntimeAuthorityPublicationResult,
} from "../runtime-authority-publication.js";
import type { GitHubAppRepositoryReadCapability } from "./app-installation-credential-broker.js";
import type { LocalRuntimeProfileRepository } from "../local-runtime-profile.js";

const DEFAULT_WAIT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface RuntimeAuthorityPublicationClientOptions {
  readonly capability: GitHubAppRepositoryReadCapability;
  readonly repository: LocalRuntimeProfileRepository;
  readonly authority: Delegator;
  readonly dispatch: (authority: Delegator) => Promise<void>;
  readonly maxWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Dispatch only the validated public artifact, then wait for its Issuer PR. */
export async function publishSetupRuntimeAuthority(
  options: RuntimeAuthorityPublicationClientOptions,
): Promise<RuntimeAuthorityPublicationResult> {
  const request = createRuntimeAuthorityPublicationRequest(options.authority);
  const repository = options.repository;
  const [owner, name, extra] = repository.repositoryNameWithOwner.split("/");
  if (
    owner === undefined ||
    name === undefined ||
    extra !== undefined ||
    repository.repositoryHost !== options.capability.scope.repository.repositoryHost ||
    repository.repositoryId !== options.capability.scope.repository.repositoryId ||
    repository.repositoryNameWithOwner.toLowerCase() !== options.capability.scope.repository.nameWithOwner.toLowerCase()
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const branch = runtimeAuthorityPublicationBranch(options.authority.id);
  const artifact = renderDelegatorArtifact(options.authority);
  const title = runtimeAuthorityPublicationTitle(options.authority.id);
  const body = runtimeAuthorityPublicationBody(options.authority);
  const base = await readDefaultBranch(options.capability, repository, owner, name);
  const initial = await readPullRequests(options.capability, repository, owner, name, branch, base);
  if (initial.length > 1) throw new RuntimeAuthorityPublicationError();
  if (initial.length === 1 && initial[0] !== undefined) {
    await verifyPullRequest(
      options.capability,
      repository,
      owner,
      name,
      initial[0],
      branch,
      base,
      artifact.path,
      artifact.content,
      title,
      body,
    );
    return publicationResult("existing", options.authority, branch, initial[0]);
  }

  try {
    await options.dispatch(request.authority);
  } catch {
    throw new RuntimeAuthorityPublicationError();
  }

  const maxWaitMs = boundedWait(options.maxWaitMs ?? DEFAULT_WAIT_MS, 600_000);
  const pollIntervalMs = boundedWait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 10_000);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    const pullRequests = await readPullRequests(options.capability, repository, owner, name, branch, base);
    if (pullRequests.length > 1) throw new RuntimeAuthorityPublicationError();
    const pullRequest = pullRequests[0];
    if (pullRequest !== undefined) {
      await verifyPullRequest(
        options.capability,
        repository,
        owner,
        name,
        pullRequest,
        branch,
        base,
        artifact.path,
        artifact.content,
        title,
        body,
      );
      return publicationResult("created", options.authority, branch, pullRequest);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
  throw new RuntimeAuthorityPublicationError();
}

interface ObservedAuthorityPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headRepository: string;
  readonly baseBranch: string;
  readonly author: string;
  readonly changedFiles: number;
}

async function readDefaultBranch(
  capability: GitHubAppRepositoryReadCapability,
  repository: LocalRuntimeProfileRepository,
  owner: string,
  name: string,
): Promise<string> {
  const response = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  });
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    String(response.body.id) !== repository.repositoryId ||
    typeof response.body.default_branch !== "string" ||
    !safeRefName(response.body.default_branch)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  return response.body.default_branch;
}

async function readPullRequests(
  capability: GitHubAppRepositoryReadCapability,
  repository: LocalRuntimeProfileRepository,
  owner: string,
  name: string,
  branch: string,
  base: string,
): Promise<readonly ObservedAuthorityPullRequest[]> {
  const head = encodeURIComponent(`${owner}:${branch}`);
  const response = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=100&head=${head}&base=${encodeURIComponent(base)}`,
  });
  if (response.status !== 200 || !Array.isArray(response.body) || response.body.length > 100) {
    throw new RuntimeAuthorityPublicationError();
  }
  return Object.freeze(response.body.map(parsePullRequest));
}

async function verifyPullRequest(
  capability: GitHubAppRepositoryReadCapability,
  repository: LocalRuntimeProfileRepository,
  owner: string,
  name: string,
  pullRequest: ObservedAuthorityPullRequest,
  branch: string,
  base: string,
  artifactPath: string,
  artifactContent: string,
  title: string,
  body: string,
): Promise<void> {
  if (
    pullRequest.state !== "open" ||
    pullRequest.draft ||
    pullRequest.headBranch !== branch ||
    pullRequest.headRepository.toLowerCase() !== repository.repositoryNameWithOwner.toLowerCase() ||
    pullRequest.baseBranch !== base ||
    pullRequest.author !== "inari-issuer[bot]" ||
    pullRequest.title !== title ||
    pullRequest.body !== body ||
    pullRequest.changedFiles !== 1
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const files = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest.number}/files?per_page=100`,
  });
  if (
    files.status !== 200 ||
    !Array.isArray(files.body) ||
    files.body.length !== 1 ||
    !isRecord(files.body[0]) ||
    files.body[0].filename !== artifactPath
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const ref = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(branch)}`,
  });
  if (
    ref.status !== 200 ||
    !isRecord(ref.body) ||
    ref.body.ref !== `refs/heads/${branch}` ||
    !isRecord(ref.body.object) ||
    typeof ref.body.object.sha !== "string" ||
    !safeSha(ref.body.object.sha)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const commit = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/commits/${encodeURIComponent(ref.body.object.sha)}`,
  });
  if (
    commit.status !== 200 ||
    !isRecord(commit.body) ||
    commit.body.sha !== ref.body.object.sha ||
    !isRecord(commit.body.tree) ||
    typeof commit.body.tree.sha !== "string" ||
    !safeSha(commit.body.tree.sha)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const tree = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(commit.body.tree.sha)}?recursive=1`,
  });
  if (
    !isRecord(tree.body) ||
    tree.status !== 200 ||
    tree.body.sha !== commit.body.tree.sha ||
    tree.body.truncated !== false ||
    !Array.isArray(tree.body.tree)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const entries = tree.body.tree.filter((entry) => isRecord(entry) && entry.path === artifactPath);
  if (
    entries.length !== 1 ||
    !isRecord(entries[0]) ||
    entries[0].mode !== "100644" ||
    entries[0].type !== "blob" ||
    typeof entries[0].sha !== "string" ||
    !safeSha(entries[0].sha)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  const blob = await capability.transport.request({
    hostname: repository.repositoryHost,
    method: "GET",
    path: `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs/${encodeURIComponent(entries[0].sha)}`,
  });
  if (
    blob.status !== 200 ||
    !isRecord(blob.body) ||
    blob.body.encoding !== "base64" ||
    typeof blob.body.content !== "string"
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  let content: string;
  try {
    const normalized = blob.body.content.replace(/[ \t\r\n]+/gu, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) throw new Error();
    content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(normalized, "base64"));
  } catch {
    throw new RuntimeAuthorityPublicationError();
  }
  if (content !== artifactContent) throw new RuntimeAuthorityPublicationError();
}

function parsePullRequest(value: unknown): ObservedAuthorityPullRequest {
  if (
    !isRecord(value) ||
    !isRecord(value.head) ||
    !isRecord(value.base) ||
    !isRecord(value.user) ||
    !isRecord(value.head.repo)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  if (
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.html_url !== "string" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.draft !== "boolean" ||
    typeof value.head.ref !== "string" ||
    typeof value.head.repo.full_name !== "string" ||
    typeof value.base.ref !== "string" ||
    typeof value.user.login !== "string" ||
    typeof value.changed_files !== "number" ||
    !Number.isSafeInteger(value.changed_files)
  ) {
    throw new RuntimeAuthorityPublicationError();
  }
  let parsed: URL;
  try {
    parsed = new URL(value.html_url);
  } catch {
    throw new RuntimeAuthorityPublicationError();
  }
  if (parsed.protocol !== "https:") throw new RuntimeAuthorityPublicationError();
  return Object.freeze({
    number: value.number,
    url: parsed.toString(),
    title: value.title,
    body: value.body,
    state: value.state,
    draft: value.draft,
    headBranch: value.head.ref,
    headRepository: value.head.repo.full_name,
    baseBranch: value.base.ref,
    author: value.user.login,
    changedFiles: value.changed_files,
  });
}

function publicationResult(
  status: RuntimeAuthorityPublicationResult["status"],
  authority: Delegator,
  branch: string,
  pullRequest: ObservedAuthorityPullRequest,
): RuntimeAuthorityPublicationResult {
  return Object.freeze({
    status,
    authorityId: authority.id,
    branch,
    pullRequest: Object.freeze({ number: pullRequest.number, url: pullRequest.url }),
  });
}

function safeRefName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !/[\u0000-\u0020\u007F~^:?*\\]/u.test(value) &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.split("/").some((segment) => segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock"))
  );
}

function safeSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function boundedWait(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RuntimeAuthorityPublicationError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
