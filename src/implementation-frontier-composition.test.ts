import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueDependencyMarker } from "./artifact.js";
import { projectChangeFromGitHubEvidence } from "./change.js";
import type { ImplementationFrontierRepository } from "./implementation-frontier-composition.js";
import { composeImplementationFrontier } from "./implementation-frontier-composition.js";
import { renderImplementationIssueBody } from "./implementation-contract.js";
import type { GitHubIssue, RepositoryContext } from "./github/types.js";

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
