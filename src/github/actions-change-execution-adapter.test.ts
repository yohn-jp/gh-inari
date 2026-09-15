import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  ChangeExecutionPortError,
  changeMutationRequest,
  changeReadRequest,
} from "../change-execution-port.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import {
  createActionsChangeExecutionAdapter,
  INARI_CHANGE_EXECUTOR_REF,
  INARI_CHANGE_EXECUTOR_WORKFLOW,
  type GitHubActionsRemoteApi,
} from "./actions-change-execution-adapter.js";
import type { RepositoryContext, RepositoryTree } from "./types.js";
import { createChangeProvenanceRecord } from "../change-provenance-record.js";
import { assertRuntimeAuthority } from "../agent-authority/runtime-authority.js";
import { generateRuntimeAuthorityKeyPair } from "../agent-authority/runtime-key.js";

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

function recoveryProjection(): ChangeProjectionResult {
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
            state: "closed",
            draft: false,
            merged: false,
            provenance: { issuer: "app:inari-issuer" },
          },
        ],
      },
    },
  });
  assert.equal(result.valid, false);
  assert.equal(result.status, "partial");
  assert.equal(result.change?.state, "RECOVERY_REQUIRED");
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

function branchPolicySource(pattern: string): string {
  return ["version: 1", "sections: []", "branch:", `  pattern: \"${pattern}\"`, ""].join("\n");
}

class FakeActionsApi implements GitHubActionsRemoteApi {
  readonly calls: Array<{ path: string; method: "GET" | "POST"; fields: Readonly<Record<string, string>> }> = [];
  readonly baselineRunId = 10;
  readonly resultRunId = 11;
  readonly resultArtifactId = 21;
  readonly result = projection();
  runState: "pending" | "success" | "failure" = "success";
  artifactMode: "valid" | "malformed" | "stale" | "ambiguous" | "missing" = "valid";
  archiveValue: unknown = { projection: this.result };
  governanceTree: RepositoryTree = { sha: "remote-governance-generation", entries: [] };
  governanceBlobs = new Map<string, string>();
  governanceReads = 0;
  governanceUnavailable = false;
  private runReads = 0;

  async getRepositoryContext(): Promise<RepositoryContext> {
    return repository;
  }

  async getRepositoryDefaultBranch(): Promise<string> {
    this.governanceReads += 1;
    if (this.governanceUnavailable) throw new Error("remote governance unavailable");
    return "main";
  }

  async getRepositoryTree(ref: string): Promise<RepositoryTree> {
    assert.equal(ref, "main");
    this.governanceReads += 1;
    if (this.governanceUnavailable) throw new Error("remote governance unavailable");
    return this.governanceTree;
  }

