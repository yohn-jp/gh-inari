import { randomUUID as generateRandomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  ChangeRemoteExecutorError,
  changeRemoteMutationRequest,
  normalizeChangeRemoteExecutionResult,
  normalizeChangeRemoteProjection,
  type ChangeRemoteExecutor,
  type ChangeRemoteExecutorOptions,
  type ChangeRemoteExecutionResult,
  type ChangeRemoteMutationRequest,
  type ChangeRemoteReadRequest,
} from "../change-executor.js";
import { GitHubAdapter } from "./adapter.js";
import { GitHubActionsEvidenceReader, loadBranchGovernance } from "./actions-change-executor.js";
import type {
  GitHubChangeEffectRequest,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import { isGitHubAdapterError } from "./errors.js";
import type { RepositoryContext } from "./types.js";

/** The only workflow and ref selected by the CLI transport. */
export const INARI_CHANGE_EXECUTOR_WORKFLOW = "inari-change-executor.yml" as const;
export const INARI_CHANGE_EXECUTOR_REF = "refs/heads/main" as const;

const INARI_CHANGE_EXECUTOR_BRANCH = "main" as const;
const MAX_ACTION_RUNS = 100;
const MAX_ARTIFACTS = 100;
const MAX_RESULT_BYTES = 262_144;
const DEFAULT_POLL_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface GitHubActionsRemoteApi {
  getRepositoryContext(): Promise<RepositoryContext>;
  getAuthenticatedUser(): Promise<string>;
  requestActionsApi(
    actionsPath: string,
    method: "GET" | "POST",
    fields?: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  requestRepositoryApi?(
    repositoryPath: string,
    method?: "GET",
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  downloadActionsArtifact(artifactId: number): Promise<Uint8Array>;
}

export interface GitHubActionsChangeRemoteExecutorOptions extends ChangeRemoteExecutorOptions {
  /** Injectable repository/auth/API abstraction; the default is the normal gh session. */
  readonly api?: GitHubActionsRemoteApi;
  /** Internal test/dogfood seam; never a public CLI option. */
  readonly requester?: string;
  readonly maxPollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly randomUUID?: () => string;
}

interface WorkflowRun {
  readonly id: number;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
  readonly event: string;
  readonly headBranch: string;
  readonly path?: string;
}

interface WorkflowArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly workflowRunId: number;
  readonly repositoryId?: number;
}

interface ActionResultEnvelope {
  readonly value: unknown;
  readonly failed: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.metadata", "invalid-metadata");
  }
  return value as number;
}

function remoteError(
  code: ConstructorParameters<typeof ChangeRemoteExecutorError>[0],
  operation: string,
  reason: string,
): ChangeRemoteExecutorError {
  const messages: Record<string, string> = {
    CHANGE_REMOTE_EXECUTOR_UNAVAILABLE: "The GitHub Actions Change executor is unavailable.",
    CHANGE_REMOTE_TRANSPORT_FAILED: "The GitHub Actions Change transport failed.",
    CHANGE_REMOTE_DISPATCH_FAILED: "The trusted Change workflow could not be dispatched.",
    CHANGE_REMOTE_RUN_FAILED: "The trusted Change workflow did not produce a successful result.",
    CHANGE_REMOTE_CORRELATION_FAILED: "The trusted Change workflow result could not be correlated safely.",
    CHANGE_REMOTE_RESULT_INVALID: "The trusted Change workflow returned an invalid bounded result.",
    CHANGE_REMOTE_REQUEST_INVALID: "The Change request is invalid.",
  };
  return new ChangeRemoteExecutorError(code, messages[code] ?? "The Change remote operation failed.", {
    operation,
    reason,
  });
}

function normalizeTransportError(
  error: unknown,
  operation: string,
  code:
    | "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE"
    | "CHANGE_REMOTE_TRANSPORT_FAILED"
    | "CHANGE_REMOTE_DISPATCH_FAILED"
    | "CHANGE_REMOTE_RUN_FAILED",
): ChangeRemoteExecutorError {
  if (error instanceof ChangeRemoteExecutorError) return error;
  if (isGitHubAdapterError(error) && error.category === "authentication") {
    return remoteError(code, operation, "authentication");
  }
  return remoteError(code, operation, "transport");
}

function workflowRunsPath(): string {
  return `actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/runs?event=workflow_dispatch&branch=${INARI_CHANGE_EXECUTOR_BRANCH}&per_page=${MAX_ACTION_RUNS}`;
}

function artifactsPath(name: string): string {
  return `actions/artifacts?name=${encodeURIComponent(name)}&per_page=${MAX_ARTIFACTS}`;
}

function dispatchPath(): string {
  return `actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/dispatches`;
}

function parseRuns(value: unknown): readonly WorkflowRun[] {
  const payload = record(value);
  if (!Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > MAX_ACTION_RUNS) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata");
  }
  return payload.workflow_runs.map((candidate) => {
    const item = record(candidate);
    const id = positiveInteger(item.id);
    const status = item.status;
    if (status !== "queued" && status !== "in_progress" && status !== "completed") {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata");
    }
    if (item.conclusion !== null && typeof item.conclusion !== "string") {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata");
    }
    const path = item.path === undefined ? undefined : boundedText(item.path, 512);
    if (path !== undefined && path !== `.github/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}`) {
      throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", "actions.runs", "wrong-workflow");
    }
    if (item.ref !== undefined && item.ref !== INARI_CHANGE_EXECUTOR_REF) {
      throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", "actions.runs", "wrong-ref");
    }
    return {
      id,
      status,
      conclusion: item.conclusion as string | null,
      event: boundedText(item.event, 64),
      headBranch: boundedText(item.head_branch, 255),
      ...(path === undefined ? {} : { path }),
    };
  });
}

