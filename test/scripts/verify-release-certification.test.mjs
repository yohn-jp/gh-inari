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
  selfDogfoodArtifactName,
} from "../../scripts/certification-evidence.mjs";
import {
  RELEASE_CERTIFICATION_CONTRACT_VERSIONS,
  RELEASE_CERTIFICATION_SCHEMA_VERSION,
} from "../../src/release-certification.js";
import {
  extractSelfDogfoodEvidence,
  generatePackedEvidence,
  parseArgs,
  parseWorkflowContext,
  resolveSelfDogfoodWorkflowRun,
  retrieveSelfDogfoodEvidence,
  runWorkflowCertification,
} from "../../scripts/verify-release-certification.mjs";

const SOURCE_SHA = "a".repeat(40);
const OTHER_SOURCE_SHA = "b".repeat(40);
const DOGFOOD_RUN_ID = "4101";
const DOGFOOD_RUN_ATTEMPT = "1";
const PACKAGE = { name: "gh-inari", version: "0.12.0" };
const CONTRACT_VERSIONS = { ...RELEASE_CERTIFICATION_CONTRACT_VERSIONS };
const BASE_ARGS = [
  "--source-sha",
  SOURCE_SHA,
  "--package-name",
  PACKAGE.name,
  "--package-version",
  PACKAGE.version,
  "--tarball-sha256",
  `sha256:${"a".repeat(64)}`,
  "--repository-owner",
  "yohn-jp",
  "--repository-name",
  "gh-inari",
  "--packed-evidence",
  "packed.json",
  "--dogfood-evidence",
  "dogfood.json",
  "--dogfood-workflow-run-id",
  DOGFOOD_RUN_ID,
  "--dogfood-workflow-run-attempt",
  DOGFOOD_RUN_ATTEMPT,
];

function dogfoodOperations() {
  let operations = [];
  for (const requirement of SELF_DOGFOOD_OPERATION_REQUIREMENTS)
    operations = appendSelfDogfoodOperation(operations, requirement.operation, requirement.outcomes[0]);
  return operations;
}

function packedEvidence(overrides = {}) {
  return {
    schemaVersion: RELEASE_CERTIFICATION_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[0],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...CONTRACT_VERSIONS },
    package: { name: PACKAGE.name, version: PACKAGE.version, tarballSha256: `sha256:${"c".repeat(64)}` },
    diagnostics: [],
    ...overrides,
  };
}

function dogfoodEvidence(overrides = {}) {
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: CERTIFICATION_KINDS[1],
    result: CERTIFICATION_RESULTS[0],
    sourceCommitSha: SOURCE_SHA,
    contractVersions: { ...CONTRACT_VERSIONS },
    diagnostics: [],
    repository: { owner: "yohn-jp", name: "gh-inari" },
    workflow: { runId: DOGFOOD_RUN_ID, runAttempt: DOGFOOD_RUN_ATTEMPT },
    scenario: "fresh-create",
    rootIssue: 405,
    change: { issue: 405, branch: "feat/405-certification", pullRequest: 999 },
    operations: dogfoodOperations(),
    finalState: { status: "REVIEW", recovery: { state: "NONE", action: null } },
    ...overrides,
  };
}

function digestFor(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function workflowEnvironment(artifactPath, artifactSha256, overrides = {}) {
  return {
    GITHUB_REPOSITORY: "yohn-jp/gh-inari",
    RELEASE_SOURCE_SHA: SOURCE_SHA,
    RELEASE_TAG: `v${PACKAGE.version}`,
    RELEASE_ARTIFACT_PATH: artifactPath,
    RELEASE_ARTIFACT_SHA256: artifactSha256,
    ...overrides,
  };
}

function temporaryArtifact() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inari-release-verifier-test-"));
  const artifactPath = path.join(directory, "gh-inari.tgz");
  fs.writeFileSync(artifactPath, "exact release artifact bytes");
  return { directory, artifactPath, artifactSha256: digestFor(artifactPath) };
}

function jsonResponse(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
}