  async getRepositoryBlob(sha: string): Promise<string> {
    this.governanceReads += 1;
    if (this.governanceUnavailable) throw new Error("remote governance unavailable");
    const source = this.governanceBlobs.get(sha);
    if (source === undefined) throw new Error(`unknown governance blob ${sha}`);
    return source;
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
    if (path.startsWith("git/matching-refs/heads/")) {
      return { status: 200, body: [] };
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

function executor(api: FakeActionsApi, cwd = process.cwd(), maxPollAttempts = 2) {
  return createActionsChangeExecutionAdapter({
    cwd,
    api,
    randomUUID: () => correlation,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    maxPollAttempts,
  });
}

test("issue, ready, and abort dispatch the same semantic request through the trusted workflow", async () => {
  for (const operation of ["issue", "ready", "abort"] as const) {
    const api = new FakeActionsApi();
    const result = await executor(api).execute(changeMutationRequest(operation, 42));
    assert.deepEqual(result, { projection: api.result });
    const dispatch = api.calls.find((call) => call.method === "POST");
    assert.ok(dispatch);
    assert.equal(dispatch.path, `actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/dispatches`);
    assert.equal(dispatch.fields.ref, INARI_CHANGE_EXECUTOR_REF);
    assert.deepEqual(JSON.parse(dispatch.fields["inputs[request]"] ?? "{}"), {
      version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
      operation,
      issue: 42,
    });
    assert.equal(dispatch.fields["inputs[correlation]"], correlation);
    assert.doesNotMatch(JSON.stringify(dispatch.fields["inputs[request]"]), /workflow|token|privateKey|effect/iu);
  }
});

test("caller-produced signed provenance crosses the bounded Actions request unchanged", async () => {
  const key = generateRuntimeAuthorityKeyPair();
  const authority = assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "runtime-actions-transport",
    key: key.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  const signedRecord = createChangeProvenanceRecord({
    rootIssue: 42,
    runtimeAuthority: authority,
    runtimeKey: key,
    now: new Date("2026-09-13T00:00:00Z"),
  });
  const api = new FakeActionsApi();
  await executor(api).execute(changeMutationRequest("issue", 42, undefined, signedRecord));
  const dispatch = api.calls.find((call) => call.method === "POST");
  assert.ok(dispatch);
  const dispatched = JSON.parse(dispatch.fields["inputs[request]"] ?? "{}") as Record<string, unknown>;
  assert.deepEqual(dispatched.signedProvenanceRecord, signedRecord);
  assert.equal((dispatched.signedProvenanceRecord as { signature: { kid: string } }).signature.kid, authority.id);
});

test("show uses the same remote boundary and does not request requester or issuer credentials", async () => {
  const api = new FakeActionsApi();
  const result = await executor(api).read(changeReadRequest(42));

  assert.deepEqual(result, api.result);
  assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
});

test("show derives branch governance from the target default-branch generation, ignoring foreign local policy", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gh-inari-change-show-"));
  try {
    const localPolicy = path.join(cwd, ".github/inari/pr-policy.yml");
    await mkdir(path.dirname(localPolicy), { recursive: true });
    await writeFile(localPolicy, branchPolicySource("^fix/[0-9]+-[a-z0-9-]+$"), "utf8");

    const api = new FakeActionsApi();
    api.governanceTree = {
      sha: "target-governance-generation",
      entries: [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: "target-policy-sha" }],
    };
    api.governanceBlobs.set("target-policy-sha", branchPolicySource("^feat/[0-9]+-[a-z0-9-]+$"));

    const result = await executor(api, cwd).read(changeReadRequest(42));
    assert.deepEqual(result, api.result);
    assert.equal(api.governanceReads, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("show remains remote-authoritative when the local checkout matches the target policy", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gh-inari-change-show-"));
  try {
    const policy = branchPolicySource("^feat/[0-9]+-[a-z0-9-]+$");
    const localPolicy = path.join(cwd, ".github/inari/pr-policy.yml");
    await mkdir(path.dirname(localPolicy), { recursive: true });
    await writeFile(localPolicy, policy, "utf8");

    const api = new FakeActionsApi();
    api.governanceTree = {
      sha: "matching-governance-generation",
      entries: [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: "matching-policy-sha" }],
    };
    api.governanceBlobs.set("matching-policy-sha", policy);

    assert.deepEqual(await executor(api, cwd).read(changeReadRequest(42)), api.result);
    // Matching local content is not reused; the authoritative target generation
    // is still read through the repository governance primitives.
    assert.equal(api.governanceReads, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("show distinguishes a target repository with no branch policy from unavailable remote governance", async () => {
  const noPolicyApi = new FakeActionsApi();
  const noPolicyCwd = await mkdtemp(path.join(os.tmpdir(), "gh-inari-change-show-"));
  try {
    const localPolicy = path.join(noPolicyCwd, ".github/inari/pr-policy.yml");
    await mkdir(path.dirname(localPolicy), { recursive: true });
    await writeFile(localPolicy, branchPolicySource("^fix/[0-9]+-[a-z0-9-]+$"), "utf8");
    assert.deepEqual(await executor(noPolicyApi, noPolicyCwd).read(changeReadRequest(42)), noPolicyApi.result);

    const unavailableApi = new FakeActionsApi();
    unavailableApi.governanceUnavailable = true;
    await assert.rejects(
      executor(unavailableApi).read(changeReadRequest(42)),
      (error: unknown) =>
        error instanceof ChangeExecutionPortError &&
        error.code === "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE" &&
        JSON.stringify(error.details) ===
          JSON.stringify({ operation: "change.show", reason: "remote-governance-unavailable" }),
    );
  } finally {
    await rm(noPolicyCwd, { recursive: true, force: true });
  }
});

test("waits through queued and in-progress executor runs before accepting the completed result", async () => {
  const api = new FakeActionsApi();
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  let workflowReads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/workflows/")) {
      workflowReads += 1;
      const run =
        workflowReads === 1
          ? { id: api.baselineRunId, status: "completed", conclusion: "success" }
          : workflowReads === 2
            ? { id: api.resultRunId, status: "queued", conclusion: null }
            : workflowReads === 3
              ? { id: api.resultRunId, status: "in_progress", conclusion: null }
              : { id: api.resultRunId, status: "completed", conclusion: "success" };
      api.calls.push({ path, method, fields });
      return {
        workflow_runs: [
          { ...run, event: "workflow_dispatch", head_branch: "main" },
          ...(run.id === api.resultRunId
            ? [
                {
                  id: api.baselineRunId,
                  status: "completed",
                  conclusion: "success",
                  event: "workflow_dispatch",
                  head_branch: "main",
                },
              ]
            : []),
        ],
      };
    }
    return originalRequestActionsApi(path, method, fields);
  };

  const result = await executor(api, process.cwd(), 3).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.equal(workflowReads, 4);
});

test("retries one transient run or artifact poll failure before observing success", async () => {
  for (const failureTarget of ["runs", "artifacts"] as const) {
    const api = new FakeActionsApi();
    const originalRequestActionsApi = api.requestActionsApi.bind(api);
    let workflowReads = 0;
    let artifactReads = 0;
    let failed = false;
    api.requestActionsApi = async (path, method, fields = {}) => {
      if (method === "GET" && path.startsWith("actions/workflows/")) {
        workflowReads += 1;
        if (failureTarget === "runs" && workflowReads === 2 && !failed) {
          failed = true;
          throw new Error("transient Actions run lookup failure");
        }
      }
      if (method === "GET" && path.startsWith("actions/artifacts?")) {
        artifactReads += 1;
        if (failureTarget === "artifacts" && artifactReads === 1 && !failed) {
          failed = true;
          throw new Error("transient Actions artifact lookup failure");
        }
      }
      return originalRequestActionsApi(path, method, fields);
    };

    const result = await executor(api).execute(changeMutationRequest("issue", 42));

    assert.deepEqual(result, { projection: api.result });
    assert.equal(failed, true);
  }
});

test("preserves the bounded result-timeout failure when no executor run becomes observable", async () => {
  const api = new FakeActionsApi();
  api.runState = "pending";

  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) === JSON.stringify({ operation: "change.issue", reason: "result-timeout" }),
  );
});

test("requester authentication is not consulted and repository resolution failures are normalized", async () => {
  const authApi = new FakeActionsApi();
  assert.deepEqual(await executor(authApi).execute(changeMutationRequest("issue", 42)), { projection: authApi.result });

  const resolutionApi = new FakeActionsApi();
  resolutionApi.getRepositoryContext = async () => {
    throw new Error("privateKey=secret");
  };
  await assert.rejects(
    executor(resolutionApi).read(changeReadRequest(42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError && error.code === "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
  );
});

test("dispatch, run, missing, ambiguous, stale, and malformed result failures fail closed", async () => {
  const dispatchApi = new FakeActionsApi();
  dispatchApi.requestActionsApi = async (path, method, fields = {}) => {
    dispatchApi.calls.push({ path, method, fields });
    if (method === "POST") throw new Error("token=secret");
    return { workflow_runs: [] };
  };
  await assert.rejects(
    executor(dispatchApi).execute(changeMutationRequest("issue", 42)),
    (error: unknown) => error instanceof ChangeExecutionPortError && error.code === "CHANGE_REMOTE_DISPATCH_FAILED",
  );

  const failedRunApi = new FakeActionsApi();
  failedRunApi.runState = "failure";
  failedRunApi.artifactMode = "missing";
  await assert.rejects(
    executor(failedRunApi).execute(changeMutationRequest("issue", 42)),
    (error: unknown) => error instanceof ChangeExecutionPortError && error.code === "CHANGE_REMOTE_RUN_FAILED",
  );

  for (const artifactMode of ["ambiguous", "stale", "malformed"] as const) {
    const api = new FakeActionsApi();
    api.artifactMode = artifactMode;
    await assert.rejects(
      executor(api).execute(changeMutationRequest("issue", 42)),
      (error: unknown) =>
        error instanceof ChangeExecutionPortError &&
        (artifactMode === "malformed"
          ? error.code === "CHANGE_REMOTE_RESULT_INVALID"
          : error.code === "CHANGE_REMOTE_CORRELATION_FAILED"),
    );
  }
});

test("a valid semantic recovery result remains authoritative over a failed workflow conclusion", async () => {
  const api = new FakeActionsApi();
  api.runState = "failure";
  const expectedProjection = recoveryProjection();
  const expectedEvidence = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "issue",
    outcome: "recovery-required",
    effects: [
      { kind: "CREATE_BRANCH", status: "succeeded", createdCommitSha: "a".repeat(40) },
      { kind: "CREATE_PULL_REQUEST", status: "failed" },
    ],
    compensation: "failed",
    failure: {
      kind: "CREATE_PULL_REQUEST",
      code: "CHANGE_EFFECT_FAILED",
      message: "The pull request effect failed.",
    },
  } as const;
  api.archiveValue = { projection: expectedProjection, evidence: expectedEvidence };

  const result = await executor(api).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: expectedProjection, evidence: expectedEvidence });
  assert.equal(result.projection.change?.state, "RECOVERY_REQUIRED");
  assert.equal(result.evidence?.outcome, "recovery-required");
});

test("workflow failure artifacts preserve only an enumerated diagnostic stage", async () => {
  const api = new FakeActionsApi();
  api.archiveValue = {
    ok: false,
    error: {
      code: "CHANGE_ACTIONS_RUNTIME_INVALID",
      message: "Bearer installation-secret-token /private/provider/path",
      details: { stage: "installation-token" },
    },
  };
  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "workflow-failed", stage: "installation-token" }) &&
      !JSON.stringify(error).includes("installation-secret-token") &&
      !JSON.stringify(error).includes("/private/provider/path"),
  );
});

