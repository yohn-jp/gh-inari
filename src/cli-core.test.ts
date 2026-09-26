import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli-core.js";
import { getCommandForPositionals } from "./command-contract.js";
import {
  createDelegatorRecord,
  createLocalDelegatorSignedChangeProvenanceRecord,
} from "./agent-authority/delegator-operations.js";
import {
  delegatorPublicKeyFingerprint,
  generateDelegatorKeyPair,
  loadDelegatorKeyPair,
} from "./agent-authority/delegator-key.js";
import { validateDelegator, type Delegator } from "./agent-authority/delegator.js";
import {
  createLocalSessionBinding,
  verifyLocalSessionBinding,
  type LocalSessionBinding,
} from "./local-control/session-binding.js";
import { createLocalAdmissionHttpServer } from "./local-control/admission-server.js";
import { LocalExecutorClient } from "./local-control/executor-client.js";
import { createLocalExecutorHttpServer } from "./local-control/executor-server.js";
import { createLocalAdmissionClient } from "./local-control/admission-client.js";
import { setupLocalAuthority } from "./local-control/identity.js";
import {
  localComponentPath,
  validateLocalCliConfig,
  validateLocalAuthorityConfig,
  validateLocalExecutorConfig,
  writeLocalJson,
} from "./local-control/config.js";
import { publishLocalRuntimeEndpoint } from "./local-control/runtime-discovery.js";
import {
  readLocalSessionBinding,
  readLocalSessionChangeIssueProvenance,
  storeLocalSessionBinding,
  storeLocalSessionChangeIssueProvenance,
} from "./local-control/session-launcher.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import { renderImplementationIssueBody } from "./implementation-contract.js";
import { verifyChangeProvenanceRecord } from "./change-provenance-record.js";
import type { AuthorizedExecutionResult } from "./authorized-execution.js";
import { createAppUserCredential } from "./github/app-user-credential.js";
import { FileAppUserCredentialStore } from "./github/app-user-credential-store.js";

interface CapturedOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-cli-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

/** Executor-owned Issuer App private key custody outside the config home. */
async function configureIssuerKey(root: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const keyPath = path.join(root, "issuer-app.private-key.pem");
  await writeFile(keyPath, pem, { mode: 0o600 });
  environment.INARI_GITHUB_APP_PRIVATE_KEY_FILE = keyPath;
  return pem;
}

