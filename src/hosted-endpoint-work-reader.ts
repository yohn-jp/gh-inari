/**
 * Hosted, read-only Endpoint work composition.
 *
 * The human-authentication boundary owns the credential. This module receives
 * only its request-scoped GET-only repository callback and adapts that callback
 * to the existing GitHub, Implementation Frontier, Change, semantic, and
 * Operational Observation authorities.
 */

import {
  createEndpointObservation,
  reconcileEndpointObservation,
  type EndpointObservationRecord,
} from "./endpoint-reconciliation.js";
import {
  tryProjectEndpointWork,
  type EndpointWorkProjection,
  type EndpointWorkProjectionDiagnostic,
  type EndpointWorkProjectionInput,
} from "./endpoint-work-projection.js";
import { ENDPOINT_READ_QUERY_LIMITS } from "./endpoint-read-query.js";
import {
  createGitHubImplementationFrontierRepository,
  composeImplementationFrontier,
} from "./implementation-frontier-composition.js";
import { normalizeChangeProjection, type ChangeExecutionPort } from "./change-execution-port.js";
import { projectChangeFromGitHubEvidence } from "./change.js";
import {
  GitHubAdapter,
  type GitHubArtifactTransport,
  type GitHubOperationalIssueEvidence,
  type GitHubOperationalPullRequestEvidence,
  type GitHubPullRequest,
  type RepositoryContext,
} from "./github/index.js";
import type { EndpointApiProjectionRequest } from "./endpoint-api.js";
import type {
  EndpointHumanRepositoryReadOperation,
  EndpointHumanRepositoryReadTransport,
} from "./github/endpoint-human-auth.js";
import { tryObserveOperationalIssue, tryObserveOperationalPullRequest } from "./operational-observation.js";
import { tryObserveSemanticPullRequest } from "./semantic-pr-observation.js";
import { GitHubChangeStateProjector } from "./github/change-state-projector.js";
import { resolveRepositoryBranchGovernance, type RepositoryGovernanceSourceReader } from "./governance.js";
import type { ChangeProjectionResult } from "./change.js";

const DEFAULT_MAX_AGE_MS = 300_000;
const DEFAULT_CWD = ".";

export const HOSTED_ENDPOINT_WORK_READER_VERSION = 1 as const;
export const HOSTED_ENDPOINT_WORK_READER_LIMITS = Object.freeze({
  maxRootIssue: ENDPOINT_READ_QUERY_LIMITS.maxRootIssue,
  maxCandidates: 1_000,
  maxConcurrency: 4,
} as const);

export type HostedEndpointWorkReaderFunction = (
  request: EndpointApiProjectionRequest,
) => Promise<EndpointWorkProjection>;

export interface HostedEndpointWorkReaderOptions {
  /** The request-scoped opaque callback emitted by #954. */
  readonly withRepositoryReadTransport?: <T>(operation: EndpointHumanRepositoryReadOperation<T>) => Promise<T>;
  /** Compatibility spelling for callers that name the capability callback. */
  readonly withRepositoryReadCapability?: <T>(operation: EndpointHumanRepositoryReadOperation<T>) => Promise<T>;
  /** An already-admitted opaque GET-only transport, useful for composition tests. */
  readonly transport?: EndpointHumanRepositoryReadTransport;
  /** Working directory is retained only for compatibility with the composition seam. */
  readonly cwd?: string;
  /** Optional existing Change read port; otherwise the repository-backed authority is used. */
  readonly changeReader?: Pick<ChangeExecutionPort, "read">;
  /** Optional existing Implementation authority evidence reader. */
  readonly implementationEvidenceReader?: (issueNumber: number) => Promise<unknown>;
  /** Injectable clock for deterministic freshness records. */
  readonly now?: () => string | Date;
  readonly maxAgeMs?: number;
}

export type HostedEndpointWorkReaderInput =
  | HostedEndpointWorkReaderOptions
  | (<T>(operation: EndpointHumanRepositoryReadOperation<T>) => Promise<T>)
  | EndpointHumanRepositoryReadTransport;