test("parses every required explicit option", () => {
  assert.deepEqual(parseArgs(BASE_ARGS), {
    sourceSha: SOURCE_SHA,
    packageName: PACKAGE.name,
    packageVersion: PACKAGE.version,
    tarballSha256: `sha256:${"a".repeat(64)}`,
    repositoryOwner: "yohn-jp",
    repositoryName: "gh-inari",
    packedEvidence: "packed.json",
    dogfoodEvidence: "dogfood.json",
    dogfoodWorkflowRunId: DOGFOOD_RUN_ID,
    dogfoodWorkflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
  });
});

test("retains deterministic explicit argument failures", () => {
  assert.throws(() => parseArgs([...BASE_ARGS, "--unknown-flag", "x"]), /unknown option/u);
  assert.throws(() => parseArgs([...BASE_ARGS, "--source-sha", "x"]), /duplicate option/u);
  assert.throws(() => parseArgs(["--source-sha"]), /usage:/u);
});

test("parses the no-argument reusable-workflow context", () => {
  const context = parseWorkflowContext(
    workflowEnvironment("./release.tgz", "a".repeat(64), { RELEASE_SOURCE_SHA: SOURCE_SHA }),
  );
  assert.deepEqual(context, {
    repositoryOwner: "yohn-jp",
    repositoryName: "gh-inari",
    sourceSha: SOURCE_SHA,
    releaseTag: `v${PACKAGE.version}`,
    artifactPath: path.resolve("./release.tgz"),
    artifactSha256: "a".repeat(64),
  });
});

test("rejects missing or invalid workflow context", () => {
  assert.throws(
    () => parseWorkflowContext({ ...workflowEnvironment("release.tgz", "a".repeat(64)), RELEASE_TAG: undefined }),
    /missing workflow context: RELEASE_TAG/u,
  );
  assert.throws(
    () => parseWorkflowContext({ ...workflowEnvironment("release.tgz", "A".repeat(64)) }),
    /lowercase SHA-256/u,
  );
  assert.throws(
    () =>
      parseWorkflowContext({ ...workflowEnvironment("release.tgz", "a".repeat(64)), GITHUB_REPOSITORY: "other/repo" }),
    /GITHUB_REPOSITORY must be yohn-jp\/gh-inari/u,
  );
});

test("resolves a retained passing attempt without letting a failed rerun replace it", async () => {
  const requests = [];
  const candidateAttempts = [];
  const artifact = (runId, runAttempt, createdAt) => ({
    id: Number(runId) * 10 + Number(runAttempt),
    name: selfDogfoodArtifactName(SOURCE_SHA, runId, runAttempt),
    expired: false,
    created_at: createdAt,
    expires_at: "2026-03-01T00:00:00Z",
    workflow_run: { id: Number(runId), run_attempt: Number(runAttempt), head_sha: SOURCE_SHA },
  });
  const resolved = await resolveSelfDogfoodWorkflowRun({
    sourceSha: SOURCE_SHA,
    environment: { GITHUB_API_URL: "https://api.example.test", GITHUB_TOKEN: "bounded-token" },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        artifacts: [
          artifact("4101", "1", "2025-12-31T00:00:00Z"),
          artifact("4101", "2", "2025-12-31T00:02:00Z"),
          artifact("4102", "1", "2025-12-31T00:01:00Z"),
        ],
      });
    },
    now: Date.parse("2026-01-01T00:00:00Z"),
    candidateEvidenceRetriever: async ({ workflowRunId, workflowRunAttempt }) => {
      candidateAttempts.push({ workflowRunId, workflowRunAttempt });
      return dogfoodEvidence({
        result: workflowRunId === "4101" && workflowRunAttempt === "1" ? "passed" : "blocked",
        workflow: { runId: workflowRunId, runAttempt: workflowRunAttempt },
      });
    },
  });
  assert.deepEqual(resolved, { workflowRunId: "4101", workflowRunAttempt: "1" });
  assert.deepEqual(candidateAttempts, [
    { workflowRunId: "4101", workflowRunAttempt: "2" },
    { workflowRunId: "4102", workflowRunAttempt: "1" },
    { workflowRunId: "4101", workflowRunAttempt: "1" },
  ]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /repos\/yohn-jp\/gh-inari\/actions\/artifacts\?per_page=100$/u);
  assert.equal(requests[0].init.headers.authorization, "Bearer bounded-token");
});

