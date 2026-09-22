import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli-core.js";
import { getCommandForPositionals } from "./command-contract.js";

interface CapturedOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-cli-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

async function capture(argv: string[], environment: NodeJS.ProcessEnv): Promise<CapturedOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    return { exitCode: await runCli(argv, { environment }), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("inari init declares only the local CLI topology and is idempotent", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const first = await capture(["init", "--json"], environment);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    const firstOutput = JSON.parse(first.stdout) as {
      readonly ok: boolean;
      readonly operation: string;
      readonly configPath: string;
      readonly config: Record<string, unknown>;
    };
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.operation, "init");
    assert.equal(firstOutput.configPath, path.join(environment.INARI_CONFIG_HOME as string, "cli", "config.json"));
    assert.deepEqual(firstOutput.config, {
      version: 1,
      topology: { admission: "local", executor: "local" },
    });
    assert.equal("endpoint" in firstOutput.config, false);
    assert.equal("admission" in firstOutput.config, false);
    assert.equal(first.stdout.includes("private-key.pem"), false);
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "admission")));
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));

    const second = await capture(["init", "--json"], environment);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(JSON.parse(second.stdout), firstOutput);
    assert.deepEqual(JSON.parse(await readFile(firstOutput.configPath, "utf8")), firstOutput.config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority setup provisions only Authority custody without emitting private material", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const first = await capture(["authority", "setup", "--json"], environment);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(first.stdout.includes("BEGIN PRIVATE KEY"), false);
    const output = JSON.parse(first.stdout) as {
      readonly ok: boolean;
      readonly operation: string;
      readonly configPath: string;
      readonly privateKeyPath: string;
      readonly publicKey: { readonly x: string; readonly d?: string };
      readonly publicKeyFingerprint: string;
    };
    assert.equal(output.ok, true);
    assert.equal(output.operation, "authority.setup");
    assert.equal(output.configPath, path.join(environment.INARI_CONFIG_HOME as string, "authority", "config.json"));
    assert.equal(
      output.privateKeyPath,
      path.join(environment.INARI_CONFIG_HOME as string, "authority", "private-key.pem"),
    );
    assert.equal("d" in output.publicKey, false);
    assert.match(output.publicKeyFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal((await lstat(output.privateKeyPath)).mode & 0o777, 0o600);
    assert.equal((await readFile(output.configPath, "utf8")).includes("BEGIN PRIVATE KEY"), false);
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "cli")));
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "admission")));
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));

    const second = await capture(["authority", "setup", "--json"], environment);
    assert.equal(second.exitCode, 0);
    assert.equal(JSON.parse(second.stdout).publicKeyFingerprint, output.publicKeyFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local provisioning commands are additive, closed, and use INARI_CONFIG_HOME only", async () => {
  assert.equal(getCommandForPositionals(["init"])?.id, "root.init");
  assert.equal(getCommandForPositionals(["authority", "setup"])?.id, "authority.setup");
  assert.equal(getCommandForPositionals(["setup"])?.id, "root.setup");
  assert.equal(getCommandForPositionals(["authority", "generate"])?.id, "authority.generate");

  const { root, environment } = await temporaryEnvironment();
  try {
    const invalid = await capture(["init", "--config-home", path.join(root, "other"), "--json"], environment);
    assert.equal(invalid.exitCode, 1);
    assert.equal(JSON.parse(invalid.stdout).error.code, "INVALID_OPTION");
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "cli")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
