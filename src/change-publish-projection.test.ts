import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectPublishTreeDelta, PublishProjectionError, resolvePublishCommit } from "./change-publish-projection.js";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "publish-projection-"));
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["config", "user.email", "agent@example.com"]);
  git(dir, ["config", "user.name", "Agent"]);
  return dir;
}

async function commit(dir: string, message: string): Promise<string> {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

test("compiles the exact bounded upsert/delete delta relative to the expected head", async () => {
  const dir = await initRepo();
  try {
    await writeFile(path.join(dir, "keep.txt"), "keep\n");
    await writeFile(path.join(dir, "remove.txt"), "gone\n");
    const base = await commit(dir, "base");

    await writeFile(path.join(dir, "keep.txt"), "keep-changed\n");
    await rm(path.join(dir, "remove.txt"));
    await writeFile(path.join(dir, "added.txt"), "added\n");
    const head = await commit(dir, "implement feature");

    const projection = projectPublishTreeDelta({ cwd: dir, commit: head, expectedHead: base });
    assert.equal(projection.commit, head);
    assert.equal(projection.expectedHead, base);
    assert.equal(projection.commitMetadata.message, "implement feature");
    assert.equal(projection.commitMetadata.author?.email, "agent@example.com");

    const byPath = new Map(projection.changes.map((change) => [change.path, change]));
    assert.equal(byPath.size, 3);
    assert.deepEqual(byPath.get("remove.txt"), { operation: "delete", path: "remove.txt" });
    const keep = byPath.get("keep.txt");
    assert.ok(keep !== undefined && keep.operation === "upsert");
    assert.equal(keep.mode, "100644");
    assert.equal(Buffer.from(keep.content, "base64").toString("utf8"), "keep-changed\n");
    const added = byPath.get("added.txt");
    assert.ok(added !== undefined && added.operation === "upsert");
    assert.equal(Buffer.from(added.content, "base64").toString("utf8"), "added\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolvePublishCommit fails closed for an unresolvable rev", async () => {
  const dir = await initRepo();
  try {
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await commit(dir, "base");
    assert.throws(
      () => resolvePublishCommit(dir, "does-not-exist"),
      (error: unknown) => error instanceof PublishProjectionError && error.code === "PUBLISH_PROJECTION_INVALID_COMMIT",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails closed when the expected head is unrelated history", async () => {
  const dir = await initRepo();
  const otherDir = await initRepo();
  try {
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await commit(dir, "base");

    await writeFile(path.join(otherDir, "b.txt"), "b\n");
    const unrelated = await commit(otherDir, "unrelated");

    assert.throws(
      () => projectPublishTreeDelta({ cwd: dir, commit: "HEAD", expectedHead: unrelated }),
      (error: unknown) =>
        error instanceof PublishProjectionError && error.code === "PUBLISH_PROJECTION_UNRELATED_HISTORY",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  }
});

test("fails closed for an unsupported Git object mode such as a symlink", async () => {
  const dir = await initRepo();
  try {
    await writeFile(path.join(dir, "a.txt"), "a\n");
    const base = await commit(dir, "base");

    await symlink("a.txt", path.join(dir, "link.txt"));
    const head = await commit(dir, "add symlink");

    assert.throws(
      () => projectPublishTreeDelta({ cwd: dir, commit: head, expectedHead: base }),
      (error: unknown) =>
        error instanceof PublishProjectionError && error.code === "PUBLISH_PROJECTION_UNSUPPORTED_MODE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails closed when the commit has no changes relative to the expected head", async () => {
  const dir = await initRepo();
  try {
    await writeFile(path.join(dir, "a.txt"), "a\n");
    const base = await commit(dir, "base");

    assert.throws(
      () => projectPublishTreeDelta({ cwd: dir, commit: base, expectedHead: base }),
      (error: unknown) => error instanceof PublishProjectionError && error.code === "PUBLISH_PROJECTION_NO_CHANGES",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
