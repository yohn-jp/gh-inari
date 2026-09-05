import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  type ChangeGitHubEvidence,
  type ChangeProjectionInput,
  type ChangeEffect,
} from "./change.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type IssuerRepositoryIdentity,
  type TrustedExecutionContext,
} from "./github/issuer-authority.js";
import {
  TrustedChangeExecutor,
  ChangeTrustedExecutorError,
  type ChangeTrustedEvidenceReader,
} from "./change-trusted-executor.js";
import type { ChangeRemoteMutationRequest } from "./change-executor.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "218000001",
  rootIssue: 218,
} as const;
const branch = "feat/218-execute-change-plans-through-trusted-github-actions";
const target: IssuerRepositoryIdentity = {
  repositoryHost: "github.com",
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

function evidence(
  branches: readonly string[],
  pullRequests: ChangeGitHubEvidence["pullRequests"] = { status: "available", value: [] },
): ChangeGitHubEvidence {
  return {
    issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
    branches: { status: "available", value: branches.map((name) => ({ name })) },
    pullRequests,
  };
}

function input(current: ChangeGitHubEvidence): ChangeProjectionInput {
  return {
    change: identity,
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "execute-change-plans-through-trusted-github-actions" },
    baseBranch: "main",
    evidence: current,
  };
}

function draftPullRequest() {
  return {
    number: 2180,
    head: branch,
    base: "main",
    state: "open" as const,
    draft: true,
    merged: false,
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
  };
}

function closedPullRequest() {
  return {
    ...draftPullRequest(),
    state: "closed" as const,
    draft: false,
    merged: false,
  };
}

class MutableReader implements ChangeTrustedEvidenceReader {
  constructor(public current: ChangeProjectionInput) {}

  async read(_request: ChangeRemoteMutationRequest): Promise<ChangeProjectionInput> {
    return this.current;
  }
}

class FakeIssuer {
  readonly effects: ChangeEffect[] = [];
  fail: ChangeEffect["kind"] | undefined;
  readonly reader: MutableReader;

  constructor(reader: MutableReader) {
    this.reader = reader;
  }

  async applyEffects(inputValue: IssuerMutationRequest): Promise<IssuerMutationResult> {
    const effect = inputValue.effects[0];
    assert.ok(effect);
    this.effects.push(effect);
    if (effect.kind === this.fail) throw new Error("provider detail must not cross the boundary");
    if (effect.kind === "CREATE_BRANCH") {
      this.reader.current = { ...this.reader.current, evidence: evidence([branch]) };
    } else if (effect.kind === "CREATE_PULL_REQUEST") {
      this.reader.current = {
        ...this.reader.current,
        evidence: evidence([branch], { status: "available", value: [draftPullRequest()] }),
      };
    } else if (effect.kind === "CLOSE_PULL_REQUEST") {
      this.reader.current = {
        ...this.reader.current,
        evidence: evidence([branch], { status: "available", value: [closedPullRequest()] }),
      };
    } else if (effect.kind === "DELETE_BRANCH") {
      const pullRequests =
        this.reader.current.evidence.pullRequests?.status === "available"
          ? this.reader.current.evidence.pullRequests.value
          : [];
      this.reader.current = {
        ...this.reader.current,
        evidence: evidence([], { status: "available", value: pullRequests }),
      };
    }
    return {
      version: 1,
      authority: "issuer",
      issuer: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: INARI_ISSUER_PRINCIPAL },
      repository: target,
      installation: { appId: "218", installationId: "218", repositoryHost: "github.com" },
      permissions: {},
      effects: [{ kind: effect.kind, status: "applied" }],
    };
  }
}

function executor(reader: MutableReader, issuer: FakeIssuer): TrustedChangeExecutor {
  return new TrustedChangeExecutor({
    reader,
    issuerAuthority: issuer,
    execution,
    target,
  });
}

test("trusted issuance plans in Core, applies ordered effects, and verifies a fresh projection", async () => {
  const reader = new MutableReader(input(evidence([])));
  const issuer = new FakeIssuer(reader);
  const result = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "issue",
    issue: identity.rootIssue,
    requester: "agent:alice",
  });

  assert.deepEqual(
    issuer.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST"],
  );
  assert.equal(result.evidence?.outcome, "verified");
  assert.equal(result.evidence?.requester, "agent:alice");
  assert.equal(result.evidence?.issuer, INARI_ISSUER_PRINCIPAL);
  assert.equal(result.projection.change?.provenance.requester, "agent:alice");
  assert.equal(result.projection.change?.provenance.issuer, INARI_ISSUER_PRINCIPAL);
  assert.equal(result.projection.change?.state, "DRAFT");
});

