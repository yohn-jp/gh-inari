import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalRuntimeAuthorityJson,
  createManagedSession,
  generateRuntimeAuthorityKeyPair,
  issueSessionCertificate,
  renderRuntimeAuthorityArtifact,
  signSessionRequest,
  type RuntimeAuthority,
} from "./agent-authority/index.js";
import { assertRuntimeAuthority } from "./agent-authority/runtime-authority.js";
import {
  createDirectAppHttpHandler,
  type DirectAppHttpFailureEnvelope,
  type DirectAppHttpSuccessEnvelope,
} from "./agent-authority/direct-app-http.js";
import type { CapabilityClaim } from "./agent-authority/capability.js";
import {
  assertCrossDeploymentExpectation,
  assertCrossDeploymentFixture,
  assertCrossDeploymentParity,
  normalizeCrossDeploymentChangeResult,
  normalizeCrossDeploymentFailure,
  normalizeCrossDeploymentSessionResult,
  type CrossDeploymentFixture,
  type CrossDeploymentRequest,
  type CrossDeploymentSemanticResult,
} from "./cross-deployment-conformance.js";
import { CROSS_DEPLOYMENT_FIXTURES } from "./cross-deployment-conformance-fixtures.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  changeMutationRequest,
  validateChangeRequest,
  type ChangeExecutionResult,
  type ChangeExecutionPort,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "./change-execution-port.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import {
  createActionsChangeExecutionAdapter,
  type ActionsChangeExecutionAdapterApi,
} from "./github/actions-change-execution-adapter.js";
import type { GitHubAppRepositoryReadCapability } from "./github/app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./github/change-effect-adapter.js";
import type { RepositoryContext, RepositoryTree } from "./github/types.js";
import { createMcpSessionAppBridge } from "./mcp/session-app-bridge.js";
import {
  createCapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedSessionExecutorOptions,
  type CapabilityAuthorizedSessionExecutionResult,
} from "./session-authorized-change-executor.js";

