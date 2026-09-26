// #1184: the 0.17.0 Local Runtime Golden Path, certified as ONE continuous run
// of the same packed artifact over the same persisted state:
//
//   clean setup -> fresh shell -> Runtime -> canonical Implementation/branch
//   -> Session -> governed operation -> publication of an initially absent PR
//
// Nothing is pre-generated: no ready profile, remote trust, Session or pull
// request exists before the packed CLI creates it. The only outside inputs are
// the operator's Issuer App key file (enrolled once into Executor custody), the
// Device Flow approval, and the explicit human merge of the trust PR. After
// setup the fresh shell carries only INARI_CONFIG_HOME: no Issuer App ID, key
// reference or user credential is re-injected. The provider is a deterministic
// GitHub stand-in (test/fixtures/setup/golden-path-provider.mjs) that replaces
// only the external API boundary.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installPackedCli } from "./fixtures/setup/packed-cli.mjs";

const checkout = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const preload = fileURLToPath(new URL("./fixtures/setup/golden-path-provider.mjs", import.meta.url));
const REPOSITORY = "gp-owner/golden-project";
const REPOSITORY_ID = "61840000";
const ENDPOINT = "https://endpoint.golden-path.test";
const APP_ID = "5151";
const INSTALLATION_ID = "88";
const SOURCE_ISSUE = 41;
const IMPLEMENTATION = 42;
const DEFAULT_BRANCH = "trunk";
const BRANCH = "work/golden-path-42";
const BRANCH_PATTERN = "^work/[a-z-]+-[0-9]+$";

const sha1 = (value) => createHash("sha1").update(value).digest("hex");
const gitBlobSha = (bytes) => sha1(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Repository content of the default branch: this checkout's governance, minus any trust record. */
function governedFiles() {
  const files = new Map();
  const walk = (relative) => {
    const absolute = path.join(checkout, relative);
    for (const name of readdirSync(absolute)) {
      const child = path.posix.join(relative, name);
      if (child === ".github/inari/authorities") continue;
      if (statSync(path.join(checkout, child)).isDirectory()) walk(child);
      else files.set(child, readFileSync(path.join(checkout, child)));
    }
  };
  walk(".github/inari");
  walk(".github/ISSUE_TEMPLATE");
  walk(".github/PULL_REQUEST_TEMPLATE");
  files.delete(".github/inari/manifest.json");
  const policy = readFileSync(path.join(checkout, ".github/inari/pr-policy.yml"), "utf8");
  files.set(
    ".github/inari/pr-policy.yml",
    Buffer.from(`${policy.trimEnd()}\nbranch:\n  pattern: ${JSON.stringify(BRANCH_PATTERN)}\n`),
  );
  files.set("README.md", Buffer.from("# golden-project\n"));
  return files;
}

function initialProviderState(issuerPublicKey) {
  const blobs = {};
  const entries = [];
  for (const [file, bytes] of [...governedFiles()].sort(([left], [right]) => left.localeCompare(right))) {
    const sha = gitBlobSha(bytes);
    blobs[sha] = bytes.toString("base64");
    entries.push({ path: file, mode: "100644", type: "blob", sha });
  }
  const tree = sha1(`tree\0${JSON.stringify(entries)}`);
  const commit = sha1(`commit\0${tree}`);
  return {
    endpoint: ENDPOINT,
    appId: APP_ID,
    clientId: "Iv1.golden-path",
    installationId: INSTALLATION_ID,
    issuerPublicKey,
    repository: { id: REPOSITORY_ID, name: REPOSITORY, nodeId: "R_golden_path" },
    defaultBranch: DEFAULT_BRANCH,
    refs: { [DEFAULT_BRANCH]: commit },
    commits: { [commit]: { tree, parents: [], message: "Initial governed repository" } },
    trees: { [tree]: entries },
    blobs,
    issues: {
      [SOURCE_ISSUE]: {
        title: "Golden Path source capability",
        body: "## Summary\n\nA source Issue.\n",
        state: "open",
      },
    },
    pulls: [],
    nextPull: 100,
  };
}

async function implementationBody(baseRevision) {
  const { parseImplementationContract, renderImplementationIssueBody } =
    await import("../src/implementation-contract.ts");
  const repository = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, repository: REPOSITORY };
  return renderImplementationIssueBody(
    parseImplementationContract({
      version: 1,
      kind: "implementation",
      repository,
      sources: [{ ...repository, number: SOURCE_ISSUE }],
      objective: "Deliver the Golden Path change.",
      nonGoals: ["Review approval"],
      architecture: {
        decision: "Use the local Runtime.",
        affectedComponents: ["docs"],
        invariants: ["Governed execution only."],
        compatibilityConstraints: [],
      },
      scope: { readOnly: ["**"], write: ["docs/**"], create: ["docs/**"], delete: [], deny: [] },
      constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
      verification: {
        acceptanceCriteria: ["The PR exists."],
        targetedTests: [],
        requiredChecks: [],
        postconditions: [],
      },
      execution: {
        baseBranch: DEFAULT_BRANCH,
        baseRevision,
        baseFreshness: baseRevision,
        branch: BRANCH,
        dependencies: [],
      },
    }),
  );
}

