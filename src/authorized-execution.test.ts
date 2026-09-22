import assert from "node:assert/strict";
import { test } from "node:test";
import type { BranchAdvanceSemanticRequest } from "./agent-authority/branch-advance.js";
import { validateCapabilityClaim, type CapabilityClaim } from "./agent-authority/capability.js";
import { createCapabilityExecutionProvenance } from "./agent-authority/capability-provenance.js";
import { projectChangeFromGitHubEvidence, type ChangeGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import { changeMutationRequest, type ChangeExecutionPort } from "./change-execution-port.js";
import { assertTrustedExecution, INARI_ISSUER_PRINCIPAL, type RepositoryIdentity } from "./github/effect-authorizer.js";
import {
  createAuthorizedExecution,
  executeAuthorizedExecution,
  type AuthorizedExecution,
  type AuthorizedExecutionOperation,
} from "./authorized-execution.js";
import type { PrPublicationRequest } from "./pr-publication.js";

const ISSUE = 465;
const REPOSITORY: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "123456789",
  nameWithOwner: "acme/inari",
};
const BRANCH = "feat/465-post-admission-execution";
const APP = {
  kind: "github-app" as const,
  slug: "inari-issuer" as const,
  appId: "123",
  principal: "app:inari-issuer" as const,
  installationId: "456",
};

function claim(input: unknown): CapabilityClaim {
  const result = validateCapabilityClaim(input);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.value);
  return result.value;
}

function projection(kind: "absent" | "draft"): ChangeProjectionResult {
  const evidence: ChangeGitHubEvidence = {
    issue: { status: "available", value: { number: ISSUE, state: "open" } },
    branches:
      kind === "absent"
        ? { status: "absent" }
        : { status: "available", value: [{ name: BRANCH, sha: "d".repeat(40), rootIssue: ISSUE }] },
    pullRequests:
      kind === "absent"
        ? { status: "absent" }
        : {
            status: "available",
            value: [
              {
                number: 4650,
                head: BRANCH,
                base: "main",
                state: "open",
                draft: true,
                merged: false,
                rootIssue: ISSUE,
                provenance: { issuer: INARI_ISSUER_PRINCIPAL },
              },
            ],
          },
  };
  return projectChangeFromGitHubEvidence({
    change: { repositoryHost: REPOSITORY.repositoryHost, repositoryId: REPOSITORY.repositoryId, rootIssue: ISSUE },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "post-admission-execution" },
    baseBranch: "main",
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    evidence,
  });
}

function publicationRequest(): PrPublicationRequest {
  const repository = {
    repositoryHost: REPOSITORY.repositoryHost,
    repositoryId: REPOSITORY.repositoryId,
    repository: REPOSITORY.nameWithOwner,
  };
  const implementation = { ...repository, number: ISSUE };
  return {
    version: 1,
    kind: "pr-publication",
    repository,
    workIdentity: { implementation },
    routing: {
      version: 1,
      kind: "integration-routing",
      mode: "standalone",
      role: "implementation",
      implementation,
      relationships: {},
      branches: { default: "main", implementation: BRANCH },
      head: BRANCH,
      base: "main",
    },
    headRevision: "d".repeat(40),
    title: "feat: post-admission execution",
    body: "Closes #465",
  };
}

function authorized(
  operation: AuthorizedExecutionOperation,
  request: unknown,
  capabilityInput: unknown,
  subject: AuthorizedExecution["subject"],
): AuthorizedExecution {
  const capability = claim(capabilityInput);
  const requestId = `request-${operation.replaceAll(".", "-")}`;
  const provenance = createCapabilityExecutionProvenance({
    version: 1,
    stage: "authorized",
    repository: REPOSITORY,
    runtimeAuthority: { id: "runtime-local-test", kid: "delegator-key" },
    session: { id: "session-local-test", certificateJti: "certificate-local-test" },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    request: { requestId, operation, issuedAt: 1_800_000_000, expiresAt: 1_800_000_060 },
    subject,
    capability,
  });
  const common = {
    version: 1 as const,
    operation,
    repository: REPOSITORY,
    task: { kind: "issue" as const, number: ISSUE },
    subject,
    capability,
    provenance,
  };
  if (operation === "branch.advance") {
    return createAuthorizedExecution({ ...common, operation, request: request as BranchAdvanceSemanticRequest });
  }
  if (operation === "pullRequest.publish") {
    return createAuthorizedExecution({
      ...common,
      operation,
      request: request as PrPublicationRequest,
      execution: assertTrustedExecution({
        version: 1,
        runtime: "inari-app",
        event: "session-request",
        repository: REPOSITORY,
        requestId,
        sessionId: provenance.session.id,
        certificateJti: provenance.session.certificateJti,
        requester: `session:${provenance.session.id}`,
      }),
    });
  }
  if (operation === "change.show") {
    return createAuthorizedExecution({
      ...common,
      operation,
      request: { version: 1, operation: "show", issue: ISSUE },
      initialProjection: projection("draft"),
    });
  }
  const mutation = request as ReturnType<typeof changeMutationRequest>;
  return createAuthorizedExecution({
    ...common,
    operation,
    request: mutation,
    execution: assertTrustedExecution({
      version: 1,
      runtime: "inari-app",
      event: "session-request",
      repository: REPOSITORY,
      requestId,
      sessionId: provenance.session.id,
      certificateJti: provenance.session.certificateJti,
      requester: `session:${provenance.session.id}`,
    }),
  });
}