interface RepositoryReadCallback {
  <T>(operation: EndpointHumanRepositoryReadOperation<T>): Promise<T>;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveRootIssue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= HOSTED_ENDPOINT_WORK_READER_LIMITS.maxRootIssue
  );
}

function nowValue(options: HostedEndpointWorkReaderOptions): string | Date {
  return options.now?.() ?? new Date();
}

function callbackOf(input: HostedEndpointWorkReaderInput): RepositoryReadCallback {
  if (typeof input === "function") return input;
  if (isRecord(input) && typeof (input as { readonly request?: unknown }).request === "function") {
    const transport = input as unknown as EndpointHumanRepositoryReadTransport;
    return async <T>(operation: EndpointHumanRepositoryReadOperation<T>): Promise<T> => operation(transport);
  }
  if (!isRecord(input)) throw new TypeError("Hosted Endpoint work reader options are invalid.");
  const options = input as unknown as HostedEndpointWorkReaderOptions;
  const callback = options.withRepositoryReadTransport ?? options.withRepositoryReadCapability;
  if (typeof callback === "function") return callback;
  if (options.transport !== undefined && typeof options.transport.request === "function") {
    return async <T>(operation: EndpointHumanRepositoryReadOperation<T>): Promise<T> => operation(options.transport!);
  }
  throw new TypeError("Hosted Endpoint work reader requires the request-scoped repository read capability.");
}

function repositoryOf(context: RepositoryContext): {
  readonly hostname: string;
  readonly owner: string;
  readonly name: string;
} {
  return { hostname: context.hostname, owner: context.owner, name: context.name };
}

function providerTransport(callback: RepositoryReadCallback): GitHubArtifactTransport {
  return {
    request: async (request) => {
      if (request.method !== "GET") throw new Error("Hosted Endpoint work reads are GET-only.");
      return callback((transport) =>
        transport.request({ hostname: request.hostname, method: "GET", path: request.path }),
      );
    },
  };
}

function changePullRequestNumber(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const change = isRecord(value.change) ? value.change : isRecord(value.projection) ? value.projection : undefined;
  if (!isRecord(change) || !isRecord(change.projection)) return undefined;
  const pullRequest = change.projection.pullRequest;
  return typeof pullRequest === "number" && Number.isSafeInteger(pullRequest) && pullRequest >= 1
    ? pullRequest
    : undefined;
}

function unavailableDiagnostic(path: string, message: string): EndpointWorkProjectionDiagnostic {
  return { code: "ENDPOINT_WORK_PROJECTION_INVALID_OPERATIONAL_EVIDENCE", path, message };
}

function collectionStatus<T>(
  items: readonly T[],
  failures: number,
  path: string,
):
  | readonly T[]
  | {
      readonly status: "unavailable";
      readonly items: readonly T[];
      readonly diagnostics: readonly EndpointWorkProjectionDiagnostic[];
    } {
  if (failures === 0) return items.length === 0 ? [] : items;
  return {
    status: "unavailable",
    items,
    diagnostics: [unavailableDiagnostic(path, "One or more bounded provider observations were unavailable.")],
  };
}

function contextRepository(request: EndpointApiProjectionRequest): string {
  if (typeof request.repository.nameWithOwner !== "string" || request.repository.nameWithOwner.length === 0) {
    throw new Error("Endpoint repository locator is unavailable.");
  }
  return request.repository.nameWithOwner;
}

async function remoteChangeReader(
  adapter: GitHubAdapter,
  transport: EndpointHumanRepositoryReadTransport,
): Promise<Pick<ChangeExecutionPort, "read">> {
  const context = await adapter.getRepositoryContext();
  if (context.repositoryId === undefined) throw new Error("Repository identity is unavailable.");
  const repository = repositoryOf(context);
  const governance: RepositoryGovernanceSourceReader = {
    resolveRepositoryContext: async () => context,
    getRepositoryDefaultBranch: () => adapter.getRepositoryDefaultBranch(),
    getRepositoryTree: (ref) => adapter.getRepositoryTree(ref),
    getRepositoryBlob: (sha) => adapter.getRepositoryBlob(sha),
  };
  return {
    read: async (request) => {
      const branchGovernance = await resolveRepositoryBranchGovernance(governance);
      const projector = new GitHubChangeStateProjector({
        repository,
        identity: {
          repositoryHost: context.hostname,
          repositoryId: context.repositoryId!,
          rootIssue: request.issue,
        },
        branchGovernance,
        transport,
        remoteGovernance: governance,
      });
      return normalizeChangeProjection("show", projectChangeFromGitHubEvidence(await projector.read(request)));
    },
  };
}

