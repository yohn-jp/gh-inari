/**
 * Session-authorized, bounded advancement of an already-authorized branch.
 *
 * The request is semantic and is normally carried by the #373 signed
 * Session envelope.  This module performs no local Git operation and never
 * receives a GitHub credential.  It admits one explicit `branch.advance`
 * claim, classifies the complete #370 delta, and delegates the minimum Git
 * object operations to the App-owned Git-data capability.
 */

import { createHash } from "node:crypto";
import { validateBranchName } from "../../branch-naming-authority.mjs";
import {
  MAX_SESSION_REQUEST_BYTES,
  canonicalizeSemanticRequest,
  type SemanticSessionRequest,
} from "./session-request.js";
import {
  classifyDelegatedTreeDelta,
  admitDelegatedWrite,
  type DelegatedTreeDelta,
  type DelegatedTreeDeltaClassification,
  type DelegatedTreePathChange,
  type DelegatedTreeSnapshotEntry,
} from "./protected-paths.js";
import { validateCapabilityClaim, type BranchAdvanceCapabilityClaim, type CapabilityClaim } from "./capability.js";
import type {
  AuthenticatedSessionAuthorityRef,
  AuthenticatedSessionContext,
  AuthenticatedSessionRepository,
} from "./session-authentication.js";
import { MAX_UNIX_TIME_SECONDS } from "./session-certificate.js";
import {
  GIT_DATA_WRITE_MODES,
  type GitDataCapability,
  type GitDataRef,
  type GitDataTree,
  type GitDataTreeWriteEntry,
} from "../github/git-data-capability.js";
import type { IssuerInstallationScope, IssuerRepositoryIdentity } from "../github/issuer-authority.js";
import { INARI_ISSUER_PRINCIPAL } from "../issuer-identity.js";

export const BRANCH_ADVANCE_CONTRACT_VERSION = 1 as const;
export type BranchAdvanceContractVersion = typeof BRANCH_ADVANCE_CONTRACT_VERSION;

export const BRANCH_ADVANCE_OPERATION = "branch.advance" as const;

export const BRANCH_ADVANCE_OUTCOMES = Object.freeze([
  "advanced",
  "idempotent",
  "stale",
  "failed",
  "recovery-required",
] as const);
export type BranchAdvanceOutcome = (typeof BRANCH_ADVANCE_OUTCOMES)[number];

export const BRANCH_ADVANCE_FAILURE_CODES = Object.freeze([
  "INVALID_REQUEST",
  "REQUEST_TOO_LARGE",
  "SESSION_BINDING_FAILED",
  "SESSION_EXPIRED",
  "REPOSITORY_MISMATCH",
  "BRANCH_MISMATCH",
  "DEFAULT_BRANCH_FORBIDDEN",
  "CAPABILITY_DENIED",
  "PROTECTED_PATH_DENIED",
  "PATH_POLICY_DENIED",
  "TREE_DELTA_INVALID",
  "TREE_STATE_MISMATCH",
  "BRANCH_NOT_FOUND",
  "STALE_EXPECTED_HEAD",
  "CAS_REJECTED",
  "PROVIDER_AMBIGUOUS",
  "PROVIDER_FAILED",
  "RECOVERY_REQUIRED",
] as const);
export type BranchAdvanceFailureCode = (typeof BRANCH_ADVANCE_FAILURE_CODES)[number];

export interface BranchAdvanceDiagnostic {
  readonly code: BranchAdvanceFailureCode;
  readonly path: string;
  readonly message: string;
}

export interface BranchAdvanceCommitAuthor {
  readonly name: string;
  readonly email: string;
}

/** A complete file-tree entry. `content` is present only for changed blobs. */
export interface BranchAdvanceTreeSnapshotEntry extends DelegatedTreeSnapshotEntry {
  readonly mode: string;
  readonly type: "blob";
  /** Base64 content used to create a changed blob. */
  readonly content?: string;
  readonly encoding?: "base64";
}

/** #370's complete before/after delta with bounded changed-file content. */
export interface BranchAdvanceTreeDelta extends Omit<DelegatedTreeDelta, "before" | "after"> {
  readonly changes: readonly DelegatedTreePathChange[];
  readonly before: readonly BranchAdvanceTreeSnapshotEntry[];
  readonly after: readonly BranchAdvanceTreeSnapshotEntry[];
}

/** The exact semantic payload signed by the Session request envelope. */
export interface BranchAdvanceSemanticRequest {
  readonly version: BranchAdvanceContractVersion;
  readonly repositoryId: string;
  /** Exact already-authorized canonical branch; never a default branch. */
  readonly branch: string;
  /** Exact current commit SHA required by the final compare-and-swap. */
  readonly expectedHead: string;
  readonly treeDelta: BranchAdvanceTreeDelta;
  readonly commit: {
    readonly message: string;
    /** Deliberately separate from the App mutation/provenance identity. */
    readonly author: BranchAdvanceCommitAuthor;
  };
}

export interface BranchAdvanceExecutionFailure {
  readonly code: BranchAdvanceFailureCode;
  readonly message: string;
}

