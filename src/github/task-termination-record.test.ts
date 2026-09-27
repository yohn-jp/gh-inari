import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImplementationAuthorizationRecord } from "../implementation-authorization.js";
import type { GitHubBranchAdvanceCapability, GitDataTreeEntry } from "./git-data-capability.js";
import {
  finalizeTaskTerminationRecord,
  readTaskTerminationRecord,
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
const firstHead = "c".repeat(40);
const firstTree = "d".repeat(40);
const nextHead = "e".repeat(40);
const nextTree = "f".repeat(40);
const blobSha = "1".repeat(40);

function fixture(
  options: { readonly existing?: unknown; readonly wrongScope?: boolean; readonly missingRef?: boolean } = {},
) {
  let head = firstHead;
  let content = options.existing === undefined ? undefined : JSON.stringify(options.existing);
  let pendingContent: string | undefined;
  let updateMode: "normal" | "reject" | "lost" | "read-failure" | "race-conflict" = "normal";
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
      if (updateMode === "read-failure" && updates > 0) throw new Error("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      return options.missingRef ? undefined : { name: branch, ref: `refs/heads/${branch}`, sha: head };
    },
    async readCommit(sha) {
      return { sha, treeSha: head === firstHead ? firstTree : nextTree };
    },
    async readTree(sha) {
      const entries: GitDataTreeEntry[] =
        content === undefined ? [] : [{ path, mode: "100644", type: "blob", sha: blobSha }];
      return { sha, entries };
    },
    async readBlob() {
      if (content === undefined) throw new Error("no blob");
      return content;
    },
    async createBlob(input) {
      pendingContent = Buffer.from(input.content, "base64").toString("utf8");
      return { sha: blobSha };
    },
    async createTree(input) {
      assert.equal(input.baseTreeSha, firstTree);
      assert.deepEqual(input.entries, [{ path, mode: "100644", type: "blob", sha: blobSha }]);
      return { sha: nextTree };
    },
    async createCommit(input) {
      assert.deepEqual(input.parents, [firstHead]);
      return { sha: nextHead };
    },
    async compareAndAdvanceRef(input) {
      updates += 1;
      assert.deepEqual(input, { branch: "main", beforeOid: firstHead, afterOid: nextHead, force: false });
      if (updateMode === "reject") return { status: "rejected" };
      if (updateMode === "race-conflict") {
        content = JSON.stringify({ ...record, authorizationDigest: "9".repeat(64) });
        head = nextHead;
        return { status: "rejected" };
      }
      head = nextHead;
      content = pendingContent;
      if (updateMode === "lost") throw new Error("github_pat_abcdefghijklmnopqrstuvwxyz0123456789");
      return { status: "updated" };
    },
  };
  return {
    capability,
    setMode: (value: typeof updateMode) => {
      updateMode = value;
    },
    calls: () => ({ refCalls, updates }),
  };
}

test("authoritative empty, validated present, unavailable, and invalid evidence remain distinct", async () => {
  assert.equal((await readTaskTerminationRecord(fixture().capability, authorization)).status, "absent");
  assert.equal(
    (await readTaskTerminationRecord(fixture({ existing: record }).capability, authorization)).status,
    "present",
  );
  assert.equal(
    (await readTaskTerminationRecord(fixture({ missingRef: true }).capability, authorization)).status,
    "unavailable",
  );
  assert.equal(
    (
      await readTaskTerminationRecord(
        fixture({ existing: { ...record, base: { ...base, revision: "0".repeat(40) } } }).capability,
        authorization,
      )
    ).status,
    "invalid",
  );
});

test("wrong identity and base deny before provider reads or writes; conflicting record is preserved", async () => {
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
  const wrongScope = fixture({ wrongScope: true });
  assert.equal((await finalizeTaskTerminationRecord(wrongScope.capability, authorization, record)).status, "denied");
  assert.deepEqual(wrongScope.calls(), { refCalls: 0, updates: 0 });
  const conflict = fixture({ existing: { ...record, authorizationDigest: "0".repeat(64) } });
  assert.equal((await finalizeTaskTerminationRecord(conflict.capability, authorization, record)).status, "denied");
  assert.equal(conflict.calls().updates, 0);
});

test("conditional write requires authoritative post-read and same-event replay is idempotent", async () => {
  const fake = fixture();
  const first = await finalizeTaskTerminationRecord(fake.capability, authorization, record);
  assert.equal(first.status, "success");
  if (first.status === "success") assert.equal(first.replay, false);
  const replay = await finalizeTaskTerminationRecord(fake.capability, authorization, record);
  assert.equal(replay.status, "success");
  if (replay.status === "success") assert.equal(replay.replay, true);
  assert.equal(fake.calls().updates, 1);
});

test("CAS race, lost response, and post-effect read failure are bounded without retry or credential leakage", async () => {
  for (const mode of ["reject", "race-conflict", "lost", "read-failure"] as const) {
    const fake = fixture();
    fake.setMode(mode);
    const result = await finalizeTaskTerminationRecord(fake.capability, authorization, record);
    assert.equal(result.status, mode === "lost" ? "success" : "possible-effect");
    assert.equal(fake.calls().updates, 1);
    assert.doesNotMatch(JSON.stringify(result), /ghp_|github_pat_|abcdefghijklmnopqrstuvwxyz0123456789/u);
  }
});
