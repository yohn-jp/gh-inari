import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueDependencyMarker } from "./artifact.js";
import { projectChangeFromGitHubEvidence } from "./change.js";
import type { ImplementationFrontierRepository } from "./implementation-frontier-composition.js";
import {
  composeImplementationFrontier,
  readCurrentImplementationAdmissionEvidence,
} from "./implementation-frontier-composition.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  renderImplementationIssueBody,
} from "./implementation-contract.js";
import { authorizeImplementation } from "./implementation-authorization.js";
import {
  IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
  IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
} from "./implementation-execution-evidence.js";
import type { GitHubIssue, GitHubOperationalPullRequestEvidence, RepositoryContext } from "./github/types.js";

const identity = { repositoryHost: "github.com", repositoryId: "700", repository: "acme/frontier" };

function reference(number: number) {
  return { ...identity, number };
}

function context(): RepositoryContext {
  return {
    hostname: "github.com",
    host: "github.com",
    owner: "acme",
    name: "frontier",
    nameWithOwner: "acme/frontier",
    url: "https://github.com/acme/frontier",
    repositoryId: identity.repositoryId,
  };
}

function issue(number: number, body = ""): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body,
    state: "open",
    url: `https://github.com/acme/frontier/issues/${number}`,
    labels: [],
    assignees: [],
  };
}

function repository(
  issues: ReadonlyMap<number, GitHubIssue>,
  relations: ReadonlyMap<
    number,
    { readonly kind: "empty" | "present" | "unavailable"; readonly references: readonly ReturnType<typeof reference>[] }
  >,
  change: (number: number) => unknown = () => undefined,
  implementationEvidence: (number: number) => unknown = () => undefined,
): ImplementationFrontierRepository & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getRepositoryContext: async () => context(),
    getIssue: async (number) => {
      calls.push(`issue:${number}`);
      const value = issues.get(number);
      if (value === undefined) throw new Error(`missing issue ${number}`);
      return value;
    },
    observeBlockedBy: async (number) => {
      calls.push(`relation:${number}`);
      return { ...(relations.get(number) ?? { kind: "empty", references: [] }), diagnostics: [] };
    },
    findBranch: async (branch) => {
      calls.push(`branch:${branch}`);
      return undefined;
    },
    observePullRequest: async () => {
      throw new Error("unexpected pull-request read");
    },
    readChange: async (number) => {
      calls.push(`change:${number}`);
      return change(number);
    },
    readImplementationEvidence: async (number) => {
      calls.push(`implementation-evidence:${number}`);
      return implementationEvidence(number);
    },
  };
}

test("composes only the starting Issue's transitive blocked_by closure", async () => {
  const root = reference(1);
  const first = reference(2);
  const second = reference(3);
  const repo = repository(
    new Map([
      [1, issue(1, renderIssueDependencyMarker({ blockedBy: [first], blocks: [] }))],
      [2, issue(2, renderIssueDependencyMarker({ blockedBy: [second], blocks: [] }))],
      [3, issue(3)],
    ]),
    new Map([
      [1, { kind: "present", references: [first] }],
      [2, { kind: "present", references: [second] }],
      [3, { kind: "empty", references: [] }],
    ]),
  );

  const result = await composeImplementationFrontier(repo, root.number);

  assert.equal(result.valid, true);
  assert.deepEqual(
    result.projection?.candidates.map((candidate) => [candidate.reference.number, candidate.classification]),
    [
      [1, "BLOCKED"],
      [2, "BLOCKED"],
      [3, "READY"],
    ],
  );
  assert.equal(
    repo.calls.some((call) => call.includes(":4")),
    false,
  );
  assert.deepEqual(
    repo.calls.filter((call) => call.startsWith("issue:")),
    ["issue:1", "issue:2", "issue:3"],
  );
  assert.deepEqual(
    repo.calls.filter((call) => call.startsWith("change:")),
    ["change:1", "change:2", "change:3"],
  );
});