/** Bounded #376 delegation and execution provenance. */
export interface BranchAdvanceExecutionProvenance {
  readonly version: 1;
  readonly repository: {
    readonly host: string;
    readonly repositoryId: string;
    readonly nameWithOwner: string;
  };
  readonly runtimeAuthority: {
    readonly id: string;
    readonly kid: string;
  };
  readonly session: {
    readonly id: string;
    readonly certificateJti: string;
  };
  readonly request: {
    readonly requestId: string;
    readonly operation: typeof BRANCH_ADVANCE_OPERATION;
    readonly issuedAt: number;
    readonly expiresAt: number;
  };
  readonly subject?: string;
  readonly authority: AuthenticatedSessionAuthorityRef;
  readonly policy?: {
    readonly name: string;
    readonly ref: string;
    readonly sha: string;
  };
  readonly app: {
    readonly principal: string;
    readonly appId?: string;
    readonly installationId?: string;
  };
  /** Commit author is not the App actor. */
  readonly commitAuthor: BranchAdvanceCommitAuthor;
}

export interface BranchAdvanceSemanticResult {
  readonly version: BranchAdvanceContractVersion;
  readonly operation: typeof BRANCH_ADVANCE_OPERATION;
  readonly status: "succeeded" | "failed";
  readonly outcome: BranchAdvanceOutcome;
  readonly repositoryId: string;
  readonly branch: string;
  readonly expectedHead: string;
  readonly afterHead?: string;
  readonly commitSha?: string;
  readonly treeSha?: string;
  readonly provenance?: BranchAdvanceExecutionProvenance;
  readonly failure?: BranchAdvanceExecutionFailure;
}

export interface BranchAdvanceValidationResult {
  readonly valid: boolean;
  readonly value?: BranchAdvanceSemanticRequest;
  readonly diagnostics: readonly BranchAdvanceDiagnostic[];
}

export interface BranchAdvanceResolvedPathPolicy {
  readonly name: string;
  readonly ref: string;
  readonly sha: string;
  readonly allowsPath: (path: string) => boolean;
}

/** Same narrow current-policy resolver seam used by semantic admission. */
export interface BranchAdvancePathPolicyResolver {
  resolve(
    name: string,
    input: {
      readonly repository: AuthenticatedSessionRepository;
      readonly authority: AuthenticatedSessionAuthorityRef;
    },
  ): Promise<BranchAdvanceResolvedPathPolicy | undefined>;
}

export interface BranchAdvanceCapabilityBroker {
  withGitDataCapability<T>(
    request: { readonly target: IssuerRepositoryIdentity },
    operation: (capability: GitDataCapability) => Promise<T>,
  ): Promise<T>;
}

export interface ExecuteBranchAdvanceOptions {
  /** Fresh output from #374 authentication. */
  readonly context: AuthenticatedSessionContext;
  /** #466 broker seam; it does not expose a token or provider client. */
  readonly broker: BranchAdvanceCapabilityBroker;
  /** Optional assertion; otherwise the signed semantic request is consumed. */
  readonly request?: unknown;
  readonly pathPolicyResolver?: BranchAdvancePathPolicyResolver;
  readonly now?: Date | number | (() => Date | number);
}

const REQUEST_KEYS = new Set(["version", "repositoryId", "branch", "expectedHead", "treeDelta", "commit"]);
const COMMIT_KEYS = new Set(["message", "author"]);
const AUTHOR_KEYS = new Set(["name", "email"]);
const DELTA_KEYS = new Set(["changes", "before", "after"]);
const CHANGE_KEYS = new Set(["operation", "path", "previousPath"]);
const SNAPSHOT_KEYS = new Set(["path", "sha", "mode", "type", "content", "encoding"]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_BRANCH_ADVANCE_MESSAGE_LENGTH = 4_096;
const MAX_BRANCH_ADVANCE_AUTHOR_NAME_LENGTH = 256;
const MAX_BRANCH_ADVANCE_AUTHOR_EMAIL_LENGTH = 320;
const MAX_BRANCH_ADVANCE_DELTA_ENTRIES = 4_096;
const MAX_BRANCH_ADVANCE_CONTENT_BYTES = MAX_SESSION_REQUEST_BYTES;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function diagnostic(code: BranchAdvanceFailureCode, path: string, message: string): BranchAdvanceDiagnostic {
  return { code, path, message };
}

function unknownProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: BranchAdvanceDiagnostic[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key))
      diagnostics.push(diagnostic("INVALID_REQUEST", `${path}.${key}`, "Property is not accepted."));
  }
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && SHA_PATTERN.test(value);
}

function validMode(value: unknown): value is (typeof GIT_DATA_WRITE_MODES)[number] {
  return typeof value === "string" && GIT_DATA_WRITE_MODES.includes(value as (typeof GIT_DATA_WRITE_MODES)[number]);
}

function validBase64(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_BRANCH_ADVANCE_CONTENT_BYTES * 2 && BASE64_PATTERN.test(value)
  );
}

function decodedContent(value: string): Uint8Array | undefined {
  if (!validBase64(value)) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    return bytes.byteLength <= MAX_BRANCH_ADVANCE_CONTENT_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function gitBlobSha(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, Buffer.from(content)]))
    .digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function snapshotFingerprint(entry: Pick<DelegatedTreeSnapshotEntry, "sha" | "mode" | "type">): string {
  return JSON.stringify([entry.sha, entry.mode, entry.type]);
}