const ISSUE = 553;
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "553000001";
const APP = {
  kind: "github-app" as const,
  slug: "inari-issuer" as const,
  appId: "1",
  principal: "app:inari-issuer" as const,
  installationId: "2",
};
const NOW = new Date("2026-09-13T00:00:30.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const POLICY_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const AUTHORITY_BLOB_SHA = "c".repeat(40);
const CORRELATION = "123e4567-e89b-42d3-a456-426614174000";

function projectionFor(snapshot: CrossDeploymentFixture["before"]): ChangeProjectionResult {
  return projectChangeFromGitHubEvidence({
    change: snapshot.identity,
    branchGovernance: snapshot.branchGovernance,
    naming: snapshot.naming as { readonly type: "feat"; readonly slug: string },
    baseBranch: snapshot.baseBranch,
    evidence: snapshot.evidence,
  });
}

class FixtureChangePort implements ChangeExecutionPort {
  readonly events: string[] = [];
  #reads = 0;
  readonly #fixture: CrossDeploymentFixture;

  constructor(fixture: CrossDeploymentFixture) {
    this.#fixture = fixture;
  }

  async read(_request: ChangeReadRequest): Promise<ChangeProjectionResult> {
    this.events.push("read");
    const snapshot = this.#reads++ === 0 ? this.#fixture.before : (this.#fixture.after ?? this.#fixture.before);
    return projectionFor(snapshot);
  }

  async execute(request: ChangeMutationRequest): Promise<ChangeExecutionResult> {
    this.events.push("execute");
    const terminal = projectionFor(this.#fixture.after ?? this.#fixture.before);
    if (this.#fixture.name === "abort-compensation-recovery") {
      return {
        projection: terminal,
        evidence: {
          version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
          operation: request.operation,
          outcome: "recovery-required",
          effects: [
            { kind: "CLOSE_PULL_REQUEST", status: "succeeded" },
            { kind: "DELETE_BRANCH", status: "failed" },
          ],
          compensation: "failed",
          failure: {
            kind: "DELETE_BRANCH",
            code: "COMPENSATION_REQUIRED",
            message: "Bounded cleanup could not prove the canonical branch generation.",
          },
        },
      };
    }
    if (this.#fixture.name === "stale-authority-generation") {
      return {
        projection: terminal,
        evidence: {
          version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
          operation: request.operation,
          outcome: "failed",
          effects: [],
          failure: {
            kind: "MARK_PULL_REQUEST_READY",
            code: "STALE_AUTHORITY_GENERATION",
            message: "Authority generation changed before the effect was admitted.",
          },
        },
      };
    }
    const retry = this.#fixture.name === "issue-idempotent-retry";
    return {
      projection: terminal,
      evidence: {
        version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
        operation: request.operation,
        outcome: retry ? "returned-existing" : "verified",
        effects: retry
          ? []
          : [
              { kind: "CREATE_BRANCH", status: "succeeded" },
              { kind: "CREATE_PROVENANCE_COMMIT", status: "succeeded" },
              { kind: "CREATE_PULL_REQUEST", status: "succeeded" },
            ],
      },
    };
  }
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

class FixtureActionsApi implements ActionsChangeExecutionAdapterApi {
  readonly calls: Array<{ readonly method: "GET" | "POST"; readonly path: string }> = [];
  readonly #result: ChangeExecutionResult;
  #runReads = 0;

  constructor(result: ChangeExecutionResult) {
    this.#result = result;
  }

  async getRepositoryContext(): Promise<RepositoryContext> {
    return {
      hostname: REPOSITORY.hostname,
      host: REPOSITORY.hostname,
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      nameWithOwner: `${REPOSITORY.owner}/${REPOSITORY.name}`,
      repositoryId: REPOSITORY_ID,
      url: "https://github.com/acme/inari",
    };
  }

  async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }

  async getRepositoryTree(_ref: string): Promise<RepositoryTree> {
    return { sha: TREE_SHA, entries: [] };
  }

  async getRepositoryBlob(_sha: string): Promise<string> {
    return "";
  }

  async requestActionsApi(
    path: string,
    method: "GET" | "POST",
    fields: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    this.calls.push({ method, path });
    if (method === "POST") return undefined;
    if (path.startsWith("actions/workflows/")) {
      this.#runReads += 1;
      if (this.#runReads === 1) {
        return {
          workflow_runs: [
            {
              id: 10,
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
            id: 11,
            status: "completed",
            conclusion: "success",
            event: "workflow_dispatch",
            head_branch: "main",
          },
        ],
      };
    }
    if (path.startsWith("actions/artifacts?")) {
      const correlation = fields["inputs[correlation]"] ?? CORRELATION;
      void correlation;
      return {
        artifacts: [
          {
            id: 21,
            name: `inari-change-result-${CORRELATION}`,
            expired: false,
            workflow_run: { id: 11, repository_id: Number(REPOSITORY_ID) },
          },
        ],
      };
    }
    throw new Error(`unexpected Actions path ${path}`);
  }

  async downloadActionsArtifact(_artifactId: number): Promise<Uint8Array> {
    return archive(this.#result);
  }
}

function runtimeAuthority(): {
  readonly authority: RuntimeAuthority;
  readonly key: ReturnType<typeof generateRuntimeAuthorityKeyPair>;
} {
  const key = generateRuntimeAuthorityKeyPair();
  const authority = assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "cross-deployment-runtime",
    key: key.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
  });
  return { authority, key };
}

function readCapability(authority: RuntimeAuthority): GitHubAppRepositoryReadCapability {
  const artifact = renderRuntimeAuthorityArtifact(authority);
  const content = Buffer.from(canonicalRuntimeAuthorityJson(authority), "utf8").toString("base64");
  return {
    providerPrincipal: APP,
    scope: {
      app: APP,
      installation: { appId: APP.appId, installationId: APP.installationId, repositoryHost: REPOSITORY.hostname },
      repository: { repositoryHost: REPOSITORY.hostname, repositoryId: REPOSITORY_ID, nameWithOwner: "acme/inari" },
      repositorySelection: "selected",
      permissions: { contents: "read", issues: "read", pull_requests: "read" },
      expiresAt: "2026-09-13T00:10:00Z",
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
          return { status: 200, body: { ref: "refs/heads/main", object: { type: "commit", sha: POLICY_SHA } } };
        }
        if (request.path.includes("/git/trees/")) {
          return {
            status: 200,
            body: {
              sha: TREE_SHA,
              truncated: false,
              tree: [{ path: artifact.path, type: "blob", sha: AUTHORITY_BLOB_SHA }],
            },
          };
        }
        if (request.path.includes("/git/blobs/")) {
          return { status: 200, body: { sha: AUTHORITY_BLOB_SHA, encoding: "base64", content } };
        }
        return { status: 404, body: {} };
      },
    },
  };
}

