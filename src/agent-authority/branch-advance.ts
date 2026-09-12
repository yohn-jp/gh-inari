/** The bounded, credentialless branch-advance execution authority (#466). */
import { createHash } from "node:crypto";
import { validateBranchName } from "../../branch-naming-authority.mjs";
import { MAX_SESSION_REQUEST_BYTES, canonicalizeSemanticRequest } from "./session-request.js";
import { classifyDelegatedTreeDelta } from "./protected-paths.js";
import { MAX_ISSUE_NUMBER, type BranchAdvanceCapabilityClaim } from "./capability.js";
import { createCapabilityExecutionProvenance, type CapabilityExecutionProvenance } from "./capability-provenance.js";
import type { AuthenticatedSessionContext } from "./session-authentication.js";
import type { SessionAgentMetadata } from "./session-bundle.js";
import {
  GitDataCapabilityError,
  type GitDataTree,
  type GitDataRefUpdateInput,
  type GitHubBranchAdvanceCapability,
} from "../github/git-data-capability.js";
import type { AdmittedSessionCapability } from "./capability-admission.js";
import type { IssuerRepositoryIdentity } from "../github/issuer-authority.js";

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
    request: { readonly target: IssuerRepositoryIdentity },
    operation: (capability: GitHubBranchAdvanceCapability) => Promise<T>,
  ) => Promise<T>;
}
export interface ExecuteBranchAdvanceOptions {
  readonly context: AuthenticatedSessionContext;
  readonly broker: BranchAdvanceCapabilityBroker;
  readonly admission: AdmittedSessionCapability;
  readonly request?: unknown;
  readonly now?: Date | number | (() => Date | number);
}

const KEYS = new Set(["version", "issue", "branch", "expectedHead", "changes", "commit", "agent"]);
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

