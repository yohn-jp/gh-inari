import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "./cli.js";
import { prepareRelease, type ReleasePreparationVerificationResult } from "./release-preparation.js";
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
    assert.deepEqual(first.publicationHandoff, {
      version: 1,
      kind: "release-pr-publication",
      role: "release",
      targetVersion: "0.14.2",
      head: "release/0.14.2",
      base: "main",
      expectedHead: "release/0.14.2",
      expectedBase: "main",
      headRevision: history.targetSource.sourceRevision,
      template: "release",
    });
    assert.equal(first.idempotent, false);
    assert.deepEqual(first.changedPaths, [
      ".agents/plugins/marketplace.json",
      ".codex-plugin/plugin.json",
      "docs/releases/0.14.2.md",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    assert.match(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"), /    version: 0\.14\.2\n/u);
    const document = await readFile(path.join(root, "docs/releases/0.14.2.md"), "utf8");
    assert.match(document, /inari:release-preparation/u);
    for (const heading of [
      "Summary",
      "Highlights",
      "Fixed",
      "Behavioral changes",
      "Upgrade instructions",
      "Breaking changes",
      "Known limitations",
    ])
      assert.match(document, new RegExp(`^## ${heading}$`, "mu"));
    assert.match(document, /#928: Project release preparation/u);
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

test("fails closed when the target release document already contains conflicting content", async () => {
  const { root, history } = await fixture();
  try {
    await writeFile(path.join(root, "docs/releases/0.14.2.md"), "# unrelated release notes\n");
    await assert.rejects(
      prepareRelease({ repositoryRoot: root, history, intent: "patch", runVerification: alwaysVerify }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "RELEASE_TARGET_CONFLICT",
    );
    assert.equal(
      await readFile(path.join(root, "package.json"), "utf8"),
      '{\n  "name": "gh-inari",\n  "version": "0.14.1"\n}\n',
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
    const output = JSON.parse(lines[0] ?? "{}") as {
      targetVersion?: string;
      identity?: { targetSource?: { sourceRevision?: string } };
      publicationHandoff?: { sourceIssue?: number; head?: string; template?: string };
    };
    assert.equal(output.targetVersion, "0.20.0");
    assert.equal(output.identity?.targetSource?.sourceRevision, history.targetSource.sourceRevision);
    assert.equal(output.publicationHandoff?.sourceIssue, undefined);
    assert.equal(output.publicationHandoff?.head, "release/0.20.0");
    assert.equal(output.publicationHandoff?.template, "release");
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
