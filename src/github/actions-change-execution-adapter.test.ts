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
  type ChangeExecutionDeadline,
} from "../change-execution-port.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import {
  ActionsChangeExecutionAdapter,
  ActionsChangeExecutionNativeHttpApi,
  createActionsChangeExecutionAdapter,
  INARI_CHANGE_EXECUTOR_REF,
  INARI_CHANGE_EXECUTOR_WORKFLOW,
  type GitHubActionsRemoteApi,
} from "./actions-change-execution-adapter.js";
import { GitHubAuthenticationError } from "./errors.js";
import type { RepositoryContext, RepositoryTree } from "./types.js";
import { createChangeProvenanceRecord } from "../change-provenance-record.js";
import { assertRuntimeAuthority } from "../agent-authority/runtime-authority.js";
import { generateRuntimeAuthorityKeyPair } from "../agent-authority/runtime-key.js";

const correlation = "123e4567-e89b-42d3-a456-426614174000";
const unrelatedCorrelation = "00000000-0000-4000-8000-000000000001";
const otherUnrelatedCorrelation = "00000000-0000-4000-8000-000000000002";

function runDisplayTitle(runCorrelation: string): string {
  return `Inari Change ${runCorrelation}`;
}
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

function nativeJsonResponse(value: unknown, status = 200): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: value === undefined ? {} : { "content-type": "application/json" },
  });
}

function branchPolicySource(pattern: string): string {
  return ["version: 1", "sections: []", "branch:", `  pattern: \"${pattern}\"`, ""].join("\n");
}

class FakeActionsApi implements GitHubActionsRemoteApi {
  readonly calls: Array<{ path: string; method: "GET" | "POST"; fields: Readonly<Record<string, string>> }> = [];
  readonly deadlines: Array<ChangeExecutionDeadline | undefined> = [];
  readonly baselineRunId = 10;
  readonly resultRunId = 11;
  readonly resultArtifactId = 21;
  readonly result = projection();
  artifactDownloads = 0;
  runState: "pending" | "success" | "failure" = "success";
  artifactMode: "valid" | "malformed" | "stale" | "ambiguous" | "missing" = "valid";
  archiveValue: unknown = { projection: this.result };
  governanceTree: RepositoryTree = { sha: "remote-governance-generation", entries: [] };
  governanceBlobs = new Map<string, string>();
  governanceReads = 0;
  governanceUnavailable = false;
  private runReads = 0;

  async getRepositoryContext(deadline?: ChangeExecutionDeadline): Promise<RepositoryContext> {
    this.deadlines.push(deadline);
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
    deadline?: ChangeExecutionDeadline,
  ): Promise<unknown> {
    this.deadlines.push(deadline);
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
              display_title: runDisplayTitle(unrelatedCorrelation),
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
            display_title: runDisplayTitle(correlation),
          },
          {
            id: 12,
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: "main",
            display_title: runDisplayTitle(otherUnrelatedCorrelation),
          },
          {
            id: this.baselineRunId,
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: "main",
            display_title: runDisplayTitle(unrelatedCorrelation),
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

  async downloadActionsArtifact(artifactId: number, deadline?: ChangeExecutionDeadline): Promise<Uint8Array> {
    this.deadlines.push(deadline);
    this.artifactDownloads += 1;
    assert.equal(artifactId, this.resultArtifactId);
    if (this.artifactMode === "malformed") return new Uint8Array(Buffer.from("not-a-zip"));
    return archive(this.archiveValue);
  }
}

function executor(
  api: FakeActionsApi,
  cwd = process.cwd(),
  maxPollAttempts = 2,
  extra: { maxWaitMs?: number; now?: () => number; pollIntervalMs?: number; sleep?: () => Promise<void> } = {},
) {
  return createActionsChangeExecutionAdapter({
    cwd,
    api,
    randomUUID: () => correlation,
    pollIntervalMs: extra.pollIntervalMs ?? 0,
    sleep: extra.sleep ?? (async () => undefined),
    maxPollAttempts,
    ...(extra.maxWaitMs === undefined ? {} : { maxWaitMs: extra.maxWaitMs }),
    ...(extra.now === undefined ? {} : { now: extra.now }),
  });
}

test("Actions transport accepts no repository projection API and delegates reads", async () => {
  const source = new FakeActionsApi();
  const transport: GitHubActionsRemoteApi = {
    getRepositoryContext: source.getRepositoryContext.bind(source),
    requestActionsApi: source.requestActionsApi.bind(source),
    downloadActionsArtifact: source.downloadActionsArtifact.bind(source),
  };
  const adapter = new ActionsChangeExecutionAdapter({
    cwd: process.cwd(),
    api: transport,
    read: { read: async () => source.result },
    randomUUID: () => correlation,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    maxPollAttempts: 2,
  });

  assert.deepEqual(await adapter.read(changeReadRequest(42)), source.result);
  assert.deepEqual(await adapter.execute(changeMutationRequest("issue", 42)), { projection: source.result });
});

test("default Actions transport uses native HTTP for dispatch, runs, artifacts, and binary download", async () => {
  const requests: Array<{ readonly url: string; readonly method: string; readonly body?: unknown }> = [];
  let runReads = 0;
  let dispatchBody: unknown;
  const nativeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });
    const parsed = new URL(url);
    if (parsed.pathname === "/repos/acme/inari" && method === "GET") {
      return nativeJsonResponse({ id: 100000157, fork: false, default_branch: "main" });
    }
    if (parsed.pathname.endsWith(`/actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/runs`)) {
      runReads += 1;
      return nativeJsonResponse({
        workflow_runs:
          runReads === 1
            ? [
                {
                  id: 10,
                  status: "completed",
                  conclusion: "success",
                  event: "workflow_dispatch",
                  head_branch: "main",
                  display_title: runDisplayTitle(unrelatedCorrelation),
                },
              ]
            : [
                {
                  id: 11,
                  status: "completed",
                  conclusion: "success",
                  event: "workflow_dispatch",
                  head_branch: "main",
                  display_title: runDisplayTitle(correlation),
                },
              ],
      });
    }
    if (parsed.pathname.endsWith(`/actions/workflows/${INARI_CHANGE_EXECUTOR_WORKFLOW}/dispatches`)) {
      dispatchBody = body;
      return nativeJsonResponse(undefined, 204);
    }
    if (parsed.pathname.endsWith("/actions/runs/11/jobs")) {
      return nativeJsonResponse({
        total_count: 1,
        jobs: [{ id: 31, run_id: 11, status: "completed", conclusion: "success" }],
      });
    }
    if (parsed.pathname.endsWith("/actions/artifacts") && method === "GET") {
      return nativeJsonResponse({
        artifacts: [
          {
            id: 21,
            name: `inari-change-result-${correlation}`,
            expired: false,
            workflow_run: { id: 11, repository_id: 100000157 },
          },
        ],
      });
    }
    if (parsed.pathname.endsWith("/actions/artifacts/21/zip") && method === "GET") {
      return new Response(Buffer.from(archive({ projection: projection() })), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`unexpected native URL ${url}`);
  };
  const adapter = new ActionsChangeExecutionAdapter({
    cwd: process.cwd(),
    repository: "acme/inari",
    token: "actions-transport-secret",
    fetch: nativeFetch,
    read: { read: async () => projection() },
    randomUUID: () => correlation,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    maxPollAttempts: 2,
  });

