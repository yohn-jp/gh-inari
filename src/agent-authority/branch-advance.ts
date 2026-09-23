/** The bounded, credentialless branch-advance execution authority (#466). */
import { createHash } from "node:crypto";
import { validateBranchName } from "../branch-naming.js";
import { MAX_SESSION_REQUEST_BYTES, canonicalizeSemanticRequest } from "./session-request.js";
import { classifyDelegatedTreeDelta } from "./protected-paths.js";
import { MAX_ISSUE_NUMBER } from "./capability.js";
import {
  createCapabilityExecutionProvenance,
  validateCapabilityExecutionProvenance,
  type CapabilityExecutionProvenance,
} from "./capability-provenance.js";
import type { SessionAdmissionAuthorizationContext } from "./session-authentication.js";
import type { SessionAgentMetadata } from "./session-bundle.js";
import {
  isImplementationScopeProjectionPathAllowed,
  isImplementationScopeProjectionPathDenied,
  type ImplementationScopeProjection,
} from "../implementation-scope-projection.js";
import { validateImplementationReworkMarker, type ImplementationReworkMarker } from "../implementation-rework.js";
import type { ImplementationScopeOperation } from "../implementation-contract.js";
import {
  GitDataCapabilityError,
  type GitDataTree,
  type GitDataRefUpdateInput,
  type GitHubBranchAdvanceCapability,
} from "../github/git-data-capability.js";
import type { AdmittedSessionCapability } from "./capability-admission.js";
import { validateIssuerRepositoryIdentity, type RepositoryIdentity } from "../github/effect-authorizer.js";

export const BRANCH_ADVANCE_CONTRACT_VERSION = 1 as const;
export const BRANCH_ADVANCE_OPERATION = "branch.advance" as const;
export const BRANCH_ADVANCE_OUTCOMES = Object.freeze([
  "advanced",
  "idempotent",
  "stale",
  "failed",
  "recovery-required",
] as const);
export type BranchAdvanceOutcome = (typeof BRANCH_ADVANCE_OUTCOMES)[number];
export const BRANCH_ADVANCE_FAILURE_CODES = Object.freeze(["BRANCH_ADVANCE_FAILED"] as const);
export type BranchAdvanceFailureCode = "BRANCH_ADVANCE_FAILED";
export type BranchAdvanceFailureReason =
  | "request"
  | "authorization"
  | "branch-state"
  | "protected-path"
  | "stale-head"
  | "provider"
  | "verification"
  | "recovery-required";

export interface BranchAdvanceCommitAuthor {
  readonly name: string;
  readonly email?: string;
}
export type BranchAdvanceChange =
  | {
      readonly operation: "upsert";
      readonly path: string;
      readonly mode: "100644" | "100755";
      readonly content: string;
    }
  | { readonly operation: "delete"; readonly path: string };
export interface BranchAdvanceSemanticRequest {
  readonly version: 1;
  readonly issue: number;
  readonly branch: string;
  readonly expectedHead: string;
  readonly changes: readonly BranchAdvanceChange[];
  readonly commit: Readonly<{ message: string; author?: Readonly<BranchAdvanceCommitAuthor> }>;
  /** Required when re-entering from a canonical Change in REVIEW. */
  readonly rework?: ImplementationReworkMarker;
  readonly agent?: SessionAgentMetadata;
}
export interface BranchAdvanceExecutionFailure {
  readonly code: "BRANCH_ADVANCE_FAILED";
  readonly reason: BranchAdvanceFailureReason;
  readonly message: string;
}
export interface BranchAdvanceSemanticResult {
  readonly version: 1;
  readonly operation: "branch.advance";
  readonly status: "succeeded" | "failed";
  readonly outcome: BranchAdvanceOutcome;
  readonly branch: string;
  readonly expectedHead: string;
  readonly resultingHead?: string;
  readonly provenance?: CapabilityExecutionProvenance;
  readonly failure?: BranchAdvanceExecutionFailure;
}
export interface BranchAdvanceDiagnostic {
  readonly code: "BRANCH_ADVANCE_FAILED";
  readonly reason: BranchAdvanceFailureReason;
  readonly path: string;
  readonly message: string;
}
export interface BranchAdvanceValidationResult {
  readonly valid: boolean;
  readonly value?: BranchAdvanceSemanticRequest;
  readonly diagnostics: readonly BranchAdvanceDiagnostic[];
}
export interface BranchAdvanceCapabilityBroker {
  withBranchAdvanceCapability: <T>(
    request: { readonly target: RepositoryIdentity },
    operation: (capability: GitHubBranchAdvanceCapability) => Promise<T>,
  ) => Promise<T>;
}
export interface ExecuteBranchAdvanceOptions {
  readonly context: SessionAdmissionAuthorizationContext;
  readonly broker: BranchAdvanceCapabilityBroker;
  readonly admission: AdmittedSessionCapability;
  readonly request?: unknown;
  readonly now?: Date | number | (() => Date | number);
}

