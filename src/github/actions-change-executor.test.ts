import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GitHubActionsApiTransport,
  GitHubActionsCredentialBroker,
  GitHubActionsEvidenceReader,
  GitHubActionsChangeExecutorError,
  REPOSITORY_EVIDENCE_FAILURE_REASONS,
  TRUSTED_ACTIONS_FAILURE_STAGES,
  createGitHubActionsChangeExecutor,
  deriveChangeNamingFromIssueTitle,
  asTrustedActionsFailure,
  isRepositoryEvidenceFailureReason,
  isTrustedActionsFailureStage,
  loadBranchGovernance,
  runGitHubActionsChangeExecutor,
} from "./actions-change-executor.js";
import type {
  GitHubChangeEffectRequest,
  GitHubChangeEffectResponse,
  GitHubChangeEffectTransport,
} from "./change-effect-adapter.js";
import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  MAX_CHANGE_ARTIFACT_BODY_LENGTH,
  createChangeDiagnostic,
  planChangeIssuance,
  projectChangeFromGitHubEvidence,
  type ChangeEffect,
  type ChangeEffectSuccessEvidence,
} from "../change.js";
import { ChangeTrustedExecutorError, TrustedChangeExecutor } from "../change-trusted-executor.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerCredentialRequest,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type IssuerRepositoryIdentity,
  type TrustedExecutionContext,
} from "./issuer-authority.js";
import { changeRemoteMutationRequest, changeRemoteReadRequest } from "../change-executor.js";

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const target: IssuerRepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "218000001",
  nameWithOwner: "acme/inari",
};
const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function effectSuccessEvidence(effect: ChangeEffect): ChangeEffectSuccessEvidence {
  switch (effect.kind) {
    case "CREATE_BRANCH":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        createdCommitSha: "0123456789abcdef0123456789abcdef01234567",
      };
    case "CREATE_PULL_REQUEST":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        rootIssue: effect.rootIssue,
        pullRequest: 2180,
      };
    case "MARK_PULL_REQUEST_READY":
    case "CLOSE_PULL_REQUEST":
      return { kind: effect.kind, pullRequest: effect.pullRequest };
    case "DELETE_BRANCH":
      return effect.expectedCommitSha === undefined
        ? { kind: effect.kind, branch: effect.branch }
        : { kind: effect.kind, branch: effect.branch, expectedCommitSha: effect.expectedCommitSha, outcome: "deleted" };
  }
}

function issuerCredentialRequest(): IssuerCredentialRequest {
  return {
    version: 1,
    authority: "issuer",
    app: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: INARI_ISSUER_PRINCIPAL },
    execution: {
      version: 1,
      runtime: "github-actions",
      event: "workflow_dispatch",
      repository: target,
      workflowRef: "refs/heads/main",
      workflowSha: "a".repeat(40),
      workflowTrust: "protected",
      codeExecution: "trusted-only",
      fork: false,
      pullRequest: false,
    },
    target,
    permissions: { contents: "write" },
  };
}

test("Issue title naming is resolved by the executable runtime and not by workflow YAML", () => {
  assert.deepEqual(deriveChangeNamingFromIssueTitle("feat: Execute Change plans safely"), {
    type: "feat",
    slug: "execute-change-plans-safely",
  });
  assert.deepEqual(deriveChangeNamingFromIssueTitle("fix: normalize café input"), {
    type: "fix",
    slug: "normalize-cafe-input",
  });
  assert.throws(() => deriveChangeNamingFromIssueTitle("unclassified work"));
});

test("trusted Actions diagnostics are enumerable, bounded, and non-secret", () => {
  assert.deepEqual(TRUSTED_ACTIONS_FAILURE_STAGES, [
    "repository-evidence",
    "trusted-execution",
    "branch-governance",
    "issuer-configuration",
    "installation-token",
    "installation-scope",
    "projection-execution",
  ]);
  for (const stage of TRUSTED_ACTIONS_FAILURE_STAGES) {
    const error = new GitHubActionsChangeExecutorError("Bearer secret-token", stage);
    assert.deepEqual(error.details, { stage });
    assert.equal(isTrustedActionsFailureStage(stage), true);
    assert.equal(JSON.stringify(error.details).includes("secret-token"), false);
  }
  assert.equal(isTrustedActionsFailureStage("arbitrary-provider-error"), false);
});

class ReadTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];

  constructor(
    private readonly options: {
      readonly issueBody?: unknown;
      readonly issueTitle?: unknown;
      readonly pullRequests?: readonly unknown[];
      readonly branchPresent?: boolean;
      readonly branchSha?: string;
    } = {},
  ) {}

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    if (request.path.endsWith("repos/acme/inari")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/218")) {
      return {
        status: 200,
        body: {
          number: 218,
          title: this.options.issueTitle ?? "feat: Execute Change plans safely",
          state: "open",
          body: this.options.issueBody,
        },
      };
    }
    if (request.path.includes("git/ref/heads/feat%2F218-execute-change-plans-safely")) {
      return this.options.branchPresent
        ? {
            status: 200,
            body: {
              ref: "refs/heads/feat/218-execute-change-plans-safely",
              ...(this.options.branchSha === undefined
                ? {}
                : { object: { type: "commit", sha: this.options.branchSha } }),
            },
          }
        : { status: 404, body: { message: "Not Found" } };
    }
    if (request.path.includes("git/matching-refs/heads/")) return { status: 200, body: [] };
    if (request.path.endsWith("pulls/2190")) {
      return {
        status: 200,
        body: {
          number: 2190,
          head: { ref: "manual/branch" },
          base: { ref: "main" },
          state: "open",
          draft: true,
          merged_at: null,
          user: { login: "human" },
        },
      };
    }
    if (request.path.includes("pulls?state=all")) {
      return { status: 200, body: this.options.pullRequests ?? [] };
    }
    throw new Error("unexpected read");
  }
}

