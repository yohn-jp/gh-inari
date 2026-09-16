import { randomUUID as generateRandomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  normalizeChangeEffectFailureClassification,
  type ChangeDiagnostic,
  type ChangeEffectFailureClassification,
  type ChangeProjectionResult,
} from "../change.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  ChangeExecutionPortError,
  changeMutationRequest,
  createChangeExecutionDeadline,
  DEFAULT_CHANGE_EXECUTION_DEADLINE_MS,
  normalizeChangeExecutionEvidence,
  normalizeChangeExecutionResult,
  validateChangeRequest,
  type ChangeExecutionPort,
  type ChangeExecutionDeadline,
  type ChangeExecutionPortOptions,
  type ChangeExecutionEvidence,
  type ChangeExecutionResult,
  type ChangeMutation,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "../change-execution-port.js";
import { normalizeTrustedFailureDiagnostics } from "../change-failure-diagnostics.js";
import { GitHubAdapter } from "./adapter.js";
import { isRepositoryEvidenceFailureReason, isTrustedActionsFailureStage } from "./actions-change-executor.js";
import type { TrustedActionsFailureDiagnostic } from "./actions-change-executor.js";
import { isChangeTrustedExecutorErrorCode } from "../change-trusted-executor.js";
import { isGitHubAdapterError } from "./errors.js";
import { createGitHubChangeReadAdapter, type GitHubChangeProjectionApi } from "./change-state-projector.js";
import type { RepositoryContext } from "./types.js";

/** The only workflow and ref selected by the CLI transport. */
export const INARI_CHANGE_EXECUTOR_WORKFLOW = "inari-change-executor.yml" as const;
export const INARI_CHANGE_EXECUTOR_REF = "refs/heads/main" as const;

const INARI_CHANGE_EXECUTOR_BRANCH = "main" as const;
const MAX_ACTION_RUNS = 100;
const MAX_ARTIFACTS = 100;
const MAX_RESULT_BYTES = 262_144;
// The execution deadline is owned by change-execution-port. These polling
// settings only shape observation cadence; they never establish when the
// semantic execution is allowed to stop.
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_ATTEMPTS = 300;

/**
 * Adapter-owned transport boundaries. These values describe where Actions
 * transport processing failed; they are not Change semantic diagnostics.
 */
export const ACTIONS_TRANSPORT_FAILURE_STAGES = Object.freeze([
  "repository-context",
  "dispatch",
  "run-read",
  "artifact-read",
  "artifact-download",
  "result-decode",
  "correlation",
] as const);
export type ActionsTransportFailureStage = (typeof ACTIONS_TRANSPORT_FAILURE_STAGES)[number];

export interface ActionsChangeExecutionAdapterApi {
  getRepositoryContext(deadline?: ChangeExecutionDeadline): Promise<RepositoryContext>;
  requestActionsApi(
    actionsPath: string,
    method: "GET" | "POST",
    fields?: Readonly<Record<string, string>>,
    deadline?: ChangeExecutionDeadline,
  ): Promise<unknown>;
  downloadActionsArtifact(artifactId: number, deadline?: ChangeExecutionDeadline): Promise<Uint8Array>;
}

export interface ActionsChangeExecutionAdapterOptions extends ChangeExecutionPortOptions {
  /** Injectable Actions transport abstraction; the default is the normal gh session. */
  readonly api?: ActionsChangeExecutionAdapterApi;
  /** Optional shared GitHub read composition when the transport has no read API. */
  readonly readApi?: GitHubChangeProjectionApi;
  /** Shared Core-facing read adapter; Actions itself never projects Change state. */
  readonly read?: Pick<ChangeExecutionPort, "read">;
  readonly maxPollAttempts?: number;
  readonly pollIntervalMs?: number;
  /**
   * Real wall-clock budget for the whole wait, in milliseconds. Each poll
   * attempt also spends time on live API calls (readRuns/readArtifacts/
   * downloadActionsArtifact) that is not otherwise counted against
   * maxPollAttempts * pollIntervalMs, so this deadline is the authority for
   * when to stop, not attempt count alone.
   */
  readonly maxWaitMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

interface WorkflowRun {
  readonly id: number;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
  readonly event: string;
  readonly headBranch: string;
  /**
   * The evaluated `run-name` (GitHub API `display_title`). The executor
   * workflow sets this to `Inari Change <correlation>`, which is the only
   * evidence strong enough to positively bind a run to this request; it is
   * never inferred from ordering, cardinality, or baseline membership.
   */
  readonly displayTitle: string;
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
  readonly diagnostic?: TrustedActionsFailureDiagnostic;
}

function record(value: unknown, stage: ActionsTransportFailureStage = "result-decode"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result", undefined, stage);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number, stage: ActionsTransportFailureStage = "result-decode"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result", undefined, stage);
  }
  return value;
}

