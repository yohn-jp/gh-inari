import { randomUUID as generateRandomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  normalizeChangeEffectFailureClassification,
  type ChangeDiagnostic,
  type ChangeEffectFailureClassification,
  type ChangeProjectionResult,
} from "../change.js";
import type {
  GitHubChangeEffectJsonObject,
  GitHubChangeEffectJsonValue,
  GitHubChangeEffectRepository,
} from "./change-effect-adapter.js";
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
import { resolveGitHubRepository } from "./app-installation-credential-broker.js";
import { isRepositoryEvidenceFailureReason, isTrustedActionsFailureStage } from "./actions-change-executor.js";
import type { TrustedActionsFailureDiagnostic } from "./actions-change-executor.js";
import { isChangeTrustedExecutorErrorCode } from "../change-trusted-executor.js";
import { isGitHubAdapterError } from "./errors.js";
import { createGitHubChangeReadAdapter, type GitHubChangeProjectionApi } from "./change-state-projector.js";
import { GitHubNativeHttpTransport } from "./native-http-transport.js";
import {
  githubProviderFailure,
  githubProviderFailureFromStatus,
  normalizeGitHubProviderFailureClassification,
  readGitHubProviderFailure,
  type GitHubProviderFailureClassification,
} from "./provider-failure.js";
import { resolveGitHubUserCredential, GitHubUserCredentialError } from "./user-credential.js";
import { resolveLocalRepositoryContext } from "./local-repository-context.js";
import type { RepositoryContext, RepositoryTree } from "./types.js";

/** The only workflow and ref selected by the CLI transport. */
export const INARI_CHANGE_EXECUTOR_WORKFLOW = "inari-change-executor.yml" as const;
export const INARI_CHANGE_EXECUTOR_REF = "refs/heads/main" as const;

const INARI_CHANGE_EXECUTOR_BRANCH = "main" as const;
const ACTIONS_PAGE_SIZE = 100;
const MAX_ACTION_RUN_PAGES = 10;
const MAX_ARTIFACT_PAGES = 10;
const MAX_ACTION_RUNS = ACTIONS_PAGE_SIZE * MAX_ACTION_RUN_PAGES;
const MAX_ARTIFACTS = ACTIONS_PAGE_SIZE * MAX_ARTIFACT_PAGES;
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
  "jobs-read",
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
  /** Optional bounded inspection of the positively correlated run's jobs. */
  readonly inspectActionsJobs?: (runId: number, deadline?: ChangeExecutionDeadline) => Promise<void>;
}