export type BranchAdvanceAuthorizedPathOperation = Exclude<ImplementationScopeOperation, "READONLY">;

export interface BranchAdvanceAuthorizedPath {
  readonly path: string;
  /** The exact Implementation scope operations admitted for this requested path. */
  readonly operations: readonly BranchAdvanceAuthorizedPathOperation[];
}

/**
 * Bounded path authorization issued after Session/Implementation Admission.
 * The request digest binds this evidence to the complete signed semantic
 * request without carrying the Session request signature or Session context.
 */
export interface BranchAdvanceAuthorizationEvidence {
  readonly version: 1;
  readonly requestDigest: string;
  readonly implementation: Readonly<{ number: number; governedBodyDigest: string }>;
  readonly paths: readonly BranchAdvanceAuthorizedPath[];
}

export interface BranchAdvanceAuthorizationOptions {
  readonly context: SessionAdmissionAuthorizationContext;
  readonly admission: AdmittedSessionCapability;
  readonly request?: unknown;
}

export type BranchAdvanceAuthorizationResult =
  | Readonly<{
      readonly valid: true;
      readonly request: BranchAdvanceSemanticRequest;
      readonly authorization: BranchAdvanceAuthorizationEvidence;
    }>
  | Readonly<{ readonly valid: false; readonly failure: BranchAdvanceSemanticResult }>;

export interface ExecuteBranchAdvanceEffectsOptions {
  readonly repository: RepositoryIdentity;
  readonly provenance: CapabilityExecutionProvenance;
  readonly request: unknown;
  readonly authorization: unknown;
  readonly broker: BranchAdvanceCapabilityBroker;
  readonly now?: Date | number | (() => Date | number);
}

