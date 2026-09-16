import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendCertificationDiagnostic,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CertificationEvidenceError,
  assertCertificationEvidence,
  projectStructuredCommandError,
  readCertificationEvidence,
  sanitizeCertificationText,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
  SELF_DOGFOOD_RECONCILIATION_RECOVERY_OPERATION_REQUIREMENTS,
  SELF_DOGFOOD_SCENARIOS,
  serializeCertificationEvidence,
  sha256Tarball,
  validateCertificationEvidence,
  writeCertificationEvidence,
} from "../../scripts/certification-evidence.mjs";

const sourceCommitSha = "a".repeat(40);
const tarballSha256 = `sha256:${"b".repeat(64)}`;
const contractVersions = { goldenPath: "1", statusRecovery: "1", skill: "1.3.0" };

function structuredCommandError() {
  return {
    error: {
      code: "CHANGE_REMOTE_RUN_FAILED",
      message: "The trusted Change workflow did not produce a successful result.",
      details: {
        operation: "change.ready",
        reason: "workflow-failed",
        stage: "projection-execution",
        trustedCode: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        token: "issuer-secret",
        diagnostics: [
          {
            version: 1,
            code: "CHANGE_PROVENANCE_CONFLICT",
            path: "$.projection.change.provenance",
            message: "The trusted Change provenance is inconsistent.",
          },
        ],
        evidence: {
          version: 1,
          operation: "ready",
          outcome: "recovery-required",
          requester: "change-executor",
          issuer: "app-principal",
          effects: [
            { kind: "CREATE_PROVENANCE_COMMIT", status: "succeeded", createdCommitSha: "a".repeat(40) },
            { kind: "MARK_PULL_REQUEST_READY", status: "failed" },
          ],
          compensation: "failed",
          failure: {
            kind: "MARK_PULL_REQUEST_READY",
            code: "CHANGE_EFFECT_FAILED",
            message: "The ready effect failed.",
            reason: "provider-http",
            status: 422,
            provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
          },
        },
      },
    },
  };
}

test("projects structured Change errors through the canonical evidence authority", () => {
  const projected = projectStructuredCommandError(structuredCommandError());

  assert.deepEqual(projected, {
    code: "CHANGE_REMOTE_RUN_FAILED",
    message: "The trusted Change workflow did not produce a successful result.",
    structured: {
      details: {
        operation: "change.ready",
        reason: "workflow-failed",
        stage: "projection-execution",
        trustedCode: "CHANGE_EXECUTION_RECOVERY_REQUIRED",
        diagnostics: [
          {
            version: 1,
            code: "CHANGE_PROVENANCE_CONFLICT",
            path: "$.projection.change.provenance",
            message: "The trusted Change provenance is inconsistent.",
          },
        ],
        evidence: {
          version: 1,
          operation: "ready",
          outcome: "recovery-required",
          requester: "change-executor",
          issuer: "app-principal",
          effects: [
            { kind: "CREATE_PROVENANCE_COMMIT", status: "succeeded", createdCommitSha: "a".repeat(40) },
            { kind: "MARK_PULL_REQUEST_READY", status: "failed" },
          ],
          compensation: "failed",
          failure: {
            kind: "MARK_PULL_REQUEST_READY",
            code: "CHANGE_EFFECT_FAILED",
            message: "The ready effect failed.",
            reason: "provider-http",
            status: 422,
            provider: { category: "validation-failed", resource: "PullRequest", field: "head", code: "custom" },
          },
        },
      },
    },
  });
});

test("canonical structured projection fails closed for unknown and unsafe command evidence", () => {
  const command = structuredCommandError();
  const withUnknownErrorField = {
    ...command,
    error: { ...command.error, rawProviderPayload: "must not be recorded" },
  };
  assert.equal(projectStructuredCommandError(withUnknownErrorField), undefined);

  const withUnknownEvidenceField = {
    ...command,
    error: {
      ...command.error,
      details: {
        ...command.error.details,
        evidence: { ...command.error.details.evidence, unmodeledEvidence: "ignored" },
      },
    },
  };
  const unknownProjection = projectStructuredCommandError(withUnknownEvidenceField);
  assert.equal(unknownProjection?.structured.details?.evidence, undefined);

  const withUnsafeRequester = {
    ...command,
    error: {
      ...command.error,
      details: {
        ...command.error.details,
        evidence: { ...command.error.details.evidence, requester: "https://provider.example.invalid/raw" },
      },
    },
  };
  const unsafeProjection = projectStructuredCommandError(withUnsafeRequester);
  assert.equal(unsafeProjection?.structured.details?.evidence, undefined);
  assert.equal(sanitizeCertificationText("https://provider.example.invalid/raw"), undefined);
  assert.doesNotMatch(JSON.stringify(unknownProjection), /must not be recorded|rawProviderPayload/iu);
});

