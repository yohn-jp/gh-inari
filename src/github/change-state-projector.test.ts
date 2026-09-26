import assert from "node:assert/strict";
import { test } from "node:test";
import { changeReadRequest } from "../change-execution-port.js";
import { GitHubActionsEvidenceReader } from "./actions-change-executor.js";
import { GitHubChangeStateProjector } from "./change-state-projector.js";
import type { GitHubAppRepositoryReadTransport } from "./app-installation-credential-broker.js";
import type { GitHubChangeEffectRepository } from "./change-effect-adapter.js";
import { projectChangeFromGitHubEvidence } from "../change.js";
import type { RepositoryGovernanceSourceReader } from "../governance.js";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "../implementation-contract.js";

const REPOSITORY: GitHubChangeEffectRepository = { hostname: "github.com", owner: "acme", name: "inari" };
const IDENTITY = { repositoryHost: "github.com", repositoryId: "1", rootIssue: 42 } as const;
const BRANCH = "feat/42-shared-projection";

function transport(): GitHubAppRepositoryReadTransport {
  return {
    request: async (request) => {
      if (request.path === "repos/acme/inari") {
        return { status: 200, body: { id: 1, default_branch: "main" } };
      }
      if (request.path === "repos/acme/inari/issues/42") {
        return { status: 200, body: { number: 42, title: "feat: Shared projection", state: "open" } };
      }
      if (request.path === `repos/acme/inari/git/ref/heads/${encodeURIComponent(BRANCH)}`) {
        return { status: 404, body: {} };
      }
      if (request.path === "repos/acme/inari/git/matching-refs/heads/") {
        return { status: 200, body: [] };
      }
      if (request.path.startsWith("repos/acme/inari/pulls?state=all&head=")) {
        return { status: 200, body: [] };
      }
      throw new Error(`unexpected provider request: ${request.path}`);
    },
  };
}

test("Actions compatibility and Direct App composition share the same semantic projection", async () => {
  const request = changeReadRequest(42);
  const actions = new GitHubActionsEvidenceReader({
    repository: REPOSITORY,
    identity: IDENTITY,
    transport: transport(),
  });
  const directApp = new GitHubChangeStateProjector({
    repository: REPOSITORY,
    identity: IDENTITY,
    transport: transport(),
  });

  assert.deepEqual(await actions.read(request), await directApp.read(request));
});

const ALTERNATIVE_BRANCH = "story/42-shared-projection";
const POLICY_SOURCE = 'version: 1\nsections: []\nbranch:\n  pattern: "^story/[0-9]+-[a-z0-9-]+$"\n';

function implementationBody(overrides: { readonly branch?: string; readonly repositoryId?: string } = {}): string {
  const repository = {
    repositoryHost: "github.com",
    repositoryId: overrides.repositoryId ?? "1",
    repository: "acme/inari",
  };
  return renderImplementationIssueBody(
    parseImplementationContract({
      version: IMPLEMENTATION_CONTRACT_VERSION,
      kind: IMPLEMENTATION_KIND,
      repository,
      sources: [{ ...repository, number: 40 }],
      objective: "Project an alternative repository branch convention.",
      nonGoals: ["Automatic naming"],
      architecture: {
        decision: "Repository policy is the naming authority.",
        affectedComponents: ["Change projection"],
        invariants: ["Admitted branch equals mutated branch."],
        compatibilityConstraints: [],
      },
      scope: { readOnly: ["src/**"], write: ["src/change.ts"], create: [], delete: [], deny: ["src/private/**"] },
      constraints: {
        prohibitedOperations: ["Do not derive names."],
        immutableAreas: ["Policy"],
        prerequisites: ["Policy exists."],
      },
      verification: {
        acceptanceCriteria: ["The exact branch is projected."],
        targetedTests: ["pnpm test"],
        requiredChecks: ["pnpm run verify"],
        postconditions: ["The exact branch is current."],
      },
      execution: {
        baseBranch: "trunk",
        baseRevision: "a".repeat(40),
        baseFreshness: "fresh-1",
        branch: overrides.branch ?? ALTERNATIVE_BRANCH,
        dependencies: [{ ...repository, number: 40 }],
      },
    }),
  );
}

function implementationTransport(body: string, defaultBranch = "trunk"): GitHubAppRepositoryReadTransport {
  return {
    request: async (request) => {
      if (request.path === "repos/acme/inari") return { status: 200, body: { id: 1, default_branch: defaultBranch } };
      if (request.path === "repos/acme/inari/issues/42")
        return { status: 200, body: { number: 42, title: "impl: alternative policy", state: "open", body } };
      if (request.path.startsWith("repos/acme/inari/git/ref/heads/")) return { status: 404, body: {} };
      if (request.path === "repos/acme/inari/git/matching-refs/heads/") return { status: 200, body: [] };
      if (request.path.startsWith("repos/acme/inari/pulls?state=all&head=")) return { status: 200, body: [] };
      throw new Error(`unexpected provider request: ${request.path}`);
    },
  };
}

function governance(defaultBranch = "trunk"): RepositoryGovernanceSourceReader {
  return {
    resolveRepositoryContext: async () => ({
      hostname: "github.com",
      host: "github.com",
      owner: "acme",
      name: "inari",
      nameWithOwner: "acme/inari",
      url: "https://github.com/acme/inari",
      repositoryId: "1",
    }),
    getRepositoryDefaultBranch: async () => defaultBranch,
    getRepositoryTree: async () => ({
      sha: "e".repeat(40),
      entries: [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: "f".repeat(40) }],
    }),
    getRepositoryBlob: async () => POLICY_SOURCE,
  };
}

function implementationProjector(
  body: string,
  options: { readonly repoDefault?: string; readonly policyDefault?: string } = {},
) {
  return new GitHubChangeStateProjector({
    repository: REPOSITORY,
    identity: IDENTITY,
    transport: implementationTransport(body, options.repoDefault),
    remoteGovernance: governance(options.policyDefault),
  });
}

test("Implementation-native projection threads exact repository branch policy evidence and the default branch", async () => {
  const input = await implementationProjector(implementationBody()).read(changeReadRequest(42));
  assert.equal(input.naming, undefined);
  assert.equal(input.branchGovernance, undefined);
  assert.equal(input.branchEvidence?.branch, ALTERNATIVE_BRANCH);
  assert.equal(input.branchEvidence?.source, "exact-binding");
  assert.equal(input.branchEvidence?.defaultBranch, "trunk");
  assert.equal(input.baseBranch, "trunk");
  const projection = projectChangeFromGitHubEvidence(input);
  assert.equal(projection.valid, true, JSON.stringify(projection.diagnostics));
  assert.equal(projection.canonicalBranch, ALTERNATIVE_BRANCH);
  assert.equal(projection.canonicalBaseBranch, "trunk");
});

test("Implementation-native projection fails closed on off-policy, foreign or stale branch evidence", async () => {
  await assert.rejects(
    implementationProjector(implementationBody({ branch: "feat/42-shared-projection" })).read(changeReadRequest(42)),
    /BRANCH_POLICY_MISMATCH/u,
  );
  await assert.rejects(
    implementationProjector(implementationBody({ repositoryId: "2" })).read(changeReadRequest(42)),
    /repository does not match/u,
  );
  await assert.rejects(
    implementationProjector(implementationBody(), { policyDefault: "develop" }).read(changeReadRequest(42)),
    /generation does not match/u,
  );
});