test("Actions evidence reader retains the observed canonical branch generation", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const transport = new ReadTransport({ branchPresent: true, branchSha: sha });
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
    transport,
  });
  const result = await reader.read(changeRemoteMutationRequest("issue", 218));
  assert.deepEqual(result.evidence.branches, {
    status: "available",
    value: [{ name: "feat/218-execute-change-plans-safely", sha }],
  });
});

test("merge-boundary evidence retains the observed PR even when its branch is noncanonical", async () => {
  const transport = new ReadTransport({
    pullRequests: [
      {
        number: 2190,
        head: { ref: "manual/branch" },
        base: { ref: "main" },
        state: "open",
        draft: true,
        merged_at: null,
        user: { login: "human" },
      },
    ],
  });
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    pullRequestNumber: 2190,
    branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
    transport,
  });

  const result = await reader.read(changeRemoteReadRequest(218));
  assert.deepEqual(result.evidence.pullRequests, {
    status: "available",
    value: [
      {
        number: 2190,
        head: "manual/branch",
        base: "main",
        state: "open",
        draft: true,
        merged: false,
        rootIssue: 218,
        provenance: { issuer: "human" },
      },
    ],
  });
});

class CanonicalPullRequestLookupTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];

  constructor(private readonly pullRequests: readonly unknown[]) {}

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    if (request.path.endsWith("repos/acme/inari")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/218")) {
      return {
        status: 200,
        body: { number: 218, title: "feat: Execute Change plans safely", state: "open" },
      };
    }
    if (request.path.includes("git/ref/heads/feat%2F218-execute-change-plans-safely")) {
      return { status: 404, body: { message: "Not Found" } };
    }
    if (request.path.includes("git/matching-refs/heads/")) return { status: 200, body: [] };
    if (request.path.includes("pulls?state=all&head=")) {
      return { status: 200, body: this.pullRequests };
    }
    if (request.path.includes("pulls?state=all&per_page=")) {
      throw new Error("unfiltered pull-request enumeration is not allowed");
    }
    throw new Error(`unexpected read: ${request.path}`);
  }
}

test("canonical PR lookup is independent of repository PR ordering", async () => {
  const transport = new CanonicalPullRequestLookupTransport([
    {
      number: 2180,
      head: { ref: "feat/218-execute-change-plans-safely" },
      base: { ref: "main" },
      state: "open",
      draft: true,
      merged_at: null,
      user: { login: "inari-issuer[bot]" },
    },
  ]);
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });

  const result = await reader.read(changeRemoteMutationRequest("issue", 218));

  assert.deepEqual(result.evidence.pullRequests, {
    status: "available",
    value: [
      {
        number: 2180,
        head: "feat/218-execute-change-plans-safely",
        base: "main",
        state: "open",
        draft: true,
        merged: false,
        provenance: { issuer: INARI_ISSUER_PRINCIPAL },
      },
    ],
  });
  assert.equal(
    transport.calls.some((request) =>
      request.path.includes(
        "pulls?state=all&head=acme%3Afeat%2F218-execute-change-plans-safely&base=main&per_page=100",
      ),
    ),
    true,
  );
  assert.equal(
    transport.calls.some((request) => request.path === "repos/acme/inari/pulls?state=all&per_page=100"),
    false,
  );
});

test("canonical PR lookup does not fail when repository history hits the legacy 100-item bound", async () => {
  const canonical = {
    number: 2180,
    head: { ref: "feat/218-execute-change-plans-safely" },
    base: { ref: "main" },
    state: "open",
    draft: true,
    merged_at: null,
    user: { login: "inari-issuer[bot]" },
  };
  const transport = new (class extends CanonicalPullRequestLookupTransport {
    override async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
      if (request.path === "repos/acme/inari/pulls?state=all&per_page=100") {
        return { status: 200, body: Array.from({ length: 100 }, () => null) };
      }
      return super.request(request);
    }
  })([canonical]);

  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });

  const result = await reader.read(changeRemoteMutationRequest("issue", 218));

  assert.deepEqual(result.evidence.pullRequests, {
    status: "available",
    value: [
      {
        number: 2180,
        head: "feat/218-execute-change-plans-safely",
        base: "main",
        state: "open",
        draft: true,
        merged: false,
        provenance: { issuer: INARI_ISSUER_PRINCIPAL },
      },
    ],
  });
  assert.equal(
    transport.calls.some((request) => request.path.endsWith("pulls?state=all&per_page=100")),
    false,
  );
});

test("canonical PR lookup reports bounded incomplete evidence", async () => {
  const transport = new CanonicalPullRequestLookupTransport(Array.from({ length: 100 }, () => null));
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });

  await assert.rejects(
    () => reader.read(changeRemoteMutationRequest("issue", 218)),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "repository-evidence" &&
      error.details.reason === "pull-request-evidence",
  );
});