interface ValidatedDelta {
  readonly delta: BranchAdvanceTreeDelta;
  readonly classification: DelegatedTreeDeltaClassification;
  readonly before: ReadonlyMap<string, BranchAdvanceTreeSnapshotEntry>;
  readonly after: ReadonlyMap<string, BranchAdvanceTreeSnapshotEntry>;
}

function validateSnapshot(
  value: unknown,
  path: string,
  diagnostics: BranchAdvanceDiagnostic[],
  allowContent: boolean,
): readonly BranchAdvanceTreeSnapshotEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_BRANCH_ADVANCE_DELTA_ENTRIES) {
    diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "Tree snapshots must be bounded arrays."));
    return undefined;
  }
  const entries: BranchAdvanceTreeSnapshotEntry[] = [];
  const paths = new Set<string>();
  value.forEach((raw, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", entryPath, "Tree entry must be an object."));
      return;
    }
    unknownProperties(raw, SNAPSHOT_KEYS, entryPath, diagnostics);
    if (
      typeof raw.path !== "string" ||
      raw.path.length === 0 ||
      typeof raw.sha !== "string" ||
      !validSha(raw.sha) ||
      typeof raw.mode !== "string" ||
      !validMode(raw.mode) ||
      raw.type !== "blob"
    ) {
      diagnostics.push(
        diagnostic(
          validMode(raw.mode) ? "TREE_DELTA_INVALID" : "INVALID_REQUEST",
          entryPath,
          "Tree entries must be canonical blob identities with a supported Git object mode.",
        ),
      );
      return;
    }
    if (paths.has(raw.path)) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", `${entryPath}.path`, "Tree snapshot paths must be unique."));
      return;
    }
    paths.add(raw.path);
    const hasContent = hasOwn(raw, "content");
    if (!allowContent && (hasContent || hasOwn(raw, "encoding"))) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", entryPath, "Before snapshots cannot contain blob content."));
      return;
    }
    let content: string | undefined;
    if (hasContent) {
      if (!validBase64(raw.content) || decodedContent(raw.content) === undefined) {
        diagnostics.push(
          diagnostic("TREE_DELTA_INVALID", `${entryPath}.content`, "Blob content is invalid or too large."),
        );
      } else {
        content = raw.content;
        if (raw.encoding !== undefined && raw.encoding !== "base64") {
          diagnostics.push(
            diagnostic("TREE_DELTA_INVALID", `${entryPath}.encoding`, "Only base64 content is supported."),
          );
        }
        const bytes = decodedContent(raw.content);
        if (bytes !== undefined && gitBlobSha(bytes) !== raw.sha) {
          diagnostics.push(diagnostic("TREE_DELTA_INVALID", `${entryPath}.sha`, "Blob SHA does not match content."));
        }
      }
    } else if (hasOwn(raw, "encoding")) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", `${entryPath}.encoding`, "Encoding requires content."));
    }
    entries.push({
      path: raw.path,
      sha: raw.sha,
      mode: raw.mode,
      type: "blob",
      ...(content === undefined ? {} : { content }),
      ...(content === undefined || raw.encoding === undefined ? {} : { encoding: "base64" as const }),
    });
  });
  return entries;
}

function validateChanges(
  value: unknown,
  path: string,
  diagnostics: BranchAdvanceDiagnostic[],
): readonly DelegatedTreePathChange[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BRANCH_ADVANCE_DELTA_ENTRIES) {
    diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "Tree changes must contain a bounded non-empty array."));
    return undefined;
  }
  const changes: DelegatedTreePathChange[] = [];
  value.forEach((raw, index) => {
    const changePath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", changePath, "Tree change must be an object."));
      return;
    }
    unknownProperties(raw, CHANGE_KEYS, changePath, diagnostics);
    if (
      (raw.operation !== "create" &&
        raw.operation !== "modify" &&
        raw.operation !== "delete" &&
        raw.operation !== "rename" &&
        raw.operation !== "delete-add" &&
        raw.operation !== "replace") ||
      typeof raw.path !== "string" ||
      raw.path.length === 0
    ) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", changePath, "Tree change operation or path is invalid."));
      return;
    }
    const needsPrevious = raw.operation === "rename" || raw.operation === "delete-add";
    if (needsPrevious && (typeof raw.previousPath !== "string" || raw.previousPath.length === 0)) {
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", `${changePath}.previousPath`, "A source path is required."));
      return;
    }
    if (!needsPrevious && hasOwn(raw, "previousPath")) {
      diagnostics.push(
        diagnostic("TREE_DELTA_INVALID", `${changePath}.previousPath`, "A source path is not accepted."),
      );
      return;
    }
    const previousPath = typeof raw.previousPath === "string" ? raw.previousPath : undefined;
    changes.push({
      operation: raw.operation as DelegatedTreePathChange["operation"],
      path: raw.path,
      ...(previousPath === undefined ? {} : { previousPath }),
    });
  });
  return changes;
}

