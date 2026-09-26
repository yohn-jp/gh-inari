import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installPackedCli } from "./fixtures/setup/packed-cli.mjs";

function command(entry, args, options) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    ...options,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function json(result, label) {
  assert.equal(result.status, 0, `${label} returned ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test(
  "packed installed CLI certifies clean setup and denied actions without preseeded trust",
  { timeout: 120_000 },
  async () => {
    const packed = await installPackedCli();
    const root = await mkdtemp(path.join(os.tmpdir(), "inari-setup-application-cert-"));
    const configHome = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    const environment = { ...process.env, INARI_CONFIG_HOME: configHome, NO_COLOR: "1" };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "INARI_GITHUB_APP_USER_CREDENTIAL_FILE",
      "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY",
    ])
      delete environment[name];
    try {
      const repository = "example-alternative/renamed-project";
      const repositoryId = "99887766";
      const status = json(
        command(
          packed.entry,
          ["setup", "status", "--json", "--repository", repository, "--repository-id", repositoryId],
          {
            cwd: root,
            env: environment,
          },
        ),
        "clean setup status",
      );
      assert.equal(status.operation, "setup.status");
      assert.equal(status.state.stage, "clean");
      assert.deepEqual(status.state.repository, {
        repositoryHost: "github.com",
        repositoryId,
        nameWithOwner: repository,
      });
      assert.equal(status.state.nextAction.kind, "perform");
      assert.equal(
        status.state.actions.find((action) => action.id === status.state.nextAction.actionId)?.kind,
        "executor.configure",
      );

      const incomplete = command(
        packed.entry,
        [
          "setup",
          "next",
          "--json",
          "--yes",
          "--input",
          "app-id=123456",
          "--repository",
          repository,
          "--repository-id",
          repositoryId,
        ],
        { cwd: root, env: environment },
      );
      assert.equal(incomplete.status, 2);
      assert.equal(JSON.parse(incomplete.stdout).kind, "input-required");
      assert.equal(JSON.stringify(status).includes("PRIVATE KEY"), false);
      for (const directory of ["authority", "admission", "executor", "runtime-profiles"])
        assert.equal(existsSync(path.join(configHome, directory)), false, `denied incomplete setup wrote ${directory}`);

      const after = json(
        command(
          packed.entry,
          ["setup", "status", "--json", "--repository", repository, "--repository-id", repositoryId],
          {
            cwd: root,
            env: environment,
          },
        ),
        "setup status after denial",
      );
      assert.deepEqual(after.state.generation, status.state.generation);
      assert.equal(after.state.stage, "clean");
      console.log(
        `packed package ${packed.identity.name}@${packed.identity.version} (${packed.identity.integrity ?? packed.identity.shasum}): clean setup, alternative repository name, and incomplete-action denial PASS; provider boundary deterministic fixture not used; live GitHub/Cloudflare NOT CHECKED`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await packed.cleanup();
    }
  },
);