test("rereads and validates a canonical Implementation contract and current Change projection", async () => {
  const body = renderImplementationIssueBody({
    version: 1,
    kind: "implementation",
    repository: identity,
    sources: [reference(10)],
    objective: "Compose repository evidence.",
    nonGoals: ["Creating a second authority."],
    architecture: {
      decision: "Use existing authorities.",
      affectedComponents: ["Frontier"],
      invariants: ["Core remains authoritative."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["The contract is current."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      baseFreshness: "a".repeat(40),
      branch: "feat/10-frontier",
      dependencies: [reference(11)],
    },
  });
  const currentChange = projectChangeFromGitHubEvidence({
    change: { repositoryHost: identity.repositoryHost, repositoryId: identity.repositoryId, rootIssue: 10 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "frontier" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: 10, state: "open" } },
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    },
  });
  assert.equal(currentChange.valid, true);
  const repo = repository(
    new Map([
      [
        10,
        {
          ...issue(10, `${body}\n${renderIssueDependencyMarker({ blockedBy: [reference(11)], blocks: [] })}`),
          labels: ["implementation"],
        },
      ],
      [11, issue(11)],
    ]),
    new Map([
      [10, { kind: "present", references: [reference(11)] }],
      [11, { kind: "empty", references: [] }],
    ]),
    (number) => (number === 10 ? currentChange : undefined),
  );

  const result = await composeImplementationFrontier(repo, 10);

  assert.equal(result.valid, true);
  assert.equal(result.projection?.candidates[0]?.classification, "BLOCKED");
  assert.deepEqual(
    repo.calls.filter((call) => call.startsWith("change:")),
    ["change:10", "change:11"],
  );
});

test("reads current Implementation authorization inputs from canonical Issue, dependency, Change, and base evidence", async () => {
  const base = { branch: "main", revision: "a".repeat(40), freshness: "a".repeat(40) };
  const body = renderImplementationIssueBody({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: identity,
    sources: [reference(19)],
    objective: "Admit one current task.",
    nonGoals: ["Persisting derived scope."],
    architecture: {
      decision: "Reuse canonical evidence.",
      affectedComponents: ["Admission"],
      invariants: ["Current provider evidence is required."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: ["src/**"], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Current evidence is required."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: "feat/10-frontier",
      dependencies: [],
    },
  });
  const absentChange = projectChangeFromGitHubEvidence({
    change: { repositoryHost: identity.repositoryHost, repositoryId: identity.repositoryId, rootIssue: 10 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "frontier" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: 10, state: "open" } },
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    },
  });
  const repo = repository(
    new Map([[10, { ...issue(10, body), labels: ["implementation"] }]]),
    new Map([[10, { kind: "empty", references: [] }]]),
    () => absentChange,
  );
  repo.findBranch = async (branch) => {
    repo.calls.push(`branch:${branch}`);
    return branch === base.branch ? { name: base.branch, ref: "refs/heads/main", sha: base.revision } : undefined;
  };

  const current = await readCurrentImplementationAdmissionEvidence(repo, 10);

  assert.equal(current.implementation.number, 10);
  assert.equal(current.issue.body, body);
  assert.deepEqual(current.base, base);
  assert.deepEqual(current.readiness, { evidence: [] });
  assert.equal(current.change, absentChange);
  assert.ok(repo.calls.includes("branch:main"));
});

test("unavailable relationship evidence is not completed by inference", async () => {
  const repo = repository(new Map([[1, issue(1)]]), new Map([[1, { kind: "unavailable", references: [] }]]));

  const result = await composeImplementationFrontier(repo, 1);

  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "FRONTIER_EVIDENCE_UNAVAILABLE"));
  assert.deepEqual(
    repo.calls.filter((call) => call.startsWith("issue:")),
    ["issue:1"],
  );
});