function provesTarget(tree: GitDataTree, request: BranchAdvanceSemanticRequest): boolean {
  const entries = new Map(tree.entries.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  return (request.changes ?? []).every((change) => {
    if (change.operation === "delete") return !entries.has(change.path);
    const entry = entries.get(change.path);
    return entry !== undefined && entry.sha === blobSha(change.content) && entry.mode === change.mode;
  });
}
function provenance(
  context: AuthenticatedSessionContext,
  capability: GitHubBranchAdvanceCapability,
  request: BranchAdvanceSemanticRequest,
  c: BranchAdvanceCapabilityClaim,
): CapabilityExecutionProvenance | undefined {
  if (!context.task || context.task.kind !== "issue") return undefined;
  try {
    return createCapabilityExecutionProvenance({
      version: 1,
      stage: "verified",
      repository: context.repository,
      runtimeAuthority: context.runtimeAuthority,
      session: context.session,
      authority: context.authority,
      request: context.request,
      subject: { kind: "branch", issue: context.task.number, branch: request.branch },
      capability: c,
      app: { ...capability.scope.app, installationId: capability.scope.installation.installationId },
      ...(request.commit.author === undefined ? {} : { commitAuthor: request.commit.author }),
      ...(request.agent === undefined ? {} : { agent: request.agent }),
    });
  } catch {
    return undefined;
  }
}

export async function executeBranchAdvance(options: ExecuteBranchAdvanceOptions): Promise<BranchAdvanceSemanticResult> {
  const signed = options?.context?.verifiedRequest?.envelope?.request;
  const candidate = options?.request ?? signed;
  const v = validateBranchAdvanceSemanticRequest(candidate);
  if (!v.valid || !v.value) return fail(undefined, "request", v.diagnostics[0]?.message ?? "Request is invalid.");
  const r = v.value;
  const context = options.context;
  if (options.request !== undefined) {
    try {
      if (canonicalizeSemanticRequest(options.request) !== canonicalizeSemanticRequest(signed))
        return fail(r, "authorization", "Request is not the signed Session request.");
    } catch {
      return fail(r, "authorization", "Request is not the signed Session request.");
    }
  }
  if (
    context.repository.repositoryId === "" ||
    context.request.operation !== BRANCH_ADVANCE_OPERATION ||
    context.task?.kind !== "issue" ||
    context.task.number !== r.issue
  )
    return fail(r, "authorization", "The request is not admitted for this Issue.");
  if (r.branch === context.authority.ref || r.branch === "main")
    return fail(r, "branch-state", "Default-branch writes are forbidden.");
  const c = options.admission.capability;
  if (c.kind !== "branch.advance" || c.branch !== r.branch)
    return fail(r, "authorization", "No exact branch.advance capability was admitted.");
  const projected = { changes: r.changes.map((x) => ({ operation: "modify" as const, path: x.path })) };
  const classification = classifyDelegatedTreeDelta(projected);
  if (classification.kind !== "allowed") return fail(r, "protected-path", classification.message);
  if (c.pathPolicy !== undefined) return fail(r, "authorization", "Named path policy could not be resolved.");
  const target = {
    repositoryHost: context.repository.repositoryHost,
    repositoryId: context.repository.repositoryId,
    nameWithOwner: context.repository.nameWithOwner,
  };
  try {
    return await options.broker.withBranchAdvanceCapability({ target }, async (capability) => {
      if (capability.scope.repository.repositoryId !== target.repositoryId)
        return fail(r, "authorization", "Capability repository does not match.");
      const ref = await capability.readRef(r.branch);
      if (!ref) return fail(r, "branch-state", "Branch does not exist.");
      const commit = await capability.readCommit(ref.sha);
      const tree = await capability.readTree(commit.treeSha);
      const before: Map<string, { sha: string; mode: string }> = new Map(
        tree.entries
          .filter((e: { type: string }) => e.type === "blob")
          .map((e: { path: string; sha: string; mode: string }): [string, { sha: string; mode: string }] => [
            e.path,
            { sha: e.sha, mode: e.mode },
          ]),
      );
      if (ref.sha !== r.expectedHead) {
        const replayCommit = await capability.readCommit(ref.sha);
        const replayTree = await capability.readTree(replayCommit.treeSha);
        if (provesTarget(replayTree, r))
          return result(r, "idempotent", undefined, ref.sha, provenance(context, capability, r, c));
        return fail(r, "stale-head", "Expected head is stale; no overwrite was attempted.", "stale");
      }
      const writes = [];
      for (const ch of r.changes) {
        if (ch.operation === "delete") {
          if (!before.has(ch.path)) return fail(r, "branch-state", "Cannot delete a missing path.");
          writes.push({
            path: ch.path,
            sha: null,
            mode: before.get(ch.path)!.mode === "100755" ? ("100755" as const) : ("100644" as const),
            type: "blob" as const,
          });
        } else {
          const blob = await capability.createBlob({ content: ch.content });
          if (blob.sha !== blobSha(ch.content))
            return fail(r, "verification", "Created blob identity could not be verified.");
          writes.push({ path: ch.path, sha: blob.sha, mode: ch.mode, type: "blob" as const });
        }
      }
      const newTree = await capability.createTree({ baseTreeSha: commit.treeSha, entries: writes });
      const newCommit = await capability.createCommit({
        message: r.commit.message,
        treeSha: newTree.sha,
        parents: [r.expectedHead],
        ...(r.commit.author === undefined ? {} : { author: r.commit.author }),
      });

      const resolveUncertainUpdate = async (providerThrew: boolean): Promise<BranchAdvanceSemanticResult> => {
        let reread: Awaited<ReturnType<GitHubBranchAdvanceCapability["readRef"]>>;
        try {
          reread = await capability.readRef(r.branch);
        } catch {
          return fail(r, "recovery-required", "Authoritative provider reread failed.", "recovery-required");
        }
        if (reread?.sha === newCommit.sha) {
          const p = provenance(context, capability, r, c);
          if (!p) return fail(r, "verification", "Verified provenance is unavailable.", "recovery-required");
          return result(r, "idempotent", undefined, reread.sha, p);
        }
        if (reread?.sha === r.expectedHead) {
          return providerThrew
            ? fail(r, "provider", "Provider mutation was not proven.")
            : fail(r, "stale-head", "Concurrent branch update rejected the compare-and-swap.", "stale");
        }
        return fail(r, "recovery-required", "Provider ambiguity requires recovery.", "recovery-required");
      };

      let update: Awaited<ReturnType<GitHubBranchAdvanceCapability["compareAndAdvanceRef"]>>;
      try {
        update = await capability.compareAndAdvanceRef({
          branch: r.branch,
          beforeOid: r.expectedHead,
          afterOid: newCommit.sha,
          force: false,
        });
      } catch {
        return resolveUncertainUpdate(true);
      }
      if (update.status !== "updated") {
        return resolveUncertainUpdate(false);
      }
      let reread: Awaited<ReturnType<GitHubBranchAdvanceCapability["readRef"]>>;
      try {
        reread = await capability.readRef(r.branch);
      } catch {
        return fail(r, "recovery-required", "Authoritative provider reread failed.", "recovery-required");
      }
      if (!reread || reread.sha !== newCommit.sha)
        return fail(r, "verification", "Authoritative postcondition verification failed.", "recovery-required");
      const p = provenance(context, capability, r, c);
      if (!p) return fail(r, "verification", "Verified provenance is unavailable.");
      return result(r, "advanced", undefined, reread.sha, p);
    });
  } catch (e) {
    if (e instanceof GitDataCapabilityError)
      return fail(r, "provider", "Git provider operation failed.", "recovery-required");
    return fail(r, "provider", "Branch advancement failed closed.");
  }
}
