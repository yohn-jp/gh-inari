import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_TRANSITION_CONTRACT_VERSION,
  type ChangeProjectionInput,
  validateGovernedRootIssueEvidence,
} from "./change.js";
import { renderIssueArtifact } from "./artifact.js";
import { issueContractFixture } from "./contract/fixtures.js";
import { TrustedChangeExecutor } from "./change-trusted-executor.js";
import {
  INARI_ISSUER_PRINCIPAL,
  type IssuerMutationRequest,
  type IssuerMutationResult,
  type TrustedExecutionContext,
} from "./github/issuer-authority.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "258000001",
  rootIssue: 258,
} as const;

const governedIssueContract = {
  ...issueContractFixture,
  provenance: {
    authority: "repository-default-branch" as const,
    repository: {
      host: "github.com",
      owner: "acme",
      name: "inari",
      nameWithOwner: "acme/inari",
      repositoryId: identity.repositoryId,
    },
    ref: "main",
    treeSha: "governance-generation-258",
    template: {
      path: issueContractFixture.templateIdentity.path,
      ref: "main",
      sha: "issue-template-258",
      digest: "issue-template-digest-258",
    },
  },
};

const governedIssueBody = renderIssueArtifact(governedIssueContract, {
  problem: "A governed Change root Issue.",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
});

function projection(body: string): ChangeProjectionInput {
  return {
    change: identity,
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "validate-governed-root-issue-before-issuance" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    },
    governedIssue: { contract: governedIssueContract, body },
  };
}

const execution: TrustedExecutionContext = {
  version: 1,
  runtime: "github-actions",
  event: "workflow_dispatch",
  repository: { repositoryHost: "github.com", repositoryId: identity.repositoryId, nameWithOwner: "acme/inari" },
  workflowRef: "refs/heads/main",
  workflowSha: "a".repeat(40),
  workflowTrust: "protected",
  codeExecution: "trusted-only",
  fork: false,
  pullRequest: false,
};

test("root Issue validation accepts only the canonical governed artifact", () => {
  assert.deepEqual(
    validateGovernedRootIssueEvidence({ contract: governedIssueContract, body: governedIssueBody }, identity, "main"),
    [],
  );
  assert.ok(
    validateGovernedRootIssueEvidence({ contract: governedIssueContract, body: "### malformed\n" }, identity, "main")
      .length > 0,
  );
  assert.ok(
    validateGovernedRootIssueEvidence(
      { contract: governedIssueContract, body: governedIssueBody.slice(0, -4) },
      identity,
      "main",
    ).length > 0,
  );
});

test("trusted issuance applies zero effects when root Issue governance fails", async () => {
  const reader = {
    requiresGovernedIssueValidation: true,
    read: async () => projection("### malformed\n"),
  };
  const effects: IssuerMutationRequest[] = [];
  const issuer = {
    applyEffects: async (request: IssuerMutationRequest): Promise<IssuerMutationResult> => {
      effects.push(request);
      return {
        version: 1,
        authority: "issuer",
        issuer: { kind: "github-app", slug: "inari-issuer", appId: "258", principal: INARI_ISSUER_PRINCIPAL },
        repository: execution.repository,
        installation: { appId: "258", installationId: "258", repositoryHost: "github.com" },
        permissions: {},
        effects: request.effects.map((effect) => ({ kind: effect.kind, status: "applied" as const })),
      };
    },
  };
  const executor = new TrustedChangeExecutor({
    reader,
    issuerAuthority: issuer,
    execution,
    target: execution.repository,
  });
  await assert.rejects(
    executor.execute({ version: CHANGE_TRANSITION_CONTRACT_VERSION, operation: "issue", issue: identity.rootIssue }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CHANGE_EXECUTION_PRECONDITION_FAILED",
  );
  assert.equal(effects.length, 0);
});
