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
  normalizeCrossDeploymentError,
  normalizeCrossDeploymentFailure,
  normalizeCrossDeploymentSessionResult,
  type CrossDeploymentFixture,
  type CrossDeploymentOperation,
  type CrossDeploymentSemanticResult,
} from "./cross-deployment-conformance.js";
import { CROSS_DEPLOYMENT_FIXTURES } from "./cross-deployment-conformance-fixtures.js";
import {
  CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
  ChangeExecutionPortError,
  changeMutationRequest,
  hasCallerSuppliedRequester,
  validateChangeRequest,
  type ChangeExecutionPort,
  type ChangeMutation,
  type ChangeMutationRequest,
  type ChangeReadRequest,
} from "./change-execution-port.js";
import {
  projectChangeFromGitHubEvidence,
  type ChangeEffect,
  type ChangeEffectSuccessEvidence,
  type ChangeProjectionInput,
  type ChangeProjectionResult,
} from "./change.js";
import {
  createActionsChangeExecutionAdapter,
  type ActionsChangeExecutionAdapterApi,
} from "./github/actions-change-execution-adapter.js";
import { asTrustedActionsFailure } from "./github/actions-change-executor.js";
import type { GitHubAppRepositoryReadCapability } from "./github/app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./github/change-effect-adapter.js";
import type { RepositoryContext, RepositoryTree } from "./github/types.js";
import { createMcpSessionAppBridge } from "./mcp/session-app-bridge.js";
import {
  createCapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedSessionExecutor,
  type CapabilityAuthorizedSessionExecutorOptions,
  type CapabilityAuthorizedSessionExecutionResult,
  type SessionExecutionPhase,
} from "./session-authorized-change-executor.js";
import {
  TrustedChangeExecutor,
  ChangeTrustedExecutorError,
  type ChangeTrustedEvidenceReader,
} from "./change-trusted-executor.js";
import {
  EFFECT_AUTHORIZER_CONTRACT_VERSION,
  INARI_ISSUER_PRINCIPAL,
  type EffectAuthorizerMutationRequest,
  type EffectAuthorizerMutationResult,
  type RepositoryIdentity,
  type TrustedExecutionContext,
} from "./github/effect-authorizer.js";
import { renderIssueArtifact } from "./artifact.js";
import { issueContractFixture } from "./contract/fixtures.js";

const ISSUE = 553;
const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const REPOSITORY_ID = "553000001";
const TARGET: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: REPOSITORY_ID,
  nameWithOwner: "acme/inari",
};
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
const BRANCH = "feat/553-cross-deployment-conformance";
const PULL_REQUEST = 5530;
const CREATED_COMMIT_SHA = "e".repeat(40);

/** The same trusted-execution claim every profile's real trusted core runs under. */
const TRUSTED_EXECUTION: TrustedExecutionContext = {
  version: 1,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository: TARGET,
  workflowRef: "refs/heads/main",
  workflowSha: POLICY_SHA,
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
};

const TRUSTED_LOCAL_EXECUTION: TrustedExecutionContext = {
  ...TRUSTED_EXECUTION,
  requester: "user:trusted-local",
};

const ACTIONS_EXECUTION: TrustedExecutionContext = {
  ...TRUSTED_EXECUTION,
  requester: "github:authenticated-actions-actor",
};

/** Which effect a fixture's Authority evidence implies fails during application. */
const FIXTURE_FAILING_EFFECT: Readonly<Record<string, ChangeEffect["kind"]>> = {
  "abort-compensation-recovery": "DELETE_BRANCH",
};

/** The inverse of the real Direct App HTTP boundary's `ERROR_CODE_BY_PHASE` map. */
const DIRECT_APP_PHASE_BY_ERROR_CODE: Readonly<Record<string, SessionExecutionPhase>> = {
  SESSION_AUTHENTICATION_FAILED: "authentication",
  SESSION_REQUEST_INVALID: "request",
  SESSION_AUTHORIZATION_DENIED: "authorization",
  SESSION_EVIDENCE_UNAVAILABLE: "evidence",
  SESSION_EXECUTION_FAILED: "execution",
  SESSION_STATE_CONFLICT: "conflict",
  SESSION_VERIFICATION_FAILED: "verification",
  SESSION_RECOVERY_REQUIRED: "recovery-required",
};

