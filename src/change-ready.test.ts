import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  type ChangeGitHubEvidence,
  planChangeRecovery,
  planChangeIssuance,
  planChangeReadyTransition,
  planChangeTransition,
  validateChangeReadyTransition,
  type Change,
  type ChangeProjectionInput,
  type ChangeReadyEvidence,
  type ChangePullRequestEvidence,
  projectChangeFromGitHubEvidence,
} from "./change.js";
import { renderIssueArtifact, renderPullRequestArtifact } from "./artifact.js";
import {
  parseImplementationContract,
  parseImplementationIssueBody,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import { authorizeImplementation } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
  IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
} from "./implementation-execution-evidence.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";
import type { CanonicalContract } from "./contract/ir.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type IssuerRepositoryIdentity,
  type TrustedExecutionContext,
} from "./github/effect-authorizer.js";
import {
  TrustedChangeExecutor,
  ChangeTrustedExecutorError,
  type ChangeTrustedEvidenceReader,
} from "./change-trusted-executor.js";
import type { ChangeMutationRequest } from "./change-execution-port.js";
import { executeReadyWithXState } from "./change/machine/ready-execution-machine.js";
import type { GitHubOperationalPullRequestEvidence, GitHubOperationalCollection } from "./github/types.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "221000001",
  rootIssue: 221,
} as const;
const branch = "feat/221-implement-governed-change-ready-transition";
const baseBranch = "main";
const issuer = INARI_ISSUER_PRINCIPAL;
const branchGovernance = { pattern: "^(feat|fix|docs|refactor|test|chore)/[0-9]+-[a-z0-9-]+$" };
const naming = { type: "feat", slug: "implement-governed-change-ready-transition" };

function governedContract(contract: CanonicalContract): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: {
        host: identity.repositoryHost,
        owner: "acme",
        name: "inari",
        nameWithOwner: "acme/inari",
        repositoryId: identity.repositoryId,
      },
      ref: baseBranch,
      treeSha: "fixture-tree-sha",
      template: {
        path: contract.templateIdentity.path,
        ref: baseBranch,
        sha: "fixture-template-sha",
        digest: "fixture-template-digest",
      },
    },
  };
}

const issueContract = governedContract(issueContractFixture);
const pullRequestContract = governedContract(pullRequestContractFixture);
const issueBody = renderIssueArtifact(issueContract, {
  problem: "A Draft Change needs a governed Ready transition.",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
});
const pullRequestBody = renderPullRequestArtifact(pullRequestContract, {
  summary: "Complete the governed Ready transition.",
  linked_issue: "Closes #221",
  acceptance: ["tests"],
  scope: "Ready validation and trusted execution.",
});

function pullRequest(overrides: Partial<ChangePullRequestEvidence> = {}): ChangePullRequestEvidence {
  return {
    number: 2210,
    head: branch,
    base: baseBranch,
    state: "open",
    draft: true,
    merged: false,
    provenance: { issuer },
    ...overrides,
  };
}

function projectionInput(pr: ChangePullRequestEvidence = pullRequest()): ChangeProjectionInput {
  const readyEvidence: ChangeReadyEvidence = {
    issue: { contract: issueContract, body: issueBody },
    pullRequest: { contract: pullRequestContract, body: pullRequestBody },
  };
  return {
    change: identity,
    provenance: { issuer },
    branchGovernance,
    naming,
    baseBranch,
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch }] },
      pullRequests: { status: "available", value: [pr] },
    },
    readyEvidence,
  };
}

function canonicalChange(input: ChangeProjectionInput = projectionInput()): Change {
  return planChangeIssuance(input).result;
}