/** The operator's `git push` of the contract branch: a provider-side commit on the current default branch. */
async function operatorPush(readState, writeState, branch, file, bytes) {
  const state = await readState();
  const parent = state.refs[state.defaultBranch];
  const entries = state.trees[state.commits[parent].tree].filter((entry) => entry.path !== file);
  const sha = gitBlobSha(bytes);
  state.blobs[sha] = bytes.toString("base64");
  entries.push({ path: file, mode: "100644", type: "blob", sha });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const tree = sha1(`tree\0${JSON.stringify(entries)}`);
  const commit = sha1(`commit\0${tree}\0${parent}`);
  state.trees[tree] = entries;
  state.commits[commit] = { tree, parents: [parent], message: "docs: golden path" };
  state.refs[branch] = commit;
  await writeState(state);
}

function runPacked(entry, args, options) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    ...options,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function lastJson(result) {
  const line = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  return line === undefined ? undefined : JSON.parse(line);
}

function ok(result, label) {
  assert.equal(result.status, 0, `${label} exited ${result.status}: ${result.stdout}\n${result.stderr}`);
  return lastJson(result);
}

const dimension = (state, name) => state.dimensions.find((item) => item.dimension === name);
const nextKind = (state) => state.actions.find((action) => action.id === state.nextAction.actionId)?.kind;

