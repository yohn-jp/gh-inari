import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIssueArtifact } from "./artifact.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionInput, type ChangeProjectionResult } from "./change.js";
import { issueContractFixture } from "./contract/fixtures.js";
import {
  executeGoldenPathEntry,
  GOLDEN_PATH_ENTRY_CONTRACT_VERSION,
  projectGoldenPathEntry,
  serializeGoldenPathEntryResult,
  tryProjectGoldenPathEntry,
  validateGoldenPathEntryResult,
  type GoldenPathEntryProjectionInput,
} from "./golden-path-entry.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  type ChangeRemoteExecutor,
  type ChangeRemoteMutationRequest,
} from "./change-executor.js";
import { runCli } from "./cli.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "406000001",
  rootIssue: 406,
} as const;
const branch = "feat/406-golden-path-entry";
const baseBranch = "main";
const naming = { type: "feat", slug: "golden-path-entry" } as const;
const branchGovernance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" } as const;

const governedIssueContract = {
  ...issueContractFixture,
  provenance: {
    authority: "repository-default-branch" as const,
    repository: {
      host: identity.repositoryHost,
      owner: "acme",
      name: "inari",
      nameWithOwner: "acme/inari",
      repositoryId: identity.repositoryId,
    },
    ref: baseBranch,
    treeSha: "generation-406",
    template: {
      path: issueContractFixture.templateIdentity.path,
      ref: baseBranch,
      sha: "template-406",
      digest: "template-digest-406",
    },
  },
};

const governedIssueBody = renderIssueArtifact(governedIssueContract, {
  problem: "A governed Golden Path root Issue.",
  category: "feature",
  affected_areas: ["contracts"],
  acceptance: ["tests"],
});

function projectionInput(
  pullRequests: ChangeProjectionInput["evidence"]["pullRequests"] = { status: "absent" },
  branches: ChangeProjectionInput["evidence"]["branches"] = { status: "absent" },
): ChangeProjectionInput {
  return {
    change: identity,
    branchGovernance,
    naming,
    baseBranch,
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches,
      pullRequests,
    },
    governedIssue: { contract: governedIssueContract, body: governedIssueBody },
  };
}

function existingProjection(): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence(
    projectionInput(
      {
        status: "available",
        value: [{ number: 4406, head: branch, base: baseBranch, state: "open", draft: true, merged: false }],
      },
      { status: "available", value: [{ name: branch }] },
    ),
  );
  assert.equal(result.valid, true);
  return result;
}

function entryInput(overrides: Partial<GoldenPathEntryProjectionInput> = {}): GoldenPathEntryProjectionInput {
  return {
    projection: projectionInput(),
    ...overrides,
  };
}

test("a governed root Issue yields the exact create Change action", () => {
  const result = projectGoldenPathEntry(entryInput());

  assert.equal(result.version, GOLDEN_PATH_ENTRY_CONTRACT_VERSION);
  assert.equal(result.valid, true);
  assert.deepEqual(result.subject, identity);
  assert.deepEqual(result.action, { operation: "change.issue", issue: 406, mode: "create" });
  assert.deepEqual(result.nextAction, {
    kind: "ISSUE_CHANGE",
    owner: "inari",
    reasonCode: "CHANGE_ISSUANCE_REQUIRED",
  });
  assert.equal(result.status.phase, "CHANGE");
  assert.equal(result.status.projectionStatus, "absent");
  assert.equal(result.recovery, null);
  assert.equal(result.diagnostics.length, 0);
});

