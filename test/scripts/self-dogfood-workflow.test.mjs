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
} from "../../scripts/certification-evidence.mjs";
import { resolveInstalledPackageExecutablePath, verifySelfDogfoodRun } from "../../scripts/self-dogfood-workflow.mjs";

const sourceCommitSha = "a".repeat(40);
const workflowEnvironment = (overrides = {}) => ({
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "1",
  ...overrides,
});

test("the installed package declares a real package-owned inari executable", () => {
  const packageMetadata = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(typeof packageMetadata.bin, "object");
  assert.equal(packageMetadata.bin.inari, "dist/index.js");
  assert.equal(
    resolveInstalledPackageExecutablePath("/consumer/node_modules/gh-inari", packageMetadata),
    "/consumer/node_modules/gh-inari/dist/index.js",
  );
});

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
    workflow: { runId: "12345", runAttempt: "1" },
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
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "gh-inari",
      version: "0.11.0",
      bin: { "gh-inari": "dist/index.js", inari: "dist/index.js" },
    }),
  );
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
    assert.equal(result.metadata.artifact.name, `self-dogfood-golden-path-${sourceCommitSha}-12345-1`);
    assert.equal(result.metadata.residualChange.status, "none");
    assert.match(result.summary, /Residual disposable Change: none/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow verifier rejects an arbitrary executable or .bin shim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-workflow-executable-"));
  const sourceRoot = path.join(root, "source");
  const packageRoot = path.join(root, "consumer", "node_modules", "gh-inari");
  const target = path.join(packageRoot, "dist", "index.js");
  const shim = path.join(root, "consumer", "node_modules", ".bin", "inari");
  const tarball = path.join(root, "gh-inari.tgz");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "gh-inari",
      version: "0.11.0",
      bin: { "gh-inari": "dist/index.js", inari: "dist/index.js" },
    }),
  );
  fs.writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.symlinkSync("../gh-inari/dist/index.js", shim);
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
          installedExecutablePath: shim,
          workerObservation: workerObservation(),
          sourceRoot,
          exerciseAbort: true,
          environment: workflowEnvironment(),
        }),
      /exactly match package\.json bin\.inari/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow verifier accepts a pnpm-style symlinked installed package resolving into .pnpm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-workflow-pnpm-"));
  const sourceRoot = path.join(root, "source");
  const physicalPackageRoot = path.join(
    root,
    "consumer",
    "node_modules",
    ".pnpm",
    "gh-inari@0.11.0",
    "node_modules",
    "gh-inari",
  );
  const symlinkedPackageRoot = path.join(root, "consumer", "node_modules", "gh-inari");
  const tarball = path.join(root, "gh-inari.tgz");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(physicalPackageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(physicalPackageRoot, "package.json"),
    JSON.stringify({
      name: "gh-inari",
      version: "0.11.0",
      bin: { "gh-inari": "dist/index.js", inari: "dist/index.js" },
    }),
  );
  fs.writeFileSync(path.join(physicalPackageRoot, "dist", "index.js"), "installed", { mode: 0o755 });
  fs.symlinkSync(physicalPackageRoot, symlinkedPackageRoot, "dir");
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
      // Both the installed package path and the installed executable path are the
      // caller's logical, symlinked node_modules/gh-inari paths -- not the physical
      // .pnpm/... location -- matching how the workflow observes the pnpm layout.
      installedPackagePath: symlinkedPackageRoot,
      installedExecutablePath: path.join(symlinkedPackageRoot, "dist", "index.js"),
      workerObservation: workerObservation(),
      sourceRoot,
      exerciseAbort: true,
      environment: workflowEnvironment(),
    });
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow verifier rejects a supplied executable resolving to a different physical file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-workflow-mismatch-"));
  const sourceRoot = path.join(root, "source");
  const packageRoot = path.join(root, "consumer", "node_modules", "gh-inari");
  const otherFile = path.join(root, "not-installed.js");
  const tarball = path.join(root, "gh-inari.tgz");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "gh-inari",
      version: "0.11.0",
      bin: { "gh-inari": "dist/index.js", inari: "dist/index.js" },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "installed", { mode: 0o755 });
  fs.writeFileSync(otherFile, "not the installed executable", { mode: 0o755 });
  fs.writeFileSync(tarball, crypto.randomBytes(64));
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
          installedExecutablePath: otherFile,
          workerObservation: workerObservation(),
          sourceRoot,
          exerciseAbort: true,
          environment: workflowEnvironment(),
        }),
      /exactly match package\.json bin\.inari/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow verifier rejects installed products resolved inside the source checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inari-self-dogfood-workflow-boundary-"));
  const tarball = path.join(root, "gh-inari.tgz");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "gh-inari",
      version: "0.11.0",
      bin: { "gh-inari": "dist/index.js", inari: "dist/index.js" },
    }),
  );
  fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "installed", { mode: 0o755 });
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
          installedExecutablePath: path.join(packageRoot, "dist", "index.js"),
          workerObservation: workerObservation(),
          sourceRoot: root,
          exerciseAbort: true,
          environment: workflowEnvironment(),
        }),
      /outside the source checkout/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
