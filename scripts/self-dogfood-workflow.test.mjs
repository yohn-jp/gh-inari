import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
  SELF_DOGFOOD_OPERATION_REQUIREMENTS,
  SELF_DOGFOOD_RECOVERY_OPERATION,
  appendSelfDogfoodOperation,
} from "./certification-evidence.mjs";
import { verifySelfDogfoodRun } from "./self-dogfood-workflow.mjs";

const sourceCommitSha = "a".repeat(40);

function evidence() {
  const operations = SELF_DOGFOOD_OPERATION_REQUIREMENTS.reduce(
    (current, requirement) => appendSelfDogfoodOperation(current, requirement.operation, requirement.outcomes[0]),
    [],
  );
  return {
    schemaVersion: CERTIFICATION_EVIDENCE_SCHEMA_VERSION,
    certificationKind: "self-dogfood-golden-path",
    result: "passed",
    sourceCommitSha,
    contractVersions: { goldenPath: "1", statusRecovery: "1", skill: "1.3.0" },
    repository: { owner: "yohn-jp", name: "gh-inari" },
    rootIssue: 239,
    change: { issue: 239, branch: "feat/239-self-dogfood", pullRequest: 9239 },
    operations: appendSelfDogfoodOperation(
      operations,
      SELF_DOGFOOD_RECOVERY_OPERATION.operation,
      SELF_DOGFOOD_RECOVERY_OPERATION.outcomes[0],
    ),
    finalState: { status: "ABORTED", recovery: { state: "COMPLETED", action: "none" } },
    diagnostics: [],
  };
}

function workerObservation() {
  return {
    sourceCommitSha,
    sensitiveEnvironmentKeys: [],
    handoff: {
      version: 1,
      kind: "implementation-handoff",
      repositoryHost: "github.com",
      repositoryId: "123239",
      rootIssue: 239,
      changeVersion: 1,
      state: "DRAFT",
      branch: "feat/239-self-dogfood",
      baseBranch: "main",
      pullRequest: 9239,
    },
  };
}

test("workflow verifier binds passed evidence to the exact installed tarball and reports completed cleanup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-workflow-test-"));
  const sourceRoot = path.join(root, "source");
  const packageRoot = path.join(root, "consumer", "node_modules", "gh-inari");
  const binRoot = path.join(packageRoot, "dist");
  const tarball = path.join(root, "gh-inari.tgz");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "gh-inari", version: "0.11.0" }));
  fs.writeFileSync(path.join(binRoot, "index.js"), "installed");
  fs.writeFileSync(tarball, crypto.randomBytes(64));
  try {
    const tarballSha256 = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex")}`;
    const result = verifySelfDogfoodRun({
      evidence: evidence(),
      sourceCommitSha,
      repository: "yohn-jp/gh-inari",
      issue: 239,
      tarballPath: tarball,
      tarballSha256,
      installedPackagePath: packageRoot,
      installedExecutablePath: path.join(binRoot, "index.js"),
      workerObservation: workerObservation(),
      sourceRoot,
      exerciseAbort: true,
      environment: {
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Self-dogfood certification",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "yohn-jp/gh-inari",
      },
    });
    assert.equal(result.passed, true);
    assert.equal(result.metadata.artifact.name, `self-dogfood-golden-path-${sourceCommitSha}`);
    assert.equal(result.metadata.residualChange.status, "none");
    assert.match(result.summary, /Residual disposable Change: none/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow verifier rejects installed products resolved inside the source checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-workflow-boundary-"));
  const tarball = path.join(root, "gh-inari.tgz");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "gh-inari", version: "0.11.0" }));
  fs.writeFileSync(tarball, "artifact");
  try {
    const tarballSha256 = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex")}`;
    assert.throws(
      () =>
        verifySelfDogfoodRun({
          evidence: evidence(),
          sourceCommitSha,
          repository: "yohn-jp/gh-inari",
          issue: 239,
          tarballPath: tarball,
          tarballSha256,
          installedPackagePath: packageRoot,
          installedExecutablePath: path.join(packageRoot, "package.json"),
          workerObservation: workerObservation(),
          sourceRoot: root,
          exerciseAbort: true,
          environment: {},
        }),
      /outside the source checkout/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
