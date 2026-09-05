import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  ChangeRemoteExecutorError,
  changeRemoteMutationRequest,
  changeRemoteReadRequest,
} from "../change-executor.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import {
  createGitHubActionsChangeRemoteExecutor,
  INARI_CHANGE_EXECUTOR_REF,
  INARI_CHANGE_EXECUTOR_WORKFLOW,
  type GitHubActionsRemoteApi,
} from "./change-actions-remote-executor.js";
import type { RepositoryContext } from "./types.js";

const correlation = "123e4567-e89b-42d3-a456-426614174000";
const repository: RepositoryContext = {
  hostname: "github.com",
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  url: "https://github.com/acme/inari",
  repositoryId: "100000157",
};

function projection(): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence({
    change: { repositoryHost: "github.com", repositoryId: "100000157", rootIssue: 42 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "remote-change" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: 42, state: "open" } },
      branches: { status: "available", value: [{ name: "feat/42-remote-change" }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: 100,
            head: "feat/42-remote-change",
            base: "main",
            state: "open",
            draft: true,
            merged: false,
            provenance: { issuer: "app:inari-issuer" },
          },
        ],
      },
    },
  });
  assert.equal(result.valid, true);
  return result;
}

function archive(value: unknown): Uint8Array {
  const name = Buffer.from("result.json", "utf8");
  const content = Buffer.from(JSON.stringify(value), "utf8");
  const local = Buffer.alloc(30 + name.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  content.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, end]));
}

class FakeActionsApi implements GitHubActionsRemoteApi {
  readonly calls: Array<{ path: string; method: "GET" | "POST"; fields: Readonly<Record<string, string>> }> = [];
  readonly baselineRunId = 10;
  readonly resultRunId = 11;
  readonly resultArtifactId = 21;
  readonly result = projection();
  authenticatedUser = "octocat";
  authenticatedUserReads = 0;
  runState: "pending" | "success" | "failure" = "success";
  artifactMode: "valid" | "malformed" | "stale" | "ambiguous" | "missing" = "valid";
  archiveValue: unknown = { projection: this.result };
  private runReads = 0;

  async getRepositoryContext(): Promise<RepositoryContext> {
    return repository;
  }

  async getAuthenticatedUser(): Promise<string> {
    this.authenticatedUserReads += 1;
    return this.authenticatedUser;
  }

  async requestActionsApi(
    path: string,
    method: "GET" | "POST",
    fields: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    this.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      this.runReads += 1;
      if (this.runState === "pending" || this.runReads === 1) {
        return {
          workflow_runs: [
            {
              id: this.baselineRunId,
              status: "completed",
              conclusion: "success",
              event: "workflow_dispatch",
              head_branch: "main",
            },
          ],
        };
      }
      return {
        workflow_runs: [
          {
            id: this.resultRunId,
            status: "completed",
            conclusion: this.runState === "success" ? "success" : "failure",
            event: "workflow_dispatch",
            head_branch: "main",
          },
          { id: 12, status: "completed", conclusion: "success", event: "workflow_dispatch", head_branch: "main" },
          {
            id: this.baselineRunId,
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: "main",
          },
        ],
      };
    }
    if (path.startsWith("actions/artifacts?")) {
      if (this.artifactMode === "missing") return { artifacts: [] };
      const workflowRunId = this.artifactMode === "stale" ? this.baselineRunId : this.resultRunId;
      const artifacts = [
        {
          id: this.resultArtifactId,
          name: `inari-change-result-${correlation}`,
          expired: false,
          workflow_run: { id: workflowRunId },
        },
      ];
      if (this.artifactMode === "ambiguous")
        artifacts.push({
          id: 22,
          name: `inari-change-result-${correlation}`,
          expired: false,
          workflow_run: { id: this.resultRunId },
        });
      return { artifacts };
    }
    throw new Error(`unexpected API path ${path}`);
  }

  async requestRepositoryApi(path: string): Promise<{ readonly status: number; readonly body: unknown }> {
    if (path === "") return { status: 200, body: { id: "100000157", default_branch: "main" } };
    if (path === "issues/42") {
      return { status: 200, body: { number: 42, title: "feat: remote change", state: "open", body: null } };
    }
    if (path.startsWith("git/ref/heads/")) {
      return { status: 200, body: { ref: "refs/heads/feat/42-remote-change" } };
    }
    if (path.startsWith("pulls?")) {
      return {
        status: 200,
        body: [
          {
            number: 100,
            head: { ref: "feat/42-remote-change" },
            base: { ref: "main" },
            state: "open",
            draft: true,
            merged_at: null,
            user: { login: "inari-issuer[bot]" },
          },
        ],
      };
    }
    throw new Error(`unexpected repository path ${path}`);
  }

  async downloadActionsArtifact(artifactId: number): Promise<Uint8Array> {
    assert.equal(artifactId, this.resultArtifactId);
    if (this.artifactMode === "malformed") return new Uint8Array(Buffer.from("not-a-zip"));
    return archive(this.archiveValue);
  }
}