  const result = await adapter.execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: projection() });
  assert.equal(
    requests.some((request) => request.url.startsWith("gh ")),
    false,
  );
  assert.equal(
    requests.some((request) => request.url.endsWith("/user")),
    false,
  );
  assert.deepEqual(dispatchBody, {
    ref: INARI_CHANGE_EXECUTOR_REF,
    inputs: {
      request: JSON.stringify({ version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION, operation: "issue", issue: 42 }),
      correlation,
    },
  });
  assert.doesNotMatch(JSON.stringify(dispatchBody), /actions-transport-secret|requester|token/iu);
  assert.ok(requests.some((request) => request.url.includes("/actions/workflows/")));
  assert.ok(requests.some((request) => request.url.includes("/actions/artifacts")));
  assert.ok(requests.some((request) => request.url.endsWith("/actions/artifacts/21/zip")));
});

test("native Actions transport errors remain bounded and never expose the credential", async () => {
  const secret = "actions-transport-secret";
  const nativeFetch: typeof fetch = async () => {
    throw new Error(`provider failed while sending Bearer ${secret}`);
  };
  const adapter = new ActionsChangeExecutionAdapter({
    cwd: process.cwd(),
    repository: "acme/inari",
    token: secret,
    fetch: nativeFetch,
    read: { read: async () => projection() },
    randomUUID: () => correlation,
    maxPollAttempts: 1,
    pollIntervalMs: 0,
    sleep: async () => undefined,
  });

  await assert.rejects(adapter.execute(changeMutationRequest("issue", 42)), (error: unknown) => {
    assert.ok(error instanceof ChangeExecutionPortError);
    assert.equal(error.code, "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, "u"));
    return true;
  });
});

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

test("passes one canonical deadline through repository context, Actions requests, and artifact download", async () => {
  const api = new FakeActionsApi();

  const result = await executor(api).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.ok(api.deadlines.length > 0);
  const deadline = api.deadlines[0];
  assert.ok(deadline);
  assert.ok(api.deadlines.every((candidate) => candidate === deadline));
  assert.ok(api.calls.some((call) => call.method === "POST"));
  assert.equal(api.artifactDownloads, 1);
});

test("normalizes an expired execution deadline into the bounded Change failure model", async () => {
  const api = new FakeActionsApi();
  let clockReads = 0;
  const now = () => (clockReads++ === 0 ? 0 : 1);

  await assert.rejects(
    executor(api, process.cwd(), 2, { maxWaitMs: 1, now }).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "result-timeout", stage: "repository-context" }),
  );
  assert.equal(api.deadlines.length, 0);
  assert.equal(api.calls.length, 0);
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
          ? { id: api.baselineRunId, status: "completed", conclusion: "success", displayTitle: unrelatedCorrelation }
          : workflowReads === 2
            ? { id: api.resultRunId, status: "queued", conclusion: null, displayTitle: correlation }
            : workflowReads === 3
              ? { id: api.resultRunId, status: "in_progress", conclusion: null, displayTitle: correlation }
              : { id: api.resultRunId, status: "completed", conclusion: "success", displayTitle: correlation };
      api.calls.push({ path, method, fields });
      return {
        workflow_runs: [
          {
            id: run.id,
            status: run.status,
            conclusion: run.conclusion,
            event: "workflow_dispatch",
            head_branch: "main",
            display_title: runDisplayTitle(run.displayTitle),
          },
          ...(run.id === api.resultRunId
            ? [
                {
                  id: api.baselineRunId,
                  status: "completed",
                  conclusion: "success",
                  event: "workflow_dispatch",
                  head_branch: "main",
                  display_title: runDisplayTitle(unrelatedCorrelation),
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

function runFixture(
  id: number,
  runCorrelation: string,
  status: "queued" | "in_progress" | "completed",
  conclusion: string | null,
): Record<string, unknown> {
  return {
    id,
    status,
    conclusion,
    event: "workflow_dispatch",
    head_branch: "main",
    display_title: runDisplayTitle(runCorrelation),
  };
}

function artifactFixture(id: number, workflowRunId: number): Record<string, unknown> {
  return { id, name: `inari-change-result-${correlation}`, expired: false, workflow_run: { id: workflowRunId } };
}

function pageFromPath(value: string): number {
  const match = /[?&]page=(\d+)/u.exec(value);
  if (match === null) throw new Error(`missing page in Actions path: ${value}`);
  return Number(match[1]);
}

function unrelatedRunPage(startId: number): Record<string, unknown>[] {
  return Array.from({ length: 100 }, (_, index) =>
    runFixture(startId + index, unrelatedCorrelation, "completed", "success"),
  );
}

test("#617 paginates workflow runs until the correlated run is found on page 2", async () => {
  const api = new FakeActionsApi();
  let dispatched = false;
  const baselinePages: number[] = [];
  const pollPages: number[] = [];
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") {
      dispatched = true;
      return undefined;
    }
    if (path.startsWith("actions/workflows/")) {
      const page = pageFromPath(path);
      (dispatched ? pollPages : baselinePages).push(page);
      if (page === 1) return { workflow_runs: unrelatedRunPage(dispatched ? 1_000 : 2_000) };
      return dispatched
        ? { workflow_runs: [runFixture(api.resultRunId, correlation, "completed", "success")] }
        : { workflow_runs: [] };
    }
    if (path.startsWith("actions/artifacts?"))
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    throw new Error(`unexpected API path ${path}`);
  };

  const result = await executor(api, process.cwd(), 1).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.deepEqual(baselinePages, [1, 2]);
  assert.deepEqual(pollPages, [1, 2]);
});

test("#617 paginates artifact discovery until the result artifact is found on page 2", async () => {
  const api = new FakeActionsApi();
  const artifactPages: number[] = [];
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/artifacts?")) {
      api.calls.push({ path, method, fields });
      const page = pageFromPath(path);
      artifactPages.push(page);
      if (page === 1) {
        return {
          artifacts: Array.from({ length: 100 }, (_, index) => ({
            id: 1_000 + index,
            name: `unrelated-artifact-${index}`,
            expired: false,
            workflow_run: { id: 900 + index },
          })),
        };
      }
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    }
    return originalRequestActionsApi(path, method, fields);
  };

  const result = await executor(api, process.cwd(), 1).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.deepEqual(artifactPages, [1, 2]);
});

test("#617 stops absent workflow-run discovery at the bounded page limit", async () => {
  const api = new FakeActionsApi();
  let dispatched = false;
  const pollPages: number[] = [];
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") {
      dispatched = true;
      return undefined;
    }
    if (path.startsWith("actions/workflows/")) {
      const page = pageFromPath(path);
      if (!dispatched) return page === 1 ? { workflow_runs: unrelatedRunPage(2_000) } : { workflow_runs: [] };
      pollPages.push(page);
      return { workflow_runs: unrelatedRunPage(3_000 + page * 100) };
    }
    if (path.startsWith("actions/artifacts?")) return { artifacts: [] };
    throw new Error(`unexpected API path ${path}`);
  };

  await assert.rejects(
    executor(api, process.cwd(), 1).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "result-timeout", stage: "artifact-read" }),
  );

  assert.deepEqual(
    pollPages,
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
});