export interface ActionsChangeExecutionAdapterOptions extends ChangeExecutionPortOptions {
  /** Injectable Actions transport abstraction; the default is bounded native GitHub HTTP. */
  readonly api?: ActionsChangeExecutionAdapterApi;
  /** Optional standalone Actions credential, kept inside the transport boundary. */
  readonly token?: string;
  /** Optional environment seam for deterministic native credential resolution. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional REST API base; defaults to GITHUB_API_URL when present. */
  readonly apiUrl?: string;
  /** Injectable fetch implementation for deterministic native transport tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
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
  providerFailure?: GitHubProviderFailureClassification,
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
      ...(providerFailure === undefined ? {} : { providerFailure }),
      ...(diagnostic === undefined
        ? {}
        : {
            stage: diagnostic.stage,
            ...(diagnostic.reason === undefined ? {} : { stageReason: diagnostic.reason }),
            ...(diagnostic.trustedCode === undefined ? {} : { trustedCode: diagnostic.trustedCode }),
            ...(diagnostic.evidence === undefined ? {} : { evidence: diagnostic.evidence }),
            ...(diagnostic.effectFailure === undefined ? {} : { effectFailure: diagnostic.effectFailure }),
            ...(diagnostic.providerFailure === undefined ? {} : { providerFailure: diagnostic.providerFailure }),
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

function adapterProviderFailure(error: unknown): GitHubProviderFailureClassification | undefined {
  const attached = readGitHubProviderFailure(error);
  if (attached !== undefined) return attached;
  if (error instanceof GitHubUserCredentialError) {
    return githubProviderFailure("authentication", { retryable: false });
  }
  if (isGitHubAdapterError(error)) {
    if (error.category === "authentication") {
      return githubProviderFailure("authentication", { retryable: false });
    }
    if (error.category === "timeout") {
      const timeoutMs =
        typeof error.details.timeoutMs === "number" &&
        Number.isSafeInteger(error.details.timeoutMs) &&
        error.details.timeoutMs > 0
          ? error.details.timeoutMs
          : undefined;
      return githubProviderFailure("timeout", {
        retryable: true,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }
    if (error.code === "GITHUB_RESPONSE_LIMIT_EXCEEDED") {
      const limitBytes =
        typeof error.details.limitBytes === "number" &&
        Number.isSafeInteger(error.details.limitBytes) &&
        error.details.limitBytes > 0
          ? error.details.limitBytes
          : undefined;
      return githubProviderFailure("response-limit", {
        retryable: false,
        ...(limitBytes === undefined ? {} : { limitBytes }),
      });
    }
    if (error.code === "GITHUB_API_RESPONSE_INVALID") {
      return githubProviderFailure("response-invalid", { retryable: false });
    }
    if (error.category === "transport") {
      return githubProviderFailure("transport", { retryable: true });
    }
  }
  return undefined;
}

function applyActionsRetryPolicy(
  providerFailure: GitHubProviderFailureClassification,
  stage: ActionsTransportFailureStage,
): GitHubProviderFailureClassification {
  // GitHub can list an Actions artifact before its blob download has converged.
  // #577 established 404/425 at this exact read-after-list boundary as a
  // retryable observation state. The same statuses remain non-retryable at
  // unrelated stages.
  if (stage === "artifact-download" && (providerFailure.status === 404 || providerFailure.status === 425)) {
    return normalizeGitHubProviderFailureClassification({
      ...providerFailure,
      retryable: true,
    })!;
  }
  return providerFailure;
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
  const providerFailure = applyActionsRetryPolicy(
    adapterProviderFailure(error) ?? githubProviderFailure("transport", { retryable: true }),
    stage,
  );
  return remoteError(code, operation, providerFailure.failureClass, undefined, stage, providerFailure);
}

function workflowRunsPath(page: number): string {
  return `actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/runs?event=workflow_dispatch&branch=${INARI_CHANGE_EXECUTOR_BRANCH}&per_page=${ACTIONS_PAGE_SIZE}&page=${page}`;
}

function workflowRunPath(runId: number): string {
  return `actions/runs/${runId}`;
}

function artifactsPath(name: string, page: number): string {
  return `actions/artifacts?name=${encodeURIComponent(name)}&per_page=${ACTIONS_PAGE_SIZE}&page=${page}`;
}

function artifactPath(artifactId: number): string {
  return `actions/artifacts/${artifactId}`;
}

function dispatchPath(): string {
  return `actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/dispatches`;
}

function parseFailureDiagnostic(value: unknown, operation: string): TrustedActionsFailureDiagnostic | undefined {
  if (value === undefined) return undefined;
  const details = record(value, "result-decode");
  if (
    Object.keys(details).some(
      (key) =>
        !["stage", "reason", "trustedCode", "diagnostics", "evidence", "effectFailure", "providerFailure"].includes(
          key,
        ),
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
  let providerFailure: GitHubProviderFailureClassification | undefined;
  try {
    providerFailure = normalizeGitHubProviderFailureClassification(details.providerFailure);
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
    ...(providerFailure === undefined ? {} : { providerFailure }),
  });
}

function parseRun(value: unknown): WorkflowRun {
  const item = record(value, "run-read");
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
}

function parseRuns(value: unknown): readonly WorkflowRun[] {
  const payload = record(value, "run-read");
  if (!Array.isArray(payload.workflow_runs) || payload.workflow_runs.length > ACTIONS_PAGE_SIZE) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.runs", "invalid-metadata", undefined, "run-read");
  }
  return payload.workflow_runs.map((candidate) => parseRun(candidate));
}

function parseJobs(value: unknown, expectedRunId: number): void {
  const payload = record(value, "jobs-read");
  if (!Array.isArray(payload.jobs) || payload.jobs.length > ACTIONS_PAGE_SIZE) {
    throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.jobs", "invalid-metadata", undefined, "jobs-read");
  }
  for (const candidate of payload.jobs) {
    const job = record(candidate, "jobs-read");
    const runId = positiveInteger(job.run_id, "jobs-read");
    if (runId !== expectedRunId) {
      throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", "actions.jobs", "wrong-run", undefined, "correlation");
    }
    positiveInteger(job.id, "jobs-read");
    if (job.status !== "queued" && job.status !== "in_progress" && job.status !== "completed") {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.jobs", "invalid-metadata", undefined, "jobs-read");
    }
    if (job.conclusion !== null && typeof job.conclusion !== "string") {
      throw remoteError("CHANGE_REMOTE_RESULT_INVALID", "actions.jobs", "invalid-metadata", undefined, "jobs-read");
    }
  }
}

function parseArtifact(value: unknown, expectedName: string, expectedRepositoryId: string): WorkflowArtifact {
  const item = record(value, "artifact-read");
  if (item.name !== expectedName) {
    throw remoteError(
      "CHANGE_REMOTE_CORRELATION_FAILED",
      "actions.artifacts",
      "wrong-artifact",
      undefined,
      "correlation",
    );
  }
  const workflowRun = record(item.workflow_run, "artifact-read");
  const repositoryId =
    workflowRun.repository_id === undefined ? undefined : positiveInteger(workflowRun.repository_id, "artifact-read");
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
}

function parseArtifacts(
  value: unknown,
  expectedName: string,
  expectedRepositoryId: string,
): readonly WorkflowArtifact[] {
  const payload = record(value, "artifact-read");
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length > ACTIONS_PAGE_SIZE) {
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
    .map((candidate) => parseArtifact(candidate, expectedName, expectedRepositoryId));
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
    request.mergeStrategy,
    request.implementationConformance,
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
  if (typeof details !== "object" || details === null || Array.isArray(details)) return false;
  try {
    return (
      normalizeGitHubProviderFailureClassification((details as { readonly providerFailure?: unknown }).providerFailure)
        ?.retryable === true
    );
  } catch {
    return false;
  }
}

const NATIVE_ACTIONS_MAX_RESPONSE_BYTES = 1_048_576;
const NATIVE_ACTIONS_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

class NativeActionsApiError extends Error {
  readonly reason: "authentication" | "response" | "timeout";
  readonly providerFailure: GitHubProviderFailureClassification;

  constructor(
    reason: "authentication" | "response" | "timeout",
    providerFailure: GitHubProviderFailureClassification = reason === "authentication"
      ? githubProviderFailure("authentication", { retryable: false })
      : reason === "timeout"
        ? githubProviderFailure("timeout", { retryable: true })
        : githubProviderFailure("response-invalid", { retryable: false }),
  ) {
    super(
      reason === "authentication"
        ? "GitHub Actions authentication failed."
        : reason === "timeout"
          ? "GitHub Actions request exceeded its bounded deadline."
          : "GitHub Actions API request failed.",
    );
    this.name = "NativeActionsApiError";
    this.reason = reason;
    this.providerFailure = providerFailure;
  }
}

function assertActionsApiPath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("..") ||
    !/^actions\//u.test(value)
  ) {
    throw new NativeActionsApiError("response");
  }
}

function assertRepositoryApiPath(value: string): void {
  if (
    value.length > 2_048 ||
    value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("..") ||
    (value !== "" && !/^(?:issues\/|pulls(?:\/|\?|$)|git\/|branches\/|commits\/)/u.test(value))
  ) {
    throw new NativeActionsApiError("response");
  }
}

function nativeRecord(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeActionsApiError("response");
  }
  return value as Record<string, unknown>;
}

function nativeText(value: unknown, maximum: number, operation: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new NativeActionsApiError("response");
  }
  return value;
}

function nativeActionsBody(fields: Readonly<Record<string, string>>): GitHubChangeEffectJsonObject {
  const body: Record<string, GitHubChangeEffectJsonValue> = {};
  let inputs: Record<string, GitHubChangeEffectJsonValue> | undefined;
  for (const [name, value] of Object.entries(fields)) {
    const input = /^inputs\[([^\]]+)\]$/u.exec(name)?.[1];
    if (input !== undefined) {
      inputs ??= {};
      inputs[input] = value;
    } else {
      body[name] = value;
    }
  }
  if (inputs !== undefined) body.inputs = inputs;
  return body;
}

function nativeRepositoryResponseStatus(status: number, headers?: Readonly<Record<string, string>>): void {
  if (status >= 200 && status < 300) return;
  const providerFailure = githubProviderFailureFromStatus(status, headers);
  throw new NativeActionsApiError(
    providerFailure.failureClass === "authentication" ? "authentication" : "response",
    providerFailure,
  );
}

function nativeTree(value: unknown): RepositoryTree {
  const payload = nativeRecord(value, "repository.governance.tree");
  if (payload.truncated !== false || !Array.isArray(payload.tree)) {
    throw new NativeActionsApiError("response");
  }
  const sha = nativeText(payload.sha, 128, "repository.governance.tree");
  const entries = payload.tree.map((candidate) => {
    const entry = nativeRecord(candidate, "repository.governance.tree");
    const path = nativeText(entry.path, 4_096, "repository.governance.tree");
    const entrySha = nativeText(entry.sha, 128, "repository.governance.tree");
    if (entry.type !== "blob" && entry.type !== "tree") throw new NativeActionsApiError("response");
    return { path, type: entry.type, sha: entrySha } as const;
  });
  return { sha, entries };
}

/**
 * Native Actions provider API. It owns only bounded provider I/O and
 * repository identity resolution; the Actions adapter remains responsible for
 * correlation, polling, artifact framing, and Change semantics.
 */
export interface ActionsChangeExecutionNativeHttpApiOptions {
  readonly cwd: string;
  readonly repository?: string;
  readonly token?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly apiUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

export class ActionsChangeExecutionNativeHttpApi
  implements ActionsChangeExecutionAdapterApi, GitHubChangeProjectionApi
{
  readonly #cwd: string;
  readonly #repository: string | undefined;
  readonly #token: string | undefined;
  readonly #apiUrl: string | undefined;
  readonly #env: Readonly<Record<string, string | undefined>> | undefined;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #requestTimeoutMs: number;
  #credential: string | undefined;
  #contextValue: RepositoryContext | undefined;
  #contextPromise: Promise<RepositoryContext> | undefined;

  constructor(options: ActionsChangeExecutionNativeHttpApiOptions) {
    this.#cwd = options.cwd;
    this.#repository = options.repository;
    this.#token = options.token;
    this.#apiUrl = options.apiUrl ?? options.env?.GITHUB_API_URL ?? process.env.GITHUB_API_URL;
    this.#env = options.env;
    this.#fetch = options.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? NATIVE_ACTIONS_DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getRepositoryContext(deadline?: ChangeExecutionDeadline): Promise<RepositoryContext> {
    if (this.#contextValue !== undefined) return this.#contextValue;
    if (deadline === undefined) {
      if (this.#contextPromise === undefined) {
        const pending = this.resolveRepositoryContext(undefined);
        this.#contextPromise = pending;
        pending.catch(() => {
          if (this.#contextPromise === pending) this.#contextPromise = undefined;
        });
      }
      return this.#contextPromise;
    }
    return this.resolveRepositoryContext(deadline);
  }

  async requestActionsApi(
    actionsPath: string,
    method: "GET" | "POST",
    fields: Readonly<Record<string, string>> = {},
    deadline?: ChangeExecutionDeadline,
  ): Promise<unknown> {
    assertActionsApiPath(actionsPath);
    const context = await this.getRepositoryContext(deadline);
    const response = await this.request(
      context,
      method,
      `repos/${context.nameWithOwner}/actions/${actionsPath.slice("actions/".length)}`,
      method === "POST" ? nativeActionsBody(fields) : undefined,
      deadline,
    );
    nativeRepositoryResponseStatus(response.status, response.headers);
    return response.body;
  }

  async inspectActionsJobs(runId: number, deadline?: ChangeExecutionDeadline): Promise<void> {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new NativeActionsApiError("response");
    for (let page = 1; page <= MAX_ACTION_RUN_PAGES; page += 1) {
      const value = await this.requestActionsApi(
        `actions/runs/${runId}/jobs?per_page=${ACTIONS_PAGE_SIZE}&page=${page}`,
        "GET",
        {},
        deadline,
      );
      parseJobs(value, runId);
      const entries = nativeRecord(value, "jobs-read").jobs;
      if (!Array.isArray(entries) || entries.length < ACTIONS_PAGE_SIZE) return;
      if (deadline !== undefined && deadline.remainingMs() <= 0) throw new NativeActionsApiError("timeout");
    }
  }

  async downloadActionsArtifact(artifactId: number, deadline?: ChangeExecutionDeadline): Promise<Uint8Array> {
    if (!Number.isSafeInteger(artifactId) || artifactId < 1) throw new NativeActionsApiError("response");
    const context = await this.getRepositoryContext(deadline);
    const transport = this.transport(deadline);
    const response = await transport.requestBinary({
      hostname: context.hostname,
      method: "GET",
      path: `repos/${context.nameWithOwner}/actions/artifacts/${artifactId}/zip`,
    });
    nativeRepositoryResponseStatus(response.status, response.headers);
    if (response.bytes === undefined) throw new NativeActionsApiError("response");
    return response.bytes;
  }

  async getRepositoryDefaultBranch(deadline?: ChangeExecutionDeadline): Promise<string> {
    const response = await this.requestRepositoryApi("", "GET", deadline);
    nativeRepositoryResponseStatus(response.status, response.headers);
    return nativeText(
      nativeRecord(response.body, "repository.default_branch").default_branch,
      255,
      "repository.default_branch",
    );
  }

  async getRepositoryTree(ref: string, deadline?: ChangeExecutionDeadline): Promise<RepositoryTree> {
    const response = await this.requestRepositoryApi(
      `git/trees/${encodeURIComponent(nativeText(ref, 255, "repository.governance.tree"))}?recursive=1`,
      "GET",
      deadline,
    );
    nativeRepositoryResponseStatus(response.status, response.headers);
    return nativeTree(response.body);
  }

  async getRepositoryBlob(sha: string, deadline?: ChangeExecutionDeadline): Promise<string> {
    const response = await this.requestRepositoryApi(
      `git/blobs/${encodeURIComponent(nativeText(sha, 128, "repository.governance.blob"))}`,
      "GET",
      deadline,
    );
    nativeRepositoryResponseStatus(response.status, response.headers);
    const body = nativeRecord(response.body, "repository.governance.blob");
    if (body.encoding !== "base64") throw new NativeActionsApiError("response");
    if (
      typeof body.content !== "string" ||
      body.content.length === 0 ||
      body.content.length > NATIVE_ACTIONS_MAX_RESPONSE_BYTES
    ) {
      throw new NativeActionsApiError("response");
    }
    const content = body.content.replace(/[ \t\r\n]+/gu, "");
    if (content.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)) {
      throw new NativeActionsApiError("response");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(content, "base64"));
    } catch {
      throw new NativeActionsApiError("response");
    }
  }

  async requestRepositoryApi(
    repositoryPath: string,
    method: "GET" = "GET",
    deadline?: ChangeExecutionDeadline,
  ): Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  }> {
    assertRepositoryApiPath(repositoryPath);
    const context = await this.getRepositoryContext(deadline);
    const response = await this.request(
      context,
      method,
      repositoryPath === "" ? `repos/${context.nameWithOwner}` : `repos/${context.nameWithOwner}/${repositoryPath}`,
      undefined,
      deadline,
    );
    if (response.status !== 404) nativeRepositoryResponseStatus(response.status, response.headers);
    return { status: response.status, body: response.body };
  }