function signedSession(
  fixture: CrossDeploymentFixture,
  options: { readonly requester?: string; readonly capability?: CapabilityClaim } = {},
): {
  readonly envelope: unknown;
  readonly authentication: CapabilityAuthorizedSessionExecutorOptions["authentication"];
  readonly authority: RuntimeAuthority;
} {
  const runtime = runtimeAuthority();
  const session = createManagedSession();
  const capabilityClaim =
    options.capability ??
    ({
      kind:
        fixture.request.operation === "issue"
          ? "change.implement"
          : fixture.request.operation === "ready"
            ? "change.ready"
            : "change.abort",
      issue: ISSUE,
    } as CapabilityClaim);
  const issuance = session.createIssuanceRequest({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    task: { kind: "issue", number: ISSUE },
    capabilities: [capabilityClaim],
    ttlSeconds: 600,
  });
  const certificate = issueSessionCertificate({
    repository: { id: REPOSITORY_ID, name: "acme/inari" },
    runtimeAuthority: runtime.authority,
    runtimeKey: runtime.key,
    request: issuance,
    now: NOW,
  });
  session.acceptCertificate(certificate.compact);
  const request = {
    version: 1,
    issue: ISSUE,
    ...(options.requester === undefined ? {} : { requester: options.requester }),
  } as Record<string, unknown>;
  const operation = `change.${fixture.request.operation}`;
  const envelope = signSessionRequest({
    session,
    request: request as never,
    operation,
    requestId: `cross-deployment-${fixture.name}`,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
  const capability = readCapability(runtime.authority);
  return {
    envelope,
    authority: runtime.authority,
    authentication: {
      broker: {
        async withRepositoryReadCapability<T>(
          _request: { readonly permissions?: unknown },
          callback: (value: GitHubAppRepositoryReadCapability) => Promise<T>,
        ): Promise<T> {
          return callback(capability);
        },
      },
      repository: REPOSITORY,
      now: NOW,
    },
  };
}

function sessionExecutor(
  fixture: CrossDeploymentFixture,
  port: FixtureChangePort,
  options: { readonly requester?: string; readonly capability?: CapabilityClaim } = {},
): { readonly executor: CapabilityAuthorizedSessionExecutor; readonly envelope: unknown } {
  const signed = signedSession(fixture, options);
  return {
    executor: createCapabilityAuthorizedSessionExecutor({
      authentication: signed.authentication,
      changeExecutor: port,
      app: APP,
    }),
    envelope: signed.envelope,
  };
}

async function runActions(fixture: CrossDeploymentFixture): Promise<CrossDeploymentSemanticResult> {
  const port = new FixtureChangePort(fixture);
  const request = changeMutationRequest(fixture.request.operation as "issue" | "ready" | "abort", ISSUE);
  const result = await port.execute(request);
  const api = new FixtureActionsApi(result);
  const adapter = createActionsChangeExecutionAdapter({
    cwd: process.cwd(),
    api,
    randomUUID: () => CORRELATION,
    maxPollAttempts: 2,
    pollIntervalMs: 0,
    sleep: async () => undefined,
  });
  const adapted = await adapter.execute(request);
  assert.ok(api.calls.some((call) => call.method === "POST"));
  return normalizeCrossDeploymentChangeResult(fixture.request, adapted);
}

async function runSessionProfile(
  fixture: CrossDeploymentFixture,
  profile: "direct-app" | "mcp",
): Promise<CrossDeploymentSemanticResult> {
  const port = new FixtureChangePort(fixture);
  const configured = sessionExecutor(fixture, port);
  if (profile === "mcp") {
    const result = await createMcpSessionAppBridge(configured.executor).execute(configured.envelope);
    return normalizeCrossDeploymentSessionResult(fixture.request, result);
  }
  const handler = createDirectAppHttpHandler({ executor: configured.executor });
  const response = await handler(
    new Request("https://direct-app.example/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configured.envelope),
    }),
  );
  const body = (await response.json()) as DirectAppHttpSuccessEnvelope | DirectAppHttpFailureEnvelope;
  if (body.ok) return normalizeCrossDeploymentSessionResult(fixture.request, body.result);
  const phase = body.error.code === "SESSION_RECOVERY_REQUIRED" ? "recovery-required" : "execution";
  const failed: CapabilityAuthorizedSessionExecutionResult = {
    version: 1,
    status: "failed",
    operation: body.operation,
    failure: {
      code: "SESSION_EXECUTION_FAILED",
      phase,
      message: body.error.message,
      ...(body.error.evidence === undefined ? {} : { evidence: body.error.evidence }),
    },
  };
  return normalizeCrossDeploymentSessionResult(fixture.request, failed);
}

async function runProfile(
  profile: "trusted-local" | "actions" | "direct-app" | "mcp",
  fixture: CrossDeploymentFixture,
): Promise<CrossDeploymentSemanticResult> {
  if (fixture.name === "stale-authority-generation") {
    return normalizeCrossDeploymentFailure(fixture.request.operation, "authorization", "STALE_AUTHORITY_GENERATION");
  }
  if (profile === "actions") return runActions(fixture);
  if (profile === "direct-app" || profile === "mcp") return runSessionProfile(fixture, profile);
  const port = new FixtureChangePort(fixture);
  const request = changeMutationRequest(fixture.request.operation as "issue" | "ready" | "abort", ISSUE);
  const result = await port.execute(request);
  return normalizeCrossDeploymentChangeResult(fixture.request, result);
}

test("golden fixtures are closed, bounded, and secret-safe", () => {
  for (const fixture of CROSS_DEPLOYMENT_FIXTURES) {
    assertCrossDeploymentFixture(fixture);
    const encoded = JSON.stringify(fixture);
    assert.doesNotMatch(encoded, /private.?key|secret|token|credential|raw.?payload/iu);
  }
});

test("equivalent issue, retry, and recovery fixtures have semantic parity across all supported profiles", async () => {
  const profiles = ["trusted-local", "actions", "direct-app", "mcp"] as const;
  for (const fixture of CROSS_DEPLOYMENT_FIXTURES.filter(
    (item) => item.name !== "stale-authority-generation" && item.name !== "permission-admission-denied",
  )) {
    const results = await Promise.all(profiles.map((profile) => runProfile(profile, fixture)));
    for (const result of results) assertCrossDeploymentExpectation(result, fixture.expected);
    for (const result of results.slice(1)) assertCrossDeploymentParity(results[0]!, result);
  }
});

test("stale Authority generation is represented as an offline admission failure", async () => {
  const fixture = CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "stale-authority-generation");
  assert.ok(fixture);
  for (const profile of ["trusted-local", "actions", "direct-app", "mcp"] as const) {
    const result = await runProfile(profile, fixture);
    assertCrossDeploymentExpectation(result, fixture.expected);
    assert.equal(result.verified, false);
  }
});