async function readFreshness(
  adapter: GitHubAdapter,
  request: EndpointApiProjectionRequest,
  options: HostedEndpointWorkReaderOptions,
): Promise<EndpointObservationRecord<unknown>> {
  const key = `${request.repository.repositoryHost}/${request.repository.repositoryId}`;
  const initial = createEndpointObservation({ key });
  return reconcileEndpointObservation(
    initial,
    async () => {
      const branch = await adapter.getRepositoryDefaultBranch();
      const reference = await adapter.findBranch(branch);
      if (reference === undefined || reference.sha.length === 0) throw new Error("Default-branch SHA is unavailable.");
      const observedAt = nowValue(options);
      return { value: { defaultBranch: branch, revision: reference.sha }, revision: reference.sha, observedAt };
    },
    { now: nowValue(options), maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS },
  );
}

async function readOperationalIssue(
  adapter: GitHubAdapter,
  number: number,
): Promise<ReturnType<typeof tryObserveOperationalIssue>["observation"]> {
  const evidence: GitHubOperationalIssueEvidence = await adapter.observeIssue(number);
  const result = tryObserveOperationalIssue({ issue: evidence });
  if (!result.valid || result.observation === undefined) throw new Error("Operational Issue observation is invalid.");
  return result.observation;
}

async function readOperationalPullRequest(
  adapter: GitHubAdapter,
  number: number,
): Promise<ReturnType<typeof tryObserveOperationalPullRequest>["observation"]> {
  const evidence: GitHubOperationalPullRequestEvidence = await adapter.observePullRequest(number);
  const result = tryObserveOperationalPullRequest({ pullRequest: evidence });
  if (!result.valid || result.observation === undefined)
    throw new Error("Operational pull-request observation is invalid.");
  return result.observation;
}

async function readSemanticPullRequest(
  adapter: GitHubAdapter,
  context: RepositoryContext,
  number: number,
): Promise<ReturnType<typeof tryObserveSemanticPullRequest>["projection"]> {
  const pullRequest: GitHubPullRequest = await adapter.getPullRequest(number);
  const result = tryObserveSemanticPullRequest({
    pullRequest,
    repository: {
      repositoryHost: context.hostname,
      repositoryId: context.repositoryId,
      repository: context.nameWithOwner,
    },
  });
  if (!result.valid || result.projection === undefined)
    throw new Error("Semantic pull-request observation is invalid.");
  return result.projection;
}

/** Hosted Endpoint reader that composes only the explicitly rooted Frontier closure. */
export class HostedEndpointWorkReader {
  readonly #options: HostedEndpointWorkReaderOptions;
  readonly #read: RepositoryReadCallback;

  constructor(input: HostedEndpointWorkReaderInput) {
    this.#options = isRecord(input) ? (input as HostedEndpointWorkReaderOptions) : {};
    this.#read = callbackOf(input);
  }