function validateDelta(
  value: unknown,
  path: string,
  diagnostics: BranchAdvanceDiagnostic[],
): ValidatedDelta | undefined {
  const classification = classifyDelegatedTreeDelta(value);
  if (classification.kind === "protected") {
    diagnostics.push(diagnostic("PROTECTED_PATH_DENIED", path, classification.message));
  } else if (classification.kind === "invalid") {
    diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, classification.message));
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "Tree delta must be an object."));
    return undefined;
  }
  unknownProperties(value, DELTA_KEYS, path, diagnostics);
  const changes = validateChanges(value.changes, `${path}.changes`, diagnostics);
  const before = validateSnapshot(value.before, `${path}.before`, diagnostics, false);
  const after = validateSnapshot(value.after, `${path}.after`, diagnostics, true);
  if (changes === undefined || before === undefined || after === undefined) return undefined;

  const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.map((entry) => [entry.path, entry]));
  const touched = new Set<string>();
  const changePaths = new Set<string>();
  for (const change of changes) {
    if (changePaths.has(change.path))
      diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "A path may be changed once."));
    changePaths.add(change.path);
    touched.add(change.path);
    if (change.previousPath !== undefined) {
      if (changePaths.has(change.previousPath))
        diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "A path may be changed once."));
      changePaths.add(change.previousPath);
      touched.add(change.previousPath);
    }
    const beforeEntry = beforeMap.get(change.path);
    const afterEntry = afterMap.get(change.path);
    const previousBefore = change.previousPath === undefined ? undefined : beforeMap.get(change.previousPath);
    const previousAfter = change.previousPath === undefined ? undefined : afterMap.get(change.previousPath);
    if (change.operation === "create") {
      if (beforeEntry !== undefined || afterEntry === undefined)
        diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "Create must add a new path."));
    } else if (change.operation === "delete") {
      if (beforeEntry === undefined || afterEntry !== undefined)
        diagnostics.push(diagnostic("TREE_DELTA_INVALID", path, "Delete must remove an existing path."));
    } else if (change.operation === "rename" || change.operation === "delete-add") {
      if (
        change.previousPath === undefined ||
        previousBefore === undefined ||
        previousAfter !== undefined ||
        beforeEntry !== undefined ||
        afterEntry === undefined ||
        change.path === change.previousPath
      ) {
        diagnostics.push(
          diagnostic("TREE_DELTA_INVALID", path, "Rename/delete-add must contain a complete source and target."),
        );
      }
    } else if (
      beforeEntry === undefined ||
      afterEntry === undefined ||
      snapshotFingerprint(beforeEntry) === snapshotFingerprint(afterEntry)
    ) {
      diagnostics.push(
        diagnostic("TREE_DELTA_INVALID", path, "Modify/replace must change the target identity or mode."),
      );
    }
  }
  const allPaths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const changedPath of allPaths) {
    if (
      snapshotFingerprint(beforeMap.get(changedPath) ?? { sha: "", mode: "", type: "blob" }) !==
      snapshotFingerprint(afterMap.get(changedPath) ?? { sha: "", mode: "", type: "blob" })
    ) {
      if (!touched.has(changedPath))
        diagnostics.push(
          diagnostic("TREE_DELTA_INVALID", path, "Complete tree changes must represent every before/after difference."),
        );
    }
  }
  for (const entry of after) {
    const beforeEntry = beforeMap.get(entry.path);
    const changed = beforeEntry === undefined || snapshotFingerprint(beforeEntry) !== snapshotFingerprint(entry);
    if (changed && entry.content === undefined) {
      diagnostics.push(
        diagnostic("TREE_DELTA_INVALID", `${path}.after.${entry.path}`, "Changed blobs require content."),
      );
    }
  }
  if (diagnostics.length > 0) return undefined;
  const delta: BranchAdvanceTreeDelta = Object.freeze({
    changes: Object.freeze([...changes]),
    before: Object.freeze([...before]),
    after: Object.freeze([...after]),
  });
  return { delta, classification, before: beforeMap, after: afterMap };
}