const KEYS = new Set(["version", "issue", "branch", "expectedHead", "changes", "commit", "rework", "agent"]);
const COMMIT_KEYS = new Set(["message", "author"]);
const AUTHOR_KEYS = new Set(["name", "email"]);
const CHANGE_KEYS = new Set(["operation", "path", "mode", "content"]);
const SHA = /^[0-9a-f]{40}$/u;
const SAFE = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_TEXT = 4096;
const MAX_CHANGES = 4096;
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" &&
  x !== null &&
  !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const own = (x: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(x, k);
function diag(path: string, message: string, reason: BranchAdvanceFailureReason = "request"): BranchAdvanceDiagnostic {
  return { code: "BRANCH_ADVANCE_FAILED", reason, path, message };
}
function unknowns(
  x: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  out: BranchAdvanceDiagnostic[],
) {
  for (const k of Object.keys(x)) if (!allowed.has(k)) out.push(diag(`${path}.${k}`, "Property is not accepted."));
}
function text(x: unknown, n: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= n && SAFE.test(x);
}
function freeze<T>(x: T): T {
  if (typeof x !== "object" || x === null || Object.isFrozen(x)) return x;
  for (const v of Object.values(x as Record<string, unknown>)) freeze(v);
  return Object.freeze(x);
}
function decodeBase64(content: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)) return undefined;
  const bytes = Buffer.from(content, "base64");
  return bytes.toString("base64") === content ? bytes : undefined;
}
function blobSha(content: string): string {
  const b = decodeBase64(content);
  if (b === undefined) return "";
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${b.byteLength}\0`), b]))
    .digest("hex");
}

export function validateBranchAdvanceSemanticRequest(input: unknown): BranchAdvanceValidationResult {
  const d: BranchAdvanceDiagnostic[] = [];
  if (!record(input)) return { valid: false, diagnostics: [diag("$", "Request must be an object.")] };
  unknowns(input, KEYS, "$", d);
  try {
    if (Buffer.byteLength(canonicalizeSemanticRequest(input), "utf8") > MAX_SESSION_REQUEST_BYTES)
      d.push(diag("$", "Request exceeds the Session request bound."));
  } catch {
    d.push(diag("$", "Request is not canonical JSON."));
  }
  if (
    input.version !== 1 ||
    !Number.isSafeInteger(input.issue) ||
    (input.issue as number) < 1 ||
    (input.issue as number) > MAX_ISSUE_NUMBER
  )
    d.push(diag("$.issue", "Issue must be a positive bounded integer."));
  if (!text(input.branch, 255) || input.branch === "main" || validateBranchName(input.branch).length !== 0)
    d.push(diag("$.branch", "Branch must be a canonical non-default branch name."));
  if (!text(input.expectedHead, 40) || !SHA.test(input.expectedHead))
    d.push(diag("$.expectedHead", "Expected head must be a lowercase commit SHA."));
  if (!record(input.commit)) d.push(diag("$.commit", "Commit metadata is required."));
  else {
    unknowns(input.commit, COMMIT_KEYS, "$.commit", d);
    if (!text(input.commit.message, MAX_TEXT)) d.push(diag("$.commit.message", "Commit message is invalid."));
    if (own(input.commit, "author")) {
      if (!record(input.commit.author)) d.push(diag("$.commit.author", "Author must be an object."));
      else {
        unknowns(input.commit.author, AUTHOR_KEYS, "$.commit.author", d);
        if (!text(input.commit.author.name, 128)) d.push(diag("$.commit.author.name", "Author name is invalid."));
        if (
          input.commit.author.email !== undefined &&
          (!text(input.commit.author.email, 320) || !input.commit.author.email.includes("@"))
        )
          d.push(diag("$.commit.author.email", "Author email is invalid."));
      }
    }
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > MAX_CHANGES)
    d.push(diag("$.changes", "Changes must be a bounded non-empty array."));
  let rework: ImplementationReworkMarker | undefined;
  if (input.rework !== undefined) {
    const marker = validateImplementationReworkMarker(input.rework);
    if (!marker.valid || marker.marker === undefined) {
      for (const violation of marker.diagnostics)
        d.push(diag(`$.rework${violation.path === "$" ? "" : violation.path.slice(1)}`, violation.message));
    } else rework = marker.marker;
  }
  const changes: BranchAdvanceChange[] = [];
  const paths = new Set<string>();
  if (Array.isArray(input.changes))
    for (const [i, raw] of input.changes.entries()) {
      const p = `$.changes[${i}]`;
      if (!record(raw)) {
        d.push(diag(p, "Change must be an object."));
        continue;
      }
      unknowns(raw, CHANGE_KEYS, p, d);
      if (
        typeof raw.path !== "string" ||
        classifyDelegatedTreeDelta({ changes: [{ operation: "modify", path: raw.path }] }).kind === "invalid"
      )
        d.push(diag(`${p}.path`, "Path is invalid."));
      if (paths.has(raw.path as string)) d.push(diag(`${p}.path`, "A path may occur only once."));
      paths.add(raw.path as string);
      if (raw.operation === "delete") {
        if (Object.keys(raw).some((k) => k === "mode" || k === "content"))
          d.push(diag(p, "Delete accepts only operation and path."));
        else changes.push({ operation: "delete", path: raw.path as string });
      } else if (
        raw.operation === "upsert" &&
        (raw.mode === "100644" || raw.mode === "100755") &&
        typeof raw.content === "string" &&
        raw.content.length <= MAX_SESSION_REQUEST_BYTES
      ) {
        if (decodeBase64(raw.content) === undefined) d.push(diag(`${p}.content`, "Content must be canonical base64."));
        else changes.push({ operation: "upsert", path: raw.path as string, mode: raw.mode, content: raw.content });
      } else d.push(diag(p, "Only upsert (100644/100755/content) and delete operations are accepted."));
    }
  if (d.length) return { valid: false, diagnostics: Object.freeze(d.slice(0, 32)) };
  const c = input.commit as Record<string, unknown>;
  const a = c.author as Record<string, unknown> | undefined;
  return {
    valid: true,
    diagnostics: [],
    value: freeze({
      version: 1,
      issue: input.issue as number,
      branch: input.branch as string,
      expectedHead: input.expectedHead as string,
      changes,
      commit: {
        message: c.message as string,
        ...(a === undefined
          ? {}
          : { author: { name: a.name as string, ...(a.email === undefined ? {} : { email: a.email as string }) } }),
      },
      ...(rework === undefined ? {} : { rework }),
      ...(input.agent === undefined ? {} : { agent: input.agent as SessionAgentMetadata }),
    }) as unknown as BranchAdvanceSemanticRequest,
  };
}

function result(
  request: Partial<BranchAdvanceSemanticRequest> | undefined,
  outcome: BranchAdvanceOutcome,
  failure?: BranchAdvanceExecutionFailure,
  resultingHead?: string,
  provenance?: CapabilityExecutionProvenance,
): BranchAdvanceSemanticResult {
  return freeze({
    version: 1,
    operation: BRANCH_ADVANCE_OPERATION,
    status: failure ? "failed" : "succeeded",
    outcome,
    branch: request?.branch ?? "",
    expectedHead: request?.expectedHead ?? "",
    ...(resultingHead === undefined ? {} : { resultingHead }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(failure === undefined ? {} : { failure }),
  });
}
function fail(
  r: Partial<BranchAdvanceSemanticRequest> | undefined,
  reason: BranchAdvanceFailureReason,
  message: string,
  outcome: BranchAdvanceOutcome = "failed",
) {
  return result(r, outcome, { code: "BRANCH_ADVANCE_FAILED", reason, message });
}

type ReplayTreeEntry = Pick<GitDataTree["entries"][number], "mode" | "type" | "sha">;

/**
 * Return the provider's complete file snapshot, excluding only structural
 * directory entries.  Tree entry SHAs change when a child changes, so they
 * cannot be compared as file state; blobs and submodule (commit) entries are
 * part of the target state and must be compared exactly.
 */
function replaySnapshot(tree: GitDataTree): Map<string, ReplayTreeEntry> | undefined {
  const entries = new Map<string, ReplayTreeEntry>();
  for (const entry of tree.entries) {
    if (entry.type === "tree") continue;
    if (entries.has(entry.path)) return undefined;
    entries.set(entry.path, { mode: entry.mode, type: entry.type, sha: entry.sha });
  }
  return entries;
}

/**
 * Prove the exact requested target against the signed expected-head tree.
 * Checking only changed paths is insufficient: a concurrent update to an
 * unrelated path would otherwise be reported as an idempotent replay.
 */
function provesTarget(
  tree: GitDataTree,
  expectedHeadTree: GitDataTree,
  request: BranchAdvanceSemanticRequest,
): boolean {
  const expected = replaySnapshot(expectedHeadTree);
  const actual = replaySnapshot(tree);
  if (expected === undefined || actual === undefined) return false;

  for (const change of request.changes) {
    if (change.operation === "delete") {
      const before = expected.get(change.path);
      // A delete of a missing/non-blob entry could not have been a successful
      // branch.advance mutation, so it cannot establish idempotent success.
      if (before === undefined || before.type !== "blob") return false;
      expected.delete(change.path);
      continue;
    }
    expected.set(change.path, { mode: change.mode, type: "blob", sha: blobSha(change.content) });
  }

  if (actual.size !== expected.size) return false;
  for (const [path, expectedEntry] of expected) {
    const actualEntry = actual.get(path);
    if (
      actualEntry === undefined ||
      actualEntry.mode !== expectedEntry.mode ||
      actualEntry.type !== expectedEntry.type ||
      actualEntry.sha !== expectedEntry.sha
    )
      return false;
  }
  return true;
}
function verifiedProvenance(
  authorized: CapabilityExecutionProvenance,
  capability: GitHubBranchAdvanceCapability,
  request: BranchAdvanceSemanticRequest,
): CapabilityExecutionProvenance | undefined {
  try {
    return createCapabilityExecutionProvenance({
      ...authorized,
      stage: "verified",
      app: { ...capability.scope.app, installationId: capability.scope.installation.installationId },
      ...(request.commit.author === undefined ? {} : { commitAuthor: request.commit.author }),
      ...(request.agent === undefined ? {} : { agent: request.agent }),
    });
  } catch {
    return undefined;
  }
}

function matchesImplementationScopeBinding(
  context: SessionAdmissionAuthorizationContext,
  scope: ImplementationScopeProjection,
  issue: number,
  branch: string,
): boolean {
  const binding = context.implementationBinding;
  if (binding === undefined) return false;
  return (
    binding.task.kind === "issue" &&
    binding.task.number === issue &&
    binding.authorization.version === scope.authorization.version &&
    binding.authorization.kind === scope.authorization.kind &&
    binding.authorization.contractVersion === scope.authorization.contractVersion &&
    binding.authorization.governedBodyDigest === scope.authorization.governedBodyDigest &&
    binding.authorization.implementation.repositoryHost === scope.authorization.implementation.repositoryHost &&
    binding.authorization.implementation.repositoryId === scope.authorization.implementation.repositoryId &&
    binding.authorization.implementation.number === scope.authorization.implementation.number &&
    binding.authorization.implementation.number === issue &&
    binding.repository.repositoryHost.toLowerCase() === scope.repository.repositoryHost.toLowerCase() &&
    binding.repository.repositoryId === scope.repository.repositoryId &&
    binding.base.branch === scope.base.branch &&
    binding.base.revision === scope.base.revision &&
    binding.base.freshness === scope.base.freshness &&
    context.repository.repositoryHost.toLowerCase() === scope.repository.repositoryHost.toLowerCase() &&
    context.repository.repositoryId === scope.repository.repositoryId &&
    scope.branch === branch
  );
}

function scopeAllows(
  scope: ImplementationScopeProjection,
  operation: ImplementationScopeOperation,
  path: string,
): boolean {
  try {
    return (
      !isImplementationScopeProjectionPathDenied(scope, path) &&
      isImplementationScopeProjectionPathAllowed(scope, operation, path)
    );
  } catch {
    return false;
  }
}

function requestDigest(request: BranchAdvanceSemanticRequest): string {
  return createHash("sha256").update(canonicalizeSemanticRequest(request), "utf8").digest("hex");
}

export interface BranchAdvanceAuthorizationValidationResult {
  readonly valid: boolean;
  readonly authorization?: BranchAdvanceAuthorizationEvidence;
  readonly diagnostics: readonly string[];
}

/** Validate the bounded Admission evidence against the exact branch request. */
export function validateBranchAdvanceAuthorizationEvidence(
  input: unknown,
  requestInput: unknown,
): BranchAdvanceAuthorizationValidationResult {
  const diagnostics: string[] = [];
  const requestResult = validateBranchAdvanceSemanticRequest(requestInput);
  if (!requestResult.valid || requestResult.value === undefined) {
    return { valid: false, diagnostics: Object.freeze(["Branch request is invalid."]) };
  }
  const request = requestResult.value;
  if (!record(input)) return { valid: false, diagnostics: Object.freeze(["Branch authorization is invalid."]) };
  const allowedRoot = new Set(["version", "requestDigest", "implementation", "paths"]);
  if (Object.keys(input).some((key) => !allowedRoot.has(key))) diagnostics.push("Branch authorization is invalid.");
  if (input.version !== 1 || input.requestDigest !== requestDigest(request))
    diagnostics.push("Branch authorization is invalid.");
  if (
    !record(input.implementation) ||
    Object.keys(input.implementation).some((key) => !new Set(["number", "governedBodyDigest"]).has(key)) ||
    input.implementation.number !== request.issue ||
    typeof input.implementation.governedBodyDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.implementation.governedBodyDigest)
  ) {
    diagnostics.push("Branch authorization is invalid.");
  }
  if (!Array.isArray(input.paths) || input.paths.length !== request.changes.length) {
    diagnostics.push("Branch authorization is invalid.");
  } else {
    const normalizedPaths: BranchAdvanceAuthorizedPath[] = [];
    input.paths.forEach((entry, index) => {
      const change = request.changes[index];
      if (
        change === undefined ||
        !record(entry) ||
        Object.keys(entry).some((key) => !new Set(["path", "operations"]).has(key)) ||
        entry.path !== change.path ||
        !Array.isArray(entry.operations)
      ) {
        diagnostics.push("Branch authorization is invalid.");
        return;
      }
      const operations = entry.operations;
      const validValues = change.operation === "delete" ? ["DELETE"] : ["CREATE", "WRITE"];
      if (
        operations.length === 0 ||
        operations.some((operation) => !validValues.includes(operation as string)) ||
        new Set(operations).size !== operations.length ||
        (change.operation === "delete" && (operations.length !== 1 || operations[0] !== "DELETE"))
      ) {
        diagnostics.push("Branch authorization is invalid.");
        return;
      }
      normalizedPaths.push(
        Object.freeze({
          path: change.path,
          operations: Object.freeze([...operations]) as readonly BranchAdvanceAuthorizedPathOperation[],
        }),
      );
    });
    if (diagnostics.length === 0) {
      const implementation = input.implementation as Record<string, unknown>;
      return {
        valid: true,
        authorization: Object.freeze({
          version: 1,
          requestDigest: input.requestDigest as string,
          implementation: Object.freeze({
            number: implementation.number as number,
            governedBodyDigest: implementation.governedBodyDigest as string,
          }),
          paths: Object.freeze(normalizedPaths),
        }),
        diagnostics: Object.freeze([]),
      };
    }
  }
  return { valid: false, diagnostics: Object.freeze(diagnostics.slice(0, 32)) };
}

/**
 * Complete Session, capability, binding, protected-path, and Implementation
 * scope authorization before the post-admission execution boundary. No Git
 * provider capability or mutation is acquired here.
 */
export function authorizeBranchAdvance(options: BranchAdvanceAuthorizationOptions): BranchAdvanceAuthorizationResult {
  const semanticRequest = options?.context?.semanticRequest;
  const candidate = options?.request ?? semanticRequest;
  const validation = validateBranchAdvanceSemanticRequest(candidate);
  if (!validation.valid || validation.value === undefined) {
    return {
      valid: false,
      failure: fail(undefined, "request", validation.diagnostics[0]?.message ?? "Request is invalid."),
    };
  }
  const request = validation.value;
  if (request.rework !== undefined && request.expectedHead !== request.rework.reviewHead) {
    return {
      valid: false,
      failure: fail(request, "stale-head", "Rework review head does not match the expected branch head.", "stale"),
    };
  }
  const context = options.context;
  if (options.request !== undefined) {
    try {
      if (canonicalizeSemanticRequest(options.request) !== canonicalizeSemanticRequest(semanticRequest)) {
        return {
          valid: false,
          failure: fail(request, "authorization", "Request is not the admitted Session request."),
        };
      }
    } catch {
      return { valid: false, failure: fail(request, "authorization", "Request is not the admitted Session request.") };
    }
  }
  if (
    context.repository.repositoryId === "" ||
    context.request.operation !== BRANCH_ADVANCE_OPERATION ||
    context.task?.kind !== "issue" ||
    context.task.number !== request.issue
  ) {
    return { valid: false, failure: fail(request, "authorization", "The request is not admitted for this Issue.") };
  }
  if (request.branch === context.authority.ref || request.branch === "main") {
    return { valid: false, failure: fail(request, "branch-state", "Default-branch writes are forbidden.") };
  }
  const admission = options.admission;
  const subject = admission?.subject;
  if (
    admission?.operation !== BRANCH_ADVANCE_OPERATION ||
    subject?.kind !== "branch" ||
    subject.issue !== request.issue ||
    subject.branch !== request.branch ||
    admission.canonical?.branch !== request.branch ||
    admission.repository?.repositoryHost?.toLowerCase() !== context.repository.repositoryHost.toLowerCase() ||
    admission.repository?.repositoryId !== context.repository.repositoryId ||
    admission.session?.id !== context.session.id ||
    admission.session?.certificateJti !== context.session.certificateJti ||
    admission.request?.requestId !== context.request.requestId ||
    admission.request?.operation !== context.request.operation
  ) {
    return {
      valid: false,
      failure: fail(
        request,
        "authorization",
        "The supplied admission is not the exact branch.advance admission for this request.",
      ),
    };
  }
  if (request.rework !== undefined) {
    if (admission.canonical.state !== "REVIEW" || admission.canonical.pullRequest !== request.rework.pullRequest) {
      return {
        valid: false,
        failure: fail(request, "authorization", "Rework is not bound to the canonical REVIEW pull request."),
      };
    }
    const binding = context.implementationBinding;
    if (binding === undefined || binding.authorization.governedBodyDigest !== request.rework.authorizationDigest) {
      return {
        valid: false,
        failure: fail(request, "authorization", "Rework is not bound to the current Implementation authorization."),
      };
    }
  } else if (admission.canonical.state === "REVIEW") {
    return {
      valid: false,
      failure: fail(request, "authorization", "A REVIEW branch advance requires an explicit bounded rework marker."),
    };
  }
  const capability = admission.capability;
  if (capability.kind !== "branch.advance" || capability.branch !== request.branch) {
    return {
      valid: false,
      failure: fail(request, "authorization", "No exact branch.advance capability was admitted."),
    };
  }
  const classification = classifyDelegatedTreeDelta({
    changes: request.changes.map((change) => ({ operation: "modify" as const, path: change.path })),
  });
  if (classification.kind !== "allowed") {
    return { valid: false, failure: fail(request, "protected-path", classification.message) };
  }
  const implementationScope = context.implementationScope;
  if (
    implementationScope === undefined ||
    !matchesImplementationScopeBinding(context, implementationScope, request.issue, request.branch)
  ) {
    return {
      valid: false,
      failure: fail(request, "authorization", "The current Implementation scope is not bound to this Session request."),
    };
  }
  if (capability.pathPolicy !== undefined) {
    return { valid: false, failure: fail(request, "authorization", "Named path policy could not be resolved.") };
  }
  const paths: BranchAdvanceAuthorizedPath[] = [];
  for (const change of request.changes) {
    const operations: BranchAdvanceAuthorizedPathOperation[] =
      change.operation === "delete"
        ? scopeAllows(implementationScope, "DELETE", change.path)
          ? ["DELETE"]
          : []
        : (["CREATE", "WRITE"] as const).filter((operation) =>
            scopeAllows(implementationScope, operation, change.path),
          );
    if (operations.length === 0) {
      return {
        valid: false,
        failure: fail(
          request,
          "authorization",
          "The proposed tree delta is outside the authorized Implementation scope.",
        ),
      };
    }
    paths.push(Object.freeze({ path: change.path, operations: Object.freeze([...operations]) }));
  }
  const authorization: BranchAdvanceAuthorizationEvidence = Object.freeze({
    version: 1,
    requestDigest: requestDigest(request),
    implementation: Object.freeze({
      number: request.issue,
      governedBodyDigest: implementationScope.authorization.governedBodyDigest,
    }),
    paths: Object.freeze(paths),
  });
  return { valid: true, request, authorization };
}

function sameRepositoryIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase()
  );
}

/** Execute only provider effects from an Admission-authorized branch request. */
export async function executeBranchAdvanceEffects(
  options: ExecuteBranchAdvanceEffectsOptions,
): Promise<BranchAdvanceSemanticResult> {
  const validation = validateBranchAdvanceSemanticRequest(options?.request);
  if (!validation.valid || validation.value === undefined) {
    return fail(undefined, "request", validation.diagnostics[0]?.message ?? "Request is invalid.");
  }
  const request = validation.value;
  if (request.rework !== undefined && request.expectedHead !== request.rework.reviewHead) {
    return fail(request, "stale-head", "Rework review head does not match the expected branch head.", "stale");
  }
  const authorizationResult = validateBranchAdvanceAuthorizationEvidence(options.authorization, request);
  if (!authorizationResult.valid || authorizationResult.authorization === undefined) {
    return fail(request, "authorization", "Branch scope authorization evidence is invalid.");
  }
  const provenanceResult = validateCapabilityExecutionProvenance(options.provenance);
  if (!provenanceResult.valid || provenanceResult.value === undefined) {
    return fail(request, "authorization", "Authorized branch provenance is invalid.");
  }
  const authorized = provenanceResult.value;
  const capabilityClaim = authorized.capability;
  const repositoryResult = validateIssuerRepositoryIdentity(options.repository);
  if (!repositoryResult.valid || repositoryResult.value === undefined) {
    return fail(request, "authorization", "Authorized branch repository is invalid.");
  }
  if (
    authorized.stage !== "authorized" ||
    authorized.request.operation !== BRANCH_ADVANCE_OPERATION ||
    authorized.subject.kind !== "branch" ||
    authorized.subject.issue !== request.issue ||
    authorized.subject.branch !== request.branch ||
    capabilityClaim?.kind !== "branch.advance" ||
    capabilityClaim.branch !== request.branch ||
    capabilityClaim.pathPolicy !== undefined ||
    !sameRepositoryIdentity(authorized.repository, repositoryResult.value) ||
    authorizationResult.authorization.implementation.number !== request.issue
  ) {
    return fail(request, "authorization", "Authorized branch provenance does not match the request.");
  }
  const target = repositoryResult.value;
  try {
    return await options.broker.withBranchAdvanceCapability({ target }, async (capability) => {
      if (!sameRepositoryIdentity(capability.scope.repository, target))
        return fail(request, "authorization", "Capability repository does not match.");
      const ref = await capability.readRef(request.branch);
      if (!ref) return fail(request, "branch-state", "Branch does not exist.");
      const commit = await capability.readCommit(ref.sha);
      const tree = await capability.readTree(commit.treeSha);
      const before: Map<string, { sha: string; mode: string }> = new Map(
        tree.entries
          .filter((entry: { type: string }) => entry.type === "blob")
          .map((entry: { path: string; sha: string; mode: string }): [string, { sha: string; mode: string }] => [
            entry.path,
            { sha: entry.sha, mode: entry.mode },
          ]),
      );
      if (ref.sha !== request.expectedHead) {
        const replayCommit = await capability.readCommit(ref.sha);
        const replayTree = await capability.readTree(replayCommit.treeSha);
        const expectedHeadCommit = await capability.readCommit(request.expectedHead);
        const expectedHeadTree = await capability.readTree(expectedHeadCommit.treeSha);
        if (provesTarget(replayTree, expectedHeadTree, request)) {
          const verified = verifiedProvenance(authorized, capability, request);
          return verified === undefined
            ? fail(request, "verification", "Verified provenance is unavailable.", "recovery-required")
            : result(request, "idempotent", undefined, ref.sha, verified);
        }
        return fail(request, "stale-head", "Expected head is stale; no overwrite was attempted.", "stale");
      }
      const operations = request.changes.map((change, index) => {
        if (change.operation === "delete") {
          if (!before.has(change.path)) return undefined;
          return { change, operation: "DELETE" as const, admitted: authorizationResult.authorization!.paths[index] };
        }
        return {
          change,
          operation: before.has(change.path) ? ("WRITE" as const) : ("CREATE" as const),
          admitted: authorizationResult.authorization!.paths[index],
        };
      });
      if (operations.some((operation) => operation === undefined))
        return fail(request, "branch-state", "Cannot delete a missing path.");
      for (const entry of operations) {
        if (entry !== undefined && !entry.admitted?.operations.includes(entry.operation)) {
          return fail(
            request,
            "authorization",
            "The proposed tree delta is outside the admitted Implementation scope.",
          );
        }
      }
      const writes = [];
      for (const entry of operations) {
        if (entry === undefined) continue;
        const change = entry.change;
        if (change.operation === "delete") {
          writes.push({
            path: change.path,
            sha: null,
            mode: before.get(change.path)!.mode === "100755" ? ("100755" as const) : ("100644" as const),
            type: "blob" as const,
          });
        } else {
          const blob = await capability.createBlob({ content: change.content });
          if (blob.sha !== blobSha(change.content))
            return fail(request, "verification", "Created blob identity could not be verified.");
          writes.push({ path: change.path, sha: blob.sha, mode: change.mode, type: "blob" as const });
        }
      }
      const newTree = await capability.createTree({ baseTreeSha: commit.treeSha, entries: writes });
      const newCommit = await capability.createCommit({
        message: request.commit.message,
        treeSha: newTree.sha,
        parents: [request.expectedHead],
        ...(request.commit.author === undefined ? {} : { author: request.commit.author }),
      });

      const resolveUncertainUpdate = async (providerThrew: boolean): Promise<BranchAdvanceSemanticResult> => {
        let reread: Awaited<ReturnType<GitHubBranchAdvanceCapability["readRef"]>>;
        try {
          reread = await capability.readRef(request.branch);
        } catch {
          return fail(request, "recovery-required", "Authoritative provider reread failed.", "recovery-required");
        }
        if (reread?.sha === newCommit.sha) {
          const verified = verifiedProvenance(authorized, capability, request);
          if (verified === undefined)
            return fail(request, "verification", "Verified provenance is unavailable.", "recovery-required");
          return result(request, "idempotent", undefined, reread.sha, verified);
        }
        if (reread?.sha === request.expectedHead) {
          return providerThrew
            ? fail(request, "provider", "Provider mutation was not proven.")
            : fail(request, "stale-head", "Concurrent branch update rejected the compare-and-swap.", "stale");
        }
        return fail(request, "recovery-required", "Provider ambiguity requires recovery.", "recovery-required");
      };

      let update: Awaited<ReturnType<GitHubBranchAdvanceCapability["compareAndAdvanceRef"]>>;
      try {
        update = await capability.compareAndAdvanceRef({
          branch: request.branch,
          beforeOid: request.expectedHead,
          afterOid: newCommit.sha,
          force: false,
        });
      } catch {
        return resolveUncertainUpdate(true);
      }
      if (update.status !== "updated") return resolveUncertainUpdate(false);
      let reread: Awaited<ReturnType<GitHubBranchAdvanceCapability["readRef"]>>;
      try {
        reread = await capability.readRef(request.branch);
      } catch {
        return fail(request, "recovery-required", "Authoritative provider reread failed.", "recovery-required");
      }
      if (!reread || reread.sha !== newCommit.sha)
        return fail(request, "verification", "Authoritative postcondition verification failed.", "recovery-required");
      const verified = verifiedProvenance(authorized, capability, request);
      if (verified === undefined) return fail(request, "verification", "Verified provenance is unavailable.");
      return result(request, "advanced", undefined, reread.sha, verified);
    });
  } catch (error) {
    if (error instanceof GitDataCapabilityError)
      return fail(request, "provider", "Git provider operation failed.", "recovery-required");
    return fail(request, "provider", "Branch advancement failed closed.");
  }
}

/** Compatibility composition: authorize first, then share the same provider-effect primitive. */
export async function executeBranchAdvance(options: ExecuteBranchAdvanceOptions): Promise<BranchAdvanceSemanticResult> {
  const prepared = authorizeBranchAdvance(options);
  if (!prepared.valid) return prepared.failure;
  const context = options.context;
  let provenance: CapabilityExecutionProvenance;
  try {
    provenance = createCapabilityExecutionProvenance({
      version: 1,
      stage: "authorized",
      repository: context.repository,
      runtimeAuthority: context.runtimeAuthority,
      session: context.session,
      authority: context.authority,
      request: context.request,
      subject: options.admission.subject,
      capability: options.admission.capability,
    });
  } catch {
    return fail(prepared.request, "authorization", "Authorized branch provenance could not be established.");
  }
  return executeBranchAdvanceEffects({
    repository: context.repository,
    provenance,
    request: prepared.request,
    authorization: prepared.authorization,
    broker: options.broker,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
