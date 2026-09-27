import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArtifactContractProvenance, CanonicalContract } from "./contract/ir.js";
import { compileEffectiveArtifactContract } from "./contract/effective-artifact-contract.js";
import { parseArtifactContract } from "./contract/artifact-contract.js";
import { pullRequestContractFixture } from "./contract/fixtures.js";
import { materializeSemanticArtifact } from "./contract/semantic-artifact.js";
import { tryProjectIntegrationRouting } from "./integration-routing.js";
import { planSemanticBranch } from "./semantic-branch-projection.js";
import { tryPlanIntegrationPublication } from "./integration-publication-plan.js";

const repository = { repositoryHost: "github.com", repositoryId: "100", repository: "acme/inari" } as const;
const sourceIssue = { ...repository, number: 680 } as const;
const epic = { ...repository, number: 640 } as const;
const sourceSha = "a".repeat(40);
const governanceRepository = {
  host: "github.com",
  owner: "acme",
  name: "inari",
  nameWithOwner: "acme/inari",
  repositoryId: "100",
} as const;

function branchProvenance(treeSha = "tree-sha"): ArtifactContractProvenance {
  return {
    authority: "repository-default-branch",
    repository: governanceRepository,
    ref: "main",
    treeSha,
    source: {
      path: ".github/inari/canon/branch.json",
      ref: "main",
      sha: "branch-contract-sha",
      digest: "branch-contract-digest",
    },
  };
}

const branchContract = parseArtifactContract({
  version: "1",
  kind: "branch",
  id: "integration-branch",
  properties: {
    name: { presence: "required", authority: { kind: "supplied" } },
    source: { presence: "required", authority: { kind: "supplied" } },
  },
});

function branchPlan(name: string, source: string, treeSha = "tree-sha") {
  const artifact = materializeSemanticArtifact(
    compileEffectiveArtifactContract(branchContract, { provenance: branchProvenance(treeSha) }),
    { name, source },
  );
  return planSemanticBranch({ artifact });
}

function pullRequestContract(treeSha = "tree-sha"): CanonicalContract {
  return {
    ...pullRequestContractFixture,
    supplementalConstraints: { fields: [] },
    provenance: {
      authority: "repository-default-branch",
      repository: governanceRepository,
      ref: "main",
      treeSha,
      template: {
        path: pullRequestContractFixture.templateIdentity.path,
        ref: "main",
        sha: "pull-request-template-sha",
        digest: "pull-request-template-digest",
      },
    },
  };
}

function routing(role: "issue-integration" | "epic-integration", overrides: Record<string, unknown> = {}) {
  if (role === "issue-integration")
    return {
      version: 1,
      kind: "integration-routing",
      role,
      sourceIssue,
      epic,
      relationships: { sourceIssueParent: epic },
      branches: { default: "main", issue: "issue/680-source", epic: "epic/640-platform" },
      head: "issue/680-source",
      base: "epic/640-platform",
      ...overrides,
    };
  return {
    version: 1,
    kind: "integration-routing",
    role,
    epic,
    branches: { default: "main", epic: "epic/640-platform" },
    head: "epic/640-platform",
    base: "main",
    ...overrides,
  };
}

function input(
  role: "issue-integration" | "epic-integration",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const route = routing(role);
  const head = role === "issue-integration" ? "issue/680-source" : "epic/640-platform";
  const base = role === "issue-integration" ? "epic/640-platform" : "main";
  const workIdentity = role === "issue-integration" ? { role, sourceIssue, epic } : { role, epic };
  const contract = pullRequestContract();
  return {
    version: 1,
    kind: "integration-publication-plan",
    repository,
    routing: route,
    workIdentity,
    branchPlan: branchPlan(head, base),
    sourceSha,
    headRevision: sourceSha,
    pullRequestContract: contract,
    pullRequestDocument: {
      fields: {
        summary: "Compose the governed outcome.",
        linked_issue: "The integration result is tracked by its role identity.",
        acceptance: ["tests"],
        scope: "Canonical integration publication",
      },
      metadata: { title: "feat: integrate governed outcome", head, base, draft: true },
    },
    ...overrides,
  };
}

