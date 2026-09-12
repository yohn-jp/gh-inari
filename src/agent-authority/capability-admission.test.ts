import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITY_ADMISSION_CONTRACT_VERSION,
  CapabilityAdmissionError,
  admitAuthenticatedSessionCapability,
  type AdmittedSessionCapability,
  type CapabilityAdmissionFailureReason,
  type CapabilityAdmissionRequest,
  type CapabilityAdmissionOperation,
  type CapabilityAdmissionSubject,
} from "./capability-admission.js";
import * as capabilityAdmissionModule from "./capability-admission.js";
import { authenticateSessionRequest, type AuthenticatedSessionContext } from "./session-authentication.js";
import type { CapabilityClaim } from "./capability.js";
import type { DelegatedTreeDelta } from "./protected-paths.js";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  renderRuntimeAuthorityArtifact,
  signSessionRequest,
  type RuntimeAuthority,
} from "./index.js";
import { assertRuntimeAuthority } from "./runtime-authority.js";
import type { GitHubAppRepositoryReadCapability } from "../github/app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "../github/change-effect-adapter.js";
import { projectChangeFromGitHubEvidence, type ChangeGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import type { SemanticSessionRequest } from "./session-request.js";
import type { IssuerRepositoryIdentity } from "../github/issuer-authority.js";
import type { SessionCertificateTask } from "./session-certificate.js";
import type { ChangeState } from "../change.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

type ExpectedCapabilityAdmissionOperation =
  | "change.issue"
  | "change.show"
  | "change.ready"
  | "change.abort"
  | "branch.create"
  | "branch.advance"
  | "pullRequest.create";
type ExpectedCapabilityAdmissionSubject =
  | { readonly kind: "change"; readonly issue: number }
  | { readonly kind: "branch"; readonly issue: number; readonly branch: string }
  | {
      readonly kind: "pullRequest";
      readonly issue: number;
      readonly head: string;
      readonly base: string;
    };
type ExpectedCapabilityAdmissionRequest = {
  readonly context: AuthenticatedSessionContext;
  readonly operation: ExpectedCapabilityAdmissionOperation;
  readonly subject: ExpectedCapabilityAdmissionSubject;
  readonly projection: ChangeProjectionResult;
  readonly treeDelta?: DelegatedTreeDelta;
};
type ExpectedAdmittedSessionCapability = {
  readonly version: 1;
  readonly operation: ExpectedCapabilityAdmissionOperation;
  readonly repository: IssuerRepositoryIdentity;
  readonly runtimeAuthority: Readonly<{ id: string; kid: string }>;
  readonly session: Readonly<{ id: string; certificateJti: string }>;
  readonly authority: Readonly<{ ref: string; sha: string }>;
  readonly request: Readonly<{
    requestId: string;
    operation: string;
    issuedAt: number;
    expiresAt: number;
  }>;
  readonly task?: SessionCertificateTask;
  readonly capability: CapabilityClaim;
  readonly subject: ExpectedCapabilityAdmissionSubject;
  readonly canonical: Readonly<{
    state?: ChangeState;
    branch?: string;
    pullRequest?: number;
  }>;
  readonly protectedPathClassifierVersion: 1;
};
type ExpectedCapabilityAdmissionFailureReason =
  | "operation"
  | "repository"
  | "task"
  | "session-capability"
  | "canonical-state"
  | "canonical-identity"
  | "protected-path"
  | "path-policy"
  | "stale-evidence";

type PublicOperationIsExact = Assert<Equal<CapabilityAdmissionOperation, ExpectedCapabilityAdmissionOperation>>;
type PublicSubjectIsExact = Assert<Equal<CapabilityAdmissionSubject, ExpectedCapabilityAdmissionSubject>>;
type PublicRequestIsExact = Assert<Equal<CapabilityAdmissionRequest, ExpectedCapabilityAdmissionRequest>>;
type PublicOutputIsExact = Assert<Equal<AdmittedSessionCapability, ExpectedAdmittedSessionCapability>>;
type PublicFailureReasonsAreExact = Assert<
  Equal<CapabilityAdmissionFailureReason, ExpectedCapabilityAdmissionFailureReason>
>;

// These are deliberate compile-time contract guards: reintroducing any of the
// obsolete public seams makes the expected diagnostics unused and fails the
// typecheck.
// @ts-expect-error Runtime trust is authenticated by #374 and is not an admission seam.
import type { RuntimeAuthoritySourceReader } from "./capability-admission.js";
// @ts-expect-error Runtime trust is authenticated by #374 and is not an admission seam.
import type { CapabilityAdmissionPathPolicyResolver } from "./capability-admission.js";
// @ts-expect-error This compatibility alias is intentionally not public.
import type { CapabilityAdmissionDeniedError } from "./capability-admission.js";
// @ts-expect-error The obsolete admission result shape is intentionally not public.
import type { AuthenticatedSessionCapabilityAdmission } from "./capability-admission.js";

const NOW = new Date("2026-09-12T00:00:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "123456789";
const AUTHORITY_ID = "runtime-capability-admission-test";
const POLICY_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const BRANCH_SHA = "d".repeat(40);
const CANONICAL_BRANCH = "feat/375-semantic-capability-admission";
const BASE_BRANCH = "main";

function runtimeAuthority(key = generateRuntimeAuthorityKeyPair()): {
  readonly authority: RuntimeAuthority;
  readonly key: ReturnType<typeof generateRuntimeAuthorityKeyPair>;
} {
  return {
    key,
    authority: assertRuntimeAuthority({
      version: 1,
      kind: "runtime-authority",
      id: AUTHORITY_ID,
      key: key.publicKeyJwk,
      status: "active",
      notBefore: "2026-01-01T00:00:00Z",
      notAfter: null,
      maxSessionTtlSeconds: 3_600,
      capabilityCeiling: [
        "change.implement",
        "change.ready",
        "change.abort",
        "branch.create",
        "branch.advance",
        "pullRequest.create",
      ],
    }),
  };
}

function signedRequest(
  authority: RuntimeAuthority,
  key: ReturnType<typeof generateRuntimeAuthorityKeyPair>,
  operation: string,
  request: Record<string, unknown>,
  capabilities: readonly CapabilityClaim[],
  taskNumber: number,
) {
  const session = createManagedSession();
  const issuanceRequest = session.createIssuanceRequest({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    task: { kind: "issue", number: taskNumber },
    capabilities,
    ttlSeconds: 600,
  });
  const issued = issueSessionCertificate({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    runtimeAuthority: authority,
    runtimeKey: key,
    request: issuanceRequest,
    now: NOW,
  });
  session.acceptCertificate(issued.compact);
  return signSessionRequest({
    session,
    request: request as unknown as SemanticSessionRequest,
    operation,
    requestId: `request-${operation.replaceAll(".", "-")}-${taskNumber}`,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
}

function appReadCapability(authority: RuntimeAuthority): GitHubAppRepositoryReadCapability {
  const content = Buffer.from(canonicalRuntimeAuthorityJson(authority), "utf8").toString("base64");
  const artifact = renderRuntimeAuthorityArtifact(authority);
  return {
    scope: {
      app: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
      installation: { appId: "1", installationId: "2", repositoryHost: "github.com" },
      repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: "acme/inari" },
      repositorySelection: "selected",
      permissions: { contents: "read", issues: "read", pull_requests: "read" },
      expiresAt: "2026-09-12T00:10:00Z",
    },
    transport: {
      async request(request) {
        if (request.path === "repos/acme/inari") {
          return {
            status: 200,
            body: { id: Number(REPOSITORY_ID), full_name: "acme/inari", fork: false, default_branch: "main" },
          };
        }
        if (request.path === "repos/acme/inari/git/ref/heads/main") {
          return {
            status: 200,
            body: { ref: "refs/heads/main", object: { type: "commit", sha: POLICY_SHA } },
          };
        }
        if (request.path.includes("/git/trees/")) {
          return {
            status: 200,
            body: { sha: TREE_SHA, truncated: false, tree: [{ path: artifact.path, type: "blob", sha: BLOB_SHA }] },
          };
        }
        if (request.path.includes("/git/blobs/")) {
          return { status: 200, body: { sha: BLOB_SHA, encoding: "base64", content } };
        }
        return { status: 404, body: {} };
      },
    },
  };
}

async function authenticatedContext(
  authority: RuntimeAuthority,
  key: ReturnType<typeof generateRuntimeAuthorityKeyPair>,
  operation: CapabilityAdmissionOperation,
  request: Record<string, unknown>,
  capabilities: readonly CapabilityClaim[],
  issue = 375,
): Promise<AuthenticatedSessionContext> {
  const envelope = signedRequest(authority, key, operation, request, capabilities, issue);
  return authenticateSessionRequest({
    broker: {
      async withRepositoryReadCapability<T>(
        _request: { readonly permissions?: unknown },
        callback: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
      ): Promise<T> {
        return callback(appReadCapability(authority));
      },
    },
    repository: REPOSITORY,
    request: envelope,
    now: NOW,
  });
}

function projection(
  issue: number,
  state: "absent" | "branch-only" | "draft" | "review" | "aborted" | "recovery" = "absent",
): ChangeProjectionResult {
  const branchEvidence: ChangeGitHubEvidence["branches"] =
    state === "absent" || state === "aborted"
      ? { status: "available", value: [] }
      : {
          status: "available",
          value: [{ name: `feat/${issue}-semantic-capability-admission`, sha: BRANCH_SHA, rootIssue: issue }],
        };
  const pullRequestEvidence: ChangeGitHubEvidence["pullRequests"] =
    state === "absent" || state === "branch-only"
      ? { status: "available", value: [] }
      : {
          status: "available",
          value: [
            {
              number: 5375,
              head: `feat/${issue}-semantic-capability-admission`,
              base: BASE_BRANCH,
              state: state === "aborted" || state === "recovery" ? "closed" : "open",
              draft: state === "draft",
              merged: false,
              ...(state === "review" ? {} : {}),
              rootIssue: issue,
            },
          ],
        };
  return projectChangeFromGitHubEvidence({
    change: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, rootIssue: issue },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "semantic-capability-admission" },
    baseBranch: BASE_BRANCH,
    evidence: {
      issue: { status: "available", value: { number: issue, state: "open" } },
      branches: branchEvidence,
      pullRequests: pullRequestEvidence,
    },
  });
}

function subject(kind: "change" | "branch" | "pullRequest", issue = 375): CapabilityAdmissionSubject {
  if (kind === "change") return { kind, issue };
  if (kind === "branch") return { kind, issue, branch: CANONICAL_BRANCH };
  return { kind, issue, head: CANONICAL_BRANCH, base: BASE_BRANCH };
}

function admission(
  context: AuthenticatedSessionContext,
  operation: CapabilityAdmissionOperation,
  requestSubject: CapabilityAdmissionSubject,
  currentProjection: ChangeProjectionResult,
  treeDelta?: CapabilityAdmissionRequest["treeDelta"],
) {
  return admitAuthenticatedSessionCapability({
    context,
    operation,
    subject: requestSubject,
    projection: currentProjection,
    ...(treeDelta === undefined ? {} : { treeDelta }),
  });
}

function assertDenied(action: () => unknown, reason: CapabilityAdmissionError["reason"]): void {
  assert.throws(action, (error: unknown) => {
    return (
      error instanceof CapabilityAdmissionError &&
      error.code === "CAPABILITY_ADMISSION_DENIED" &&
      error.reason === reason
    );
  });
}

test("admits pre-issuance change.issue from change.implement and freezes the result", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.issue",
    { version: 1, issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
  );
  const admitted = admission(context, "change.issue", subject("change"), projection(375));

  assert.equal(admitted.version, CAPABILITY_ADMISSION_CONTRACT_VERSION);
  assert.equal(admitted.canonical.state, "DEFINED");
  assert.equal(admitted.canonical.branch, CANONICAL_BRANCH);
  assert.equal(admitted.canonical.pullRequest, undefined);
  assert.deepEqual(admitted.subject, subject("change"));
  assert.equal(admitted.capability.kind, "change.implement");
  assert.deepEqual(Object.keys(admitted).sort(), [
    "authority",
    "canonical",
    "capability",
    "operation",
    "protectedPathClassifierVersion",
    "repository",
    "request",
    "runtimeAuthority",
    "session",
    "subject",
    "task",
    "version",
  ]);
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.canonical), true);
});