/** Validate without authenticating or invoking a provider. */
export function validateBranchAdvanceSemanticRequest(input: unknown): BranchAdvanceValidationResult {
  const diagnostics: BranchAdvanceDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [diagnostic("INVALID_REQUEST", "$", "Branch advance request must be an object.")],
    };
  }
  try {
    const canonical = canonicalizeSemanticRequest(input);
    if (Buffer.byteLength(canonical, "utf8") > MAX_SESSION_REQUEST_BYTES) {
      diagnostics.push(diagnostic("REQUEST_TOO_LARGE", "$", "The semantic request exceeds the Session request bound."));
    }
  } catch {
    diagnostics.push(diagnostic("REQUEST_TOO_LARGE", "$", "The semantic request is not valid bounded JSON."));
  }
  unknownProperties(input, REQUEST_KEYS, "$", diagnostics);
  if (input.version !== BRANCH_ADVANCE_CONTRACT_VERSION)
    diagnostics.push(diagnostic("INVALID_REQUEST", "$.version", "Unsupported branch advance contract version."));
  if (typeof input.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(input.repositoryId))
    diagnostics.push(
      diagnostic("REPOSITORY_MISMATCH", "$.repositoryId", "Repository ID must be an immutable decimal ID."),
    );
  if (
    typeof input.branch !== "string" ||
    input.branch === "main" ||
    !validText(input.branch, 255) ||
    validateBranchName(input.branch).length !== 0
  ) {
    diagnostics.push(diagnostic("BRANCH_MISMATCH", "$.branch", "Branch must be a canonical non-default branch name."));
  }
  if (!validSha(input.expectedHead))
    diagnostics.push(diagnostic("INVALID_REQUEST", "$.expectedHead", "Expected head must be a lowercase commit SHA."));
  if (!isRecord(input.commit)) {
    diagnostics.push(diagnostic("INVALID_REQUEST", "$.commit", "Commit metadata is required."));
  } else {
    const commit = input.commit;
    unknownProperties(commit, COMMIT_KEYS, "$.commit", diagnostics);
    if (!validText(commit.message, MAX_BRANCH_ADVANCE_MESSAGE_LENGTH))
      diagnostics.push(diagnostic("INVALID_REQUEST", "$.commit.message", "Commit message is invalid or too long."));
    if (!isRecord(commit.author)) {
      diagnostics.push(diagnostic("INVALID_REQUEST", "$.commit.author", "Commit author is required."));
    } else {
      const author = commit.author;
      unknownProperties(author, AUTHOR_KEYS, "$.commit.author", diagnostics);
      if (!validText(author.name, MAX_BRANCH_ADVANCE_AUTHOR_NAME_LENGTH))
        diagnostics.push(diagnostic("INVALID_REQUEST", "$.commit.author.name", "Commit author name is invalid."));
      if (!validText(author.email, MAX_BRANCH_ADVANCE_AUTHOR_EMAIL_LENGTH) || !author.email.includes("@"))
        diagnostics.push(diagnostic("INVALID_REQUEST", "$.commit.author.email", "Commit author email is invalid."));
    }
  }
  const delta = validateDelta(input.treeDelta, "$.treeDelta", diagnostics);
  if (diagnostics.length > 0 || delta === undefined)
    return { valid: false, diagnostics: Object.freeze(diagnostics.slice(0, 32)) };
  const request: BranchAdvanceSemanticRequest = Object.freeze({
    version: BRANCH_ADVANCE_CONTRACT_VERSION,
    repositoryId: input.repositoryId as string,
    branch: input.branch as string,
    expectedHead: input.expectedHead as string,
    treeDelta: delta.delta,
    commit: Object.freeze({
      message: (input.commit as Record<string, unknown>).message as string,
      author: Object.freeze({
        name: ((input.commit as Record<string, unknown>).author as Record<string, unknown>).name as string,
        email: ((input.commit as Record<string, unknown>).author as Record<string, unknown>).email as string,
      }),
    }),
  });
  return { valid: true, value: request, diagnostics: [] };
}

function normalizeNow(input: Date | number | (() => Date | number) | undefined): Date | undefined {
  try {
    const value = typeof input === "function" ? input() : input;
    if (value === undefined) return new Date();
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined;
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UNIX_TIME_SECONDS) return undefined;
    return new Date(value * 1000);
  } catch {
    return undefined;
  }
}

function failed(
  request: BranchAdvanceSemanticRequest | undefined,
  code: BranchAdvanceFailureCode,
  message: string,
  outcome: BranchAdvanceOutcome = "failed",
  extra: Partial<BranchAdvanceSemanticResult> = {},
): BranchAdvanceSemanticResult {
  return freezeDeep({
    version: BRANCH_ADVANCE_CONTRACT_VERSION,
    operation: BRANCH_ADVANCE_OPERATION,
    status: "failed" as const,
    outcome,
    repositoryId: request?.repositoryId ?? "",
    branch: request?.branch ?? "",
    expectedHead: request?.expectedHead ?? "",
    ...extra,
    failure: { code, message },
  });
}

function successful(
  request: BranchAdvanceSemanticRequest,
  outcome: "advanced" | "idempotent",
  afterHead: string,
  provenance: BranchAdvanceExecutionProvenance,
  extra: Partial<BranchAdvanceSemanticResult> = {},
): BranchAdvanceSemanticResult {
  return freezeDeep({
    version: BRANCH_ADVANCE_CONTRACT_VERSION,
    operation: BRANCH_ADVANCE_OPERATION,
    status: "succeeded" as const,
    outcome,
    repositoryId: request.repositoryId,
    branch: request.branch,
    expectedHead: request.expectedHead,
    afterHead,
    provenance,
    ...extra,
  });
}

function sameRepository(left: AuthenticatedSessionRepository, right: BranchAdvanceSemanticRequest): boolean {
  return left.repositoryId === right.repositoryId;
}

function sameSnapshot(tree: GitDataTree, expected: ReadonlyMap<string, BranchAdvanceTreeSnapshotEntry>): boolean {
  const actual = new Map<string, string>();
  for (const entry of tree.entries) {
    if (entry.type !== "blob") {
      if (entry.type === "commit") return false;
      continue;
    }
    actual.set(entry.path, snapshotFingerprint({ sha: entry.sha, mode: entry.mode, type: entry.type }));
  }
  if (actual.size !== expected.size) return false;
  for (const [path, entry] of expected) {
    if (actual.get(path) !== snapshotFingerprint(entry)) return false;
  }
  return true;
}