function positiveInteger(value: unknown, stage: ActionsTransportFailureStage = "result-decode"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.metadata", "invalid-metadata", undefined, stage);
  }
  return value as number;
}

function remoteError(
  code: ConstructorParameters<typeof ChangeExecutionPortError>[0],
  operation: string,
  reason: string,
  diagnostic?: TrustedActionsFailureDiagnostic,
  stage?: ActionsTransportFailureStage,
): ChangeExecutionPortError {
  const messages: Record<string, string> = {
    CHANGE_REMOTE_EXECUTOR_UNAVAILABLE: "The GitHub Actions Change executor is unavailable.",
    CHANGE_REMOTE_TRANSPORT_FAILED: "The GitHub Actions Change transport failed.",
    CHANGE_REMOTE_DISPATCH_FAILED: "The trusted Change workflow could not be dispatched.",
    CHANGE_REMOTE_RUN_FAILED: "The trusted Change workflow did not produce a successful result.",
    CHANGE_REMOTE_CORRELATION_FAILED: "The trusted Change workflow result could not be correlated safely.",
    CHANGE_REMOTE_RESULT_INVALID: "The trusted Change workflow returned an invalid bounded result.",
    CHANGE_REMOTE_REQUEST_INVALID: "The Change request is invalid.",
  };
  return new ChangeExecutionPortError(
    code,
    messages[code] ?? "The Change remote operation failed.",
    {
      operation,
      reason,
      ...(stage === undefined || diagnostic !== undefined ? {} : { stage }),
      ...(diagnostic === undefined
        ? {}
        : {
            stage: diagnostic.stage,
            ...(diagnostic.reason === undefined ? {} : { stageReason: diagnostic.reason }),
            ...(diagnostic.trustedCode === undefined ? {} : { trustedCode: diagnostic.trustedCode }),
            ...(diagnostic.evidence === undefined ? {} : { evidence: diagnostic.evidence }),
            ...(diagnostic.effectFailure === undefined ? {} : { effectFailure: diagnostic.effectFailure }),
          }),
    },
    diagnostic?.diagnostics,
  );
}

function resultValidationError(
  error: unknown,
  operation: string,
  stage: ActionsTransportFailureStage,
): ChangeExecutionPortError {
  if (!(error instanceof ChangeExecutionPortError)) {
    return remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result", undefined, stage);
  }
  if (error.code !== "CHANGE_REMOTE_RESULT_INVALID") return error;
  const details =
    typeof error.details === "object" && error.details !== null && !Array.isArray(error.details)
      ? { ...(error.details as Record<string, unknown>), stage }
      : { operation, stage };
  return new ChangeExecutionPortError(error.code, error.message, details, error.diagnostics);
}

