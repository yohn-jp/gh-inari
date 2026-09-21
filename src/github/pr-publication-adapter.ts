/**
 * GitHub provider adapter for the provider-neutral PR publication kernel.
 * It deliberately exposes only list/read/create and keeps repository context
 * and native response parsing inside GitHubAdapter.
 */

import type { ChangeExecutionDeadline } from "../change-execution-port.js";
import type {
  PrPublicationCreateInput,
  PrPublicationListQuery,
  PrPublicationProvider,
  PrPublicationRecord,
  PrPublicationRepositoryIdentity,
} from "../pr-publication.js";
import type { GitHubPullRequest } from "./types.js";

export interface GitHubPrPublicationAdapterOptions {
  readonly deadline?: ChangeExecutionDeadline;
}

/** Existing user-context adapter seam; no publication-specific credentials enter it. */
export interface GitHubPrPublicationApi {
  getRepositoryContext(deadline?: ChangeExecutionDeadline): Promise<{
    readonly hostname: string;
    readonly nameWithOwner: string;
    readonly repositoryId?: string;
  }>;
  listPullRequests(
    head: string,
    base: string,
    deadline?: ChangeExecutionDeadline,
  ): Promise<readonly GitHubPullRequest[]>;
  getPullRequest(number: number, deadline?: ChangeExecutionDeadline): Promise<GitHubPullRequest>;
  createPullRequestPublication(
    input: {
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
      readonly draft?: boolean;
      readonly maintainerCanModify?: boolean;
    },
    deadline?: ChangeExecutionDeadline,
  ): Promise<GitHubPullRequest>;
}

function repositoryIdentity(
  context: Awaited<ReturnType<GitHubPrPublicationApi["getRepositoryContext"]>>,
): PrPublicationRepositoryIdentity {
  if (context.repositoryId === undefined) throw new Error("GitHub repository identity did not include a database id.");
  return {
    repositoryHost: context.hostname.toLowerCase(),
    repositoryId: context.repositoryId,
    repository: context.nameWithOwner,
  };
}

function record(value: GitHubPullRequest, repository: PrPublicationRepositoryIdentity): PrPublicationRecord {
  return {
    number: value.number,
    url: value.url,
    title: value.title,
    body: value.body,
    head: value.head,
    base: value.base,
    ...(value.headSha === undefined ? {} : { headRevision: value.headSha }),
    repository,
    ...(value.draft === undefined ? {} : { draft: value.draft }),
  };
}

export class GitHubPrPublicationAdapter implements PrPublicationProvider {
  private readonly adapter: GitHubPrPublicationApi;
  private readonly deadline: ChangeExecutionDeadline | undefined;

  constructor(adapter: GitHubPrPublicationApi, options: GitHubPrPublicationAdapterOptions = {}) {
    if (adapter === undefined || typeof adapter.getRepositoryContext !== "function")
      throw new TypeError("A GitHub repository adapter is required.");
    this.adapter = adapter;
    this.deadline = options.deadline;
  }

  async getRepositoryIdentity(): Promise<PrPublicationRepositoryIdentity> {
    return repositoryIdentity(await this.adapter.getRepositoryContext(this.deadline));
  }

  async listPullRequests(query: PrPublicationListQuery): Promise<readonly PrPublicationRecord[]> {
    const repository = await this.getRepositoryIdentity();
    if (
      repository.repositoryHost !== query.repository.repositoryHost.toLowerCase() ||
      repository.repositoryId !== query.repository.repositoryId
    )
      throw new Error("Publication repository does not match the GitHub adapter context.");
    const values = await this.adapter.listPullRequests(query.head, query.base, this.deadline);
    return values.map((value) => record(value, repository));
  }

  async readPullRequest(number: number): Promise<PrPublicationRecord> {
    const repository = await this.getRepositoryIdentity();
    return record(await this.adapter.getPullRequest(number, this.deadline), repository);
  }

  async createPullRequest(input: PrPublicationCreateInput): Promise<PrPublicationRecord> {
    const repository = await this.getRepositoryIdentity();
    if (
      repository.repositoryHost !== input.repository.repositoryHost.toLowerCase() ||
      repository.repositoryId !== input.repository.repositoryId
    )
      throw new Error("Publication repository does not match the GitHub adapter context.");
    const created = await this.adapter.createPullRequestPublication(
      {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        ...(input.draft === undefined ? {} : { draft: input.draft }),
        ...(input.maintainerCanModify === undefined ? {} : { maintainerCanModify: input.maintainerCanModify }),
      },
      this.deadline,
    );
    return record(created, repository);
  }
}

/** Spelling alias for callers that use the GitHub PR acronym. */
export const GitHubPRPublicationAdapter = GitHubPrPublicationAdapter;