function writeEntries(
  request: BranchAdvanceSemanticRequest,
  contentShas: ReadonlyMap<string, string>,
): readonly GitDataTreeWriteEntry[] {
  const before = new Map(request.treeDelta.before.map((entry) => [entry.path, entry]));
  const after = new Map(request.treeDelta.after.map((entry) => [entry.path, entry]));
  const result: GitDataTreeWriteEntry[] = [];
  const added = new Set<string>();
  const add = (path: string, sha: string | null, mode: (typeof GIT_DATA_WRITE_MODES)[number]): void => {
    if (added.has(path)) throw new Error("duplicate tree write path");
    added.add(path);
    result.push({ path, sha, mode, type: "blob" });
  };
  for (const change of request.treeDelta.changes) {
    if (change.operation === "delete" || change.operation === "rename" || change.operation === "delete-add") {
      const source = change.previousPath ?? change.path;
      const sourceEntry = before.get(source);
      if (sourceEntry === undefined) throw new Error("missing source tree entry");
      add(source, null, sourceEntry.mode as (typeof GIT_DATA_WRITE_MODES)[number]);
    }
    if (change.operation !== "delete") {
      const target = after.get(change.path);
      if (target === undefined) throw new Error("missing target tree entry");
      add(
        change.path,
        contentShas.get(change.path) ?? target.sha,
        target.mode as (typeof GIT_DATA_WRITE_MODES)[number],
      );
    }
  }
  return Object.freeze(result);
}

function claimFor(context: AuthenticatedSessionContext, branch: string): BranchAdvanceCapabilityClaim | undefined {
  if (context.request.operation !== BRANCH_ADVANCE_OPERATION || !Array.isArray(context.capabilities)) return undefined;
  for (const rawClaim of context.capabilities) {
    const result = validateCapabilityClaim(rawClaim);
    if (result.valid && result.value?.kind === "branch.advance" && result.value.branch === branch) {
      return result.value;
    }
  }
  return undefined;
}

function contextFresh(context: AuthenticatedSessionContext, now: Date): BranchAdvanceFailureCode | undefined {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const payload = context.verifiedRequest?.certificate?.payload;
  const envelope = context.verifiedRequest?.envelope;
  if (
    envelope === undefined ||
    payload === undefined ||
    envelope.operation !== BRANCH_ADVANCE_OPERATION ||
    context.request.operation !== envelope.operation ||
    context.request.requestId !== envelope.requestId ||
    context.request.issuedAt !== envelope.issuedAt ||
    context.request.expiresAt !== envelope.expiresAt ||
    context.session.certificateJti !== envelope.certificateJti ||
    nowSeconds < envelope.issuedAt ||
    nowSeconds >= envelope.expiresAt ||
    nowSeconds < payload.nbf ||
    nowSeconds >= payload.exp
  ) {
    return nowSeconds >= context.request.expiresAt ? "SESSION_EXPIRED" : "SESSION_BINDING_FAILED";
  }
  return undefined;
}

function provenance(
  context: AuthenticatedSessionContext,
  author: BranchAdvanceCommitAuthor,
  scope: IssuerInstallationScope | undefined,
  policy: { readonly name: string; readonly ref: string; readonly sha: string } | undefined,
): BranchAdvanceExecutionProvenance {
  const app = scope?.app;
  const installation = scope?.installation;
  return {
    version: 1,
    repository: {
      host: context.repository.repositoryHost,
      repositoryId: context.repository.repositoryId,
      nameWithOwner: context.repository.nameWithOwner,
    },
    runtimeAuthority: { id: context.runtimeAuthority.id, kid: context.runtimeAuthority.kid },
    session: { id: context.session.id, certificateJti: context.session.certificateJti },
    request: {
      requestId: context.request.requestId,
      operation: BRANCH_ADVANCE_OPERATION,
      issuedAt: context.request.issuedAt,
      expiresAt: context.request.expiresAt,
    },
    ...(context.task === undefined ? {} : { subject: `issue:${context.task.number}` }),
    authority: { ref: context.authority.ref, sha: context.authority.sha },
    ...(policy === undefined ? {} : { policy }),
    app: {
      principal: app?.principal ?? INARI_ISSUER_PRINCIPAL,
      ...(app?.appId === undefined ? {} : { appId: app.appId }),
      ...(installation?.installationId === undefined ? {} : { installationId: installation.installationId }),
    },
    commitAuthor: { name: author.name, email: author.email },
  };
}

async function authoritativeState(
  capability: GitDataCapability,
  branch: string,
): Promise<{ readonly ref: GitDataRef; readonly tree: GitDataTree } | undefined> {
  const ref = await capability.readRef(branch);
  if (ref === undefined) return undefined;
  const tree = await capability.readTree(ref.sha);
  return { ref, tree };
}