test("plans a Source integration branch and Draft PR without an Implementation identity", () => {
  const result = tryPlanIntegrationPublication(input("issue-integration"));
  assert.equal(result.valid, true);
  assert.equal(result.plan?.role, "issue-integration");
  assert.equal(result.plan?.routing.implementation, undefined);
  assert.deepEqual(result.plan?.workIdentity, { role: "issue-integration", sourceIssue, epic });
  assert.equal(result.plan?.branchCreation.source, "epic/640-platform");
  assert.equal(result.plan?.branchCreation.target, "issue/680-source");
  assert.equal(result.plan?.branchCreation.sourceSha, sourceSha);
  assert.equal(result.plan?.branchCreation.artifact.id, "integration-branch");
  assert.equal(result.plan?.publication.expectedHead, "issue/680-source");
  assert.equal(result.plan?.publication.expectedBase, "epic/640-platform");
  assert.equal(result.plan?.publication.headRevision, sourceSha);
  assert.equal(result.plan?.publication.draft, true);
  assert.match(result.plan?.publication.body ?? "", /Compose the governed outcome\./u);
  assert.match(result.plan?.publication.body ?? "", /inari:pr-publication/u);
  assert.equal(Object.isFrozen(result.plan), true);
});

test("plans an Epic integration branch and Draft PR from its explicit Epic identity alone", () => {
  const result = tryPlanIntegrationPublication(input("epic-integration"));
  assert.equal(result.valid, true);
  assert.equal(result.plan?.role, "epic-integration");
  assert.equal(result.plan?.routing.implementation, undefined);
  assert.equal(result.plan?.routing.sourceIssue, undefined);
  assert.deepEqual(result.plan?.workIdentity, { role: "epic-integration", epic });
  assert.equal(result.plan?.branchCreation.source, "main");
  assert.equal(result.plan?.branchCreation.target, "epic/640-platform");
  assert.equal(result.plan?.publication.expectedHead, "epic/640-platform");
  assert.equal(result.plan?.publication.expectedBase, "main");
  assert.equal(result.plan?.publication.draft, true);
});

test("fails closed on repository, relationship, role, branch, base, head revision, and generation mismatches", () => {
  const valid = input("issue-integration");
  const failures = [
    input("issue-integration", {
      repository: { ...repository, repositoryId: "101" },
    }),
    input("issue-integration", {
      routing: routing("issue-integration", { relationships: { sourceIssueParent: { ...epic, number: 641 } } }),
    }),
    input("issue-integration", {
      workIdentity: { role: "epic-integration", epic },
    }),
    input("issue-integration", {
      branchPlan: branchPlan("issue/681-other-source", "epic/640-platform"),
    }),
    input("issue-integration", {
      pullRequestDocument: {
        fields: {
          summary: "Compose the governed outcome.",
          linked_issue: "The integration result is tracked by its role identity.",
          acceptance: ["tests"],
          scope: "Canonical integration publication",
        },
        metadata: { title: "feat: integrate governed outcome", head: "issue/680-source", base: "main", draft: true },
      },
    }),
    input("issue-integration", { headRevision: "b".repeat(40) }),
    input("issue-integration", { pullRequestContract: pullRequestContract("different-tree") }),
  ];
  assert.equal(failures.length, 7);
  for (const failure of failures) assert.equal(tryPlanIntegrationPublication(failure).valid, false);
  assert.equal(tryPlanIntegrationPublication(valid).valid, true);
});

test("requires full 40-character Git commit SHAs for the source and planned head", () => {
  for (const revision of ["a".repeat(7), "a".repeat(39), "a".repeat(41), "a".repeat(64)]) {
    const sourceShaResult = tryPlanIntegrationPublication(
      input("issue-integration", { sourceSha: revision, headRevision: revision }),
    );
    assert.equal(sourceShaResult.valid, false);
    assert.ok(sourceShaResult.violations.some((entry) => entry.code === "SOURCE_SHA_INVALID"));
    assert.ok(sourceShaResult.violations.some((entry) => entry.code === "HEAD_REVISION_INVALID"));
  }
  assert.equal(tryPlanIntegrationPublication(input("issue-integration")).valid, true);
});

test("keeps ordinary and explicit legacy Implementation routes available", () => {
  const legacyRouting = {
    version: 1,
    kind: "integration-routing",
    mode: "legacy",
    implementation: { ...repository, number: 700 },
    epic,
    relationships: { implementationParent: epic },
    branches: { default: "main", implementation: "feat/700-legacy", epic: "epic/640-platform" },
    role: "implementation",
    head: "feat/700-legacy",
    base: "epic/640-platform",
  };
  assert.equal(tryProjectIntegrationRouting(legacyRouting).valid, true);
  assert.equal(tryPlanIntegrationPublication(input("issue-integration", { routing: legacyRouting })).valid, false);
});