  private async resolveRepositoryContext(deadline: ChangeExecutionDeadline | undefined): Promise<RepositoryContext> {
    const context = resolveLocalRepositoryContext({ cwd: this.#cwd, repository: this.#repository });
    const credential = resolveGitHubUserCredential({
      hostname: context.hostname,
      ...(this.#token === undefined ? {} : { token: this.#token }),
      ...(this.#env === undefined ? {} : { env: this.#env }),
    });
    this.#credential = credential.token;
    const resolved = await resolveGitHubRepository(
      {
        hostname: context.hostname,
        owner: context.owner,
        name: context.name,
      } satisfies GitHubChangeEffectRepository,
      this.transport(deadline),
    );
    const complete = Object.freeze({ ...context, repositoryId: resolved.target.repositoryId });
    this.#contextValue = complete;
    return complete;
  }

  private transport(deadline?: ChangeExecutionDeadline): GitHubNativeHttpTransport {
    const remaining = deadline?.remainingMs();
    if (remaining !== undefined && remaining <= 0) {
      throw new NativeActionsApiError("timeout", githubProviderFailure("timeout", { retryable: true }));
    }
    const timeout =
      remaining === undefined
        ? this.#requestTimeoutMs
        : Math.max(1, Math.min(this.#requestTimeoutMs, Math.floor(remaining)));
    const credential =
      this.#credential ??
      resolveGitHubUserCredential({
        ...(this.#token === undefined ? {} : { token: this.#token }),
        ...(this.#env === undefined ? {} : { env: this.#env }),
      }).token;
    this.#credential = credential;
    return new GitHubNativeHttpTransport({
      token: credential,
      ...(this.#apiUrl === undefined ? {} : { apiUrl: this.#apiUrl }),
      fetch: this.#fetch,
      requestTimeoutMs: timeout,
      maxResponseBytes: NATIVE_ACTIONS_MAX_RESPONSE_BYTES,
    });
  }

  private async request(
    context: RepositoryContext,
    method: "GET" | "POST",
    path: string,
    body: GitHubChangeEffectJsonObject | undefined,
    deadline?: ChangeExecutionDeadline,
  ) {
    return this.transport(deadline).request({
      hostname: context.hostname,
      method,
      path,
      ...(body === undefined ? {} : { body }),
    });
  }
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
    const api =
      options.api ??
      new ActionsChangeExecutionNativeHttpApi({
        cwd: options.cwd,
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      });
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
    const baseline = await this.readBaselineRuns(operation, deadline);
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
      ...(request.mergeStrategy === undefined ? {} : { mergeStrategy: request.mergeStrategy }),
      ...(request.implementationConformance === undefined
        ? {}
        : { implementationConformance: request.implementationConformance }),
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

  private async readRuns(
    operation: string,
    deadline: ChangeExecutionDeadline,
    correlation?: string,
  ): Promise<readonly WorkflowRun[]> {
    return this.withinDeadline(
      operation,
      deadline,
      async () => {
        const runs: WorkflowRun[] = [];
        for (let page = 1; page <= MAX_ACTION_RUN_PAGES; page += 1) {
          let value: unknown;
          try {
            value = await this.#api.requestActionsApi(workflowRunsPath(page), "GET", {}, deadline);
          } catch (error: unknown) {
            throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "run-read");
          }
          const pageRuns = parseRuns(value);
          runs.push(...pageRuns);
          if (runs.length > MAX_ACTION_RUNS) {
            throw remoteError(
              "CHANGE_REMOTE_RESULT_INVALID",
              "actions.runs",
              "invalid-metadata",
              undefined,
              "run-read",
            );
          }
          if (correlation !== undefined && pageRuns.some((run) => isCorrelatedRun(run, correlation))) return runs;
          if (pageRuns.length < ACTIONS_PAGE_SIZE) return runs;
          this.assertDeadline(operation, deadline, "run-read");
        }
        return runs;
      },
      "run-read",
    );
  }

  private async readBaselineRuns(
    operation: string,
    deadline: ChangeExecutionDeadline,
  ): Promise<readonly WorkflowRun[]> {
    for (let attempt = 0; deadline.remainingMs() > 0 && attempt < this.#maxPollAttempts; attempt += 1) {
      try {
        return await this.readRuns(operation, deadline);
      } catch (error: unknown) {
        if (!isRetryablePollTransportError(error) || deadline.remainingMs() <= 0) throw error;
        if (attempt + 1 < this.#maxPollAttempts && deadline.remainingMs() > 0) {
          await this.#sleep(this.#pollIntervalMs);
        }
      }
    }
    throw remoteError("CHANGE_REMOTE_RUN_FAILED", operation, "result-timeout", undefined, "run-read");
  }

  private async readExactRun(
    operation: string,
    runId: number,
    correlation: string,
    deadline: ChangeExecutionDeadline,
  ): Promise<WorkflowRun> {
    return this.withinDeadline(
      operation,
      deadline,
      async () => {
        let value: unknown;
        try {
          value = await this.#api.requestActionsApi(workflowRunPath(runId), "GET", {}, deadline);
        } catch (error: unknown) {
          throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "run-read");
        }
        const run = parseRun(value);
        if (run.id !== runId || !isCorrelatedRun(run, correlation)) {
          throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "wrong-run", undefined, "correlation");
        }
        return run;
      },
      "run-read",
    );
  }

  private async readExactArtifact(
    operation: string,
    artifactId: number,
    artifactName: string,
    repositoryId: string,
    runId: number,
    deadline: ChangeExecutionDeadline,
  ): Promise<WorkflowArtifact> {
    return this.withinDeadline(
      operation,
      deadline,
      async () => {
        let value: unknown;
        try {
          value = await this.#api.requestActionsApi(artifactPath(artifactId), "GET", {}, deadline);
        } catch (error: unknown) {
          throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "artifact-read");
        }
        const artifact = parseArtifact(value, artifactName, repositoryId);
        if (artifact.id !== artifactId || artifact.workflowRunId !== runId) {
          throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "wrong-artifact", undefined, "correlation");
        }
        return artifact;
      },
      "artifact-read",
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
    let correlatedRun: WorkflowRun | undefined;
    let correlatedArtifact: WorkflowArtifact | undefined;
    let observationStage: ActionsTransportFailureStage = "run-read";
    for (let attempt = 0; deadline.remainingMs() > 0 && attempt < this.#maxPollAttempts; attempt += 1) {
      const timeRemaining = () => deadline.remainingMs() > 0;
      let runs: readonly WorkflowRun[] | undefined;
      let runReadFailed = false;
      let runRecoveredByExactObservation = false;
      let runListConfirmedCorrelation = false;
      observationStage = "run-read";
      try {
        runs = await this.readRuns(operation, deadline, correlation);
      } catch (error: unknown) {
        if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
        runReadFailed = true;
      }

      if (runs !== undefined) {
        const correlatedRuns = runs.filter((candidate) => isCorrelatedRun(candidate, correlation));
        if (correlatedRuns.length > 1) {
          throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "ambiguous-run", undefined, "correlation");
        }
        const observedRun = correlatedRuns[0];
        if (observedRun !== undefined) {
          runListConfirmedCorrelation = true;
          if (correlatedRun !== undefined && correlatedRun.id !== observedRun.id) {
            throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "ambiguous-run", undefined, "correlation");
          }
          correlatedRun = observedRun;
        }
      }

      // Once the run-name match has established a request/run pair, a later
      // list failure or omission cannot erase that identity. Observe the
      // exact run by its established ID under the same deadline before
      // deciding whether to retry.
      if (correlatedRun !== undefined && (runReadFailed || !runListConfirmedCorrelation)) {
        try {
          correlatedRun = await this.readExactRun(operation, correlatedRun.id, correlation, deadline);
          runRecoveredByExactObservation = true;
        } catch (error: unknown) {
          if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
          await this.#sleep(this.#pollIntervalMs);
          continue;
        }
      }

      // A transient list failure before any positive run evidence remains
      // fail-closed: an artifact name or candidate count cannot establish the
      // request identity by itself.
      if (runs === undefined && correlatedRun === undefined) {
        await this.#sleep(this.#pollIntervalMs);
        continue;
      }
      // The run-name correlation is the only identity evidence used below.
      // Candidate count, "new since baseline", and observation order never
      // decide which run belongs to this request.
      let artifacts: readonly WorkflowArtifact[];
      let artifact: WorkflowArtifact | undefined;
      if (correlatedRun !== undefined && this.#api.inspectActionsJobs !== undefined) {
        observationStage = "jobs-read";
        try {
          await this.withinDeadline(
            operation,
            deadline,
            () => this.#api.inspectActionsJobs?.(correlatedRun!.id, deadline) ?? Promise.resolve(),
            "jobs-read",
          );
        } catch (error: unknown) {
          const normalized = normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "jobs-read");
          if (!isRetryablePollTransportError(normalized) || !timeRemaining()) throw normalized;
          await this.#sleep(this.#pollIntervalMs);
          continue;
        }
      }
      observationStage = "artifact-read";
      if (runRecoveredByExactObservation && correlatedArtifact !== undefined && correlatedRun !== undefined) {
        try {
          artifact = await this.readExactArtifact(
            operation,
            correlatedArtifact.id,
            artifactName,
            repositoryId,
            correlatedRun.id,
            deadline,
          );
        } catch (error: unknown) {
          if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
          await this.#sleep(this.#pollIntervalMs);
          continue;
        }
        artifacts = [artifact];
      } else {
        try {
          artifacts = await this.readArtifacts(operation, artifactName, repositoryId, deadline);
        } catch (error: unknown) {
          if (correlatedArtifact === undefined || correlatedRun === undefined) {
            if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
            await this.#sleep(this.#pollIntervalMs);
            continue;
          }
          try {
            artifact = await this.readExactArtifact(
              operation,
              correlatedArtifact.id,
              artifactName,
              repositoryId,
              correlatedRun.id,
              deadline,
            );
            artifacts = [artifact];
          } catch (exactError: unknown) {
            if (!isRetryablePollTransportError(exactError) || !timeRemaining()) throw exactError;
            await this.#sleep(this.#pollIntervalMs);
            continue;
          }
        }
      }
      if (artifacts.length === 0 && correlatedArtifact !== undefined && correlatedRun !== undefined) {
        try {
          artifact = await this.readExactArtifact(
            operation,
            correlatedArtifact.id,
            artifactName,
            repositoryId,
            correlatedRun.id,
            deadline,
          );
          artifacts = [artifact];
        } catch (error: unknown) {
          if (!isRetryablePollTransportError(error) || !timeRemaining()) throw error;
          await this.#sleep(this.#pollIntervalMs);
          continue;
        }
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
      artifact ??= artifacts[0];
      if (artifact !== undefined && artifact.expired) {
        throw remoteError("CHANGE_REMOTE_CORRELATION_FAILED", operation, "expired-artifact", undefined, "correlation");
      }
      if (artifact !== undefined && correlatedRun !== undefined && artifact.workflowRunId === correlatedRun.id) {
        if (correlatedArtifact !== undefined && correlatedArtifact.id !== artifact.id) {
          throw remoteError(
            "CHANGE_REMOTE_CORRELATION_FAILED",
            operation,
            "ambiguous-artifact",
            undefined,
            "correlation",
          );
        }
        correlatedArtifact = artifact;
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
        const artifacts: WorkflowArtifact[] = [];
        for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
          let value: unknown;
          try {
            value = await this.#api.requestActionsApi(artifactsPath(name, page), "GET", {}, deadline);
          } catch (error: unknown) {
            throw normalizeTransportError(error, operation, "CHANGE_REMOTE_TRANSPORT_FAILED", "artifact-read");
          }
          const pageArtifacts = parseArtifacts(value, name, repositoryId);
          artifacts.push(...pageArtifacts);
          if (artifacts.length > MAX_ARTIFACTS) {
            throw remoteError(
              "CHANGE_REMOTE_RESULT_INVALID",
              "actions.artifacts",
              "invalid-metadata",
              undefined,
              "artifact-read",
            );
          }
          if (pageArtifacts.length > 0) return artifacts;
          const pageEntries = record(value, "artifact-read").artifacts;
          if (!Array.isArray(pageEntries) || pageEntries.length < ACTIONS_PAGE_SIZE) return artifacts;
          this.assertDeadline(operation, deadline, "artifact-read");
        }
        return artifacts;
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
