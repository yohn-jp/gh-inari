import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_CODES,
  GitHubChangeEffectAdapter,
  GitHubChangeEffectContractError,
  GitHubChangeEffectFailureError,
  MAX_GITHUB_CHANGE_EFFECT_REJECTION_BODY_BYTES,
  type GitHubChangeEffectRequest,
  type GitHubChangeEffectResponse,
  type GitHubChangeEffectGraphqlRequest,
  type GitHubChangeEffectGraphqlTransport,
  type GitHubChangeEffectCompareAndDeleteRequest,
  type GitHubChangeEffectCompareAndDeleteOutcome,
  type GitHubChangeEffectTransport,
  type GitHubChangeProvenanceExecutionOptions,
} from "./index.js";
import type { ChangeEffect } from "../change.js";
import { changeProvenanceRecordPath, createChangeProvenanceRecord } from "../change-provenance-record.js";
import { verifyChangeProvenanceRecord } from "../change-provenance-record.js";
import { assertRuntimeAuthority } from "../agent-authority/runtime-authority.js";
import { generateRuntimeAuthorityKeyPair } from "../agent-authority/runtime-key.js";
import type { GitHubBranchAdvanceCapability } from "./git-data-capability.js";

type StubResponse = GitHubChangeEffectResponse | Error;

class StubChangeEffectTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];
  readonly graphqlCalls: GitHubChangeEffectGraphqlRequest[] = [];
  private readonly responses: StubResponse[];
  readonly compareAndDeleteBranch:
    | ((request: GitHubChangeEffectCompareAndDeleteRequest) => Promise<GitHubChangeEffectCompareAndDeleteOutcome>)
    | undefined;

  constructor(
    responses: StubResponse[],
    compareAndDeleteBranch?: (
      request: GitHubChangeEffectCompareAndDeleteRequest,
    ) => Promise<GitHubChangeEffectCompareAndDeleteOutcome>,
  ) {
    this.responses = [...responses];
    this.compareAndDeleteBranch = compareAndDeleteBranch;
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected transport call");
    if (response instanceof Error) throw response;
    return response;
  }

  async requestGraphql(request: GitHubChangeEffectGraphqlRequest): Promise<GitHubChangeEffectResponse> {
    this.graphqlCalls.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected GraphQL transport call");
    if (response instanceof Error) throw response;
    return response;
  }
}

const repository = { hostname: "github.com", owner: "acme", name: "inari" } as const;

function response(status: number, body?: unknown): GitHubChangeEffectResponse {
  return body === undefined ? { status } : { status, body };
}

function gitReference(ref: string, sha = "0123456789abcdef0123456789abcdef01234567"): unknown {
  return { ref, object: { type: "commit", sha } };
}

function pullRequest(
  number: number,
  branch: string,
  baseBranch: string,
  draft: boolean,
  state: "open" | "closed" = "open",
): unknown {
  return {
    number,
    state,
    draft,
    head: { ref: branch },
    base: { ref: baseBranch },
  };
}

function readyPullRequest(number: number, draft: boolean): unknown {
  return { number, state: "open", draft, node_id: "MDExOlB1bGxSZXF1ZXN0OTA=" };
}

function readyMutationResponse(number: number, nodeId = "MDExOlB1bGxSZXF1ZXN0OTA="): unknown {
  return {
    data: {
      markPullRequestReadyForReview: {
        pullRequest: { id: nodeId, number, state: "OPEN", isDraft: false },
      },
    },
  };
}

function adapter(transport: GitHubChangeEffectTransport): GitHubChangeEffectAdapter {
  return new GitHubChangeEffectAdapter({
    repository,
    transport,
    graphqlTransport: transport as unknown as GitHubChangeEffectGraphqlTransport,
  });
}

