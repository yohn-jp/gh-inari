import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli-core.js";
import { getCommandForPositionals } from "./command-contract.js";
import { createDelegatorRecord } from "./agent-authority/delegator-operations.js";
import {
  delegatorPublicKeyFingerprint,
  generateDelegatorKeyPair,
  loadDelegatorKeyPair,
} from "./agent-authority/delegator-key.js";
import { validateDelegator, type Delegator } from "./agent-authority/delegator.js";
import { createLocalSessionBinding, type LocalSessionBinding } from "./local-control/session-binding.js";
import { setupLocalAuthority } from "./local-control/identity.js";
import {
  localComponentPath,
  validateLocalCliConfig,
  validateLocalAuthorityConfig,
  validateLocalExecutorConfig,
  writeLocalJson,
} from "./local-control/config.js";
import { storeLocalSessionBinding } from "./local-control/session-launcher.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "./change.js";
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

test("executor setup and serve use the Executor command contract and existing credential custody", async () => {
  assert.equal(getCommandForPositionals(["executor", "setup"])?.id, "executor.setup");
  assert.equal(getCommandForPositionals(["executor", "serve"])?.id, "executor.serve");

  const { root, environment } = await temporaryEnvironment();
  environment.INARI_GITHUB_APP_ID = "123456";
  try {
    const missingSetup = await capture(["executor", "serve", "--json"], environment);
    assert.equal(missingSetup.exitCode, 2);
    assert.equal(JSON.parse(missingSetup.stdout).error.code, "EXECUTOR_NOT_SETUP");

    const store = new FileAppUserCredentialStore({
      path: path.join(environment.INARI_CONFIG_HOME as string, "app-user-credential.json"),
    });
    await store.save(
      createAppUserCredential({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        accessTokenExpiresAt: "2027-01-01T00:00:00.000Z",
        refreshTokenExpiresAt: "2027-06-01T00:00:00.000Z",
      }),
    );
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
    assert.equal(output.configPath, path.join(environment.INARI_CONFIG_HOME as string, "executor", "config.json"));
    assert.equal(output.provider.credentialProfile, "default");
    assert.equal(setup.stdout.includes("access-secret"), false);
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
    assert.equal(first.stdout.includes("private"), false);

    const second = await capture(["admission", "setup", "--from", authorityPath, "--json"], environment);
    assert.equal(JSON.parse(second.stdout).admissionId, firstOutput.admissionId);
    assert.deepEqual(JSON.parse(await readFile(firstOutput.configPath, "utf8")).executor, {
      id: firstOutput.executorId,
      endpoint: "http://127.0.0.1:8765",
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
  handler: (request: AdmissionTestRequest) => { readonly status: number; readonly body: unknown },
): Promise<{ readonly endpoint: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      const result = handler({
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

function writeAdmissionRoute(environment: NodeJS.ProcessEnv, endpoint: string): void {
  writeLocalJson(
    "cli",
    "config.json",
    {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: { id: "adm_0123456789abcdef", endpoint },
    },
    validateLocalCliConfig,
    environment,
  );
}

function authorityValidator(value: unknown): Delegator {
  const validation = validateDelegator(value);
  if (!validation.valid || validation.value === undefined) throw new Error("invalid test Authority");
  return validation.value;
}

function localAuthority(environment: NodeJS.ProcessEnv): Delegator {
  setupLocalAuthority(environment);
  const keyPair = loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment));
  const authority = createDelegatorRecord({
    id: "cli-local-admission-test",
    key: keyPair,
    notBefore: new Date("2026-01-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort", "change.merge"],
  });
  writeLocalJson("admission", "runtime-authority.json", authority, authorityValidator, environment);
  return authority;
}

function localSessionBinding(
  sessionId: string,
  issue: number,
  repositoryId: string,
  repositoryName: string,
): LocalSessionBinding {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "cli-local-binding-test",
    key: keyPair,
    notBefore: new Date("2026-01-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort", "change.merge"],
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
    ],
    ttlSeconds: 300,
    runtimeAuthority: authority,
    runtimeKey: keyPair,
  });
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
  execFileSync("git", ["config", "user.name", "Inari Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "inari-test@example.invalid"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/inari.git"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "baseline\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
  const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(path.join(root, "README.md"), "local admission change\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "local admission change"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { baseHead, head };
}

test("session start issues through Authority and Admission, then returns the exact child exit code", async () => {
  const { root, environment } = await temporaryEnvironment();
  const calls: AdmissionTestRequest[] = [];
  const server = await startAdmissionTestServer((request) => {
    calls.push(request);
    const body = request.body as { readonly binding?: LocalSessionBinding };
    return {
      status: 201,
      body: { ok: true, session: { id: body.binding?.sessionId, status: "active", exp: body.binding?.exp } },
    };
  });
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
    assert.equal(calls.length, 0);
    localAuthority(environment);
    writeAdmissionRoute(environment, server.endpoint);
    environment.PARENT_ONLY = "unchanged";
    let identityReads = 0;
    const result = await runCli(
      ["session", "start", "--issue", "1029", "--", process.execPath, "-e", "process.exit(13)"],
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
    assert.equal(identityReads, 1);
    assert.equal(environment.INARI_SESSION_ID, undefined);
    assert.equal(environment.PARENT_ONLY, "unchanged");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.path, "/v1/sessions");
    assert.equal((calls[0]?.body as { readonly binding?: LocalSessionBinding }).binding?.task.number, 1029);
    assert.equal(
      await lstat(path.join(environment.INARI_CONFIG_HOME as string, "cli", "sessions", "current.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("all six normal Change operations route closed intents only to configured Admission", async () => {
  const { root: configRoot, environment } = await temporaryEnvironment();
  const repositoryRoot = path.join(configRoot, "repository");
  await mkdir(repositoryRoot);
  const { baseHead, head } = await gitRepository(repositoryRoot);
  const sessionId = "sess_cli-route-1029";
  const issue = 1029;
  const branch = "feat/1029-local-cli-admission-path";
  const received: AdmissionTestRequest[] = [];
  let currentHead = baseHead;
  let rejectAdmission = false;
  const server = await startAdmissionTestServer((request) => {
    received.push(request);
    if (rejectAdmission && request.path === "/v1/executions") {
      return { status: 503, body: { ok: false, error: { code: "UNAVAILABLE" } } };
    }
    if (request.method === "POST" && request.path === "/v1/executions") {
      const intent = request.body as {
        readonly operation: string;
        readonly request: Record<string, unknown>;
      };
      if (intent.operation === "change.show") {
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              version: 1,
              operation: "change.show",
              status: "succeeded",
              projection: localChangeProjection(issue, "123456789", branch, currentHead),
            },
          },
        };
      }
      if (intent.operation === "branch.advance") {
        currentHead = head;
        return {
          status: 200,
          body: {
            ok: true,
            result: {
              version: 1,
              operation: "branch.advance",
              status: "succeeded",
              branchAdvance: {
                version: 1,
                operation: "branch.advance",
                status: "succeeded",
                outcome: "advanced",
                branch,
                expectedHead: baseHead,
                resultingHead: head,
              },
            },
          },
        };
      }
      const projection = localChangeProjection(issue, "123456789", branch, currentHead);
      return {
        status: 200,
        body: {
          ok: true,
          result: {
            version: 1,
            operation: intent.operation,
            status: "succeeded",
            projection,
            execution: { projection },
          },
        },
      };
    }
    return { status: 404, body: { ok: false } };
  });
  try {
    writeAdmissionRoute(environment, server.endpoint);
    environment.INARI_SESSION_ID = sessionId;
    environment.GH_TOKEN = "must-not-be-read";
    storeLocalSessionBinding(localSessionBinding(sessionId, issue, "123456789", "acme/inari"), environment);
    let providerAdapterUsed = false;
    let nonAdmissionExecutorUsed = false;
    const dependencies = {
      repositoryRoot,
      environment,
      createAdapter: (() => {
        providerAdapterUsed = true;
        throw new Error("local Admission route must not construct GitHubAdapter");
      }) as never,
      createChangeExecutor: (() => {
        nonAdmissionExecutorUsed = true;
        throw new Error("local Admission route must not construct another executor");
      }) as never,
    };
    const commands = [
      ["change", "issue", String(issue), "--json"],
      ["change", "show", String(issue), "--json"],
      ["change", "ready", String(issue), "--json"],
      ["change", "abort", String(issue), "--json"],
      ["change", "merge", String(issue), "--strategy", "squash", "--json"],
      ["change", "publish", String(issue), "--commit", "HEAD", "--json"],
    ];
    for (const command of commands) {
      const result = await capture(command, environment, dependencies);
      assert.equal(result.exitCode, 0, result.stdout || result.stderr);
    }
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
    assert.equal("signedProvenanceRecord" in issueIntent, false);
    assert.equal("implementationConformance" in issueIntent, false);
    assert.equal("semanticPullRequestPlan" in issueIntent, false);
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));
    assert.equal(
      received.every((request) => request.path.startsWith("/v1/executions")),
      true,
    );
  } finally {
    await server.close();
    await rm(configRoot, { recursive: true, force: true });
  }
});

test("session close selects only inherited INARI_SESSION_ID through Admission without Authority or Executor config", async () => {
  const { root, environment } = await temporaryEnvironment();
  const selectedId = "sess_close-selected";
  const otherId = "sess_close-other";
  const selected = localSessionBinding(selectedId, 1029, "123456789", "acme/inari");
  const other = localSessionBinding(otherId, 1030, "123456789", "acme/inari");
  storeLocalSessionBinding(selected, environment);
  storeLocalSessionBinding(other, environment);
  const calls: AdmissionTestRequest[] = [];
  const server = await startAdmissionTestServer((request) => {
    calls.push(request);
    return { status: 200, body: { ok: true, session: { id: selectedId, status: "closed" } } };
  });
  try {
    writeAdmissionRoute(environment, server.endpoint);
    environment.INARI_SESSION_ID = selectedId;
    const result = await capture(["session", "close", "--json"], environment);
    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.path, `/v1/sessions/${selectedId}`);
    assert.deepEqual(calls[0]?.body, { version: 1, binding: selected });
    assert.notEqual((calls[0]?.body as { readonly binding: LocalSessionBinding }).binding.sessionId, otherId);
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "authority")));
    await assert.rejects(lstat(path.join(environment.INARI_CONFIG_HOME as string, "executor")));

    const noSelector = { INARI_CONFIG_HOME: environment.INARI_CONFIG_HOME };
    const missing = await capture(["session", "close", "--json"], noSelector);
    assert.notEqual(missing.exitCode, 0);
    assert.equal(JSON.parse(missing.stdout).error.code, "ADMISSION_SESSION_SELECTOR_REQUIRED");
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
