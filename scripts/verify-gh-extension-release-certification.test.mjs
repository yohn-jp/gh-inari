import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendSelfDogfoodOperation,
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  CERTIFICATION_KINDS,
  CERTIFICATION_RESULTS,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
} from "./certification-evidence.mjs";
import {
  buildArtifactManifest,
  computeArtifactManifestSha256,
  parseWorkflowContext,
  runWorkflowCertification,
} from "./verify-gh-extension-release-certification.mjs";
import {
  RELEASE_CERTIFICATION_CONTRACT_VERSIONS,
  verifyGhExtensionReleaseCertification,
} from "../src/release-certification.js";

const SOURCE_SHA = "a".repeat(40);
const OTHER_SOURCE_SHA = "b".repeat(40);
const CONTRACT_VERSIONS = { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS };

function dogfoodOperations() {
  let operations = [];
  for (const requirement of SELF_DOGFOOD_OPERATION_REQUIREMENTS)
    operations = appendSelfDogfoodOperation(operations, requirement.operation, requirement.outcomes[0]);
  return operations;
}

function dogfoodEvidence(overrides = {}) {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[1],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: CONTRACT_VERSIONS,
    diagnostics: [],
    repository: { owner: "yohn-jp", name: "gh-inari" },
    rootIssue: 405,
    change: { issue: 405, branch: "feat/405-certification", pullRequest: 999 },
    operations: dogfoodOperations(),
    finalState: { status: "REVIEW", recovery: { state: "NONE", action: null } },
    ...overrides,
  };
}

function makeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inari-gh-extension-certification-test-"));
}

function writeArtifacts(
  directory,
  entries = [
    ["gh-inari-linux-amd64", "linux artifact"],
    ["gh-inari-darwin-arm64", "darwin artifact"],
  ],
) {
  for (const [name, contents] of entries) fs.writeFileSync(path.join(directory, name), contents);
}

function sharedManifest(directory) {
  return Buffer.from(
    fs
      .readdirSync(directory)
      .map((name) => {
        const digest = crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(directory, name)))
          .digest("hex");
        return `${digest}  ${name}\n`;
      })
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .join(""),
  );
}

function environment(directory, manifestSha256, overrides = {}) {
  return {
    GITHUB_REPOSITORY: "yohn-jp/gh-inari",
    RELEASE_SOURCE_SHA: SOURCE_SHA,
    RELEASE_TAG: "v0.11.0",
    RELEASE_ARTIFACT_DIR: directory,
    RELEASE_ARTIFACT_MANIFEST_SHA256: manifestSha256,
    ...overrides,
  };
}

function fixture() {
  const directory = makeDirectory();
  writeArtifacts(directory);
  return { directory, manifest: sharedManifest(directory) };
}

function extensionIdentity(manifestSha256, overrides = {}) {
  return {
    expectedReleaseSourceCommitSha: SOURCE_SHA,
    expectedRepositoryOwner: "yohn-jp",
    expectedRepositoryName: "gh-inari",
    expectedReleaseTag: "v0.11.0",
    expectedArtifactManifestSha256: manifestSha256,
    observedArtifactManifestSha256: manifestSha256,
    dogfoodEvidence: dogfoodEvidence(),
    ...overrides,
  };
}