function provenanceAdapter(
  transport: GitHubChangeEffectTransport,
  provenance: GitHubChangeProvenanceExecutionOptions,
): GitHubChangeEffectAdapter {
  return new GitHubChangeEffectAdapter({ repository, transport, provenance });
}

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function provenanceCapability(): {
  readonly capability: GitHubBranchAdvanceCapability;
  readonly state: {
    head: string;
    entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>;
    blobs: Map<string, string>;
  };
  readonly calls: { blobs: number; trees: number; commits: number; advances: number; reads: number };
} {
  const state = {
    head: "0123456789abcdef0123456789abcdef01234567",
    entries: [] as Array<{ path: string; mode: "100644"; type: "blob"; sha: string }>,
    blobs: new Map<string, string>(),
  };
  const calls = { blobs: 0, trees: 0, commits: 0, advances: 0, reads: 0 };
  const capability: GitHubBranchAdvanceCapability = {
    scope: {} as GitHubBranchAdvanceCapability["scope"],
    readRef: async () => {
      calls.reads += 1;
      return {
        name: "feat/513-signed-change-provenance-bootstrap",
        ref: "refs/heads/feat/513-signed-change-provenance-bootstrap",
        sha: state.head,
      };
    },
    readCommit: async (sha) => ({ sha, treeSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }),
    readTree: async () => ({ sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", entries: state.entries }),
    readBlob: async (sha) => {
      const content = state.blobs.get(sha);
      if (content === undefined) throw new Error("missing blob");
      return content;
    },
    createBlob: async ({ content }) => {
      calls.blobs += 1;
      const decoded = Buffer.from(content, "base64").toString("utf8");
      const sha = blobSha(decoded);
      state.blobs.set(sha, decoded);
      return { sha };
    },
    createTree: async () => {
      calls.trees += 1;
      state.entries = [
        { path: changeProvenanceRecordPath(513), mode: "100644", type: "blob", sha: [...state.blobs.keys()][0]! },
      ];
      return { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    },
    createCommit: async () => {
      calls.commits += 1;
      return { sha: "cccccccccccccccccccccccccccccccccccccccc" };
    },
    compareAndAdvanceRef: async ({ beforeOid, afterOid }) => {
      calls.advances += 1;
      if (beforeOid !== state.head) return { status: "rejected" };
      state.head = afterOid;
      return { status: "updated" };
    },
  };
  return { capability, state, calls };
}

function provenanceOptions(gitData: GitHubBranchAdvanceCapability): GitHubChangeProvenanceExecutionOptions {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "runtime-change",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  // Acting as "the Runtime" here is legitimate in a test: only production
  // trust domains (the App/executor) must never hold the private key.
  const signedRecord = createChangeProvenanceRecord({
    rootIssue: 513,
    runtimeAuthority,
    runtimeKey,
    actor: { type: "agent", name: "Luna" },
  });
  return {
    runtimeAuthority,
    signedRecord,
    gitData,
  };
}

test("CREATE_PROVENANCE_COMMIT writes, verifies, and replays one signed canonical record", async () => {
  const git = provenanceCapability();
  const effect = {
    kind: "CREATE_PROVENANCE_COMMIT",
    branch: "feat/513-signed-change-provenance-bootstrap",
    rootIssue: 513,
    path: changeProvenanceRecordPath(513),
  } as const;
  const options = provenanceOptions(git.capability);
  const transport = new StubChangeEffectTransport([]);

  const first = await provenanceAdapter(transport, options).execute(effect);
  assert.deepEqual(first, {
    status: "succeeded",
    effect,
    evidence: {
      kind: "CREATE_PROVENANCE_COMMIT",
      branch: effect.branch,
      rootIssue: effect.rootIssue,
      path: effect.path,
      createdCommitSha: "cccccccccccccccccccccccccccccccccccccccc",
    },
  });
  assert.deepEqual(git.calls, { blobs: 1, trees: 1, commits: 1, advances: 1, reads: 2 });
  const entry = git.state.entries[0];
  assert.notEqual(entry, undefined);
  const rendered = git.state.blobs.get(entry!.sha);
  assert.notEqual(rendered, undefined);
  assert.deepEqual(verifyChangeProvenanceRecord(rendered!, options.runtimeAuthority), {
    version: 1,
    rootIssue: 513,
    operation: "change.issue",
    actor: { type: "agent", name: "Luna" },
  });

  const second = await provenanceAdapter(transport, options).execute(effect);
  assert.deepEqual(second, first);
  assert.deepEqual(git.calls, { blobs: 1, trees: 1, commits: 1, advances: 1, reads: 3 });

  const tampered = JSON.parse(rendered!) as Record<string, unknown>;
  tampered.rootIssue = 514;
  git.state.blobs.set(entry!.sha, `${JSON.stringify(tampered)}\n`);
  const rejected = await provenanceAdapter(transport, options).execute(effect);
  assert.equal(rejected.status, "failed");
  assert.deepEqual(git.calls, { blobs: 1, trees: 1, commits: 1, advances: 1, reads: 4 });
});

test("CREATE_BRANCH reads the explicit base ref and creates the exact explicit branch ref", async () => {
  const effect = {
    kind: "CREATE_BRANCH",
    branch: "Feature/Exact_Name",
    baseBranch: "Release/Exact",
  } as const;
  const transport = new StubChangeEffectTransport([
    response(200, gitReference("refs/heads/Release/Exact")),
    response(201, gitReference("refs/heads/Feature/Exact_Name")),
  ]);

  const result = await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari/git/ref/heads/Release%2FExact",
    },
    {
      hostname: "github.com",
      method: "POST",
      path: "repos/acme/inari/git/refs",
      body: {
        ref: "refs/heads/Feature/Exact_Name",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: {
      kind: "CREATE_BRANCH",
      branch: effect.branch,
      baseBranch: effect.baseBranch,
      createdCommitSha: "0123456789abcdef0123456789abcdef01234567",
    },
  });
});

test("CREATE_PULL_REQUEST creates a separate Draft PR with Core-owned title/body", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "Feature/Exact_Name",
    baseBranch: "Release/Exact",
    rootIssue: 216,
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  } as const;
  const transport = new StubChangeEffectTransport([
    response(201, pullRequest(901, effect.branch, effect.baseBranch, true)),
  ]);

  const result = await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "POST",
      path: "repos/acme/inari/pulls",
      body: {
        head: effect.branch,
        base: effect.baseBranch,
        title: effect.title,
        body: effect.body,
        draft: true,
      },
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: {
      kind: "CREATE_PULL_REQUEST",
      branch: effect.branch,
      baseBranch: effect.baseBranch,
      rootIssue: effect.rootIssue,
      pullRequest: 901,
    },
  });
});

