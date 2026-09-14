/**
 * Shared #464-backed repository-read evidence adapter.
 *
 * Converts one #464 pre-admission repository-read capability into the
 * provider-neutral reader shapes existing Core/governance authorities
 * already accept (`DelegatorSourceReader`, a superset of
 * `RepositoryGovernanceSourceReader`). This module owns acquisition only:
 * bounded GitHub REST reads and their field validation. It performs no
 * Runtime trust, Session, capability admission, Change, or governance
 * semantics of its own -- those remain owned by the existing authorities
 * that consume the reader this module produces.
 */

import type {
  GitHubAppRepositoryReadCapability,
  GitHubAppRepositoryReadTransport,
} from "./app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";
import type { RepositoryContext, RepositoryTree, RepositoryTreeEntry, GitHubBranch } from "./types.js";
import type { DelegatorSourceReader } from "../agent-authority/delegator-trust.js";
import type { RepositoryIdentity } from "./effect-authorizer.js";

const MAX_REPOSITORY_REF_LENGTH = 255;
const MAX_REPOSITORY_SHA_LENGTH = 128;
const MAX_BLOB_CONTENT_LENGTH = 1_048_576;
const SAFE_REPOSITORY_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const BASE64_CONTENT_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class AppRepositoryEvidenceReaderError extends Error {
  readonly code = "APP_REPOSITORY_EVIDENCE_READ_FAILED" as const;

  constructor() {
    super("Trusted App repository evidence read failed closed.");
    this.name = "AppRepositoryEvidenceReaderError";
  }
}

function fail(): never {
  throw new AppRepositoryEvidenceReaderError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedProviderText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_REPOSITORY_TEXT.test(value);
}

async function readProvider(
  transport: GitHubAppRepositoryReadTransport,
  repository: GitHubChangeEffectRepository,
  path: string,
): Promise<Record<string, unknown>> {
  let response: { readonly status: number; readonly body?: unknown };
  try {
    response = await transport.request({ hostname: repository.hostname, method: "GET", path });
  } catch {
    fail();
  }
  if (response.status !== 200 || !isRecord(response.body)) fail();
  return response.body;
}

function repositoryPath(repository: GitHubChangeEffectRepository, suffix = ""): string {
  const root = `repos/${repository.owner}/${repository.name}`;
  return suffix.length === 0 ? root : `${root}/${suffix}`;
}

/**
 * Build a provider-neutral repository evidence reader over one #464
 * pre-admission read capability. The returned reader satisfies both
 * `DelegatorSourceReader` (Runtime trust resolution) and the
 * narrower `RepositoryGovernanceSourceReader` (governed Issue/PR template
 * evidence) -- the same acquisition surface, reused by every consumer that
 * only needs bounded repository-default-branch reads.
 */
export function createRepositoryEvidenceReader(
  transport: GitHubAppRepositoryReadTransport,
  repository: GitHubChangeEffectRepository,
  identity: RepositoryIdentity,
): DelegatorSourceReader {
  const context: RepositoryContext = repositoryContext(identity);
  return {
    resolveRepositoryContext: async () => context,
    getRepositoryDefaultBranch: async () => {
      const body = await readProvider(transport, repository, repositoryPath(repository));
      if (!isBoundedProviderText(body.default_branch, MAX_REPOSITORY_REF_LENGTH)) fail();
      return body.default_branch;
    },
    findBranch: async (branch: string): Promise<GitHubBranch | undefined> => {
      if (!isBoundedProviderText(branch, MAX_REPOSITORY_REF_LENGTH)) fail();
      let response: { readonly status: number; readonly body?: unknown };
      try {
        response = await transport.request({
          hostname: repository.hostname,
          method: "GET",
          path: repositoryPath(repository, `git/ref/heads/${encodeURIComponent(branch)}`),
        });
      } catch {
        fail();
      }
      if (response.status === 404) return undefined;
      if (response.status !== 200 || !isRecord(response.body)) fail();
      const body = response.body;
      if (
        body.ref !== `refs/heads/${branch}` ||
        !isRecord(body.object) ||
        body.object.type !== "commit" ||
        !isBoundedProviderText(body.object.sha, MAX_REPOSITORY_SHA_LENGTH)
      ) {
        fail();
      }
      return { name: branch, ref: body.ref, sha: body.object.sha };
    },
    getRepositoryTree: async (ref: string): Promise<RepositoryTree> => {
      if (!isBoundedProviderText(ref, MAX_REPOSITORY_SHA_LENGTH)) fail();
      const body = await readProvider(
        transport,
        repository,
        repositoryPath(repository, `git/trees/${encodeURIComponent(ref)}?recursive=1`),
      );
      if (body.truncated !== false || !isBoundedProviderText(body.sha, MAX_REPOSITORY_SHA_LENGTH)) fail();
      if (!Array.isArray(body.tree)) fail();
      const entries: RepositoryTreeEntry[] = body.tree.map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          !isBoundedProviderText(entry.path, MAX_REPOSITORY_REF_LENGTH) ||
          !isBoundedProviderText(entry.sha, MAX_REPOSITORY_SHA_LENGTH) ||
          (entry.type !== "blob" && entry.type !== "tree")
        ) {
          fail();
        }
        return { path: entry.path, type: entry.type, sha: entry.sha };
      });
      return { sha: body.sha, entries };
    },
    getRepositoryBlob: async (sha: string): Promise<string> => {
      if (!isBoundedProviderText(sha, MAX_REPOSITORY_SHA_LENGTH)) fail();
      const body = await readProvider(
        transport,
        repository,
        repositoryPath(repository, `git/blobs/${encodeURIComponent(sha)}`),
      );
      if (
        body.sha !== sha ||
        body.encoding !== "base64" ||
        typeof body.content !== "string" ||
        body.content.length > MAX_BLOB_CONTENT_LENGTH
      ) {
        fail();
      }
      const content = body.content.replace(/\s/gu, "");
      if (!BASE64_CONTENT_PATTERN.test(content)) fail();
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(content, "base64"));
      } catch {
        fail();
      }
    },
  };
}

/** Build the same reader over a credential-bound App read capability. */
export function createAppRepositoryEvidenceReader(
  capability: GitHubAppRepositoryReadCapability,
  repository: GitHubChangeEffectRepository,
  identity: RepositoryIdentity,
): DelegatorSourceReader {
  return createRepositoryEvidenceReader(capability.transport, repository, identity);
}

function repositoryContext(identity: RepositoryIdentity): RepositoryContext {
  const parts = identity.nameWithOwner.split("/");
  if (parts.length !== 2) fail();
  const owner = parts[0] as string;
  const name = parts[1] as string;
  return Object.freeze({
    hostname: identity.repositoryHost,
    host: identity.repositoryHost,
    owner,
    name,
    nameWithOwner: identity.nameWithOwner,
    url: `https://${identity.repositoryHost}/${identity.nameWithOwner}`,
    repositoryId: identity.repositoryId,
  });
}