test("unknown or malformed workflow diagnostic stages remain fail closed", async () => {
  for (const details of [
    { stage: "provider-specific" },
    { stage: "installation-token", token: "secret" },
    { stage: "repository-evidence", reason: "provider-specific-reason" },
    { stage: "projection-execution", trustedCode: "provider-specific-code" },
    {
      stage: "projection-execution",
      effectFailure: { reason: "provider-http", status: 422, rawBody: "provider-secret" },
    },
    {
      stage: "projection-execution",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_PARTIAL",
          path: "$.projection",
          message: "unknown diagnostic property",
          extra: true,
        },
      ],
    },
    {
      stage: "projection-execution",
      diagnostics: [
        {
          version: 1,
          code: "CHANGE_PROJECTION_PARTIAL",
          path: "$.projection",
          message: "Bearer raw-secret-token /private/provider/body",
        },
      ],
    },
    {
      stage: "projection-execution",
      diagnostics: Array.from({ length: 33 }, () => ({
        version: 1,
        code: "CHANGE_PROJECTION_PARTIAL",
        path: "$.projection",
        message: "bounded diagnostic",
      })),
    },
  ]) {
    const api = new FakeActionsApi();
    api.archiveValue = {
      ok: false,
      error: { code: "CHANGE_ACTIONS_RUNTIME_INVALID", message: "failure", details },
    };
    await assert.rejects(
      executor(api).execute(changeMutationRequest("issue", 42)),
      (error: unknown) => error instanceof ChangeExecutionPortError && error.code === "CHANGE_REMOTE_RESULT_INVALID",
    );
  }
});