function packedEvidence(overrides = {}) {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: "packed-artifact-golden-path",
    result: "passed",
    sourceCommitSha,
    contractVersions: { ...contractVersions },
    package: { name: "gh-inari", version: "0.11.0", tarballSha256 },
    diagnostics: [],
    ...overrides,
  };
}

test("validates the frozen packed-artifact evidence envelope", () => {
  const evidence = packedEvidence();
  assert.deepEqual(validateCertificationEvidence(evidence), {
    valid: true,
    errors: [],
    evidence,
    diagnostics: [],
  });
  assert.doesNotThrow(() =>
    assertCertificationEvidence(evidence, { certificationKind: "packed-artifact-golden-path" }),
  );
});

test("rejects blocked packed evidence instead of treating an incomplete lane as certification", () => {
  const evidence = packedEvidence({
    result: "blocked",
    diagnostics: [{ code: "PACKED_CERTIFICATION_FAILED", message: "The installed artifact failed." }],
  });
  assert.equal(validateCertificationEvidence(evidence).valid, false);
  assert.throws(() => assertCertificationEvidence(evidence), CertificationEvidenceError);
});

test("serializes evidence with deterministic key order", () => {
  const evidence = packedEvidence();
  assert.equal(
    serializeCertificationEvidence(evidence),
    JSON.stringify({
      schemaVersion: "1",
      certificationKind: "packed-artifact-golden-path",
      result: "passed",
      sourceCommitSha,
      contractVersions: { ...contractVersions },
      package: { name: "gh-inari", version: "0.11.0", tarballSha256 },
      diagnostics: [],
    }) + "\n",
  );
});

for (const [label, mutate] of [
  ["schema version", (value) => ({ ...value, schemaVersion: "2" })],
  ["source SHA case", (value) => ({ ...value, sourceCommitSha: "A".repeat(40) })],
  ["source SHA length", (value) => ({ ...value, sourceCommitSha: "a".repeat(39) })],
  ["tarball digest prefix", (value) => ({ ...value, package: { ...value.package, tarballSha256: "b".repeat(64) } })],
  [
    "tarball digest case",
    (value) => ({ ...value, package: { ...value.package, tarballSha256: `sha256:${"B".repeat(64)}` } }),
  ],
  ["unknown top-level property", (value) => ({ ...value, mutableLastGreen: true })],
  ["unknown package property", (value) => ({ ...value, package: { ...value.package, digest: "other" } })],
  [
    "diagnostic count",
    (value) => ({
      ...value,
      result: "failed",
      diagnostics: Array.from({ length: 21 }, () => ({ code: "E", message: "x" })),
    }),
  ],
  [
    "diagnostic message bound",
    (value) => ({ ...value, result: "failed", diagnostics: [{ code: "E", message: "x".repeat(513) }] }),
  ],
  [
    "diagnostic unsafe message",
    (value) => ({
      ...value,
      result: "failed",
      diagnostics: [{ code: "E", message: "https://provider.example.invalid/raw" }],
    }),
  ],
  ["diagnostics on pass", (value) => ({ ...value, diagnostics: [{ code: "E", message: "failure" }] })],
]) {
  test(`rejects ${label}`, () => {
    const result = validateCertificationEvidence(mutate(packedEvidence()));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.throws(() => assertCertificationEvidence(mutate(packedEvidence())), CertificationEvidenceError);
  });
}