test("native Actions governance blob decoder accepts wrapped base64 and rejects malformed content", async () => {
  const policy = branchPolicySource("^feat/[0-9]+-[a-z0-9-]+$");
  const encoded = Buffer.from(policy, "utf8").toString("base64");
  const wrapped = encoded.replace(/(.{20})/gu, "$1\n");

  function fetchBlob(content: string): typeof fetch {
    return async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/acme/inari") {
        return nativeJsonResponse({ id: 100000157, fork: false });
      }
      if (url.pathname === "/repos/acme/inari/git/blobs/policy-sha") {
        return nativeJsonResponse({ encoding: "base64", content });
      }
      throw new Error(`unexpected native URL ${url}`);
    };
  }

  const api = new ActionsChangeExecutionNativeHttpApi({
    cwd: process.cwd(),
    repository: "acme/inari",
    token: "actions-transport-secret",
    fetch: fetchBlob(wrapped),
  });
  assert.equal(await api.getRepositoryBlob("policy-sha"), policy);

  const malformed = new ActionsChangeExecutionNativeHttpApi({
    cwd: process.cwd(),
    repository: "acme/inari",
    token: "actions-transport-secret",
    fetch: fetchBlob("not-base64!"),
  });
  await assert.rejects(malformed.getRepositoryBlob("policy-sha"));
});
test("native Actions job inspection is paginated and bound to the correlated run", async () => {
  const pages: number[] = [];
  const nativeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/inari") return nativeJsonResponse({ id: 100000157, fork: false });
    if (url.pathname.endsWith("/actions/runs/11/jobs")) {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      return nativeJsonResponse({
        total_count: 101,
        jobs: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
          id: 31 + index,
          run_id: 11,
          status: "completed",
          conclusion: "success",
        })),
      });
    }
    throw new Error(`unexpected native URL ${url}`);
  };
  const api = new ActionsChangeExecutionNativeHttpApi({
    cwd: process.cwd(),
    repository: "acme/inari",
    token: "actions-transport-secret",
    fetch: nativeFetch,
  });

  await api.inspectActionsJobs?.(11);

  assert.deepEqual(pages, [1, 2]);
});