async function certifyGoldenPath(scenario) {
  {
    const packed = await installPackedCli();
    const root = await mkdtemp(path.join(path.dirname(checkout), "inari-golden-path-"));
    const configHome = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    const operatorFiles = path.join(root, "operator");
    const providerState = path.join(root, "provider-state.json");
    const providerLog = path.join(root, "provider-log.jsonl");
    const processes = [];
    const readState = async () => JSON.parse(await readFile(providerState, "utf8"));
    const writeState = async (value) => writeFile(providerState, JSON.stringify(value));
    // The only environment any process gets: config home + provider stand-in.
    const shell = () => {
      const environment = {
        PATH: process.env.PATH,
        HOME: root,
        INARI_CONFIG_HOME: configHome,
        INARI_GP_PROVIDER_STATE: providerState,
        INARI_GP_PROVIDER_LOG: providerLog,
        NODE_OPTIONS: `--import=${preload}`,
        NO_COLOR: "1",
        GIT_AUTHOR_NAME: "Golden Path",
        GIT_AUTHOR_EMAIL: "golden-path@example.test",
        GIT_COMMITTER_NAME: "Golden Path",
        GIT_COMMITTER_EMAIL: "golden-path@example.test",
      };
      return environment;
    };
    const setupShell = shell();
    Object.assign(setupShell, {});
    const cli = (args, environment = setupShell) => runPacked(packed.entry, args, { cwd: workspace, env: environment });
    const setupArgs = ["--json", "--repository", REPOSITORY, "--repository-id", REPOSITORY_ID];
    try {
      await Promise.all([mkdir(configHome), mkdir(workspace), mkdir(operatorFiles)]);
      const issuer = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const issuerKeyFile = path.join(operatorFiles, "issuer-app.private-key.pem");
      await writeFile(issuerKeyFile, issuer.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      await writeState(initialProviderState(issuer.publicKey.export({ type: "spki", format: "pem" }).toString()));
      await writeFile(providerLog, "");
      // The operator's workspace is a clone of the default branch's content.
      git(workspace, "init", "-q", "-b", DEFAULT_BRANCH);
      git(workspace, "remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
      for (const [file, bytes] of governedFiles()) {
        await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
        await writeFile(path.join(workspace, file), bytes);
      }
      git(workspace, "add", "-A");
      git(workspace, "commit", "-q", "-m", "Initial governed repository");

      // Device Flow authorization, Authority preparation, profile and trust PR.
      const legacyAuthorityKey = path.join(configHome, "runtime-keys", "legacy.pem");
      const prepareArgs =
        scenario === "legacy"
          ? [
              "setup",
              "--repository",
              REPOSITORY,
              "--endpoint",
              ENDPOINT,
              "--authority-id",
              "runtime-legacy",
              "--private-key",
              legacyAuthorityKey,
            ]
          : ["setup", "--repository", REPOSITORY, "--endpoint", ENDPOINT, "--capability", "change.implement"];
      const prepare = async () => {
        const authorization = cli(prepareArgs);
        assert.equal(authorization.status, 0, `${authorization.stdout}\n${authorization.stderr}`);
        assert.match(authorization.stdout, /GOLD-1184/u);
        const result = ok(cli([...prepareArgs, "--json"]), "Authority preparation");
        assert.equal(result.state, "trust-pending");
        assert.equal(result.trust.status, "pending-human-trust");
        const publication = (await readState()).pulls.find(
          (pull) => pull.number === result.publication.pullRequest.number,
        );
        assert.equal(publication.state, "open");
        assert.equal(publication.merged, false);
        return result;
      };

      let prepared;
      if (scenario === "legacy") {
        // ---- 0. Explicit legacy state: the pre-0.17 operator flow, left as is ----
        ok(cli(["authority", "generate", "--json", "--private-key", legacyAuthorityKey]), "legacy Authority key");
        ok(
          cli([
            "authority",
            "bootstrap",
            "--json",
            "--authority-id",
            "runtime-legacy",
            "--private-key",
            legacyAuthorityKey,
            "--output",
            "authority.json",
            "--max-session-ttl-seconds",
            "1800",
            "--capability",
            "change.implement",
          ]),
          "legacy Authority bootstrap",
        );
        ok(cli(["authority", "register", "--json", "--from", "authority.json"]), "legacy Authority registration");
        await rm(path.join(workspace, "authority.json"));
        prepared = await prepare();
        assert.equal(existsSync(prepared.profilePath), true);
      }

      // ---- 1. init -> setup -----------------------------------------------------
      const initialized = ok(cli(["init", "--json", "--repository-id", REPOSITORY_ID]), "init");
      assert.equal(initialized.repository.nameWithOwner, REPOSITORY);
      const initial = ok(cli(["setup", "status", ...setupArgs]), "initial setup status").state;
      assert.deepEqual(initial.generation, initialized.setup.generation);
      assert.equal(nextKind(initial), "executor.configure");
      if (scenario === "clean") {
        assert.equal(initial.stage, "clean");
        for (const directory of ["authority", "admission", "executor", "runtime-profiles"])
          assert.equal(existsSync(path.join(configHome, directory)), false, `clean state already has ${directory}`);
      } else {
        // The legacy profile is not a ready setup: nothing is trusted or ready yet.
        assert.notEqual(initial.stage, "task-ready");
        assert.notEqual(dimension(initial, "repository-trust").status, "trusted");
        assert.equal(existsSync(path.join(configHome, "executor")), false);
      }

      const enrolled = ok(
        cli([
          "setup",
          "next",
          ...setupArgs,
          "--yes",
          "--input",
          `app-id=${APP_ID}`,
          "--enrollment-file",
          `issuer-key=${issuerKeyFile}`,
        ]),
        "Executor enrollment",
      );
      assert.equal(enrolled.result.outcome, "succeeded", JSON.stringify(enrolled.result));
      // The operator's key file is not needed again: custody now holds the key.
      await rm(issuerKeyFile);

      let state = ok(cli(["setup", "status", ...setupArgs]), "status after enrollment").state;
      assert.equal(nextKind(state), "composition.complete-configuration");
      if (scenario === "clean") {
        // No Authority exists to adopt: setup guides explicit Authority preparation.
        const unprepared = cli(["setup", "next", ...setupArgs, "--yes"]);
        assert.notEqual(unprepared.status, 0);
        const unpreparedResult = lastJson(unprepared).result;
        assert.equal(unpreparedResult.outcome, "failed");
        assert.equal(unpreparedResult.diagnostics[0].code, "SETUP_AUTHORITY_PREPARATION_REQUIRED");
        assert.match(
          unpreparedResult.diagnostics[0].message,
          /inari setup --endpoint <endpoint-url> --capability change\.implement/u,
        );
        prepared = await prepare();
      }
      const trustPull = prepared.publication.pullRequest.number;

      state = ok(cli(["setup", "status", ...setupArgs]), "status after preparation").state;
      for (let step = 0; step < 6 && state.nextAction.kind === "perform"; step += 1) {
        const kind = nextKind(state);
        if (kind === "composition.start-runtime" || kind === "authority.recheck-trust") break;
        const performed = ok(cli(["setup", "next", ...setupArgs, "--yes"]), kind);
        assert.equal(performed.result.outcome, "succeeded", JSON.stringify(performed.result));
        state = ok(cli(["setup", "status", ...setupArgs]), `status after ${kind}`).state;
      }
      assert.equal(state.stage, "pending-human-trust");
      assert.equal(nextKind(state), "authority.recheck-trust");
      assert.equal(dimension(state, "repository-trust").status, "pending-human-trust");
      // Publication is not approval: recheck before the human merge stays pending.
      ok(cli(["setup", "next", ...setupArgs, "--yes"]), "trust recheck before merge");
      state = ok(cli(["setup", "status", ...setupArgs]), "status before merge").state;
      assert.equal(dimension(state, "repository-trust").status, "pending-human-trust");

      // ---- Human review and merge of the trust PR (the only provider-side act) ----
      const beforeMerge = await readState();
      const pull = beforeMerge.pulls.find((candidate) => candidate.number === trustPull);
      assert.equal(beforeMerge.commits[beforeMerge.refs[pull.head]].parents[0], beforeMerge.refs[DEFAULT_BRANCH]);
      beforeMerge.refs[DEFAULT_BRANCH] = beforeMerge.refs[pull.head];
      Object.assign(pull, { state: "closed", merged: true });
      await writeState(beforeMerge);

      // Trust is re-observed from the protected ref itself, never from local files.
      state = ok(cli(["setup", "status", ...setupArgs]), "status after trust").state;
      assert.equal(dimension(state, "repository-trust").status, "trusted");
      assert.equal(nextKind(state), "composition.start-runtime");
      // A short-lived CLI never claims to own the long-running Runtime.
      const unowned = cli(["setup", "next", ...setupArgs, "--yes"]);
      assert.notEqual(unowned.status, 0);
      assert.equal(lastJson(unowned).result.diagnostics[0].code, "SETUP_RUNTIME_OWNER_REQUIRED");

      // ---- 2. Fresh shell -> Runtime ------------------------------------------
      // A new shell: only the config home (plus the provider stand-in). No Issuer
      // App ID, key reference or user credential is re-injected.
      const fresh = shell();
      for (const name of Object.keys(fresh))
        assert.doesNotMatch(
          name,
          /GITHUB_APP|GH_TOKEN|GITHUB_TOKEN|PRIVATE_KEY|CREDENTIAL/u,
          `fresh shell carries ${name}`,
        );
      const freshLogOffset = (await readFile(providerLog, "utf8")).trim().split("\n").length;
      const startRuntime = async () => {
        const runtime = spawn(process.execPath, [packed.entry, "runtime", "supervise"], {
          cwd: workspace,
          env: shell(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        runtime.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
        runtime.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
        const deadline = Date.now() + 60_000;
        for (;;) {
          state = ok(cli(["setup", "status", ...setupArgs], fresh), "status while Runtime starts").state;
          if (dimension(state, "session-readiness").status === "ready") return runtime;
          assert.equal(runtime.exitCode, null, `Runtime exited: ${output}`);
          assert.ok(Date.now() < deadline, `Runtime never became ready: ${JSON.stringify(state.dimensions)} ${output}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      };
      const supervisor = await startRuntime();
      processes.push(supervisor);
      assert.equal(dimension(state, "health").status, "healthy");
      assert.equal(state.stage, "task-ready");
      // ---- 3. Canonical Implementation and branch -----------------------------
      // The maintainer files the governed Implementation from the repository template,
      // pinned to the current protected default-branch revision.
      {
        const current = await readState();
        current.issues[IMPLEMENTATION] = {
          title: "Golden Path Implementation",
          body: await implementationBody(current.refs[DEFAULT_BRANCH]),
          state: "open",
        };
        await writeState(current);
      }
      // The operator works on the Implementation's exact contract branch and pushes it.
      git(workspace, "checkout", "-q", "-b", BRANCH);
      await mkdir(path.join(workspace, "docs"), { recursive: true });
      const change = Buffer.from("# Golden Path\n\nDelivered through the local Runtime.\n");
      await writeFile(path.join(workspace, "docs", "golden-path.md"), change);
      git(workspace, "add", "-A");
      git(workspace, "commit", "-q", "-m", "docs: golden path");
      await operatorPush(readState, writeState, BRANCH, "docs/golden-path.md", change);
      const beforeSession = await readState();
      assert.equal(beforeSession.pulls.filter((candidate) => candidate.head === BRANCH).length, 0);

      // ---- 4. Session -> governed operation -> initially absent PR --------------
      // The Session child runs the ordinary `pr create` command twice (creation, then
      // an exact retry) and records what it observed.
      const childScript = path.join(root, "session-child.mjs");
      await writeFile(
        childScript,
        `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const run = (args) => {
  const result = spawnSync(process.execPath, [${JSON.stringify(packed.entry)}, ...args], { encoding: "utf8", env: process.env });
  const line = result.stdout.trim().split("\\n").reverse().find((candidate) => candidate.startsWith("{"));
  return { status: result.status, output: line === undefined ? null : JSON.parse(line), stderr: result.stderr };
};
const create = ["pr", "create", "--json", "--title", "docs: golden path",
  "--head", ${JSON.stringify(BRANCH)}, "--base", ${JSON.stringify(DEFAULT_BRANCH)},
  "--field", "summary=Deliver the Golden Path change.",
  "--field", "linked_issue=Closes #${IMPLEMENTATION}",
  "--field", "changes=Add docs/golden-path.md.",
  "--field", "validation=typecheck", "--field", "validation=tests", "--field", "validation=build",
  "--field", "review_focus=Local Runtime publication."];
const runs = Number(process.argv[3] ?? "2");
writeFileSync(process.argv[2], JSON.stringify({
  session: process.env.INARI_SESSION_ID ?? null,
  runs: Array.from({ length: runs }, () => run(create)),
}));
`,
      );
      let childRun = 0;
      const runSession = async (issue, runs = 2) => {
        childRun += 1;
        const results = path.join(root, `session-child-${childRun}.json`);
        const session = cli(
          ["session", "start", "--issue", String(issue), "--", process.execPath, childScript, results, String(runs)],
          fresh,
        );
        return {
          session,
          child: existsSync(results) ? JSON.parse(await readFile(results, "utf8")) : undefined,
        };
      };
      const pullsFor = (current) => current.pulls.filter((candidate) => candidate.head === BRANCH);
      const logEntries = async () =>
        (await readFile(providerLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      const freshShellLogStart = freshLogOffset;

      const governedLogStart = (await logEntries()).length;
      const governed = await runSession(IMPLEMENTATION);
      assert.equal(governed.session.status, 0, `${governed.session.stdout}\n${governed.session.stderr}`);
      assert.match(governed.child.session, /^sess_/u);
      const [created, repeated] = governed.child.runs;
      assert.equal(created.status, 0, JSON.stringify(created));
      assert.equal(created.output.route, "local-admission");
      assert.equal(created.output.classification, "created");
      assert.equal(created.output.mutation, true);
      assert.equal(repeated.status, 0, JSON.stringify(repeated));
      assert.equal(repeated.output.classification, "returned-existing");
      assert.equal(repeated.output.mutation, false);
      assert.deepEqual(repeated.output.pullRequest, created.output.pullRequest);

      const afterPublication = await readState();
      const [published] = pullsFor(afterPublication);
      assert.equal(pullsFor(afterPublication).length, 1);
      assert.equal(afterPublication.pullCreates, 2, "one trust PR POST and one governed PR POST");
      assert.equal(created.output.pullRequest.number, published.number);
      assert.equal(created.output.pullRequest.url, `https://github.com/${REPOSITORY}/pull/${published.number}`);
      assert.equal(published.author, "inari-issuer[bot]");
      assert.equal(published.head, BRANCH);
      assert.equal(published.base, DEFAULT_BRANCH);
      assert.equal(published.headSha, afterPublication.refs[BRANCH]);
      assert.match(published.body, /^## Summary\n\nDeliver the Golden Path change\./u);
      assert.match(published.body, /Closes #42/u);
      assert.match(
        published.body,
        /inari:template \{"version":"1","kind":"pull_request","path":".github\/inari\/pull-requests\/default.json"\}/u,
      );
      const governedPosts = (await logEntries()).filter(
        (entry) => entry.method === "POST" && entry.route === `/repos/${REPOSITORY}/pulls`,
      );
      assert.equal(governedPosts.length, 2);
      assert.equal(governedPosts[1].role, "executor");
      assert.equal(governedPosts[1].authorization, "installation");
      // After setup only the setup observation reads trust with the persisted operator
      // credential (read-only); the governed Session path never uses it.
      const afterFresh = (await logEntries()).slice(freshShellLogStart);
      assert.ok(
        afterFresh
          .filter((entry) => entry.authorization === "user")
          .every((entry) => entry.method === "GET" && entry.role === "cli"),
      );
      const governedPath = (await logEntries()).slice(governedLogStart);
      assert.equal(governedPath.filter((entry) => entry.authorization === "user").length, 0);
      assert.equal(
        afterFresh.filter((entry) => entry.unmatched).length,
        0,
        JSON.stringify(afterFresh.filter((entry) => entry.unmatched)),
      );

      // ---- 5. Minimal-cause refusals: no child and no PR effect -----------------
      const pullCount = async () => (await readState()).pullCreates;
      const refusal = async (issue, label) => {
        const before = await pullCount();
        const refused = await runSession(issue);
        assert.notEqual(refused.session.status, 0, `${label} was not refused: ${refused.session.stdout}`);
        assert.equal(refused.child, undefined, `${label} started the Session child`);
        assert.equal(await pullCount(), before, `${label} caused a PR effect`);
        return lastJson(refused.session).error;
      };
      // A Source Issue (or a branch name) is not an execution contract.
      const source = await refusal(SOURCE_ISSUE, "Source Issue Session");
      assert.match(source.code, /^ADMISSION_|^SESSION_|^EXECUTOR_/u, JSON.stringify(source));
      console.log("GP-REFUSAL source", JSON.stringify(source));

      // An unavailable provider is reported as unavailable, not as a denial.
      {
        const current = await readState();
        await writeState({ ...current, providerUnavailable: true });
        const unavailable = await refusal(IMPLEMENTATION, "provider-unavailable Session");
        assert.equal(unavailable.code, "ADMISSION_OWNER_UNAVAILABLE", JSON.stringify(unavailable));
        assert.equal(unavailable.details.reason, "GITHUB_APP_PROVIDER_UNAVAILABLE");
        await writeState({ ...(await readState()), providerUnavailable: false });
      }

      // Trust removed from the protected ref: the Session is refused on trust evidence.
      {
        const current = await readState();
        const trusted = current.refs[DEFAULT_BRANCH];
        const entries = current.trees[current.commits[trusted].tree].filter(
          (entry) => !entry.path.startsWith(".github/inari/authorities/"),
        );
        const tree = sha1(`tree\0${JSON.stringify(entries)}`);
        const revoked = sha1(`commit\0${tree}\0${trusted}`);
        current.trees[tree] = entries;
        current.commits[revoked] = { tree, parents: [trusted], message: "revoke trust" };
        current.refs[DEFAULT_BRANCH] = revoked;
        await writeState(current);
        const untrusted = await refusal(IMPLEMENTATION, "untrusted Session");
        assert.equal(untrusted.code, "ADMISSION_TRUST_UNVERIFIED");
        assert.equal(untrusted.details.reason, "RUNTIME_AUTHORITY_NOT_FOUND");
        const restored = await readState();
        restored.refs[DEFAULT_BRANCH] = trusted;
        await writeState(restored);
      }

      // A closed Session cannot be replayed.
      {
        const staleShell = { ...fresh, INARI_SESSION_ID: governed.child.session };
        ok(cli(["session", "close", "--json"], staleShell), "session close");
        const before = await pullCount();
        const stale = cli(
          [
            "pr",
            "create",
            "--json",
            "--title",
            "docs: golden path",
            "--head",
            BRANCH,
            "--base",
            DEFAULT_BRANCH,
            "--field",
            "summary=Deliver the Golden Path change.",
            "--field",
            `linked_issue=Closes #${IMPLEMENTATION}`,
            "--field",
            "changes=Add docs/golden-path.md.",
            "--field",
            "validation=typecheck",
            "--field",
            "validation=tests",
            "--field",
            "validation=build",
            "--field",
            "review_focus=Local Runtime publication.",
          ],
          staleShell,
        );
        assert.notEqual(stale.status, 0, stale.stdout);
        assert.equal(lastJson(stale).error.code, "ADMISSION_SESSION_REJECTED", stale.stdout);
        assert.equal(await pullCount(), before);
      }

      // ---- 6. Runtime restart in a fresh shell: same identity, idempotent result ----
      supervisor.kill("SIGTERM");
      if (supervisor.exitCode === null) await once(supervisor, "exit");
      const restarted = await startRuntime();
      processes.push(restarted);
      const afterRestart = await runSession(IMPLEMENTATION, 1);
      assert.equal(afterRestart.session.status, 0, afterRestart.session.stdout);
      assert.equal(afterRestart.child.runs[0].output.classification, "returned-existing");
      assert.equal(afterRestart.child.runs[0].output.pullRequest.number, published.number);
      assert.equal(await pullCount(), 2);

      console.log(
        `packed package ${packed.identity.name}@${packed.identity.version} (${packed.identity.integrity ?? packed.identity.shasum}): ` +
          `continuous ${scenario} Golden Path init -> setup -> fresh shell -> Runtime -> Implementation -> Session -> new PR: PASS ` +
          "(deterministic provider stand-in; live GitHub NOT CHECKED)",
      );
    } finally {
      for (const child of processes) {
        child.kill("SIGTERM");
        if (child.exitCode === null) await once(child, "exit").catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
      await packed.cleanup();
    }
  }
}

test(
  "#1184 clean: init -> setup -> fresh shell -> Runtime -> Implementation -> Session -> new PR on one packed artifact",
  { timeout: 600_000 },
  () => certifyGoldenPath("clean"),
);

test(
  "#1184 legacy-resume: an explicit legacy profile resumes through the same public path to a new PR",
  { timeout: 600_000 },
  () => certifyGoldenPath("legacy"),
);