function normalizeTransportError(
  error: unknown,
  operation: string,
  code:
    | "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE"
    | "CHANGE_REMOTE_TRANSPORT_FAILED"
    | "CHANGE_REMOTE_DISPATCH_FAILED"
    | "CHANGE_REMOTE_RUN_FAILED",
  stage: ActionsTransportFailureStage,
): ChangeExecutionPortError {
  if (error instanceof ChangeExecutionPortError) return error;
  if (isGitHubAdapterError(error) && error.category === "authentication") {
    return remoteError(code, operation, "authentication", undefined, stage);
  }
  return remoteError(code, operation, "transport", undefined, stage);
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

function parseFailureDiagnostic(value: unknown, operation: string): TrustedActionsFailureDiagnostic | undefined {
  if (value === undefined) return undefined;
  const details = record(value, "result-decode");
  if (
    Object.keys(details).some(
      (key) => !["stage", "reason", "trustedCode", "diagnostics", "evidence", "effectFailure"].includes(key),
    ) ||
    !isTrustedActionsFailureStage(details.stage) ||
    (details.reason !== undefined && !isRepositoryEvidenceFailureReason(details.reason)) ||
    (details.trustedCode !== undefined && !isChangeTrustedExecutorErrorCode(details.trustedCode))
  ) {
    throw remoteError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "actions.result",
      "invalid-diagnostic",
      undefined,
      "result-decode",
    );
  }
  let diagnostics: readonly ChangeDiagnostic[] | undefined;
  try {
    diagnostics = normalizeTrustedFailureDiagnostics(details.diagnostics);
  } catch {
    throw remoteError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "actions.result",
      "invalid-diagnostic",
      undefined,
      "result-decode",
    );
  }
  let evidence: ChangeExecutionEvidence | undefined;
  if (details.evidence !== undefined) {
    try {
      evidence = normalizeChangeExecutionEvidence(operation, details.evidence);
    } catch {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.result",
        "invalid-diagnostic",
        undefined,
        "result-decode",
      );
    }
  }
  let effectFailure: ChangeEffectFailureClassification | undefined;
  try {
    effectFailure = normalizeChangeEffectFailureClassification(details.effectFailure);
  } catch {
    throw remoteError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "actions.result",
      "invalid-diagnostic",
      undefined,
      "result-decode",
    );
  }
  return Object.freeze({
    stage: details.stage,
    ...(details.reason === undefined ? {} : { reason: details.reason }),
    ...(details.trustedCode === undefined ? {} : { trustedCode: details.trustedCode }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(effectFailure === undefined ? {} : { effectFailure }),
  });
}

function parseRuns(value: unknown): readonly WorkflowRun[] {
  const payload = record(value, "run-read");
  if (!Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > MAX_ACTION_RUNS) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata", undefined, "run-read");
  }
  return payload.workflow_runs.map((candidate) => {
    const item = record(candidate, "run-read");
    const id = positiveInteger(item.id, "run-read");
    const status = item.status;
    if (status !== "queued" && status !== "in_progress" && status !== "completed") {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata", undefined, "run-read");
    }
    if (item.conclusion !== null && typeof item.conclusion !== "string") {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata", undefined, "run-read");
    }
    const path = item.path === undefined ? undefined : boundedText(item.path, 512, "run-read");
    if (path !== undefined && path !== `.github/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}`) {
      throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", "actions.runs", "wrong-workflow", undefined, "correlation");
    }
    if (item.ref !== undefined && item.ref !== INARI_CHANGE_EXECUTOR_REF) {
      throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", "actions.runs", "wrong-ref", undefined, "correlation");
    }
    return {
      id,
      status,
      conclusion: item.conclusion as string | null,
      event: boundedText(item.event, 64, "run-read"),
      headBranch: boundedText(item.head_branch, 255, "run-read"),
      displayTitle: boundedText(item.display_title, 512, "run-read"),
      ...(path === undefined ? {} : { path }),
    };
  });
}

function parseArtifacts(
  value: unknown,
  expectedName: string,
  expectedRepositoryId: string,
): readonly WorkflowArtifact[] {
  const payload = record(value, "artifact-read");
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length > MAX_ARTIFACTS) {
    throw remoteError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "actions.artifacts",
      "invalid-metadata",
      undefined,
      "artifact-read",
    );
  }
  return payload.artifacts
    .filter((candidate) => {
      const item = record(candidate, "artifact-read");
      return item.name === expectedName;
    })
    .map((candidate) => {
      const item = record(candidate, "artifact-read");
      const workflowRun = record(item.workflow_run, "artifact-read");
      const repositoryId =
        workflowRun.repository_id === undefined
          ? undefined
          : positiveInteger(workflowRun.repository_id, "artifact-read");
      if (repositoryId !== undefined && String(repositoryId) !== expectedRepositoryId) {
        throw remoteError(
          "CHANGE_REMOTE_CORRELATION_FAILED",
          "actions.artifacts",
          "wrong-repository",
          undefined,
          "correlation",
        );
      }
      if (typeof item.expired !== "boolean") {
        throw remoteError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "actions.artifacts",
          "invalid-metadata",
          undefined,
          "artifact-read",
        );
      }
      return {
        id: positiveInteger(item.id, "artifact-read"),
        name: boundedText(item.name, 255, "artifact-read"),
        expired: item.expired,
        workflowRunId: positiveInteger(workflowRun.id, "artifact-read"),
        ...(repositoryId === undefined ? {} : { repositoryId }),
      };
    });
}