test("repository root read failures retain a bounded repository reason", async () => {
  const transport = new (class extends ReadTransport {
    override async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
      if (request.path.endsWith("repos/acme/inari")) return { status: 404, body: { message: "Not Found" } };
      return super.request(request);
    }
  })();
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    transport,
  });

  await assert.rejects(
    () => reader.read(changeRemoteMutationRequest("issue", 218)),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "repository-evidence" &&
      error.details.reason === "repository-status",
  );
});

test("Actions evidence reader accepts multiline Issue bodies while preserving single-line validation", async () => {
  const transport = new ReadTransport({ issueBody: "## Summary\r\n\r\nfirst paragraph\nsecond paragraph" });
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
    transport,
  });

  const result = await reader.read(changeRemoteMutationRequest("issue", 218));
  assert.deepEqual(result.naming, { type: "feat", slug: "execute-change-plans-safely" });

  const invalidTitleReader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
    transport: new ReadTransport({ issueTitle: "feat: invalid\ntitle" }),
  });
  await assert.rejects(() => invalidTitleReader.read(changeRemoteMutationRequest("issue", 218)));
});

class MultilineReadyTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    if (request.path.endsWith("repos/acme/inari")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/239")) {
      return {
        status: 200,
        body: {
          number: 239,
          title: "feat: dogfood governed Change lifecycle through trusted Actions",
          state: "open",
          body: "## Issue\r\n\r\nline one\nline two",
        },
      };
    }
    if (request.path.includes("git/ref/heads/feat%2F239-dogfood-governed-change-lifecycle-through-trusted-actions")) {
      return {
        status: 200,
        body: { ref: "refs/heads/feat/239-dogfood-governed-change-lifecycle-through-trusted-actions" },
      };
    }
    if (request.path.includes("git/matching-refs/heads/")) return { status: 200, body: [] };
    if (request.path.includes("pulls?state=all")) {
      return {
        status: 200,
        body: [
          {
            number: 2180,
            head: { ref: "feat/239-dogfood-governed-change-lifecycle-through-trusted-actions" },
            base: { ref: "main" },
            state: "open",
            draft: true,
            merged_at: null,
            user: { login: "inari-issuer[bot]" },
          },
        ],
      };
    }
    if (request.path.endsWith("pulls/2180")) {
      return { status: 200, body: { number: 2180, body: "## Pull request\r\n\r\nline one\nline two" } };
    }
    if (request.path.includes("git/trees/main?recursive=1")) {
      return { status: 200, body: { sha: "tree-sha", truncated: false, tree: [] } };
    }
    throw new Error(`unexpected read: ${request.path}`);
  }
}

test("ready evidence reader reaches multiline PR body through readPullRequestBody", async () => {
  const transport = new MultilineReadyTransport();
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 239 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
    cwd: "/tmp/inari-missing-governance",
  });

  const result = await reader.read(changeRemoteMutationRequest("ready", 239));
  assert.deepEqual(result.naming, { type: "feat", slug: "dogfood-governed-change-lifecycle-through-trusted-actions" });
  assert.equal(result.readyEvidence, undefined);
  assert.equal(
    transport.calls.some((request) => request.path.endsWith("pulls/2180")),
    true,
  );
});

test("Issue and PR body validation rejects non-line-break controls and preserves the length bound", async () => {
  for (const control of ["\u0000", "\u001B"]) {
    const reader = new GitHubActionsEvidenceReader({
      repository,
      identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
      branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
      transport: new ReadTransport({ issueBody: `body${control}` }),
    });
    await assert.rejects(() => reader.read(changeRemoteMutationRequest("issue", 218)));
  }

  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
    transport: new ReadTransport({ issueBody: "x".repeat(MAX_CHANGE_ARTIFACT_BODY_LENGTH + 1) }),
  });
  await assert.rejects(() => reader.read(changeRemoteMutationRequest("issue", 218)));
});

test("Actions evidence reader returns only bounded Core projection input", async () => {
  const transport = new ReadTransport();
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });
  const result = await reader.read(changeRemoteMutationRequest("issue", 218));

  assert.deepEqual(result.naming, {
    type: "feat",
    slug: "execute-change-plans-safely",
  });
  assert.deepEqual(result.evidence.branches, { status: "absent" });
  assert.deepEqual(result.evidence.pullRequests, { status: "absent" });
  assert.equal(JSON.stringify(result).includes("Not Found"), false);
});

test("Actions evidence reader rejects an Issue response that is already a pull request", async () => {
  const transport = new ReadTransport();
  const original = transport.request.bind(transport);
  transport.request = async (request) => {
    const response = await original(request);
    if (request.path.endsWith("issues/218") && response.status === 200 && response.body !== undefined) {
      return { ...response, body: { ...(response.body as Record<string, unknown>), pull_request: {} } };
    }
    return response;
  };
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });
  await assert.rejects(() => reader.read(changeRemoteMutationRequest("issue", 218)), GitHubActionsChangeExecutorError);
});

function githubPullRequestEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 2180,
    head: { ref: "feat/218-execute-change-plans-safely" },
    base: { ref: "main" },
    state: "closed",
    draft: false,
    merged_at: null,
    user: { login: "inari-issuer[bot]" },
    ...overrides,
  };
}