test("appended structured diagnostics are normalized by the canonical authority", () => {
  const diagnostics = [];
  appendCertificationDiagnostic(diagnostics, "CHANGE_FAILED", "safe message", {
    details: { operation: "change.ready", token: "issuer-secret" },
    evidence: {
      version: 1,
      operation: "ready",
      outcome: "failed",
      effects: [{ kind: "MARK_PULL_REQUEST_READY", status: "failed" }],
    },
  });

  assert.deepEqual(diagnostics, [
    {
      code: "CHANGE_FAILED",
      message: "safe message",
      details: { operation: "change.ready" },
      evidence: {
        version: 1,
        operation: "ready",
        outcome: "failed",
        effects: [{ kind: "MARK_PULL_REQUEST_READY", status: "failed" }],
      },
    },
  ]);
});

test("compares observed contract versions only when an expected version set is supplied", () => {
  const evidence = packedEvidence({
    contractVersions: { ...contractVersions, skill: "1.2.0" },
  });
  assert.equal(validateCertificationEvidence(evidence).valid, true);
  assert.equal(validateCertificationEvidence(evidence, { contractVersions }).valid, false);
});

function dogfoodOperations(requirements) {
  let operations = [];
  for (const requirement of requirements) {
    operations = [
      ...operations,
      { operation: requirement.operation, outcome: requirement.outcomes[0] },
    ];
  }
  return operations;
}

function dogfoodEvidence(overrides = {}) {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: "self-dogfood-golden-path",
    result: "passed",
    sourceCommitSha,
    contractVersions: { ...contractVersions },
    diagnostics: [],
    repository: { owner: "yohn-jp", name: "gh-inari" },
    scenario: SELF_DOGFOOD_SCENARIOS.FRESH_CREATE,
    rootIssue: 614,
    change: { issue: 614, branch: "chore/614-isolate-fresh-self-dogfood-fixtures", pullRequest: 622 },
    operations: dogfoodOperations(SELF_DOGFOOD_OPERATION_REQUIREMENTS),
    finalState: { status: "REVIEW", recovery: { state: "NONE", action: null } },
    ...overrides,
  };
}

test("a strict passed fresh-create evidence document still requires a verified fresh preflight", () => {
  const withoutFreshPreflight = dogfoodEvidence({
    operations: dogfoodOperations(
      SELF_DOGFOOD_OPERATION_REQUIREMENTS.filter((entry) => entry.operation !== "change.issue.fresh-preflight"),
    ),
  });
  const result = validateCertificationEvidence(withoutFreshPreflight, { certificationKind: "self-dogfood-golden-path" });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "DOGFOOD_OPERATION_MISSING"));
});

test("a strict passed reconciliation/recovery evidence document does not require or accept a fresh preflight claim", () => {
  const reconciliationEvidence = dogfoodEvidence({
    scenario: SELF_DOGFOOD_SCENARIOS.RECONCILIATION_RECOVERY,
    operations: dogfoodOperations(SELF_DOGFOOD_RECONCILIATION_RECOVERY_OPERATION_REQUIREMENTS),
  });
  const result = validateCertificationEvidence(reconciliationEvidence, {
    certificationKind: "self-dogfood-golden-path",
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);

  const claimingFreshPreflight = dogfoodEvidence({
    scenario: SELF_DOGFOOD_SCENARIOS.RECONCILIATION_RECOVERY,
    operations: [
      ...dogfoodOperations(SELF_DOGFOOD_RECONCILIATION_RECOVERY_OPERATION_REQUIREMENTS),
      { operation: "change.issue.fresh-preflight", outcome: "verified" },
    ],
  });
  const contradictoryResult = validateCertificationEvidence(claimingFreshPreflight, {
    certificationKind: "self-dogfood-golden-path",
  });
  assert.equal(contradictoryResult.valid, false);
  assert.ok(contradictoryResult.diagnostics.some((diagnostic) => diagnostic.code === "DOGFOOD_OPERATION_MISSING"));
});

test("computes and round-trips an exact tarball digest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inari-evidence-test-"));
  const filePath = path.join(directory, "package.tgz");
  const bytes = crypto.randomBytes(128);
  fs.writeFileSync(filePath, bytes);
  try {
    const expected = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(sha256Tarball(filePath), expected);
    const evidencePath = path.join(directory, "evidence.json");
    writeCertificationEvidence(
      evidencePath,
      packedEvidence({ package: { ...packedEvidence().package, tarballSha256: expected } }),
    );
    assert.deepEqual(
      readCertificationEvidence(evidencePath),
      packedEvidence({ package: { ...packedEvidence().package, tarballSha256: expected } }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
