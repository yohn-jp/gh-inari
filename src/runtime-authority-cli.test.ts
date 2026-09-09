import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { loadRuntimeAuthorityKeyPair } from "./agent-authority/runtime-key.js";

interface CapturedOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function captureCli(argv: string[], repositoryRoot: string): Promise<CapturedOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    return {
      exitCode: await runCli(argv, { repositoryRoot }),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("authority generate writes a local key, exports public material, and does not register trust", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "inari-authority-cli-"));
  try {
    const first = await captureCli(["authority", "generate", "--private-key", "runtime.pem", "--json"], repositoryRoot);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    const firstOutput = JSON.parse(first.stdout) as {
      readonly ok: boolean;
      readonly privateKeyPath: string;
      readonly publicKey: { readonly x: string; readonly d?: string };
      readonly publicKeyJson: string;
      readonly repositoryTrustChanged: boolean;
    };
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.privateKeyPath, path.join(repositoryRoot, "runtime.pem"));
    assert.equal(firstOutput.repositoryTrustChanged, false);
    assert.equal("d" in firstOutput.publicKey, false);
    assert.equal(JSON.parse(firstOutput.publicKeyJson).x, firstOutput.publicKey.x);

    const keyPath = path.join(repositoryRoot, "runtime.pem");
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    assert.equal(loadRuntimeAuthorityKeyPair(keyPath).publicKeyJwk.x, firstOutput.publicKey.x);
    assert.equal((await readFile(keyPath, "utf8")).includes(firstOutput.publicKey.x), false);

    const duplicate = await captureCli(
      ["authority", "generate", "--private-key", "runtime.pem", "--json"],
      repositoryRoot,
    );
    assert.equal(duplicate.exitCode, 2);
    assert.match(duplicate.stdout, /RUNTIME_AUTHORITY_KEY_EXISTS/u);
    assert.equal(duplicate.stdout.includes("BEGIN PRIVATE KEY"), false);

    const replacement = await captureCli(
      ["authority", "generate", "--private-key", "runtime.pem", "--replace", "--json"],
      repositoryRoot,
    );
    assert.equal(replacement.exitCode, 0);
    const replacementOutput = JSON.parse(replacement.stdout) as {
      readonly publicKey: { readonly x: string };
      readonly repositoryTrustChanged: boolean;
    };
    assert.notEqual(replacementOutput.publicKey.x, firstOutput.publicKey.x);
    assert.equal(replacementOutput.repositoryTrustChanged, false);
    await assert.rejects(lstat(path.join(repositoryRoot, ".github", "inari", "authorities")));
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("authority generate has an explicit human-readable trust boundary", async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "inari-authority-cli-help-"));
  try {
    const result = await captureCli(["authority", "generate", "--private-key", "runtime.pem"], repositoryRoot);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Generated local Runtime Authority keypair\./u);
    assert.match(result.stdout, /Public key:/u);
    assert.match(result.stdout, /Repository trust was not modified\./u);
    assert.equal(result.stdout.includes("BEGIN PRIVATE KEY"), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