function evidenceReaderForPullRequests(
  pullRequests: readonly unknown[],
  branchPresent = true,
): GitHubActionsEvidenceReader {
  return new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 218 },
    branchGovernance: { pattern: "^[a-z]+/[0-9]+-[a-z0-9-]+$" },
    transport: new ReadTransport({ pullRequests, branchPresent }),
  });
}

test("Actions evidence reader requires validated merge evidence for closed PRs", async () => {
  const merged = await evidenceReaderForPullRequests([
    githubPullRequestEvidence({ merged_at: "2024-02-29T12:34:56.123Z" }),
  ]).read(changeRemoteMutationRequest("issue", 218));
  assert.deepEqual(merged.evidence.pullRequests, {
    status: "available",
    value: [
      {
        number: 2180,
        head: "feat/218-execute-change-plans-safely",
        base: "main",
        state: "closed",
        draft: false,
        merged: true,
        provenance: { issuer: "app:inari-issuer" },
      },
    ],
  });
  assert.equal(projectChangeFromGitHubEvidence(merged).change?.state, "MERGED");

  const aborted = await evidenceReaderForPullRequests([githubPullRequestEvidence()], false).read(
    changeRemoteMutationRequest("issue", 218),
  );
  assert.equal(projectChangeFromGitHubEvidence(aborted).change?.state, "ABORTED");

  const openWithoutMergeEvidence = await evidenceReaderForPullRequests([
    githubPullRequestEvidence({ state: "open", draft: true, merged_at: undefined }),
  ]).read(changeRemoteMutationRequest("issue", 218));
  assert.equal(projectChangeFromGitHubEvidence(openWithoutMergeEvidence).change?.state, "DRAFT");
  assert.deepEqual(openWithoutMergeEvidence.evidence.pullRequests, {
    status: "available",
    value: [
      {
        number: 2180,
        head: "feat/218-execute-change-plans-safely",
        base: "main",
        state: "open",
        draft: true,
        merged: false,
        provenance: { issuer: "app:inari-issuer" },
      },
    ],
  });
});

test("Actions evidence reader fails closed for omitted or malformed closed PR merge evidence", async () => {
  const { merged_at: _omitted, ...withoutMergeEvidence } = githubPullRequestEvidence();
  const candidates = [
    withoutMergeEvidence,
    githubPullRequestEvidence({ merged_at: undefined }),
    githubPullRequestEvidence({ merged_at: "not-a-timestamp" }),
    githubPullRequestEvidence({ merged_at: "2024-02-30T12:34:56Z" }),
    githubPullRequestEvidence({ merged_at: 1_710_000_000 }),
  ];
  for (const candidate of candidates) {
    await assert.rejects(
      () => evidenceReaderForPullRequests([candidate]).read(changeRemoteMutationRequest("issue", 218)),
      GitHubActionsChangeExecutorError,
    );
  }
});

class MutablePreIssuanceTransport implements GitHubChangeEffectTransport {
  branch = false;
  pullRequest = false;

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    if (request.path.endsWith("repos/acme/inari")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/239")) {
      return {
        status: 200,
        body: { number: 239, title: "feat: dogfood governed Change lifecycle through trusted Actions", state: "open" },
      };
    }
    if (request.path.includes("git/ref/heads/feat%2F239-dogfood-governed-change-lifecycle-through-trusted-actions")) {
      return this.branch
        ? {
            status: 200,
            body: { ref: "refs/heads/feat/239-dogfood-governed-change-lifecycle-through-trusted-actions" },
          }
        : { status: 404, body: { message: "Not Found" } };
    }
    if (request.path.includes("git/matching-refs/heads/")) return { status: 200, body: [] };
    if (request.path.includes("pulls?state=all")) {
      return {
        status: 200,
        body: this.pullRequest
          ? [
              {
                number: 2180,
                head: { ref: "feat/239-dogfood-governed-change-lifecycle-through-trusted-actions" },
                base: { ref: "main" },
                state: "open",
                draft: true,
                merged_at: null,
                user: { login: "inari-issuer[bot]" },
              },
            ]
          : [],
      };
    }
    throw new Error("unexpected read");
  }
}

test("trusted executor preserves a reader's DEFINED pre-issuance projection and plans creation", async () => {
  const transport = new MutablePreIssuanceTransport();
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 239 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    transport,
  });
  const request = changeRemoteMutationRequest("issue", 239);
  const initial = await reader.read(request);
  const initialProjection = projectChangeFromGitHubEvidence(initial);
  assert.equal(initialProjection.valid, true);
  assert.equal(initialProjection.status, "absent");
  assert.equal(initialProjection.change?.state, "DEFINED");
  const plan = planChangeIssuance(initial);
  assert.equal(plan.mode, "create");
  assert.deepEqual(
    plan.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST"],
  );

  const effects: string[] = [];
  const target: IssuerRepositoryIdentity = {
    repositoryHost: "github.com",
    repositoryId: "218000001",
    nameWithOwner: "acme/inari",
  };
  const execution: TrustedExecutionContext = {
    version: 1,
    runtime: "github-actions",
    event: "workflow_dispatch",
    repository: target,
    workflowRef: "refs/heads/main",
    workflowSha: "a".repeat(40),
    workflowTrust: "protected",
    codeExecution: "trusted-only",
    fork: false,
    pullRequest: false,
  };
  const issuerAuthority = {
    applyEffects: async (input: IssuerMutationRequest): Promise<IssuerMutationResult> => {
      const effect = input.effects[0];
      assert.ok(effect);
      effects.push(effect.kind);
      if (effect.kind === "CREATE_BRANCH") transport.branch = true;
      if (effect.kind === "CREATE_PULL_REQUEST") transport.pullRequest = true;
      return {
        version: 1,
        authority: "issuer",
        issuer: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: INARI_ISSUER_PRINCIPAL },
        repository: target,
        installation: { appId: "218", installationId: "219", repositoryHost: "github.com" },
        permissions: {},
        effects: [
          {
            kind: effect.kind,
            status: "applied",
            evidence: effectSuccessEvidence(effect),
          },
        ],
      };
    },
  };
  const executor = new TrustedChangeExecutor({ reader, issuerAuthority, execution, target });
  const result = await executor.execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "issue",
    issue: 239,
  });

  assert.deepEqual(effects, ["CREATE_BRANCH", "CREATE_PULL_REQUEST"]);
  assert.equal(result.evidence?.outcome, "verified");
  assert.equal(result.projection.change?.state, "DRAFT");
  assert.equal(result.projection.change?.projection?.pullRequest, 2180);
});

