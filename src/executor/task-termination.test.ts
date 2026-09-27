import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_CONTRACT_VERSION,
  IMPLEMENTATION_KIND,
  parseImplementationContract,
  renderImplementationIssueBody,
} from "../implementation-contract.js";
import { authorizeImplementation } from "../implementation-authorization.js";
import type { CurrentImplementationAdmissionEvidence } from "../implementation-frontier-composition.js";
import type { GitHubBranchAdvanceCapability } from "../github/git-data-capability.js";
import { TASK_TERMINATION_METADATA_BRANCH } from "../github/task-termination-record.js";
import {
  finalizeExecutorTaskTermination,
  readExecutorTaskTermination,
  taskTerminationReadCapability,
} from "./task-termination.js";

const repository = { repositoryHost: "github.com", repositoryId: "415000001", repository: "yohn-jp/gh-inari" } as const;
const implementation = { ...repository, number: 1250 } as const;
const source = { ...repository, number: 1261 } as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" } as const;
const body = renderImplementationIssueBody(
  parseImplementationContract({
    version: IMPLEMENTATION_CONTRACT_VERSION,
    kind: IMPLEMENTATION_KIND,
    repository,
    sources: [source],
    objective: "Terminate one exact task.",
    nonGoals: ["No public mutation route."],
    architecture: {
      decision: "Use the existing record.",
      affectedComponents: ["Executor"],
      invariants: ["Current authorization is required."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: [], write: [], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["The effect is exact."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: base.branch,
      baseRevision: base.revision,
      baseFreshness: base.freshness,
      branch: "feat/1250",
      dependencies: [],
    },
  }),
);
const authorization = authorizeImplementation({ implementation, body, repository, base });
const current: CurrentImplementationAdmissionEvidence = {
  implementation,
  issue: { reference: implementation, body },
  repository,
  base,
  readiness: { evidence: [] },
  change: {},
};
const record = {
  version: 1,
  kind: "implementation-task-termination",
  repository,
  implementation,
  authorizationDigest: authorization.governedBodyDigest,
  base,
} as const;

function gitData(mode: "normal" | "uncertain" = "normal") {
  let metadataHead: string | undefined;
  let updates = 0;
  const capability: GitHubBranchAdvanceCapability = {
    scope: {
      app: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
      installation: { appId: "1", installationId: "2", repositoryHost: "github.com" },
      repository: {
        repositoryHost: "github.com",
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.repository,
      },
      repositorySelection: "selected",
      permissions: { contents: "write", metadata: "read" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    async readRef(branch) {
      if (branch === base.branch) return { name: branch, ref: `refs/heads/${branch}`, sha: base.revision };
      assert.equal(branch, TASK_TERMINATION_METADATA_BRANCH);
      return metadataHead === undefined ? undefined : { name: branch, ref: `refs/heads/${branch}`, sha: metadataHead };
    },
    async readCommit(sha) {
      return { sha, treeSha: sha === base.revision ? "b".repeat(40) : "c".repeat(40) };
    },
    async readTree(sha) {
      return {
        sha,
        entries:
          metadataHead === undefined
            ? []
            : [
                {
                  path: ".inari/task-termination/implementation-1250.json",
                  mode: "100644",
                  type: "blob" as const,
                  sha: "d".repeat(40),
                },
              ],
      };
    },
    async readBlob() {
      return JSON.stringify(record);
    },
    async createBlob() {
      return { sha: "d".repeat(40) };
    },
    async createTree() {
      return { sha: "c".repeat(40) };
    },
    async createCommit() {
      return { sha: "e".repeat(40) };
    },
    async compareAndAdvanceRef(input) {
      updates += 1;
      assert.equal(input.beforeOid, "0".repeat(40));
      if (mode === "normal") metadataHead = input.afterOid;
      throw new Error("provider outcome uncertain");
    },
  };
  return { capability, updates: () => updates };
}

test("current exact authorization yields authoritative absence and reconciled effect", async () => {
  const state = gitData();
  assert.equal((await readExecutorTaskTermination(state.capability, authorization, current)).status, "absent");
  const result = await finalizeExecutorTaskTermination(state.capability, authorization, current, record);
  assert.equal(result.status, "success");
  assert.equal(result.observation?.status, "present");
  assert.equal(state.updates(), 1);
});

test("drifted authorization denies before provider read or effect", async () => {
  const state = gitData();
  const drifted = { ...current, issue: { ...current.issue, body: `${body}\nChanged objective` } };
  assert.equal((await readExecutorTaskTermination(state.capability, authorization, drifted)).status, "invalid");
  assert.equal(
    (await finalizeExecutorTaskTermination(state.capability, authorization, drifted, record)).status,
    "denied",
  );
  assert.equal(state.updates(), 0);
});

test("uncertain provider effect is not retried or reported successful", async () => {
  const state = gitData("uncertain");
  const result = await finalizeExecutorTaskTermination(state.capability, authorization, current, record);
  assert.equal(result.status, "possible-effect");
  assert.equal(state.updates(), 1);
});

test("task evidence uses the read-only App transport and cannot issue a write", async () => {
  const methods: string[] = [];
  const reader = taskTerminationReadCapability(
    {
      providerPrincipal: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
      scope: gitData().capability.scope,
      transport: {
        request: async (request) => {
          methods.push(request.method);
          return { status: 200, body: { ref: "refs/heads/main", object: { type: "commit", sha: base.revision } } };
        },
      },
    },
    { repositoryHost: "github.com", repositoryId: repository.repositoryId, nameWithOwner: repository.repository },
  );
  assert.equal((await reader.readRef("main"))?.sha, base.revision);
  await assert.rejects(reader.createBlob({ content: "YQ==" }));
  assert.deepEqual(methods, ["GET"]);
});