test("a sole unrelated completed executor run is not sufficient evidence and never reports a missing result artifact for this request", async () => {
  const api = new FakeActionsApi();
  let workflowReads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      workflowReads += 1;
      if (workflowReads === 1) return { workflow_runs: [] };
      // Only ever one unrelated completed run is observed; the target's
      // run-name never appears within the bounded poll budget. Candidate
      // cardinality (exactly one) must never substitute for correlation.
      return { workflow_runs: [runFixture(90, unrelatedCorrelation, "completed", "success")] };
    }
    if (path.startsWith("actions/artifacts?")) return { artifacts: [] };
    throw new Error(`unexpected API path ${path}`);
  };

  await assert.rejects(
    executor(api, process.cwd(), 3).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "result-timeout", stage: "artifact-read" }),
  );
});

test("an unrelated completed executor run observed before the target does not disrupt eventual correlation", async () => {
  const api = new FakeActionsApi();
  let workflowReads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      workflowReads += 1;
      if (workflowReads === 1) return { workflow_runs: [] };
      if (workflowReads === 2) {
        return { workflow_runs: [runFixture(90, unrelatedCorrelation, "completed", "success")] };
      }
      return {
        workflow_runs: [
          runFixture(90, unrelatedCorrelation, "completed", "success"),
          runFixture(api.resultRunId, correlation, "completed", "success"),
        ],
      };
    }
    if (path.startsWith("actions/artifacts?")) {
      return workflowReads < 3
        ? { artifacts: [] }
        : { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    }
    throw new Error(`unexpected API path ${path}`);
  };

  const result = await executor(api).execute(changeMutationRequest("issue", 42));
  assert.deepEqual(result, { projection: api.result });
});

test("an unrelated completed run listed before the target in the same response does not divert correlation", async () => {
  const api = new FakeActionsApi();
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      return {
        workflow_runs: [
          runFixture(90, unrelatedCorrelation, "completed", "failure"),
          runFixture(api.resultRunId, correlation, "completed", "success"),
        ],
      };
    }
    if (path.startsWith("actions/artifacts?"))
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    throw new Error(`unexpected API path ${path}`);
  };

  const result = await executor(api).execute(changeMutationRequest("issue", 42));
  assert.deepEqual(result, { projection: api.result });
});

test("an unrelated completed run listed after the target in the same response does not divert correlation", async () => {
  const api = new FakeActionsApi();
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      return {
        workflow_runs: [
          runFixture(api.resultRunId, correlation, "completed", "success"),
          runFixture(90, unrelatedCorrelation, "completed", "failure"),
        ],
      };
    }
    if (path.startsWith("actions/artifacts?"))
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    throw new Error(`unexpected API path ${path}`);
  };

  const result = await executor(api).execute(changeMutationRequest("issue", 42));
  assert.deepEqual(result, { projection: api.result });
});

test("with multiple candidate runs visible, only the run positively correlated by run-name is interpreted", async () => {
  const api = new FakeActionsApi();
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      return {
        workflow_runs: [
          runFixture(90, unrelatedCorrelation, "completed", "failure"),
          runFixture(91, otherUnrelatedCorrelation, "completed", "success"),
          runFixture(api.resultRunId, correlation, "completed", "success"),
        ],
      };
    }
    if (path.startsWith("actions/artifacts?"))
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    throw new Error(`unexpected API path ${path}`);
  };

  const result = await executor(api).execute(changeMutationRequest("issue", 42));
  assert.deepEqual(result, { projection: api.result });
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