test("workflow failure artifacts preserve the bounded repository-evidence reason", async () => {
  const api = new FakeActionsApi();
  api.archiveValue = {
    ok: false,
    error: {
      code: "CHANGE_ACTIONS_RUNTIME_INVALID",
      message: "Bearer repo-secret-token /private/provider/path",
      details: { stage: "repository-evidence", reason: "repository-fork" },
    },
  };
  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          operation: "change.issue",
          reason: "workflow-failed",
          stage: "repository-evidence",
          stageReason: "repository-fork",
        }) &&
      !JSON.stringify(error).includes("repo-secret-token") &&
      !JSON.stringify(error).includes("/private/provider/path"),
  );
});

test("workflow failure artifacts preserve trusted code, Core diagnostics, and bounded evidence", async () => {
  const api = new FakeActionsApi();
  api.archiveValue = {
    ok: false,
    error: {
      code: "CHANGE_ACTIONS_RUNTIME_INVALID",
      message: "raw provider body Bearer installation-secret-token /private/provider/path",
      details: {
        stage: "projection-execution",
        trustedCode: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        diagnostics: [
          {
            version: 1,
            code: "CHANGE_PROVENANCE_CONFLICT",
            path: "$.projection.change.provenance",
            message: "The trusted Change provenance is inconsistent.",
          },
        ],
        evidence: {
          version: 1,
          operation: "issue",
          outcome: "recovery-required",
          effects: [],
          compensation: "failed",
          failure: {
            kind: "CREATE_PULL_REQUEST",
            code: "PULL_REQUEST_CREATE_FAILED",
            message: "The pull request creation effect failed.",
            reason: "provider-http",
            status: 422,
            provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
          },
        },
      },
    },
  };
  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          operation: "change.issue",
          reason: "workflow-failed",
          stage: "projection-execution",
          trustedCode: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
          evidence: {
            version: 1,
            operation: "issue",
            outcome: "recovery-required",
            effects: [],
            compensation: "failed",
            failure: {
              kind: "CREATE_PULL_REQUEST",
              code: "PULL_REQUEST_CREATE_FAILED",
              message: "The pull request creation effect failed.",
              reason: "provider-http",
              status: 422,
              provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
            },
          },
        }) &&
      JSON.stringify(error.diagnostics) ===
        JSON.stringify([
          {
            version: 1,
            code: "CHANGE_PROVENANCE_CONFLICT",
            path: "$.projection.change.provenance",
            message: "The trusted Change provenance is inconsistent.",
          },
        ]) &&
      !JSON.stringify(error).includes("installation-secret-token") &&
      !JSON.stringify(error).includes("/private/provider/path"),
  );
});