test("narrows an issued Change to its exact branch and pull request", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.show",
    { version: 1, issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
  );
  const admitted = admission(context, "change.show", subject("change"), projection(375, "draft"));
  assert.deepEqual(admitted.canonical, { state: "DRAFT", branch: CANONICAL_BRANCH, pullRequest: 5375 });

  assertDenied(() => admission(context, "change.show", subject("change", 376), projection(375, "draft")), "task");
  assertDenied(
    () =>
      admission(
        context,
        "change.show",
        { kind: "change", issue: 375, branch: "not-allowed" } as unknown as CapabilityAdmissionSubject,
        projection(375, "draft"),
      ),
    "canonical-identity",
  );
});

test("requires separate ready and abort claims and delegates lifecycle legality to Core/XState", async () => {
  const runtime = runtimeAuthority();
  const readyContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.ready",
    { version: 1, issue: 375 },
    [{ kind: "change.ready", issue: 375 }],
  );
  const ready = admission(readyContext, "change.ready", subject("change"), projection(375, "draft"));
  assert.equal(ready.canonical.state, "DRAFT");

  const review = admission(readyContext, "change.ready", subject("change"), projection(375, "review"));
  assert.equal(review.canonical.state, "REVIEW");

  const abortContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.abort",
    { version: 1, issue: 375 },
    [{ kind: "change.abort", issue: 375 }],
  );
  const aborted = admission(abortContext, "change.abort", subject("change"), projection(375, "aborted"));
  assert.equal(aborted.canonical.state, "ABORTED");

  const implementContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.ready",
    { version: 1, issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
  );
  assertDenied(
    () => admission(implementContext, "change.ready", subject("change"), projection(375, "draft")),
    "session-capability",
  );
});

