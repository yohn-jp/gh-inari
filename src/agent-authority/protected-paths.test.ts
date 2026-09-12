import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitDelegatedWrite,
  classifyDelegatedTreeDelta,
  classifyRepositoryPath,
  RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY,
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
  type DelegatedTreeChangeOperation,
} from "./index.js";

const authorityPath = `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime.json`;
const ordinaryPath = "src/implementation.ts";
const validBranch = "feat/367-runtime-session-certificate-schemas";

function change(operation: DelegatedTreeChangeOperation, path = authorityPath, previousPath?: string) {
  return {
    operation,
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
}

function entry(path: string, sha: string) {
  return { path, sha, mode: "100644", type: "blob" as const };
}

test("derives the protected root from the canonical Runtime Authority path constants", () => {
  assert.equal(classifyRepositoryPath(RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY).kind, "protected");
  assert.equal(classifyRepositoryPath(authorityPath).kind, "protected");
  assert.equal(classifyRepositoryPath(`${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}-backup/file.json`).kind, "unprotected");
});

test("rejects traversal, separator, encoding, and Unicode-normalization path bypasses", () => {
  const invalidPaths = [
    `../${authorityPath}`,
    `./${authorityPath}`,
    `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/../outside.txt`,
    `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}//runtime.json`,
    authorityPath.replaceAll("/", "\\"),
    `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/%2e%2e/outside.txt`,
    `${RUNTIME_AUTHORITY_ARTIFACT_DIRECTORY}/fullwidth\uFF0Fseparator.json`,
  ];
  for (const path of invalidPaths) {
    assert.equal(classifyRepositoryPath(path).kind, "invalid", path);
  }
});

test("denies every direct and equivalent tree operation touching the trust root", () => {
  const cases = [
    { changes: [change("create")] },
    { changes: [change("modify")] },
    { changes: [change("delete")] },
    { changes: [change("replace")] },
    { changes: [change("rename", ordinaryPath, authorityPath)] },
    { changes: [change("rename", authorityPath, ordinaryPath)] },
    { changes: [change("delete-add", ordinaryPath, authorityPath)] },
    {
      changes: [change("delete", authorityPath), change("create", authorityPath)],
    },
    {
      changes: [change("modify", authorityPath)],
      before: [entry(authorityPath, "same-sha")],
      after: [entry(authorityPath, "same-sha")],
    },
  ];
  for (const delta of cases) {
    const result = classifyDelegatedTreeDelta(delta);
    assert.equal(result.kind, "protected", JSON.stringify(delta));
  }
});

test("detects implicit protected changes from complete before/after snapshots", () => {
  const result = classifyDelegatedTreeDelta({
    changes: [],
    before: [entry(authorityPath, "old-sha")],
    after: [entry(authorityPath, "new-sha")],
  });
  assert.equal(result.kind, "protected");
  assert.deepEqual(result.protectedPaths, [authorityPath]);
});

test("requires snapshot differences to be represented by the complete delta", () => {
  const result = classifyDelegatedTreeDelta({
    changes: [],
    before: [entry(ordinaryPath, "old-sha")],
    after: [entry(ordinaryPath, "new-sha")],
  });
  assert.equal(result.kind, "invalid");
});

test("leaves ordinary non-trust-root branch writes available", () => {
  const result = classifyDelegatedTreeDelta({ changes: [change("modify", ordinaryPath)] });
  assert.equal(result.kind, "allowed");
  assert.deepEqual(result.protectedPaths, []);
});

test("change.implement cannot authorize a trust-root mutation", () => {
  const result = admitDelegatedWrite({
    capability: { kind: "change.implement", issue: 370 },
    treeDelta: { changes: [change("modify")] },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "DELEGATED_WRITE_TRUST_ROOT_DENIED");
});

test("explicit branch.advance remains denied even with a broad optional path policy", () => {
  const result = admitDelegatedWrite({
    capability: { kind: "branch.advance", branch: validBranch, pathPolicy: "**" },
    treeDelta: { changes: [change("create")] },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "DELEGATED_WRITE_TRUST_ROOT_DENIED");
});

test("the same admission seam allows non-trust-root writes for both delegated write capabilities", () => {
  for (const capability of [
    { kind: "change.implement", issue: 370 },
    { kind: "branch.advance", branch: validBranch, pathPolicy: "**" },
  ]) {
    const result = admitDelegatedWrite({
      capability,
      treeDelta: { changes: [change("modify", ordinaryPath)] },
    });
    assert.equal(result.allowed, true, JSON.stringify(capability));
    assert.equal(result.code, "DELEGATED_WRITE_ALLOWED");
  }
});

test("fails closed for malformed complete deltas and unsupported capability input", () => {
  assert.equal(
    admitDelegatedWrite({
      capability: { kind: "branch.advance", branch: validBranch, pathPolicy: "**" },
      treeDelta: { changes: [{ operation: "rename", path: ordinaryPath }] },
    }).allowed,
    false,
  );
  assert.equal(
    admitDelegatedWrite({
      capability: { kind: "contents:write" },
      treeDelta: { changes: [change("modify")] },
    }).allowed,
    false,
  );
});