async function resolveAfterProviderFailure(
  capability: GitDataCapability,
  request: BranchAdvanceSemanticRequest,
  validated: ValidatedDelta,
  context: AuthenticatedSessionContext,
  author: BranchAdvanceCommitAuthor,
  scope: IssuerInstallationScope,
  policy: { readonly name: string; readonly ref: string; readonly sha: string } | undefined,
  knownCommitSha?: string,
): Promise<BranchAdvanceSemanticResult> {
  try {
    const state = await authoritativeState(capability, request.branch);
    if (state !== undefined && sameSnapshot(state.tree, validated.after)) {
      return successful(
        request,
        knownCommitSha !== undefined && state.ref.sha === knownCommitSha ? "advanced" : "idempotent",
        state.ref.sha,
        provenance(context, author, scope, policy),
        knownCommitSha === undefined ? {} : { commitSha: knownCommitSha },
      );
    }
    if (state !== undefined && state.ref.sha === request.expectedHead && sameSnapshot(state.tree, validated.before)) {
      return failed(request, "PROVIDER_AMBIGUOUS", "The provider result was ambiguous; no branch advance was proven.");
    }
  } catch {
    return failed(
      request,
      "RECOVERY_REQUIRED",
      "Authoritative reread was unavailable after a provider ambiguity.",
      "recovery-required",
    );
  }
  return failed(
    request,
    "RECOVERY_REQUIRED",
    "The branch changed to an unverified state; recovery is required.",
    "recovery-required",
  );
}

async function executeWithCapability(
  capability: GitDataCapability,
  request: BranchAdvanceSemanticRequest,
  validated: ValidatedDelta,
  context: AuthenticatedSessionContext,
  author: BranchAdvanceCommitAuthor,
  scope: IssuerInstallationScope,
  policy: { readonly name: string; readonly ref: string; readonly sha: string } | undefined,
): Promise<BranchAdvanceSemanticResult> {
  let initial: { readonly ref: GitDataRef; readonly tree: GitDataTree } | undefined;
  try {
    initial = await authoritativeState(capability, request.branch);
  } catch {
    return failed(request, "PROVIDER_FAILED", "The authorized branch could not be reread.", "recovery-required");
  }
  if (initial === undefined) return failed(request, "BRANCH_NOT_FOUND", "The authorized branch does not exist.");
  if (initial.ref.sha !== request.expectedHead) {
    if (sameSnapshot(initial.tree, validated.after)) {
      return successful(request, "idempotent", initial.ref.sha, provenance(context, author, scope, policy));
    }
    return failed(
      request,
      "STALE_EXPECTED_HEAD",
      "The expected branch head is stale; no overwrite was attempted.",
      "stale",
    );
  }
  if (!sameSnapshot(initial.tree, validated.before)) {
    return failed(
      request,
      "TREE_STATE_MISMATCH",
      "The signed before-tree does not match the authoritative branch tree.",
      "stale",
    );
  }

  const contentShas = new Map<string, string>();
  let treeSha: string | undefined;
  let commitSha: string | undefined;
  try {
    for (const entry of request.treeDelta.after) {
      const beforeEntry = validated.before.get(entry.path);
      const changed = beforeEntry === undefined || snapshotFingerprint(beforeEntry) !== snapshotFingerprint(entry);
      if (!changed || entry.content === undefined) continue;
      const created = await capability.createBlob({ content: entry.content });
      if (created.sha !== entry.sha) throw new Error("created blob identity mismatch");
      contentShas.set(entry.path, created.sha);
    }
    const tree = await capability.createTree({
      baseTreeSha: initial.tree.sha,
      entries: writeEntries(request, contentShas),
    });
    treeSha = tree.sha;
    const commit = await capability.createCommit({
      message: request.commit.message,
      treeSha,
      parents: [request.expectedHead],
      author: request.commit.author,
    });
    commitSha = commit.sha;
    const update = await capability.updateRefs({
      branch: request.branch,
      beforeOid: request.expectedHead,
      afterOid: commitSha,
      force: false,
    });
    let after: { readonly ref: GitDataRef; readonly tree: GitDataTree } | undefined;
    try {
      after = await authoritativeState(capability, request.branch);
    } catch {
      return failed(
        request,
        "RECOVERY_REQUIRED",
        "Authoritative reread was unavailable after ref advancement.",
        "recovery-required",
        {
          commitSha,
          treeSha,
        },
      );
    }
    if (after !== undefined && sameSnapshot(after.tree, validated.after)) {
      return successful(
        request,
        after.ref.sha === commitSha ? "advanced" : "idempotent",
        after.ref.sha,
        provenance(context, author, scope, policy),
        {
          commitSha,
          treeSha,
        },
      );
    }
    if (after !== undefined && after.ref.sha === request.expectedHead && sameSnapshot(after.tree, validated.before)) {
      return failed(
        request,
        update.status === "rejected" ? "CAS_REJECTED" : "PROVIDER_AMBIGUOUS",
        update.status === "rejected"
          ? "The expected branch head no longer matched; no overwrite occurred."
          : "The ref update result was ambiguous; no branch advance was proven.",
        update.status === "rejected" ? "stale" : "failed",
        {
          commitSha,
          treeSha,
        },
      );
    }
    return failed(
      request,
      "RECOVERY_REQUIRED",
      "The final branch state is not the requested target.",
      "recovery-required",
      {
        commitSha,
        treeSha,
      },
    );
  } catch {
    return resolveAfterProviderFailure(capability, request, validated, context, author, scope, policy, commitSha);
  }
}

/**
 * Execute one already-authenticated Session branch advance. All rejection and
 * provider ambiguity results are bounded; no provider payload is returned.
 */