function projectionFor(snapshot: CrossDeploymentFixture["before"]): ChangeProjectionResult {
  return projectChangeFromGitHubEvidence(evidenceInput(snapshot));
}

/** The bounded reader input a real trusted execution boundary is handed. */
function evidenceInput(snapshot: CrossDeploymentFixture["before"]): ChangeProjectionInput {
  return {
    change: snapshot.identity,
    ...(snapshot.branchGovernance === undefined ? {} : { branchGovernance: snapshot.branchGovernance }),
    naming: snapshot.naming as { readonly type: "feat"; readonly slug: string },
    baseBranch: snapshot.baseBranch,
    evidence: snapshot.evidence,
  };
}

function successEvidenceFor(effect: ChangeEffect): ChangeEffectSuccessEvidence {
  switch (effect.kind) {
    case "CREATE_BRANCH":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        createdCommitSha: CREATED_COMMIT_SHA,
      };
    case "CREATE_PROVENANCE_COMMIT":
      return {
        kind: effect.kind,
        branch: effect.branch,
        rootIssue: effect.rootIssue,
        path: effect.path,
        createdCommitSha: CREATED_COMMIT_SHA,
      };
    case "CREATE_PULL_REQUEST":
      return {
        kind: effect.kind,
        branch: effect.branch,
        baseBranch: effect.baseBranch,
        rootIssue: effect.rootIssue,
        pullRequest: PULL_REQUEST,
      };
    case "MARK_PULL_REQUEST_READY":
    case "CLOSE_PULL_REQUEST":
      return { kind: effect.kind, pullRequest: effect.pullRequest };
    case "DELETE_BRANCH":
      return effect.expectedCommitSha === undefined
        ? { kind: effect.kind, branch: effect.branch }
        : {
            kind: effect.kind,
            branch: effect.branch,
            expectedCommitSha: effect.expectedCommitSha,
            outcome: "deleted",
          };
  }
}

/**
 * Reads whatever Authority evidence the fixture currently claims. It starts
 * at `fixture.before` and only ever advances to `fixture.after` when the
 * fixture's effect authorizer reports a real applied effect - it never
 * decides the semantic outcome itself.
 */
class FixtureEvidenceReader implements ChangeTrustedEvidenceReader {
  current: ChangeProjectionInput;
  reads = 0;

  constructor(private readonly fixture: CrossDeploymentFixture) {
    this.current = evidenceInput(fixture.before);
  }

  async read(_request: ChangeMutationRequest | ChangeReadRequest): Promise<ChangeProjectionInput> {
    this.reads += 1;
    return this.current;
  }
}

/** Applies one effect per fixture's evidence, failing only the effect the fixture designates. */
class FixtureEffectAuthorizer {
  constructor(
    private readonly reader: FixtureEvidenceReader,
    private readonly fixture: CrossDeploymentFixture,
    private readonly failEffect?: ChangeEffect["kind"],
  ) {}

  async applyEffects(request: EffectAuthorizerMutationRequest): Promise<EffectAuthorizerMutationResult> {
    const effect = request.effects[0];
    assert.ok(effect);
    if (effect.kind === this.failEffect) {
      throw new Error("Fixture effect failed for deterministic recovery coverage.");
    }
    this.reader.current = evidenceInput(this.fixture.after ?? this.fixture.before);
    return {
      version: EFFECT_AUTHORIZER_CONTRACT_VERSION,
      authority: "issuer",
      issuer: { kind: "github-app", slug: "inari-issuer", appId: APP.appId, principal: INARI_ISSUER_PRINCIPAL },
      repository: TARGET,
      installation: { appId: APP.appId, installationId: APP.installationId, repositoryHost: TARGET.repositoryHost },
      permissions: {},
      effects: [{ kind: effect.kind, status: "applied", evidence: successEvidenceFor(effect) }],
    };
  }
}

/** Builds a fresh instance of the real trusted execution boundary from one fixture's evidence. */
function createTrustedAdapter(
  fixture: CrossDeploymentFixture,
  execution: TrustedExecutionContext = TRUSTED_EXECUTION,
): {
  readonly adapter: ChangeExecutionPort;
  readonly reader: FixtureEvidenceReader;
} {
  const reader = new FixtureEvidenceReader(fixture);
  const effectAuthorizer = new FixtureEffectAuthorizer(reader, fixture, FIXTURE_FAILING_EFFECT[fixture.name]);
  const adapter = new TrustedChangeExecutor({ reader, effectAuthorizer, execution, target: TARGET });
  return { adapter, reader };
}