class TitleEditedIssuedTransport implements GitHubChangeEffectTransport {
  readonly oldBranch = "feat/239-before-title-edit";

  constructor(readonly title = "feat: after title edit") {}

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    if (request.path.endsWith("repos/acme/inari")) {
      return { status: 200, body: { id: 218000001, default_branch: "main" } };
    }
    if (request.path.endsWith("issues/239")) {
      return { status: 200, body: { number: 239, title: this.title, state: "open" } };
    }
    if (request.path.includes("git/ref/heads/feat%2F239-after-title-edit")) {
      return { status: 404, body: { message: "Not Found" } };
    }
    if (request.path.includes("git/matching-refs/heads/")) {
      return {
        status: 200,
        body: [{ ref: `refs/heads/${this.oldBranch}` }],
      };
    }
    if (request.path.includes("pulls?state=all")) {
      return {
        status: 200,
        body: [
          {
            number: 2181,
            head: { ref: this.oldBranch },
            base: { ref: "main" },
            state: "open",
            draft: true,
            merged_at: null,
            user: { login: "inari-issuer[bot]" },
          },
        ],
      };
    }
    throw new Error("unexpected read");
  }
}

test("Actions evidence anchors an issued branch and PR after a root Issue title edit", async () => {
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 239 },
    branchGovernance: { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" },
    transport: new TitleEditedIssuedTransport(),
  });
  const input = await reader.read(changeRemoteMutationRequest("issue", 239));
  const projection = projectChangeFromGitHubEvidence(input);

  assert.equal(projection.valid, true);
  assert.equal(projection.status, "healthy");
  assert.equal(projection.canonicalBranch, "feat/239-before-title-edit");
  assert.deepEqual(projection.change?.projection, { branch: "feat/239-before-title-edit", pullRequest: 2181 });
  const plan = planChangeIssuance(input);
  assert.equal(plan.mode, "return-existing");
  assert.deepEqual(plan.effects, []);
});

test("issued evidence survives a title edit that no longer matches pre-issuance naming", async () => {
  const reader = new GitHubActionsEvidenceReader({
    repository,
    identity: { repositoryHost: "github.com", repositoryId: "218000001", rootIssue: 239 },
    branchGovernance: { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" },
    transport: new TitleEditedIssuedTransport("renamed descriptive title"),
  });
  const projection = projectChangeFromGitHubEvidence(await reader.read(changeRemoteMutationRequest("issue", 239)));
  assert.equal(projection.valid, true);
  assert.equal(projection.canonicalBranch, "feat/239-before-title-edit");
});

test("App installation token is confined to the broker transport and never its scope/result", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = "installation-secret-token";
  const calls: RequestInit[] = [];
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          token,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
          repositories: [{ id: Number(target.repositoryId), full_name: target.nameWithOwner }],
        }),
        { status: 201 },
      );
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: "a".repeat(40) } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ ref: "refs/heads/feat/218-safe", object: { type: "commit", sha: "a".repeat(40) } }),
      {
        status: 201,
      },
    );
  };
  const broker = new GitHubActionsCredentialBroker({
    appId: "218",
    installationId: "219",
    privateKeyPem,
    repository,
    fetch,
  });
  const request = issuerCredentialRequest();
  let capabilityScope: unknown;
  await broker.withScopedInstallationCredential(request, async (capability) => {
    capabilityScope = capability.scope;
    await capability.apply({ kind: "CREATE_BRANCH", branch: "feat/218-safe", baseBranch: "main" });
  });
  assert.equal(JSON.stringify(capabilityScope).includes(token), false);
  assert.equal(JSON.stringify(capabilityScope).includes(privateKeyPem), false);
  assert.match(String(calls[1]?.headers && JSON.stringify(calls[1]?.headers)), /Bearer installation-secret-token/u);
});