export async function executeBranchAdvance(options: ExecuteBranchAdvanceOptions): Promise<BranchAdvanceSemanticResult> {
  const now = normalizeNow(options?.now);
  if (now === undefined || !isRecord(options) || !isRecord(options.context) || !isRecord(options.broker)) {
    return failed(undefined, "INVALID_REQUEST", "Branch advance execution options are invalid.");
  }
  const context = options.context;
  const signedRequest = context.verifiedRequest?.envelope?.request;
  const candidate = options.request === undefined ? signedRequest : options.request;
  const validation = validateBranchAdvanceSemanticRequest(candidate);
  if (!validation.valid || validation.value === undefined) {
    const first = validation.diagnostics[0];
    return failed(
      undefined,
      first?.code ?? "INVALID_REQUEST",
      first?.message ?? "Branch advance request is invalid.",
      "failed",
    );
  }
  const request = validation.value;
  if (options.request !== undefined) {
    try {
      if (canonicalizeSemanticRequest(options.request) !== canonicalizeSemanticRequest(signedRequest)) {
        return failed(request, "SESSION_BINDING_FAILED", "The supplied request is not the signed Session request.");
      }
    } catch {
      return failed(request, "SESSION_BINDING_FAILED", "The supplied request is not the signed Session request.");
    }
  }
  const freshnessFailure = contextFresh(context, now);
  if (freshnessFailure !== undefined)
    return failed(
      request,
      freshnessFailure,
      freshnessFailure === "SESSION_EXPIRED"
        ? "The Session request has expired."
        : "The Session request binding is invalid.",
    );
  if (!sameRepository(context.repository, request))
    return failed(request, "REPOSITORY_MISMATCH", "Request repository ID does not match authenticated repository.");
  if (request.branch === context.authority.ref || request.branch === "main")
    return failed(request, "DEFAULT_BRANCH_FORBIDDEN", "Default-branch writes are not delegable.");
  const claim = claimFor(context, request.branch);
  if (claim === undefined)
    return failed(request, "CAPABILITY_DENIED", "The Session has no exact branch.advance claim for this branch.");
  const delegated = admitDelegatedWrite({ capability: claim, treeDelta: request.treeDelta });
  if (!delegated.allowed || delegated.treeDelta === undefined) {
    return failed(
      request,
      delegated.code === "DELEGATED_WRITE_TRUST_ROOT_DENIED" ? "PROTECTED_PATH_DENIED" : "TREE_DELTA_INVALID",
      delegated.message,
    );
  }
  const validationDiagnostics: BranchAdvanceDiagnostic[] = [];
  const validated = validateDelta(request.treeDelta, "$.treeDelta", validationDiagnostics);
  if (validated === undefined || validationDiagnostics.length > 0) {
    const first = validationDiagnostics[0];
    return failed(request, first?.code ?? "TREE_DELTA_INVALID", first?.message ?? "Tree delta is invalid.");
  }
  let policy: { readonly name: string; readonly ref: string; readonly sha: string } | undefined;
  if (claim.pathPolicy !== undefined) {
    if (options.pathPolicyResolver === undefined)
      return failed(request, "PATH_POLICY_DENIED", "Named path policy resolution is required.");
    let resolved: BranchAdvanceResolvedPathPolicy | undefined;
    try {
      resolved = await options.pathPolicyResolver.resolve(claim.pathPolicy, {
        repository: context.repository,
        authority: context.authority,
      });
    } catch {
      return failed(request, "PATH_POLICY_DENIED", "Named path policy resolution failed closed.");
    }
    if (
      resolved === undefined ||
      resolved.name !== claim.pathPolicy ||
      resolved.ref !== context.authority.ref ||
      resolved.sha !== context.authority.sha ||
      typeof resolved.allowsPath !== "function"
    ) {
      return failed(request, "PATH_POLICY_DENIED", "Named path policy is not bound to current canonical authority.");
    }
    try {
      if (!validated.classification.touchedPaths.every((path) => resolved?.allowsPath(path))) {
        return failed(request, "PATH_POLICY_DENIED", "Tree delta exceeds the named path policy.");
      }
    } catch {
      return failed(request, "PATH_POLICY_DENIED", "Named path policy evaluation failed closed.");
    }
    policy = { name: resolved.name, ref: resolved.ref, sha: resolved.sha };
  }
  const target: IssuerRepositoryIdentity = {
    repositoryHost: context.repository.repositoryHost,
    repositoryId: context.repository.repositoryId,
    nameWithOwner: context.repository.nameWithOwner,
  };
  try {
    return await options.broker.withGitDataCapability({ target }, async (capability) => {
      if (capability.scope.repository.repositoryId !== context.repository.repositoryId) {
        return failed(request, "REPOSITORY_MISMATCH", "Git-data capability repository ID does not match the Session.");
      }
      return executeWithCapability(
        capability,
        request,
        validated,
        context,
        request.commit.author,
        capability.scope,
        policy,
      );
    });
  } catch {
    return failed(request, "PROVIDER_FAILED", "The App Git-data capability failed closed.");
  }
}

/** Semantic alias used by App handlers that call the operation `branch.advance`. */
export const advanceBranch = executeBranchAdvance;
export const executeSessionBranchAdvance = executeBranchAdvance;
