import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANGE_CONTRACT_VERSION,
  CHANGE_STATES,
  MAX_CHANGE_DIAGNOSTICS,
  MAX_CHANGE_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CHANGE_DIAGNOSTIC_PATH_LENGTH,
  ChangeValidationError,
  changeIdentityKey,
  createChangeDiagnostic,
  createChangeDiagnosticReport,
  deserializeChange,
  deserializeChangeDiagnosticReport,
  isChange,
  serializeChange,
  serializeChangeDiagnosticReport,
  validateChange,
  validateChangeIdentity,
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
