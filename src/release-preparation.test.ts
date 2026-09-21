import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "./cli.js";
import {
  prepareRelease,
  RELEASE_PUBLICATION_ISSUE,
  type ReleasePreparationVerificationResult,
} from "./release-preparation.js";
import type { ReleaseHistoryEvidence } from "./release-preparation-plan.js";

const previousRevision = "a".repeat(40);

async function fixture(): Promise<{ readonly root: string; readonly history: ReleaseHistoryEvidence }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-release-preparation-"));
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await mkdir(path.join(root, "docs", "releases"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{\n  "name": "gh-inari",\n  "version": "0.14.1"\n}\n');
  await writeFile(path.join(root, ".codex-plugin", "plugin.json"), '{\n  "name": "inari",\n  "version": "0.14.1"\n}\n');
  await writeFile(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    '{\n  "name": "gh-inari",\n  "plugins": [{\n    "name": "inari",\n    "source": {\n      "source": "npm",\n      "package": "gh-inari",\n      "version": "^0.14.1"\n    }\n  }]\n}\n',
  );
  await writeFile(
    path.join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\npackages: {}\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Release Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return {
    root,
    history: {
      previousRelease: { tag: "v0.14.1", version: "0.14.1", sourceRevision: previousRevision },
      targetSource: { ref: "main", sourceRevision },
      includedChanges: [
        {
          number: 928,
          title: "Project release preparation",
          mergeCommitSha: "b".repeat(40),
          mergedAt: "2026-09-22T00:00:00Z",
          governed: true,
          sourceIssueNumbers: [912],
        },
      ],
    },
  };
}

const alwaysVerify = async (
  command: string,
  args: readonly string[],
): Promise<ReleasePreparationVerificationResult> => ({
  command,
  args,
  status: 0,
});

test("prepares all version artifacts, release metadata, and converges on retry", async () => {
  const { root, history } = await fixture();
  const calls: { command?: string; args?: readonly string[]; cwd?: string }[] = [];
  const verifySuccess = async (
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<ReleasePreparationVerificationResult> => {
    calls.push({ command, args, cwd });
    return { command, args, status: 0 };
  };
  try {
    const first = await prepareRelease({
      repositoryRoot: root,
      history,
      intent: "patch",
      runVerification: verifySuccess,
    });
    assert.equal(first.targetVersion, "0.14.2");
    assert.equal(first.publication.sourceIssue, RELEASE_PUBLICATION_ISSUE);
    assert.equal(first.idempotent, false);
    assert.deepEqual(first.changedPaths, [
      ".agents/plugins/marketplace.json",
      ".codex-plugin/plugin.json",
      "docs/releases/0.14.2.md",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    assert.match(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"), /    version: 0\.14\.2\n/u);
    assert.match(await readFile(path.join(root, "docs/releases/0.14.2.md"), "utf8"), /inari:release-preparation/u);
    const second = await prepareRelease({
      repositoryRoot: root,
      history,
      intent: "patch",
      runVerification: verifySuccess,
    });
    assert.equal(second.idempotent, true);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on dirty workspace and exact-source mismatch", async () => {
  const { root, history } = await fixture();
  try {
    await writeFile(path.join(root, "unrelated.txt"), "unrelated\n");
    await assert.rejects(
      prepareRelease({ repositoryRoot: root, history, intent: "minor", runVerification: alwaysVerify }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_WORKSPACE_DIRTY",
    );
    execFileSync("git", ["add", "unrelated.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "unrelated"], { cwd: root });
    await assert.rejects(
      prepareRelease({ repositoryRoot: root, history, intent: "minor", runVerification: alwaysVerify }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_SOURCE_CONFLICT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release prepare CLI exposes machine-readable handoff without publication", async () => {
  const { root, history } = await fixture();
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["release", "prepare", "--intent", "exact", "--target-version", "0.20.0", "--json"], {
      repositoryRoot: root,
      releaseHistoryPort: {
        async readReleaseHistory() {
          return history;
        },
      },
      runReleaseVerification: async (command, args) => ({ command, args, status: 0 }),
    });
    assert.equal(exitCode, 0, lines[0]);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? "{}").targetVersion, "0.20.0");
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