test("fails closed when retained self-dogfood artifacts have no passing evidence", async () => {
  const base = {
    sourceSha: SOURCE_SHA,
    environment: { GITHUB_API_URL: "https://api.example.test" },
    now: Date.parse("2026-01-01T00:00:00Z"),
  };
  await assert.rejects(
    resolveSelfDogfoodWorkflowRun({ ...base, fetchImpl: async () => jsonResponse({ artifacts: [] }) }),
    /no retained self-dogfood artifact/u,
  );
  await assert.rejects(
    resolveSelfDogfoodWorkflowRun({
      ...base,
      fetchImpl: async () =>
        jsonResponse({
          artifacts: [
            {
              id: 4101,
              name: selfDogfoodArtifactName(SOURCE_SHA, DOGFOOD_RUN_ID, DOGFOOD_RUN_ATTEMPT),
              expired: false,
              created_at: "2025-12-31T00:00:00Z",
              expires_at: "2026-03-01T00:00:00Z",
              workflow_run: { id: Number(DOGFOOD_RUN_ID), run_attempt: 1, head_sha: SOURCE_SHA },
            },
          ],
        }),
      candidateEvidenceRetriever: async () => dogfoodEvidence({ result: "blocked" }),
    }),
    /no retained passing self-dogfood artifact/u,
  );
});