test("effect and workflow injection cannot enter the semantic dispatch request", async () => {
  const api = new FakeActionsApi();
  const request = {
    ...changeMutationRequest("issue", 42),
    workflow: "evil.yml",
    ref: "refs/heads/evil",
    effect: { kind: "create-branch" },
    token: "secret",
  } as unknown as Parameters<GitHubActionsRemoteApi["requestActionsApi"]>;
  await executor(api).execute(request as never);
  const dispatch = api.calls.find((call) => call.method === "POST");
  assert.ok(dispatch);
  assert.deepEqual(JSON.parse(dispatch.fields["inputs[request]"] ?? "{}"), {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "issue",
    issue: 42,
  });
});

test("requester injection is rejected before crossing the Actions boundary", async () => {
  const api = new FakeActionsApi();
  const request = {
    ...changeMutationRequest("issue", 42),
    requester: "agent:tester",
  } as never;
  await assert.rejects(
    executor(api).execute(request),
    (error: unknown) => error instanceof ChangeExecutionPortError && error.code === "CHANGE_REMOTE_REQUEST_INVALID",
  );
  assert.equal(
    api.calls.some((call) => call.method === "POST"),
    false,
  );
});

test("untrusted execution envelope fields are rejected before crossing the remote boundary", async () => {
  const api = new FakeActionsApi();
  api.archiveValue = { projection: api.result, token: "secret", effect: { kind: "CREATE_BRANCH" } };
  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) => error instanceof ChangeExecutionPortError && error.code === "CHANGE_REMOTE_RESULT_INVALID",
  );
});
