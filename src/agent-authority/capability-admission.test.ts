import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticateSessionRequest, type AuthenticatedSessionContext } from "./session-authentication.js";
import {
  CAPABILITY_ADMISSION_CONTRACT_VERSION,
  CapabilityAdmissionError,
  admitAuthenticatedSessionCapability,
  type AdmitAuthenticatedSessionCapabilityOptions,
  type CapabilityAdmissionCanonicalState,
} from "./capability-admission.js";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  renderRuntimeAuthorityArtifact,
  signSessionRequest,
  type RuntimeAuthority,
} from "./index.js";
import type { CapabilityClaim } from "./capability.js";
import { assertRuntimeAuthority } from "./runtime-authority.js";
import type { RuntimeAuthoritySourceReader } from "./runtime-authority-trust.js";
import type { SemanticSessionRequest } from "./session-request.js";
import type { GitHubAppRepositoryReadCapability } from "../github/app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "../github/change-effect-adapter.js";
import {
  projectChangeFromGitHubEvidence,
  type Change,
  type ChangeGitHubEvidence,
  type ChangeProjectionResult,
} from "../change.js";

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

function runtimeAuthority(
  key = generateRuntimeAuthorityKeyPair(),
  overrides: Record<string, unknown> = {},
): { readonly authority: RuntimeAuthority; readonly key: ReturnType<typeof generateRuntimeAuthorityKeyPair> } {
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
      ...overrides,
    }),
  };
}

function requestEnvelope(
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
  const scope: GitHubAppRepositoryReadCapability["scope"] = {
    app: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
    installation: { appId: "1", installationId: "2", repositoryHost: "github.com" },
    repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: "acme/inari" },
    repositorySelection: "selected",
    permissions: { contents: "read", issues: "read", pull_requests: "read" },
    expiresAt: "2026-09-12T00:10:00Z",
  };
  return {
    scope,
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

function trustReader(authority: RuntimeAuthority, policySha = POLICY_SHA): RuntimeAuthoritySourceReader {
  const artifact = renderRuntimeAuthorityArtifact(authority);
  return {
    async resolveRepositoryContext() {
      return {
        hostname: "github.com",
        host: "github.com",
        owner: "acme",
        name: "inari",
        nameWithOwner: "acme/inari",
        url: "https://github.com/acme/inari",
        repositoryId: REPOSITORY_ID,
      };
    },
    async getRepositoryDefaultBranch() {
      return "main";
    },
    async findBranch(branch) {
      return { name: branch, ref: `refs/heads/${branch}`, sha: policySha };
    },
    async getRepositoryTree() {
      return { sha: TREE_SHA, entries: [{ path: artifact.path, type: "blob", sha: BLOB_SHA }] };
    },
    async getRepositoryBlob() {
      return canonicalRuntimeAuthorityJson(authority);
    },
  };
}

async function authenticatedContext(
  authority: RuntimeAuthority,
  key: ReturnType<typeof generateRuntimeAuthorityKeyPair>,
  operation: string,
  request: Record<string, unknown>,
  capabilities: readonly CapabilityClaim[],
  issue: number,
): Promise<AuthenticatedSessionContext> {
  const envelope = requestEnvelope(authority, key, operation, request, capabilities, issue);
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

function evidence(
  issue: number,
  state: "absent" | "draft" | "review" | "aborted" | "partial" = "absent",
): CapabilityAdmissionCanonicalState {
  const canonicalBranch = `feat/${issue}-semantic-capability-admission`;
  const branchEvidence: ChangeGitHubEvidence["branches"] =
    state === "absent" || state === "aborted"
      ? { status: "available", value: [] }
      : { status: "available", value: [{ name: canonicalBranch, sha: BRANCH_SHA, rootIssue: issue }] };
  const pullRequestEvidence: ChangeGitHubEvidence["pullRequests"] =
    state === "absent"
      ? { status: "available", value: [] }
      : {
          status: "available",
          value: [
            {
              number: 5375,
              head: canonicalBranch,
              base: BASE_BRANCH,
              state: state === "aborted" || state === "partial" ? "closed" : "open",
              draft: state === "draft",
              merged: false,
              ...(state === "aborted" || state === "partial" ? {} : { accepted: state === "review" }),
              rootIssue: issue,
            },
          ],
        };
  const projection = projectChangeFromGitHubEvidence({
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
  assert.equal(projection.canonicalBranch, canonicalBranch);
  return { projection, authority: { ref: "main", sha: POLICY_SHA } };
}

function options(
  context: AuthenticatedSessionContext,
  authority: RuntimeAuthority,
  canonicalState: CapabilityAdmissionCanonicalState,
  overrides: Partial<AdmitAuthenticatedSessionCapabilityOptions> = {},
): AdmitAuthenticatedSessionCapabilityOptions {
  return {
    context,
    runtimeAuthorityReader: trustReader(authority),
    canonicalState,
    now: NOW,
    ...overrides,
  };
}

async function denial(promise: Promise<unknown>, reason: CapabilityAdmissionError["reason"]): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof CapabilityAdmissionError &&
      error.code === "CAPABILITY_ADMISSION_DENIED" &&
      error.reason === reason,
  );
}

test("admits change.implement before issuance and retains Core's canonical target", async () => {
  const runtime = runtimeAuthority();
  const capabilities: readonly CapabilityClaim[] = [{ kind: "change.implement", issue: 375 }];
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.implement",
    { issue: 375 },
    capabilities,
    375,
  );
  const admitted = await admitAuthenticatedSessionCapability(options(context, runtime.authority, evidence(375)));

  assert.equal(admitted.version, CAPABILITY_ADMISSION_CONTRACT_VERSION);
  assert.equal(admitted.canonical.status, "absent");
  assert.equal(admitted.canonical.state, "DEFINED");
  assert.equal(admitted.canonical.branch, CANONICAL_BRANCH);
  assert.equal(admitted.canonical.pullRequest, undefined);
  assert.equal(admitted.lifecycle?.operation, "issue");
  assert.equal(admitted.lifecycle?.to, "DRAFT");
  assert.equal(admitted.capability.kind, "change.implement");
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.change.identity), true);
});