function executor(api: FakeActionsApi) {
  return createGitHubActionsChangeRemoteExecutor({
    cwd: process.cwd(),
    api,
    randomUUID: () => correlation,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    maxPollAttempts: 2,
  });
}

test("issue, ready, and abort dispatch the same semantic request through the trusted workflow", async () => {
  for (const operation of ["issue", "ready", "abort"] as const) {
    const api = new FakeActionsApi();
    const result = await executor(api).execute(changeRemoteMutationRequest(operation, 42));
    assert.deepEqual(result, { projection: api.result });
    const dispatch = api.calls.find((call) => call.method === "POST");
    assert.ok(dispatch);
    assert.equal(dispatch.path, `actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/dispatches`);
    assert.equal(dispatch.fields.ref, INARI_CHANGE_EXECUTOR_REF);
    assert.deepEqual(JSON.parse(dispatch.fields["inputs[request]"] ?? "{}"), {
      version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
      operation,
      issue: 42,
      requester: "github:octocat",
    });
    assert.equal(dispatch.fields["inputs[correlation]"], correlation);
    assert.doesNotMatch(JSON.stringify(dispatch.fields["inputs[request]"]), /workflow|token|privateKey|effect/iu);
  }
});

test("show uses the same remote boundary and does not request requester or issuer credentials", async () => {
  const api = new FakeActionsApi();
  const result = await executor(api).read(changeRemoteReadRequest(42));

  assert.deepEqual(result, api.result);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(api.authenticatedUserReads, 0);
});

test("auth and repository resolution failures are normalized without raw credentials", async () => {
  const authApi = new FakeActionsApi();
  authApi.getAuthenticatedUser = async () => {
    throw new Error("Bearer secret-token");
  };
  await assert.rejects(
    executor(authApi).execute(changeRemoteMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeRemoteExecutorError &&
      error.code === "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE" &&
      !error.message.includes("secret-token") &&
      !JSON.stringify(error).includes("secret-token"),
  );

  const resolutionApi = new FakeActionsApi();
  resolutionApi.getRepositoryContext = async () => {
    throw new Error("privateKey=secret");
  };
  await assert.rejects(
    executor(resolutionApi).read(changeRemoteReadRequest(42)),
    (error: unknown) =>
      error instanceof ChangeRemoteExecutorError && error.code === "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
  );
});

test("dispatch, run, ambiguous, stale, and malformed result failures fail closed", async () => {
  const dispatchApi = new FakeActionsApi();
  dispatchApi.requestActionsApi = async (path, method, fields = {}) => {
    dispatchApi.calls.push({ path, method, fields });
    if (method === "POST") throw new Error("token=secret");
    return { workflow_runs: [] };
  };
  await assert.rejects(
    executor(dispatchApi).execute(changeRemoteMutationRequest("issue", 42)),
    (error: unknown) => error instanceof ChangeRemoteExecutorError && error.code === "CHANGE_REMOTE_DISPATCH_FAILED",
  );

  const failedRunApi = new FakeActionsApi();
  failedRunApi.runState = "failure";
  await assert.rejects(
    executor(failedRunApi).execute(changeRemoteMutationRequest("issue", 42)),
    (error: unknown) => error instanceof ChangeRemoteExecutorError && error.code === "CHANGE_REMOTE_RUN_FAILED",
  );

  for (const artifactMode of ["ambiguous", "stale", "malformed"] as const) {
    const api = new FakeActionsApi();
    api.artifactMode = artifactMode;
    await assert.rejects(
      executor(api).execute(changeRemoteMutationRequest("issue", 42)),
      (error: unknown) =>
        error instanceof ChangeRemoteExecutorError &&
        (artifactMode === "malformed"
          ? error.code === "CHANGE_REMOTE_RESULT_INVALID"
          : error.code === "CHANGE_REMOTE_CORRELATION_FAILED"),
    );
  }
});

test("effect and workflow injection cannot enter the semantic dispatch request", async () => {
  const api = new FakeActionsApi();
  const request = {
    ...changeRemoteMutationRequest("issue", 42, "agent:tester"),
    workflow: "evil.yml",
    ref: "refs/heads/evil",
    effect: { kind: "create-branch" },
    token: "secret",
  } as unknown as Parameters<GitHubActionsRemoteApi["requestActionsApi"]>;
  await executor(api).execute(request as never);
  const dispatch = api.calls.find((call) => call.method === "POST");
  assert.ok(dispatch);
  assert.deepEqual(JSON.parse(dispatch.fields["inputs[request]"] ?? "{}"), {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation: "issue",
    issue: 42,
    requester: "agent:tester",
  });
});

test("untrusted execution envelope fields are rejected before crossing the remote boundary", async () => {
  const api = new FakeActionsApi();
  api.archiveValue = { projection: api.result, token: "secret", effect: { kind: "CREATE_BRANCH" } };
  await assert.rejects(
    executor(api).execute(changeRemoteMutationRequest("issue", 42)),
    (error: unknown) => error instanceof ChangeRemoteExecutorError && error.code === "CHANGE_REMOTE_RESULT_INVALID",
  );
});