test("runs packed certification with the supplied tarball and never invokes npm pack", () => {
  const fixture = temporaryArtifact();
  try {
    const evidencePath = path.join(fixture.directory, "packed.json");
    const commandCalls = [];
    const evidence = packedEvidence({ package: { ...PACKAGE, tarballSha256: `sha256:${"c".repeat(64)}` } });
    const result = generatePackedEvidence({
      artifactPath: fixture.artifactPath,
      evidencePath,
      runCommand(command, args) {
        commandCalls.push({ command, args });
        fs.writeFileSync(evidencePath, JSON.stringify(evidence));
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(result, evidence);
    assert.equal(commandCalls.length, 1);
    assert.equal(commandCalls[0].args.includes("npm"), false);
    assert.deepEqual(commandCalls[0].args.slice(-4), ["--tarball", fixture.artifactPath, "--evidence", evidencePath]);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a missing release artifact before any evidence composition", async () => {
  const fixture = temporaryArtifact();
  fs.rmSync(fixture.artifactPath);
  try {
    let composed = false;
    const result = await runWorkflowCertification({
      environment: workflowEnvironment(fixture.artifactPath, fixture.artifactSha256),
      currentSourceSha: SOURCE_SHA,
      packageMetadata: PACKAGE,
      packedEvidenceGenerator: async () => {
        composed = true;
        return packedEvidence();
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.diagnostics[0].code, "ARTIFACT_FILE_INVALID");
    assert.equal(composed, false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects checkout/source and supplied artifact digest mismatches", async () => {
  const fixture = temporaryArtifact();
  try {
    const sourceMismatch = await runWorkflowCertification({
      environment: workflowEnvironment(fixture.artifactPath, fixture.artifactSha256),
      currentSourceSha: OTHER_SOURCE_SHA,
      packageMetadata: PACKAGE,
    });
    assert.equal(sourceMismatch.diagnostics[0].code, "SOURCE_SHA_MISMATCH");

    const digestMismatch = await runWorkflowCertification({
      environment: workflowEnvironment(fixture.artifactPath, "d".repeat(64)),
      currentSourceSha: SOURCE_SHA,
      packageMetadata: PACKAGE,
    });
    assert.equal(digestMismatch.diagnostics[0].code, "TARBALL_DIGEST_MISMATCH");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a release tag/package version mismatch", async () => {
  const fixture = temporaryArtifact();
  try {
    const result = await runWorkflowCertification({
      environment: workflowEnvironment(fixture.artifactPath, fixture.artifactSha256, { RELEASE_TAG: "v0.13.0" }),
      currentSourceSha: SOURCE_SHA,
      packageMetadata: PACKAGE,
    });
    assert.equal(result.diagnostics[0].code, "PACKAGE_VERSION_MISMATCH");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("composes a successful workflow result from exact-artifact and exact-source evidence", async () => {
  const fixture = temporaryArtifact();
  try {
    let packedInput;
    let dogfoodInput;
    const result = await runWorkflowCertification({
      environment: workflowEnvironment(fixture.artifactPath, fixture.artifactSha256),
      currentSourceSha: SOURCE_SHA,
      packageMetadata: PACKAGE,
      workflowRunResolver: async () => ({
        workflowRunId: DOGFOOD_RUN_ID,
        workflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
      }),
      packedEvidenceGenerator: async (input) => {
        packedInput = input;
        return packedEvidence({ package: { ...PACKAGE, tarballSha256: `sha256:${fixture.artifactSha256}` } });
      },
      dogfoodEvidenceRetriever: async (input) => {
        dogfoodInput = input;
        return dogfoodEvidence();
      },
    });
    assert.deepEqual(result, { passed: true, diagnostics: [] });
    assert.equal(packedInput.artifactPath, fixture.artifactPath);
    assert.match(packedInput.evidencePath, /packed-evidence\.json$/u);
    assert.equal(dogfoodInput.sourceSha, SOURCE_SHA);
    assert.equal(dogfoodInput.repositoryOwner, "yohn-jp");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("delegates failed, malformed, package-mismatched, and repository-mismatched evidence to canonical composition", async () => {
  const fixture = temporaryArtifact();
  try {
    const baseOptions = {
      environment: workflowEnvironment(fixture.artifactPath, fixture.artifactSha256),
      currentSourceSha: SOURCE_SHA,
      packageMetadata: PACKAGE,
      workflowRunResolver: async () => ({
        workflowRunId: DOGFOOD_RUN_ID,
        workflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
      }),
      dogfoodEvidenceRetriever: async () => dogfoodEvidence(),
    };
    const failed = await runWorkflowCertification({
      ...baseOptions,
      packedEvidenceGenerator: async () =>
        packedEvidence({ result: "failed", sourceCommitSha: null, diagnostics: [{ code: "E", message: "failed" }] }),
    });
    assert.equal(failed.diagnostics[0].code, "RESULT_NOT_PASSED");

    const malformed = await runWorkflowCertification({
      ...baseOptions,
      packedEvidenceGenerator: async () => ({ malformed: true }),
    });
    assert.equal(malformed.diagnostics[0].code, "EVIDENCE_MALFORMED");

    const packageMismatch = await runWorkflowCertification({
      ...baseOptions,
      packedEvidenceGenerator: async () =>
        packedEvidence({
          package: { ...PACKAGE, version: "0.11.0", tarballSha256: `sha256:${"c".repeat(64)}` },
        }),
    });
    assert.equal(packageMismatch.diagnostics[0].code, "PACKAGE_MISMATCH");

    const repositoryMismatch = await runWorkflowCertification({
      ...baseOptions,
      packedEvidenceGenerator: async () =>
        packedEvidence({ package: { ...PACKAGE, tarballSha256: `sha256:${fixture.artifactSha256}` } }),
      dogfoodEvidenceRetriever: async () => dogfoodEvidence({ repository: { owner: "other", name: "repo" } }),
    });
    assert.equal(repositoryMismatch.diagnostics[0].code, "REPOSITORY_MISMATCH");
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("retrieves the explicitly intended unexpired exact-source artifact through a bounded fake GitHub API", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const requests = [];
  const artifact = {
    id: 42,
    name: selfDogfoodArtifactName(SOURCE_SHA, DOGFOOD_RUN_ID, DOGFOOD_RUN_ATTEMPT),
    expired: false,
    created_at: "2025-12-31T00:00:00Z",
    expires_at: "2026-03-01T00:00:00Z",
    workflow_run: { id: Number(DOGFOOD_RUN_ID), run_attempt: Number(DOGFOOD_RUN_ATTEMPT), head_sha: SOURCE_SHA },
  };
  const evidence = dogfoodEvidence();
  const retrieved = await retrieveSelfDogfoodEvidence({
    sourceSha: SOURCE_SHA,
    workflowRunId: DOGFOOD_RUN_ID,
    workflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
    environment: { GITHUB_API_URL: "https://api.example.test", GITHUB_TOKEN: "bounded-token" },
    now,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.includes("/actions/artifacts?")) return jsonResponse({ artifacts: [artifact] });
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("fake-zip").buffer };
    },
    extractArchive: async (archivePath) => {
      assert.equal(fs.statSync(archivePath).isFile(), true);
      return evidence;
    },
  });
  assert.deepEqual(retrieved, evidence);
  assert.equal(requests.length, 2);
  assert.match(
    requests[0].url,
    new RegExp(
      `repos/yohn-jp/gh-inari/actions/artifacts\\?name=self-dogfood-golden-path-${SOURCE_SHA}-${DOGFOOD_RUN_ID}-${DOGFOOD_RUN_ATTEMPT}`,
    ),
  );
  assert.match(requests[1].url, /repos\/yohn-jp\/gh-inari\/actions\/artifacts\/42\/zip$/u);
  assert.equal(requests[0].init.headers.authorization, "Bearer bounded-token");
});

test("does not let a newer same-source attempt replace the explicitly intended attempt", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const intendedRunId = "4101";
  const newerRunId = "4102";
  const artifactNameFor = (runId) => `self-dogfood-golden-path-${SOURCE_SHA}-${runId}-1`;
  const artifacts = [
    {
      id: 41,
      name: artifactNameFor(intendedRunId),
      expired: false,
      created_at: "2025-12-31T00:00:00Z",
      expires_at: "2026-03-01T00:00:00Z",
      workflow_run: { id: Number(intendedRunId), run_attempt: 1, head_sha: SOURCE_SHA },
    },
    {
      id: 42,
      name: artifactNameFor(newerRunId),
      expired: false,
      created_at: "2025-12-31T00:01:00Z",
      expires_at: "2026-03-01T00:00:00Z",
      workflow_run: { id: Number(newerRunId), run_attempt: 1, head_sha: SOURCE_SHA },
    },
  ];
  const evidenceFor = (runId) => ({
    ...dogfoodEvidence(),
    workflow: { runId, runAttempt: "1" },
  });

  const retrieved = await retrieveSelfDogfoodEvidence({
    sourceSha: SOURCE_SHA,
    workflowRunId: intendedRunId,
    workflowRunAttempt: "1",
    environment: { GITHUB_API_URL: "https://api.example.test" },
    now,
    fetchImpl: async (url) => {
      if (url.includes("/actions/artifacts?")) return jsonResponse({ artifacts });
      const marker = url.endsWith("/41/zip") ? intendedRunId : newerRunId;
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(marker).buffer };
    },
    extractArchive: async (archivePath) => evidenceFor(fs.readFileSync(archivePath, "utf8")),
  });

  assert.equal(retrieved.workflow.runId, intendedRunId);
  const retrievedFromReverseListing = await retrieveSelfDogfoodEvidence({
    sourceSha: SOURCE_SHA,
    workflowRunId: intendedRunId,
    workflowRunAttempt: "1",
    environment: { GITHUB_API_URL: "https://api.example.test" },
    now,
    fetchImpl: async (url) => {
      if (url.includes("/actions/artifacts?")) return jsonResponse({ artifacts: [...artifacts].reverse() });
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(intendedRunId).buffer };
    },
    extractArchive: async () => evidenceFor(intendedRunId),
  });
  assert.equal(retrievedFromReverseListing.workflow.runId, intendedRunId);
});

test("fails closed when the selected artifact or evidence names another workflow run", async () => {
  const expectedName = selfDogfoodArtifactName(SOURCE_SHA, DOGFOOD_RUN_ID, DOGFOOD_RUN_ATTEMPT);
  const base = {
    sourceSha: SOURCE_SHA,
    workflowRunId: DOGFOOD_RUN_ID,
    workflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
    environment: { GITHUB_API_URL: "https://api.example.test" },
    now: Date.parse("2026-01-01T00:00:00Z"),
  };
  const fetchFor = (artifact) => async (url) => {
    if (url.includes("/actions/artifacts?")) return jsonResponse({ artifacts: [artifact] });
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("archive").buffer };
  };
  await assert.rejects(
    retrieveSelfDogfoodEvidence({
      ...base,
      fetchImpl: fetchFor({
        id: 41,
        name: expectedName,
        expired: false,
        expires_at: "2026-03-01T00:00:00Z",
        workflow_run: { id: 4102, run_attempt: 1, head_sha: SOURCE_SHA },
      }),
      extractArchive: async () => dogfoodEvidence(),
    }),
    /does not match the explicitly intended certification run/u,
  );
  await assert.rejects(
    retrieveSelfDogfoodEvidence({
      ...base,
      fetchImpl: fetchFor({
        id: 41,
        name: expectedName,
        expired: false,
        expires_at: "2026-03-01T00:00:00Z",
        workflow_run: { id: 4101, run_attempt: 1, head_sha: SOURCE_SHA },
      }),
      extractArchive: async () => dogfoodEvidence({ workflow: { runId: "4102", runAttempt: "1" } }),
    }),
    /does not match the explicitly intended certification run/u,
  );
});

test("rejects missing, expired, and wrong-head self-dogfood artifacts", async () => {
  const base = {
    sourceSha: SOURCE_SHA,
    workflowRunId: DOGFOOD_RUN_ID,
    workflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
    environment: { GITHUB_API_URL: "https://api.example.test" },
    now: Date.parse("2026-01-01T00:00:00Z"),
    extractArchive: async () => dogfoodEvidence(),
  };
  const responseFor = (artifact) => async (url) =>
    url.includes("/actions/artifacts?")
      ? jsonResponse({ artifacts: artifact === undefined ? [] : [artifact] })
      : jsonResponse({});
  await assert.rejects(
    retrieveSelfDogfoodEvidence({ ...base, fetchImpl: responseFor(undefined) }),
    /no artifact named/u,
  );
  await assert.rejects(
    retrieveSelfDogfoodEvidence({
      ...base,
      fetchImpl: responseFor({
        id: 1,
        name: `self-dogfood-golden-path-${SOURCE_SHA}-${DOGFOOD_RUN_ID}-${DOGFOOD_RUN_ATTEMPT}`,
        expired: true,
        workflow_run: { id: Number(DOGFOOD_RUN_ID), run_attempt: Number(DOGFOOD_RUN_ATTEMPT), head_sha: SOURCE_SHA },
      }),
    }),
    /expired/u,
  );
  await assert.rejects(
    retrieveSelfDogfoodEvidence({
      ...base,
      fetchImpl: responseFor({
        id: 2,
        name: `self-dogfood-golden-path-${SOURCE_SHA}-${DOGFOOD_RUN_ID}-${DOGFOOD_RUN_ATTEMPT}`,
        expired: false,
        workflow_run: {
          id: Number(DOGFOOD_RUN_ID),
          run_attempt: Number(DOGFOOD_RUN_ATTEMPT),
          head_sha: OTHER_SOURCE_SHA,
        },
      }),
    }),
    /head SHA does not match/u,
  );
});

test("rejects ambiguous and malformed artifact evidence documents", () => {
  assert.throws(
    () =>
      extractSelfDogfoodEvidence("fixture.zip", {
        runCommand(command) {
          if (command === "unzip")
            return { status: 0, stdout: "one/self-dogfood-golden-path.json\ntwo/self-dogfood-golden-path.json\n" };
          return { status: 0, stdout: "" };
        },
      }),
    /exactly one/u,
  );
  assert.throws(
    () =>
      extractSelfDogfoodEvidence("fixture.zip", {
        runCommand(command, args) {
          if (args[0] === "-Z1") return { status: 0, stdout: "self-dogfood-golden-path.json\n" };
          return { status: 0, stdout: "not-json" };
        },
      }),
    /not JSON/u,
  );
});

test("rejects exact-source dogfood content mismatch and bounds adapter failures", async () => {
  const fixture = temporaryArtifact();
  try {
    const result = await runWorkflowCertification({
      environment: workflowEnvironment(fixture.artifactPath, fixture.artifactSha256),
      currentSourceSha: SOURCE_SHA,
      packageMetadata: PACKAGE,
      workflowRunResolver: async () => ({
        workflowRunId: DOGFOOD_RUN_ID,
        workflowRunAttempt: DOGFOOD_RUN_ATTEMPT,
      }),
      packedEvidenceGenerator: async () =>
        packedEvidence({ package: { ...PACKAGE, tarballSha256: `sha256:${fixture.artifactSha256}` } }),
      dogfoodEvidenceRetriever: async () => dogfoodEvidence({ sourceCommitSha: OTHER_SOURCE_SHA }),
    });
    assert.equal(result.passed, false);
    assert.equal(result.diagnostics[0].code, "SOURCE_SHA_MISMATCH");
    assert.ok(result.diagnostics[0].message.length <= 512);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