function resultFromArchive(archive: Uint8Array, operation: ChangeMutation): ActionResultEnvelope {
  try {
    if (archive.byteLength === 0 || archive.byteLength > 1_048_576) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    const bytes = Buffer.from(archive);
    const endOfCentralDirectory = findEndOfCentralDirectory(bytes);
    if (endOfCentralDirectory === undefined) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    const entryCount = bytes.readUInt16LE(endOfCentralDirectory + 10);
    const directorySize = bytes.readUInt32LE(endOfCentralDirectory + 12);
    const directoryOffset = bytes.readUInt32LE(endOfCentralDirectory + 16);
    if (entryCount !== 1 || directoryOffset + directorySize > bytes.length) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    const directory = directoryOffset;
    if (bytes.readUInt32LE(directory) !== 0x02014b50) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
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
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    const fileName = decodeUtf8(bytes.subarray(directory + 46, directory + 46 + fileNameLength));
    if (
      fileName !== "result.json" ||
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + 30 + localNameLength + localExtraLength;
    const contentEnd = contentStart + compressedSize;
    if (contentEnd > bytes.length) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    let content: Buffer;
    try {
      content =
        compression === 0
          ? bytes.subarray(contentStart, contentEnd)
          : compression === 8
            ? inflateRawSync(bytes.subarray(contentStart, contentEnd), { maxOutputLength: MAX_RESULT_BYTES })
            : (() => {
                throw remoteError(
                  "CHANGE_REMOTE_RESULT_INVALID",
                  "actions.artifact",
                  "unsupported-compression",
                  undefined,
                  "result-decode",
                );
              })();
    } catch (error: unknown) {
      if (error instanceof ChangeExecutionPortError) throw error;
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    if (content.byteLength !== uncompressedSize || content.byteLength > MAX_RESULT_BYTES) {
      throw remoteError(
        "CHANGE_REMOTE_RESULT_INVALID",
        "actions.artifact",
        "invalid-archive",
        undefined,
        "result-decode",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(decodeUtf8(content)) as unknown;
    } catch (error: unknown) {
      if (error instanceof ChangeExecutionPortError) throw error;
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-json", undefined, "result-decode");
    }
    const result = record(value, "result-decode");
    if (result.ok === false) {
      const failure = record(result.error, "result-decode");
      if (Object.keys(failure).some((key) => !["code", "message", "details"].includes(key))) {
        throw remoteError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "actions.result",
          "invalid-result",
          undefined,
          "result-decode",
        );
      }
      if (failure.code !== "CHANGE_ACTIONS_RUNTIME_INVALID") {
        throw remoteError(
          "CHANGE_REMOTE_RESULT_INVALID",
          "actions.result",
          "invalid-result",
          undefined,
          "result-decode",
        );
      }
      boundedText(failure.message, 240, "result-decode");
      const diagnostic = parseFailureDiagnostic(failure.details, operation);
      return {
        value: undefined,
        failed: true,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      };
    }
    if (result.ok !== undefined) {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.result", "invalid-result", undefined, "result-decode");
    }
    return { value, failed: false };
  } catch (error: unknown) {
    if (error instanceof ChangeExecutionPortError) throw error;
    throw remoteError(
      "CHANGE_REMOTE_RESULT_INVALID",
      "actions.artifact",
      "invalid-archive",
      undefined,
      "result-decode",
    );
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
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.artifact", "invalid-utf8", undefined, "result-decode");
  }
}

function canonicalMutationRequest(request: ChangeMutationRequest): ChangeMutationRequest {
  return changeMutationRequest(
    request.operation,
    request.issue,
    request.semanticPullRequestPlan,
    request.signedProvenanceRecord,
  );
}

/**
 * The executor's `run-name: Inari Change ${{ inputs.correlation }}` is the
 * authoritative correlation evidence between a dispatched request and an
 * observed workflow run. Candidate cardinality, "new since baseline", and
 * observation order are never substitutes for this positive match.
 */
function expectedRunDisplayTitle(correlation: string): string {
  return `Inari Change ${correlation}`;
}

function isCorrelatedRun(run: WorkflowRun, correlation: string): boolean {
  return (
    run.event === "workflow_dispatch" &&
    run.headBranch === INARI_CHANGE_EXECUTOR_BRANCH &&
    run.displayTitle === expectedRunDisplayTitle(correlation)
  );
}

function isRetryablePollTransportError(error: unknown): error is ChangeExecutionPortError {
  if (!(error instanceof ChangeExecutionPortError) || error.code !== "CHANGE_REMOTE_TRANSPORT_FAILED") return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { readonly reason?: unknown }).reason === "transport"
  );
}