const implementationRepository = {
  repositoryHost: identity.repositoryHost,
  repositoryId: identity.repositoryId,
  repository: "acme/inari",
} as const;
const implementationBase = { branch: baseBranch, revision: "base-revision", freshness: "base-revision" } as const;
const implementationHeadRevision = "a".repeat(40);
const implementationBody = renderImplementationIssueBody(
  parseImplementationContract({
    version: 1,
    kind: "implementation",
    repository: implementationRepository,
    sources: [{ ...implementationRepository, number: 220 }],
    objective: "Complete the Change Ready implementation.",
    nonGoals: ["Review approval"],
    architecture: {
      decision: "Compose Implementation conformance with Change Ready.",
      affectedComponents: ["Change Core"],
      invariants: ["Change remains the lifecycle authority."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Ready is gated."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch,
      baseRevision: implementationBase.revision,
      baseFreshness: implementationBase.freshness,
      branch,
      dependencies: [{ ...implementationRepository, number: 220 }],
    },
  }),
);
const implementationAuthorization = authorizeImplementation({
  implementation: { ...implementationRepository, number: identity.rootIssue },
  body: implementationBody,
  repository: implementationRepository,
  base: implementationBase,
  readiness: {
    evidence: [
      {
        reference: { ...implementationRepository, number: 220 },
        authority: "implementation-conformance",
        status: "satisfied",
        freshness: "current",
        dependencies: [],
      },
    ],
  },
});

function operationalCollection<T>(items: readonly T[]): GitHubOperationalCollection<T> {
  return {
    status: "available",
    items,
    pagination: { perPage: 100, pages: 1, returned: items.length, truncated: false },
    diagnostics: [],
  };
}

function implementationPullRequest(
  overrides: Partial<GitHubOperationalPullRequestEvidence> = {},
): GitHubOperationalPullRequestEvidence {
  return {
    repository: { host: identity.repositoryHost, nameWithOwner: "acme/inari", repositoryId: identity.repositoryId },
    number: 2210,
    title: "Implementation Ready",
    body: pullRequestBody,
    state: "open",
    author: null,
    head: { ref: branch, sha: implementationHeadRevision },
    base: { ref: baseBranch, sha: implementationBase.revision },
    draft: true,
    labels: [],
    assignees: [],
    url: "https://github.com/acme/inari/pull/2210",
    checks: operationalCollection([]),
    requiredCheckBindings: operationalCollection([]),
    reviews: operationalCollection([]),
    comments: operationalCollection([]),
    inlineReviewComments: operationalCollection([]),
    changedFiles: operationalCollection([]),
    provenance: { provider: "github", endpoints: ["pulls/2210"] },
    ...overrides,
  };
}

function implementationConformance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pullRequestValue = implementationPullRequest();
  return {
    authorization: implementationAuthorization,
    issue: {
      reference: { ...implementationRepository, number: identity.rootIssue },
      body: implementationBody,
    },
    repository: implementationRepository,
    base: implementationBase,
    pullRequestNumber: pullRequestValue.number,
    pullRequest: pullRequestValue,
    ...overrides,
  };
}

const parsedImplementation = parseImplementationIssueBody(implementationBody);
if (parsedImplementation.contract === undefined) throw new Error("Implementation fixture must be canonical.");
const targetedImplementationContract = {
  ...parsedImplementation.contract,
  verification: { ...parsedImplementation.contract.verification, targetedTests: ["pnpm test"] },
};
const targetedImplementationBody = renderImplementationIssueBody(targetedImplementationContract);
const targetedImplementationAuthorization = authorizeImplementation({
  implementation: { ...implementationRepository, number: identity.rootIssue },
  body: targetedImplementationBody,
  repository: implementationRepository,
  base: implementationBase,
  readiness: {
    evidence: [
      {
        reference: { ...implementationRepository, number: 220 },
        authority: "implementation-conformance",
        status: "satisfied",
        freshness: "current",
        dependencies: [],
      },
    ],
  },
});

function targetedImplementationConformance(executionEvidence?: unknown): Record<string, unknown> {
  return implementationConformance({
    authorization: targetedImplementationAuthorization,
    issue: {
      reference: { ...implementationRepository, number: identity.rootIssue },
      body: targetedImplementationBody,
    },
    ...(executionEvidence === undefined ? {} : { executionEvidence }),
  });
}

function targetedExecutionEvidence(result: "satisfied" | "failed"): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation: targetedImplementationAuthorization.implementation,
    repository: targetedImplementationAuthorization.repository,
    governedBodyDigest: targetedImplementationAuthorization.governedBodyDigest,
    base: targetedImplementationAuthorization.base,
    branch,
    headRevision: implementationHeadRevision,
    targetedTests: [{ command: "pnpm test", result }],
  };
}