test("API transport does not return credential-bearing headers or unbounded response data", async () => {
  const token = "read-token";
  let received: RequestInit | undefined;
  const transport = new GitHubActionsApiTransport({
    token,
    fetch: async (_input, init) => {
      received = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const result = await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(JSON.stringify(received?.headers), /Bearer read-token/u);
});

test("API transport uses GitHub GraphQL updateRefs as an atomic conditional branch delete", async () => {
  let receivedUrl: string | undefined;
  let receivedInit: RequestInit | undefined;
  const transport = new GitHubActionsApiTransport({
    token: "issuer-token",
    repositoryNodeId: "R_kgDO218000001",
    fetch: async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return new Response(JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }), { status: 200 });
    },
  });

  const result = await transport.compareAndDeleteBranch({
    branch: "feat/218-execute-change-plans-safely",
    expectedCommitSha: "0123456789abcdef0123456789abcdef01234567",
  });

  assert.equal(result, "deleted");
  assert.equal(receivedUrl, "https://api.github.com/graphql");
  const body = JSON.parse(String(receivedInit?.body)) as {
    readonly variables: {
      readonly input: {
        readonly repositoryId: string;
        readonly refUpdates: readonly [
          {
            readonly name: string;
            readonly beforeOid: string;
            readonly afterOid: string;
            readonly force: boolean;
          },
        ];
      };
    };
  };
  assert.deepEqual(body.variables.input, {
    repositoryId: "R_kgDO218000001",
    refUpdates: [
      {
        name: "refs/heads/feat/218-execute-change-plans-safely",
        beforeOid: "0123456789abcdef0123456789abcdef01234567",
        afterOid: "0000000000000000000000000000000000000000",
        force: true,
      },
    ],
  });
});

test("API transport failures expose only the bounded projection boundary", async () => {
  const transport = new GitHubActionsApiTransport({
    token: "read-token",
    failureStage: "projection-execution",
    fetch: async () => {
      throw new Error("Authorization: Bearer secret-token; /private/path");
    },
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "projection-execution" &&
      !error.message.includes("secret-token") &&
      !JSON.stringify(error).includes("secret-token") &&
      !JSON.stringify(error).includes("/private/path"),
  );
});

function trustedEnvironment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_REPOSITORY: "acme/inari",
    GITHUB_TOKEN: "read-token",
    GITHUB_ACTOR: "octocat",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "acme/inari/.github/workflows/inari-change-executor.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: checkedOutSha,
    INARI_ISSUER_APP_ID: "218",
    INARI_ISSUER_INSTALLATION_ID: "219",
    INARI_ISSUER_APP_PRIVATE_KEY: "unused-in-these-tests",
    ...overrides,
  };
}

function repositoryOnlyFetch(fork: boolean): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ id: 218000001, default_branch: "main", fork }), {
      status: 200,
    })) as unknown as typeof globalThis.fetch;
}

const branchPolicySource = ["version: 1", "sections: []", "branch:", '  pattern: "^feat/[0-9]+-[a-z0-9-]+$"', ""].join(
  "\n",
);

async function withPolicyRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "gh-inari-branch-policy-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePolicy(root: string, relativePath: string, source = branchPolicySource): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
}

test("branch policy fallback is selected only when the primary path is absent", async () => {
  await withPolicyRoot(async (root) => {
    await writePolicy(root, ".inari/pr-policy.yml");
    assert.deepEqual(await loadBranchGovernance(root), { pattern: "^feat/[0-9]+-[a-z0-9-]+$" });
  });
});

test("a non-regular primary policy cannot fall back to a valid legacy policy", async () => {
  await withPolicyRoot(async (root) => {
    await mkdir(path.join(root, ".github/inari/pr-policy.yml"), { recursive: true });
    await writePolicy(root, ".inari/pr-policy.yml");
    await assert.rejects(
      () => loadBranchGovernance(root),
      (error: unknown) =>
        error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "branch-governance",
    );
  });
});

test("a primary policy symlink cannot be used or bypassed through the legacy path", async () => {
  await withPolicyRoot(async (root) => {
    const target = path.join(root, "outside-policy.yml");
    await writeFile(target, branchPolicySource, "utf8");
    const primary = path.join(root, ".github/inari/pr-policy.yml");
    await mkdir(path.dirname(primary), { recursive: true });
    await symlink(target, primary);
    await writePolicy(root, ".inari/pr-policy.yml");
    await assert.rejects(
      () => loadBranchGovernance(root),
      (error: unknown) =>
        error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "branch-governance",
    );
  });
});

test("missing policies, malformed primary policy, and valid primary policy remain fail-closed and deterministic", async () => {
  await withPolicyRoot(async (root) => {
    await assert.rejects(
      () => loadBranchGovernance(root),
      (error: unknown) =>
        error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "branch-governance",
    );

    await writePolicy(root, ".github/inari/pr-policy.yml", "version: 1\nsections: [");
    await writePolicy(root, ".inari/pr-policy.yml");
    await assert.rejects(
      () => loadBranchGovernance(root),
      (error: unknown) =>
        error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "branch-governance",
    );

    await writePolicy(root, ".github/inari/pr-policy.yml");
    assert.deepEqual(await loadBranchGovernance(root), { pattern: "^feat/[0-9]+-[a-z0-9-]+$" });
  });
});