test("admits exact lower-level create and advance claims without widening canonical identity", async () => {
  const runtime = runtimeAuthority();
  const branchContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.create",
    { version: 1, issue: 375, branch: CANONICAL_BRANCH },
    [{ kind: "branch.create", branch: CANONICAL_BRANCH, max: 1 }],
  );
  assert.equal(
    admission(branchContext, "branch.create", subject("branch"), projection(375)).capability.kind,
    "branch.create",
  );

  const pullRequestContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "pullRequest.create",
    { version: 1, issue: 375, head: CANONICAL_BRANCH, base: BASE_BRANCH },
    [{ kind: "pullRequest.create", head: CANONICAL_BRANCH, base: BASE_BRANCH, max: 1 }],
  );
  assert.equal(
    admission(pullRequestContext, "pullRequest.create", subject("pullRequest"), projection(375, "branch-only"))
      .capability.kind,
    "pullRequest.create",
  );

  const advanceContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    { version: 1, issue: 375, branch: CANONICAL_BRANCH },
    [{ kind: "branch.advance", branch: CANONICAL_BRANCH }],
  );
  const advanced = admission(advanceContext, "branch.advance", subject("branch"), projection(375, "draft"), {
    changes: [{ operation: "modify", path: "src/implementation.ts" }],
  });
  assert.equal(advanced.capability.kind, "branch.advance");

  assertDenied(
    () =>
      admission(
        advanceContext,
        "branch.advance",
        { kind: "branch", issue: 375, branch: "feat/375-other" },
        projection(375, "draft"),
        { changes: [{ operation: "modify", path: "src/implementation.ts" }] },
      ),
    "canonical-identity",
  );
});

