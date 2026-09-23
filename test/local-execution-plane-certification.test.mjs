import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliEntry = path.join(projectRoot, "src/index.ts");
const tsx = path.join(projectRoot, "node_modules/.bin/tsx");
const issue = 1030;
const repository = "acme/inari";
const repositoryId = "469000001";
const branch = "feat/1030-local-certification";
const pullRequest = 10300;
const appId = "123";
const installationId = "456";
const accessToken = "gho_local_certification_access_token";
const refreshToken = "ghr_local_certification_refresh_token";

const providerPreload = String.raw`
import http from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const role = process.env.INARI_CERT_ROLE;
const requestLog = process.env.INARI_CERT_REQUEST_LOG;
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "request" && requestLog) {
    const request = args[0];
    appendFileSync(requestLog, JSON.stringify({ method: request.method, path: request.url }) + "\n");
  }
  return originalEmit.call(this, event, ...args);
};

if (role === "admission") {
  const NativeDate = Date;
  const now = () => { const value = readFileSync(process.env.INARI_CERT_CLOCK_FILE, "utf8"); return value === "live" ? NativeDate.now() : Number(value); };
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [now()] : args)); }
    static now() { return now(); }
  };
}

if (role === "executor") {
  const fixture = JSON.parse(readFileSync(process.env.INARI_CERT_PROVIDER_FIXTURE, "utf8"));
  const stateFile = process.env.INARI_CERT_PROVIDER_STATE;
  const providerLog = process.env.INARI_CERT_PROVIDER_LOG;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const saveState = (state) => writeFileSync(stateFile, JSON.stringify(state));
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") {
      return nativeFetch(input, init);
    }
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected external provider request");
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const route = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    appendFileSync(providerLog, JSON.stringify({ method, route, search: url.search }) + "\n");
    const prefix = "repos/acme/inari/";
    const permissions = { metadata: "read", contents: "write", issues: "write", pull_requests: "write" };
    const repository = { id: Number(fixture.repositoryId), full_name: "acme/inari", fork: false, default_branch: "main" };
    if (method === "GET" && route === "user/installations") {
      return respond({ installations: [{ id: fixture.installationId, app_id: fixture.appId, suspended_at: null, permissions }] });
    }
    if (method === "GET" && route === "user/installations/" + fixture.installationId + "/repositories") {
      return respond({ repositories: [{ ...repository, permissions }] });
    }
    if (method === "GET" && route === "repos/acme/inari") return respond(repository);
    if (method === "GET" && route === prefix + "git/ref/heads/main") {
      return respond({ ref: "refs/heads/main", object: { type: "commit", sha: fixture.policySha } });
    }
    if (method === "GET" && route.startsWith(prefix + "git/trees/") && url.search === "?recursive=1") {
      return respond({ sha: fixture.treeSha, truncated: false, tree: fixture.tree });
    }
    if (method === "GET" && route.startsWith(prefix + "git/blobs/")) {
      const sha = route.slice((prefix + "git/blobs/").length);
      const content = fixture.blobs[sha];
      return content === undefined ? respond({}, 404) : respond({ sha, encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    if (method === "GET" && route === prefix + "issues/" + fixture.issue) {
      return respond({ number: fixture.issue, title: "feat: local certification", state: "open", body: fixture.issueBody,
        html_url: "https://github.com/acme/inari/issues/" + fixture.issue, labels: [], assignees: [] });
    }
    if (method === "GET" && route === prefix + "issues/" + fixture.issue + "/dependencies/blocked_by") return respond([]);
    if (method === "GET" && route === prefix + "git/ref/heads/" + fixture.branch) {
      return readState().branchPresent
        ? respond({ ref: "refs/heads/" + fixture.branch, object: { type: "commit", sha: fixture.branchSha } })
        : respond({}, 404);
    }
    if (method === "GET" && route === prefix + "git/matching-refs/heads/") {
      return respond(readState().branchPresent
        ? [{ ref: "refs/heads/" + fixture.branch, object: { type: "commit", sha: fixture.branchSha } }]
        : []);
    }
    if (method === "GET" && route === prefix + "pulls") {
      const state = readState();
      return respond([{ number: fixture.pullRequest, head: { ref: fixture.branch, repo: { full_name: "acme/inari" } },
        base: { ref: "main" }, user: { login: "inari-issuer[bot]" }, state: state.pullRequestState,
        draft: true, merged_at: null }]);
    }
    if (method === "GET" && route === prefix + "pulls/" + fixture.pullRequest) {
      return respond({ number: fixture.pullRequest, title: "feat: local certification", body: "Local certification PR",
        html_url: "https://github.com/acme/inari/pull/" + fixture.pullRequest,
        state: readState().pullRequestState, user: { login: "inari-issuer[bot]" },
        head: { ref: fixture.branch }, base: { ref: "main" }, draft: true, merged: false });
    }
    if (method === "GET" && [
      prefix + "issues/" + fixture.pullRequest + "/comments",
      prefix + "pulls/" + fixture.pullRequest + "/comments",
      prefix + "pulls/" + fixture.pullRequest + "/reviews",
      prefix + "pulls/" + fixture.pullRequest + "/files",
    ].includes(route)) return respond([]);
    if (method === "PATCH" && route === prefix + "pulls/" + fixture.pullRequest) {
      const state = readState();
      state.pullRequestState = "closed";
      saveState(state);
      return respond({ number: fixture.pullRequest, state: "closed" });
    }
    if (method === "DELETE" && route === prefix + "git/refs/heads/" + fixture.branch) {
      const state = readState();
      state.branchPresent = false;
      saveState(state);
      return new Response(null, { status: 204 });
    }
    return respond({ message: "Unmatched deterministic provider fixture" }, 404);
  };
}
`;