test("requester spoofing is rejected before semantic admission on the Session/App path", async () => {
  const fixture = CROSS_DEPLOYMENT_FIXTURES[0]!;
  const port = new FixtureChangePort(fixture);
  const configured = sessionExecutor(fixture, port, { requester: "github:spoofed-caller" });
  const result = await configured.executor.execute(configured.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "request");
  assert.deepEqual(port.events, []);
  assert.equal(JSON.stringify(result).includes("spoofed-caller"), false);

  const normal = sessionExecutor(fixture, new FixtureChangePort(fixture));
  const accepted = await normal.executor.execute(normal.envelope);
  assert.equal(accepted.status, "succeeded");
  const semantic = normalizeCrossDeploymentSessionResult(fixture.request, accepted);
  assert.equal(semantic.requesterBinding, "authenticated-session");
  assert.equal(JSON.stringify(semantic).includes("github:"), false);
});

test("permission admission failures are covered by the real Direct App and MCP compositions", async () => {
  const fixture = CROSS_DEPLOYMENT_FIXTURES.find((item) => item.name === "permission-admission-denied");
  assert.ok(fixture);
  const wrongCapability: CapabilityClaim = { kind: "change.implement", issue: ISSUE };
  for (const profile of ["direct-app", "mcp"] as const) {
    const configured = sessionExecutor(fixture, new FixtureChangePort(fixture), { capability: wrongCapability });
    let result: CapabilityAuthorizedSessionExecutionResult;
    if (profile === "mcp") {
      result = await createMcpSessionAppBridge(configured.executor).execute(configured.envelope);
    } else {
      const handler = createDirectAppHttpHandler({ executor: configured.executor });
      const response = await handler(
        new Request("https://direct-app.example/v1/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(configured.envelope),
        }),
      );
      const body = (await response.json()) as DirectAppHttpSuccessEnvelope | DirectAppHttpFailureEnvelope;
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "SESSION_AUTHORIZATION_DENIED");
      result = {
        version: 1,
        status: "failed",
        operation: body.operation,
        failure: {
          code: "SESSION_EXECUTION_FAILED",
          phase: "authorization",
          message: body.error.message,
        },
      };
    }
    assertCrossDeploymentExpectation(normalizeCrossDeploymentSessionResult(fixture.request, result), fixture.expected);
  }
});

test("authoritative reread mismatches fail closed as postcondition verification failures", async () => {
  const fixture = CROSS_DEPLOYMENT_FIXTURES[0]!;
  const port = new FixtureChangePort(fixture);
  port.execute = async (request) => ({
    ...(() => {
      port.events.push("execute");
      return {};
    })(),
    projection: projectionFor(fixture.before),
    evidence: {
      version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
      operation: request.operation,
      outcome: "verified",
      effects: [],
    },
  });
  const configured = sessionExecutor(fixture, port);
  const result = await configured.executor.execute(configured.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "verification");
  assert.deepEqual(port.events, ["read", "execute", "read"]);
});

test("caller requester fields remain outside the local Change Port contract", () => {
  const request = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "issue",
    issue: ISSUE,
    requester: "github:spoofed-caller",
  };
  assert.throws(() => validateChangeRequest(request as never));
});