test("attenuates post-issuance implementation to the exact canonical branch and PR", async () => {
  const runtime = runtimeAuthority();
  const capabilities: readonly CapabilityClaim[] = [{ kind: "change.implement", issue: 375 }];
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.implement",
    { issue: 375, branch: CANONICAL_BRANCH, pullRequest: 5375 },
    capabilities,
    375,
  );
  const admitted = await admitAuthenticatedSessionCapability(
    options(context, runtime.authority, evidence(375, "draft")),
  );

  assert.deepEqual(admitted.canonical, {
    status: "healthy",
    issue: 375,
    state: "DRAFT",
    branch: CANONICAL_BRANCH,
    baseBranch: BASE_BRANCH,
    pullRequest: 5375,
  });
  assert.equal(admitted.operation, "change.implement");
  assert.equal(admitted.change.projection?.branch, CANONICAL_BRANCH);
  assert.equal(admitted.change.projection?.pullRequest, 5375);

  const handoffContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.handoff",
    { issue: 375, branch: CANONICAL_BRANCH, pullRequest: 5375 },
    capabilities,
    375,
  );
  const handoff = await admitAuthenticatedSessionCapability(
    options(handoffContext, runtime.authority, evidence(375, "draft")),
  );
  assert.equal(handoff.operation, "change.handoff");
});

test("keeps ready and abort claims separate and admits Core idempotent states", async () => {
  const runtime = runtimeAuthority();
  const readyContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.ready",
    { issue: 375 },
    [{ kind: "change.ready", issue: 375 }],
    375,
  );
  const ready = await admitAuthenticatedSessionCapability(
    options(readyContext, runtime.authority, evidence(375, "draft")),
  );
  assert.deepEqual(ready.lifecycle, { operation: "ready", from: "DRAFT", to: "REVIEW", idempotent: false });

  const abortContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.abort",
    { issue: 375 },
    [{ kind: "change.abort", issue: 375 }],
    375,
  );
  const aborted = await admitAuthenticatedSessionCapability(
    options(abortContext, runtime.authority, evidence(375, "aborted")),
  );
  assert.deepEqual(aborted.lifecycle, { operation: "abort", from: "ABORTED", to: "ABORTED", idempotent: true });

  const implementContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.ready",
    { issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
    375,
  );
  await denial(
    admitAuthenticatedSessionCapability(options(implementContext, runtime.authority, evidence(375, "draft"))),
    "session-capability",
  );
});

test("intersects claims with the current Runtime ceiling", async () => {
  const key = generateRuntimeAuthorityKeyPair();
  const issuedRuntime = runtimeAuthority(key);
  const context = await authenticatedContext(
    issuedRuntime.authority,
    key,
    "change.ready",
    { issue: 375 },
    [{ kind: "change.ready", issue: 375 }],
    375,
  );
  const revokedCeiling = runtimeAuthority(key, { capabilityCeiling: ["change.implement"] });
  await denial(
    admitAuthenticatedSessionCapability(options(context, revokedCeiling.authority, evidence(375, "draft"))),
    "runtime-ceiling",
  );
});

test("rejects cross-repository and cross-Issue substitutions", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.implement",
    { issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
    375,
  );
  const foreign = structuredClone(evidence(375)) as CapabilityAdmissionCanonicalState;
  const foreignProjection = foreign.projection as ChangeProjectionResult;
  assert.ok(foreignProjection.change);
  const foreignChange: Change = {
    ...structuredClone(foreignProjection.change),
    identity: { repositoryHost: "github.com", repositoryId: "987654321", rootIssue: 375 },
  };
  const tamperedProjection = { ...foreignProjection, change: foreignChange };
  await denial(
    admitAuthenticatedSessionCapability(
      options(context, runtime.authority, { ...foreign, projection: tamperedProjection }),
    ),
    "repository",
  );

  await denial(admitAuthenticatedSessionCapability(options(context, runtime.authority, evidence(376))), "task");
});