function nativeProjectionInput(
  pullRequestEvidence: ChangePullRequestEvidence = pullRequest({ number: 2210, headSha: implementationHeadRevision }),
  conformance: Record<string, unknown> = implementationConformance(),
  currentIssueBody: string = implementationBody,
  currentBaseRevision: string = implementationBase.revision,
): ChangeProjectionInput {
  return {
    ...projectionInput(pullRequestEvidence),
    readyEvidence: {
      pullRequest: { contract: pullRequestContract, body: pullRequestBody },
      implementationConformance: conformance,
      implementationIssueBody: currentIssueBody,
      baseRevision: currentBaseRevision,
    },
  };
}

function readyInput(input: ChangeProjectionInput = projectionInput(), change = canonicalChange(input)) {
  return {
    change,
    projection: input,
    ...(input.readyEvidence?.issue === undefined ? {} : { issue: input.readyEvidence.issue }),
    ...(input.readyEvidence?.pullRequest === undefined ? {} : { pullRequest: input.readyEvidence.pullRequest }),
    ...(input.readyEvidence?.implementationConformance === undefined
      ? {}
      : { implementationConformance: input.readyEvidence.implementationConformance }),
    ...(input.readyEvidence?.implementationIssueBody === undefined
      ? {}
      : { implementationIssueBody: input.readyEvidence.implementationIssueBody }),
    ...(input.readyEvidence?.baseRevision === undefined ? {} : { baseRevision: input.readyEvidence.baseRevision }),
  };
}

test("healthy DRAFT -> REVIEW validates every Ready precondition in Core", () => {
  const result = validateChangeReadyTransition(readyInput());
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.idempotent, false);
  assert.equal(result.change?.state, "DRAFT");
  assert.equal(result.projection?.status, "healthy");
});

test("Implementation-native Ready composes the authoritative current conformance result", () => {
  const input = nativeProjectionInput();
  const transitionInput = readyInput(input, canonicalChange(input));
  const result = validateChangeReadyTransition(transitionInput);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.idempotent, false);
  assert.deepEqual(planChangeReadyTransition(transitionInput).effects, [
    { kind: "MARK_PULL_REQUEST_READY", pullRequest: 2210 },
  ]);
});

test("Implementation-native Ready blocks the authoritative non-conformant reasons", () => {
  const cases = [
    {
      name: "scope violation",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        implementationConformance({
          pullRequest: implementationPullRequest({
            changedFiles: operationalCollection([{ filename: "outside/changed.ts", status: "modified" }]),
          }),
        }),
      ),
      reason: "IMPLEMENTATION_CONFORMANCE_SCOPE_VIOLATION",
    },
    {
      name: "failed targeted test",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        targetedImplementationConformance(targetedExecutionEvidence("failed")),
        targetedImplementationBody,
      ),
      reason: "IMPLEMENTATION_CONFORMANCE_TEST_FAILED",
    },
    {
      name: "missing targeted evidence",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        targetedImplementationConformance(),
        targetedImplementationBody,
      ),
      reason: "IMPLEMENTATION_CONFORMANCE_TEST_UNVERIFIABLE",
    },
    {
      name: "body drift",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        implementationConformance(),
        implementationBody.replace("Complete the Change Ready implementation.", "Changed objective."),
      ),
      reason: "not derived from the current Implementation body",
    },
    {
      name: "base drift",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        implementationConformance(),
        implementationBody,
        "new-base-revision",
      ),
      reason: "base evidence is stale",
    },
    {
      name: "pull-request identity mismatch",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        implementationConformance({ pullRequestNumber: 999 }),
      ),
      reason: "IMPLEMENTATION_CONFORMANCE_PR_IDENTITY_MISMATCH",
    },
    {
      // A current, otherwise-authorizable Implementation body must not admit
      // Ready merely because it looks authorizable now: Ready may only
      // consume an existing authorization it did not itself create.
      name: "no existing authorization supplied",
      input: nativeProjectionInput(
        pullRequest({ headSha: implementationHeadRevision }),
        implementationConformance({ authorization: undefined }),
      ),
      reason: "IMPLEMENTATION_AUTHORIZATION_RECORD_INVALID",
    },
  ] as const;

  for (const entry of cases) {
    const result = validateChangeReadyTransition(readyInput(entry.input, canonicalChange(entry.input)));
    assert.equal(result.valid, false, entry.name);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "CHANGE_IMPLEMENTATION_CONFORMANCE_INVALID" && diagnostic.message.includes(entry.reason),
      ),
      `${entry.name}: ${JSON.stringify(result.diagnostics)}`,
    );
  }
});