test("CREATE_PULL_REQUEST rejects an API response that reused the root Issue number", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "feat/216-separate-pr",
    baseBranch: "main",
    rootIssue: 216,
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  } as const;
  const result = await adapter(
    new StubChangeEffectTransport([response(201, pullRequest(216, effect.branch, effect.baseBranch, true))]),
  ).execute(effect);
  assert.equal(result.status, "failed");
});

test("MARK_PULL_REQUEST_READY uses GitHub's explicit ready-for-review mutation", async () => {
  const effect = { kind: "MARK_PULL_REQUEST_READY", pullRequest: 901 } as const;
  const transport = new StubChangeEffectTransport([
    response(200, readyPullRequest(901, true)),
    response(200, readyMutationResponse(901)),
  ]);

  const result = await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari/pulls/901",
    },
  ]);
  assert.deepEqual(transport.graphqlCalls, [
    {
      operationName: "PullRequestReadyForReview",
      query:
        "mutation PullRequestReadyForReview($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { pullRequest { id number state isDraft } } }",
      variables: { input: { pullRequestId: "MDExOlB1bGxSZXF1ZXN0OTA=" } },
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: { kind: "MARK_PULL_REQUEST_READY", pullRequest: 901 },
  });
});

test("MARK_PULL_REQUEST_READY fails closed for GitHub failures and malformed responses", async () => {
  const effect = { kind: "MARK_PULL_REQUEST_READY", pullRequest: 901 } as const;
  const apiFailure = await adapter(
    new StubChangeEffectTransport([
      response(200, readyPullRequest(901, true)),
      response(200, { errors: [{ message: "denied" }] }),
    ]),
  ).execute(effect);
  const malformedResponse = await adapter(
    new StubChangeEffectTransport([
      response(200, readyPullRequest(901, true)),
      response(200, readyMutationResponse(901, "other")),
    ]),
  ).execute(effect);

  assert.equal(apiFailure.status, "failed");
  assert.equal(malformedResponse.status, "failed");
  if (apiFailure.status !== "failed" || malformedResponse.status !== "failed") {
    throw new Error("expected failure results");
  }
  assert.deepEqual(apiFailure.failure, {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.MARK_PULL_REQUEST_READY,
    message: "The pull request ready effect failed.",
    reason: "response-validation",
  });
  assert.deepEqual(malformedResponse.failure, apiFailure.failure);
});

