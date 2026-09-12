/**
 * Narrow Git data capability used by Session-authorized branch advancement.
 *
 * This is deliberately not a GitHub client.  It exposes only the Git object
 * operations and authoritative reads required by one bounded branch write;
 * the credential-bound implementation remains inside the App broker.
 */

import {
  type GitHubChangeEffectRepository,
  type GitHubChangeEffectResponse,
  type GitHubChangeEffectJsonObject,
  type GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import { MAX_CHANGE_BRANCH_LENGTH } from "../change.js";
import type { IssuerInstallationScope } from "./issuer-authority.js";
import { validateBranchName } from "../../branch-naming-authority.mjs";
import { classifyRepositoryPath } from "../agent-authority/protected-paths.js";

export const GIT_DATA_CAPABILITY_VERSION = 1 as const;
export type GitDataCapabilityVersion = typeof GIT_DATA_CAPABILITY_VERSION;

export const GIT_DATA_WRITE_MODES = Object.freeze(["100644", "100755", "120000"] as const);
export type GitDataWriteMode = (typeof GIT_DATA_WRITE_MODES)[number];

export type GitDataObjectType = "blob" | "tree" | "commit";

export interface GitDataRef {
  readonly name: string;
  readonly ref: string;
  readonly sha: string;
}

export interface GitDataTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: GitDataObjectType;
  readonly sha: string;
}

export interface GitDataTree {
  readonly sha: string;
  readonly entries: readonly GitDataTreeEntry[];
}

export interface GitDataBlobInput {
  /** Unpadded or padded base64 content; the provider receives base64. */
  readonly content: string;
}

export interface GitDataTreeWriteEntry {
  readonly path: string;
  readonly mode: GitDataWriteMode;
  readonly type: "blob";
  /** `null` deletes the path from the base tree. */
  readonly sha: string | null;
}

export interface GitDataTreeInput {
  readonly baseTreeSha: string;
  readonly entries: readonly GitDataTreeWriteEntry[];
}

export interface GitDataCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface GitDataCommitInput {
  readonly message: string;
  readonly treeSha: string;
  readonly parents: readonly string[];
  readonly author: GitDataCommitAuthor;
}

export interface GitDataRefUpdateInput {
  readonly branch: string;
  readonly beforeOid: string;
  readonly afterOid: string;
  readonly force: false;
}

export interface GitDataRefUpdateResult {
  readonly status: "updated" | "rejected";
}

/** The only App-internal Git surface used by branch advancement. */
export interface GitHubBranchAdvanceCapability {
  readonly scope: IssuerInstallationScope;
  readRef(branch: string): Promise<GitDataRef | undefined>;
  readCommit(sha: string): Promise<{ readonly sha: string; readonly treeSha: string }>;
  readTree(refOrSha: string): Promise<GitDataTree>;
  createBlob(input: GitDataBlobInput): Promise<{ readonly sha: string }>;
  createTree(input: GitDataTreeInput): Promise<{ readonly sha: string }>;
  createCommit(
    input: Omit<GitDataCommitInput, "author"> & { readonly author?: GitDataCommitAuthor },
  ): Promise<{ readonly sha: string }>;
  compareAndAdvanceRef(input: GitDataRefUpdateInput): Promise<GitDataRefUpdateResult>;
}

export interface GitDataCapability {
  readonly version: GitDataCapabilityVersion;
  readonly scope: IssuerInstallationScope;
  readRef(branch: string): Promise<GitDataRef | undefined>;
  readTree(refOrSha: string): Promise<GitDataTree>;
  createBlob(input: GitDataBlobInput): Promise<{ readonly sha: string }>;
  createTree(input: GitDataTreeInput): Promise<{ readonly sha: string }>;
  createCommit(input: GitDataCommitInput): Promise<{ readonly sha: string }>;
  updateRefs(input: GitDataRefUpdateInput): Promise<GitDataRefUpdateResult>;
}

export interface GitDataGraphqlRequest {
  readonly query: string;
  readonly variables: {
    readonly [key: string]:
      | string
      | number
      | boolean
      | null
      | readonly GitDataGraphqlValue[]
      | { readonly [key: string]: GitDataGraphqlValue };
  };
}

type GitDataGraphqlValue =
  string | number | boolean | null | readonly GitDataGraphqlValue[] | { readonly [key: string]: GitDataGraphqlValue };

export interface GitDataCapabilityTransport extends Pick<GitHubChangeEffectTransport, "request"> {
  requestGraphql(request: GitDataGraphqlRequest): Promise<GitHubChangeEffectResponse>;
}

export interface GitHubGitDataCapabilityOptions {
  readonly repository: GitHubChangeEffectRepository;
  readonly repositoryId: string;
  /** Provider node ID is retained only inside the credential-bound facade. */
  readonly repositoryNodeId: string;
  readonly scope: IssuerInstallationScope;
  readonly transport: GitDataCapabilityTransport;
}