function governedIssueEvidence(treeSha: string) {
  const contract = {
    ...issueContractFixture,
    provenance: {
      authority: "repository-default-branch" as const,
      repository: {
        host: "github.com",
        owner: "acme",
        name: "inari",
        nameWithOwner: "acme/inari",
        repositoryId: REPOSITORY_ID,
      },
      ref: "main",
      treeSha,
      template: {
        path: issueContractFixture.templateIdentity.path,
        ref: "main",
        sha: `issue-template-${treeSha}`,
        digest: `issue-template-digest-${treeSha}`,
      },
    },
  };
  const body = renderIssueArtifact(contract, {
    problem: "A governed Change root Issue.",
    category: "feature",
    affected_areas: ["contracts"],
    acceptance: ["tests"],
  });
  return { contract, body };
}

/**
 * Reads a distinct Governance Canon generation on the initial read versus the
 * fresh read a real Change issuance attempt takes right before planning. The
 * production drift check in the trusted execution boundary - not this test -
 * decides whether that difference is a failure.
 */
class DriftEvidenceReader implements ChangeTrustedEvidenceReader {
  readonly requiresGovernedIssueValidation = true;
  #reads = 0;

  constructor(
    private readonly initialTreeSha: string,
    private readonly freshTreeSha: string,
  ) {}

  async read(_request: ChangeMutationRequest | ChangeReadRequest): Promise<ChangeProjectionInput> {
    this.#reads += 1;
    // Some transports (Direct App/MCP) read once themselves before handing
    // off to the trusted core, so the trusted core's own two reads do not
    // always land on call #1/#2. Every call after the first gets its own
    // distinct value so the trusted core's initial and fresh reads always
    // differ from each other, whichever call indices they land on.
    const treeSha = this.#reads === 1 ? this.initialTreeSha : `${this.freshTreeSha}-r${this.#reads}`;
    return {
      change: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, rootIssue: ISSUE },
      branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
      naming: { type: "feat", slug: "cross-deployment-conformance" },
      baseBranch: "main",
      evidence: {
        issue: { status: "available", value: { number: ISSUE, state: "open" } },
        branches: { status: "absent" },
        pullRequests: { status: "absent" },
      },
      governedIssue: governedIssueEvidence(treeSha),
    };
  }
}

function createDriftAdapter(
  fixture: CrossDeploymentFixture,
  execution: TrustedExecutionContext = TRUSTED_EXECUTION,
): { readonly adapter: ChangeExecutionPort } {
  const reader = new DriftEvidenceReader(
    fixture.before.generation,
    fixture.after?.generation ?? fixture.before.generation,
  );
  const effectAuthorizer = {
    applyEffects: async (): Promise<EffectAuthorizerMutationResult> => {
      throw new Error("A governance-drift fixture must fail before any effect is attempted.");
    },
  };
  const adapter = new TrustedChangeExecutor({ reader, effectAuthorizer, execution, target: TARGET });
  return { adapter };
}

