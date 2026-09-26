import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { validateExecutionIntent, type ExecutionIntent } from "../local-control/execution-intent.js";
import type { LocalExecutorEvidenceRequest } from "../local-control/executor-http.js";
import { createLocalSessionBinding, type LocalSessionBinding } from "../local-control/session-binding.js";
import { createRepositoryBranchPolicy } from "../repository-branch-policy.js";
import { observeLocalBranch } from "../cli/runtime/branch-observation.js";
import { projectChangeFromGitHubEvidence } from "../change.js";
import { changeReadRequest } from "../change-execution-port.js";
import { renderImplementationIssueBody } from "../implementation-contract.js";
import {
  admitSession,
  authorizeExecutionIntent,
  closeSession,
  currentBranchPolicyInput,
  type AdmissionAuthorizationOptions,
} from "./authorization.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY_ID = "123456789";
const REPOSITORY_NAME = "acme/inari";
const ISSUE = 375;
const BRANCH = "feat/375-local-admission";

test("policy-bound Session admission requires matching current generation and branch", async () => {
  await withEnvironment(async (environment) => {
    const fixture = authorityFixture();
    const generation = { ref: "trunk", treeSha: "a".repeat(40) };
    const acquired = createRepositoryBranchPolicy({
      generation: {
        authority: "repository-default-branch",
        repository: {
          host: "github.com",
          repositoryId: REPOSITORY_ID,
          owner: "acme",
          name: "inari",
          nameWithOwner: REPOSITORY_NAME,
        },
        ...generation,
      },
      rule: { pattern: "^work/[0-9]+-[a-z]+$", format: "work/{issueNumber}-{slug}" },
    });
    assert.equal(acquired.status, "available");
    if (acquired.status !== "available") return;
    const branchInput = {
      policy: acquired.policy,
      target: { repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID }, implementation: ISSUE },
      observedGeneration: generation,
      observedBranch: "work/375-session",
      binding: {
        repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID },
        implementation: ISSUE,
        branch: "work/375-session",
      },
    };
    const branchObservation = observeLocalBranch(branchInput);
    const session = createLocalSessionBinding({
      sessionId: "session-policy",
      repository: { id: REPOSITORY_ID, name: REPOSITORY_NAME },
      task: { kind: "issue", number: ISSUE },
      capabilities: [{ kind: "branch.advance", branch: branchObservation.expectedBranch }],
      ttlSeconds: 120,
      runtimeAuthority: fixture.authority,
      runtimeKey: fixture.keyPair,
      now: NOW,
      branchObservation,
    });
    const base = options(environment, fixture.authority, () => trustEvidence(fixture.authority));
    // #1179: Admission reads the current policy from the owner; a caller-supplied observation is never accepted.
    const reader = (input: Omit<typeof branchInput, "observedBranch">) => ({
      readBranchPolicy: async () => ({ version: 1, kind: "local-branch-policy-input", ...input }),
    });
    const { observedBranch: _observed, ...current } = branchInput;
    await assert.rejects(admitSession(session, base), /observation is missing/u);
    await assert.rejects(
      admitSession(session, {
        ...base,
        ...reader({ ...current, observedGeneration: { ref: "trunk", treeSha: "b".repeat(40) } }),
      }),
      /invalid or stale/u,
    );
    const moved = createRepositoryBranchPolicy({
      generation: { ...acquired.policy.generation, treeSha: "c".repeat(40) },
      rule: acquired.policy.rule,
    });
    assert.equal(moved.status, "available");
    if (moved.status !== "available") return;
    await assert.rejects(
      admitSession(session, {
        ...base,
        ...reader({ ...current, policy: moved.policy, observedGeneration: { ref: "trunk", treeSha: "c".repeat(40) } }),
      }),
      /contradicts Session binding/u,
    );
    await assert.rejects(
      admitSession(session, { ...base, readBranchPolicy: async () => ({ version: 1, kind: "forged" }) }),
      /invalid or stale/u,
    );
    assert.equal((await admitSession(session, { ...base, ...reader(current) })).status, "active");
  });
});

