import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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

      // #1185: one config home, repository A console live, repository B setup
      // console must report a bounded conflict without stopping, re-binding or
      // replacing A's host.
      const consoleA = spawn(
        process.execPath,
        [packed.entry, "setup", "console", "--json", "--repository", repository, "--repository-id", repositoryId],
        { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        let consoleOutput = "";
        const startedA = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`setup console A timed out: ${consoleOutput}`)), 20_000);
          consoleA.stdout.setEncoding("utf8").on("data", (chunk) => {
            consoleOutput += chunk;
            const line = consoleOutput.split("\n").find((candidate) => candidate.startsWith("{"));
            if (line === undefined) return;
            clearTimeout(timer);
            resolve(JSON.parse(line));
          });
          consoleA.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`setup console A exited ${code}: ${consoleOutput}`));
          });
        });
        assert.equal(startedA.reused, false);
        const announcementFile = path.join(configHome, "runtime", "endpoints", "setup.json");
        const announcementA = await readFile(announcementFile, "utf8");
        const reusedA = json(
          command(
            packed.entry,
            ["setup", "console", "--json", "--repository", repository, "--repository-id", repositoryId],
            { cwd: root, env: environment },
          ),
          "same-repository setup console reuse",
        );
        assert.equal(reusedA.reused, true);
        assert.equal(reusedA.endpoint, startedA.endpoint);
        const conflictB = command(
          packed.entry,
          ["setup", "console", "--json", "--repository", "example-other/second-project", "--repository-id", "55443322"],
          { cwd: root, env: environment },
        );
        assert.equal(conflictB.status, 2, conflictB.stdout);
        assert.equal(JSON.parse(conflictB.stdout).error.code, "SETUP_HOST_REPOSITORY_CONFLICT");
        assert.equal(await readFile(announcementFile, "utf8"), announcementA);
        const identity = await (await fetch(`${startedA.endpoint}/api/setup/host`)).json();
        assert.deepEqual(identity.repository, {
          repositoryHost: "github.com",
          repositoryId,
          nameWithOwner: repository,
        });
        const stillA = json(
          command(
            packed.entry,
            ["setup", "status", "--json", "--repository", repository, "--repository-id", repositoryId],
            { cwd: root, env: environment },
          ),
          "setup status for A after B conflict",
        );
        assert.deepEqual(stillA.state.generation, status.state.generation);
      } finally {
        consoleA.kill("SIGTERM");
        if (consoleA.exitCode === null) await once(consoleA, "exit");
      }
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
  "packed shared setup publishes first trust PR after legacy recovery and rechecks provider merge",
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
      await writeFile(providerState, JSON.stringify({ merged: false, trustUnavailable: true }));
      await writeFile(providerLog, "");
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
      const authorization = run(...args.filter((arg) => arg !== "--json"));
      assert.equal(authorization.status, 0, `${authorization.stdout} ${authorization.stderr}`);
      assert.match(authorization.stdout, /CERT-1122/u);
      assert.equal(existsSync(path.join(configHome, "app-user-credential.json")), true);
      const result = json(run(...args), "packed repository setup");
      assert.equal(result.state, "trust-pending");
      assert.equal(result.repository.repositoryId, "44332211");
      assert.equal(result.publication, undefined);
      const initialProvider = JSON.parse(await readFile(providerState, "utf8"));
      assert.equal(initialProvider.pr, undefined);
      await writeFile(providerState, JSON.stringify({ ...initialProvider, trustUnavailable: false }));
      const routes = (await readFile(providerLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).route);
      assert.ok(routes.includes("user/installations"));
      assert.ok(routes.includes("user/installations/77/repositories"));
      assert.ok(routes.includes("login/device/code"));
      assert.ok(routes.includes("login/oauth/access_token"));
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
      assert.deepEqual(admissionPin, bootstrap.authority);
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
      const beforeTrustRead = JSON.parse(await readFile(providerState, "utf8"));
      await writeFile(providerState, JSON.stringify({ ...beforeTrustRead, trustUnavailable: true }));
      const unavailable = json(run("setup", "status", ...setupArguments), "shared setup unavailable trust");
      assert.equal(
        unavailable.state.dimensions.find((item) => item.dimension === "repository-trust")?.status,
        "unknown",
      );
      assert.equal(
        unavailable.state.actions.some((action) => action.kind === "authority.publish-trust"),
        false,
      );
      await writeFile(providerState, JSON.stringify(beforeTrustRead));
      const publicationState = json(run("setup", "status", ...setupArguments), "shared setup publication state");
      assert.equal(
        publicationState.state.dimensions.find((item) => item.dimension === "repository-trust")?.status,
        "untrusted",
      );
      assert.equal(
        publicationState.state.actions.find((action) => action.id === publicationState.state.nextAction.actionId)?.kind,
        "authority.publish-trust",
      );
      const published = json(run("setup", "next", ...setupArguments, "--yes"), "shared setup first trust publication");
      assert.equal(published.result.outcome, "succeeded");
      assert.equal(published.result.diagnostics[0]?.code, "SETUP_TRUST_PUBLICATION_PENDING");
      const pending = JSON.parse(await readFile(providerState, "utf8"));
      assert.equal(pending.merged, false);
      assert.equal(pending.pr, true);
      assert.deepEqual(JSON.parse(pending.artifact.content), admissionPin);
      const waiting = json(run("setup", "status", ...setupArguments), "shared setup human wait");
      assert.equal(waiting.state.stage, "pending-human-trust");
      assert.equal(waiting.state.nextAction.kind, "wait");
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
        "packed CLI Device Flow, App-user scope, unavailable-trust denial, first deterministic trust PR, human wait, partial migration recovery, and provider-side merge trust recheck: PASS",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await packed.cleanup();
    }
  },
);