test("CLOSE_PULL_REQUEST maps to the explicit pull request and closed state", async () => {
  const effect = { kind: "CLOSE_PULL_REQUEST", pullRequest: 902 } as const;
  const transport = new StubChangeEffectTransport([
    response(200, pullRequest(902, "Feature/Exact_Name", "main", true, "closed")),
  ]);

  const result = await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "PATCH",
      path: "repos/acme/inari/pulls/902",
      body: { state: "closed" },
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: { kind: "CLOSE_PULL_REQUEST", pullRequest: 902 },
  });
});

test("DELETE_BRANCH is an explicit compensation execution boundary with no planning or extra reads", async () => {
  const effect = { kind: "DELETE_BRANCH", branch: "Feature/Exact_Name" } as const;
  const transport = new StubChangeEffectTransport([response(204)]);

  const result = await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "DELETE",
      path: "repos/acme/inari/git/refs/heads/Feature%2FExact_Name",
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: { kind: "DELETE_BRANCH", branch: effect.branch },
  });
});

test("SHA-conditional compensation uses an atomic provider primitive and never sends unconditional DELETE", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const effect = { kind: "DELETE_BRANCH", branch: "Feature/Exact_Name", expectedCommitSha: sha } as const;
  let primitiveCalls = 0;
  const transport = new StubChangeEffectTransport(
    [response(200, gitReference("refs/heads/Feature/Exact_Name", sha))],
    async (request) => {
      primitiveCalls += 1;
      assert.deepEqual(request, { branch: effect.branch, expectedCommitSha: sha });
      return "deleted";
    },
  );

  const result = await adapter(transport).execute(effect);

  assert.equal(result.status, "succeeded");
  assert.equal(primitiveCalls, 1);
  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "GET",
      path: "repos/acme/inari/git/ref/heads/Feature%2FExact_Name",
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: { kind: "DELETE_BRANCH", branch: effect.branch, expectedCommitSha: sha, outcome: "deleted" },
  });
});

test("SHA-conditional compensation classifies an observed generation mismatch and never invokes deletion", async () => {
  const expectedSha = "0123456789abcdef0123456789abcdef01234567";
  const observedSha = "fedcba9876543210fedcba9876543210fedcba98";
  const effect = { kind: "DELETE_BRANCH", branch: "Feature/Exact_Name", expectedCommitSha: expectedSha } as const;
  let primitiveCalls = 0;
  const result = await adapter(
    new StubChangeEffectTransport(
      [response(200, gitReference("refs/heads/Feature/Exact_Name", observedSha))],
      async () => {
        primitiveCalls += 1;
        return "deleted";
      },
    ),
  ).execute(effect);

  assert.deepEqual(result, {
    status: "failed",
    effect,
    failure: {
      effect,
      code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.DELETE_BRANCH,
      message: "The branch deletion effect failed.",
      reason: "generation-mismatch",
    },
  });
  assert.equal(primitiveCalls, 0);
});

test("SHA-conditional compensation treats absence as idempotent and refuses REST-only deletion", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const effect = { kind: "DELETE_BRANCH", branch: "Feature/Exact_Name", expectedCommitSha: sha } as const;
  const absent = await adapter(new StubChangeEffectTransport([response(404)])).execute(effect);
  assert.deepEqual(absent, {
    status: "succeeded",
    effect,
    evidence: { kind: "DELETE_BRANCH", branch: effect.branch, expectedCommitSha: sha, outcome: "absent" },
  });

  const restOnly = await adapter(
    new StubChangeEffectTransport([response(200, gitReference("refs/heads/Feature/Exact_Name", sha))]),
  ).execute(effect);
  assert.equal(restOnly.status, "failed");
});

