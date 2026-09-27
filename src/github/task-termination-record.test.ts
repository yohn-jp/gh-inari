import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImplementationAuthorizationRecord } from "../implementation-authorization.js";
import type { GitHubBranchAdvanceCapability, GitDataTreeEntry } from "./git-data-capability.js";
import {
  finalizeTaskTerminationRecord,
  readTaskTerminationRecord,
  TASK_TERMINATION_METADATA_BRANCH,
  TASK_TERMINATION_RECORD_DIRECTORY,
} from "./task-termination-record.js";

const repository = { repositoryHost: "github.com", repositoryId: "415000001", repository: "yohn-jp/gh-inari" } as const;
const implementation = { ...repository, number: 1263 } as const;
const base = { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" } as const;
const authorization = {
  version: 1,
  kind: "implementation-authorization",
  contractVersion: 1,
  repository,
  implementation,
  base,
  governedBodyDigest: "b".repeat(64),
} satisfies ImplementationAuthorizationRecord;
const record = {
  version: 1,
  kind: "implementation-task-termination",
  repository,
  implementation,
  authorizationDigest: authorization.governedBodyDigest,
  base,
} as const;
const path = `${TASK_TERMINATION_RECORD_DIRECTORY}/implementation-1263.json`;
const metadataHead = "c".repeat(40);
const baseTree = "d".repeat(40);
const metadataTree = "e".repeat(40);
const nextHead = "f".repeat(40);
const nextTree = "1".repeat(40);
const blobSha = "2".repeat(40);
const zeroOid = "0".repeat(40);

type Mode = "normal" | "reject" | "lost" | "read-failure" | "race-conflict" | "base-drift-before-effect";
type Metadata =
  "missing" | "empty" | "present" | "malformed-ref" | "malformed-tree" | "bad-entry" | "missing-blob" | "read-failure";

function fixture(
  options: {
    readonly metadata?: Metadata;
    readonly existing?: unknown;
    readonly wrongScope?: boolean;
    readonly missingBase?: boolean;
    readonly driftedBase?: boolean;
  } = {},
) {
  let baseHead = options.driftedBase ? "9".repeat(40) : base.revision;
  let metadataHeadNow = options.metadata === undefined || options.metadata === "missing" ? undefined : metadataHead;
  let content = options.existing === undefined ? JSON.stringify(record) : JSON.stringify(options.existing);
  let pendingContent: string | undefined;
  let mode: Mode = "normal";
  let refCalls = 0;
  let updates = 0;
  const capability: GitHubBranchAdvanceCapability = {
    scope: {
      app: { kind: "github-app", slug: "inari-issuer", appId: "1", principal: "app:inari-issuer" },
      installation: { appId: "1", installationId: "2", repositoryHost: "github.com" },
      repository: {
        repositoryHost: "github.com",
        repositoryId: options.wrongScope ? "9" : repository.repositoryId,
        nameWithOwner: repository.repository,
      },
      repositorySelection: "selected",
      permissions: { contents: "write", metadata: "read" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    async readRef(branch) {
      refCalls += 1;
      if (mode === "read-failure" && updates > 0) throw new Error("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      if (branch === base.branch) {
        return options.missingBase ? undefined : { name: branch, ref: `refs/heads/${branch}`, sha: baseHead };
      }
      assert.equal(branch, TASK_TERMINATION_METADATA_BRANCH);
      if (options.metadata === "read-failure") throw new Error("provider unavailable");
      if (metadataHeadNow === undefined) return undefined;
      return {
        name: branch,
        ref: options.metadata === "malformed-ref" ? "refs/heads/wrong" : `refs/heads/${branch}`,
        sha: metadataHeadNow,
      };
    },
    async readCommit(sha) {
      return { sha, treeSha: sha === base.revision ? baseTree : sha === metadataHead ? metadataTree : nextTree };
    },
    async readTree(sha) {
      const entries: GitDataTreeEntry[] =
        metadataHeadNow === undefined || (metadataHeadNow === metadataHead && options.metadata === "empty")
          ? []
          : [{ path, mode: options.metadata === "bad-entry" ? "100755" : "100644", type: "blob", sha: blobSha }];
      return { sha: options.metadata === "malformed-tree" ? "3".repeat(40) : sha, entries };
    },
    async readBlob() {
      if (options.metadata === "missing-blob") throw new Error("provider unavailable");
      return content;
    },
    async createBlob(input) {
      pendingContent = Buffer.from(input.content, "base64").toString("utf8");
      return { sha: blobSha };
    },
    async createTree(input) {
      assert.equal(input.baseTreeSha, metadataHeadNow === undefined ? baseTree : metadataTree);
      assert.deepEqual(input.entries, [{ path, mode: "100644", type: "blob", sha: blobSha }]);
      return { sha: nextTree };
    },
    async createCommit(input) {
      assert.deepEqual(input.parents, [metadataHeadNow ?? base.revision]);
      if (mode === "base-drift-before-effect") baseHead = "9".repeat(40);
      return { sha: nextHead };
    },
    async compareAndAdvanceRef(input) {
      updates += 1;
      assert.deepEqual(input, {
        branch: TASK_TERMINATION_METADATA_BRANCH,
        beforeOid: metadataHeadNow ?? zeroOid,
        afterOid: nextHead,
        force: false,
      });
      if (mode === "reject") return { status: "rejected" };
      if (mode === "race-conflict") {
        content = JSON.stringify({ ...record, authorizationDigest: "9".repeat(64) });
        metadataHeadNow = nextHead;
        return { status: "rejected" };
      }
      metadataHeadNow = nextHead;
      content = pendingContent!;
      if (mode === "lost") throw new Error("github_pat_abcdefghijklmnopqrstuvwxyz0123456789");
      return { status: "updated" };
    },
  };
  return {
    capability,
    setMode: (value: Mode) => {
      mode = value;
    },
    calls: () => ({ refCalls, updates }),
    heads: () => ({ base: baseHead, metadata: metadataHeadNow }),
  };
}

test("metadata 404 is absent; validated record is present; failed and malformed reads are not absent", async () => {
  assert.equal((await readTaskTerminationRecord(fixture().capability, authorization)).status, "absent");
  assert.equal(
    (await readTaskTerminationRecord(fixture({ metadata: "empty" }).capability, authorization)).status,
    "absent",
  );
  assert.equal(
    (await readTaskTerminationRecord(fixture({ metadata: "present" }).capability, authorization)).status,
    "present",
  );
  for (const metadata of ["read-failure", "missing-blob"] as const) {
    assert.equal(
      (await readTaskTerminationRecord(fixture({ metadata }).capability, authorization)).status,
      "unavailable",
    );
  }
  for (const metadata of ["malformed-ref", "malformed-tree", "bad-entry"] as const) {
    assert.equal((await readTaskTerminationRecord(fixture({ metadata }).capability, authorization)).status, "invalid");
  }
  assert.equal(
    (await readTaskTerminationRecord(fixture({ missingBase: true }).capability, authorization)).status,
    "unavailable",
  );
  assert.equal(
    (await readTaskTerminationRecord(fixture({ driftedBase: true }).capability, authorization)).status,
    "invalid",
  );
  assert.equal(
    (
      await readTaskTerminationRecord(
        fixture({ metadata: "present", existing: { ...record, base: { ...base, revision: "0".repeat(40) } } })
          .capability,
        authorization,
      )
    ).status,
    "invalid",
  );
});

test("wrong binding, drifted base, and conflicting record deny before effect", async () => {
  for (const proposed of [
    { ...record, repository: { ...repository, repositoryId: "2" } },
    { ...record, implementation: { ...implementation, number: 99 } },
    { ...record, authorizationDigest: "0".repeat(64) },
    { ...record, base: { ...base, revision: "0".repeat(40) } },
  ]) {
    const fake = fixture();
    assert.equal((await finalizeTaskTerminationRecord(fake.capability, authorization, proposed)).status, "denied");
    assert.deepEqual(fake.calls(), { refCalls: 0, updates: 0 });
  }
  for (const fake of [
    fixture({ wrongScope: true }),
    fixture({ driftedBase: true }),
    fixture({ metadata: "present", existing: { ...record, authorizationDigest: "0".repeat(64) } }),
  ]) {
    assert.equal((await finalizeTaskTerminationRecord(fake.capability, authorization, record)).status, "denied");
    assert.equal(fake.calls().updates, 0);
  }
  const drift = fixture();
  drift.setMode("base-drift-before-effect");
  assert.equal((await finalizeTaskTerminationRecord(drift.capability, authorization, record)).status, "denied");
  assert.equal(drift.calls().updates, 0);
});

test("first creation leaves accepted base fixed and fresh observation sees record; replay is idempotent", async () => {
  const fake = fixture();
  const first = await finalizeTaskTerminationRecord(fake.capability, authorization, record);
  assert.equal(first.status, "success");
  if (first.status === "success") assert.equal(first.replay, false);
  assert.deepEqual(fake.heads(), { base: base.revision, metadata: nextHead });
  assert.equal((await readTaskTerminationRecord(fake.capability, authorization)).status, "present");
  const replay = await finalizeTaskTerminationRecord(fake.capability, authorization, record);
  assert.equal(replay.status, "success");
  if (replay.status === "success") assert.equal(replay.replay, true);
  assert.equal(fake.calls().updates, 1);
});

test("existing metadata ref advances conditionally without moving accepted base", async () => {
  const fake = fixture({ metadata: "empty" });
  assert.equal((await finalizeTaskTerminationRecord(fake.capability, authorization, record)).status, "success");
  assert.deepEqual(fake.heads(), { base: base.revision, metadata: nextHead });
  assert.equal(fake.calls().updates, 1);
});

test("CAS race, lost response, and post-effect read failure are bounded without retry or credential leakage", async () => {
  for (const mode of ["reject", "race-conflict", "lost", "read-failure"] as const) {
    const fake = fixture();
    fake.setMode(mode);
    const result = await finalizeTaskTerminationRecord(fake.capability, authorization, record);
    assert.equal(result.status, mode === "lost" ? "success" : "possible-effect");
    assert.equal(fake.calls().updates, 1);
    assert.equal(fake.heads().base, base.revision);
    assert.doesNotMatch(JSON.stringify(result), /ghp_|github_pat_|abcdefghijklmnopqrstuvwxyz0123456789/u);
  }
});