const UPDATE_REFS_MUTATION =
  "mutation ConditionalUpdateRefs($input: UpdateRefsInput!) { " + "updateRefs(input: $input) { clientMutationId } }";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATH_MAX = 4_096;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

export class GitDataCapabilityError extends Error {
  readonly code = "GIT_DATA_CAPABILITY_FAILED" as const;

  constructor() {
    super("Git data capability operation failed closed.");
    this.name = "GitDataCapabilityError";
  }
}

/** Credential-free facade over one broker-owned GitHub transport. */
export class GitHubGitDataCapability implements GitDataCapability {
  readonly version = GIT_DATA_CAPABILITY_VERSION;
  readonly scope: IssuerInstallationScope;
  readonly #repository: GitHubChangeEffectRepository;
  readonly #repositoryNodeId: string;
  readonly #transport: GitDataCapabilityTransport;

  constructor(options: GitHubGitDataCapabilityOptions) {
    if (
      !isRecord(options) ||
      !isRecord(options.repository) ||
      !validText(options.repository.hostname, 255) ||
      !validText(options.repository.owner, 255) ||
      !validText(options.repository.name, 255) ||
      !validRepositoryId(options.repositoryId) ||
      !validNodeId(options.repositoryNodeId) ||
      !isRecord(options.scope) ||
      !isRecord(options.scope.repository) ||
      options.scope.repository.repositoryId !== options.repositoryId ||
      !isRecord(options.transport) ||
      typeof options.transport.request !== "function" ||
      typeof options.transport.requestGraphql !== "function"
    ) {
      throw new GitDataCapabilityError();
    }
    this.#repository = Object.freeze({ ...options.repository });
    this.#repositoryNodeId = options.repositoryNodeId;
    this.scope = options.scope;
    this.#transport = options.transport;
  }

