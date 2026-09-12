import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalRuntimeAuthorityJson,
  RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX,
} from "../src/agent-authority/runtime-authority.ts";
import {
  RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME,
  snapshotEntry,
  validateRuntimeAuthorityGitTransition,
  validateRuntimeAuthorityTransition,
} from "./validate-runtime-authority-governance.mjs";

const KEY_A = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) };
const KEY_B = { kty: "OKP", crv: "Ed25519", x: "B".repeat(43) };
const KEY_C = { kty: "OKP", crv: "Ed25519", x: "C".repeat(43) };

function authority(id, key = KEY_A, overrides = {}) {
  return {
    version: 1,
    kind: "runtime-authority",
    id,
    key,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 7200,
    capabilityCeiling: ["change.implement"],
    ...overrides,
  };
}

function file(id, value, options = {}) {
  return [
    `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}${id}.json`,
    snapshotEntry(typeof value === "string" ? value : canonicalRuntimeAuthorityJson(value), options.mode, options.type),
  ];
}

function report(base, head) {
  return validateRuntimeAuthorityTransition({ base: new Map(base), head: new Map(head) });
}

test("reports the stable dedicated check and permits active registration and overlap rotation", () => {
  const oldAuthority = authority("runtime-old", KEY_A);
  const newAuthority = authority("runtime-new", KEY_B);
  const result = report(
    [file("runtime-old", oldAuthority)],
    [file("runtime-old", oldAuthority), file("runtime-new", newAuthority)],
  );
  assert.equal(result.check, RUNTIME_AUTHORITY_GOVERNANCE_CHECK_NAME);
  assert.equal(result.valid, true);
  assert.deepEqual(result.created, [`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-new.json`]);
  assert.deepEqual(result.revoked, []);
});

test("permits active-to-disabled revocation, including the last active authority, and idempotent disabled state", () => {
  const active = authority("runtime-only", KEY_A);
  const disabled = authority("runtime-only", KEY_A, { status: "disabled" });
  const revoked = report([file("runtime-only", active)], [file("runtime-only", disabled)]);
  assert.equal(revoked.valid, true);
  assert.deepEqual(revoked.revoked, [`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-only.json`]);

  const repeated = report([file("runtime-only", disabled)], [file("runtime-only", disabled)]);
  assert.equal(repeated.valid, true);
  assert.equal(repeated.changed, false);
});

test("rejects deletion, reactivation, immutable mutations, and mixed phases", () => {
  const active = authority("runtime-a", KEY_A);
  const disabled = authority("runtime-a", KEY_A, { status: "disabled" });
  assert.equal(report([file("runtime-a", active)], []).valid, false);
  assert.equal(report([file("runtime-a", disabled)], [file("runtime-a", active)]).valid, false);
  assert.equal(
    report([file("runtime-a", active)], [file("runtime-a", authority("runtime-a", KEY_B, { status: "disabled" }))])
      .valid,
    false,
  );
  assert.equal(
    report([file("runtime-a", active)], [file("runtime-a", disabled), file("runtime-b", authority("runtime-b", KEY_B))])
      .valid,
    false,
  );
});

test("rejects malformed, noncanonical, path-mismatched, and unsupported artifacts", () => {
  const active = authority("runtime-a", KEY_A);
  const malformed = report([], [[`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, snapshotEntry("{")]]);
  assert.equal(malformed.valid, false);

  const noncanonical = report(
    [],
    [[`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, snapshotEntry(JSON.stringify(active, null, 2))]],
  );
  assert.equal(noncanonical.valid, false);

  const mismatch = report(
    [],
    [
      [
        `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`,
        snapshotEntry(canonicalRuntimeAuthorityJson(authority("runtime-b", KEY_A))),
      ],
    ],
  );
  assert.equal(mismatch.valid, false);

  const unsupported = report(
    [],
    [
      [`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.txt`, snapshotEntry("not-json")],
      [
        `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}nested/runtime-b.json`,
        snapshotEntry(canonicalRuntimeAuthorityJson(authority("runtime-b", KEY_B))),
      ],
      [
        `${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-c.json`,
        snapshotEntry(canonicalRuntimeAuthorityJson(authority("runtime-c", KEY_C)), "120000", "blob"),
      ],
    ],
  );
  assert.equal(unsupported.valid, false);
});

test("rejects duplicate authority identifiers and Ed25519 public keys", () => {
  const duplicateKey = report(
    [],
    [file("runtime-a", authority("runtime-a", KEY_A)), file("runtime-b", authority("runtime-b", KEY_A))],
  );
  assert.equal(duplicateKey.valid, false);
  assert.ok(duplicateKey.violations.some((entry) => entry.code === "RUNTIME_AUTHORITY_DUPLICATE_PUBLIC_KEY"));

  const duplicateId = report(
    [],
    [file("runtime-a", authority("runtime-a", KEY_A)), file("runtime-b", authority("runtime-a", KEY_B))],
  );
  assert.equal(duplicateId.valid, false);
  assert.ok(duplicateId.violations.some((entry) => entry.code === "RUNTIME_AUTHORITY_DUPLICATE_ID"));
  assert.ok(duplicateId.violations.some((entry) => entry.code === "RUNTIME_AUTHORITY_PATH_ID_MISMATCH"));
});

test("validates complete base and head snapshots, including unchanged malformed base records", () => {
  const valid = authority("runtime-a", KEY_A);
  const malformedBase = report(
    [[`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`, snapshotEntry("{}")]],
    [file("runtime-a", valid), file("runtime-b", authority("runtime-b", KEY_B))],
  );
  assert.equal(malformedBase.valid, false);
  assert.ok(malformedBase.violations.some((entry) => entry.side === "base"));

  const unchanged = report([file("runtime-a", valid)], [file("runtime-a", valid)]);
  assert.equal(unchanged.valid, true);
  assert.equal(unchanged.changed, false);
});

test("reads exact base and head commits for the offline PR authority", () => {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "inari-runtime-authority-governance-git-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.name", "governance-test"], { cwd: repositoryRoot });
    execFileSync("git", ["config", "user.email", "governance-test@example.invalid"], { cwd: repositoryRoot });
    writeFileSync(path.join(repositoryRoot, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repositoryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repositoryRoot });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();

    const directory = path.join(repositoryRoot, ".github", "inari", "authorities");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "runtime-a.json"), canonicalRuntimeAuthorityJson(authority("runtime-a", KEY_A)));
    execFileSync("git", ["add", ".github"], { cwd: repositoryRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "register"], { cwd: repositoryRoot });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();

    const result = validateRuntimeAuthorityGitTransition(repositoryRoot, base, head);
    assert.equal(result.valid, true);
    assert.deepEqual(result.created, [`${RUNTIME_AUTHORITY_ARTIFACT_PATH_PREFIX}runtime-a.json`]);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