test("retries one transient result artifact download failure before accepting success", async () => {
  const api = new FakeActionsApi();
  const originalDownloadActionsArtifact = api.downloadActionsArtifact.bind(api);
  let downloads = 0;
  api.downloadActionsArtifact = async (artifactId) => {
    downloads += 1;
    if (downloads === 1) throw new Error("transient Actions artifact download failure");
    return originalDownloadActionsArtifact(artifactId);
  };

  const result = await executor(api).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.equal(downloads, 2);
});

test("#632 retains established run and artifact evidence across a transient run-list read", async () => {
  const api = new FakeActionsApi();
  let runListReads = 0;
  let artifactListReads = 0;
  let downloads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      runListReads += 1;
      if (runListReads === 1)
        return { workflow_runs: [runFixture(api.baselineRunId, unrelatedCorrelation, "completed", "success")] };
      if (runListReads === 2)
        return { workflow_runs: [runFixture(api.resultRunId, correlation, "completed", "success")] };
      if (runListReads === 3) throw new Error("transient run-list read failure");
      return { workflow_runs: [runFixture(api.resultRunId, correlation, "completed", "success")] };
    }
    if (path === `actions/runs/${api.resultRunId}`) {
      return runFixture(api.resultRunId, correlation, "completed", "success");
    }
    if (path.startsWith("actions/artifacts?")) {
      artifactListReads += 1;
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    }
    if (path === `actions/artifacts/${api.resultArtifactId}`) {
      return artifactFixture(api.resultArtifactId, api.resultRunId);
    }
    throw new Error(`unexpected API path ${path}`);
  };
  api.downloadActionsArtifact = async (artifactId) => {
    assert.equal(artifactId, api.resultArtifactId);
    downloads += 1;
    if (downloads === 1) throw new Error("transient artifact download failure");
    return archive(api.archiveValue);
  };

  const result = await executor(api, process.cwd(), 4).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.equal(artifactListReads, 1);
  assert.equal(downloads, 2);
  assert.ok(api.calls.some((call) => call.path === `actions/runs/${api.resultRunId}`));
  assert.ok(api.calls.some((call) => call.path === `actions/artifacts/${api.resultArtifactId}`));
  assert.doesNotMatch(JSON.stringify(api.calls), /secret|token|private/iu);
});

test("#632 rejects a wrong exact-run observation after positive correlation instead of accepting its artifact", async () => {
  const api = new FakeActionsApi();
  let runListReads = 0;
  let downloads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      runListReads += 1;
      if (runListReads === 1)
        return { workflow_runs: [runFixture(api.baselineRunId, unrelatedCorrelation, "completed", "success")] };
      if (runListReads === 2)
        return { workflow_runs: [runFixture(api.resultRunId, correlation, "completed", "success")] };
      throw new Error("transient run-list read failure");
    }
    if (path === `actions/runs/${api.resultRunId}`) {
      return runFixture(api.resultRunId, unrelatedCorrelation, "completed", "success");
    }
    if (path.startsWith("actions/artifacts?")) {
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    }
    throw new Error(`unexpected API path ${path}`);
  };
  api.downloadActionsArtifact = async () => {
    downloads += 1;
    throw new Error("transient artifact download failure");
  };

  await assert.rejects(
    executor(api, process.cwd(), 4).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_CORRELATION_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "wrong-run", stage: "correlation" }),
  );
  assert.equal(downloads, 1);
  assert.doesNotMatch(JSON.stringify(api.calls), /secret|token|private/iu);
});

test("#632 recovers a transient artifact-list failure via exact-artifact observation without touching the run-list-failure path", async () => {
  const api = new FakeActionsApi();
  let runListReads = 0;
  let artifactListReads = 0;
  let downloads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      runListReads += 1;
      if (runListReads === 1)
        return { workflow_runs: [runFixture(api.baselineRunId, unrelatedCorrelation, "completed", "success")] };
      const status = runListReads === 2 ? "in_progress" : "completed";
      return {
        workflow_runs: [runFixture(api.resultRunId, correlation, status, runListReads === 2 ? null : "success")],
      };
    }
    if (path.startsWith("actions/artifacts?")) {
      artifactListReads += 1;
      if (artifactListReads === 1) return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
      if (artifactListReads === 2) throw new Error("transient artifact-list read failure");
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    }
    if (path === `actions/artifacts/${api.resultArtifactId}`) {
      return artifactFixture(api.resultArtifactId, api.resultRunId);
    }
    throw new Error(`unexpected API path ${path}`);
  };
  api.downloadActionsArtifact = async (artifactId) => {
    assert.equal(artifactId, api.resultArtifactId);
    downloads += 1;
    return archive(api.archiveValue);
  };

  const result = await executor(api, process.cwd(), 4).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.equal(downloads, 1);
  assert.ok(api.calls.some((call) => call.path === `actions/artifacts/${api.resultArtifactId}`));
  assert.ok(!api.calls.some((call) => call.path === `actions/runs/${api.resultRunId}`));
  assert.doesNotMatch(JSON.stringify(api.calls), /secret|token|private/iu);
});

