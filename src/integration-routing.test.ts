import assert from "node:assert/strict";
import { test } from "node:test";
import { projectIntegrationRouting, tryProjectIntegrationRouting } from "./integration-routing.js";
import { branchBelongsToRootIssue, recognizeBranchName, validateBranchName } from "./branch-naming.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;
const implementation = { ...repository, number: 700 } as const;
const sourceIssue = { ...repository, number: 680 } as const;
const epic = { ...repository, number: 640 } as const;

function issueRoute(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "integration-routing",
    mode: "issue-integration",
    implementation,
    sourceIssue,
    epic,
    relationships: {
      implementationParent: sourceIssue,
      sourceIssueParent: epic,
    },
    branches: {
      default: "main",
      implementation: "feat/700-add-routing",
      issue: "issue/680-source-routing",
      epic: "epic/640-dashboard",
    },
    role: "implementation",
    head: "feat/700-add-routing",
    base: "issue/680-source-routing",
    ...overrides,
  };
}

test("issue integration routing projects an explicit Epic -> source Issue -> Implementation path", () => {
  const result = tryProjectIntegrationRouting(issueRoute());
  assert.equal(result.valid, true);
  assert.equal(result.projection?.expectedBase, "issue/680-source-routing");
  assert.equal(result.projection?.pullRequest.role, "implementation");
  assert.equal(Object.isFrozen(result.projection), true);
});

test("issue integration routing projects each convergence PR role", () => {
  const issue = projectIntegrationRouting({
    ...issueRoute(),
    role: "issue-integration",
    head: "issue/680-source-routing",
    base: "epic/640-dashboard",
  });
  assert.deepEqual(
    { role: issue.role, head: issue.expectedHead, base: issue.expectedBase },
    { role: "issue-integration", head: "issue/680-source-routing", base: "epic/640-dashboard" },
  );

  const epicRoute = projectIntegrationRouting({
    ...issueRoute(),
    role: "epic-integration",
    head: "epic/640-dashboard",
    base: "main",
  });
  assert.deepEqual(
    { role: epicRoute.role, head: epicRoute.expectedHead, base: epicRoute.expectedBase },
    { role: "epic-integration", head: "epic/640-dashboard", base: "main" },
  );
});