test("healthy issuance retry returns the existing Change without effects", async () => {
  const reader = new MutableReader(input(evidence([branch], { status: "available", value: [draftPullRequest()] })));
  const issuer = new FakeIssuer(reader);
  const result = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "issue",
    issue: identity.rootIssue,
  });

  assert.deepEqual(issuer.effects, []);
  assert.equal(result.evidence?.outcome, "returned-existing");
  assert.equal(result.projection.change?.projection?.pullRequest, 2180);
});

test("branch success and pull-request failure are compensated through a Core recovery plan", async () => {
  const reader = new MutableReader(input(evidence([])));
  const issuer = new FakeIssuer(reader);
  issuer.fail = "CREATE_PULL_REQUEST";
  const result = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "issue",
    issue: identity.rootIssue,
  });

  assert.deepEqual(
    issuer.effects.map((effect) => effect.kind),
    ["CREATE_BRANCH", "CREATE_PULL_REQUEST", "DELETE_BRANCH"],
  );
  assert.equal(result.evidence?.outcome, "compensated");
  assert.equal(result.evidence?.compensation, "succeeded");
  assert.equal(result.projection.status, "absent");
});

test("failed compensation returns bounded RECOVERY_REQUIRED evidence", async () => {
  const reader = new MutableReader(input(evidence([])));
  const issuer = new FakeIssuer(reader);
  issuer.fail = "CREATE_PULL_REQUEST";
  const originalApply = issuer.applyEffects.bind(issuer);
  let compensation = false;
  issuer.applyEffects = async (request) => {
    if (request.effects[0]?.kind === "DELETE_BRANCH") compensation = true;
    if (compensation) throw new Error("credential-bearing provider detail");
    return originalApply(request);
  };
  const result = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "issue",
    issue: identity.rootIssue,
  });

  assert.equal(result.evidence?.outcome, "recovery-required");
  assert.equal(result.evidence?.compensation, "failed");
  assert.equal(result.projection.change?.state, "RECOVERY_REQUIRED");
  assert.doesNotMatch(JSON.stringify(result), /credential-bearing|token|privateKey/iu);
});

test("effect failure has deterministic bounded mapping", async () => {
  const reader = new MutableReader(input(evidence([])));
  const issuer = new FakeIssuer(reader);
  issuer.fail = "CREATE_BRANCH";

  await assert.rejects(
    executor(reader, issuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "issue",
      issue: identity.rootIssue,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeTrustedExecutorError);
      assert.equal(error.code, "CHANGE_EXECUTION_EFFECT_FAILED");
      assert.equal(error.evidence?.failure?.code, "BRANCH_CREATE_FAILED");
      assert.doesNotMatch(error.message, /provider|credential|token/iu);
      return true;
    },
  );
});

test("post-effect projection verification failure fails closed", async () => {
  const reader = new MutableReader(input(evidence([])));
  const issuer = new FakeIssuer(reader);
  const originalApply = issuer.applyEffects.bind(issuer);
  issuer.applyEffects = async (request) => {
    const effect = request.effects[0];
    if (effect?.kind === "CREATE_PULL_REQUEST") {
      return {
        version: 1,
        authority: "issuer",
        issuer: { kind: "github-app", slug: "inari-issuer", appId: "218", principal: INARI_ISSUER_PRINCIPAL },
        repository: target,
        installation: { appId: "218", installationId: "218", repositoryHost: "github.com" },
        permissions: {},
        effects: [{ kind: effect.kind, status: "applied" }],
      };
    }
    return originalApply(request);
  };

  await assert.rejects(
    executor(reader, issuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "issue",
      issue: identity.rootIssue,
    }),
    (error: unknown) =>
      error instanceof ChangeTrustedExecutorError && error.code === "CHANGE_EXECUTION_PROJECTION_VERIFICATION_FAILED",
  );
});