test("#632 recovers a transient artifact-list omission via exact-artifact observation without touching the run-list-failure path", async () => {
  const api = new FakeActionsApi();
  let runListReads = 0;
  let artifactListReads = 0;
  let downloads = 0;
  api.requestActionsApi = async (path, method, fields = {}) => {
    api.calls.push({ path, method, fields });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      runListReads += 1;
      if (runListReads === 1)
        return { workflow_runs: [runFixture(api.baselineRunId, unrelatedCorrelation, "completed", "success")] };
      const status = runListReads === 2 ? "in_progress" : "completed";
      return {
        workflow_runs: [runFixture(api.resultRunId, correlation, status, runListReads === 2 ? null : "success")],
      };
    }
    if (path.startsWith("actions/artifacts?")) {
      artifactListReads += 1;
      if (artifactListReads === 2) return { artifacts: [] };
      return { artifacts: [artifactFixture(api.resultArtifactId, api.resultRunId)] };
    }
    if (path === `actions/artifacts/${api.resultArtifactId}`) {
      return artifactFixture(api.resultArtifactId, api.resultRunId);
    }
    throw new Error(`unexpected API path ${path}`);
  };
  api.downloadActionsArtifact = async (artifactId) => {
    assert.equal(artifactId, api.resultArtifactId);
    downloads += 1;
    return archive(api.archiveValue);
  };

  const result = await executor(api, process.cwd(), 4).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.equal(downloads, 1);
  assert.ok(api.calls.some((call) => call.path === `actions/artifacts/${api.resultArtifactId}`));
  assert.ok(!api.calls.some((call) => call.path === `actions/runs/${api.resultRunId}`));
  assert.doesNotMatch(JSON.stringify(api.calls), /secret|token|private/iu);
});

test("preserves the bounded result-timeout failure when no executor run becomes observable", async () => {
  const api = new FakeActionsApi();
  api.runState = "pending";

  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "result-timeout", stage: "artifact-read" }),
  );
});

test("stops on real wall-clock deadline even when the poll-attempt count has not been exhausted", async () => {
  const api = new FakeActionsApi();
  api.runState = "pending";
  // Each attempt's API calls consume more real time than the sleep-only
  // budget would suggest, exactly the gap issue #582 reported: a nominal
  // maxPollAttempts of 60 would take far longer than 120s of real time to
  // exhaust in practice, but the wall-clock deadline must still stop the
  // wait promptly instead of running every attempt.
  let elapsedMs = 0;
  const now = () => elapsedMs;
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    elapsedMs += 50_000;
    return originalRequestActionsApi(path, method, fields);
  };

  await assert.rejects(
    executor(api, process.cwd(), 60, { maxWaitMs: 120_000, now }).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "result-timeout", stage: "run-read" }),
  );
  // Two readRuns calls each advance the clock 50s past the 120s deadline
  // (readArtifacts also advances it, so bound the exact count loosely) and
  // the loop must stop well short of the full 60-attempt nominal budget.
  assert.ok(elapsedMs < 400_000, `expected the wait to stop near the deadline, elapsed=${elapsedMs}`);
});

test("a single slow-but-successful attempt still returns the result within the wall-clock deadline", async () => {
  const api = new FakeActionsApi();
  let elapsedMs = 0;
  const now = () => elapsedMs;
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    elapsedMs += 10_000;
    return originalRequestActionsApi(path, method, fields);
  };

  const result = await executor(api, process.cwd(), 60, { maxWaitMs: 240_000, now }).execute(
    changeMutationRequest("issue", 42),
  );

  assert.deepEqual(result, { projection: api.result });
});