test("a concurrent update is reported by compare-and-delete and cannot fall through to DELETE", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const effect = { kind: "DELETE_BRANCH", branch: "Feature/Exact_Name", expectedCommitSha: sha } as const;
  let primitiveCalls = 0;
  const transport = new StubChangeEffectTransport(
    [response(200, gitReference("refs/heads/Feature/Exact_Name", sha))],
    async () => {
      primitiveCalls += 1;
      return "mismatch";
    },
  );
  const result = await adapter(transport).execute(effect);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected conditional delete failure");
  assert.equal(result.failure.reason, "generation-mismatch");
  assert.equal(primitiveCalls, 1);
  assert.equal(
    transport.calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("the adapter validates an effect but never repairs or canonicalizes its values", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "FEATURE/Caller_Value",
    baseBranch: "Base/Caller_Value",
    rootIssue: 216,
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  } as const;
  const transport = new StubChangeEffectTransport([
    response(201, pullRequest(903, effect.branch, effect.baseBranch, true)),
  ]);

  await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls[0]?.body, {
    head: "FEATURE/Caller_Value",
    base: "Base/Caller_Value",
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  });

  const invalidTransport = new StubChangeEffectTransport([]);
  await assert.rejects(
    adapter(invalidTransport).execute({
      kind: "CREATE_PULL_REQUEST",
      branch: "FEATURE/Caller_Value",
      baseBranch: "Base/Caller_Value",
      rootIssue: 216,
      title: "Change #216",
      body: "Closes #216",
      draft: false,
    } as unknown as ChangeEffect),
    (error: unknown) => error instanceof GitHubChangeEffectContractError,
  );
  assert.equal(invalidTransport.calls.length, 0);

  const conversionTransport = new StubChangeEffectTransport([]);
  await assert.rejects(
    adapter(conversionTransport).execute({
      ...effect,
      issue: effect.rootIssue,
    } as unknown as ChangeEffect),
    (error: unknown) => error instanceof GitHubChangeEffectContractError,
  );
  assert.equal(conversionTransport.calls.length, 0);
});

test("API, transport, and response failures normalize to deterministic bounded evidence", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "Feature/Exact_Name",
    baseBranch: "main",
    rootIssue: 216,
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  } as const;
  const apiFailure = await adapter(
    new StubChangeEffectTransport([
      response(422, { message: "Authorization: Bearer api-secret", documentation_url: "https://secret.invalid" }),
    ]),
  ).execute(effect);
  const transportFailure = await adapter(
    new StubChangeEffectTransport([new Error("Authorization: Bearer transport-secret")]),
  ).execute(effect);
  const malformedResponse = await adapter(new StubChangeEffectTransport([response(201, { number: "903" })])).execute(
    effect,
  );

  assert.equal(apiFailure.status, "failed");
  if (apiFailure.status !== "failed") throw new Error("expected failure result");
  assert.deepEqual(apiFailure.failure, {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST,
    message: "The pull request creation effect failed.",
    reason: "provider-http",
    status: 422,
  });
  assert.equal(transportFailure.status, "failed");
  if (transportFailure.status !== "failed") throw new Error("expected transport failure result");
  assert.deepEqual(transportFailure.failure, {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST,
    message: "The pull request creation effect failed.",
    reason: "transport",
  });
  assert.equal(malformedResponse.status, "failed");
  if (malformedResponse.status !== "failed") throw new Error("expected malformed response failure result");
  assert.deepEqual(malformedResponse.failure, {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST,
    message: "The pull request creation effect failed.",
    reason: "response-validation",
  });
  assert.equal(JSON.stringify(apiFailure).includes("api-secret"), false);
  assert.equal(JSON.stringify(apiFailure).includes("transport-secret"), false);
  assert.equal(JSON.stringify(malformedResponse).includes("903"), false);
});

