import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  CHANGE_TRANSITION_CONTRACT_VERSION,
  CHANGE_STATES,
  MAX_CHANGE_DIAGNOSTICS,
  MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH,
  ChangeTransitionValidationError,
  ChangeValidationError,
  changeIdentityKey,
  createChangeDiagnostic,
  createChangeDiagnosticReport,
  deserializeChange,
  deserializeChangeDiagnosticReport,
  deriveCanonicalBranchIdentity,
  deserializeChangeTransitionPlan,
  deserializeChangeTransitionRequest,
  isChange,
  isChangeTransitionPlan,
  isChangeTransitionRequest,
  planChangeTransition,
  serializeChange,
  serializeChangeDiagnosticReport,
  serializeChangeTransitionPlan,
  serializeChangeTransitionRequest,
  validateChange,
  validateChangeIdentity,
  validateChangeTransitionPlan,
  validateChangeTransitionRequest,
  type Change,
} from "./change.js";

const validChange: Change = {
  version: CHANGE_CONTRACT_VERSION,
  identity: {
    repositoryHost: "github.com",
    repositoryId: "100000210",
    rootIssue: 210,
  },
  state: "DRAFT",
  provenance: {
    requester: "human:sophia",
    issuer: "app:inari-issuer",
    implementer: "agent:codex",
    reviewer: "human:reviewer",
    merger: "human:maintainer",
  },
  projection: {
    branch: "feat/210-define-canonical-change-domain-contract",
    pullRequest: 321,
  },
};

test("Change contract includes every architectural lifecycle state", () => {
  assert.deepEqual(CHANGE_STATES, ["DEFINED", "DRAFT", "REVIEW", "ACCEPTED", "MERGED", "ABORTED", "RECOVERY_REQUIRED"]);
  for (const state of CHANGE_STATES) {
    const result = validateChange({ ...validChange, state });
    assert.equal(result.valid, true, state);
    assert.equal(result.change?.state, state);
  }
});

test("repository and root Issue form one canonical deterministic identity", () => {
  const result = validateChangeIdentity({
    repositoryHost: "GITHUB.COM",
    repositoryId: "100000210",
    rootIssue: 210,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.identity, {
    repositoryHost: "github.com",
    repositoryId: "100000210",
    rootIssue: 210,
  });
  assert.equal(
    changeIdentityKey({ repositoryHost: "GITHUB.COM", repositoryId: "100000210", rootIssue: 210 }),
    changeIdentityKey(result.identity!),
  );
  assert.equal(changeIdentityKey(result.identity!), "github.com#100000210#210");
});

test("canonical Change branch identity is derived through governed naming and branch policy", () => {
  const result = deriveCanonicalBranchIdentity({
    change: validChange,
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "derive-canonical-change-branch-identity" },
  });
  assert.deepEqual(result, {
    valid: true,
    branch: "feat/210-derive-canonical-change-branch-identity",
    diagnostics: [],
  });
});

test("equivalent governed Change input produces the same canonical branch identity", () => {
  const naming = { type: "feat", slug: "derive-canonical-change-branch-identity" };
  const governance = { pattern: "^feat/[0-9]+-[a-z0-9-]+$" };
  const first = deriveCanonicalBranchIdentity({ change: validChange, branchGovernance: governance, naming });
  const equivalent = deriveCanonicalBranchIdentity({
    change: {
      ...validChange,
      identity: { ...validChange.identity, repositoryHost: "GITHUB.COM" },
    },
    branchGovernance: { ...governance },
    naming: { ...naming },
  });
  assert.deepEqual(equivalent, first);
  assert.deepEqual(deriveCanonicalBranchIdentity({ change: validChange, branchGovernance: governance, naming }), first);
});