function authorityFixture(id = "runtime-admission-authorization-test") {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id,
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "branch.advance"],
  });
  return { keyPair, authority };
}

function binding(fixture: ReturnType<typeof authorityFixture>, sessionId: string, ttlSeconds = 120) {
  return createLocalSessionBinding({
    sessionId,
    repository: { id: REPOSITORY_ID, name: REPOSITORY_NAME },
    task: { kind: "issue", number: ISSUE },
    capabilities: [{ kind: "branch.advance", branch: BRANCH } as LocalSessionBinding["capabilities"][number]],
    ttlSeconds,
    runtimeAuthority: fixture.authority,
    runtimeKey: fixture.keyPair,
    now: NOW,
  });
}

function trustEvidence(authority: unknown, repositoryId = REPOSITORY_ID) {
  return {
    repository: { repositoryHost: "github.com", repositoryId, nameWithOwner: REPOSITORY_NAME },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    runtimeAuthority: authority,
  };
}

function intent(requestId: string, overrides: { readonly issue?: number; readonly repositoryId?: string } = {}) {
  const issue = overrides.issue ?? ISSUE;
  const validation = validateExecutionIntent({
    version: 1,
    requestId,
    repository: {
      repositoryHost: "github.com",
      repositoryId: overrides.repositoryId ?? REPOSITORY_ID,
      repositoryNameWithOwner: REPOSITORY_NAME,
    },
    operation: "branch.advance",
    request: {
      version: 1,
      issue,
      branch: issue === ISSUE ? BRANCH : `feat/${issue}-local-admission`,
      expectedHead: "b".repeat(40),
      changes: [{ operation: "upsert", path: "src/example.ts", mode: "100644", content: "eA==" }],
      commit: { message: "Update the implementation" },
    },
  });
  assert.ok(validation.valid && validation.intent !== undefined);
  return validation.intent as ExecutionIntent;
}