/**
 * Bounded GitHub Actions transport for the transport-neutral Change port.
 *
 * This class owns workflow dispatch, run/artifact correlation, polling
 * deadlines, artifact framing, and request/result contract normalization.
 * Semantic Change projection is supplied as a delegated read port; this class
 * never selects governance, lifecycle, recovery, requester, or effect policy.
 */
export class ActionsChangeExecutionAdapter implements ChangeExecutionPort {
  readonly #api: ActionsChangeExecutionAdapterApi;
  readonly #read: Pick<ChangeExecutionPort, "read">;
  readonly #maxPollAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;

  constructor(options: ActionsChangeExecutionAdapterOptions) {
    const api = options.api ?? new GitHubAdapter({ cwd: options.cwd, repository: options.repository });
    const projectionApi = options.readApi ?? projectionApiFromTransport(api);
    const read =
      options.read ??
      (projectionApi === undefined
        ? undefined
        : createGitHubChangeReadAdapter({ cwd: options.cwd, api: projectionApi }));
    this.#api = api;
    this.#read =
      read ??
      ({
        read: async () => {
          throw remoteError("CHANGE_REMOTE_EXECUTOR_UNAVAILABLE", "change.show", "read-path-unavailable");
        },
      } satisfies Pick<ChangeExecutionPort, "read">);
    this.#maxPollAttempts = boundedOption(options.maxPollAttempts ?? DEFAULT_POLL_ATTEMPTS, 1, 1_000);
    this.#pollIntervalMs = boundedOption(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 0, 10_000);
    this.#maxWaitMs = boundedOption(options.maxWaitMs ?? DEFAULT_CHANGE_EXECUTION_DEADLINE_MS, 1, 600_000);
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? (() => Date.now());
    this.#randomUUID = options.randomUUID ?? generateRandomUUID;
  }