test("missing or invalid branch governance fails closed with bounded structured diagnostics", () => {
  const missing = deriveCanonicalBranchIdentity({
    change: validChange,
    naming: { type: "feat", slug: "missing-governance" },
  } as unknown);
  assert.equal(missing.valid, false);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_MISSING_PROPERTY"));

  const invalid = deriveCanonicalBranchIdentity({
    change: validChange,
    branchGovernance: { pattern: "(a+)+$" },
    naming: { type: "feat", slug: "invalid-governance" },
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_BRANCH_GOVERNANCE"));
  assert.ok(invalid.diagnostics.every((diagnostic) => diagnostic.path.length <= MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH));
  assert.ok(
    invalid.diagnostics.every((diagnostic) => diagnostic.message.length <= MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH),
  );
});

test("a derived branch that does not satisfy repository governance fails closed", () => {
  const result = deriveCanonicalBranchIdentity({
    change: validChange,
    branchGovernance: { pattern: "^fix/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "governance-mismatch" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_BRANCH_GOVERNANCE_MISMATCH"));
});

test("legacy caller-selected branch projections remain valid for compatibility diagnostics", () => {
  const result = validateChange({
    ...validChange,
    projection: { branch: "feat/210-legacy-caller-branch" },
  });
  assert.equal(result.valid, true);
  assert.equal(result.change?.projection?.branch, "feat/210-legacy-caller-branch");
});

test("provenance keeps requester, issuer, implementer, reviewer, and merger distinct", () => {
  const result = validateChange(validChange);
  assert.equal(result.valid, true);
  assert.deepEqual(result.change?.provenance, validChange.provenance);
  assert.equal(isChange(result.change), true);
});

test("serialization is deterministic and safely round-trips optional projections", () => {
  const first = serializeChange(validChange);
  const reordered = {
    projection: { pullRequest: 321, branch: "feat/210-define-canonical-change-domain-contract" },
    provenance: {
      merger: "human:maintainer",
      reviewer: "human:reviewer",
      implementer: "agent:codex",
      issuer: "app:inari-issuer",
      requester: "human:sophia",
    },
    state: "DRAFT",
    identity: { rootIssue: 210, repositoryId: "100000210", repositoryHost: "GITHUB.COM" },
    version: CHANGE_CONTRACT_VERSION,
  } satisfies Record<string, unknown>;
  assert.equal(first, serializeChange(reordered));
  assert.deepEqual(deserializeChange(first), validChange);
  assert.equal(first, serializeChange(deserializeChange(first)));

  const legacyShape = { ...validChange };
  delete (legacyShape as { projection?: unknown }).projection;
  const parsed = deserializeChange(JSON.stringify(legacyShape));
  assert.equal(parsed.projection, undefined);
  assert.equal(serializeChange(parsed), JSON.stringify(legacyShape));
});

test("invalid Change input fails closed with bounded machine-readable diagnostics", () => {
  const result = validateChange({
    ...validChange,
    version: 2,
    state: "ready",
    unknown: true,
    identity: {
      repositoryHost: "github.com",
      repositoryId: "owner/repository",
      rootIssue: 0,
    },
    provenance: { issuer: "\u0000" },
    projection: { pullRequest: 0 },
  });
  assert.equal(result.valid, false);
  assert.equal(result.change, undefined);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_UNKNOWN_PROPERTY"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_UNSUPPORTED_VERSION"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_STATE"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_IDENTITY"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_PROVENANCE"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_PROJECTION"));
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.path.length <= MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH));
  assert.ok(
    result.diagnostics.every((diagnostic) => diagnostic.message.length <= MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH),
  );
});

test("diagnostic reports have deterministic ordering and explicit bounds", () => {
  const second = createChangeDiagnostic({ code: "CHANGE_INVALID_STATE", path: "$.state", message: "state" });
  const first = createChangeDiagnostic({ code: "CHANGE_INVALID_ROOT", path: "$", message: "root" });
  const report = createChangeDiagnosticReport([second, first]);
  assert.deepEqual(report.diagnostics, [first, second]);
  const serialized = serializeChangeDiagnosticReport(report);
  assert.equal(serialized, serializeChangeDiagnosticReport(deserializeChangeDiagnosticReport(serialized)));
  assert.throws(
    () =>
      createChangeDiagnostic({
        code: "CHANGE_INVALID_ROOT",
        message: "x".repeat(MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH + 1),
      }),
    /bound/,
  );
  assert.throws(
    () => createChangeDiagnosticReport(Array.from({ length: MAX_CHANGE_DIAGNOSTICS + 1 }, () => first)),
    /diagnostics are supported/,
  );
});

test("malformed serialized Change produces the same structured validation error contract", () => {
  assert.throws(
    () => deserializeChange("{"),
    (error: unknown) => {
      assert.ok(error instanceof ChangeValidationError);
      assert.equal(error.code, "CHANGE_INVALID_JSON");
      assert.equal(error.path, "$");
      return true;
    },
  );
});

const definedChange: Change = {
  version: CHANGE_CONTRACT_VERSION,
  identity: validChange.identity,
  state: "DEFINED",
  provenance: {
    requester: "human:sophia",
    issuer: "app:inari-issuer",
  },
};

const issueRequest = {
  version: CHANGE_TRANSITION_CONTRACT_VERSION,
  transition: "issue",
  change: definedChange,
  target: {
    branch: "feat/210-define-canonical-change-domain-contract",
    baseBranch: "main",
  },
} as const;

test("Core owns the lifecycle matrix and emits explicit issue effects", () => {
  const result = validateChangeTransitionRequest(issueRequest);
  assert.equal(result.valid, true);
  assert.equal(isChangeTransitionRequest(result.request), true);

  const plan = planChangeTransition(issueRequest);
  assert.equal(plan.from, "DEFINED");
  assert.equal(plan.to, "DRAFT");
  assert.deepEqual(plan.effects, [
    {
      kind: "CREATE_BRANCH",
      branch: "feat/210-define-canonical-change-domain-contract",
      baseBranch: "main",
    },
    {
      kind: "CREATE_PULL_REQUEST",
      branch: "feat/210-define-canonical-change-domain-contract",
      baseBranch: "main",
      rootIssue: 210,
      title: "Change #210",
      body: "Closes #210",
      draft: true,
    },
  ]);
  assert.deepEqual(plan.result, {
    ...definedChange,
    state: "DRAFT",
    projection: { branch: "feat/210-define-canonical-change-domain-contract" },
  });
  assert.equal(isChangeTransitionPlan(plan), true);
});