test("provider HTTP failures retain only recognized bounded GitHub validation detail", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "Feature/Exact_Name",
    baseBranch: "main",
    rootIssue: 216,
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  } as const;
  const recognized = await adapter(
    new StubChangeEffectTransport([
      response(422, {
        message: "Validation Failed; Bearer provider-secret",
        documentation_url: "https://provider.invalid/secret",
        errors: [
          {
            resource: "PullRequest",
            field: "head",
            code: "custom",
            message: "provider-controlled prose and secret",
          },
        ],
      }),
    ]),
  ).execute(effect);
  assert.equal(recognized.status, "failed");
  if (recognized.status !== "failed") throw new Error("expected failure result");
  assert.deepEqual(recognized.failure, {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST,
    message: "The pull request creation effect failed.",
    reason: "provider-http",
    status: 422,
    provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
  });
  assert.doesNotMatch(JSON.stringify(recognized), /provider-secret|provider\.invalid|provider-controlled/iu);

  const baseline = async (status: number, body: unknown) => {
    const result = await adapter(new StubChangeEffectTransport([response(status, body)])).execute(effect);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("expected failure result");
    assert.deepEqual(result.failure, {
      effect,
      code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST,
      message: "The pull request creation effect failed.",
      reason: "provider-http",
      status,
    });
    return result;
  };

  await baseline(422, { message: "free-form provider message" });
  await baseline(422, { errors: { resource: "PullRequest", field: "head", code: "custom" } });
  await baseline(422, {
    errors: [{ resource: "PullRequest", field: "head", code: "custom" }],
    message: "x".repeat(MAX_GITHUB_CHANGE_EFFECT_REJECTION_BODY_BYTES),
  });
  await baseline(404, { message: "Not Found" });
  await baseline(500, { message: "Internal Server Error", errors: [{ resource: "PullRequest", code: "custom" }] });
  await baseline(422, {
    errors: [{ resource: "PullRequest", field: 42, code: "custom", message: "unsafe shape" }],
  });
});

test("recognized status-only provider categories remain bounded", async () => {
  const effect = { kind: "DELETE_BRANCH", branch: "feature" } as const;
  for (const [status, category] of [
    [401, "authentication-failed"],
    [409, "conflict"],
    [429, "rate-limit"],
  ] as const) {
    const result = await adapter(new StubChangeEffectTransport([response(status)])).execute(effect);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("expected failure result");
    assert.equal(result.failure.reason, "provider-http");
    assert.equal(result.failure.status, status);
    assert.deepEqual(result.failure.provider, { category });
  }
});

test("a typed credential classification remains bounded when supplied by a credential transport", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "Feature/Exact_Name",
    baseBranch: "main",
    rootIssue: 216,
    title: "Change #216",
    body: "Closes #216",
    draft: true,
  } as const;
  const result = await adapter(
    new StubChangeEffectTransport([new GitHubChangeEffectFailureError({ reason: "credential" })]),
  ).execute(effect);

  assert.equal(result.status, "failed");
  if (result.status !== "failed") throw new Error("expected credential failure result");
  assert.equal(result.failure.reason, "credential");
  assert.equal(result.failure.code, GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST);
  assert.equal(JSON.stringify(result).includes("credential"), true);
  assert.doesNotMatch(JSON.stringify(result), /token|private.?key|authorization|provider.?body/iu);
});

test("malformed branch and unexpected delete responses fail closed", async () => {
  const malformedBranch = await adapter(
    new StubChangeEffectTransport([response(200, { ref: "refs/heads/main", object: { type: "tag", sha: "sha" } })]),
  ).execute({ kind: "CREATE_BRANCH", branch: "feature", baseBranch: "main" });
  const unexpectedDelete = await adapter(new StubChangeEffectTransport([response(204, { deleted: true })])).execute({
    kind: "DELETE_BRANCH",
    branch: "feature",
  });

  assert.equal(malformedBranch.status, "failed");
  assert.equal(unexpectedDelete.status, "failed");
});