test("parses the no-argument shared-workflow environment contract", () => {
  const directory = makeDirectory();
  try {
    const context = parseWorkflowContext(environment(directory, "a".repeat(64)));
    assert.deepEqual(context, {
      repositoryOwner: "yohn-jp",
      repositoryName: "gh-inari",
      sourceSha: SOURCE_SHA,
      releaseTag: "v0.11.0",
      artifactDirectory: path.resolve(directory),
      artifactManifestSha256: "a".repeat(64),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects missing, malformed, or repository-mismatched workflow context", () => {
  const directory = makeDirectory();
  try {
    assert.throws(
      () => parseWorkflowContext({ ...environment(directory, "a".repeat(64)), RELEASE_TAG: undefined }),
      /missing workflow context: RELEASE_TAG/u,
    );
    assert.throws(() => parseWorkflowContext(environment(directory, "A".repeat(64))), /lowercase SHA-256/u);
    assert.throws(
      () => parseWorkflowContext(environment(directory, "a".repeat(64), { GITHUB_REPOSITORY: "other/repo" })),
      /GITHUB_REPOSITORY must be yohn-jp\/gh-inari/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("matches the shared workflow manifest bytes and is stable across enumeration order", () => {
  const first = makeDirectory();
  const second = makeDirectory();
  try {
    writeArtifacts(first, [
      ["gh-inari-linux-amd64", "first"],
      ["gh-inari-darwin-arm64", "second"],
      ["gh-inari-windows-amd64.exe", "third"],
    ]);
    writeArtifacts(second, [
      ["gh-inari-windows-amd64.exe", "third"],
      ["gh-inari-darwin-arm64", "second"],
      ["gh-inari-linux-amd64", "first"],
    ]);
    assert.deepEqual(buildArtifactManifest(first), sharedManifest(first));
    assert.deepEqual(buildArtifactManifest(second), sharedManifest(second));
    assert.equal(computeArtifactManifestSha256(first), computeArtifactManifestSha256(second));
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("rejects missing, empty, nested, symlinked, and unsupported artifact entries", () => {
  const missing = path.join(makeDirectory(), "missing");
  assert.throws(() => buildArtifactManifest(missing), /artifact directory is unavailable/u);
  fs.rmSync(path.dirname(missing), { recursive: true, force: true });

  const empty = makeDirectory();
  assert.throws(() => buildArtifactManifest(empty), /artifact directory is empty/u);
  fs.rmSync(empty, { recursive: true, force: true });

  const nested = makeDirectory();
  fs.mkdirSync(path.join(nested, "nested"));
  assert.throws(() => buildArtifactManifest(nested), /direct regular file|naming surface/u);
  fs.rmSync(nested, { recursive: true, force: true });

  const unsupported = makeDirectory();
  fs.writeFileSync(path.join(unsupported, "gh-inari-plan9-amd64"), "unsupported");
  assert.throws(() => buildArtifactManifest(unsupported), /naming surface/u);
  fs.rmSync(unsupported, { recursive: true, force: true });

  const symlinked = makeDirectory();
  const target = path.join(symlinked, "target");
  fs.writeFileSync(target, "target");
  fs.symlinkSync(target, path.join(symlinked, "gh-inari-linux-amd64"));
  assert.throws(() => buildArtifactManifest(symlinked), /symlink/u);
  fs.rmSync(symlinked, { recursive: true, force: true });
});

test("rejects file drift during manifest construction", () => {
  const directory = makeDirectory();
  writeArtifacts(directory);
  const originalReadDirectory = fs.readdirSync;
  let calls = 0;
  fs.readdirSync = (...args) => {
    const result = originalReadDirectory(...args);
    calls += 1;
    if (calls === 2) fs.appendFileSync(path.join(directory, "gh-inari-linux-amd64"), " drift");
    return result;
  };
  try {
    assert.throws(() => buildArtifactManifest(directory), /changed during manifest construction/u);
  } finally {
    fs.readdirSync = originalReadDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects checkout/source and manifest mismatches before certifying", async () => {
  const { directory } = fixture();
  try {
    const sourceMismatch = await runWorkflowCertification({
      environment: environment(directory, computeArtifactManifestSha256(directory)),
      currentSourceSha: OTHER_SOURCE_SHA,
      dogfoodEvidenceRetriever: async () => dogfoodEvidence(),
    });
    assert.equal(sourceMismatch.diagnostics[0].code, "SOURCE_SHA_MISMATCH");

    const manifestMismatch = await runWorkflowCertification({
      environment: environment(directory, "c".repeat(64)),
      currentSourceSha: SOURCE_SHA,
      dogfoodEvidenceRetriever: async () => dogfoodEvidence(),
    });
    assert.equal(manifestMismatch.diagnostics[0].code, "ARTIFACT_MANIFEST_MISMATCH");
    assert.equal(manifestMismatch.diagnostics[0].message.length <= 512, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reuses the exact-source dogfood retrieval seam and certifies the complete identity", async () => {
  const { directory, manifest } = fixture();
  try {
    let retrievalInput;
    const result = await runWorkflowCertification({
      environment: environment(directory, crypto.createHash("sha256").update(manifest).digest("hex")),
      currentSourceSha: SOURCE_SHA,
      dogfoodEvidenceRetriever: async (input) => {
        retrievalInput = input;
        return dogfoodEvidence();
      },
    });
    assert.deepEqual(result, { passed: true, diagnostics: [] });
    assert.equal(retrievalInput.sourceSha, SOURCE_SHA);
    assert.equal(retrievalInput.repositoryOwner, "yohn-jp");
    assert.equal(retrievalInput.repositoryName, "gh-inari");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical extension composition rejects missing, malformed, stale, and repository-mismatched evidence", () => {
  const manifest = "d".repeat(64);
  assert.equal(
    verifyGhExtensionReleaseCertification(extensionIdentity(manifest, { dogfoodEvidence: undefined })).passed,
    false,
  );
  const malformed = verifyGhExtensionReleaseCertification(
    extensionIdentity(manifest, { dogfoodEvidence: { malformed: true } }),
  );
  assert.equal(malformed.diagnostics[0].code, "EVIDENCE_MALFORMED");
  const stale = verifyGhExtensionReleaseCertification(
    extensionIdentity(manifest, { dogfoodEvidence: dogfoodEvidence({ sourceCommitSha: OTHER_SOURCE_SHA }) }),
  );
  assert.equal(stale.diagnostics[0].code, "SOURCE_SHA_MISMATCH");
  const repositoryMismatch = verifyGhExtensionReleaseCertification(
    extensionIdentity(manifest, { dogfoodEvidence: dogfoodEvidence({ repository: { owner: "other", name: "repo" } }) }),
  );
  assert.equal(repositoryMismatch.diagnostics[0].code, "REPOSITORY_MISMATCH");
});

test("bounds extension diagnostics and rejects malformed identity digests", () => {
  const malformedIdentity = verifyGhExtensionReleaseCertification(
    extensionIdentity("not-a-digest", { observedArtifactManifestSha256: "e".repeat(64) }),
  );
  assert.equal(malformedIdentity.diagnostics[0].code, "EXPECTED_IDENTITY_INVALID");

  const malformedObserved = verifyGhExtensionReleaseCertification(
    extensionIdentity("e".repeat(64), { observedArtifactManifestSha256: "not-a-digest" }),
  );
  assert.equal(malformedObserved.diagnostics[0].code, "ARTIFACT_MANIFEST_INVALID");
  assert.ok(malformedObserved.diagnostics.every(({ message }) => message.length <= 512));
});