test("runtime setup exposes the bounded stage at each setup boundary", async () => {
  const cases: readonly {
    readonly name: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly stage: (typeof TRUSTED_ACTIONS_FAILURE_STAGES)[number];
  }[] = [
    {
      name: "repository configuration",
      environment: trustedEnvironment({ GITHUB_REPOSITORY: undefined }),
      stage: "repository-evidence",
    },
    {
      name: "trusted execution",
      environment: trustedEnvironment({ GITHUB_REF: "refs/heads/feature-x" }),
      stage: "trusted-execution",
    },
    {
      name: "trusted checkout",
      environment: trustedEnvironment(),
      cwd: "/tmp/inari-missing-governance",
      stage: "trusted-execution",
    },
    {
      name: "issuer configuration",
      environment: trustedEnvironment({ INARI_ISSUER_APP_ID: undefined }),
      stage: "issuer-configuration",
    },
  ];
  for (const testCase of cases) {
    await assert.rejects(
      createGitHubActionsChangeExecutor({
        cwd: testCase.cwd ?? process.cwd(),
        request: changeRemoteMutationRequest("issue", 218),
        environment: testCase.environment,
        fetch: repositoryOnlyFetch(false),
      }),
      (error: unknown) => error instanceof GitHubActionsChangeExecutorError && error.details?.stage === testCase.stage,
      testCase.name,
    );
  }
});

test("repository-evidence bootstrap failures are distinguishable by bounded fixed reason", async () => {
  assert.deepEqual(REPOSITORY_EVIDENCE_FAILURE_REASONS, [
    "repository-configuration",
    "repository-request",
    "repository-status",
    "repository-body",
    "repository-id",
    "repository-fork",
    "pull-request-evidence",
  ]);
  for (const reason of REPOSITORY_EVIDENCE_FAILURE_REASONS) {
    assert.equal(isRepositoryEvidenceFailureReason(reason), true);
  }
  assert.equal(isRepositoryEvidenceFailureReason("provider-specific"), false);

  const cases: readonly {
    readonly name: string;
    readonly reason: (typeof REPOSITORY_EVIDENCE_FAILURE_REASONS)[number];
    readonly fetch: typeof globalThis.fetch;
  }[] = [
    {
      name: "transport request failure",
      reason: "repository-request",
      fetch: (async () => {
        throw new Error("Authorization: Bearer secret-token; ECONNRESET /private/path");
      }) as unknown as typeof globalThis.fetch,
    },
    {
      name: "non-200 status",
      reason: "repository-status",
      fetch: (async () =>
        new Response(JSON.stringify({ message: "provider-secret-error-body" }), {
          status: 403,
        })) as unknown as typeof globalThis.fetch,
    },
    {
      name: "malformed body",
      reason: "repository-body",
      fetch: (async () =>
        new Response(JSON.stringify([1, 2, 3]), { status: 200 })) as unknown as typeof globalThis.fetch,
    },
    {
      name: "invalid repository id",
      reason: "repository-id",
      fetch: (async () =>
        new Response(JSON.stringify({ id: "not-a-number", default_branch: "main", fork: false }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    },
    {
      name: "missing fork evidence",
      reason: "repository-fork",
      fetch: (async () =>
        new Response(JSON.stringify({ id: 218000001, default_branch: "main" }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    },
  ];

  for (const testCase of cases) {
    await assert.rejects(
      createGitHubActionsChangeExecutor({
        cwd: process.cwd(),
        request: changeRemoteMutationRequest("issue", 218),
        environment: trustedEnvironment(),
        fetch: testCase.fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubActionsChangeExecutorError, testCase.name);
        assert.deepEqual(error.details, { stage: "repository-evidence", reason: testCase.reason }, testCase.name);
        assert.equal(JSON.stringify(error).includes("secret-token"), false, testCase.name);
        assert.equal(JSON.stringify(error).includes("provider-secret-error-body"), false, testCase.name);
        assert.equal(JSON.stringify(error).includes("/private/path"), false, testCase.name);
        return true;
      },
      testCase.name,
    );
  }
});

test("workflow entrypoint emits the bounded diagnostic and no exception payload", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await runGitHubActionsChangeExecutor(
      trustedEnvironment({
        INARI_CHANGE_REQUEST: JSON.stringify({ version: 1, operation: "issue", issue: 218 }),
        GITHUB_REPOSITORY: undefined,
      }),
      process.cwd(),
    );
    assert.equal(exitCode, 1);
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = JSON.parse(writes.join("")) as { error?: Record<string, unknown> };
  assert.deepEqual(output.error, {
    code: "CHANGE_ACTIONS_RUNTIME_INVALID",
    message: "Trusted Change execution failed closed.",
    details: { stage: "repository-evidence", reason: "repository-configuration" },
  });
  assert.doesNotMatch(JSON.stringify(output), /privateKey|token|exception|\/home/iu);
});

test("trusted executor failures retain only bounded code, Core diagnostics, and evidence", () => {
  const mapped = asTrustedActionsFailure(
    new ChangeTrustedExecutorError(
      "CHANGE_EXECUTION_PRECONDITION_FAILED",
      "Bearer installation-secret-token /private/provider/path",
      [
        createChangeDiagnostic({
          code: "CHANGE_PROVENANCE_CONFLICT",
          path: "$.governedIssue.contract.provenance.treeSha",
          message: "The validated governance generation changed before issuance.",
        }),
      ],
      {
        version: 1,
        operation: "issue",
        outcome: "recovery-required",
        effects: [],
        compensation: "failed",
      },
    ),
    "projection-execution",
  );

  assert.deepEqual(mapped.details, {
    stage: "projection-execution",
    trustedCode: "CHANGE_EXECUTION_PRECONDITION_FAILED",
    diagnostics: [
      {
        version: 1,
        code: "CHANGE_PROVENANCE_CONFLICT",
        path: "$.governedIssue.contract.provenance.treeSha",
        message: "The validated governance generation changed before issuance.",
      },
    ],
    evidence: {
      version: 1,
      operation: "issue",
      outcome: "recovery-required",
      effects: [],
      compensation: "failed",
    },
  });
  assert.doesNotMatch(JSON.stringify(mapped), /installation-secret-token|\/private\/provider\/path/iu);
});

test("unsafe or malformed trusted diagnostics are omitted at the Actions producer boundary", () => {
  const mapped = asTrustedActionsFailure(
    new ChangeTrustedExecutorError("CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED", "raw exception", [
      {
        version: 1,
        code: "CHANGE_PROJECTION_PARTIAL",
        path: "$.projection",
        message: "Bearer raw-secret-token /home/runner/private-body",
      },
    ]),
    "projection-execution",
  );

  assert.deepEqual(mapped.details, {
    stage: "projection-execution",
    trustedCode: "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(mapped), /raw exception|raw-secret-token|\/home\/runner/iu);
});

test("credential issuance and scope validation keep separate bounded stages", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const brokerOptions = {
    appId: "218",
    installationId: "219",
    privateKeyPem,
    repository,
  } as const;
  const request = issuerCredentialRequest();

  const tokenFailure = new GitHubActionsCredentialBroker({
    ...brokerOptions,
    fetch: async () => new Response("provider-secret", { status: 503 }),
  });
  await assert.rejects(
    tokenFailure.withScopedInstallationCredential(request, async () => undefined),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "installation-token",
  );

  const scopeFailure = new GitHubActionsCredentialBroker({
    ...brokerOptions,
    fetch: async () =>
      new Response(
        JSON.stringify({
          token: "installation-secret-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          permissions: { contents: "write" },
          repositories: [],
        }),
        { status: 201 },
      ),
  });
  await assert.rejects(
    scopeFailure.withScopedInstallationCredential(request, async () => undefined),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "installation-scope" &&
      !error.message.includes("installation-secret-token") &&
      !JSON.stringify(error).includes("installation-secret-token"),
  );
});

test("Trusted executor construction rejects a workflow_ref naming a different workflow file", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({
        GITHUB_WORKFLOW_REF: "acme/inari/.github/workflows/other.yml@refs/heads/main",
      }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a checkout that differs from the attested workflow SHA", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({ GITHUB_WORKFLOW_SHA: "a".repeat(40) }),
      fetch: repositoryOnlyFetch(false),
    }),
    (error: unknown) =>
      error instanceof GitHubActionsChangeExecutorError &&
      error.details?.stage === "trusted-execution" &&
      !JSON.stringify(error).includes("a".repeat(40)),
  );
});

test("Trusted executor construction rejects a workflow_ref off the protected main branch", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({
        GITHUB_WORKFLOW_REF: "acme/inari/.github/workflows/inari-change-executor.yml@refs/heads/feature-x",
      }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a workflow_ref from a different repository (cross-repo workflow_call)", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({
        GITHUB_WORKFLOW_REF: "other-org/other-repo/.github/workflows/inari-change-executor.yml@refs/heads/main",
      }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a caller ref that is not the protected main branch", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({ GITHUB_REF: "refs/heads/feature-x" }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a pull-request-triggered ref", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({ GITHUB_REF: "refs/pull/1/merge" }),
      fetch: repositoryOnlyFetch(false),
    }),
  );
});

