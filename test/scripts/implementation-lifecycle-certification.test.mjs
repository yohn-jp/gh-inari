import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPLEMENTATION_LIFECYCLE_CERTIFICATION_KIND,
  IMPLEMENTATION_LIFECYCLE_OPERATION_REQUIREMENTS,
  appendImplementationLifecycleOperation,
  serializeCertificationEvidence,
  validateImplementationLifecycleCertificationEvidence,
} from "../../scripts/certification-evidence.mjs";

function operations() {
  let value = [];
  for (const requirement of IMPLEMENTATION_LIFECYCLE_OPERATION_REQUIREMENTS)
    value = appendImplementationLifecycleOperation(value, requirement.operation, requirement.outcomes[0]);
  return value;
}

function evidence(overrides = {}) {
  return {
    schemaVersion: "1",
    certificationKind: IMPLEMENTATION_LIFECYCLE_CERTIFICATION_KIND,
    result: "passed",
    sourceCommitSha: "a".repeat(40),
    contractVersions: { goldenPath: "1", statusRecovery: "1", skill: "1.6.0" },
    package: { name: "gh-inari", version: "0.13.0", tarballSha256: `sha256:${"b".repeat(64)}` },
    repository: { owner: "yohn-jp", name: "gh-inari" },
    sourceIssue: 689,
    implementation: {
      issue: 1689,
      branch: "test/1689-implementation-native-lifecycle-certification",
      pullRequest: 2689,
    },
    session: {
      capabilities: [
        { kind: "change.implement", issue: 1689 },
        { kind: "change.ready", issue: 1689 },
        { kind: "change.merge", issue: 1689 },
        {
          kind: "branch.advance",
          branch: "test/1689-implementation-native-lifecycle-certification",
          pathPolicy: "scripts/**",
        },
      ],
    },
    operations: operations(),
    finalState: { implementation: "COMPLETED", change: "MERGED", source: "CLOSED", frontier: "SATISFIED" },
    diagnostics: [],
    ...overrides,
  };
}

test("Issue #689 lifecycle evidence requires the exact bounded sequence and terminal projection", () => {
  const value = evidence();
  assert.equal(validateImplementationLifecycleCertificationEvidence(value).valid, true);
  const serialized = serializeCertificationEvidence(value);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(serialized.includes("bearer"), false);
});

test("Issue #689 lifecycle evidence fails closed for sequence drift and unknown secret-shaped fields", () => {
  const drifted = evidence({ operations: [...operations()].reverse() });
  assert.equal(validateImplementationLifecycleCertificationEvidence(drifted).valid, false);

  const secretField = evidence({ session: { capabilities: [{ kind: "change.merge", issue: 1689, privateKey: "x" }] } });
  assert.equal(validateImplementationLifecycleCertificationEvidence(secretField).valid, false);
});