test("supports a high-level implementation claim for lower-level effects only at Core identities", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    { version: 1, issue: 375, branch: CANONICAL_BRANCH },
    [{ kind: "change.implement", issue: 375 }],
  );
  const admitted = admission(context, "branch.advance", subject("branch"), projection(375, "draft"), {
    changes: [{ operation: "modify", path: "src/implementation.ts" }],
  });
  assert.equal(admitted.capability.kind, "change.implement");
});

test("fails closed for cross-repository, cross-task, stale, and conflicting evidence", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.show",
    { version: 1, issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
  );
  const foreign = structuredClone(projection(375, "draft")) as ChangeProjectionResult;
  assert.ok(foreign.change);
  const foreignProjection = {
    ...foreign,
    change: { ...foreign.change, identity: { ...foreign.change.identity, repositoryId: "987654321" } },
  };
  assertDenied(() => admission(context, "change.show", subject("change"), foreignProjection), "repository");
  assertDenied(() => admission(context, "change.show", subject("change"), projection(376, "draft")), "task");
  assertDenied(
    () =>
      admission(context, "change.show", subject("change"), {
        ...projection(375, "draft"),
        status: "unavailable",
        valid: false,
      }),
    "stale-evidence",
  );
  assertDenied(
    () => admission(context, "change.show", subject("change"), projection(375, "branch-only")),
    "canonical-state",
  );
});

