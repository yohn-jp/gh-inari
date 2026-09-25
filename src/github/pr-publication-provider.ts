import type { AppProviderCredentialBroker } from "./app-provider-credential-broker.js";
import type { GitHubAppRepositoryReadCapability } from "./app-installation-credential-broker.js";
import {
  InariEffectAuthorizer,
  type RepositoryIdentity,
  type SessionTrustedExecutionContext,
} from "./effect-authorizer.js";
import type {
  PrPublicationCreateInput,
  PrPublicationListQuery,
  PrPublicationProvider,
  PrPublicationRecord,
  PrPublicationRepositoryIdentity,
} from "../pr-publication.js";

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
