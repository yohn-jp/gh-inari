import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateExistingPullRequestArtifact, extractTemplateIdentityMarker } from "./artifact.js";
import { CAPABILITY_KINDS } from "./agent-authority/capability.js";
import { createDelegatorRecord } from "./agent-authority/delegator-operations.js";
import { renderDelegatorArtifact } from "./agent-authority/delegator-trust.js";
import type { Delegator } from "./agent-authority/delegator.js";
import { recognizeBranchName, validateBranchName } from "./branch-naming.js";
import type { GitHubBranchAdvanceCapability } from "./github/git-data-capability.js";
import type { RepositoryIdentity } from "./github/effect-authorizer.js";
import type {
  RuntimeAuthorityPublicationBroker,
  RuntimeAuthorityPublicationCapability,
  RuntimeAuthorityPullRequest,
} from "./github/runtime-authority-publication-capability.js";
import {
  publishRuntimeAuthority,
  runtimeAuthorityPublicationBranch,
  runtimeAuthorityPublicationBody,
  RuntimeAuthorityPublicationError,
} from "./runtime-authority-publication.js";
import {
  compileSemanticTemplateSync,
  discoverSemanticTemplatesSync,
  readSemanticTemplateSync,
} from "./semantic-template.js";

const TARGET: RepositoryIdentity = {
  repositoryHost: "github.com",
  repositoryId: "99",
  nameWithOwner: "acme/inari",
};
const BASE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const PULL_REQUEST_URL = "https://github.com/acme/inari/pull/17";

function authority(id = "runtime-test"): Delegator {
  const { publicKey } = generateKeyPairSync("ed25519");
  return createDelegatorRecord({
    id,
    key: publicKey,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: null,
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: CAPABILITY_KINDS,
  });
}