test("Implementation-native Ready admits an exact current-head retry idempotently", () => {
  const input = nativeProjectionInput(
    pullRequest({ draft: false, headSha: implementationHeadRevision }),
    implementationConformance({ pullRequest: implementationPullRequest({ draft: false }) }),
  );
  const result = validateChangeReadyTransition(readyInput(input, canonicalChange(input)));
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.idempotent, true);
});

test("Implementation-native REVIEW retry rejects a stale conformance head", () => {
  const input = nativeProjectionInput(pullRequest({ draft: false, headSha: "b".repeat(40) }));
  const result = validateChangeReadyTransition(readyInput(input, { ...canonicalChange(input), state: "REVIEW" }));
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "CHANGE_IMPLEMENTATION_CONFORMANCE_INVALID" &&
        diagnostic.message.includes("stale for the current pull-request head"),
    ),
    JSON.stringify(result.diagnostics),
  );
});

test("missing Issue/PR evidence and invalid contract evidence reject before planning", () => {
  const missing = validateChangeReadyTransition({
    change: canonicalChange(),
    projection: projectionInput(),
  });
  assert.equal(missing.valid, false);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_MISSING_PROPERTY"));

  const invalid = validateChangeReadyTransition({
    ...readyInput(),
    issue: { contract: issueContract, body: issueBody.replace("Validate all", "") },
    pullRequest: { contract: pullRequestContract, body: pullRequestBody.replace("Closes #221", "No link") },
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_PROVENANCE_INVALID_PR_CONTRACT"));
});

test("noncanonical branch/PR, issuer, base, and projection recovery drift reject", () => {
  const cases = [
    projectionInput(pullRequest({ head: "feat/221-other" })),
    projectionInput(pullRequest({ provenance: { issuer: "human:manual" } })),
    projectionInput(pullRequest({ base: "develop" })),
    {
      ...projectionInput(),
      evidence: { ...projectionInput().evidence, branches: { status: "available" as const, value: [] } },
    },
    {
      ...projectionInput(),
      readyEvidence: {
        issue: { contract: issueContract, body: issueBody },
        pullRequest: { contract: pullRequestContract, body: pullRequestBody.replace("Closes #221", "No link") },
      },
    },
  ];
  for (const input of cases) {
    assert.equal(validateChangeReadyTransition(readyInput(input, canonicalChange())).valid, false);
  }
});

test("already-ready healthy retry is idempotent and requires no effect", () => {
  const input = projectionInput(pullRequest({ draft: false }));
  const result = validateChangeReadyTransition(readyInput(input));
  assert.equal(result.valid, true);
  assert.equal(result.idempotent, true);
  assert.equal(canonicalChange(input).state, "REVIEW");
});

const target: IssuerRepositoryIdentity = {
  repositoryHost: identity.repositoryHost,
  repositoryId: identity.repositoryId,
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

class MutableReader implements ChangeTrustedEvidenceReader {
  readCount = 0;
  constructor(public current: ChangeProjectionInput) {}
  async read(_request: ChangeMutationRequest): Promise<ChangeProjectionInput> {
    this.readCount += 1;
    return this.current;
  }
}

class RereadReader extends MutableReader {
  constructor(
    current: ChangeProjectionInput,
    private readonly reread: ChangeProjectionInput,
  ) {
    super(current);
  }

  override async read(_request: ChangeMutationRequest): Promise<ChangeProjectionInput> {
    this.readCount += 1;
    return this.readCount === 1 ? this.current : this.reread;
  }
}

class FakeIssuer {
  readonly effects: string[] = [];
  fail = false;
  mutate = true;
  constructor(readonly reader: MutableReader) {}

  async applyEffects(request: IssuerMutationRequest): Promise<IssuerMutationResult> {
    const effect = request.effects[0];
    assert.ok(effect);
    this.effects.push(effect.kind);
    if (this.fail) throw new Error("provider response must not cross the boundary");
    if (this.mutate && effect.kind === "MARK_PULL_REQUEST_READY") {
      this.reader.current = {
        ...this.reader.current,
        evidence: {
          ...this.reader.current.evidence,
          pullRequests: {
            status: "available",
            value:
              this.reader.current.evidence.pullRequests?.status === "available"
                ? this.reader.current.evidence.pullRequests.value.map((candidate) => ({ ...candidate, draft: false }))
                : [],
          },
        },
      };
    }
    return {
      version: 1,
      authority: "issuer",
      issuer: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: issuer },
      repository: target,
      installation: { appId: "218", installationId: "221", repositoryHost: identity.repositoryHost },
      permissions: { pull_requests: "write" },
      effects: [{ kind: effect.kind, status: "applied" }],
    };
  }
}

function executor(reader: MutableReader, issuerAuthority: FakeIssuer): TrustedChangeExecutor {
  return new TrustedChangeExecutor({ reader, issuerAuthority, execution, target });
}

function remoteReadyRequest(): ChangeMutationRequest {
  return { version: CHANGE_TRANSITION_CONTRACT_VERSION, operation: "ready", issue: identity.rootIssue };
}

test("trusted executor applies only MARK_PULL_REQUEST_READY after Core validation", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  const result = await executor(reader, issuerAuthority).execute(remoteReadyRequest());
  assert.deepEqual(issuerAuthority.effects, ["MARK_PULL_REQUEST_READY"]);
  assert.equal(reader.readCount, 2);
  assert.equal(result.evidence?.outcome, "verified");
  assert.equal(result.projection.change?.state, "REVIEW");
});

test("invalid Ready request causes no GitHub mutation", async () => {
  const input = projectionInput(pullRequest({ base: "develop" }));
  const reader = new MutableReader(input);
  const issuerAuthority = new FakeIssuer(reader);
  await assert.rejects(
    executor(reader, issuerAuthority).execute(remoteReadyRequest()),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED",
  );
  assert.deepEqual(issuerAuthority.effects, []);
});

test("Ready execution delegates lifecycle admission to the canonical machine", async () => {
  const projected = projectChangeFromGitHubEvidence(projectionInput());
  assert.ok(projected.change);
  const rejectedProjection = {
    ...projected,
    change: { ...projected.change, state: "ABORTED" as const },
  };
  let validationInputCalled = false;
  let planCalled = false;

  const outcome = await executeReadyWithXState({
    request: remoteReadyRequest(),
    read: async () => ({ ok: true as const, input: projectionInput() }),
    apply: async () => ({ ok: true as const }),
    failureForEffect: () => ({ code: "PULL_REQUEST_READY_FAILED", message: "bounded" }),
    semantics: {
      project: () => rejectedProjection,
      validationInput: () => {
        validationInputCalled = true;
        return {};
      },
      validate: () => ({ valid: true, diagnostics: [] }),
      plan: () => {
        planCalled = true;
        throw new Error("lifecycle rejection must stop before planning");
      },
      verify: () => ({ valid: true, diagnostics: [] }),
    },
    results: {
      returnedExisting: (projection) => ({ projection }),
      verified: (projection) => ({ projection }),
      failed: (projection) => ({ projection }),
    },
  });

  assert.equal(outcome.kind, "failure");
  if (outcome.kind !== "failure") throw new Error("expected lifecycle rejection");
  assert.equal(outcome.failure.code, "CHANGE_EXECUTION_PRECONDITION_FAILED");
  assert.equal(outcome.failure.diagnostics[0]?.code, "CHANGE_TRANSITION_NOT_ALLOWED");
  assert.equal(validationInputCalled, false);
  assert.equal(planCalled, false);
});

test("trusted executor treats a healthy already-ready retry as a no-op", async () => {
  const reader = new MutableReader(projectionInput(pullRequest({ draft: false })));
  const issuerAuthority = new FakeIssuer(reader);
  const result = await executor(reader, issuerAuthority).execute(remoteReadyRequest());
  assert.deepEqual(issuerAuthority.effects, []);
  assert.equal(reader.readCount, 2);
  assert.equal(result.evidence?.outcome, "returned-existing");
  assert.equal(result.projection.change?.state, "REVIEW");
});

test("mutation failure is bounded and never reported as success", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  issuerAuthority.fail = true;
  const result = await executor(reader, issuerAuthority).execute(remoteReadyRequest());
  assert.equal(result.evidence?.outcome, "failed");
  assert.equal(result.evidence?.failure?.code, "PULL_REQUEST_READY_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /provider response|token|privateKey/iu);
});

test("post-effect projection verification failure is deterministic and bounded", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  issuerAuthority.mutate = false;
  await assert.rejects(
    executor(reader, issuerAuthority).execute(remoteReadyRequest()),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  );
  assert.deepEqual(issuerAuthority.effects, ["MARK_PULL_REQUEST_READY"]);
});