test("the default attempt-count ceiling does not cut off retries before the default wall-clock deadline", async () => {
  // Issue #592: a fixed maxPollAttempts of 60 was exhausted in 230s of real
  // time (under the 240s wall-clock deadline) purely from per-attempt API
  // latency, aborting a wait that still had time remaining. Using the
  // adapter's actual default maxPollAttempts/maxWaitMs (not an
  // artificially small attempt cap), a recurring retryable transport error
  // that consumes realistic per-attempt latency must keep retrying until
  // the wall-clock deadline, not stop early because attempts ran out.
  const api = new FakeActionsApi();
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  let elapsedMs = 0;
  const now = () => elapsedMs;
  let workflowRunReads = 0;
  // Include setup and dispatch in the shared budget, then recover well past
  // the old fixed cap of 60 attempts while remaining inside the deadline.
  const failingReads = 65;
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/workflows/")) {
      workflowRunReads += 1;
      // The first read is dispatchAndCollect's pre-dispatch baseline read
      // (outside the poll loop's retry handling); only fail the poll loop's
      // own reads so the loop, not the baseline call, is under test.
      if (workflowRunReads > 1 && workflowRunReads <= failingReads + 1) {
        elapsedMs += 3_000;
        throw new Error("transient Actions run lookup failure");
      }
    }
    elapsedMs += 3_000;
    return originalRequestActionsApi(path, method, fields);
  };

  const result = await createActionsChangeExecutionAdapter({
    cwd: process.cwd(),
    api,
    randomUUID: () => correlation,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    now,
  }).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.ok(
    workflowRunReads > failingReads,
    `expected retries to continue past the old 60-attempt cap, workflowRunReads=${workflowRunReads}`,
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

test("#615 preserves a bounded transport stage at each Actions boundary", async () => {
  const expectFailure = async (
    api: FakeActionsApi,
    expected: {
      readonly code: string;
      readonly reason: string;
      readonly stage: string;
      readonly operation?: string;
    },
  ): Promise<void> => {
    await assert.rejects(executor(api).execute(changeMutationRequest("issue", 42)), (error: unknown) => {
      assert.ok(error instanceof ChangeExecutionPortError);
      assert.equal(error.code, expected.code);
      assert.deepEqual(error.details, {
        operation: expected.operation ?? "change.issue",
        reason: expected.reason,
        stage: expected.stage,
      });
      assert.doesNotMatch(JSON.stringify(error), /Bearer|secret|private|provider|token|\/private/iu);
      return true;
    });
  };

  const contextApi = new FakeActionsApi();
  contextApi.getRepositoryContext = async () => {
    throw new Error("Bearer context-secret /private/provider/context");
  };
  await expectFailure(contextApi, {
    code: "CHANGE_REMOTE_EXECUTOR_UNAVAILABLE",
    reason: "transport",
    stage: "repository-context",
  });

  const dispatchApi = new FakeActionsApi();
  const dispatchRequest = dispatchApi.requestActionsApi.bind(dispatchApi);
  dispatchApi.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "POST") throw new Error("Bearer dispatch-secret /private/provider/dispatch");
    return dispatchRequest(path, method, fields);
  };
  await expectFailure(dispatchApi, {
    code: "CHANGE_REMOTE_DISPATCH_FAILED",
    reason: "transport",
    stage: "dispatch",
  });

  const runApi = new FakeActionsApi();
  const runRequest = runApi.requestActionsApi.bind(runApi);
  let runReads = 0;
  runApi.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/workflows/")) {
      runReads += 1;
      if (runReads === 2) throw new GitHubAuthenticationError("github.com", "run-secret");
    }
    return runRequest(path, method, fields);
  };
  await expectFailure(runApi, {
    code: "CHANGE_REMOTE_TRANSPORT_FAILED",
    reason: "authentication",
    stage: "run-read",
  });

  const artifactApi = new FakeActionsApi();
  const artifactRequest = artifactApi.requestActionsApi.bind(artifactApi);
  artifactApi.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/artifacts?")) {
      throw new GitHubAuthenticationError("github.com", "artifact-secret");
    }
    return artifactRequest(path, method, fields);
  };
  await expectFailure(artifactApi, {
    code: "CHANGE_REMOTE_TRANSPORT_FAILED",
    reason: "authentication",
    stage: "artifact-read",
  });

  const downloadApi = new FakeActionsApi();
  downloadApi.downloadActionsArtifact = async () => {
    throw new GitHubAuthenticationError("github.com", "download-secret");
  };
  await expectFailure(downloadApi, {
    code: "CHANGE_REMOTE_TRANSPORT_FAILED",
    reason: "authentication",
    stage: "artifact-download",
  });

  const decodeApi = new FakeActionsApi();
  decodeApi.artifactMode = "malformed";
  await expectFailure(decodeApi, {
    code: "CHANGE_REMOTE_RESULT_INVALID",
    reason: "invalid-archive",
    stage: "result-decode",
    operation: "actions.artifact",
  });

  const correlationApi = new FakeActionsApi();
  correlationApi.artifactMode = "ambiguous";
  await expectFailure(correlationApi, {
    code: "CHANGE_REMOTE_CORRELATION_FAILED",
    reason: "ambiguous-artifact",
    stage: "correlation",
  });
});

