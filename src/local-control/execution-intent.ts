import { AUTHORIZED_EXECUTION_OPERATIONS, type AuthorizedExecutionOperation } from "../authorized-execution.js";
import { changeMutationRequest, changeReadRequest } from "../change-execution-port.js";
import { validateBranchAdvanceSemanticRequest } from "../agent-authority/branch-advance.js";
import { MAX_ISSUE_NUMBER } from "../agent-authority/capability.js";
import { tryValidatePrPublicationRequest } from "../pr-publication.js";

export const EXECUTION_INTENT_VERSION = 1 as const;
export const MAX_EXECUTION_INTENT_BYTES = 1_048_576;

export interface ExecutionIntent {
  readonly version: typeof EXECUTION_INTENT_VERSION;
  readonly requestId: string;
  readonly repository: {
    readonly repositoryHost: "github.com";
    readonly repositoryId: string;
    readonly repositoryNameWithOwner?: string;
  };
  readonly operation: AuthorizedExecutionOperation;
  readonly request: unknown;
}

export interface ExecutionIntentValidationResult {
  readonly valid: boolean;
  readonly intent?: ExecutionIntent;
  readonly diagnostics: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveIssue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ISSUE_NUMBER;
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/u.test(value);
}

function normalizeRepository(value: unknown): ExecutionIntent["repository"] | undefined {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["repositoryHost", "repositoryId", "repositoryNameWithOwner"].includes(key)) ||
    typeof value.repositoryHost !== "string" ||
    value.repositoryHost.toLowerCase() !== "github.com" ||
    typeof value.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(value.repositoryId) ||
    (value.repositoryNameWithOwner !== undefined &&
      (typeof value.repositoryNameWithOwner !== "string" ||
        value.repositoryNameWithOwner.length > 255 ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repositoryNameWithOwner) ||
        value.repositoryNameWithOwner.split("/").some((segment) => segment === "." || segment === "..")))
  ) {
    return undefined;
  }
  return Object.freeze({
    repositoryHost: "github.com",
    repositoryId: value.repositoryId,
    ...(typeof value.repositoryNameWithOwner === "string"
      ? { repositoryNameWithOwner: value.repositoryNameWithOwner }
      : {}),
  });
}

function invalid(): ExecutionIntentValidationResult {
  return Object.freeze({ valid: false, diagnostics: Object.freeze(["ExecutionIntent is invalid."]) });
}

function normalizeRequest(operation: AuthorizedExecutionOperation, value: unknown): unknown | undefined {
  if (!record(value)) return undefined;
  if (operation === "branch.advance") {
    const parsed = validateBranchAdvanceSemanticRequest(value);
    return parsed.valid ? parsed.value : undefined;
  }
  if (operation === "pullRequest.publish") {
    const parsed = tryValidatePrPublicationRequest(value);
    if (
      !parsed.valid ||
      parsed.request === undefined ||
      !positiveIssue(parsed.request.workIdentity.implementation?.number)
    )
      return undefined;
    return parsed.request;
  }
  if (!positiveIssue(value.issue)) return undefined;
  if (operation === "change.show") {
    if (
      Object.keys(value).some((key) => !["version", "operation", "issue"].includes(key)) ||
      value.version !== 1 ||
      value.operation !== "show"
    )
      return undefined;
    try {
      return changeReadRequest(value.issue);
    } catch {
      return undefined;
    }
  }
  const requestOperation = operation.slice("change.".length);
  if (value.operation !== requestOperation) return undefined;
  const allowed = new Set([
    "version",
    "operation",
    "issue",
    "semanticPullRequestPlan",
    "signedProvenanceRecord",
    "mergeStrategy",
    "implementationConformance",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1) return undefined;
  try {
    return changeMutationRequest(
      requestOperation as Parameters<typeof changeMutationRequest>[0],
      value.issue,
      value.semanticPullRequestPlan,
      value.signedProvenanceRecord as Parameters<typeof changeMutationRequest>[3],
      value.mergeStrategy as Parameters<typeof changeMutationRequest>[4],
      value.implementationConformance,
    );
  } catch {
    return undefined;
  }
}

/** Validate the closed caller intent. No capability or authorization fields are accepted. */
export function validateExecutionIntent(input: unknown): ExecutionIntentValidationResult {
  const repository = record(input) ? normalizeRepository(input.repository) : undefined;
  if (
    !record(input) ||
    Object.keys(input).some((key) => !["version", "requestId", "repository", "operation", "request"].includes(key)) ||
    input.version !== EXECUTION_INTENT_VERSION ||
    !validRequestId(input.requestId) ||
    repository === undefined ||
    typeof input.operation !== "string" ||
    !AUTHORIZED_EXECUTION_OPERATIONS.includes(input.operation as AuthorizedExecutionOperation)
  ) {
    return invalid();
  }
  const operation = input.operation as AuthorizedExecutionOperation;
  const request = normalizeRequest(operation, input.request);
  if (request === undefined) return invalid();
  return Object.freeze({
    valid: true,
    intent: Object.freeze({
      version: EXECUTION_INTENT_VERSION,
      requestId: input.requestId,
      repository,
      operation,
      request,
    }),
    diagnostics: Object.freeze([]),
  });
}

export function executionIntentIssue(intent: ExecutionIntent): number | undefined {
  if (intent.operation === "pullRequest.publish") {
    const request = intent.request as {
      readonly workIdentity?: { readonly implementation?: { readonly number?: unknown } };
    };
    return positiveIssue(request.workIdentity?.implementation?.number)
      ? request.workIdentity.implementation.number
      : undefined;
  }
  const request = intent.request as { readonly issue?: unknown };
  return positiveIssue(request.issue) ? request.issue : undefined;
}