  async execute(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    validateChangeRequest(request);
    const semanticRequest = canonicalMutationRequest(request);
    const deadline = createChangeExecutionDeadline(this.#maxWaitMs, this.#now);
    const result = await this.dispatchAndCollect(semanticRequest, deadline);
    if (result.failed) {
      throw remoteError(
        "CHANGE_REMOTE_RUN_FAILED",
        `change.${request.operation}`,
        "workflow-failed",
        result.diagnostic,
      );
    }
    try {
      return normalizeChangeExecutionResult(request.operation, result.value);
    } catch (error: unknown) {
      throw resultValidationError(error, `change.${request.operation}`, "result-decode");
    }
  }

  async read(request: ChangeReadRequest): Promise<ChangeProjectionResult> {
    // The shared projector is injected by the composition factory. Keeping
    // this method as delegation preserves the ChangeExecutionPort API without
    // putting GitHub-derived semantic policy in the Actions transport.
    return this.#read.read(request);
  }

  private async dispatchAndCollect(
    request: ChangeMutationRequest,
    deadline: ChangeExecutionDeadline,
  ): Promise<ActionResultEnvelope> {
    const correlation = this.#randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlation)) {
      throw remoteError(
        "CHANGE_REMOTE_CORRELATION_FAILED",
        `change.${request.operation}`,
        "invalid-correlation",
        undefined,
        "correlation",
      );
    }
    const operation = `change.${request.operation}`;
    const context = await this.withinDeadline(
      operation,
      deadline,
      async () => {
        try {
          return await this.#api.getRepositoryContext(deadline);
        } catch (error: unknown) {
          throw normalizeTransportError(error, operation, "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE", "repository-context");
        }
      },
      "repository-context",
    );
    if (context.repositoryId === undefined) {
      throw remoteError(
        "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
        operation,
        "repository-identity-unavailable",
        undefined,
        "repository-context",
      );
    }
    const baseline = await this.readRuns(operation, deadline);
    const artifactName = `inari-change-result-${correlation}`;
    const semanticRequest = {
      version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
      operation: request.operation,
      issue: request.issue,
      ...(request.semanticPullRequestPlan === undefined
        ? {}
        : { semanticPullRequestPlan: request.semanticPullRequestPlan }),
      ...(request.signedProvenanceRecord === undefined
        ? {}
        : { signedProvenanceRecord: request.signedProvenanceRecord }),
    };
    try {
      await this.withinDeadline(
        operation,
        deadline,
        () =>
          this.#api.requestActionsApi(
            dispatchPath(),
            "POST",
            {
              ref: INARI_CHANGE_EXECUTOR_REF,
              "inputs[request]": JSON.stringify(semanticRequest),
              "inputs[correlation]": correlation,
            },
            deadline,
          ),
        "dispatch",
      );
    } catch (error: unknown) {
      throw normalizeTransportError(error, operation, "CHANGE_REMOTE_DISPATCH_FAILED", "dispatch");
    }
    this.assertDeadline(operation, deadline, "dispatch");
    return this.waitForResult(
      operation,
      correlation,
      baseline,
      artifactName,
      context.repositoryId,
      request.operation,
      deadline,
    );
  }

  private async readRuns(operation: string, deadline: ChangeExecutionDeadline): Promise<readonly WorkflowRun[]> {
    return this.withinDeadline(
      operation,
      deadline,
      async () => {
        let value: unknown;
        try {
          value = await this.#api.requestActionsApi(workflowRunsPath(), "GET", {}, deadline);
        } catch (error: unknown) {
          throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "run-read");
        }
        return parseRuns(value);
      },
      "run-read",
    );
  }

  private async waitForResult(
    operation: string,
    correlation: string,
    baseline: readonly WorkflowRun[],
    artifactName: string,
    repositoryId: string,
    semanticOperation: ChangeMutation,
    deadline: ChangeExecutionDeadline,
  ): Promise<ActionResultEnvelope> {
    const baselineIds = new Set(baseline.map((run) => run.id));
    // The wall-clock deadline is the real stopping authority (see #582):
    // per-attempt API latency is not otherwise bounded, so a fixed attempt
    // count can be exhausted well before real time runs out. maxPollAttempts
    // remains only as a sanity ceiling against a runaway loop, not as the
    // primary budget.
    let observationStage: ActionsTransportFailureStage = "run-read";
    for (let attempt = 0; deadline.remainingMs() > 0 && attempt < this.#maxPollAttempts; attempt += 1) {
      const timeRemaining = () => deadline.remainingMs() > 0;
      let runs: readonly WorkflowRun[];
      observationStage = "run-read";
      try {
        runs = await this.readRuns(operation, deadline);
      } catch (error: unknown) {
        if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
        await this.#sleep(this.#pollIntervalMs);
        continue;
      }
      // The run-name correlation is the only identity evidence used below.
      // Candidate count, "new since baseline", and observation order never
      // decide which run belongs to this request.
      const correlatedRun = runs.find((candidate) => isCorrelatedRun(candidate, correlation));
      let artifacts: readonly WorkflowArtifact[];
      observationStage = "artifact-read";
      try {
        artifacts = await this.readArtifacts(operation, artifactName, repositoryId, deadline);
      } catch (error: unknown) {
        if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
        await this.#sleep(this.#pollIntervalMs);
        continue;
      }
      if (artifacts.length > 1) {
        throw remoteError(
          "CHANGE_REMOTE_CORRELATION_FAILED",
          operation,
          "ambiguous-artifact",
          undefined,
          "correlation",
        );
      }
      const artifact = artifacts[0];
      if (artifact !== undefined && artifact.expired) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "expired-artifact", undefined, "correlation");
      }
      const run =
        artifact !== undefined && correlatedRun !== undefined && correlatedRun.id === artifact.workflowRunId
          ? correlatedRun
          : undefined;
      if (artifact !== undefined && run === undefined && baselineIds.has(artifact.workflowRunId)) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "stale-artifact", undefined, "correlation");
      }
      if (artifact !== undefined && run !== undefined && run.status === "completed") {
        let archive: Uint8Array;
        observationStage = "artifact-download";
        try {
          archive = await this.withinDeadline(
            operation,
            deadline,
            () => this.#api.downloadActionsArtifact(artifact.id, deadline),
            "artifact-download",
          );
        } catch (error: unknown) {
          const normalized = normalizeTransportError(
            error,
            operation,
            "CHANGE_REMOTE_TRANSPORT_FAILED",
            "artifact-download",
          );
          if (!isRetryablePollTransportError(normalized) || !timeRemaining()) throw normalized;
          await this.#sleep(this.#pollIntervalMs);
          continue;
        }
        const result = resultFromArchive(archive, semanticOperation);
        // A bounded trusted result is the authority for the Change outcome.
        // Only a runtime failure envelope remains a remote-run failure when
        // the workflow itself concluded unsuccessfully.
        if (run.conclusion !== "success" && result.failed) {
          throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "workflow-conclusion", result.diagnostic);
        }
        return result;
      }
      // The positively correlated run reaching `completed` does not mean its
      // result artifact is visible yet (#613): GitHub Actions run completion
      // and artifact-listing convergence are not atomic. Absence here is an
      // observation state, not proof of failure, so this falls through to
      // keep polling for the exact correlated artifact — bounded only by the
      // same canonical deadline that governs every other observation above,
      // never by a second timeout/attempt authority of its own.
      if (timeRemaining()) await this.#sleep(this.#pollIntervalMs);
    }
    throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "result-timeout", undefined, observationStage);
  }

  private async readArtifacts(
    operation: string,
    name: string,
    repositoryId: string,
    deadline: ChangeExecutionDeadline,
  ): Promise<readonly WorkflowArtifact[]> {
    return this.withinDeadline(
      operation,
      deadline,
      async () => {
        let value: unknown;
        try {
          value = await this.#api.requestActionsApi(artifactsPath(name), "GET", {}, deadline);
        } catch (error: unknown) {
          throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "artifact-read");
        }
        return parseArtifacts(value, name, repositoryId);
      },
      "artifact-read",
    );
  }

  private assertDeadline(
    operation: string,
    deadline: ChangeExecutionDeadline,
    stage?: ActionsTransportFailureStage,
  ): void {
    if (deadline.remainingMs() <= 0) {
      throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "result-timeout", undefined, stage);
    }
  }

  private async withinDeadline<T>(
    operation: string,
    deadline: ChangeExecutionDeadline,
    task: () => Promise<T>,
    stage: ActionsTransportFailureStage,
  ): Promise<T> {
    this.assertDeadline(operation, deadline, stage);
    try {
      const result = await task();
      this.assertDeadline(operation, deadline, stage);
      return result;
    } catch (error: unknown) {
      if (deadline.remainingMs() <= 0) this.assertDeadline(operation, deadline, stage);
      throw error;
    }
  }
}

function boundedOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError("GitHub Actions polling options are outside their bounded range.");
  }
  return value;
}

export function createActionsChangeExecutionAdapter(
  options: ActionsChangeExecutionAdapterOptions,
): ChangeExecutionPort {
  return new ActionsChangeExecutionAdapter(options);
}

function projectionApiFromTransport(value: ActionsChangeExecutionAdapterApi): GitHubChangeProjectionApi | undefined {
  const candidate = value as Partial<GitHubChangeProjectionApi>;
  if (
    typeof candidate.getRepositoryContext !== "function" ||
    typeof candidate.getRepositoryDefaultBranch !== "function" ||
    typeof candidate.getRepositoryTree !== "function" ||
    typeof candidate.getRepositoryBlob !== "function" ||
    typeof candidate.requestRepositoryApi !== "function"
  ) {
    return undefined;
  }
  return candidate as GitHubChangeProjectionApi;
}

/**
 * Compatibility exports for the pre-#548 Actions remote-executor names.
 * The aliases point to this adapter and preserve one implementation.
 */
/** @deprecated Use `ActionsChangeExecutionAdapterApi`. */
export type GitHubActionsRemoteApi = ActionsChangeExecutionAdapterApi;
/** @deprecated Use `ActionsChangeExecutionAdapterOptions`. */
export type GitHubActionsChangeRemoteExecutorOptions = ActionsChangeExecutionAdapterOptions;
/** @deprecated Use `ActionsChangeExecutionAdapter`. */
export const GitHubActionsChangeRemoteExecutor = ActionsChangeExecutionAdapter;
/** @deprecated Use `ActionsChangeExecutionAdapter`. */
export type GitHubActionsChangeRemoteExecutor = ActionsChangeExecutionAdapter;
/** @deprecated Use `createActionsChangeExecutionAdapter`. */
export const createGitHubActionsChangeRemoteExecutor = createActionsChangeExecutionAdapter;