test("#615 keeps unknown transport data bounded and preserves semantic port errors", async () => {
  const unknownApi = new FakeActionsApi();
  const unknownRequest = unknownApi.requestActionsApi.bind(unknownApi);
  unknownApi.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "POST") {
      throw {
        message: "provider response Bearer unknown-secret /private/provider/body",
        token: "unknown-secret",
      };
    }
    return unknownRequest(path, method, fields);
  };
  await assert.rejects(executor(unknownApi).execute(changeMutationRequest("issue", 42)), (error: unknown) => {
    assert.ok(error instanceof ChangeExecutionPortError);
    assert.deepEqual(error.details, {
      operation: "change.issue",
      reason: "transport",
      stage: "dispatch",
    });
    assert.doesNotMatch(JSON.stringify(error), /unknown-secret|\/private\/provider\/body/iu);
    return true;
  });

  const semanticApi = new FakeActionsApi();
  const semanticError = new ChangeExecutionPortError(
    "CHANGE_REMOTE_RUN_FAILED",
    "The trusted Change workflow did not produce a successful result.",
    { operation: "change.issue", reason: "workflow-failed", stage: "installation-token" },
    [
      {
        version: 1,
        code: "CHANGE_PROVENANCE_CONFLICT",
        path: "$.projection.change.provenance",
        message: "The trusted Change provenance is inconsistent.",
      },
    ],
  );
  const semanticRequest = semanticApi.requestActionsApi.bind(semanticApi);
  semanticApi.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "POST") throw semanticError;
    return semanticRequest(path, method, fields);
  };
  await assert.rejects(executor(semanticApi).execute(changeMutationRequest("issue", 42)), (error: unknown) => {
    assert.equal(error, semanticError);
    return true;
  });
});

test("#613: continues polling for the correlated result artifact after the target run completes, and succeeds once visibility catches up", async () => {
  // The correlated run is already observed as completed on the very first
  // poll (FakeActionsApi's default fixture), but the exact result artifact
  // is absent on that same first poll — reproducing GitHub Actions' run
  // completion and artifact-listing convergence not being atomic. Absence
  // here must be treated as an observation state, not immediate proof of
  // failure, as long as the canonical deadline has time remaining.
  const api = new FakeActionsApi();
  let artifactReads = 0;
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/artifacts?")) {
      artifactReads += 1;
      if (artifactReads === 1) return { artifacts: [] };
    }
    return originalRequestActionsApi(path, method, fields);
  };

  const result = await executor(api, process.cwd(), 3).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
  assert.equal(artifactReads, 2);
});

test("#613: an artifact that never becomes visible fails closed at the canonical deadline without an independent artifact timeout", async () => {
  const api = new FakeActionsApi();
  api.artifactMode = "missing";
  let workflowReads = 0;
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/workflows/")) workflowReads += 1;
    return originalRequestActionsApi(path, method, fields);
  };

  await assert.rejects(
    executor(api, process.cwd(), 4).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "result-timeout", stage: "artifact-read" }),
  );
  // Bounded exactly by the shared maxPollAttempts/deadline (one baseline read
  // plus one read per poll-loop attempt) — no unbounded polling and no
  // second, artifact-specific timeout authority.
  assert.equal(workflowReads, 5);
});

test("#613: an artifact with a non-matching name during the lag window does not satisfy the request", async () => {
  const api = new FakeActionsApi();
  let artifactReads = 0;
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/artifacts?")) {
      artifactReads += 1;
      if (artifactReads === 1) {
        return {
          artifacts: [
            {
              id: 999,
              name: `inari-change-result-${otherUnrelatedCorrelation}`,
              expired: false,
              workflow_run: { id: api.resultRunId },
            },
          ],
        };
      }
    }
    return originalRequestActionsApi(path, method, fields);
  };

  const result = await executor(api, process.cwd(), 3).execute(changeMutationRequest("issue", 42));

  assert.deepEqual(result, { projection: api.result });
});

test("#613: a same-named artifact bound to an unrelated baseline run remains a fail-closed correlation failure, not a lag observation", async () => {
  const api = new FakeActionsApi();
  api.artifactMode = "stale";
  await assert.rejects(
    executor(api).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_CORRELATION_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "stale-artifact", stage: "correlation" }),
  );
});

test("#613: a correlated run's failure conclusion and diagnostic remain authoritative once the delayed result artifact becomes visible", async () => {
  const api = new FakeActionsApi();
  api.runState = "failure";
  api.archiveValue = {
    ok: false,
    error: {
      code: "CHANGE_ACTIONS_RUNTIME_INVALID",
      message: "Bearer installation-secret-token /private/provider/path",
      details: { stage: "installation-token" },
    },
  };
  let artifactReads = 0;
  const originalRequestActionsApi = api.requestActionsApi.bind(api);
  api.requestActionsApi = async (path, method, fields = {}) => {
    if (method === "GET" && path.startsWith("actions/artifacts?")) {
      artifactReads += 1;
      if (artifactReads === 1) return { artifacts: [] };
    }
    return originalRequestActionsApi(path, method, fields);
  };

  await assert.rejects(
    executor(api, process.cwd(), 3).execute(changeMutationRequest("issue", 42)),
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RUN_FAILED" &&
      JSON.stringify(error.details) ===
        JSON.stringify({ operation: "change.issue", reason: "workflow-conclusion", stage: "installation-token" }) &&
      !JSON.stringify(error).includes("installation-secret-token"),
  );
  assert.equal(artifactReads, 2);
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
    (error: unknown) =>
      error instanceof ChangeExecutionPortError &&
      error.code === "CHANGE_REMOTE_RESULT_INVALID" &&
      JSON.stringify(error.details) === JSON.stringify({ operation: "issue", stage: "result-decode" }) &&
      !JSON.stringify(error).includes("secret"),
  );
});
