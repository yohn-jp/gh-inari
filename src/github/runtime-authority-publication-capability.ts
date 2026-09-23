import type { GitHubBranchAdvanceCapability } from "./git-data-capability.js";
import type { AppInstallationScope, RepositoryIdentity } from "./effect-authorizer.js";
import type {
  GitHubChangeEffectJsonObject,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";

export interface RuntimeAuthorityPullRequest {
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

export interface RuntimeAuthorityBranchComparison {
  readonly aheadBy: number;
  readonly changedPaths: readonly string[];
}

/** Purpose limited Issuer capability for one public Runtime Authority record. */
export interface RuntimeAuthorityPublicationCapability {
  readonly scope: AppInstallationScope;
  readonly gitData: GitHubBranchAdvanceCapability;
  getDefaultBranch(): Promise<{ readonly name: string; readonly sha: string }>;
  createBranch(branch: string, commitSha: string): Promise<void>;
  compareBranch(base: string, head: string): Promise<RuntimeAuthorityBranchComparison>;
  findPullRequests(branch: string, base: string): Promise<readonly RuntimeAuthorityPullRequest[]>;
  readPullRequestFiles(pullRequest: number): Promise<readonly string[]>;
  createPullRequest(input: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<RuntimeAuthorityPullRequest>;
}

export interface RuntimeAuthorityPublicationBroker {
  withRuntimeAuthorityPublicationCapability<T>(
    request: { readonly target: RepositoryIdentity },
    operation: (capability: RuntimeAuthorityPublicationCapability) => Promise<T>,
  ): Promise<T>;
}

export class RuntimeAuthorityPublicationCapabilityError extends Error {
  constructor() {
    super("Runtime Authority publication capability failed closed.");
    this.name = "RuntimeAuthorityPublicationCapabilityError";
  }
}

/** API facade with only the repository reads and writes needed by publication. */
export class GitHubRuntimeAuthorityPublicationCapability implements RuntimeAuthorityPublicationCapability {
  readonly scope: AppInstallationScope;
  readonly gitData: GitHubBranchAdvanceCapability;
  readonly #transport: Pick<GitHubChangeEffectTransport, "request">;
  readonly #repository: Readonly<{ hostname: string; owner: string; name: string; nameWithOwner: string }>;

  constructor(options: {
    readonly scope: AppInstallationScope;
    readonly gitData: GitHubBranchAdvanceCapability;
    readonly transport: Pick<GitHubChangeEffectTransport, "request">;
    readonly repository: Readonly<{ hostname: string; owner: string; name: string; nameWithOwner: string }>;
  }) {
    this.scope = options.scope;
    this.gitData = options.gitData;
    this.#transport = options.transport;
    this.#repository = Object.freeze({ ...options.repository });
  }

  async getDefaultBranch(): Promise<{ readonly name: string; readonly sha: string }> {
    const repository = asRecord(await this.request("GET", this.repositoryPath(), undefined, 200));
    if (
      String(repository.id) !== this.scope.repository.repositoryId ||
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== this.#repository.nameWithOwner.toLowerCase() ||
      typeof repository.default_branch !== "string" ||
      !safeRefName(repository.default_branch)
    ) {
      throw new RuntimeAuthorityPublicationCapabilityError();
    }
    const ref = asRecord(
      await this.request(
        "GET",
        `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`,
        undefined,
        200,
      ),
    );
    if (
      ref.ref !== `refs/heads/${repository.default_branch}` ||
      !isRecord(ref.object) ||
      ref.object.type !== "commit" ||
      !validSha(ref.object.sha)
    ) {
      throw new RuntimeAuthorityPublicationCapabilityError();
    }
    return Object.freeze({ name: repository.default_branch, sha: ref.object.sha });
  }

  async createBranch(branch: string, commitSha: string): Promise<void> {
    if (!validCanonicalBranch(branch) || !validSha(commitSha)) throw new RuntimeAuthorityPublicationCapabilityError();
    await this.request(
      "POST",
      `${this.repositoryPath()}/git/refs`,
      { ref: `refs/heads/${branch}`, sha: commitSha },
      201,
    );
  }

  async compareBranch(base: string, head: string): Promise<RuntimeAuthorityBranchComparison> {
    if (!safeRefName(base) || !validCanonicalBranch(head)) throw new RuntimeAuthorityPublicationCapabilityError();
    const comparison = asRecord(
      await this.request(
        "GET",
        `${this.repositoryPath()}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        undefined,
        200,
      ),
    );
    if (
      !Number.isSafeInteger(comparison.ahead_by) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length > 300
    ) {
      throw new RuntimeAuthorityPublicationCapabilityError();
    }
    const changedPaths = comparison.files.map((file) => {
      if (!isRecord(file) || typeof file.filename !== "string" || !safeRepositoryPath(file.filename)) {
        throw new RuntimeAuthorityPublicationCapabilityError();
      }
      return file.filename;
    });
    return Object.freeze({ aheadBy: comparison.ahead_by as number, changedPaths: Object.freeze(changedPaths) });
  }

  async findPullRequests(branch: string, base: string): Promise<readonly RuntimeAuthorityPullRequest[]> {
    if (!validCanonicalBranch(branch) || !safeRefName(base)) throw new RuntimeAuthorityPublicationCapabilityError();
    const owner = this.#repository.owner;
    const head = encodeURIComponent(`${owner}:${branch}`);
    const response = await this.request(
      "GET",
      `${this.repositoryPath()}/pulls?state=open&per_page=100&head=${head}&base=${encodeURIComponent(base)}`,
      undefined,
      200,
    );
    if (!Array.isArray(response) || response.length > 100) throw new RuntimeAuthorityPublicationCapabilityError();
    return Object.freeze(response.map((value) => parsePullRequest(value, this.#repository)));
  }

  async readPullRequestFiles(pullRequest: number): Promise<readonly string[]> {
    if (!positiveInteger(pullRequest)) throw new RuntimeAuthorityPublicationCapabilityError();
    const response = await this.request(
      "GET",
      `${this.repositoryPath()}/pulls/${pullRequest}/files?per_page=100`,
      undefined,
      200,
    );
    if (!Array.isArray(response) || response.length > 100) throw new RuntimeAuthorityPublicationCapabilityError();
    const paths = response.map((value) => {
      if (!isRecord(value) || typeof value.filename !== "string" || !safeRepositoryPath(value.filename)) {
        throw new RuntimeAuthorityPublicationCapabilityError();
      }
      return value.filename;
    });
    return Object.freeze(paths);
  }

  async createPullRequest(input: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }): Promise<RuntimeAuthorityPullRequest> {
    if (
      !isRecord(input) ||
      !validCanonicalBranch(input.head) ||
      !safeRefName(input.base) ||
      !safeText(input.title, 256) ||
      !safeText(input.body, 32_768)
    ) {
      throw new RuntimeAuthorityPublicationCapabilityError();
    }
    const response = await this.request(
      "POST",
      `${this.repositoryPath()}/pulls`,
      { head: input.head, base: input.base, title: input.title, body: input.body, draft: false },
      201,
    );
    return parsePullRequest(response, this.#repository);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: GitHubChangeEffectJsonObject | undefined,
    expectedStatus: number,
  ): Promise<unknown> {
    let response: GitHubChangeEffectResponse;
    try {
      response = await this.#transport.request({
        hostname: this.#repository.hostname,
        method,
        path,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new RuntimeAuthorityPublicationCapabilityError();
    }
    if (response.status !== expectedStatus) throw new RuntimeAuthorityPublicationCapabilityError();
    return response.body;
  }

  private repositoryPath(): string {
    return `repos/${encodeURIComponent(this.#repository.owner)}/${encodeURIComponent(this.#repository.name)}`;
  }
}

function parsePullRequest(
  value: unknown,
  repository: Readonly<{ hostname: string; nameWithOwner: string }>,
): RuntimeAuthorityPullRequest {
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.base) || !isRecord(value.user)) {
    throw new RuntimeAuthorityPublicationCapabilityError();
  }
  const url = value.html_url;
  let parsedUrl: URL;
  try {
    if (typeof url !== "string") throw new Error();
    parsedUrl = new URL(url);
  } catch {
    throw new RuntimeAuthorityPublicationCapabilityError();
  }
  if (
    !positiveInteger(value.number) ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.draft !== "boolean" ||
    typeof value.head.ref !== "string" ||
    !isRecord(value.head.repo) ||
    typeof value.head.repo.full_name !== "string" ||
    typeof value.base.ref !== "string" ||
    typeof value.user.login !== "string" ||
    !Number.isSafeInteger(value.changed_files) ||
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname.toLowerCase() !== repository.hostname.toLowerCase()
  ) {
    throw new RuntimeAuthorityPublicationCapabilityError();
  }
  return Object.freeze({
    number: value.number,
    url: parsedUrl.toString(),
    title: value.title,
    body: value.body,
    state: value.state,
    draft: value.draft,
    headBranch: value.head.ref,
    headRepository: value.head.repo.full_name,
    baseBranch: value.base.ref,
    author: value.user.login,
    changedFiles: value.changed_files as number,
  });
}

function safeRefName(value: unknown): value is string {
  return (
    typeof value === "string" &&
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

function validCanonicalBranch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // The trust branch is derived by the publisher from Issue #1066 and an ID hash.
  return /^feat\/1066-runtime-authority-bootstrap-[0-9a-f]{16}$/u.test(value);
}

function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001F\u007F\\]/u.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RuntimeAuthorityPublicationCapabilityError();
  return value;
}