test("generated Authority trust PR and artifact satisfy repository governance", async () => {
  const publicAuthority = authority();
  const artifact = renderDelegatorArtifact(publicAuthority);
  const body = runtimeAuthorityPublicationBody(publicAuthority);
  const identity = discoverSemanticTemplatesSync(process.cwd()).find(
    (candidate) =>
      candidate.kind === "pull_request" && candidate.sourcePath === ".github/inari/pull-requests/authority.json",
  );
  assert.ok(identity);
  const contract = compileSemanticTemplateSync(process.cwd(), readSemanticTemplateSync(process.cwd(), identity));
  const validation = validateExistingPullRequestArtifact(contract, body);
  assert.equal(validation.valid, true, JSON.stringify(validation.violations));
  assert.match(body, /^# Runtime Authority PR\n\n/m);
  const marker = extractTemplateIdentityMarker(body);
  assert.equal(marker.status, "valid");
  assert.deepEqual(marker.marker, {
    version: "1",
    kind: "pull_request",
    path: ".github/inari/pull-requests/authority.json",
  });

  const branch = runtimeAuthorityPublicationBranch(publicAuthority.id);
  assert.deepEqual(validateBranchName(branch), []);
  const classification = recognizeBranchName(branch);
  assert.equal(classification?.type, "feat");
  assert.equal(classification?.issueNumber, 1066);

  const governance = (await import(
    new URL("../scripts/validate-runtime-authority-governance.mjs", import.meta.url).href
  )) as {
    validateDelegatorTransition(input: {
      readonly base: ReadonlyMap<string, string>;
      readonly head: ReadonlyMap<string, string>;
    }): { readonly valid: boolean; readonly created: readonly string[]; readonly violations: readonly unknown[] };
  };
  const transition = governance.validateDelegatorTransition({
    base: new Map(),
    head: new Map([[artifact.path, artifact.content]]),
  });
  assert.equal(transition.valid, true, JSON.stringify(transition.violations));
  assert.deepEqual(transition.created, [artifact.path]);
});

function brokerFor(
  publicAuthority: Delegator,
  overrides: { readonly extraChangedPath?: string; readonly artifactMode?: string } = {},
): {
  readonly broker: RuntimeAuthorityPublicationBroker;
  readonly calls: Readonly<Record<string, number>>;
  readonly publication: {
    treePaths?: readonly string[];
    pullRequestPaths?: readonly string[];
    pullRequestBody?: string;
  };
} {
  const artifact = renderDelegatorArtifact(publicAuthority);
  const counts = { createBranch: 0, createCommit: 0, createPullRequest: 0 };
  const publication: {
    treePaths?: readonly string[];
    pullRequestPaths?: readonly string[];
    pullRequestBody?: string;
  } = {};
  const blobSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(artifact.content, "utf8")}\0`)
    .update(artifact.content)
    .digest("hex");
  let branchHead: string | undefined;
  let storedPullRequest: RuntimeAuthorityPullRequest | undefined;
  const gitData = {
    scope: {} as GitHubBranchAdvanceCapability["scope"],
    readRef: async (branch: string) =>
      branchHead === undefined ? undefined : { name: branch, ref: `refs/heads/${branch}`, sha: branchHead },
    readCommit: async (sha: string) => ({ sha, treeSha: sha === BASE_SHA ? BASE_TREE_SHA : TREE_SHA }),
    readTree: async (sha: string) => ({
      sha,
      entries:
        sha === BASE_TREE_SHA
          ? []
          : [{ path: artifact.path, mode: overrides.artifactMode ?? "100644", type: "blob" as const, sha: blobSha }],
    }),
    readBlob: async (sha: string) => {
      assert.equal(sha, blobSha);
      return artifact.content;
    },
    createBlob: async (input: { readonly content: string }) => {
      assert.equal(Buffer.from(input.content, "base64").toString("utf8"), artifact.content);
      return { sha: blobSha };
    },
    createTree: async (input: {
      readonly baseTreeSha: string;
      readonly entries: readonly {
        readonly path: string;
        readonly mode: "100644" | "100755";
        readonly type: "blob";
        readonly sha: string | null;
      }[];
    }) => {
      assert.equal(input.baseTreeSha, BASE_TREE_SHA);
      assert.deepEqual(input.entries, [{ path: artifact.path, mode: "100644", type: "blob", sha: blobSha }]);
      publication.treePaths = input.entries.map((entry) => entry.path);
      return { sha: TREE_SHA };
    },
    createCommit: async (input: {
      readonly message: string;
      readonly treeSha: string;
      readonly parents: readonly string[];
    }) => {
      counts.createCommit += 1;
      assert.equal(input.treeSha, TREE_SHA);
      assert.deepEqual(input.parents, [BASE_SHA]);
      return { sha: COMMIT_SHA };
    },
    compareAndAdvanceRef: async () => ({ status: "updated" as const }),
  } as unknown as GitHubBranchAdvanceCapability;
  const pullRequest = (branch: string, base: string, title: string, body: string): RuntimeAuthorityPullRequest => ({
    number: 17,
    url: PULL_REQUEST_URL,
    title,
    body,
    state: "open",
    draft: false,
    headBranch: branch,
    headRepository: TARGET.nameWithOwner,
    baseBranch: base,
    author: "inari-issuer[bot]",
    changedFiles: 1,
  });
  const capability: RuntimeAuthorityPublicationCapability = {
    scope: {} as RuntimeAuthorityPublicationCapability["scope"],
    gitData,
    getDefaultBranch: async () => ({ name: "main", sha: BASE_SHA }),
    createBranch: async (_branch, sha) => {
      counts.createBranch += 1;
      branchHead = sha;
    },
    compareBranch: async () => ({
      aheadBy: 1,
      changedPaths: [artifact.path, ...(overrides.extraChangedPath === undefined ? [] : [overrides.extraChangedPath])],
    }),
    findPullRequests: async (_branch, _base) => (storedPullRequest === undefined ? [] : [storedPullRequest]),
    readPullRequestFiles: async () => {
      publication.pullRequestPaths = [artifact.path];
      return [artifact.path];
    },
    createPullRequest: async (input) => {
      counts.createPullRequest += 1;
      publication.pullRequestBody = input.body;
      storedPullRequest = pullRequest(input.head, input.base, input.title, input.body);
      return storedPullRequest;
    },
  };
  return {
    broker: {
      withRuntimeAuthorityPublicationCapability: async (_request, operation) => operation(capability),
    },
    calls: counts,
    publication,
  };
}

test("publishes one canonical public trust record on a dedicated branch and human-review PR", async () => {
  const publicAuthority = authority();
  const fixture = brokerFor(publicAuthority);
  const result = await publishRuntimeAuthority({ version: 1, authority: publicAuthority }, TARGET, fixture.broker);

  assert.equal(result.status, "created");
  assert.equal(result.branch, runtimeAuthorityPublicationBranch(publicAuthority.id));
  assert.deepEqual(result.pullRequest, { number: 17, url: PULL_REQUEST_URL });
  assert.deepEqual(fixture.calls, { createBranch: 1, createCommit: 1, createPullRequest: 1 });

  const replay = await publishRuntimeAuthority({ version: 1, authority: publicAuthority }, TARGET, fixture.broker);
  assert.equal(replay.status, "existing");
  assert.deepEqual(fixture.calls, { createBranch: 1, createCommit: 1, createPullRequest: 1 });
});

test("unrelated caller worktree files cannot enter the generated Authority commit or PR", async () => {
  const workingTree = await mkdtemp(path.join(os.tmpdir(), "inari-authority-caller-tree-"));
  try {
    await writeFile(path.join(workingTree, ".mcp.json"), '{"token":"unrelated-worktree-secret"}\n', "utf8");
    await writeFile(path.join(workingTree, "local-notes.txt"), "provider-token-secret\n", "utf8");
    assert.deepEqual((await readdir(workingTree)).sort(), [".mcp.json", "local-notes.txt"]);

    const publicAuthority = authority("runtime-worktree-isolation");
    const artifact = renderDelegatorArtifact(publicAuthority);
    const fixture = brokerFor(publicAuthority);
    const result = await publishRuntimeAuthority({ version: 1, authority: publicAuthority }, TARGET, fixture.broker);

    assert.equal(result.status, "created");
    assert.deepEqual(fixture.publication.treePaths, [artifact.path]);
    assert.deepEqual(fixture.publication.pullRequestPaths, [artifact.path]);
    assert.equal(fixture.publication.pullRequestBody, runtimeAuthorityPublicationBody(publicAuthority));
    assert.doesNotMatch(
      JSON.stringify(fixture.publication),
      /unrelated-worktree-secret|provider-token-secret|\.mcp\.json|local-notes\.txt/iu,
    );
  } finally {
    await rm(workingTree, { recursive: true, force: true });
  }
});

test("rejects private or unrelated properties before reaching the Issuer capability", async () => {
  const publicAuthority = authority();
  const fixture = brokerFor(publicAuthority);
  let brokerCalls = 0;
  const broker: RuntimeAuthorityPublicationBroker = {
    withRuntimeAuthorityPublicationCapability: async (_request, operation) => {
      brokerCalls += 1;
      return fixture.broker.withRuntimeAuthorityPublicationCapability(_request, operation);
    },
  };
  await assert.rejects(
    () =>
      publishRuntimeAuthority(
        { version: 1, authority: { ...publicAuthority, privateKey: "must-never-cross" }, unrelated: ".mcp.json" },
        TARGET,
        broker,
      ),
    RuntimeAuthorityPublicationError,
  );
  assert.equal(brokerCalls, 0);
});

test("fails closed when the publication branch contains any unrelated tree change", async () => {
  const publicAuthority = authority();
  const fixture = brokerFor(publicAuthority, { extraChangedPath: ".mcp.json" });
  await assert.rejects(
    () => publishRuntimeAuthority({ version: 1, authority: publicAuthority }, TARGET, fixture.broker),
    RuntimeAuthorityPublicationError,
  );
  assert.equal(fixture.calls.createPullRequest, 0);
});

test("fails closed when the public Authority artifact has a noncanonical Git mode", async () => {
  const publicAuthority = authority();
  const fixture = brokerFor(publicAuthority, { artifactMode: "100755" });
  await assert.rejects(
    () => publishRuntimeAuthority({ version: 1, authority: publicAuthority }, TARGET, fixture.broker),
    RuntimeAuthorityPublicationError,
  );
  assert.equal(fixture.calls.createPullRequest, 0);
});