test("Trusted executor construction rejects a forked target repository", async () => {
  await assert.rejects(
    createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment(),
      fetch: repositoryOnlyFetch(true),
    }),
  );
});

test("Trusted executor construction succeeds when the workflow ref, target ref, and repository identity are all proven", async () => {
  const executor = await createGitHubActionsChangeExecutor({
    cwd: process.cwd(),
    request: changeRemoteMutationRequest("issue", 218),
    environment: trustedEnvironment(),
    fetch: repositoryOnlyFetch(false),
  });
  assert.ok(executor);
});

test("workflow_dispatch and workflow_call both require a bounded authenticated actor", async () => {
  for (const event of ["workflow_dispatch", "workflow_call"] as const) {
    const executor = await createGitHubActionsChangeExecutor({
      cwd: process.cwd(),
      request: changeRemoteMutationRequest("issue", 218),
      environment: trustedEnvironment({ GITHUB_EVENT_NAME: event }),
      fetch: repositoryOnlyFetch(false),
    });
    assert.ok(executor);

    await assert.rejects(
      createGitHubActionsChangeExecutor({
        cwd: process.cwd(),
        request: changeRemoteMutationRequest("issue", 218),
        environment: trustedEnvironment({ GITHUB_EVENT_NAME: event, GITHUB_ACTOR: undefined }),
        fetch: repositoryOnlyFetch(false),
      }),
      (error: unknown) =>
        error instanceof GitHubActionsChangeExecutorError && error.details?.stage === "trusted-execution",
      event,
    );
  }
});

test("read-only Change executor construction does not require Issuer App secrets", async () => {
  const environment = trustedEnvironment();
  delete environment.INARI_ISSUER_APP_ID;
  delete environment.INARI_ISSUER_INSTALLATION_ID;
  delete environment.INARI_ISSUER_APP_PRIVATE_KEY;
  const executor = await createGitHubActionsChangeExecutor({
    cwd: process.cwd(),
    request: changeRemoteReadRequest(218),
    environment,
    fetch: repositoryOnlyFetch(false),
  });
  assert.equal(typeof executor.read, "function");
});