test("ready and abort produce Core-declared effects", () => {
  const readyPlan = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "ready",
    change: validChange,
  });
  assert.deepEqual(readyPlan.effects, [{ kind: "MARK_PULL_REQUEST_READY", pullRequest: 321 }]);
  assert.equal(readyPlan.to, "REVIEW");

  const abortPlan = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "abort",
    change: { ...validChange, state: "REVIEW" },
  });
  assert.deepEqual(abortPlan.effects, [
    { kind: "CLOSE_PULL_REQUEST", pullRequest: 321 },
    { kind: "DELETE_BRANCH", branch: "feat/210-define-canonical-change-domain-contract" },
  ]);
  assert.equal(abortPlan.to, "ABORTED");
});

test("abort retries are idempotent and recovery retries only canonical cleanup", () => {
  const alreadyAborted = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "abort",
    change: { ...validChange, state: "ABORTED" },
  });
  assert.deepEqual(alreadyAborted.effects, []);

  const recovery = planChangeTransition({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "abort",
    change: { ...validChange, state: "RECOVERY_REQUIRED" },
  });
  assert.deepEqual(recovery.effects, [
    { kind: "DELETE_BRANCH", branch: "feat/210-define-canonical-change-domain-contract" },
  ]);
  assert.equal(recovery.to, "ABORTED");
});

test("invalid and future transitions fail closed with structured diagnostics", () => {
  const invalid = validateChangeTransitionRequest({
    ...issueRequest,
    transition: "ready",
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.request, undefined);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_TRANSITION_NOT_ALLOWED"));
  assert.throws(
    () => planChangeTransition({ ...issueRequest, transition: "ready" }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeTransitionValidationError);
      assert.equal(error.code, "CHANGE_TRANSITION_NOT_ALLOWED");
      assert.ok(error.diagnostics.length > 0);
      return true;
    },
  );

  const future = validateChangeTransitionRequest({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "merge",
    change: validChange,
  });
  assert.equal(future.valid, false);
  assert.ok(future.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_UNSUPPORTED_TRANSITION"));

  const missingTarget = validateChangeTransitionRequest({
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
    transition: "issue",
    change: definedChange,
  });
  assert.equal(missingTarget.valid, false);
  assert.ok(missingTarget.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_TRANSITION_TARGET"));
});

test("transition request and plan serialization is deterministic and round-trips", () => {
  const reorderedRequest = {
    target: {
      baseBranch: "main",
      branch: "feat/210-define-canonical-change-domain-contract",
    },
    change: {
      provenance: { issuer: "app:inari-issuer", requester: "human:sophia" },
      state: "DEFINED",
      identity: { rootIssue: 210, repositoryId: "100000210", repositoryHost: "GITHUB.COM" },
      version: CHANGE_CONTRACT_VERSION,
    },
    transition: "ISSUE",
    version: CHANGE_TRANSITION_CONTRACT_VERSION,
  } satisfies Record<string, unknown>;
  const serializedRequest = serializeChangeTransitionRequest(issueRequest);
  assert.equal(serializedRequest, serializeChangeTransitionRequest(reorderedRequest));
  assert.deepEqual(deserializeChangeTransitionRequest(serializedRequest), issueRequest);
  assert.equal(isChangeTransitionRequest(deserializeChangeTransitionRequest(serializedRequest)), true);

  const plan = planChangeTransition(issueRequest);
  const serializedPlan = serializeChangeTransitionPlan(plan);
  assert.deepEqual(deserializeChangeTransitionPlan(serializedPlan), plan);
  assert.equal(serializedPlan, serializeChangeTransitionPlan(deserializeChangeTransitionPlan(serializedPlan)));
  assert.equal(validateChangeTransitionPlan(JSON.parse(serializedPlan)).valid, true);

  const invalidPlan = { ...plan, effects: [...plan.effects].reverse() };
  const invalidResult = validateChangeTransitionPlan(invalidPlan);
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.diagnostics.some((diagnostic) => diagnostic.code === "CHANGE_INVALID_PLAN"));
});

test("malformed transition JSON uses the structured Change error contract", () => {
  assert.throws(
    () => deserializeChangeTransitionPlan("{"),
    (error: unknown) => {
      assert.ok(error instanceof ChangeTransitionValidationError);
      assert.equal(error.code, "CHANGE_INVALID_JSON");
      assert.equal(error.path, "$");
      return true;
    },
  );
});