function command(args, { cwd, env, timeout = 20_000 } = {}) {
  const result = spawnSync(tsx, [cliEntry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function successful(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
  return result;
}

function jsonOutput(result, label) {
  successful(result, label);
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines.at(-1));
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function updateJson(file, update) {
  const value = JSON.parse(await readFile(file, "utf8"));
  update(value);
  await writeFile(file, `${JSON.stringify(value)}\n`);
  return value;
}

async function startServer(group, cwd, env) {
  const child = spawn(tsx, [cliEntry, group, "serve", "--json"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const announcement = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${group} serve timed out: ${stdout}\n${stderr}`)), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("{"));
      if (line === undefined) return;
      try {
        const value = JSON.parse(line);
        clearTimeout(timer);
        resolve(value);
      } catch {
        /* wait for a complete line */
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${group} serve exited ${code}: ${stdout}\n${stderr}`));
    });
  });
  assert.equal(announcement.operation, `${group}.serve`);
  return { child, announcement, stderr: () => stderr };
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  let timeout;
  try {
    await Promise.race([
      once(server.child, "exit"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Server did not stop")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function events(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function executionCount(file) {
  return (await events(file)).filter((event) => event.method === "POST" && event.path === "/v1/executions").length;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

function blobSha(content) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

async function createIssueFixture(directory) {
  const builder = path.join(directory, "issue-fixture.mts");
  const source = {
    version: 1,
    kind: "issue",
    id: "feature",
    name: "Feature",
    description: "A local execution certification fixture.",
    sections: [
      { id: "problem", kind: "input", type: "string", label: "Problem", required: true, element: "textarea" },
      { id: "capability", kind: "input", type: "string", label: "Capability", required: true, element: "textarea" },
    ],
  };
  await writeFile(
    builder,
    `
import { parseSemanticTemplate, renderSemanticNative } from ${JSON.stringify(path.join(projectRoot, "src/semantic-template.ts"))};
import { IMPLEMENTATION_CONTRACT_VERSION, IMPLEMENTATION_KIND, renderImplementationIssueBody } from ${JSON.stringify(path.join(projectRoot, "src/implementation-contract.ts"))};
const source = ${JSON.stringify(source)};
const parsed = parseSemanticTemplate(JSON.stringify(source), ".github/inari/issues/feature.json");
const native = renderSemanticNative(parsed, ".github/ISSUE_TEMPLATE/feature.yml");
const body = renderImplementationIssueBody({
  version: IMPLEMENTATION_CONTRACT_VERSION, kind: IMPLEMENTATION_KIND,
  repository: { repositoryHost: "github.com", repositoryId: ${JSON.stringify(repositoryId)}, repository: ${JSON.stringify(repository)} },
  sources: [{ repositoryHost: "github.com", repositoryId: ${JSON.stringify(repositoryId)}, repository: ${JSON.stringify(repository)}, number: ${issue} }],
  objective: "Certify the local process route.", nonGoals: ["Live provider calls."],
  architecture: { decision: "Use existing local boundaries.", affectedComponents: ["Admission", "Executor"], invariants: ["Current evidence is required."], compatibilityConstraints: [] },
  scope: { readOnly: ["src/**"], write: ["src/**"], create: ["src/**"], delete: [], deny: [] },
  constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
  verification: { acceptanceCriteria: ["Local process route works."], targetedTests: [], requiredChecks: [], postconditions: [] },
  execution: { baseBranch: "main", baseRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", baseFreshness: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: ${JSON.stringify(branch)}, dependencies: [] },
});
console.log(JSON.stringify({ source: JSON.stringify(source), native, body }));
`,
  );
  return jsonOutput(
    spawnSync(tsx, [builder], { cwd: projectRoot, env: process.env, encoding: "utf8" }),
    "build canonical Issue fixture",
  );
}

function intent(operation = "change.show", selectedIssue = issue, selectedRepositoryId = repositoryId) {
  return {
    version: 1,
    requestId: `cert-${operation}-${selectedIssue}-${selectedRepositoryId}`,
    repository: {
      repositoryHost: "github.com",
      repositoryId: selectedRepositoryId,
      repositoryNameWithOwner: selectedRepositoryId === repositoryId ? repository : "other/repository",
    },
    operation,
    request: { version: 1, operation: operation.slice("change.".length), issue: selectedIssue },
  };
}

async function postIntent(endpoint, value, sessionId) {
  return fetch(`${endpoint}/v1/executions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { "x-inari-session-id": sessionId }),
    },
    body: JSON.stringify(value),
  });
}

test("#1030 certifies the real local CLI, Admission, and Executor processes", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inari-local-cert-"));
  const configHome = path.join(directory, "config");
  const workspace = path.join(directory, "workspace");
  const providerCustody = path.join(directory, "provider");
  const credentialFile = path.join(providerCustody, "app-user.json");
  const preloadFile = path.join(directory, "provider-preload.mjs");
  const fixtureFile = path.join(directory, "provider-fixture.json");
  const stateFile = path.join(directory, "provider-state.json");
  const providerLog = path.join(directory, "provider-requests.jsonl");
  const executorLog = path.join(directory, "executor-requests.jsonl");
  const admissionLog = path.join(directory, "admission-requests.jsonl");
  const clockFile = path.join(directory, "clock.txt");
  const servers = [];
  try {
    await Promise.all([mkdir(configHome), mkdir(workspace), mkdir(providerCustody)]);
    git(workspace, "init", "-q");
    git(workspace, "remote", "add", "origin", "https://github.com/acme/inari.git");
    git(workspace, "checkout", "-q", "-b", branch);
    await writeFile(preloadFile, providerPreload);
    await writeFile(fixtureFile, "{}");
    await writeFile(clockFile, "live");
    await writeFile(
      credentialFile,
      JSON.stringify({
        version: 1,
        access_token: accessToken,
        refresh_token: refreshToken,
        access_token_expires_at: "2099-01-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    await chmod(credentialFile, 0o600);

    const baseEnv = { ...process.env, INARI_CONFIG_HOME: configHome };
    delete baseEnv.GH_TOKEN;
    delete baseEnv.GITHUB_TOKEN;
    delete baseEnv.INARI_GITHUB_APP_USER_CREDENTIAL_FILE;
    delete baseEnv.INARI_APP_USER_CREDENTIAL_FILE;
    delete baseEnv.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY;
    const executorEnv = {
      ...baseEnv,
      INARI_GITHUB_APP_ID: appId,
      INARI_GITHUB_APP_USER_CREDENTIAL_FILE: credentialFile,
      INARI_CERT_ROLE: "executor",
      INARI_CERT_REQUEST_LOG: executorLog,
      INARI_CERT_PROVIDER_FIXTURE: fixtureFile,
      INARI_CERT_PROVIDER_STATE: stateFile,
      INARI_CERT_PROVIDER_LOG: providerLog,
      NODE_OPTIONS: `--import=${preloadFile}`,
    };
    const admissionEnv = {
      ...baseEnv,
      INARI_CERT_ROLE: "admission",
      INARI_CERT_REQUEST_LOG: admissionLog,
      INARI_CERT_CLOCK_FILE: clockFile,
      NODE_OPTIONS: `--import=${preloadFile}`,
    };

    jsonOutput(command(["init", "--json"], { cwd: workspace, env: baseEnv }), "init");
    const authority = jsonOutput(
      command(["authority", "setup", "--json"], { cwd: workspace, env: baseEnv }),
      "authority setup",
    );
    const publicAuthorityFile = path.join(directory, "runtime-authority.json");
    const bootstrap = jsonOutput(
      command(
        [
          "authority",
          "bootstrap",
          "--authority-id",
          "local-certification",
          "--private-key",
          authority.privateKeyPath,
          "--max-session-ttl-seconds",
          "3600",
          "--capability",
          "change.implement",
          "--capability",
          "change.abort",
          "--output",
          publicAuthorityFile,
          "--json",
        ],
        { cwd: workspace, env: baseEnv },
      ),
      "authority bootstrap",
    );
    const executorSetup = jsonOutput(
      command(["executor", "setup", "--json"], { cwd: workspace, env: executorEnv }),
      "executor setup",
    );
    const executorPort = await freePort();
    await updateJson(executorSetup.configPath, (config) => {
      config.listen.port = executorPort;
    });
    const admissionSetup = jsonOutput(
      command(["admission", "setup", "--from", publicAuthorityFile, "--json"], {
        cwd: workspace,
        env: baseEnv,
      }),
      "admission setup",
    );
    const admissionPort = await freePort();
    await updateJson(admissionSetup.configPath, (config) => {
      config.listen.port = admissionPort;
    });
    await updateJson(path.join(configHome, "cli/config.json"), (config) => {
      config.admission.endpoint = `http://127.0.0.1:${admissionPort}`;
    });

    const issueFixture = await createIssueFixture(directory);
    const blobs = {};
    const tree = [];
    for (const [name, content] of [
      [bootstrap.artifactPath, await readFile(publicAuthorityFile, "utf8")],
      [".github/inari/issues/feature.json", issueFixture.source],
      [".github/ISSUE_TEMPLATE/feature.yml", issueFixture.native],
    ]) {
      const sha = blobSha(content);
      blobs[sha] = content;
      tree.push({ path: name, type: "blob", sha });
    }
    await writeFile(
      fixtureFile,
      JSON.stringify({
        repositoryId,
        appId,
        installationId,
        issue,
        branch,
        pullRequest,
        policySha: "a".repeat(40),
        treeSha: "b".repeat(40),
        branchSha: "c".repeat(40),
        issueBody: issueFixture.body,
        tree,
        blobs,
      }),
    );
    await writeFile(stateFile, JSON.stringify({ branchPresent: true, pullRequestState: "open" }));

    const executor = await startServer("executor", workspace, executorEnv);
    servers.push(executor);
    const executorConfig = JSON.parse(await readFile(executorSetup.configPath, "utf8"));
    const executorEndpoint = `http://${executorConfig.listen.host}:${executorConfig.listen.port}`;
    const executorHealth = await fetch(`${executorEndpoint}/health`);
    assert.equal(executorHealth.status, 200);
    assert.equal((await executorHealth.json()).executorId, executorSetup.executorId);

    const admissionConfig = JSON.parse(await readFile(admissionSetup.configPath, "utf8"));
    assert.equal(admissionConfig.executor.id, executorSetup.executorId);
    assert.equal(admissionConfig.executor.endpoint, executorEndpoint);
    const wrongId = `${executorSetup.executorId.slice(0, -1)}${executorSetup.executorId.endsWith("A") ? "B" : "A"}`;
    await updateJson(admissionSetup.configPath, (config) => {
      config.executor.id = wrongId;
    });
    const wrongAdmission = command(["admission", "serve", "--json"], {
      cwd: workspace,
      env: admissionEnv,
      timeout: 8_000,
    });
    assert.equal(wrongAdmission.error, undefined, `Wrong Executor identity check timed out: ${wrongAdmission.stderr}`);
    assert.notEqual(wrongAdmission.status, 0, "Admission started with a wrong Executor identity");
    await updateJson(admissionSetup.configPath, (config) => {
      config.executor.id = executorSetup.executorId;
    });

    const admission = await startServer("admission", workspace, admissionEnv);
    servers.push(admission);
    const admissionEndpoint = admission.announcement.endpoint;
    const admissionHealth = await fetch(`${admissionEndpoint}/health`);
    assert.equal(admissionHealth.status, 200);
    assert.equal((await admissionHealth.json()).admissionId, admissionSetup.admissionId);

    const rawIntent = intent();
    const providerCallsBeforeRaw = (await events(providerLog)).length;
    const rawResponse = await postIntent(executorEndpoint, rawIntent, "cert-session");
    assert.ok(rawResponse.status >= 400 && rawResponse.status < 500, "Executor accepted raw ExecutionIntent");
    assert.equal((await events(providerLog)).length, providerCallsBeforeRaw);

    const sessionId = "cert-session";
    const agentEnv = {
      ...baseEnv,
      INARI_SESSION_ID: sessionId,
      GH_TOKEN: "fixture-gh-token",
      GITHUB_TOKEN: "fixture-github-token",
      INARI_GITHUB_APP_USER_CREDENTIAL_FILE: credentialFile,
      INARI_RUNTIME_AUTHORITY_PRIVATE_KEY: authority.privateKeyPath,
    };
    const childResult = command(
      [
        "session",
        "start",
        "--issue",
        String(issue),
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(process.env) + '\\n')",
      ],
      { cwd: workspace, env: agentEnv },
    );
    assert.equal(
      childResult.status,
      0,
      `session start: ${childResult.stdout}\n${childResult.stderr}\nProvider: ${JSON.stringify(await events(providerLog))}\nExecutor: ${JSON.stringify(await events(executorLog))}\nAdmission: ${JSON.stringify(await events(admissionLog))}\nExecutor stderr: ${executor.stderr()}\nAdmission stderr: ${admission.stderr()}`,
    );
    const child = childResult;
    const childEnvironment = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(childEnvironment.INARI_SESSION_ID, sessionId);
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "INARI_GITHUB_APP_USER_CREDENTIAL_FILE",
      "INARI_APP_USER_CREDENTIAL_FILE",
      "INARI_RUNTIME_AUTHORITY_PRIVATE_KEY",
    ])
      assert.equal(Object.hasOwn(childEnvironment, name), false, `${name} reached the Agent child`);
    const childValues = JSON.stringify(childEnvironment);
    const privateKey = await readFile(authority.privateKeyPath, "utf8");
    for (const secret of [accessToken, refreshToken, privateKey]) assert.equal(childValues.includes(secret), false);

    const sessionEnv = { ...baseEnv, INARI_SESSION_ID: sessionId };
    const readsBefore = await executionCount(executorLog);
    const showResult = command(["change", "show", String(issue), "--json"], { cwd: workspace, env: sessionEnv });
    assert.equal(
      showResult.status,
      0,
      `change show: ${showResult.stdout}\n${showResult.stderr}\nProvider: ${JSON.stringify(await events(providerLog))}\nExecutor: ${JSON.stringify(await events(executorLog))}\nAdmission: ${JSON.stringify(await events(admissionLog))}\nExecutor stderr: ${executor.stderr()}\nAdmission stderr: ${admission.stderr()}`,
    );
    assert.ok((await executionCount(executorLog)) > readsBefore, "Change read did not cross Executor HTTP");
    const mutationsBefore = await executionCount(executorLog);
    successful(
      command(["change", "abort", String(issue), "--json"], { cwd: workspace, env: sessionEnv }),
      "change abort",
    );
    assert.ok((await executionCount(executorLog)) > mutationsBefore, "Change mutation did not cross Executor HTTP");
    const providerCalls = await events(providerLog);
    assert.ok(
      providerCalls.some((call) => call.method === "PATCH" && call.route === `repos/acme/inari/pulls/${pullRequest}`),
    );

    async function denied(value, selector, label) {
      const executorBefore = await executionCount(executorLog);
      const admissionBefore = await executionCount(admissionLog);
      const response = await postIntent(admissionEndpoint, value, selector);
      assert.ok(response.status >= 400 && response.status < 500, `${label}: ${response.status}`);
      assert.ok((await executionCount(admissionLog)) > admissionBefore, `${label} did not reach Admission`);
      assert.equal(await executionCount(executorLog), executorBefore, `${label} invoked Executor`);
    }
    await denied(intent("change.show", issue, "469000002"), sessionId, "repository denial");
    await denied(intent("change.show", issue + 1), sessionId, "task denial");
    await denied(intent("change.ready"), sessionId, "capability denial");
    await denied(intent(), undefined, "missing Session denial");

    jsonOutput(command(["session", "close", "--json"], { cwd: workspace, env: sessionEnv }), "session close");
    await denied(intent(), sessionId, "closed Session denial");

    const expiringId = "cert-expiring-session";
    successful(
      command(["session", "start", "--issue", String(issue), "--", process.execPath, "-e", "process.exit(0)"], {
        cwd: workspace,
        env: { ...baseEnv, INARI_SESSION_ID: expiringId },
      }),
      "expiring session start",
    );
    await writeFile(clockFile, String(Date.now() + 3_700_000));
    await denied(intent(), expiringId, "expired Session denial");
  } finally {
    for (const server of servers.reverse()) await stopServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});