function parseArtifacts(
  value: unknown,
  expectedName: string,
  expectedRepositoryId: string,
): readonly WorkflowArtifact[] {
  const payload = record(value);
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length > MAX_ARTIFACTS) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifacts", "invalid-metadata");
  }
  return payload.artifacts
    .filter((candidate) => {
      const item = record(candidate);
      return item.name === expectedName;
    })
    .map((candidate) => {
      const item = record(candidate);
      const workflowRun = record(item.workflow_run);
      const repositoryId =
        workflowRun.repository_id === undefined ? undefined : positiveInteger(workflowRun.repository_id);
      if (repositoryId !== undefined && String(repositoryId) !== expectedRepositoryId) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", "actions.artifacts", "wrong-repository");
      }
      if (typeof item.expired !== "boolean") {
        throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifacts", "invalid-metadata");
      }
      return {
        id: positiveInteger(item.id),
        name: boundedText(item.name, 255),
        expired: item.expired,
        workflowRunId: positiveInteger(workflowRun.id),
        ...(repositoryId === undefined ? {} : { repositoryId }),
      };
    });
}

function resultFromArchive(archive: Uint8Array): ActionResultEnvelope {
  try {
    if (archive.byteLength === 0 || archive.byteLength > 1_048_576) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    const bytes = Buffer.from(archive);
    const endOfCentralDirectory = findEndOfCentralDirectory(bytes);
    if (endOfCentralDirectory === undefined) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    const entryCount = bytes.readUInt16LE(endOfCentralDirectory + 10);
    const directorySize = bytes.readUInt32LE(endOfCentralDirectory + 12);
    const directoryOffset = bytes.readUInt32LE(endOfCentralDirectory + 16);
    if (entryCount !== 1 || directoryOffset + directorySize > bytes.length) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    const directory = directoryOffset;
    if (bytes.readUInt32LE(directory) !== 0x02014b50) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    const compression = bytes.readUInt16LE(directory + 10);
    const compressedSize = bytes.readUInt32LE(directory + 20);
    const uncompressedSize = bytes.readUInt32LE(directory + 24);
    const fileNameLength = bytes.readUInt16LE(directory + 28);
    const extraLength = bytes.readUInt16LE(directory + 30);
    const commentLength = bytes.readUInt16LE(directory + 32);
    const localOffset = bytes.readUInt32LE(directory + 42);
    const directoryEntryEnd = directory + 46 + fileNameLength + extraLength + commentLength;
    if (
      directory + 46 > bytes.length ||
      directoryEntryEnd > directory + directorySize ||
      uncompressedSize > MAX_RESULT_BYTES
    ) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    const fileName = decodeUtf8(bytes.subarray(directory + 46, directory + 46 + fileNameLength));
    if (
      fileName !== "result.json" ||
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > bytes.length) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    let content: Buffer;
    try {
      content =
        compression === 0
          ? bytes.subarray(contentStart, contentEnd)
          : compression === 8
            ? inflateRawSync(bytes.subarray(contentStart, contentEnd), { maxOutputLength: MAX_RESULT_BYTES })
            : (() => {
                throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "unsupported-compression");
              })();
    } catch (error: unknown) {
      if (error instanceof ChangeRemoteExecutorError) throw error;
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    if (content.byteLength !== uncompressedSize || content.byteLength > MAX_RESULT_BYTES) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
    }
    let value: unknown;
    try {
      value = JSON.parse(decodeUtf8(content)) as unknown;
    } catch (error: unknown) {
      if (error instanceof ChangeRemoteExecutorError) throw error;
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-json");
    }
    const result = record(value);
    if (result.ok === false) {
      const failure = record(result.error);
      boundedText(failure.code, 120);
      boundedText(failure.message, 240);
      return { value: undefined, failed: true };
    }
    if (result.ok !== undefined) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result");
    }
    return { value, failed: false };
  } catch (error: unknown) {
    if (error instanceof ChangeRemoteExecutorError) throw error;
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-archive");
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number | undefined {
  if (bytes.length < 22) return undefined;
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength <= bytes.length) return offset;
    }
  }
  return undefined;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-utf8");
  }
}