  async readRef(branch: string): Promise<GitDataRef | undefined> {
    assertBranch(branch);
    let response: GitHubChangeEffectResponse;
    try {
      response = await this.#transport.request({
        hostname: this.#repository.hostname,
        method: "GET",
        path: `${this.repositoryPath()}/git/ref/heads/${encodeURIComponent(branch)}`,
      });
    } catch {
      throw new GitDataCapabilityError();
    }
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new GitDataCapabilityError();
    const body = responseRecord(response.body);
    if (
      body.ref !== `refs/heads/${branch}` ||
      !isRecord(body.object) ||
      body.object.type !== "commit" ||
      !validSha(body.object.sha)
    ) {
      throw new GitDataCapabilityError();
    }
    return Object.freeze({ name: branch, ref: body.ref, sha: body.object.sha });
  }

  async readTree(refOrSha: string): Promise<GitDataTree> {
    assertRefOrSha(refOrSha);
    const body = await this.#request(
      "GET",
      `${this.repositoryPath()}/git/trees/${encodeURIComponent(refOrSha)}?recursive=1`,
      undefined,
      200,
    );
    if (body.truncated !== false || !validSha(body.sha) || !Array.isArray(body.tree)) {
      throw new GitDataCapabilityError();
    }
    const entries = body.tree.map((entry: unknown) => parseTreeEntry(entry));
    return Object.freeze({ sha: body.sha, entries: Object.freeze(entries) });
  }

  async readCommit(sha: string): Promise<{ readonly sha: string; readonly treeSha: string }> {
    if (!validSha(sha)) throw new GitDataCapabilityError();
    const body = await this.#request("GET", `${this.repositoryPath()}/git/commits/${sha}`, undefined, 200);
    if (body.sha !== sha || !isRecord(body.tree) || !validSha(body.tree.sha)) throw new GitDataCapabilityError();
    return Object.freeze({ sha, treeSha: body.tree.sha });
  }

  async createBlob(input: GitDataBlobInput): Promise<{ readonly sha: string }> {
    if (!isRecord(input) || typeof input.content !== "string" || !validBase64(input.content)) {
      throw new GitDataCapabilityError();
    }
    const body = await this.#request(
      "POST",
      `${this.repositoryPath()}/git/blobs`,
      { content: input.content, encoding: "base64" },
      201,
    );
    const sha = bodyRecordSha(body);
    return Object.freeze({ sha });
  }

  async createTree(input: GitDataTreeInput): Promise<{ readonly sha: string }> {
    if (!isRecord(input) || !validSha(input.baseTreeSha) || !Array.isArray(input.entries)) {
      throw new GitDataCapabilityError();
    }
    if (input.entries.length === 0 || input.entries.length > 4_096) throw new GitDataCapabilityError();
    const entries = input.entries.map((entry) => {
      if (
        !isRecord(entry) ||
        !validPath(entry.path) ||
        !GIT_DATA_WRITE_MODES.includes(entry.mode as GitDataWriteMode) ||
        entry.type !== "blob" ||
        (entry.sha !== null && !validSha(entry.sha))
      ) {
        throw new GitDataCapabilityError();
      }
      return { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha };
    });
    const body = await this.#request(
      "POST",
      `${this.repositoryPath()}/git/trees`,
      { base_tree: input.baseTreeSha, tree: entries },
      201,
    );
    return Object.freeze({ sha: bodyRecordSha(body) });
  }

  async createCommit(
    input: GitDataCommitInput | (Omit<GitDataCommitInput, "author"> & { readonly author?: GitDataCommitAuthor }),
  ): Promise<{ readonly sha: string }> {
    if (
      !isRecord(input) ||
      !validText(input.message, 4_096) ||
      !validSha(input.treeSha) ||
      !Array.isArray(input.parents) ||
      input.parents.length !== 1 ||
      !validSha(input.parents[0]) ||
      (input.author !== undefined &&
        (!isRecord(input.author) || !validText(input.author.name, 256) || !validText(input.author.email, 320)))
    ) {
      throw new GitDataCapabilityError();
    }
    const body = await this.#request(
      "POST",
      `${this.repositoryPath()}/git/commits`,
      {
        message: input.message,
        tree: input.treeSha,
        parents: input.parents,
        ...(input.author === undefined ? {} : { author: { name: input.author.name, email: input.author.email } }),
      },
      201,
    );
    return Object.freeze({ sha: bodyRecordSha(body) });
  }

  async updateRefs(input: GitDataRefUpdateInput): Promise<GitDataRefUpdateResult> {
    if (
      !isRecord(input) ||
      !validBranch(input.branch) ||
      !validSha(input.beforeOid) ||
      !validSha(input.afterOid) ||
      input.force !== false
    ) {
      throw new GitDataCapabilityError();
    }
    let response: GitHubChangeEffectResponse;
    try {
      response = await this.#transport.requestGraphql({
        query: UPDATE_REFS_MUTATION,
        variables: {
          input: {
            repositoryId: this.#repositoryNodeId,
            refUpdates: [
              {
                name: `refs/heads/${input.branch}`,
                beforeOid: input.beforeOid,
                afterOid: input.afterOid,
                force: false,
              },
            ],
          },
        },
      });
    } catch {
      throw new GitDataCapabilityError();
    }
    if (response.status !== 200) throw new GitDataCapabilityError();
    const body = responseRecord(response.body);
    if (body.errors !== undefined) {
      if (!Array.isArray(body.errors) || body.errors.length > 0) return Object.freeze({ status: "rejected" });
    }
    if (!isRecord(body.data) || !isRecord(body.data.updateRefs)) throw new GitDataCapabilityError();
    return Object.freeze({ status: "updated" });
  }

  async compareAndAdvanceRef(input: GitDataRefUpdateInput): Promise<GitDataRefUpdateResult> {
    return this.updateRefs(input);
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    expectedStatus: number,
  ): Promise<Record<string, unknown>> {
    let response: GitHubChangeEffectResponse;
    try {
      response = await this.#transport.request({
        hostname: this.#repository.hostname,
        method,
        path,
        ...(body === undefined ? {} : { body: body as GitHubChangeEffectJsonObject }),
      });
    } catch {
      throw new GitDataCapabilityError();
    }
    if (response.status !== expectedStatus) throw new GitDataCapabilityError();
    return responseRecord(response.body);
  }

  private repositoryPath(): string {
    return `repos/${this.#repository.owner}/${this.#repository.name}`;
  }
}

function parseTreeEntry(value: unknown): GitDataTreeEntry {
  if (!isRecord(value) || !validPath(value.path) || !validText(value.mode, 6) || !validSha(value.sha)) {
    throw new GitDataCapabilityError();
  }
  if (value.type !== "blob" && value.type !== "tree" && value.type !== "commit") {
    throw new GitDataCapabilityError();
  }
  return Object.freeze({
    path: value.path,
    mode: value.mode,
    type: value.type,
    sha: value.sha,
  });
}

function bodyRecordSha(value: Record<string, unknown>): string {
  if (!validSha(value.sha)) throw new GitDataCapabilityError();
  return value.sha;
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new GitDataCapabilityError();
  return value;
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value);
}

function validPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > REPOSITORY_PATH_MAX) return false;
  const classification = classifyRepositoryPath(value);
  return classification.kind !== "invalid";
}

function validBranch(value: unknown): value is string {
  return validText(value, MAX_CHANGE_BRANCH_LENGTH) && value !== "main" && validateBranchName(value).length === 0;
}

function assertBranch(value: unknown): asserts value is string {
  if (!validBranch(value)) throw new GitDataCapabilityError();
}

function assertRefOrSha(value: unknown): asserts value is string {
  if (!validText(value, MAX_CHANGE_BRANCH_LENGTH) && !validSha(value)) throw new GitDataCapabilityError();
}

function validBase64(value: string): boolean {
  return value.length <= 65_536 && BASE64_PATTERN.test(value);
}

function validRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value);
}

function validNodeId(value: unknown): value is string {
  return validText(value, 255);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
