import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITHUB_CHANGE_EFFECT_FAILURE_CODES,
  GitHubChangeEffectAdapter,
  GitHubChangeEffectContractError,
  type GitHubChangeEffectRequest,
  type GitHubChangeEffectResponse,
  type GitHubChangeEffectTransport,
} from "./index.js";
import type { ChangeEffect } from "../change.js";

type StubResponse = GitHubChangeEffectResponse | Error;

class StubChangeEffectTransport implements GitHubChangeEffectTransport {
  readonly calls: GitHubChangeEffectRequest[] = [];
  private readonly responses: StubResponse[];

  constructor(responses: StubResponse[]) {
    this.responses = [...responses];
  }

  async request(request: GitHubChangeEffectRequest): Promise<GitHubChangeEffectResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("unexpected transport call");
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

function adapter(transport: GitHubChangeEffectTransport): GitHubChangeEffectAdapter {
  return new GitHubChangeEffectAdapter({ repository, transport });
}

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
    evidence: { kind: "CREATE_BRANCH", branch: effect.branch, baseBranch: effect.baseBranch },
  });
});

test("CREATE_PULL_REQUEST maps rootIssue to GitHub's issue conversion field without inventing title or body", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "Feature/Exact_Name",
    baseBranch: "Release/Exact",
    rootIssue: 216,
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
        issue: effect.rootIssue,
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

test("MARK_PULL_REQUEST_READY maps to the explicit pull request and draft false", async () => {
  const effect = { kind: "MARK_PULL_REQUEST_READY", pullRequest: 901 } as const;
  const transport = new StubChangeEffectTransport([
    response(200, pullRequest(901, "Feature/Exact_Name", "main", false)),
  ]);

  const result = await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls, [
    {
      hostname: "github.com",
      method: "PATCH",
      path: "repos/acme/inari/pulls/901",
      body: { draft: false },
    },
  ]);
  assert.deepEqual(result, {
    status: "succeeded",
    effect,
    evidence: { kind: "MARK_PULL_REQUEST_READY", pullRequest: 901 },
  });
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

test("the adapter validates an effect but never repairs or canonicalizes its values", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "FEATURE/Caller_Value",
    baseBranch: "Base/Caller_Value",
    rootIssue: 216,
    draft: true,
  } as const;
  const transport = new StubChangeEffectTransport([
    response(201, pullRequest(903, effect.branch, effect.baseBranch, true)),
  ]);

  await adapter(transport).execute(effect);

  assert.deepEqual(transport.calls[0]?.body, {
    head: "FEATURE/Caller_Value",
    base: "Base/Caller_Value",
    issue: 216,
    draft: true,
  });

  const invalidTransport = new StubChangeEffectTransport([]);
  await assert.rejects(
    adapter(invalidTransport).execute({
      kind: "CREATE_PULL_REQUEST",
      branch: "FEATURE/Caller_Value",
      baseBranch: "Base/Caller_Value",
      rootIssue: 216,
      draft: false,
    } as unknown as ChangeEffect),
    (error: unknown) => error instanceof GitHubChangeEffectContractError,
  );
  assert.equal(invalidTransport.calls.length, 0);
});

test("API, transport, and response failures normalize to deterministic bounded evidence", async () => {
  const effect = {
    kind: "CREATE_PULL_REQUEST",
    branch: "Feature/Exact_Name",
    baseBranch: "main",
    rootIssue: 216,
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

  assert.deepEqual(apiFailure, transportFailure);
  assert.equal(apiFailure.status, "failed");
  if (apiFailure.status !== "failed") throw new Error("expected failure result");
  assert.deepEqual(apiFailure.failure, {
    effect,
    code: GITHUB_CHANGE_EFFECT_FAILURE_CODES.CREATE_PULL_REQUEST,
    message: "The pull request creation effect failed.",
  });
  assert.equal(malformedResponse.status, "failed");
  assert.equal(JSON.stringify(apiFailure).includes("api-secret"), false);
  assert.equal(JSON.stringify(apiFailure).includes("transport-secret"), false);
  assert.equal(JSON.stringify(malformedResponse).includes("903"), false);
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