test("routing rejects cross-Issue, cross-Epic, and layer-skipping relationships", () => {
  const wrongSource = tryProjectIntegrationRouting(
    issueRoute({
      relationships: { implementationParent: { ...repository, number: 681 }, sourceIssueParent: epic },
    }),
  );
  assert.equal(wrongSource.valid, false);
  assert.ok(wrongSource.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH"));

  const wrongEpic = tryProjectIntegrationRouting(
    issueRoute({
      relationships: { implementationParent: sourceIssue, sourceIssueParent: { ...repository, number: 641 } },
    }),
  );
  assert.equal(wrongEpic.valid, false);
  assert.ok(wrongEpic.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH"));

  const layerSkip = tryProjectIntegrationRouting(
    issueRoute({ relationships: { implementationParent: epic, sourceIssueParent: epic } }),
  );
  assert.equal(layerSkip.valid, false);
  assert.ok(layerSkip.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_RELATIONSHIP_MISMATCH"));
});

test("routing can consume the canonical complete parent graph", () => {
  const route = issueRoute();
  delete route.relationships;
  route.graph = {
    scope: "complete",
    nodes: [
      { reference: implementation, parent: sourceIssue },
      { reference: sourceIssue, parent: epic },
      { reference: epic },
    ],
  };
  const result = tryProjectIntegrationRouting(route);
  assert.equal(result.valid, true);
  assert.equal(result.projection?.expectedBase, "issue/680-source-routing");
});

test("standalone and explicit legacy routes remain compatible", () => {
  const standalone = projectIntegrationRouting({
    mode: "standalone",
    implementation,
    branches: { default: "main", implementation: "feat/700-standalone" },
    role: "implementation",
    head: "feat/700-standalone",
    base: "main",
  });
  assert.equal(standalone.expectedBase, "main");

  const legacy = projectIntegrationRouting({
    mode: "legacy",
    implementation,
    epic,
    relationships: { implementationParent: epic },
    branches: { default: "main", implementation: "feat/700-legacy", epic: "epic/640-dashboard" },
    role: "implementation",
    head: "feat/700-legacy",
    base: "epic/640-dashboard",
  });
  assert.equal(legacy.expectedBase, "epic/640-dashboard");
});

test("integration branch identity is strict and cannot fall through ordinary policy", () => {
  assert.deepEqual(validateBranchName("issue/680-source-routing"), []);
  assert.deepEqual(validateBranchName("epic/640-dashboard"), []);
  assert.equal(recognizeBranchName("issue/680-source-routing")?.type, "issue");
  assert.equal(branchBelongsToRootIssue("issue/680-source-routing", 680), false);
  assert.equal(recognizeBranchName("issue/0-invalid"), undefined);
  assert.notDeepEqual(validateBranchName("issue/not-a-number"), []);
  assert.notDeepEqual(validateBranchName("issue/680-UPPERCASE"), []);
  assert.notDeepEqual(validateBranchName("issue/680-source-routing/extra"), []);
});

test("observed PR head and base must match the selected canonical route", () => {
  const result = tryProjectIntegrationRouting(issueRoute({ base: "epic/640-dashboard" }));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_BASE_MISMATCH"));

  const wrongImplementation = tryProjectIntegrationRouting(issueRoute({ head: "feat/701-other" }));
  assert.equal(wrongImplementation.valid, false);
  assert.ok(wrongImplementation.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_HEAD_MISMATCH"));
});

test("ordinary Implementation routing consumes exact governed head and non-main default evidence", () => {
  const standalone = projectIntegrationRouting({
    implementation,
    implementationBranch: "story/700-alternative-policy",
    defaultBranch: "trunk",
  });
  assert.deepEqual(
    { role: standalone.role, head: standalone.expectedHead, base: standalone.expectedBase },
    { role: "implementation", head: "story/700-alternative-policy", base: "trunk" },
  );
  const issue = projectIntegrationRouting(
    issueRoute({
      branches: {
        default: "trunk",
        implementation: "users/alice/700-routing",
        issue: "issue/680-source-routing",
        epic: "epic/640-dashboard",
      },
      head: "users/alice/700-routing",
    }),
  );
  assert.equal(issue.expectedHead, "users/alice/700-routing");
  assert.equal(issue.branches.default, "trunk");
});

test("ordinary routing keeps reserved, default and unsafe branch denials", () => {
  const invalid = (input: Record<string, unknown>, path: string) => {
    const result = tryProjectIntegrationRouting(input);
    assert.equal(result.valid, false, JSON.stringify(input));
    assert.ok(
      result.diagnostics.some((entry) => entry.path === path),
      JSON.stringify(result.diagnostics),
    );
  };
  invalid({ implementation, implementationBranch: "story/../700", defaultBranch: "trunk" }, "$.implementationBranch");
  invalid({ implementation, implementationBranch: "story/700", defaultBranch: "a..b" }, "$.defaultBranch");
  invalid({ implementation, implementationBranch: "release/1.0.0", defaultBranch: "trunk" }, "$.implementationBranch");
  invalid({ implementation, implementationBranch: "issue/700-x", defaultBranch: "trunk" }, "$.implementationBranch");
  invalid({ implementation, implementationBranch: "trunk", defaultBranch: "trunk" }, "$.implementationBranch");
  // Reserved integration branches keep their canonical grammar.
  invalid(issueRoute({ branches: { default: "main", issue: "issue/x", epic: "epic/640-dashboard" } }), "$.issueBranch");
});

test("an already-projected route re-validates to the same projection and rejects a tampered PR route", () => {
  const projection = projectIntegrationRouting(issueRoute());
  assert.deepEqual(projectIntegrationRouting(projection), projection);
  const tampered = tryProjectIntegrationRouting({
    ...projection,
    pullRequest: { ...projection.pullRequest, base: "main" },
  });
  assert.equal(tampered.valid, false);
  assert.ok(tampered.diagnostics.some((entry) => entry.path === "$.pullRequest"));
});

test("an exactly policy-bound historical-looking branch naming another Issue number routes for its Implementation", () => {
  const implementation42 = { ...repository, number: 42 } as const;
  const route = projectIntegrationRouting({
    implementation: implementation42,
    implementationBranch: "feat/999-special",
    defaultBranch: "trunk",
  });
  assert.deepEqual([route.expectedHead, route.expectedBase], ["feat/999-special", "trunk"]);
  // Exact head/base equality still binds the route to the governed evidence.
  const mismatch = tryProjectIntegrationRouting({
    implementation: implementation42,
    implementationBranch: "feat/999-special",
    defaultBranch: "trunk",
    head: "feat/42-other",
  });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_HEAD_MISMATCH"));
});

test("main is an ordinary Implementation head unless it is the actual default or base branch", () => {
  const onTrunk = projectIntegrationRouting({ implementation, implementationBranch: "main", defaultBranch: "trunk" });
  assert.deepEqual([onTrunk.expectedHead, onTrunk.expectedBase], ["main", "trunk"]);
  const onMain = tryProjectIntegrationRouting({ implementation, implementationBranch: "main", defaultBranch: "main" });
  assert.equal(onMain.valid, false);
  assert.ok(onMain.diagnostics.some((entry) => entry.code === "INTEGRATION_ROUTING_HEAD_MISMATCH"));
});