class FakeChangeExecutor implements ChangeExecutionPort {
  readonly events: string[] = [];

  async execute(): Promise<ChangeProjectionResult> {
    this.events.push("execute");
    return projection("draft");
  }

  async read(): Promise<ChangeProjectionResult> {
    this.events.push("read");
    return projection("draft");
  }
}

test("executes Change work after receiving only an authorized domain context", async () => {
  const executor = new FakeChangeExecutor();
  const input = authorized(
    "change.issue",
    changeMutationRequest("issue", ISSUE),
    { kind: "change.implement", issue: ISSUE },
    { kind: "change", issue: ISSUE },
  );
  const result = await executeAuthorizedExecution(input, { changeExecutor: executor, app: APP });

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.provenance?.stage, "verified");
  assert.deepEqual(executor.events, ["execute", "read"]);
  assert.equal(JSON.stringify(input).includes("provider-token"), false);
  assert.equal("credential" in input, false);
});

test("executes branch advancement and publication through their existing delegates", async () => {
  const branchRequest = {
    version: 1,
    issue: ISSUE,
    branch: BRANCH,
    expectedHead: "d".repeat(40),
    changes: [
      {
        operation: "upsert",
        path: "src/session.txt",
        mode: "100644",
        content: Buffer.from("after").toString("base64"),
      },
    ],
    commit: { message: "bounded test commit", author: { name: "Test Author", email: "test@example.test" } },
  };
  const branchCapability = { kind: "branch.advance", branch: BRANCH, pathPolicy: "src/**" };
  const branchInput = authorized("branch.advance", branchRequest, branchCapability, {
    kind: "branch",
    issue: ISSUE,
    branch: BRANCH,
  });
  let branchCalls = 0;
  const branchResult = await executeAuthorizedExecution(branchInput, {
    branchAdvance: async ({ request }) => {
      branchCalls += 1;
      const verified = createCapabilityExecutionProvenance({
        ...branchInput.provenance,
        stage: "verified",
        app: APP,
      });
      return {
        version: 1,
        operation: "branch.advance",
        status: "succeeded",
        outcome: "advanced",
        branch: request.branch,
        expectedHead: request.expectedHead,
        resultingHead: "e".repeat(40),
        provenance: verified,
      };
    },
  });
  assert.equal(branchResult.status, "succeeded", JSON.stringify(branchResult));
  assert.equal(branchCalls, 1);

  const pub = publicationRequest();
  const pubInput = authorized(
    "pullRequest.publish",
    pub,
    { kind: "pullRequest.create", head: BRANCH, base: "main", max: 1 },
    { kind: "pullRequest", issue: ISSUE, head: BRANCH, base: "main" },
  );
  let publicationCalls = 0;
  const publication = await executeAuthorizedExecution(pubInput, {
    publishPullRequest: async ({ request }) => {
      publicationCalls += 1;
      assert.equal(request.expectedHead, BRANCH);
      return {
        app: APP,
        publication: {
          version: 1,
          kind: "pr-publication",
          ok: true,
          classification: "created",
          outcome: "created",
          pullRequest: { number: 42, url: "https://github.com/acme/inari/pull/42" },
          diagnostics: [],
          effects: [{ kind: "CREATE_PULL_REQUEST", status: "succeeded" }],
        },
      };
    },
  });
  assert.equal(publication.status, "succeeded", JSON.stringify(publication));
  assert.equal(publicationCalls, 1);
});

test("malformed or caller-authored authorization data fails closed before delegates run", async () => {
  const executor = new FakeChangeExecutor();
  const valid = authorized(
    "change.issue",
    changeMutationRequest("issue", ISSUE),
    { kind: "change.implement", issue: ISSUE },
    { kind: "change", issue: ISSUE },
  );
  const malformed = [
    { ...valid },
    { ...valid, credential: { accessToken: "provider-token" } },
    { ...valid, provenance: { ...valid.provenance, stage: "authenticated" } },
    { ...valid, version: 2 },
    { ...valid, capability: { kind: "change.implement", issue: ISSUE + 1 } },
    { ...valid, operation: "command.run" },
  ];
  for (const input of malformed) {
    const result = await executeAuthorizedExecution(input, { changeExecutor: executor, app: APP });
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.phase, "authorization");
  }
  assert.deepEqual(executor.events, []);
});