test("Ready fails closed when the required reread is unavailable or malformed", async () => {
  const rereads: readonly [string, ChangeProjectionInput][] = [
    [
      "unavailable",
      {
        ...projectionInput(),
        evidence: {
          ...projectionInput().evidence,
          branches: { status: "unavailable", reason: "reread unavailable" },
        },
      },
    ],
    [
      "malformed",
      {
        ...projectionInput(),
        evidence: {
          ...projectionInput().evidence,
          branches: {
            status: "available",
            value: "not-a-branch-list",
          } as unknown as ChangeGitHubEvidence["branches"],
        },
      },
    ],
  ];

  for (const [name, reread] of rereads) {
    const reader = new RereadReader(projectionInput(), reread);
    const issuerAuthority = new FakeIssuer(reader);
    await assert.rejects(
      executor(reader, issuerAuthority).execute(remoteReadyRequest()),
      (error: unknown) => error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_READ_FAILED",
      name,
    );
    assert.deepEqual(issuerAuthority.effects, ["MARK_PULL_REQUEST_READY"], name);
    assert.equal(reader.readCount, 2, name);
  }
});

test("requester and issuer provenance remain separate through Ready", async () => {
  const reader = new MutableReader(projectionInput());
  const issuerAuthority = new FakeIssuer(reader);
  const result = await new TrustedChangeExecutor({
    reader,
    issuerAuthority,
    execution: { ...execution, requester: "agent:implementation" },
    target,
  }).execute(remoteReadyRequest());
  assert.equal(result.evidence?.requester, "agent:implementation");
  assert.equal(result.evidence?.issuer, issuer);
  assert.equal(result.projection.change?.provenance.requester, "agent:implementation");
  assert.equal(result.projection.change?.provenance.issuer, issuer);
  assert.equal(result.projection.change?.provenance.implementer, undefined);
  assert.equal(result.projection.change?.provenance.reviewer, undefined);
  assert.equal(result.projection.change?.version, CHANGE_CONTRACT_VERSION);
});

