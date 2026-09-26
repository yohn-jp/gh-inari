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
import {
  admitSession,
  authorizeExecutionIntent,
  closeSession,
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
      naming: { slug: "session" },
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
    await assert.rejects(admitSession(session, base), /observation is missing/u);
    await assert.rejects(
      admitSession(session, {
        ...base,
        branchObservation: { ...branchInput, observedGeneration: { ref: "trunk", treeSha: "b".repeat(40) } },
      }),
      /invalid or stale/u,
    );
    await assert.rejects(
      admitSession(session, { ...base, branchObservation: { ...branchInput, observedBranch: "work/376-session" } }),
      /invalid or stale/u,
    );
    assert.equal((await admitSession(session, { ...base, branchObservation: branchInput })).status, "active");
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