test("DRAFT and REVIEW aborts close the canonical PR and delete only the canonical branch", async () => {
  for (const draft of [true, false]) {
    const reader = new MutableReader(
      input(evidence([branch], { status: "available", value: [{ ...draftPullRequest(), draft }] })),
    );
    const issuer = new FakeIssuer(reader);
    const result = await executor(reader, issuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "abort",
      issue: identity.rootIssue,
      requester: "agent:aborter",
    });

    assert.deepEqual(
      issuer.effects.map((effect) => effect.kind),
      ["CLOSE_PULL_REQUEST", "DELETE_BRANCH"],
    );
    assert.equal(result.evidence?.outcome, "verified");
    assert.equal(result.projection.change?.state, "ABORTED");
    assert.equal(result.projection.change?.provenance.requester, "agent:aborter");
    assert.equal(result.projection.change?.provenance.issuer, INARI_ISSUER_PRINCIPAL);
  }
});

test("already-aborted retry performs no duplicate close or delete", async () => {
  const reader = new MutableReader(input(evidence([], { status: "available", value: [closedPullRequest()] })));
  const issuer = new FakeIssuer(reader);
  const result = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "abort",
    issue: identity.rootIssue,
  });

  assert.deepEqual(issuer.effects, []);
  assert.equal(result.evidence?.outcome, "returned-existing");
  assert.equal(result.projection.change?.state, "ABORTED");
});

test("MERGED, noncanonical, and ambiguous projections reject before mutation", async () => {
  const mergedReader = new MutableReader(
    input(
      evidence([branch], {
        status: "available",
        value: [{ ...closedPullRequest(), merged: true }],
      }),
    ),
  );
  const mergedIssuer = new FakeIssuer(mergedReader);
  await assert.rejects(
    executor(mergedReader, mergedIssuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "abort",
      issue: identity.rootIssue,
    }),
  );
  assert.deepEqual(mergedIssuer.effects, []);

  const noncanonicalReader = new MutableReader(
    input({
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: "feat/218-arbitrary" }] },
      pullRequests: {
        status: "available",
        value: [{ ...draftPullRequest(), head: "feat/218-arbitrary" }],
      },
    }),
  );
  const noncanonicalIssuer = new FakeIssuer(noncanonicalReader);
  await assert.rejects(
    executor(noncanonicalReader, noncanonicalIssuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "abort",
      issue: identity.rootIssue,
    }),
  );
  assert.deepEqual(noncanonicalIssuer.effects, []);

  const ambiguousReader = new MutableReader(
    input({
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [] },
      pullRequests: {
        status: "available",
        value: [
          { ...draftPullRequest(), number: 2181, head: "feat/218-first", rootIssue: identity.rootIssue },
          { ...draftPullRequest(), number: 2182, head: "feat/218-second", rootIssue: identity.rootIssue },
        ],
      },
    }),
  );
  const ambiguousIssuer = new FakeIssuer(ambiguousReader);
  await assert.rejects(
    executor(ambiguousReader, ambiguousIssuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "abort",
      issue: identity.rootIssue,
    }),
  );
  assert.deepEqual(ambiguousIssuer.effects, []);

  const driftedReader = new MutableReader(
    input({
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch }] },
      pullRequests: {
        status: "available",
        value: [{ ...draftPullRequest(), base: "develop" }],
      },
    }),
  );
  const driftedIssuer = new FakeIssuer(driftedReader);
  await assert.rejects(
    executor(driftedReader, driftedIssuer).execute({
      version: CHANGE_TRANSITION_CONTRACT_VERSION,
      operation: "abort",
      issue: identity.rootIssue,
    }),
  );
  assert.deepEqual(driftedIssuer.effects, []);
});

test("partial abort cleanup returns RECOVERY_REQUIRED and a later retry applies only branch deletion", async () => {
  const reader = new MutableReader(input(evidence([branch], { status: "available", value: [draftPullRequest()] })));
  const issuer = new FakeIssuer(reader);
  issuer.fail = "DELETE_BRANCH";
  const failed = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "abort",
    issue: identity.rootIssue,
  });

  assert.equal(failed.evidence?.outcome, "recovery-required");
  assert.equal(failed.projection.change?.state, "RECOVERY_REQUIRED");
  assert.equal(failed.projection.status, "partial");
  assert.deepEqual(
    issuer.effects.map((effect) => effect.kind),
    ["CLOSE_PULL_REQUEST", "DELETE_BRANCH"],
  );

  issuer.fail = undefined;
  const retry = await executor(reader, issuer).execute({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    operation: "abort",
    issue: identity.rootIssue,
  });
  assert.equal(retry.evidence?.outcome, "verified");
  assert.equal(retry.projection.change?.state, "ABORTED");
  assert.deepEqual(
    issuer.effects.map((effect) => effect.kind),
    ["CLOSE_PULL_REQUEST", "DELETE_BRANCH", "DELETE_BRANCH"],
  );
});