test("Ready addition preserves the Abort recovery plan", () => {
  const change = canonicalChange();
  const transition = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "abort",
    change,
  });
  const recovery = planChangeRecovery({
    transition,
    attemptedEffects: [
      { effect: transition.effects[0]!, status: "succeeded" as const },
      { effect: transition.effects[1]!, status: "failed" as const },
    ],
    failure: {
      effect: transition.effects[1]!,
      code: "BRANCH_DELETE_FAILED",
      message: "The branch deletion effect failed.",
    },
    projection: projectionInput(pullRequest({ state: "closed", draft: false })),
  });

  assert.equal(recovery.operation, "recover-transition");
  if (recovery.operation !== "recover-transition") throw new Error("expected Abort transition recovery");
  assert.deepEqual(recovery.effects, [{ kind: "DELETE_BRANCH", branch }]);
});

test("Abort addition preserves the healthy Ready retry no-op", () => {
  const input = projectionInput(pullRequest({ draft: false }));
  const change = canonicalChange(input);
  const readyPlan = planChangeReadyTransition(readyInput(input, change));

  assert.deepEqual(readyPlan.effects, []);
  assert.equal(readyPlan.from, "REVIEW");
  assert.equal(readyPlan.to, "REVIEW");
});

test("RECOVERY_REQUIRED and ABORTED Changes cannot enter Ready", () => {
  for (const state of ["RECOVERY_REQUIRED", "ABORTED"] as const) {
    const result = validateChangeReadyTransition(readyInput(projectionInput(), { ...canonicalChange(), state }));
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.length > 0);
    assert.throws(() => planChangeReadyTransition(readyInput(projectionInput(), { ...canonicalChange(), state })));
  }
});