function canonicalMutationRequest(request: ChangeRemoteMutationRequest): ChangeRemoteMutationRequest {
  return changeRemoteMutationRequest(request.operation, request.issue, request.requester);
}

function isNewRun(run: WorkflowRun, baseline: ReadonlySet<number>): boolean {
  return !baseline.has(run.id) && run.event === "workflow_dispatch" && run.headBranch === INARI_CHANGE_EXECUTOR_BRANCH;
}

export class GitHubActionsChangeRemoteExecutor implements ChangeRemoteExecutor {
  readonly #api: GitHubActionsRemoteApi;
  readonly #cwd: string;
  readonly #requester: string | undefined;
  readonly #maxPollAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #randomUUID: () => string;

  constructor(options: GitHubActionsChangeRemoteExecutorOptions) {
    this.#cwd = options.cwd;
    this.#api = options.api ?? new GitHubAdapter({ cwd: options.cwd, repository: options.repository });
    this.#requester = options.requester;
    this.#maxPollAttempts = boundedOption(options.maxPollAttempts ?? DEFAULT_POLL_ATTEMPTS, 1, 60);
    this.#pollIntervalMs = boundedOption(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 0, 10_000);
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#randomUUID = options.randomUUID ?? generateRandomUUID;
  }

  async execute(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteExecutionResult> {
    const semanticRequest = await this.withRequester(canonicalMutationRequest(request));
    const result = await this.dispatchAndCollect(semanticRequest);
    if (result.failed) {
      throw remoteError("CHANGE_REMOTE_RUN_FAILED", `change.${request.operation}`, "workflow-failed");
    }
    return normalizeChangeRemoteExecutionResult(request.operation, result.value);
  }

  async read(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult> {
    const projection = await this.readCanonicalProjection(request);
    return normalizeChangeRemoteProjection("show", projection);
  }

  private async readCanonicalProjection(request: ChangeRemoteReadRequest): Promise<ChangeProjectionResult> {
    const repositoryApi = this.#api.requestRepositoryApi;
    if (repositoryApi === undefined) {
      throw remoteError("CHANGE_REMOTE_EXECUTOR_UNAVAILABLE", "change.show", "read-path-unavailable");
    }
    let context: RepositoryContext;
    try {
      context = await this.#api.getRepositoryContext();
    } catch (error: unknown) {
      throw normalizeTransportError(error, "change.show", "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE");
    }
    try {
      if (context.repositoryId === undefined) {
        throw remoteError("CHANGE_REMOTE_EXECUTOR_UNAVAILABLE", "change.show", "repository-identity-unavailable");
      }
      const branchGovernance = await loadBranchGovernance(this.#cwd);
      const reader = new GitHubActionsEvidenceReader({
        repository: { hostname: context.hostname, owner: context.owner, name: context.name },
        identity: { repositoryHost: context.hostname, repositoryId: context.repositoryId, rootIssue: request.issue },
        branchGovernance,
        transport: new GitHubRepositoryReadTransport(this.#api, context, repositoryApi),
        cwd: this.#cwd,
      });
      return projectChangeFromGitHubEvidence(await reader.read(request));
    } catch (error: unknown) {
      if (error instanceof ChangeRemoteExecutorError) throw error;
      throw normalizeTransportError(error, "change.show", "CHANGE_REMOTE_TRANSPORT_FAILED");
    }
  }

  private async withRequester(request: ChangeRemoteMutationRequest): Promise<ChangeRemoteMutationRequest> {
    if (request.requester !== undefined) return request;
    let requester = this.#requester;
    if (requester === undefined) {
      try {
        const login = await this.#api.getAuthenticatedUser();
        requester = `github:${login}`;
      } catch (error: unknown) {
        throw normalizeTransportError(error, `change.${request.operation}`, "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE");
      }
    }
    return changeRemoteMutationRequest(request.operation, request.issue, requester);
  }

  private async dispatchAndCollect(
    request: ChangeRemoteMutationRequest | ChangeRemoteReadRequest,
  ): Promise<ActionResultEnvelope> {
    const correlation = this.#randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlation)) {
      throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", `change.${request.operation}`, "invalid-correlation");
    }
    let context: RepositoryContext;
    try {
      context = await this.#api.getRepositoryContext();
    } catch (error: unknown) {
      throw normalizeTransportError(error, `change.${request.operation}`, "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE");
    }
    if (context.repositoryId === undefined) {
      throw remoteError(
        "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
        `change.${request.operation}`,
        "repository-identity-unavailable",
      );
    }
    const baseline = await this.readRuns(`change.${request.operation}`);
    const artifactName = `inari-change-result-${correlation}`;
    const semanticRequest = {
      version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
      operation: request.operation,
      issue: request.issue,
      ...(request.requester === undefined ? {} : { requester: request.requester }),
    };
    try {
      await this.#api.requestActionsApi(dispatchPath(), "POST", {
        ref: INARI_CHANGE_EXECUTOR_REF,
        "inputs[request]": JSON.stringify(semanticRequest),
        "inputs[correlation]": correlation,
      });
    } catch (error: unknown) {
      throw normalizeTransportError(error, `change.${request.operation}`, "CHANGE_REMOTE_DISPATCH_FAILED");
    }
    return this.waitForResult(`change.${request.operation}`, baseline, artifactName, context.repositoryId);
  }

  private async readRuns(operation: string): Promise<readonly WorkflowRun[]> {
    let value: unknown;
    try {
      value = await this.#api.requestActionsApi(workflowRunsPath(), "GET");
    } catch (error: unknown) {
      throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED");
    }
    return parseRuns(value);
  }

  private async waitForResult(
    operation: string,
    baseline: readonly WorkflowRun[],
    artifactName: string,
    repositoryId: string,
  ): Promise<ActionResultEnvelope> {
    const baselineIds = new Set(baseline.map((run) => run.id));
    for (let attempt = 0; attempt < this.#maxPollAttempts; attempt += 1) {
      const runs = await this.readRuns(operation);
      const candidates = runs.filter((run) => isNewRun(run, baselineIds));
      const artifacts = await this.readArtifacts(operation, artifactName, repositoryId);
      if (artifacts.length > 1) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "ambiguous-artifact");
      }
      const artifact = artifacts[0];
      if (artifact !== undefined && artifact.expired) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "expired-artifact");
      }
      const run =
        artifact === undefined ? undefined : candidates.find((candidate) => candidate.id === artifact.workflowRunId);
      if (artifact !== undefined && run === undefined && baselineIds.has(artifact.workflowRunId)) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "stale-artifact");
      }
      if (run !== undefined && run.status === "completed") {
        if (artifact === undefined) {
          throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "missing-result-artifact");
        }
        let archive: Uint8Array;
        try {
          archive = await this.#api.downloadActionsArtifact(artifact.id);
        } catch (error: unknown) {
          throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED");
        }
        const result = resultFromArchive(archive);
        if (run.conclusion !== "success") {
          throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "workflow-conclusion");
        }
        return result;
      }
      if (
        candidates.some((candidate) => candidate.status === "completed") &&
        artifact === undefined &&
        candidates.length === 1
      ) {
        throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "missing-result-artifact");
      }
      if (attempt + 1 < this.#maxPollAttempts) await this.#sleep(this.#pollIntervalMs);
    }
    throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "result-timeout");
  }

  private async readArtifacts(
    operation: string,
    name: string,
    repositoryId: string,
  ): Promise<readonly WorkflowArtifact[]> {
    let value: unknown;
    try {
      value = await this.#api.requestActionsApi(artifactsPath(name), "GET");
    } catch (error: unknown) {
      throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED");
    }
    return parseArtifacts(value, name, repositoryId);
  }
}