test("an ungoverned root Issue fails closed before issuance", () => {
  const input = projectionInput();
  delete (input as { governedIssue?: unknown }).governedIssue;

  const result = tryProjectGoldenPathEntry({ projection: input });
  assert.equal(result.valid, false);
  assert.equal(result.action, undefined);
  assert.equal(result.nextAction, null);
  assert.ok(result.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED"));
});

test("the post-execution governance bypass cannot authorize a new issuance", () => {
  const result = tryProjectGoldenPathEntry({
    projection: projectionInput(),
    requireGovernedIssue: false,
  });

  assert.equal(result.valid, false);
  assert.equal(result.action, undefined);
  assert.ok(result.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_GOVERNED_ISSUE_REQUIRED"));
});

test("invalid governed artifact evidence is bounded and machine-readable", () => {
  const result = tryProjectGoldenPathEntry(
    entryInput({ governedIssue: { contract: governedIssueContract, body: "not canonical" } }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status.availability, "blocked");
  assert.equal(result.nextAction, null);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((entry) => entry.path.length <= 160 && entry.message.length <= 240));
  assert.equal(validateGoldenPathEntryResult(result).valid, true);
  assert.doesNotThrow(() => JSON.parse(serializeGoldenPathEntryResult(result)));
});

test("a healthy existing Change is returned idempotently without a second plan effect", () => {
  const result = projectGoldenPathEntry({
    projection: existingProjection(),
    governedIssue: { contract: governedIssueContract, body: governedIssueBody },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.action, { operation: "change.issue", issue: 406, mode: "return-existing" });
  assert.equal(result.status.changeState, "DRAFT");
  assert.deepEqual(result.nextAction, { kind: "IMPLEMENT", owner: "worker", reasonCode: "CHANGE_ISSUED" });
});

test("unhealthy Change evidence fails closed and cannot become a fresh issuance", () => {
  const result = tryProjectGoldenPathEntry({
    projection: projectionInput({ status: "absent" }, { status: "available", value: [{ name: branch }] }),
    governedIssue: { contract: governedIssueContract, body: governedIssueBody },
  });

  assert.equal(result.valid, false);
  assert.equal(result.status.availability, "recovery-required");
  assert.equal(result.action, undefined);
  assert.equal(result.nextAction?.kind, "MANUAL_REVIEW");
  assert.equal(result.recovery?.class, "ISSUANCE_PARTIAL_PROJECTION");
  assert.equal(validateGoldenPathEntryResult(result).valid, true);
});

test("recovery evidence is projected as a recovery action rather than a normal Change action", () => {
  const result = tryProjectGoldenPathEntry({
    projection: existingProjection(),
    requireGovernedIssue: false,
    executionOutcome: "recovery-required",
  });

  assert.equal(result.valid, false);
  assert.equal(result.status.phase, "RECOVERY");
  assert.equal(result.status.availability, "recovery-required");
  assert.equal(result.recovery?.safeAction, "MANUAL_REVIEW");
  assert.deepEqual(result.nextAction, {
    kind: "MANUAL_REVIEW",
    owner: "recovery",
    reasonCode: "MANUAL_RECOVERY_REVIEW_REQUIRED",
  });
  assert.equal(result.action, undefined);
  assert.equal(validateGoldenPathEntryResult(result).valid, true);
});

test("blocked repository preflight never becomes a Change issuance action", () => {
  const result = tryProjectGoldenPathEntry(entryInput({ preflight: { status: "blocked", diagnostics: [] } }));

  assert.equal(result.valid, false);
  assert.equal(result.status.phase, "ENVIRONMENT");
  assert.equal(result.status.availability, "blocked");
  assert.equal(result.nextAction, null);
  assert.ok(result.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_PREFLIGHT_BLOCKED"));
});

test("the executor composition delegates only to the existing change issue request", async () => {
  const calls: ChangeRemoteMutationRequest[] = [];
  const executor: ChangeRemoteExecutor = {
    async execute(request) {
      calls.push(request);
      return {
        projection: existingProjection(),
        evidence: {
          version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
          operation: "issue",
          outcome: "returned-existing",
          effects: [],
        },
      };
    },
    async read() {
      throw new Error("read is not part of the issue execution composition");
    },
  };
  const result = await executeGoldenPathEntry({ ...entryInput(), executor });

  assert.equal(result.valid, true);
  assert.equal(result.status.executionOutcome, "returned-existing");
  assert.deepEqual(calls, [
    {
      version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
      operation: "issue",
      issue: identity.rootIssue,
    },
  ]);
});

test("the executor composition can read preflight evidence before a new issuance", async () => {
  const calls: ChangeRemoteMutationRequest[] = [];
  const reads: unknown[] = [];
  const executor: ChangeRemoteExecutor = {
    async read(request) {
      reads.push(request);
      return projectChangeFromGitHubEvidence(projectionInput());
    },
    async execute(request) {
      calls.push(request);
      return {
        projection: existingProjection(),
        evidence: {
          version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
          operation: "issue",
          outcome: "verified",
          effects: [],
        },
      };
    },
  };

  const result = await executeGoldenPathEntry({
    issue: identity.rootIssue,
    governedIssue: { contract: governedIssueContract, body: governedIssueBody },
    executor,
  });

  assert.equal(result.valid, true);
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0], {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation: "show",
    issue: identity.rootIssue,
  });
  assert.deepEqual(calls, [
    {
      version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
      operation: "issue",
      issue: identity.rootIssue,
    },
  ]);
});

test("a healthy existing Change is read-only and does not invoke issuance", async () => {
  const calls: ChangeRemoteMutationRequest[] = [];
  const executor: ChangeRemoteExecutor = {
    async read() {
      return existingProjection();
    },
    async execute(request) {
      calls.push(request);
      throw new Error("existing Change must not be issued again");
    },
  };

  const result = await executeGoldenPathEntry({
    issue: identity.rootIssue,
    governedIssue: { contract: governedIssueContract, body: governedIssueBody },
    executor,
  });

  assert.equal(result.valid, true);
  assert.equal(result.action?.mode, "return-existing");
  assert.deepEqual(calls, []);
});

test("read and issue transport failures remain bounded entry results", async () => {
  const readFailure = await executeGoldenPathEntry({
    issue: identity.rootIssue,
    executor: {
      async read() {
        throw new Error("provider token must not cross the entry boundary");
      },
      async execute() {
        throw new Error("unreachable");
      },
    },
  });
  assert.equal(readFailure.valid, false);
  assert.equal(readFailure.nextAction, null);
  assert.ok(readFailure.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_EXECUTION_INVALID"));
  assert.doesNotMatch(JSON.stringify(readFailure), /provider token/iu);

  const issueFailure = await executeGoldenPathEntry({
    ...entryInput(),
    executor: {
      async read() {
        throw new Error("read is not used when projection is supplied");
      },
      async execute() {
        throw new Error("provider token must not cross the entry boundary");
      },
    },
  });
  assert.equal(issueFailure.valid, false);
  assert.equal(issueFailure.nextAction?.kind, "MANUAL_REVIEW");
  assert.ok(issueFailure.diagnostics.some((entry) => entry.code === "GOLDEN_PATH_EXECUTION_INVALID"));
  assert.doesNotMatch(JSON.stringify(issueFailure), /provider token/iu);
});

test("the canonical change issue CLI exposes the shared entry projection", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => output.push(line);
  try {
    const exitCode = await runCli(["change", "issue", "406", "--json"], {
      changeExecutor: {
        async execute() {
          return {
            projection: existingProjection(),
            evidence: {
              version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
              operation: "issue",
              outcome: "returned-existing",
              effects: [],
            },
          };
        },
        async read() {
          throw new Error("read is not part of this command");
        },
      },
    });
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }
  const result = JSON.parse(output.at(-1) ?? "{}") as { entry?: Record<string, unknown> };
  assert.equal(result.entry?.version, GOLDEN_PATH_ENTRY_CONTRACT_VERSION);
  assert.equal(
    (result.entry?.status as { executionOutcome?: string } | undefined)?.executionOutcome,
    "returned-existing",
  );
  assert.deepEqual((result.entry?.action as Record<string, unknown> | undefined)?.mode, "return-existing");
});