test("applies the immutable #370 deny-set before admitting a branch write", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    { version: 1, issue: 375, branch: CANONICAL_BRANCH },
    [{ kind: "branch.advance", branch: CANONICAL_BRANCH }],
  );
  assertDenied(
    () =>
      admission(context, "branch.advance", subject("branch"), projection(375, "draft"), {
        changes: [{ operation: "modify", path: ".github/inari/authorities/runtime.json" }],
      }),
    "protected-path",
  );
  assertDenied(
    () => admission(context, "branch.advance", subject("branch"), projection(375, "draft")),
    "protected-path",
  );
});

test("fails closed for an unresolved named path policy and never treats it as widening", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    { version: 1, issue: 375, branch: CANONICAL_BRANCH },
    [{ kind: "branch.advance", branch: CANONICAL_BRANCH, pathPolicy: "implementation-only" }],
  );
  assertDenied(
    () =>
      admission(context, "branch.advance", subject("branch"), projection(375, "draft"), {
        changes: [{ operation: "modify", path: "src/implementation.ts" }],
      }),
    "path-policy",
  );
});

test("does not expose Runtime trust readers, provider credentials, or unsupported authority", () => {
  const error = new CapabilityAdmissionError("operation");
  assert.equal(error.code, "CAPABILITY_ADMISSION_DENIED");
  assert.equal(error.message, "Capability admission denied.");
  for (const forbiddenOperation of ["change.implement", "change.handoff"] as const) {
    assertDenied(
      () =>
        admitAuthenticatedSessionCapability({
          context: {} as AuthenticatedSessionContext,
          operation: forbiddenOperation as unknown as CapabilityAdmissionOperation,
          subject: subject("change"),
          projection: projection(375),
        }),
      "operation",
    );
  }
  assert.throws(
    () => new CapabilityAdmissionError("runtime-trust" as unknown as CapabilityAdmissionFailureReason),
    TypeError,
  );
  assert.throws(
    () => new CapabilityAdmissionError("runtime-ceiling" as unknown as CapabilityAdmissionFailureReason),
    TypeError,
  );
});

test("rejects obsolete authority inputs instead of consuming them", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.show",
    { version: 1, issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
  );
  const request = {
    context,
    operation: "change.show" as const,
    subject: subject("change"),
    projection: projection(375, "draft"),
  };
  assertDenied(
    () =>
      admitAuthenticatedSessionCapability({
        ...request,
        runtimeAuthorityReader: {},
      } as unknown as CapabilityAdmissionRequest),
    "session-capability",
  );
  assertDenied(
    () =>
      admitAuthenticatedSessionCapability({
        ...request,
        pathPolicyResolver: {},
      } as unknown as CapabilityAdmissionRequest),
    "session-capability",
  );
});

test("publishes exactly the frozen admission runtime surface", () => {
  assert.deepEqual(Object.keys(capabilityAdmissionModule).sort(), [
    "CAPABILITY_ADMISSION_CONTRACT_VERSION",
    "CapabilityAdmissionError",
    "admitAuthenticatedSessionCapability",
  ]);
  for (const obsoleteExport of [
    "RuntimeAuthoritySourceReader",
    "resolveRuntimeAuthority",
    "CAPABILITY_ADMISSION_OPERATIONS",
    "CAPABILITY_ADMISSION_FAILURE_REASONS",
    "CapabilityAdmissionDeniedError",
    "CapabilityAdmissionPathPolicyResolver",
    "CapabilityAdmissionResolvedPathPolicy",
    "AuthenticatedSessionCapabilityAdmission",
  ]) {
    assert.equal(obsoleteExport in capabilityAdmissionModule, false, obsoleteExport);
  }
});
