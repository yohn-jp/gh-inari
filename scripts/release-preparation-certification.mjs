#!/usr/bin/env node

// Release-preparation certification.  The fixtures below intentionally use
// native GitHub REST response shapes and the production adapters/modules.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = Object.freeze({
  hostname: "github.com",
  host: "github.com",
  owner: "yohn-jp",
  name: "gh-inari",
  nameWithOwner: "yohn-jp/gh-inari",
  repositoryId: "1330755860",
});
const publicationRepository = Object.freeze({
  repositoryHost: "github.com",
  repositoryId: "1330755860",
  repository: "yohn-jp/gh-inari",
});
const previousRevision = "a".repeat(40);
const annotatedTagRevision = "f".repeat(40);
const lightweightTagRevision = "d".repeat(40);
const mergeRevisions = Object.freeze(["b".repeat(40), "c".repeat(40), "e".repeat(40)]);
const pullRequestNumbers = Object.freeze([959, 960, 961]);
const pullRequestTimes = Object.freeze(["2026-09-20T00:00:00Z", "2026-09-20T01:00:00Z", "2026-09-20T02:00:00Z"]);

function response(body, status = 200, headers = {}) {
  return { status, headers, body };
}

function localRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
}

function fileText(relative) {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

async function production() {
  const [
    { GitHubReleaseHistoryAdapter },
    { compileRepositoryGovernedContract },
    { renderPullRequestArtifact },
    { prepareRelease },
    { publishReleasePullRequest },
    { createReleasePrPublicationRequest },
    { publishPullRequest },
  ] = await Promise.all([
    import("../src/github/release-history-adapter.ts"),
    import("../src/governance.ts"),
    import("../src/artifact.ts"),
    import("../src/release-preparation.ts"),
    import("../src/release-pr-publication.ts"),
    import("../src/release-pr-publication.ts"),
    import("../src/pr-publication.ts"),
  ]);
  return {
    GitHubReleaseHistoryAdapter,
    compileRepositoryGovernedContract,
    renderPullRequestArtifact,
    prepareRelease,
    publishReleasePullRequest,
    createReleasePrPublicationRequest,
    publishPullRequest,
  };
}

async function buildFixture(productionModules, options = {}) {
  const targetRevision = options.targetRevision ?? localRevision();
  const releaseSource = fileText(".github/inari/pull-requests/release.json");
  const releaseNative = fileText(".github/PULL_REQUEST_TEMPLATE/release.md");
  const defaultSource = fileText(".github/inari/pull-requests/default.json");
  const defaultNative = fileText(".github/PULL_REQUEST_TEMPLATE/default.md");
  const policySource = fileText(".github/inari/pr-policy.yml");
  const blobs = new Map([
    ["release-json-sha", releaseSource],
    ["release-native-sha", releaseNative],
    ["default-json-sha", defaultSource],
    ["default-native-sha", defaultNative],
    ["policy-sha", policySource],
  ]);
  const tree = {
    sha: "e".repeat(40),
    entries: [
      { path: ".github/inari/pull-requests/release.json", type: "blob", sha: "1".repeat(40) },
      { path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "blob", sha: "2".repeat(40) },
      { path: ".github/inari/pull-requests/default.json", type: "blob", sha: "4".repeat(40) },
      { path: ".github/PULL_REQUEST_TEMPLATE/default.md", type: "blob", sha: "5".repeat(40) },
      { path: ".github/inari/pr-policy.yml", type: "blob", sha: "3".repeat(40) },
    ],
  };
  const releaseBody = {};
  const governance = {
    context: repository,
    targetRef: "main",
    resolveRepositoryContext: async () => repository,
    getRepositoryDefaultBranch: async () => "main",
    getRepositoryTree: async () => tree,
    getRepositoryBlob: async (sha) => {
      const key =
        sha === "1".repeat(40)
          ? "release-json-sha"
          : sha === "2".repeat(40)
            ? "release-native-sha"
            : sha === "4".repeat(40)
              ? "default-json-sha"
              : sha === "5".repeat(40)
                ? "default-native-sha"
                : "policy-sha";
      return (
        blobs.get(key) ??
        (() => {
          throw new Error(`unknown fixture blob ${sha}`);
        })()
      );
    },
  };
  const contract = await productionModules.compileRepositoryGovernedContract(governance, "pr", "release");
  for (const [index, number] of pullRequestNumbers.entries()) {
    releaseBody[number] = productionModules.renderPullRequestArtifact(contract, {
      fields: {
        release_pr: `Release implementation ${number}`,
        version: "Target version: 0.14.2\n- Version bump (patch/minor/major): patch",
        release_notes: `Governed release change for #${number}.`,
        breaking_migration: "None.",
        publish_plan: "Run the fixed verification command, then publish through the governed release PR.",
        post_release_verification: "Verify the package artifact and release PR source revision.",
        tracking: `Fixes yohn-jp/gh-inari#${number}`,
      },
      metadata: { title: `Release implementation ${number}`, head: `feat/${number}-release`, base: "main" },
    });
  }
  for (const [number, body] of Object.entries(options.bodyOverrides ?? {})) releaseBody[number] = body;

  const calls = [];
  const compareBody = options.compareBody ?? {
    status: "ahead",
    ahead_by: 3,
    behind_by: 0,
    total_commits: 3,
    base_commit: { sha: previousRevision, commit: { sha: previousRevision } },
    merge_base_commit: { sha: previousRevision, commit: { sha: previousRevision } },
    commits: mergeRevisions.map((sha) => ({ sha, commit: { message: "release change" } })),
  };
  const associated =
    options.associated ?? new Map(mergeRevisions.map((sha, index) => [sha, [{ number: pullRequestNumbers[index] }]]));
  const pullRequests = Object.fromEntries(
    pullRequestNumbers.map((number, index) => [
      number,
      {
        number,
        title: `Release implementation ${number}`,
        body: releaseBody[number],
        state: "closed",
        html_url: `https://github.com/yohn-jp/gh-inari/pull/${number}`,
        url: `https://api.github.com/repos/yohn-jp/gh-inari/pulls/${number}`,
        draft: false,
        merged: true,
        merged_at: pullRequestTimes[index],
        merge_commit_sha: mergeRevisions[index],
        head: { ref: `feat/${number}-release`, sha: "4".repeat(40) },
        base: { ref: "main", sha: targetRevision },
      },
    ]),
  );
  Object.assign(pullRequests, options.pullRequestOverrides ?? {});

  const api = {
    async getRepositoryDefaultBranch() {
      return "main";
    },
    async findBranch(branch) {
      if (branch !== "main") return undefined;
      return { name: "main", ref: "refs/heads/main", sha: targetRevision };
    },
    async requestRepositoryApi(requestPath, method = "GET") {
      calls.push({ requestPath, method });
      if (requestPath === "git/refs/tags?per_page=100") {
        return response(
          [
            { ref: "refs/tags/v0.13.0", object: { type: "commit", sha: lightweightTagRevision } },
            { ref: "refs/tags/v0.14.1", object: { type: "tag", sha: annotatedTagRevision } },
          ],
          200,
          options.tagHeaders ?? {},
        );
      }
      if (requestPath === `git/tags/${annotatedTagRevision}`)
        return response({ object: { type: "commit", sha: previousRevision } });
      if (requestPath.startsWith("compare/")) return response(compareBody, 200, options.compareHeaders ?? {});
      const associatedMatch = /^commits\/([0-9a-f]+)\/pulls\?per_page=100$/u.exec(requestPath);
      if (associatedMatch !== null)
        return response(associated.get(associatedMatch[1]) ?? [], 200, options.associatedHeaders ?? {});
      const pullMatch = /^pulls\/(\d+)$/u.exec(requestPath);
      if (pullMatch !== null) return response(pullRequests[pullMatch[1]] ?? {}, 200);
      const treeMatch = /^git\/trees\/([^?]+)\?recursive=1$/u.exec(requestPath);
      if (treeMatch !== null) return response({ sha: tree.sha, tree: tree.entries });
      const blobMatch = /^git\/blobs\/([0-9a-f]+)$/u.exec(requestPath);
      if (blobMatch !== null) {
        const blobSha = blobMatch[1];
        const content =
          blobSha === "1".repeat(40)
            ? releaseSource
            : blobSha === "2".repeat(40)
              ? releaseNative
              : blobSha === "4".repeat(40)
                ? defaultSource
                : blobSha === "5".repeat(40)
                  ? defaultNative
                  : policySource;
        return response({ sha: blobSha, encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
      }
      throw new Error(`unexpected GitHub fixture request: ${requestPath}`);
    },
  };
  const adapter = new productionModules.GitHubReleaseHistoryAdapter({ adapter: api, repository });
  return { adapter, api, calls, targetRevision, releaseBody, pullRequests, compareBody };
}

function publicationProvider(repository, options = {}) {
  const records = [...(options.initial ?? [])];
  const calls = [];
  let creates = 0;
  return {
    calls,
    get creates() {
      return creates;
    },
    async getRepositoryIdentity() {
      return repository;
    },
    async listPullRequests() {
      calls.push("list");
      return [...records];
    },
    async readPullRequest(number) {
      calls.push(`read:${number}`);
      const found = records.find((entry) => entry.number === number);
      if (found === undefined) throw new Error("pull request not found");
      return found;
    },
    async createPullRequest(input) {
      creates += 1;
      calls.push("create");
      const record = {
        number: 2000 + creates,
        url: `https://github.com/yohn-jp/gh-inari/pull/${2000 + creates}`,
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        headRevision: input.headRevision,
        repository,
      };
      records.push(record);
      if (options.uncertain) throw new Error("provider response lost after create");
      return record;
    },
  };
}

async function prepareInExactWorktree(productionModules, history, targetRevision) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-release-golden-path-"));
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", root, targetRevision], { cwd: repoRoot });
  try {
    const previousVersion = history.previousRelease.version;
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    packageJson.version = previousVersion;
    const pluginJson = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
    pluginJson.version = previousVersion;
    const marketplaceJson = JSON.parse(await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
    marketplaceJson.plugins[0].source.version = "^" + previousVersion;
    await writeFile(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
    await writeFile(path.join(root, ".codex-plugin/plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n");
    await writeFile(\n      path.join(root, ".agents/plugins/marketplace.json"),\n      JSON.stringify(marketplaceJson, null, 2) + "\\n",\n    );
    execFileSync("git", ["config", "user.email", "release-certification@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Release Certification"], { cwd: root });
    execFileSync(\n      "git",\n      ["add", "package.json", ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json"],\n      { cwd: root },\n    );
    execFileSync("git", ["commit", "-qm", "fixture previous-release version"], { cwd: root });
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {\n      cwd: root,\n      encoding: "utf8",\n    }).trim();
    const preparedHistory = { ...history, targetSource: { ...history.targetSource, sourceRevision } };
    const verification = async (command, args, cwd) => ({ command, args, cwd, status: 0 });
    const first = await productionModules.prepareRelease({\n      repositoryRoot: root,\n      history: preparedHistory,\n      intent: "patch",\n      runVerification: verification,\n    });
    const document = await readFile(path.join(root, "docs/releases", first.targetVersion + ".md"), "utf8");
    const second = await productionModules.prepareRelease({\n      repositoryRoot: root,\n      history: preparedHistory,\n      intent: "patch",\n      runVerification: verification,\n    });
    return { first, second, document };
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", root], { cwd: repoRoot });
    await rm(root, { recursive: true, force: true });
  }
}
async function expectFailure(name, operation) {
  try {
    await operation();
  } catch (error) {
    return { name, passed: true, message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error(`${name} unexpectedly passed`);
}

export async function runCertification() {
  const modules = await production();
  const fixture = await buildFixture(modules);
  const history = await fixture.adapter.readReleaseHistory({ targetRef: "main" });
  assert.equal(history.previousRelease.tag, "v0.14.1");
  assert.equal(history.previousRelease.sourceRevision, previousRevision);
  assert.equal(history.targetSource.sourceRevision, fixture.targetRevision);
  assert.deepEqual(
    history.includedChanges.map((change) => change.number),
    [959, 960, 961],
  );
  assert.deepEqual(
    history.includedChanges.map((change) => change.sourceIssueNumbers),
    [[959], [960], [961]],
  );

  const prepared = await prepareInExactWorktree(modules, history, fixture.targetRevision);
  assert.equal(prepared.first.targetVersion, "0.14.2");
  assert.equal(prepared.first.idempotent, false);
  assert.equal(prepared.second.idempotent, true);
  assert.deepEqual(prepared.first.publicationHandoff, {
    version: 1,
    kind: "release-pr-publication",
    role: "release",
    targetVersion: "0.14.2",
    head: "release/0.14.2",
    base: "main",
    expectedHead: "release/0.14.2",
    expectedBase: "main",
    headRevision: prepared.first.source.sourceRevision,
    template: "release",
  });
  assert.match(prepared.document, /^# Release 0\.14\.2$/mu);
  assert.match(prepared.document, /^## Known limitations$/mu);
  assert.doesNotMatch(JSON.stringify(prepared.first.publicationHandoff), /sourceIssue/u);

  const publicationBody = prepared.document;
  const publisher = publicationProvider(publicationRepository);
  const published = await modules.publishReleasePullRequest(
    {
      repository: publicationRepository,
      targetVersion: prepared.first.targetVersion,
      sourceRevision: prepared.first.source.sourceRevision,
      title: "Release 0.14.2",
      body: publicationBody,
    },
    publisher,
  );
  assert.equal(published.classification, "created");
  const retried = await modules.publishReleasePullRequest(
    {
      repository: publicationRepository,
      targetVersion: prepared.first.targetVersion,
      sourceRevision: prepared.first.source.sourceRevision,
      title: "Release 0.14.2",
      body: publicationBody,
    },
    publisher,
  );
  assert.equal(retried.classification, "returned-existing");
  assert.equal(publisher.creates, 1);
  assert.ok(publisher.calls.includes("read:2001"));

  const negatives = [];
  negatives.push(
    await expectFailure("non-ancestor", async () => {
      const broken = await buildFixture(modules, { compareBody: { ...fixture.compareBody, status: "behind" } });
      await broken.adapter.readReleaseHistory({ targetRef: "main" });
    }),
  );
  negatives.push(
    await expectFailure("pagination-truncation", async () => {
      const broken = await buildFixture(modules, {
        compareHeaders: { link: '<https://api.github.com/next>; rel="next"' },
      });
      await broken.adapter.readReleaseHistory({ targetRef: "main" });
    }),
  );
  negatives.push(
    await expectFailure("ungoverned-pr", async () => {
      const broken = await buildFixture(modules, { bodyOverrides: { 959: "not a governed pull request" } });
      await broken.adapter.readReleaseHistory({ targetRef: "main" });
    }),
  );
  negatives.push(
    await expectFailure("unassociated-commit", async () => {
      const associated = new Map(
        mergeRevisions.map((sha, index) => [sha, index === 0 ? [] : [{ number: pullRequestNumbers[index] }]]),
      );
      const broken = await buildFixture(modules, { associated });
      await broken.adapter.readReleaseHistory({ targetRef: "main" });
    }),
  );
  negatives.push(
    await expectFailure("conflicting-associated-pr", async () => {
      const associated = new Map(
        mergeRevisions.map((sha, index) => [
          sha,
          index === 0 ? [{ number: 959 }, { number: 960 }] : [{ number: pullRequestNumbers[index] }],
        ]),
      );
      const broken = await buildFixture(modules, { associated });
      await broken.adapter.readReleaseHistory({ targetRef: "main" });
    }),
  );

  const validRequest = modules.createReleasePrPublicationRequest({
    repository: publicationRepository,
    targetVersion: "0.14.2",
    sourceRevision: prepared.first.source.sourceRevision,
    title: "Release 0.14.2",
    body: publicationBody,
  });
  for (const [name, mutation] of [
    ["wrong-source", { headRevision: "9".repeat(40) }],
    ["wrong-head", { expectedHead: "release/0.14.3" }],
    ["wrong-base", { expectedBase: "develop" }],
    ["wrong-version", { routing: { ...validRequest.routing, targetVersion: "0.14.3" } }],
  ]) {
    const result = await modules.publishPullRequest(
      { ...validRequest, ...mutation },
      publicationProvider(publicationRepository),
    );
    assert.equal(result.classification, "failed");
    negatives.push({ name, passed: true, message: result.diagnostics[0]?.message ?? "request rejected" });
  }

  const uncertain = publicationProvider(publicationRepository, { uncertain: true });
  const uncertainResult = await modules.publishReleasePullRequest(
    {
      repository: publicationRepository,
      targetVersion: "0.14.2",
      sourceRevision: prepared.first.source.sourceRevision,
      title: "Release 0.14.2",
      body: publicationBody,
    },
    uncertain,
  );
  assert.equal(uncertainResult.classification, "returned-existing");
  assert.equal(uncertain.creates, 1);
  assert.deepEqual(uncertain.calls, ["list", "create", "list"]);
  negatives.push({ name: "post-create-uncertainty", passed: true, message: "authoritative reread converged" });

  return {
    ok: true,
    targetRevision: prepared.first.source.sourceRevision,
    history: {
      previousTag: history.previousRelease.tag,
      compareCommits: mergeRevisions.length,
      includedChanges: history.includedChanges.map((change) => change.number),
    },
    preparation: { targetVersion: prepared.first.targetVersion, idempotentRetry: prepared.second.idempotent },
    publication: { first: published.classification, retry: retried.classification, creates: publisher.creates },
    negatives,
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCertification()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