async function capture(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: Parameters<typeof runCli>[1] = {},
): Promise<CapturedOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  try {
    return {
      exitCode: await runCli(argv, { ...dependencies, environment }),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("inari init declares only the local CLI topology and is idempotent", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const first = await capture(["init", "--json"], environment, { repositoryRoot: root });
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    const firstOutput = JSON.parse(first.stdout) as {
      readonly ok: boolean;
      readonly operation: string;
      readonly configPath: string;
      readonly config: Record<string, unknown>;
      readonly applicationState: {
        readonly version: number;
        readonly status: string;
        readonly setupComplete: boolean;
        readonly provider: { readonly credentialConfigured: boolean; readonly credentialPath: string };
        readonly steps: readonly { readonly id: string; readonly status: string; readonly syntax: string }[];
        readonly nextAction: { readonly stepId: string; readonly commands: readonly string[] };
        readonly runtime: { readonly status: string; readonly commands: readonly string[] };
        readonly changeBranch: { readonly status: string; readonly detail: string };
        readonly sessionStartCommand: string;
      };
      readonly runtimeStatus: { readonly executor: string; readonly admission: string; readonly overall: string };
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
    assert.equal(firstOutput.applicationState.version, 1);
    assert.equal(firstOutput.applicationState.status, "incomplete");
    assert.equal(firstOutput.applicationState.setupComplete, false);
    assert.equal(firstOutput.applicationState.provider.credentialConfigured, false);
    assert.equal(
      firstOutput.applicationState.provider.credentialPath,
      path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"),
    );
    assert.equal(firstOutput.applicationState.nextAction.stepId, "app-user-authorization");
    assert.deepEqual(firstOutput.applicationState.nextAction.commands, ["inari setup --endpoint <endpoint-url>"]);
    assert.deepEqual(
      firstOutput.applicationState.steps.map((step) => step.id),
      [
        "cli-topology",
        "app-user-authorization",
        "executor-app-id",
        "executor-issuer-key",
        "executor",
        "runtime-authority-key",
        "runtime-authority-record",
        "admission",
      ],
    );
    assert.ok(firstOutput.applicationState.steps.some((step) => step.syntax.includes("authority bootstrap")));
    assert.ok(firstOutput.applicationState.steps.some((step) => step.syntax.includes("admission setup --from")));
    assert.deepEqual(firstOutput.applicationState.runtime.commands, ["inari runtime supervise"]);
    assert.equal(firstOutput.applicationState.runtime.status, "not-checked");
    assert.equal(firstOutput.applicationState.changeBranch.status, "issue-not-selected");
    assert.equal(
      firstOutput.applicationState.sessionStartCommand,
      "inari session start --issue <number> -- <command...>",
    );
    assert.equal(firstOutput.runtimeStatus.executor, "not-running");
    assert.equal(firstOutput.runtimeStatus.admission, "not-running");
    assert.equal(firstOutput.runtimeStatus.overall, "not-ready");
    assert.equal(first.stdout.includes("BEGIN PRIVATE KEY"), false);
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "admission")));
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));

    const human = await capture(["init"], environment, { repositoryRoot: root });
    assert.equal(human.exitCode, 0);
    assert.ok(human.stdout.includes("Ordered setup path:"));
    assert.ok(human.stdout.includes("inari setup --endpoint <endpoint-url>"));
    assert.ok(human.stdout.includes("INARI_GITHUB_APP_ID"));
    assert.ok(human.stdout.includes("INARI_GITHUB_APP_PRIVATE_KEY_FILE"));
    assert.ok(human.stdout.includes("inari authority bootstrap"));
    assert.ok(human.stdout.includes("inari admission setup --from"));
    assert.ok(human.stdout.includes("Issue/Change branch: issue-not-selected"));
    assert.ok(!human.stdout.includes("Then launch the governed child with:"));
    // #1065 review: the branch-naming placeholder pattern (which contains `|`
    // and `<>`, shell pipeline/redirection operators) must appear only as
    // descriptive prose, never as its own "Run: ..." line.
    assert.ok(!human.stdout.split("\n").some((line) => line.startsWith("Run: git checkout")));
    assert.ok(human.stdout.includes("Runtime readiness: executor=not-running admission=not-running overall=not-ready"));
    assert.ok(human.stdout.includes("inari runtime console"));

    const second = await capture(["init", "--json"], environment, { repositoryRoot: root });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(JSON.parse(second.stdout), firstOutput);
    assert.deepEqual(JSON.parse(await readFile(firstOutput.configPath, "utf8")), firstOutput.config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local application state reaches configured through supported CLI commands without JSON editing", async () => {
  const { root, environment } = await temporaryEnvironment();
  environment.INARI_GITHUB_APP_ID = "123456";
  const publicAuthorityPath = localComponentPath("authority", "runtime-authority.json", environment);
  const deps = { repositoryRoot: root };
  try {
    assert.equal((await capture(["init", "--json"], environment, deps)).exitCode, 0);
    const issuerPem = await configureIssuerKey(root, environment);
    await new FileAppUserCredentialStore({
      path: path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"),
    }).save(
      createAppUserCredential({
        accessToken: "state-access-secret",
        refreshToken: "state-refresh-secret",
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    assert.equal((await capture(["executor", "setup", "--json"], environment, deps)).exitCode, 0);
    const authorityOutput = await capture(["authority", "setup", "--json"], environment, deps);
    assert.equal(authorityOutput.exitCode, 0);
    const authority = JSON.parse(authorityOutput.stdout) as {
      readonly privateKeyPath: string;
      readonly publicKeyFingerprint: string;
    };
    const authorityId = `runtime-${authority.publicKeyFingerprint.slice("sha256:".length)}`;
    const bootstrap = await capture(
      [
        "authority",
        "bootstrap",
        "--authority-id",
        authorityId,
        "--private-key",
        authority.privateKeyPath,
        "--max-session-ttl-seconds",
        "3600",
        "--capability",
        "change.implement",
        "--output",
        publicAuthorityPath,
        "--json",
      ],
      environment,
      deps,
    );
    assert.equal(bootstrap.exitCode, 0, bootstrap.stderr);
    const admission = await capture(["admission", "setup", "--from", publicAuthorityPath, "--json"], environment, deps);
    assert.equal(admission.exitCode, 0, admission.stderr);

    const initialized = await capture(["init", "--json"], environment, deps);
    assert.equal(initialized.exitCode, 0);
    const state = JSON.parse(initialized.stdout).applicationState as {
      readonly status: string;
      readonly setupComplete: boolean;
      readonly steps: readonly { readonly id: string; readonly status: string }[];
      readonly nextAction: { readonly stepId: string; readonly commands: readonly string[] };
      readonly changeBranch: { readonly status: string; readonly issue?: number; readonly branch?: string };
    };
    assert.equal(state.status, "configured", JSON.stringify(state.steps));
    assert.equal(state.setupComplete, true);
    assert.ok(
      state.steps.every((step) => step.status === "ready"),
      JSON.stringify(state.steps),
    );
    // #1065: once setup completes the canonical next action is the Runtime
    // Supervisor plus, since no canonical Issue-bound Change branch is
    // checked out yet, guidance to select one -- not a bare Session-start
    // command projected as immediately executable. The branch-naming
    // placeholder pattern is prose (inside `detail`), never a literal
    // "Run: ..." entry in `nextAction.commands` -- `<`, `|`, and `>` are
    // shell operators, and copying it verbatim must not invoke a shell
    // redirection/pipeline instead of creating a branch.
    assert.equal(state.changeBranch.status, "issue-not-selected");
    assert.equal("command" in state.changeBranch, false);
    assert.deepEqual(state.nextAction, {
      stepId: "change-branch",
      commands: ["inari runtime supervise"],
      detail:
        "Run the local Runtime Supervisor in a separate foreground terminal. No Issue is selected. Check out a canonical Issue-bound Change branch (git checkout -b, naming: <feat|fix|docs|refactor|test|chore>/<issue-number>-<slug>) before Session start.",
    });
    for (const command of state.nextAction.commands) assert.doesNotMatch(command, /[<>|]/u);
    assert.equal(initialized.stdout.includes("state-access-secret"), false);
    assert.equal(initialized.stdout.includes("state-refresh-secret"), false);
    assert.equal(initialized.stdout.includes("BEGIN PRIVATE KEY"), false);
    assert.equal(initialized.stdout.includes(issuerPem.split("\n")[1] as string), false);

    // Checking out the canonical Issue-bound Change branch flips readiness to
    // "ready" and the projected next action becomes the Runtime Supervisor
    // followed directly by the exact Session-start command for that Issue.
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "-b", "feat/4242-local-state-branch-readiness"], { cwd: root });
    const onCanonicalBranch = await capture(["init", "--json"], environment, deps);
    assert.equal(onCanonicalBranch.exitCode, 0);
    const readyState = JSON.parse(onCanonicalBranch.stdout).applicationState as {
      readonly changeBranch: { readonly status: string; readonly issue?: number; readonly branch?: string };
      readonly nextAction: { readonly stepId: string; readonly commands: readonly string[] };
    };
    assert.deepEqual(readyState.changeBranch, {
      status: "ready",
      detail: "Local branch feat/4242-local-state-branch-readiness is the canonical Change branch for Issue #4242.",
      issue: 4242,
      branch: "feat/4242-local-state-branch-readiness",
    });
    assert.deepEqual(readyState.nextAction, {
      stepId: "start-runtime",
      commands: ["inari runtime supervise"],
      detail:
        "Run the local Runtime Supervisor in a separate foreground terminal, then launch the governed child for Issue #4242 on feat/4242-local-state-branch-readiness with the Session command below.",
    });

    // A branch that is neither the default branch nor a canonical Change
    // branch is a mismatch state, not a silent pass-through to Session start.
    execFileSync("git", ["checkout", "-q", "-b", "scratch-notes"], { cwd: root });
    const onMismatchedBranch = await capture(["init", "--json"], environment, deps);
    assert.equal(onMismatchedBranch.exitCode, 0);
    const mismatchState = JSON.parse(onMismatchedBranch.stdout).applicationState as {
      readonly changeBranch: { readonly status: string; readonly branch?: string };
      readonly nextAction: { readonly stepId: string };
    };
    assert.equal(mismatchState.changeBranch.status, "branch-mismatch");
    assert.equal(mismatchState.changeBranch.branch, "scratch-notes");
    assert.equal(mismatchState.nextAction.stepId, "change-branch");
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

test("executor setup and serve use the Executor command contract and Executor-owned Issuer key custody", async () => {
  assert.equal(getCommandForPositionals(["executor", "setup"])?.id, "executor.setup");
  assert.equal(getCommandForPositionals(["executor", "serve"])?.id, "executor.serve");

  const { root, environment } = await temporaryEnvironment();
  environment.INARI_GITHUB_APP_ID = "123456";
  try {
    const missingSetup = await capture(["executor", "serve", "--json"], environment);
    assert.equal(missingSetup.exitCode, 2);
    assert.equal(JSON.parse(missingSetup.stdout).error.code, "EXECUTOR_NOT_SETUP");

    const missingKey = await capture(["executor", "setup", "--json"], environment);
    assert.notEqual(missingKey.exitCode, 0);
    assert.equal(JSON.parse(missingKey.stdout).error.code, "EXECUTOR_ISSUER_KEY_MISSING");
    assert.match(JSON.parse(missingKey.stdout).error.message, /INARI_GITHUB_APP_PRIVATE_KEY_FILE/u);

    // Setup checks only the Executor-owned reference; an unreadable path is
    // accepted because setup never opens or parses the key.
    const absentKey = await capture(["executor", "setup", "--json"], {
      ...environment,
      INARI_GITHUB_APP_PRIVATE_KEY_FILE: path.join(root, "absent-issuer-app.private-key.pem"),
    });
    assert.equal(absentKey.exitCode, 0);
    const absentState = await capture(
      ["init", "--json"],
      { ...environment, INARI_GITHUB_APP_PRIVATE_KEY_FILE: path.join(root, "absent-issuer-app.private-key.pem") },
      { repositoryRoot: root },
    );
    assert.equal(absentState.exitCode, 0);
    assert.equal(JSON.parse(absentState.stdout).applicationState.provider.issuerKey, "configured");

    const issuerPem = await configureIssuerKey(root, environment);
    const setup = await capture(["executor", "setup", "--json"], environment);
    assert.equal(setup.exitCode, 0);
    const output = JSON.parse(setup.stdout) as {
      readonly ok: boolean;
      readonly operation: string;
      readonly executorId: string;
      readonly configPath: string;
      readonly provider: { readonly credentialProfile: string };
    };
    assert.equal(output.ok, true);
    assert.equal(output.operation, "executor.setup");
    assert.match(output.executorId, /^exec_[A-Za-z0-9_-]{16,64}$/u);
    assert.equal("endpoint" in output, false);
    assert.equal(output.configPath, path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json"));
    assert.equal(output.provider.credentialProfile, "default");
    assert.equal(setup.stdout.includes(issuerPem.split("\n")[1] as string), false);
    assert.equal((await readFile(output.configPath, "utf8")).includes("PRIVATE KEY"), false);
    const second = await capture(["executor", "setup", "--json"], environment);
    assert.equal(JSON.parse(second.stdout).executorId, output.executorId);

    const unsupported = await capture(
      ["executor", "setup", "--config-home", path.join(root, "elsewhere"), "--json"],
      environment,
    );
    assert.equal(unsupported.exitCode, 1);
    assert.equal(JSON.parse(unsupported.stdout).error.code, "INVALID_OPTION");

    const unsupportedCapability = await capture(
      ["executor", "setup", "--capability", "change.implement", "--json"],
      environment,
    );
    assert.equal(unsupportedCapability.exitCode, 1);
    assert.equal(JSON.parse(unsupportedCapability.stdout).error.code, "INVALID_OPTION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Admission CLI setup is deterministic and serve requires setup", async () => {
  assert.equal(getCommandForPositionals(["admission", "setup"])?.id, "admission.setup");
  assert.equal(getCommandForPositionals(["admission", "serve"])?.id, "admission.serve");

  const { root, environment } = await temporaryEnvironment();
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "cli-admission-runtime",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "branch.advance"],
  });
  try {
    const unconfigured = await capture(["admission", "serve", "--json"], environment);
    assert.equal(unconfigured.exitCode, 2);
    assert.equal(JSON.parse(unconfigured.stdout).error.code, "ADMISSION_NOT_SETUP");

    writeLocalJson(
      "authority",
      "config.json",
      {
        version: 1,
        publicKey: keyPair.publicKeyJwk,
        publicKeyFingerprint: delegatorPublicKeyFingerprint(authority.key),
        privateKeyFile: "private-key.pem",
      },
      validateLocalAuthorityConfig,
      environment,
    );
    writeLocalJson(
      "executor",
      "config.json",
      {
        version: 1,
        id: "exec_0123456789abcdef",
        listen: { host: "127.0.0.1", port: 8765 },
        provider: { kind: "github", credentialProfile: "default" },
      },
      validateLocalExecutorConfig,
      environment,
    );
    const authorityPath = path.join(root, "runtime-authority.json");
    await writeFile(authorityPath, `${JSON.stringify(authority)}\n`, "utf8");
    assert.equal((await capture(["init", "--json"], environment)).exitCode, 0);

    const first = await capture(["admission", "setup", "--from", authorityPath, "--json"], environment);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    const firstOutput = JSON.parse(first.stdout) as {
      readonly ok: boolean;
      readonly operation: string;
      readonly admissionId: string;
      readonly executorId: string;
      readonly configPath: string;
      readonly publicAuthorityPath: string;
    };
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.operation, "admission.setup");
    assert.match(firstOutput.admissionId, /^adm_[A-Za-z0-9_-]{16,64}$/u);
    assert.equal(firstOutput.executorId, "exec_0123456789abcdef");
    assert.equal("executorEndpoint" in firstOutput, false);
    assert.equal(first.stdout.includes("private"), false);

    const second = await capture(["admission", "setup", "--from", authorityPath, "--json"], environment);
    assert.equal(JSON.parse(second.stdout).admissionId, firstOutput.admissionId);
    assert.deepEqual(JSON.parse(await readFile(firstOutput.configPath, "utf8")).executor, {
      id: firstOutput.executorId,
    });
    assert.equal(
      firstOutput.publicAuthorityPath,
      path.join(environment.INARI_CONFIG_HOME as string, "admission", "runtime-authority.json"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface AdmissionTestRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

async function startAdmissionTestServer(
  handler: (
    request: AdmissionTestRequest,
  ) =>
    { readonly status: number; readonly body: unknown } | Promise<{ readonly status: number; readonly body: unknown }>,
): Promise<{ readonly endpoint: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", async () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      const result = await handler({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: { ...request.headers },
        body,
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function closeHttpServer(server: { close(callback: (error?: Error) => void): unknown }): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function writeAdmissionRoute(environment: NodeJS.ProcessEnv, endpoint: string): void {
  const id = "adm_0123456789abcdef";
  writeLocalJson(
    "cli",
    "config.json",
    {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: { id },
    },
    validateLocalCliConfig,
    environment,
  );
  publishLocalRuntimeEndpoint("admission", id, Number(new URL(endpoint).port), environment);
}

function authorityValidator(value: unknown): Delegator {
  const validation = validateDelegator(value);
  if (!validation.valid || validation.value === undefined) throw new Error("invalid test Authority");
  return validation.value;
}

function localAuthority(environment: NodeJS.ProcessEnv): {
  readonly authority: Delegator;
  readonly keyPair: ReturnType<typeof generateDelegatorKeyPair>;
} {
  setupLocalAuthority(environment);
  const keyPair = loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment));
  const authority = createDelegatorRecord({
    id: "cli-local-admission-test",
    key: keyPair,
    notBefore: new Date("2026-01-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort", "change.merge", "branch.advance"],
  });
  writeLocalJson("admission", "runtime-authority.json", authority, authorityValidator, environment);
  return { authority, keyPair };
}

function localSessionBinding(
  sessionId: string,
  issue: number,
  repositoryId: string,
  repositoryName: string,
  options: {
    readonly authority?: Delegator;
    readonly keyPair?: ReturnType<typeof generateDelegatorKeyPair>;
    readonly branch?: string;
  } = {},
): LocalSessionBinding {
  const keyPair = options.keyPair ?? generateDelegatorKeyPair();
  const authority =
    options.authority ??
    createDelegatorRecord({
      id: "cli-local-binding-test",
      key: keyPair,
      notBefore: new Date("2026-01-01T00:00:00.000Z"),
      maxSessionTtlSeconds: 3_600,
      capabilityCeiling: ["change.implement", "change.ready", "change.abort", "change.merge", "branch.advance"],
    });
  return createLocalSessionBinding({
    sessionId,
    repository: { id: repositoryId, name: repositoryName },
    task: { kind: "issue", number: issue },
    capabilities: [
      { kind: "change.implement", issue },
      { kind: "change.ready", issue },
      { kind: "change.abort", issue },
      { kind: "change.merge", issue },
      { kind: "branch.advance", branch: options.branch ?? `feat/${issue}-local-cli-admission-path` },
    ],
    ttlSeconds: 300,
    runtimeAuthority: authority,
    runtimeKey: keyPair,
    now: new Date(),
  });
}

function localTrustEvidence(authority: Delegator): {
  readonly repository: {
    readonly repositoryHost: "github.com";
    readonly repositoryId: string;
    readonly nameWithOwner: string;
  };
  readonly authority: { readonly ref: string; readonly sha: string };
  readonly runtimeAuthority: Delegator;
} {
  return {
    repository: { repositoryHost: "github.com", repositoryId: "123456789", nameWithOwner: "acme/inari" },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    runtimeAuthority: authority,
  };
}

function localImplementationEvidence(
  issue: number,
  repositoryId: string,
  branch: string,
  baseHead: string,
  projection: ChangeProjectionResult,
): Record<string, unknown> {
  const repository = { repositoryHost: "github.com", repositoryId, repository: "acme/inari" };
  const reference = { ...repository, number: issue };
  const body = renderImplementationIssueBody({
    version: 1,
    kind: "implementation",
    repository,
    sources: [reference],
    objective: "Admit bounded local implementation.",
    nonGoals: ["Persisting derived scope."],
    architecture: {
      decision: "Derive current authorization for every execution.",
      affectedComponents: ["Admission"],
      invariants: ["Executor identity is pinned."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: ["src/**"], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Admission denies stale evidence."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: { baseBranch: "main", baseRevision: baseHead, baseFreshness: baseHead, branch, dependencies: [] },
  });
  return {
    implementation: reference,
    issue: { reference, body },
    repository,
    base: { branch: "main", revision: baseHead, freshness: baseHead },
    readiness: { evidence: [] },
    change: projection,
  };
}

function localChangeProjection(
  issue: number,
  repositoryId: string,
  branch: string,
  head: string,
): ChangeProjectionResult {
  const projection = projectChangeFromGitHubEvidence({
    change: { repositoryHost: "github.com", repositoryId, rootIssue: issue },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "local-cli-admission-path" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: issue, state: "open" } },
      branches: { status: "available", value: [{ name: branch, sha: head, rootIssue: issue }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: 1049,
            head: branch,
            headSha: head,
            base: "main",
            state: "open",
            draft: true,
            merged: false,
            rootIssue: issue,
          },
        ],
      },
    },
  });
  assert.equal(projection.valid, true);
  return projection;
}

async function gitRepository(root: string): Promise<{ readonly baseHead: string; readonly head: string }> {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["checkout", "-b", "feat/1029-local-cli-admission-path"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Inari Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "inari-test@example.invalid"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "example.ts"), "export const baseline = true;\n", "utf8");
  execFileSync("git", ["add", "src/example.ts"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
  const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(path.join(root, "src", "example.ts"), "export const baseline = false;\n", "utf8");
  execFileSync("git", ["add", "src/example.ts"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "local admission change"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { baseHead, head };
}

test("session start registers a production-verifiable binding and bounded provenance without exposing its private key", async () => {
  const { root, environment } = await temporaryEnvironment();
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["checkout", "-b", "feat/1029-local-cli-admission-path"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
  const local = localAuthority(environment);
  const admissionServer = createLocalAdmissionHttpServer(
    {
      version: 1,
      id: "adm_0123456789abcdef",
      listen: { host: "127.0.0.1", port: 0 },
      executor: { id: "exec_0123456789abcdef", endpoint: "http://127.0.0.1:8765" },
    },
    "0.14.1-test",
    local.authority,
    {
      async verifyReady() {
        return { ok: true };
      },
      async resolveRepository() {
        return { repositoryHost: "github.com", repositoryId: "123456789", nameWithOwner: "acme/inari" };
      },
      async readEvidence() {
        return localTrustEvidence(local.authority);
      },
      async execute() {
        throw new Error("session start must not execute Change mutations");
      },
    },
    { environment },
  );
  await once(admissionServer, "listening");
  const address = admissionServer.address() as AddressInfo;
  try {
    assert.equal(
      getCommandForPositionals(["session", "start", process.execPath, "-e", "process.exit(13)"])?.id,
      "session.start",
    );
    const missingSeparator = await capture(["session", "start", "--issue", "1029", process.execPath], environment, {
      repositoryRoot: root,
    });
    const oversizedIssue = await capture(
      ["session", "start", "--issue", "1000000000", "--", process.execPath],
      environment,
      { repositoryRoot: root },
    );
    assert.notEqual(missingSeparator.exitCode, 0);
    assert.notEqual(oversizedIssue.exitCode, 0);
    writeAdmissionRoute(environment, `http://127.0.0.1:${address.port}`);
    environment.PARENT_ONLY = "unchanged";
    environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY = "parent-only-secret";
    environment.INARI_ISSUER_APP_PRIVATE_KEY = "parent-only-issuer-secret";
    let identityReads = 0;
    const result = await runCli(
      [
        "session",
        "start",
        "--issue",
        "1029",
        "--",
        process.execPath,
        "-e",
        "process.exit(process.env.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY || process.env.INARI_ISSUER_APP_PRIVATE_KEY ? 91 : 13)",
      ],
      {
        repositoryRoot: root,
        environment,
        createAdapter: (() => {
          identityReads += 1;
          return {
            async getRepositoryContext() {
              return {
                hostname: "github.com",
                nameWithOwner: "acme/inari",
                repositoryId: "123456789",
              };
            },
          };
        }) as never,
      },
    );
    assert.equal(result, 13);
    assert.equal(identityReads, 0);
    assert.equal(environment.INARI_SESSION_ID, undefined);
    assert.equal(environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY, "parent-only-secret");
    assert.equal(environment.INARI_ISSUER_APP_PRIVATE_KEY, "parent-only-issuer-secret");
    assert.equal(environment.PARENT_ONLY, "unchanged");

    const sessionFiles = await readdir(path.join(environment.INARI_CONFIG_HOME as string, "cli", "sessions"));
    const bindingFile = sessionFiles.find(
      (name) => name.endsWith(".json") && !name.endsWith(".change-issue-provenance.json"),
    );
    assert.ok(bindingFile);
    const sessionId = bindingFile.slice(0, -".json".length);
    const binding = readLocalSessionBinding(sessionId, environment);
    assert.ok(binding);
    assert.equal(verifyLocalSessionBinding(binding, local.authority).valid, true);
    assert.ok(
      binding.capabilities.some(
        (claim) => claim.kind === "branch.advance" && claim.branch === "feat/1029-local-cli-admission-path",
      ),
    );
    const provenance = readLocalSessionChangeIssueProvenance(binding, environment);
    assert.equal(provenance?.rootIssue, 1029);
    const admissionRecord = JSON.parse(
      await readFile(localComponentPath("admission", `sessions/${sessionId}.json`, environment), "utf8"),
    ) as { readonly state: string };
    assert.equal(admissionRecord.state, "active");
    assert.deepEqual(sessionFiles.sort(), [`${sessionId}.change-issue-provenance.json`, `${sessionId}.json`].sort());
    assert.equal(
      sessionFiles.some((name) => name.includes("current")),
      false,
    );
  } finally {
    await new Promise<void>((resolve, reject) => admissionServer.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

test("local Change commands use the production Admission authority and its exact Session capabilities", async () => {
  const { root: configRoot, environment } = await temporaryEnvironment();
  const repositoryRoot = path.join(configRoot, "repository");
  await mkdir(repositoryRoot);
  const { baseHead, head } = await gitRepository(repositoryRoot);
  const issue = 1029;
  const branch = "feat/1029-local-cli-admission-path";
  const sessionId = "sess_cli-route-1029";
  const received: AdmissionTestRequest[] = [];
  const local = localAuthority(environment);
  let currentHead = baseHead;
  let issueProvenanceVerified = false;
  let branchAdvanceAuthorized = false;
  let rejectAdmission = false;

  const executorServer = createLocalExecutorHttpServer({
    config: {
      version: 1,
      id: "exec_0123456789abcdef",
      listen: { host: "127.0.0.1", port: 8765 },
      provider: { kind: "github", credentialProfile: "default" },
    },
    listenPort: 0,
    version: "0.14.1-test",
    executorId: "exec_0123456789abcdef",
    readEvidence: async (request) => {
      const trust = localTrustEvidence(local.authority);
      if (request.issue === undefined) return trust;
      const projection = localChangeProjection(issue, "123456789", branch, currentHead);
      return {
        ...trust,
        change: projection,
        implementation: localImplementationEvidence(issue, "123456789", branch, baseHead, projection),
      };
    },
    execute: async (execution): Promise<AuthorizedExecutionResult> => {
      if (execution.operation === "change.issue") {
        const record = execution.request.signedProvenanceRecord;
        assert.ok(record, "the production Executor requires caller-produced signed change.issue provenance");
        assert.equal(verifyChangeProvenanceRecord(record, local.authority).rootIssue, issue);
        issueProvenanceVerified = true;
      }
      if (execution.operation === "branch.advance") {
        assert.equal(execution.capability.kind, "branch.advance");
        assert.equal(execution.capability.branch, branch);
        branchAdvanceAuthorized = true;
        currentHead = head;
        return {
          version: 1,
          operation: "branch.advance",
          status: "succeeded",
          branchAdvance: {
            version: 1,
            operation: "branch.advance",
            status: "succeeded",
            outcome: "advanced",
            branch,
            expectedHead: execution.request.expectedHead,
            resultingHead: head,
          },
        };
      }
      const projection = localChangeProjection(issue, "123456789", branch, currentHead);
      return {
        version: 1,
        operation: execution.operation,
        status: "succeeded",
        projection,
        execution: { projection },
      };
    },
  });
  await once(executorServer, "listening");
  const executorAddress = executorServer.address() as AddressInfo;
  const executorEndpoint = `http://127.0.0.1:${executorAddress.port}`;
  const admissionServer = createLocalAdmissionHttpServer(
    {
      version: 1,
      id: "adm_0123456789abcdef",
      listen: { host: "127.0.0.1", port: 0 },
      executor: { id: "exec_0123456789abcdef", endpoint: executorEndpoint },
    },
    "0.14.1-test",
    local.authority,
    new LocalExecutorClient({ id: "exec_0123456789abcdef", endpoint: executorEndpoint }),
    { environment },
  );
  await once(admissionServer, "listening");
  const admissionAddress = admissionServer.address() as AddressInfo;
  const admissionEndpoint = `http://127.0.0.1:${admissionAddress.port}`;
  const proxy = await startAdmissionTestServer(async (request) => {
    received.push(request);
    if (rejectAdmission && request.path === "/v1/executions") {
      return { status: 503, body: { ok: false, error: { code: "UNAVAILABLE" } } };
    }
    const headers = new Headers({ "content-type": "application/json" });
    const sessionHeader = request.headers["x-inari-session-id"];
    if (typeof sessionHeader === "string") headers.set("x-inari-session-id", sessionHeader);
    const response = await fetch(`${admissionEndpoint}${request.path}`, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  });

  try {
    writeAdmissionRoute(environment, proxy.endpoint);
    environment.INARI_SESSION_CREDENTIAL_FILE = path.join(configRoot, "legacy-session.json");
    environment.INARI_APP_ENDPOINT = "https://legacy-app.example.com";
    const binding = localSessionBinding(sessionId, issue, "123456789", "acme/inari", {
      authority: local.authority,
      keyPair: local.keyPair,
      branch,
    });
    storeLocalSessionBinding(binding, environment);
    const signedProvenanceRecord = await createLocalDelegatorSignedChangeProvenanceRecord(issue, {
      authorityId: local.authority.id,
      privateKey: local.keyPair,
    });
    storeLocalSessionChangeIssueProvenance(binding, signedProvenanceRecord, environment);
    await createLocalAdmissionClient({ endpoint: proxy.endpoint }).registerSession(binding);
    received.length = 0;

    let providerAdapterUsed = false;
    let nonAdmissionExecutorUsed = false;
    const dependencies = {
      repositoryRoot,
      createAdapter: (() => {
        providerAdapterUsed = true;
        throw new Error("configured local topology must not construct GitHubAdapter");
      }) as never,
      createChangeExecutor: (() => {
        nonAdmissionExecutorUsed = true;
        throw new Error("configured local topology must not construct another executor");
      }) as never,
    };
    const noSelectorEnvironment = { ...environment };
    delete noSelectorEnvironment.INARI_SESSION_ID;
    const missingSelector = await capture(
      ["change", "show", String(issue), "--json"],
      noSelectorEnvironment,
      dependencies,
    );
    assert.equal(JSON.parse(missingSelector.stdout).error.code, "ADMISSION_SESSION_SELECTOR_REQUIRED");
    assert.equal(received.length, 0);

    let explicitDirectAppSelected = false;
    const explicitDirectApp = await capture(
      [
        "change",
        "show",
        String(issue),
        "--session-credential",
        "unused-session.json",
        "--app-endpoint",
        "https://api.github.com",
        "--json",
      ],
      { ...noSelectorEnvironment, INARI_SESSION_ID: "malformed-but-explicit-direct-app-wins" },
      {
        ...dependencies,
        changeExecutor: {
          async read() {
            explicitDirectAppSelected = true;
            throw new Error("explicit direct-App compatibility selected");
          },
          async execute() {
            throw new Error("unexpected direct-App mutation");
          },
        },
      },
    );
    assert.notEqual(explicitDirectApp.exitCode, 0);
    assert.equal(explicitDirectAppSelected, true);
    assert.equal(received.length, 0);

    environment.INARI_SESSION_ID = sessionId;
    environment.GH_TOKEN = "must-not-be-read";
    const commands = [
      ["change", "issue", String(issue), "--json"],
      ["change", "show", String(issue), "--json"],
      ["change", "ready", String(issue), "--json"],
      ["change", "abort", String(issue), "--json"],
      ["change", "merge", String(issue), "--strategy", "squash", "--json"],
      ["change", "publish", String(issue), "--commit", "HEAD", "--json"],
    ];
    const results: CapturedOutput[] = [];
    for (const command of commands) results.push(await capture(command, environment, dependencies));
    assert.equal(results[0]?.exitCode, 0, results[0]?.stdout || results[0]?.stderr);
    assert.equal(results[5]?.exitCode, 0, results[5]?.stdout || results[5]?.stderr);
    assert.equal(issueProvenanceVerified, true);
    assert.equal(branchAdvanceAuthorized, true);

    rejectAdmission = true;
    const denied = await capture(["change", "show", String(issue), "--json"], environment, dependencies);
    assert.notEqual(denied.exitCode, 0);
    assert.equal(JSON.parse(denied.stdout).error.code, "ADMISSION_REQUEST_DENIED");
    assert.equal(providerAdapterUsed, false);
    assert.equal(nonAdmissionExecutorUsed, false);
    assert.deepEqual(
      received.map((request) => [request.method, request.path]),
      Array.from({ length: 9 }, () => ["POST", "/v1/executions"]),
    );
    const intents = received.map((request) => request.body as Record<string, unknown>);
    assert.deepEqual(
      intents.map((intent) => intent.operation),
      [
        "change.issue",
        "change.show",
        "change.ready",
        "change.abort",
        "change.merge",
        "change.show",
        "branch.advance",
        "change.show",
        "change.show",
      ],
    );
    for (const intent of intents) {
      assert.deepEqual(Object.keys(intent).sort(), ["operation", "repository", "request", "requestId", "version"]);
      assert.equal("capability" in intent, false);
      assert.equal("authorization" in intent, false);
      assert.equal((intent.repository as Record<string, unknown>).repositoryId, "123456789");
      const request = received.find((candidate) => candidate.body === intent);
      assert.equal(request?.headers.authorization, undefined);
      assert.equal(request?.headers["x-inari-session-id"], sessionId);
    }
    const issueIntent = intents[0]?.request as Record<string, unknown>;
    assert.ok(issueIntent.signedProvenanceRecord);
    assert.equal("implementationConformance" in issueIntent, false);
    assert.equal("semanticPullRequestPlan" in issueIntent, false);
    const execution = JSON.parse(
      await readFile(localComponentPath("admission", `sessions/${sessionId}.json`, environment), "utf8"),
    ) as { readonly state: string };
    assert.equal(execution.state, "active");
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));
  } finally {
    await proxy.close();
    await closeHttpServer(admissionServer);
    await closeHttpServer(executorServer);
    await rm(configRoot, { recursive: true, force: true });
  }
});

test("session close selects only inherited INARI_SESSION_ID through the production Admission server", async () => {
  const { root, environment } = await temporaryEnvironment();
  const local = localAuthority(environment);
  const selectedId = "sess_close-selected";
  const otherId = "sess_close-other";
  const selected = localSessionBinding(selectedId, 1029, "123456789", "acme/inari", {
    authority: local.authority,
    keyPair: local.keyPair,
  });
  const other = localSessionBinding(otherId, 1030, "123456789", "acme/inari", {
    authority: local.authority,
    keyPair: local.keyPair,
  });
  storeLocalSessionBinding(selected, environment);
  storeLocalSessionBinding(other, environment);
  const admissionServer = createLocalAdmissionHttpServer(
    {
      version: 1,
      id: "adm_0123456789abcdef",
      listen: { host: "127.0.0.1", port: 0 },
      executor: { id: "exec_0123456789abcdef", endpoint: "http://127.0.0.1:8765" },
    },
    "0.14.1-test",
    local.authority,
    {
      async verifyReady() {
        return { ok: true };
      },
      async readEvidence() {
        return localTrustEvidence(local.authority);
      },
      async execute() {
        throw new Error("session close must not execute Change mutations");
      },
    },
    { environment },
  );
  await once(admissionServer, "listening");
  const address = admissionServer.address() as AddressInfo;
  const admissionEndpoint = `http://127.0.0.1:${address.port}`;
  const calls: AdmissionTestRequest[] = [];
  const proxy = await startAdmissionTestServer(async (request) => {
    calls.push(request);
    const response = await fetch(`${admissionEndpoint}${request.path}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  });
  try {
    writeAdmissionRoute(environment, proxy.endpoint);
    const client = createLocalAdmissionClient({ endpoint: proxy.endpoint });
    await client.registerSession(selected);
    await client.registerSession(other);
    calls.length = 0;
    await unlink(localComponentPath("authority", "private-key.pem", environment));
    environment.INARI_SESSION_ID = selectedId;
    const result = await capture(["session", "close", "--json"], environment);
    assert.equal(result.exitCode, 0, result.stdout || result.stderr);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.path, `/v1/sessions/${selectedId}`);
    assert.deepEqual(calls[0]?.body, { version: 1, binding: selected });
    assert.notEqual((calls[0]?.body as { readonly binding: LocalSessionBinding }).binding.sessionId, otherId);
    const closedRecord = JSON.parse(
      await readFile(localComponentPath("admission", `sessions/${selectedId}.json`, environment), "utf8"),
    ) as { readonly state: string };
    const otherRecord = JSON.parse(
      await readFile(localComponentPath("admission", `sessions/${otherId}.json`, environment), "utf8"),
    ) as { readonly state: string };
    assert.equal(closedRecord.state, "closed");
    assert.equal(otherRecord.state, "active");
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));

    const noSelector = { INARI_CONFIG_HOME: environment.INARI_CONFIG_HOME };
    const missing = await capture(["session", "close", "--json"], noSelector);
    assert.notEqual(missing.exitCode, 0);
    assert.equal(JSON.parse(missing.stdout).error.code, "ADMISSION_SESSION_SELECTOR_REQUIRED");
    assert.equal(calls.length, 1);
  } finally {
    await proxy.close();
    await closeHttpServer(admissionServer);
    await rm(root, { recursive: true, force: true });
  }
});

async function setupConsoleAssets(root: string): Promise<string> {
  const directory = path.join(root, "setup-console-assets");
  await mkdir(directory, { recursive: true });
  for (const file of ["index.html", "setup-console.js", "styles.css"])
    await writeFile(path.join(directory, file), file);
  return directory;
}

const SETUP_REPOSITORY = ["--repository", "yohn-jp/gh-inari", "--repository-id", "1330755860"];

test("setup status and next use the shared Setup Application before any key, trust or Runtime exists", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const status = await capture(["setup", "status", "--json", ...SETUP_REPOSITORY], environment, {
      repositoryRoot: root,
    });
    assert.equal(status.exitCode, 0);
    const state = JSON.parse(status.stdout) as {
      readonly ok: boolean;
      readonly operation: string;
      readonly kind: string;
      readonly state: { readonly stage: string; readonly nextAction: { readonly kind: string } };
    };
    assert.equal(state.ok, true);
    assert.equal(state.operation, "setup.status");
    assert.equal(state.state.stage, "clean");
    assert.equal(state.state.nextAction.kind, "perform");

    const human = await capture(["setup", "status", "--detail", ...SETUP_REPOSITORY], environment, {
      repositoryRoot: root,
    });
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /^Setup: clean\nNext: Configure the Executor Issuer App/u);
    assert.match(human.stdout, /health observation: not-running/u);

    const missing = await capture(["setup", "next", "--json", ...SETUP_REPOSITORY], environment, {
      repositoryRoot: root,
    });
    assert.equal(missing.exitCode, 2);
    assert.equal(JSON.parse(missing.stdout).kind, "input-required");

    // The CLI hands only a file reference to the composition; the Executor owner rejects non-key bytes.
    const marker = "cli-enrollment-not-a-key";
    await writeFile(path.join(root, "issuer.pem"), marker);
    const rejected = await capture(
      [
        "setup",
        "next",
        "--json",
        "--yes",
        "--input",
        "app-id=123456",
        "--enrollment-file",
        "issuer-key=issuer.pem",
        ...SETUP_REPOSITORY,
      ],
      environment,
      { repositoryRoot: root },
    );
    assert.equal(rejected.exitCode, 3);
    const result = JSON.parse(rejected.stdout) as {
      readonly ok: boolean;
      readonly result: { readonly outcome: string; readonly diagnostics: readonly { readonly code: string }[] };
    };
    assert.equal(result.ok, false);
    assert.equal(result.result.outcome, "failed");
    assert.ok(result.result.diagnostics.some((item) => item.code === "SETUP_ENROLLMENT_REJECTED"));
    assert.equal(rejected.stdout.includes(marker), false);

    const unsupported = await capture(["setup", "status", "--yes", "--json", ...SETUP_REPOSITORY], environment, {
      repositoryRoot: root,
    });
    assert.equal(unsupported.exitCode, 1);
    assert.equal(JSON.parse(unsupported.stdout).error.code, "INVALID_OPTION");
    const malformed = await capture(["setup", "next", "--input", "no-separator", "--json"], environment, {
      repositoryRoot: root,
    });
    assert.equal(JSON.parse(malformed.stdout).error.code, "INVALID_OPTION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup console starts one owned host, reuses it on repeated start and agrees with the CLI", async () => {
  const { root, environment } = await temporaryEnvironment();
  const setupAssetDirectory = await setupConsoleAssets(root);
  let handle: { readonly origin: string; close(): Promise<void> } | undefined;
  try {
    const started = await capture(["setup", "console", "--json", ...SETUP_REPOSITORY], environment, {
      repositoryRoot: root,
      setupAssetDirectory,
      onSetupHostStarted: (value) => (handle = value),
    });
    assert.equal(started.exitCode, 0);
    const output = JSON.parse(started.stdout) as {
      readonly operation: string;
      readonly endpoint: string;
      readonly sshForward: string;
      readonly reused: boolean;
    };
    assert.equal(output.operation, "setup.console");
    assert.equal(output.reused, false);
    assert.ok(handle);
    assert.equal(output.endpoint, handle.origin);
    const port = new URL(output.endpoint).port;
    assert.equal(output.sshForward, `-L ${port}:127.0.0.1:${port}`);

    const repeated = await capture(["setup", "console", "--json", ...SETUP_REPOSITORY], environment, {
      repositoryRoot: root,
      setupAssetDirectory,
      onSetupHostStarted: () => assert.fail("a second host must not start"),
    });
    assert.equal(repeated.exitCode, 0);
    assert.equal(JSON.parse(repeated.stdout).reused, true);
    assert.equal(JSON.parse(repeated.stdout).endpoint, output.endpoint);

    // A fresh CLI process and the browser API observe the same persisted setup generation.
    const bootstrap = (await (
      await fetch(`${output.endpoint}/api/setup/bootstrap`, {
        method: "POST",
        headers: { origin: output.endpoint, "x-inari-setup-bootstrap": "1" },
      })
    ).json()) as { readonly bearer: string; readonly csrf: string };
    const browserState = (await (
      await fetch(`${output.endpoint}/api/setup/state`, {
        headers: { authorization: `Bearer ${bootstrap.bearer}`, "x-csrf-token": bootstrap.csrf },
      })
    ).json()) as { readonly generation: unknown; readonly stage: string };
    const cliState = JSON.parse(
      (await capture(["setup", "status", "--json", ...SETUP_REPOSITORY], environment, { repositoryRoot: root })).stdout,
    ).state as { readonly generation: unknown; readonly stage: string };
    assert.deepEqual(browserState.generation, cliState.generation);
    assert.equal(browserState.stage, cliState.stage);

    await handle.close();
    handle = undefined;
    await assert.rejects(
      lstat(path.join(environment.INARI_CONFIG_HOME as string, "runtime", "endpoints", "setup.json")),
    );
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("setup help derives every setup operation from command metadata", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const help = await capture(["setup", "--help"], environment);
    assert.equal(help.exitCode, 0);
    for (const line of [
      "setup [--repository <repository>]",
      "setup status [--repository <repository>] [--repository-id <id>] [--detail]",
      "setup next [--repository <repository>] [--repository-id <id>] [--yes]",
      "setup console [--repository <repository>] [--repository-id <id>]",
    ])
      assert.ok(help.stdout.includes(line), line);
    const leaf = await capture(["setup", "console", "--help"], environment);
    assert.match(leaf.stdout, /^Usage: inari setup console /u);
    const unknown = await capture(["setup", "start", "--json"], environment);
    assert.equal(JSON.parse(unknown.stdout).error.code, "UNKNOWN_COMMAND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
