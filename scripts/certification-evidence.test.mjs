import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CertificationEvidenceError,
  assertCertificationEvidence,
  readCertificationEvidence,
  serializeCertificationEvidence,
  sha256Tarball,
  validateCertificationEvidence,
  writeCertificationEvidence,
} from "./certification-evidence.mjs";

const sourceCommitSha = "a".repeat(40);
const tarballSha256 = `sha256:${"b".repeat(64)}`;

function packedEvidence(overrides = {}) {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: "packed-artifact-golden-path",
    result: "passed",
    sourceCommitSha,
    contractVersions: { goldenPath: "402.1.0", statusRecovery: "403.1.0", skill: "404.1.0" },
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

test("serializes evidence with deterministic key order", () => {
  const evidence = packedEvidence();
  assert.equal(
    serializeCertificationEvidence(evidence),
    JSON.stringify({
      schemaVersion: "1",
      certificationKind: "packed-artifact-golden-path",
      result: "passed",
      sourceCommitSha,
      contractVersions: { goldenPath: "402.1.0", statusRecovery: "403.1.0", skill: "404.1.0" },
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
  ["diagnostics on pass", (value) => ({ ...value, diagnostics: [{ code: "E", message: "failure" }] })],
]) {
  test(`rejects ${label}`, () => {
    const result = validateCertificationEvidence(mutate(packedEvidence()));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.throws(() => assertCertificationEvidence(mutate(packedEvidence())), CertificationEvidenceError);
  });
}

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