test("rejects wrong branch and pull-request identities", async () => {
  const runtime = runtimeAuthority();
  const branchContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    {
      issue: 375,
      branch: "feat/375-wrong",
      expectedHead: BRANCH_SHA,
      treeDelta: { changes: [{ operation: "modify", path: "src/a.ts" }] },
    },
    [{ kind: "branch.advance", branch: CANONICAL_BRANCH }],
    375,
  );
  await denial(
    admitAuthenticatedSessionCapability(options(branchContext, runtime.authority, evidence(375, "draft"))),
    "canonical-state",
  );

  const prContext = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "pullRequest.create",
    { issue: 375, head: CANONICAL_BRANCH, base: "develop" },
    [{ kind: "pullRequest.create", head: CANONICAL_BRANCH, base: BASE_BRANCH, max: 1 }],
    375,
  );
  await denial(
    admitAuthenticatedSessionCapability(options(prContext, runtime.authority, evidence(375, "draft"))),
    "canonical-state",
  );
});

test("fails closed when Runtime trust is revoked or expired", async () => {
  const key = generateRuntimeAuthorityKeyPair();
  const issuedRuntime = runtimeAuthority(key);
  const context = await authenticatedContext(
    issuedRuntime.authority,
    key,
    "change.implement",
    { issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
    375,
  );
  const disabled = runtimeAuthority(key, { status: "disabled" });
  await denial(
    admitAuthenticatedSessionCapability(options(context, disabled.authority, evidence(375))),
    "runtime-trust",
  );
  const expired = runtimeAuthority(key, { notAfter: "2026-09-11T00:00:00Z" });
  await denial(
    admitAuthenticatedSessionCapability(options(context, expired.authority, evidence(375))),
    "runtime-trust",
  );
});

test("applies the #370 protected-path deny-set to every delegated write", async () => {
  const runtime = runtimeAuthority();
  const treeDelta = {
    changes: [{ operation: "modify", path: ".github/inari/authorities/runtime.json" }],
  };
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    { issue: 375, branch: CANONICAL_BRANCH, expectedHead: BRANCH_SHA, treeDelta },
    [{ kind: "branch.advance", branch: CANONICAL_BRANCH }],
    375,
  );
  await denial(
    admitAuthenticatedSessionCapability(options(context, runtime.authority, evidence(375, "draft"))),
    "protected-path",
  );
});

test("requires a current named path policy and permits only its narrower paths", async () => {
  const runtime = runtimeAuthority();
  const treeDelta = { changes: [{ operation: "modify", path: "src/implementation.ts" }] };
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "branch.advance",
    { issue: 375, branch: CANONICAL_BRANCH, expectedHead: BRANCH_SHA, treeDelta },
    [{ kind: "branch.advance", branch: CANONICAL_BRANCH, pathPolicy: "implementation-only" }],
    375,
  );
  await denial(
    admitAuthenticatedSessionCapability(options(context, runtime.authority, evidence(375, "draft"))),
    "path-policy",
  );

  const allowed = await admitAuthenticatedSessionCapability(
    options(context, runtime.authority, evidence(375, "draft"), {
      pathPolicyResolver: {
        async resolve(name, input) {
          assert.equal(name, "implementation-only");
          assert.equal(input.authority.policySha, POLICY_SHA);
          return { name, ref: "main", sha: POLICY_SHA, allowsPath: (path) => path.startsWith("src/") };
        },
      },
    }),
  );
  assert.deepEqual(allowed.write?.pathPolicy, { name: "implementation-only", ref: "main", sha: POLICY_SHA });
});

test("rejects stale canonical evidence and accepts the same generation only", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.implement",
    { issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
    375,
  );
  await denial(
    admitAuthenticatedSessionCapability(
      options(context, runtime.authority, {
        projection: evidence(375).projection,
        authority: { ref: "main", sha: "e".repeat(40) },
      }),
    ),
    "stale-evidence",
  );
  const admitted = await admitAuthenticatedSessionCapability(options(context, runtime.authority, evidence(375)));
  assert.equal(admitted.authority.sha, POLICY_SHA);
});

test("returns idempotent admission for an already-applied Change issuance", async () => {
  const runtime = runtimeAuthority();
  const context = await authenticatedContext(
    runtime.authority,
    runtime.key,
    "change.issue",
    { issue: 375 },
    [{ kind: "change.implement", issue: 375 }],
    375,
  );
  const admitted = await admitAuthenticatedSessionCapability(
    options(context, runtime.authority, evidence(375, "draft")),
  );
  assert.deepEqual(admitted.lifecycle, { operation: "issue", from: "DRAFT", to: "DRAFT", idempotent: true });
  assert.equal(admitted.canonical.pullRequest, 5375);
});
