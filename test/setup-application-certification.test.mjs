import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.equal(result.status, 0, `${label} returned ${result.status}: ${result.stdout} ${result.stderr}`);
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

test(
  "packed legacy upgrade and trust recheck reproduce the shared setup publication blocker",
  { timeout: 120_000 },
  async () => {
    const packed = await installPackedCli();
    const checkout = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const root = await mkdtemp(path.join(path.dirname(checkout), "inari-setup-publication-cert-"));
    const workspace = path.join(root, "workspace");
    const configHome = path.join(root, "config");
    const providerState = path.join(root, "provider-state.json");
    const providerLog = path.join(root, "provider-log.jsonl");
    const preload = fileURLToPath(new URL("./fixtures/setup/provider-preload.mjs", import.meta.url));
    const repository = "cert-owner/renamed-project";
    const environment = {
      ...process.env,
      INARI_CONFIG_HOME: configHome,
      INARI_SETUP_PROVIDER_STATE: providerState,
      INARI_SETUP_PROVIDER_LOG: providerLog,
      NODE_OPTIONS: `--import=${preload}`,
      NO_COLOR: "1",
    };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "INARI_GITHUB_APP_USER_CREDENTIAL_FILE",
      "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY",
    ])
      delete environment[name];
    const run = (...args) => command(packed.entry, args, { cwd: workspace, env: environment });
    try {
      await mkdir(workspace);
      await mkdir(configHome);
      await writeFile(providerState, JSON.stringify({ merged: false }));
      await writeFile(providerLog, "");
      await writeFile(
        path.join(configHome, "app-user-credential.json"),
        JSON.stringify({
          version: 1,
          access_token: "setup-cert-user-token",
          refresh_token: "setup-cert-refresh-token",
          access_token_expires_at: "2099-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const templateRoot = checkout;
      const templateDirectory = path.join(workspace, ".github", "inari", "pull-requests");
      await mkdir(templateDirectory, { recursive: true });
      await writeFile(
        path.join(templateDirectory, "authority.json"),
        await readFile(path.join(templateRoot, ".github", "inari", "pull-requests", "authority.json")),
      );
      const privateKey = path.join(configHome, "runtime-keys", "legacy.pem");
      json(run("authority", "generate", "--json", "--private-key", privateKey), "Authority key generation");
      const authorityId = "runtime-certification";
      const bootstrap = json(
        run(
          "authority",
          "bootstrap",
          "--json",
          "--authority-id",
          authorityId,
          "--private-key",
          privateKey,
          "--output",
          "authority.json",
          "--max-session-ttl-seconds",
          "1800",
          "--capability",
          "change.implement",
        ),
        "Authority bootstrap",
      );
      assert.deepEqual(bootstrap.authority.capabilityCeiling, ["change.implement"]);
      json(run("authority", "register", "--json", "--from", "authority.json"), "Authority registration");
      const args = [
        "setup",
        "--json",
        "--repository",
        repository,
        "--endpoint",
        "https://endpoint.example.test",
        "--authority-id",
        authorityId,
        "--private-key",
        privateKey,
      ];
      const result = json(run(...args), "packed repository setup");
      assert.equal(result.state, "trust-pending");
      assert.equal(result.repository.repositoryId, "44332211");
      assert.equal(result.publication?.pullRequest.number, 31);
      assert.equal(result.trust.status, "pending-human-trust");
      const pending = JSON.parse(await readFile(providerState, "utf8"));
      assert.equal(pending.merged, false);
      assert.equal(pending.pr, true);
      assert.equal(JSON.parse(pending.artifact.content).id, authorityId);
      const routes = (await readFile(providerLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).route);
      assert.ok(routes.includes("user/installations"));
      assert.ok(routes.includes("user/installations/77/repositories"));
      const setupArguments = ["--json", "--repository", repository, "--repository-id", "44332211"];
      const application = json(run("setup", "status", ...setupArguments), "shared setup state after legacy profile");
      assert.equal(application.state.repository.repositoryId, "44332211");
      assert.ok(application.state.actions.some((action) => action.kind === "executor.configure"));
      const issuerKeyFile = path.join(configHome, "issuer-key.pem");
      const issuer = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await writeFile(issuerKeyFile, issuer.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const issuerPublicKeyFile = path.join(root, "issuer-public.pem");
      await writeFile(issuerPublicKeyFile, issuer.publicKey.export({ type: "spki", format: "pem" }));
      environment.INARI_SETUP_ISSUER_PUBLIC_KEY = issuerPublicKeyFile;
      const configured = json(
        run(
          "setup",
          "next",
          ...setupArguments,
          "--yes",
          "--input",
          "app-id=4242",
          "--enrollment-file",
          `issuer-key=${issuerKeyFile}`,
        ),
        "packed shared setup Executor enrollment",
      );
      assert.equal(configured.result.outcome, "succeeded");
      const afterEnrollment = json(run("setup", "status", ...setupArguments), "shared setup state after enrollment");
      assert.equal(
        afterEnrollment.state.actions.find((action) => action.id === afterEnrollment.state.nextAction.actionId)?.kind,
        "composition.complete-configuration",
      );
      const profileDirectory = path.dirname(result.profilePath);
      await chmod(profileDirectory, 0o500);
      let interrupted;
      try {
        interrupted = run("setup", "next", ...setupArguments, "--yes");
      } finally {
        await chmod(profileDirectory, 0o700);
      }
      assert.notEqual(interrupted.status, 0);
      const partial = JSON.parse(interrupted.stdout);
      assert.equal(partial.result?.outcome, "unknown", interrupted.stdout);
      assert.ok(partial.result.diagnostics.some((item) => item.code === "SETUP_MIGRATION_RECOVERY_REQUIRED"));
      assert.equal(JSON.parse(await readFile(result.profilePath, "utf8")).authority.privateKeyPath, privateKey);
      const recoveryRoot = path.join(configHome, "authority", "migrations");
      assert.equal(existsSync(recoveryRoot), true);
      const [recoveryGeneration] = await readdir(recoveryRoot);
      assert.ok(recoveryGeneration);
      const recoveryPath = path.join(recoveryRoot, recoveryGeneration);
      assert.ok((await readdir(recoveryPath)).includes("manifest.json"));
      for (const name of await readdir(recoveryPath))
        assert.doesNotMatch(await readFile(path.join(recoveryPath, name), "utf8"), /BEGIN (?:RSA )?PRIVATE KEY/u);
      const migrated = json(run("setup", "next", ...setupArguments, "--yes"), "packed legacy migration");
      assert.equal(migrated.result.outcome, "succeeded", JSON.stringify(migrated.result.diagnostics));
      const convergedProfile = JSON.parse(await readFile(result.profilePath, "utf8"));
      assert.equal(convergedProfile.authority.authorityId, authorityId);
      assert.equal(convergedProfile.authority.publicKeyFingerprint, result.authority.publicKeyFingerprint);
      assert.equal(convergedProfile.authority.privateKeyPath, path.join(configHome, "authority", "private-key.pem"));
      const admissionPin = JSON.parse(
        await readFile(path.join(configHome, "admission", "runtime-authority.json"), "utf8"),
      );
      assert.deepEqual(admissionPin, JSON.parse(pending.artifact.content));
      assert.deepEqual(admissionPin.capabilityCeiling, ["change.implement"]);
      const bindingState = json(run("setup", "status", ...setupArguments), "shared setup binding state");
      assert.equal(
        bindingState.state.actions.find((action) => action.id === bindingState.state.nextAction.actionId)?.kind,
        "executor.bind-repository",
      );
      const bindingRun = run("setup", "next", ...setupArguments, "--yes");
      assert.equal(
        bindingRun.status,
        0,
        `binding failed: ${bindingRun.stdout}; provider tail: ${(await readFile(providerLog, "utf8")).trim().split("\n").slice(-10).join("; ")}`,
      );
      const bound = JSON.parse(bindingRun.stdout);
      assert.equal(bound.result.outcome, "succeeded", JSON.stringify(bound.result.diagnostics));
      const publicationState = json(run("setup", "status", ...setupArguments), "shared setup publication state");
      assert.equal(publicationState.state.stage, "unknown");
      assert.equal(
        publicationState.state.dimensions.find((item) => item.dimension === "repository-trust")?.diagnostics[0]?.code,
        "SETUP_TRUST_UNAVAILABLE",
      );
      assert.equal(
        publicationState.state.actions.some((action) => action.kind === "authority.publish-trust"),
        false,
      );
      const retryArgs = args.slice(0, -2);
      const repeated = json(run(...retryArgs), "setup while trust PR awaits human merge");
      assert.equal(repeated.state, "trust-pending");
      assert.equal(repeated.publication?.status, "existing");
      const stillPending = JSON.parse(await readFile(providerState, "utf8"));
      assert.equal(stillPending.merged, false);
      await writeFile(providerState, JSON.stringify({ ...stillPending, merged: true }));
      const ready = json(run(...retryArgs), "setup trust recheck after provider-side human merge");
      assert.equal(ready.state, "ready");
      assert.equal(ready.authority.authorityId, authorityId);
      assert.equal(ready.readiness.ok, true);
      const mergedState = JSON.parse(await readFile(providerState, "utf8"));
      assert.equal(mergedState.merged, true);
      const trustedState = json(run("setup", "status", ...setupArguments), "shared setup state after human merge");
      assert.equal(
        trustedState.state.dimensions.find((item) => item.dimension === "repository-trust")?.status,
        "trusted",
      );
      console.log(
        "packed CLI App-user scope, deterministic trust PR, partial migration recovery, and provider-side merge trust recheck: PASS; shared setup first publication: PRODUCTION_BLOCKER",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await packed.cleanup();
    }
  },
);