function buildFixtureAdapter(
  fixture: CrossDeploymentFixture,
  execution: TrustedExecutionContext = TRUSTED_EXECUTION,
): { readonly adapter: ChangeExecutionPort } {
  return fixture.name === "stale-authority-generation"
    ? createDriftAdapter(fixture, execution)
    : createTrustedAdapter(fixture, execution);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustedFailurePhase(code: string | undefined): string {
  return code === "CHANGE_EXECUTION_PRECONDITION_FAILED" ? "conflict" : "execution";
}

/**
 * Normalizes whatever the real trusted execution boundary (or its Actions
 * transport wrapper) actually threw. It classifies phase/admission from the
 * error's own code and carries the error's own diagnostics through; it never
 * substitutes a diagnostic no production code produced.
 */
function normalizeTrustedFailure(
  operation: CrossDeploymentOperation,
  error: unknown,
  requesterBinding?: CrossDeploymentSemanticResult["requesterBinding"],
): CrossDeploymentSemanticResult {
  if (error instanceof ChangeTrustedExecutorError) {
    return normalizeCrossDeploymentFailure(
      operation,
      trustedFailurePhase(error.code),
      error.diagnostics.map((item) => ({ code: item.code, path: item.path, message: item.message })),
      requesterBinding,
    );
  }
  if (
    error instanceof ChangeExecutionPortError &&
    isRecord(error.details) &&
    typeof error.details.trustedCode === "string"
  ) {
    return normalizeCrossDeploymentFailure(
      operation,
      trustedFailurePhase(error.details.trustedCode),
      (error.diagnostics ?? []).map((item) => ({ code: item.code, path: item.path, message: item.message })),
      requesterBinding,
    );
  }
  return normalizeCrossDeploymentError(operation, error, requesterBinding);
}

class FixtureActionsApi implements ActionsChangeExecutionAdapterApi {
  readonly calls: Array<{ readonly method: "GET" | "POST"; readonly path: string }> = [];
  readonly #content: unknown;
  #runReads = 0;

  constructor(content: unknown) {
    this.#content = content;
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
              display_title: "Inari Change 00000000-0000-4000-8000-000000000000",
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
            display_title: `Inari Change ${CORRELATION}`,
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
    return archive(this.#content);
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
  changeExecutor: ChangeExecutionPort,
  options: { readonly requester?: string; readonly capability?: CapabilityClaim } = {},
): { readonly executor: CapabilityAuthorizedSessionExecutor; readonly envelope: unknown } {
  const signed = signedSession(fixture, options);
  return {
    executor: createCapabilityAuthorizedSessionExecutor({
      authentication: signed.authentication,
      changeExecutor,
      app: APP,
    }),
    envelope: signed.envelope,
  };
}

async function runTrustedLocal(
  fixture: CrossDeploymentFixture,
  adapter: ChangeExecutionPort,
): Promise<CrossDeploymentSemanticResult> {
  const request = changeMutationRequest(fixture.request.operation as ChangeMutation, ISSUE);
  try {
    return normalizeCrossDeploymentChangeResult(fixture.request, await adapter.execute(request));
  } catch (error: unknown) {
    return normalizeTrustedFailure(fixture.request.operation, error);
  }
}

async function runActions(
  fixture: CrossDeploymentFixture,
  adapter: ChangeExecutionPort,
): Promise<CrossDeploymentSemanticResult> {
  const request = changeMutationRequest(fixture.request.operation as ChangeMutation, ISSUE);
  let content: unknown;
  try {
    content = await adapter.execute(request);
  } catch (error: unknown) {
    const mapped = asTrustedActionsFailure(error, undefined);
    content = {
      ok: false,
      error: {
        code: mapped.code,
        message: "Trusted Change execution failed closed.",
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      },
    };
  }
  const api = new FixtureActionsApi(content);
  const remote = createActionsChangeExecutionAdapter({
    cwd: process.cwd(),
    api,
    randomUUID: () => CORRELATION,
    maxPollAttempts: 2,
    pollIntervalMs: 0,
    sleep: async () => undefined,
  });
  try {
    const adapted = await remote.execute(request);
    assert.ok(api.calls.some((call) => call.method === "POST"));
    return normalizeCrossDeploymentChangeResult(fixture.request, adapted);
  } catch (error: unknown) {
    assert.ok(api.calls.some((call) => call.method === "POST"));
    return normalizeTrustedFailure(fixture.request.operation, error);
  }
}

async function runSessionProfile(
  fixture: CrossDeploymentFixture,
  profile: "direct-app" | "mcp",
  adapter: ChangeExecutionPort,
): Promise<CrossDeploymentSemanticResult> {
  const configured = sessionExecutor(fixture, adapter);
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
  // The real Direct App HTTP boundary's error `code` is a fixed, bijective
  // encoding of the session execution phase (see `ERROR_CODE_BY_PHASE` in
  // agent-authority/direct-app-http.ts); decode it back and carry through
  // both `diagnostics` and `evidence` exactly as that boundary returned them
  // rather than collapsing every non-recovery failure into one generic phase.
  const phase = DIRECT_APP_PHASE_BY_ERROR_CODE[body.error.code] ?? "execution";
  const failed: CapabilityAuthorizedSessionExecutionResult = {
    version: 1,
    status: "failed",
    operation: body.operation,
    failure: {
      code: "SESSION_EXECUTION_FAILED",
      phase,
      message: body.error.message,
      ...(body.error.diagnostics === undefined ? {} : { diagnostics: body.error.diagnostics }),
      ...(body.error.evidence === undefined ? {} : { evidence: body.error.evidence }),
    },
  };
  return normalizeCrossDeploymentSessionResult(fixture.request, failed);
}

async function runProfile(
  profile: "trusted-local" | "actions" | "direct-app" | "mcp",
  fixture: CrossDeploymentFixture,
): Promise<CrossDeploymentSemanticResult> {
  const execution = profile === "trusted-local" ? TRUSTED_LOCAL_EXECUTION : ACTIONS_EXECUTION;
  const { adapter } = buildFixtureAdapter(fixture, execution);
  if (profile === "trusted-local") return runTrustedLocal(fixture, adapter);
  if (profile === "actions") return runActions(fixture, adapter);
  return runSessionProfile(fixture, profile, adapter);
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

test("requester spoofing is rejected before semantic admission in every deployment profile", async () => {
  const fixture = CROSS_DEPLOYMENT_FIXTURES[0]!;
  const spoofedRequester = "github:spoofed-caller";

  for (const profile of ["trusted-local", "actions", "direct-app", "mcp"] as const) {
    if (profile === "direct-app" || profile === "mcp") {
      const { adapter, reader } = createTrustedAdapter(fixture, ACTIONS_EXECUTION);
      const configured = sessionExecutor(fixture, adapter, { requester: spoofedRequester });
      const result = await configured.executor.execute(configured.envelope);
      assert.equal(result.status, "failed", profile);
      assert.equal(result.failure?.phase, "request", profile);
      assert.equal(reader.reads, 0, profile);
      assert.equal(JSON.stringify(result).includes(spoofedRequester), false, profile);
      continue;
    }

    const { adapter, reader } = createTrustedAdapter(
      fixture,
      profile === "trusted-local" ? TRUSTED_LOCAL_EXECUTION : ACTIONS_EXECUTION,
    );
    const request = {
      ...changeMutationRequest(fixture.request.operation as ChangeMutation, ISSUE),
      requester: spoofedRequester,
    } as unknown as ChangeMutationRequest;
    await assert.rejects(
      adapter.execute(request),
      (error: unknown) =>
        error instanceof ChangeTrustedExecutorError &&
        error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED" &&
        error.diagnostics.some((item) => item.code === "CHANGE_PROVENANCE_CONFLICT" && item.path === "$.requester"),
      profile,
    );
    assert.equal(reader.reads, 0, profile);
  }

  const normal = sessionExecutor(fixture, createTrustedAdapter(fixture).adapter);
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
    const { adapter } = createTrustedAdapter(fixture);
    const configured = sessionExecutor(fixture, adapter, { capability: wrongCapability });
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
  let readCalls = 0;
  let executeCalls = 0;
  const port: ChangeExecutionPort = {
    async read(_request) {
      readCalls += 1;
      return projectionFor(fixture.before);
    },
    async execute(request) {
      executeCalls += 1;
      return {
        projection: projectionFor(fixture.before),
        evidence: {
          version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
          operation: request.operation,
          outcome: "verified",
          effects: [],
        },
      };
    },
  };
  const configured = sessionExecutor(fixture, port);
  const result = await configured.executor.execute(configured.envelope);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.phase, "verification");
  assert.equal(readCalls, 2);
  assert.equal(executeCalls, 1);
});

test("caller requester fields remain outside the local Change Port contract", () => {
  const request = {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "issue",
    issue: ISSUE,
    requester: "github:spoofed-caller",
  };
  assert.throws(() => validateChangeRequest(request as never));

  const inherited = Object.create({ requester: "github:inherited-spoof" }) as Record<string, unknown>;
  Object.assign(inherited, {
    version: CHANGE_EXECUTION_PORT_CONTRACT_VERSION,
    operation: "issue",
    issue: ISSUE,
  });
  assert.equal(hasCallerSuppliedRequester(inherited), true);
  assert.throws(() => validateChangeRequest(inherited as never));
});