test("re-verifies repository authorization and conformance evidence without supplemental frontier input", async () => {
  const implementation = reference(10);
  const base = { branch: "main", revision: "a".repeat(40), freshness: "a".repeat(40) };
  const branch = "feat/10-frontier";
  const headRevision = "b".repeat(40);
  const body = `${renderImplementationIssueBody({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository: identity,
    sources: [reference(1)],
    objective: "Compose current repository authority evidence.",
    nonGoals: ["Creating a second evidence path."],
    architecture: {
      decision: "Read existing authority evidence.",
      affectedComponents: ["Implementation Frontier"],
      invariants: ["Raw status flags are never trusted."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Current evidence is re-verified."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch,
      dependencies: [reference(1)],
    },
  })}\n${renderIssueDependencyMarker({ blockedBy: [reference(1)], blocks: [] })}`;
  const authorization = authorizeImplementation({
    implementation,
    body,
    repository: identity,
    base,
    readiness: {
      evidence: [
        {
          reference: reference(1),
          authority: "semantic-issue-lifecycle",
          status: "satisfied",
          freshness: "current",
          dependencies: [],
        },
      ],
    },
  });
  const pullRequestNumber = 1010;
  const pullRequest: GitHubOperationalPullRequestEvidence = {
    repository: {
      host: identity.repositoryHost,
      nameWithOwner: identity.repository,
      repositoryId: identity.repositoryId,
    },
    number: pullRequestNumber,
    title: "Frontier completion",
    body: "provider body",
    state: "open",
    author: null,
    head: { ref: branch, sha: headRevision },
    base: { ref: base.branch, sha: base.revision },
    draft: false,
    labels: [],
    assignees: [],
    url: `https://github.com/acme/frontier/pull/${pullRequestNumber}`,
    checks: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    requiredCheckBindings: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    reviews: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    comments: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    inlineReviewComments: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    changedFiles: {
      status: "available",
      items: [],
      pagination: { perPage: 100, pages: 1, returned: 0, truncated: false },
      diagnostics: [],
    },
    provenance: { provider: "github", endpoints: [`pulls/${pullRequestNumber}`] },
  };
  const executionEvidence = {
    version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation,
    repository: identity,
    governedBodyDigest: authorization.governedBodyDigest,
    base,
    branch,
    headRevision,
    targetedTests: [],
  };
  const change = projectChangeFromGitHubEvidence({
    change: {
      repositoryHost: identity.repositoryHost,
      repositoryId: identity.repositoryId,
      rootIssue: implementation.number,
    },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "frontier" },
    baseBranch: base.branch,
    evidence: {
      issue: { status: "available", value: { number: implementation.number, state: "open" } },
      branches: { status: "available", value: [{ name: branch, sha: headRevision }] },
      pullRequests: {
        status: "available",
        value: [{ number: pullRequestNumber, head: branch, base: base.branch, state: "open", draft: false }],
      },
    },
  });
  assert.equal(change.valid, true, JSON.stringify(change.diagnostics));
  const dependencyChange = {
    valid: true,
    status: "healthy",
    canonicalBranch: "feat/1-dependency",
    canonicalBaseBranch: base.branch,
    candidates: { branches: [], pullRequests: [] },
    change: {
      version: 1,
      identity: { repositoryHost: identity.repositoryHost, repositoryId: identity.repositoryId, rootIssue: 1 },
      state: "MERGED",
      provenance: {},
      projection: { branch: "feat/1-dependency" },
    },
    diagnostics: [],
  };

  const repo = repository(
    new Map([
      [10, { ...issue(10, body), labels: ["implementation"] }],
      [1, issue(1)],
    ]),
    new Map([
      [10, { kind: "present", references: [reference(1)] }],
      [1, { kind: "empty", references: [] }],
    ]),
    (number) => (number === 10 ? change : number === 1 ? dependencyChange : undefined),
    (number) =>
      number === 10
        ? {
            implementation: {
              authorization: { authorization },
              conformance: {
                authorization,
                issue: { reference: implementation, body },
                repository: identity,
                base,
                pullRequestNumber,
                pullRequest,
                executionEvidence,
              },
              executionEvidence,
            },
          }
        : undefined,
  );
  repo.findBranch = async (branchName) =>
    branchName === base.branch
      ? { name: base.branch, ref: `refs/heads/${base.branch}`, sha: base.revision }
      : undefined;
  repo.observePullRequest = async () => pullRequest;

  const result = await composeImplementationFrontier(repo, implementation.number);

  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(
    result.projection?.candidates.find((candidate) => candidate.reference.number === implementation.number)
      ?.classification,
    "SATISFIED",
  );
  assert.ok(repo.calls.includes("implementation-evidence:10"));
});