class GitHubRepositoryReadTransport implements GitHubChangeEffectTransport {
  readonly #api: GitHubActionsRemoteApi;
  readonly #context: RepositoryContext;
  readonly #requestRepositoryApi: NonNullable<GitHubActionsRemoteApi["requestRepositoryApi"]>;

  constructor(
    api: GitHubActionsRemoteApi,
    context: RepositoryContext,
    requestRepositoryApi: NonNullable<GitHubActionsRemoteApi["requestRepositoryApi"]>,
  ) {
    this.#api = api;
    this.#context = context;
    this.#requestRepositoryApi = requestRepositoryApi;
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    const prefix = `repos/${this.#context.nameWithOwner}/`;
    if (request.method !== "GET" || !request.path.startsWith(prefix)) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "change.show", "invalid-read-path");
    }
    const path = request.path.slice(prefix.length);
    try {
      return await this.#requestRepositoryApi.call(this.#api, path, "GET");
    } catch (error: unknown) {
      throw normalizeTransportError(error, "change.show", "CHANGE_REMOTE_TRANSPORT_FAILED");
    }
  }
}

function boundedOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError("GitHub Actions polling options are outside their bounded range.");
  }
  return value;
}

export function createGitHubActionsChangeRemoteExecutor(
  options: GitHubActionsChangeRemoteExecutorOptions,
): ChangeRemoteExecutor {
  return new GitHubActionsChangeRemoteExecutor(options);
}