async function withEnvironment(run: (environment: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-admission-authorization-"));
  try {
    await run({ INARI_CONFIG_HOME: path.join(root, "config") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function options(
  environment: NodeJS.ProcessEnv,
  runtimeAuthority: AdmissionAuthorizationOptions["runtimeAuthority"],
  evidence: (request: LocalExecutorEvidenceRequest) => unknown,
  requests: LocalExecutorEvidenceRequest[] = [],
): AdmissionAuthorizationOptions {
  return {
    runtimeAuthority,
    environment,
    now: () => NOW,
    readEvidence: async (request) => {
      requests.push(request);
      return evidence(request);
    },
  };
}

test("Sessions are admitted and closed only against matching current Executor trust evidence", async () => {
  await withEnvironment(async (environment) => {
    const fixture = authorityFixture();
    const other = authorityFixture("runtime-admission-other-authority");
    const session = binding(fixture, "session-admitted");
    const requests: LocalExecutorEvidenceRequest[] = [];

    await assert.rejects(
      admitSession(
        session,
        options(environment, fixture.authority, () => trustEvidence(fixture.authority, "987")),
      ),
    );
    await assert.rejects(
      admitSession(
        session,
        options(environment, fixture.authority, () => trustEvidence(other.authority)),
      ),
    );
    await assert.rejects(
      admitSession(
        session,
        options(environment, other.authority, () => trustEvidence(other.authority)),
      ),
    );
    await assert.rejects(
      admitSession(
        session,
        options(environment, fixture.authority, () => ({})),
      ),
    );

    const admitted = await admitSession(
      session,
      options(environment, fixture.authority, () => trustEvidence(fixture.authority), requests),
    );
    assert.deepEqual(admitted, { id: "session-admitted", status: "active", exp: session.exp });
    assert.deepEqual(requests, [
      {
        version: 1,
        repository: { id: REPOSITORY_ID, name: REPOSITORY_NAME },
        authorityId: fixture.authority.id,
      },
    ]);

    const closed = await closeSession(
      session,
      options(environment, fixture.authority, () => trustEvidence(fixture.authority)),
    );
    assert.deepEqual(closed, { id: "session-admitted", status: "closed" });
  });
});

test("expired Sessions are never admitted", async () => {
  await withEnvironment(async (environment) => {
    const fixture = authorityFixture();
    const session = binding(fixture, "session-expired", 60);
    const later = { ...options(environment, fixture.authority, () => trustEvidence(fixture.authority)) };
    await assert.rejects(admitSession(session, { ...later, now: () => new Date(NOW.getTime() + 3_600_000) }));
  });
});

test("execution authorization denies unavailable Sessions, repository and task mismatches before reading evidence", async () => {
  await withEnvironment(async (environment) => {
    const fixture = authorityFixture();
    const requests: LocalExecutorEvidenceRequest[] = [];
    const authorization = options(environment, fixture.authority, () => trustEvidence(fixture.authority), requests);

    await assert.rejects(authorizeExecutionIntent(intent("request-unknown"), "session-unknown", authorization));

    const session = binding(fixture, "session-active");
    await admitSession(session, authorization);
    requests.length = 0;

    await assert.rejects(
      authorizeExecutionIntent(intent("request-repository", { repositoryId: "987" }), "session-active", authorization),
    );
    await assert.rejects(
      authorizeExecutionIntent(intent("request-task", { issue: ISSUE + 1 }), "session-active", authorization),
    );
    assert.deepEqual(requests, []);

    // Current evidence is required: malformed evidence denies instead of authorizing.
    await assert.rejects(authorizeExecutionIntent(intent("request-evidence"), "session-active", authorization));
    const evidenceRequests: readonly LocalExecutorEvidenceRequest[] = requests;
    assert.equal(evidenceRequests.length, 1);
    assert.equal(evidenceRequests[0]?.issue, ISSUE);

    await closeSession(session, authorization);
    requests.length = 0;
    await assert.rejects(authorizeExecutionIntent(intent("request-closed"), "session-active", authorization));
    assert.deepEqual(requests, []);
  });
});

// #1213: Implementation → Source Change binding.
const IMPLEMENTATION = 1213;
const SOURCE_BRANCH = "fix/1213-source-binding";
const SOURCE_REPOSITORY = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, repository: REPOSITORY_NAME };
const sourceReference = (number: number, repositoryId = REPOSITORY_ID) => ({
  repositoryHost: "github.com",
  repositoryId,
  number,
});

function sourcePolicyInput(sources: readonly Record<string, unknown>[] | undefined) {
  const generation = { ref: "main", treeSha: "9".repeat(40) };
  const acquired = createRepositoryBranchPolicy({
    generation: {
      authority: "repository-default-branch",
      repository: {
        host: "github.com",
        repositoryId: REPOSITORY_ID,
        owner: "acme",
        name: "inari",
        nameWithOwner: REPOSITORY_NAME,
      },
      ...generation,
    },
  });
  assert.equal(acquired.status, "available");
  if (acquired.status !== "available") throw new Error("unreachable");
  const repository = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID };
  return {
    version: 1,
    kind: "local-branch-policy-input",
    policy: acquired.policy,
    target: { repository, implementation: IMPLEMENTATION },
    observedGeneration: generation,
    binding: { repository, implementation: IMPLEMENTATION, branch: SOURCE_BRANCH },
    ...(sources === undefined ? {} : { sources }),
  };
}

function sourceChange(issue: number) {
  const projection = projectChangeFromGitHubEvidence({
    change: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, rootIssue: issue },
    branchGovernance: { pattern: "^fix/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "fix", slug: "source-binding" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: issue, state: "open" } },
      branches: { status: "available", value: [] },
      pullRequests: { status: "available", value: [] },
    },
  });
  assert.equal(projection.valid, true);
  return projection;
}

function sourceEvidence(authority: unknown, sources: readonly Record<string, unknown>[], issue: number) {
  const reference = { ...SOURCE_REPOSITORY, number: IMPLEMENTATION };
  const baseHead = "b".repeat(40);
  const body = renderImplementationIssueBody({
    version: 1,
    kind: "implementation",
    repository: SOURCE_REPOSITORY,
    sources,
    objective: "Bind the Implementation Session to its Source Changes.",
    nonGoals: ["Primary Source inference."],
    architecture: {
      decision: "Source membership is exact.",
      affectedComponents: ["Admission"],
      invariants: ["Current evidence is reread."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Unrelated denied."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: "main",
      baseRevision: baseHead,
      baseFreshness: baseHead,
      branch: SOURCE_BRANCH,
      dependencies: [],
    },
  });
  return {
    ...trustEvidence(authority),
    change: sourceChange(issue),
    implementation: {
      implementation: reference,
      issue: { reference, body },
      repository: SOURCE_REPOSITORY,
      base: { branch: "main", revision: baseHead, freshness: baseHead },
      readiness: { evidence: [] },
      change: sourceChange(IMPLEMENTATION),
    },
  };
}

test("#1213 session registration attaches the current authorized Implementation Source set", async () => {
  await withEnvironment(async (environment) => {
    const fixture = authorityFixture();
    const sources = [sourceReference(1208), sourceReference(1209), sourceReference(7, "987654321")];
    const requests: LocalExecutorEvidenceRequest[] = [];
    const base = options(
      environment,
      fixture.authority,
      (request) =>
        request.issue === undefined
          ? trustEvidence(fixture.authority)
          : sourceEvidence(fixture.authority, sources, request.issue),
      requests,
    );
    const repository = { id: REPOSITORY_ID, name: REPOSITORY_NAME };

    // Without owner Source evidence the input is unchanged and no Implementation evidence is read.
    const legacy = await currentBranchPolicyInput(
      repository,
      IMPLEMENTATION,
      {
        ...base,
        readBranchPolicy: async () => sourcePolicyInput(undefined),
      },
      "session-registration",
    );
    assert.equal(legacy.implementationBinding, undefined);
    assert.equal(requests.length, 0);

    const bound = await currentBranchPolicyInput(
      repository,
      IMPLEMENTATION,
      {
        ...base,
        readBranchPolicy: async () => sourcePolicyInput(sources),
      },
      "session-registration",
    );
    assert.deepEqual(bound.implementationBinding?.task, { kind: "issue", number: IMPLEMENTATION });
    assert.deepEqual(bound.implementationBinding?.sources, bound.sources);
    assert.deepEqual(
      requests.map((request) => [request.issue, request.implementationIssue]),
      [[IMPLEMENTATION, IMPLEMENTATION]],
    );

    // Owner Sources that disagree with the current authorized contract, or an owner-supplied binding, fail closed.
    await assert.rejects(
      currentBranchPolicyInput(
        repository,
        IMPLEMENTATION,
        {
          ...base,
          readBranchPolicy: async () => sourcePolicyInput([sourceReference(1208)]),
        },
        "session-registration",
      ),
      /Source evidence is inconsistent/u,
    );
    await assert.rejects(
      currentBranchPolicyInput(
        repository,
        IMPLEMENTATION,
        {
          ...base,
          readBranchPolicy: async () => ({
            ...sourcePolicyInput(sources),
            implementationBinding: bound.implementationBinding,
          }),
        },
        "session-registration",
      ),
      /invalid or stale/u,
    );
  });
});

test("#1213 execution admits Change roots only from the signed and current Source sets", async () => {
  await withEnvironment(async (environment) => {
    const fixture = authorityFixture();
    let currentSources = [sourceReference(1208), sourceReference(1209)];
    const requests: LocalExecutorEvidenceRequest[] = [];
    const authorization = {
      ...options(
        environment,
        fixture.authority,
        (request) =>
          request.issue === undefined
            ? trustEvidence(fixture.authority)
            : sourceEvidence(fixture.authority, currentSources, request.issue),
        requests,
      ),
      readBranchPolicy: async () => sourcePolicyInput(currentSources),
    };
    const input = await currentBranchPolicyInput(
      { id: REPOSITORY_ID, name: REPOSITORY_NAME },
      IMPLEMENTATION,
      authorization,
      "session-registration",
    );
    const { sources: _sources, implementationBinding, ...policy } = input;
    const session = createLocalSessionBinding({
      sessionId: "session-sources",
      repository: { id: REPOSITORY_ID, name: REPOSITORY_NAME },
      task: { kind: "issue", number: IMPLEMENTATION },
      capabilities: [
        { kind: "change.implement", issue: 1208 },
        { kind: "change.implement", issue: 1209 },
        { kind: "branch.advance", branch: SOURCE_BRANCH },
      ],
      ttlSeconds: 120,
      runtimeAuthority: fixture.authority,
      runtimeKey: fixture.keyPair,
      now: NOW,
      branchObservation: observeLocalBranch({ ...policy, observedBranch: SOURCE_BRANCH }),
      ...(implementationBinding === undefined ? {} : { implementationBinding }),
    });
    await admitSession(session, authorization);
    const change = (requestId: string, issue: number) => {
      const validation = validateExecutionIntent({
        version: 1,
        requestId,
        repository: {
          repositoryHost: "github.com",
          repositoryId: REPOSITORY_ID,
          repositoryNameWithOwner: REPOSITORY_NAME,
        },
        operation: "change.show",
        request: changeReadRequest(issue),
      });
      assert.ok(validation.valid && validation.intent !== undefined);
      return validation.intent as ExecutionIntent;
    };

    // Exact members: no primary Source; the Implementation is read by the task, the Change by the Source.
    for (const issue of [1208, 1209]) {
      requests.length = 0;
      const execution = await authorizeExecutionIntent(
        change(`show-${issue}`, issue),
        "session-sources",
        authorization,
      );
      assert.deepEqual(execution.subject, { kind: "change", issue });
      assert.equal(execution.task, undefined);
      assert.deepEqual(
        requests
          .filter((request) => request.issue !== undefined)
          .map((request) => [request.issue, request.implementationIssue]),
        [[issue, IMPLEMENTATION]],
      );
    }
    // Unrelated Issue and the Implementation itself: denied before Change evidence is read.
    for (const issue of [4242, IMPLEMENTATION]) {
      requests.length = 0;
      await assert.rejects(
        authorizeExecutionIntent(change(`show-denied-${issue}`, issue), "session-sources", authorization),
        /not a Session Source/u,
      );
      assert.equal(
        requests.some((request) => request.issue !== undefined),
        false,
      );
    }
    // branch.advance stays bound to the Implementation task and branch, even on the Implementation branch.
    const advance = validateExecutionIntent({
      version: 1,
      requestId: "advance-source",
      repository: {
        repositoryHost: "github.com",
        repositoryId: REPOSITORY_ID,
        repositoryNameWithOwner: REPOSITORY_NAME,
      },
      operation: "branch.advance",
      request: {
        version: 1,
        issue: 1208,
        branch: SOURCE_BRANCH,
        expectedHead: "b".repeat(40),
        changes: [{ operation: "upsert", path: "src/example.ts", mode: "100644", content: "eA==" }],
        commit: { message: "Update the implementation" },
      },
    });
    assert.ok(advance.valid && advance.intent !== undefined);
    await assert.rejects(
      authorizeExecutionIntent(advance.intent as ExecutionIntent, "session-sources", authorization),
      /Execution task does not match Session/u,
    );
    await assert.rejects(
      authorizeExecutionIntent(
        intent("advance-other-branch", { issue: IMPLEMENTATION }),
        "session-sources",
        authorization,
      ),
      /Branch advance does not match the Session policy branch/u,
    );
    // A Source removed from the current contract is denied although the Session still names it.
    currentSources = [sourceReference(1208)];
    await assert.rejects(
      authorizeExecutionIntent(change("show-removed", 1209), "session-sources", authorization),
      /not a current Implementation Source/u,
    );
    // A stale branch-policy generation denies every operation.
    await assert.rejects(
      authorizeExecutionIntent(change("show-stale", 1208), "session-sources", {
        ...authorization,
        readBranchPolicy: async () => ({
          ...sourcePolicyInput(currentSources),
          observedGeneration: { ref: "main", treeSha: "8".repeat(40) },
        }),
      }),
      /invalid or stale/u,
    );
  });
});