  async read(request: EndpointApiProjectionRequest): Promise<EndpointWorkProjection> {
    if (!isRecord(request) || request.operation !== "work.read" || !positiveRootIssue(request.rootIssue)) {
      throw new Error("Hosted work.read requires the exact admitted bounded rootIssue.");
    }
    const repositoryName = contextRepository(request);
    let projection: EndpointWorkProjection;
    await this.#read(async (transport) => {
      const adapter = new GitHubAdapter({
        repository: repositoryName,
        hostname: request.repository.repositoryHost,
        transport: providerTransport(async (operation) => operation(transport)),
      });
      const context = await adapter.getRepositoryContext();
      if (
        context.repositoryId !== request.repository.repositoryId ||
        context.hostname.toLowerCase() !== request.repository.repositoryHost.toLowerCase()
      ) {
        throw new Error("Provider repository identity does not match the admitted Endpoint repository.");
      }
      const changeReader = this.#options.changeReader ?? (await remoteChangeReader(adapter, transport));
      const changesByIssue = new Map<number, ChangeProjectionResult>();
      const trackingChangeReader: Pick<ChangeExecutionPort, "read"> = {
        read: async (changeRequest) => {
          const result = await changeReader.read(changeRequest);
          changesByIssue.set(changeRequest.issue, result);
          return result;
        },
      };
      const repository = createGitHubImplementationFrontierRepository({
        adapter,
        cwd: this.#options.cwd ?? DEFAULT_CWD,
        changeReader: trackingChangeReader,
        ...(this.#options.implementationEvidenceReader === undefined
          ? {}
          : { implementationEvidenceReader: this.#options.implementationEvidenceReader }),
      });
      const frontier = await composeImplementationFrontier(repository, request.rootIssue!);
      if (!frontier.valid || frontier.projection === undefined)
        throw new Error("Implementation Frontier is unavailable.");
      const freshness = await readFreshness(adapter, request, this.#options);
      const issueItems: Array<NonNullable<Awaited<ReturnType<typeof readOperationalIssue>>>> = [];
      const semanticItems: Array<NonNullable<Awaited<ReturnType<typeof readSemanticPullRequest>>>> = [];
      const pullRequestItems: Array<NonNullable<Awaited<ReturnType<typeof readOperationalPullRequest>>>> = [];
      const changeItems: ChangeProjectionResult[] = [];
      let issueFailures = 0;
      let semanticFailures = 0;
      let pullRequestFailures = 0;
      let changeFailures = 0;
      const pullRequestNumbers = new Set<number>();
      for (const candidate of frontier.projection.candidates.slice(
        0,
        HOSTED_ENDPOINT_WORK_READER_LIMITS.maxCandidates,
      )) {
        try {
          const issue = await readOperationalIssue(adapter, candidate.reference.number);
          if (issue !== undefined) issueItems.push(issue);
        } catch {
          issueFailures += 1;
        }
        try {
          const change = changesByIssue.get(candidate.reference.number);
          if (change === undefined) throw new Error("Change evidence is unavailable.");
          changeItems.push(change);
          const number = changePullRequestNumber(change);
          if (number !== undefined) pullRequestNumbers.add(number);
        } catch {
          changeFailures += 1;
        }
      }
      for (const number of pullRequestNumbers) {
        try {
          const semantic = await readSemanticPullRequest(adapter, context, number);
          if (semantic !== undefined) semanticItems.push(semantic);
        } catch {
          semanticFailures += 1;
        }
        try {
          const operational = await readOperationalPullRequest(adapter, number);
          if (operational !== undefined) pullRequestItems.push(operational);
        } catch {
          pullRequestFailures += 1;
        }
      }
      const input: EndpointWorkProjectionInput = {
        repository: request.repository,
        freshness,
        frontier,
        semanticPullRequests: collectionStatus(semanticItems, semanticFailures, "$.semanticPullRequests"),
        operationalIssues: collectionStatus(issueItems, issueFailures, "$.operationalIssues"),
        operationalPullRequests: collectionStatus(pullRequestItems, pullRequestFailures, "$.operationalPullRequests"),
        changes: collectionStatus(changeItems, changeFailures, "$.changes"),
      };
      const result = tryProjectEndpointWork(input);
      if (!result.valid || result.projection === undefined)
        throw new Error(
          `Endpoint work projection is invalid (${issueFailures}/${semanticFailures}/${pullRequestFailures}/${changeFailures}): ${result.diagnostics.map((entry) => entry.message).join("; ")}`,
        );
      projection = result.projection;
    });
    return projection!;
  }
}

export function createHostedEndpointWorkReader(input: HostedEndpointWorkReaderInput): HostedEndpointWorkReaderFunction {
  const reader = new HostedEndpointWorkReader(input);
  return reader.read.bind(reader);
}

export const createHostedEndpointWorkRead = createHostedEndpointWorkReader;
