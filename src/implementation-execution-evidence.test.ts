import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
  IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
  ImplementationExecutionEvidenceError,
  parseImplementationExecutionEvidence,
  tryParseImplementationExecutionEvidence,
} from "./implementation-execution-evidence.js";

const IMPLEMENTATION = {
  repositoryHost: "github.com",
  repositoryId: "415000001",
  repository: "acme/inari",
  number: 42,
};
const REPOSITORY = { repositoryHost: "github.com", repositoryId: "415000001", repository: "acme/inari" };
const BASE = { branch: "main", revision: "a".repeat(40), freshness: "a".repeat(40) };
const DIGEST = "b".repeat(64);

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: IMPLEMENTATION_EXECUTION_EVIDENCE_VERSION,
    kind: IMPLEMENTATION_EXECUTION_EVIDENCE_KIND,
    implementation: IMPLEMENTATION,
    repository: REPOSITORY,
    governedBodyDigest: DIGEST,
    base: BASE,
    branch: "feat/642-evidence",
    headRevision: "c".repeat(40),
    targetedTests: [
      { command: "pnpm test", result: "satisfied" },
      { command: "pnpm run lint", result: "failed" },
    ],
    ...overrides,
  };
}

test("a canonical execution-evidence input parses into deterministic immutable evidence", () => {
  const result = tryParseImplementationExecutionEvidence(valid());
  assert.equal(result.valid, true);
  assert.ok(result.evidence);
  assert.equal(result.evidence.version, 1);
  assert.equal(result.evidence.kind, "implementation-execution-evidence");
  assert.equal(result.evidence.branch, "feat/642-evidence");
  assert.equal(result.evidence.headRevision, "c".repeat(40));
  assert.deepEqual(
    result.evidence.targetedTests.map((entry) => entry.command),
    ["pnpm test", "pnpm run lint"],
  );
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.evidence.targetedTests), true);
  assert.throws(() => {
    (result.evidence!.targetedTests as unknown as unknown[]).push({});
  });
});

test("parsing the same input twice is deterministic", () => {
  const first = tryParseImplementationExecutionEvidence(valid());
  const second = tryParseImplementationExecutionEvidence(valid());
  assert.deepEqual(first.evidence, second.evidence);
});

test("unknown top-level and nested properties are rejected", () => {
  const result = tryParseImplementationExecutionEvidence({ ...valid(), extra: true });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.path === "$.extra"));

  const nested = tryParseImplementationExecutionEvidence({ ...valid(), base: { ...BASE, extra: true } });
  assert.equal(nested.valid, false);
  assert.ok(nested.violations.some((violation) => violation.path === "$.base.extra"));
});

test("version and kind must be exact", () => {
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), version: 2 }).valid, false);
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), kind: "other" }).valid, false);
});

test("implementation reference and repository identity use canonical semantics", () => {
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), implementation: {} }).valid, false);
  assert.equal(
    tryParseImplementationExecutionEvidence({ ...valid(), repository: { repositoryHost: "github.com" } }).valid,
    false,
  );
  assert.equal(
    tryParseImplementationExecutionEvidence({
      ...valid(),
      repository: { ...REPOSITORY, repositoryId: "not-a-number" },
    }).valid,
    false,
  );
});

test("governedBodyDigest must be canonical lowercase SHA-256 hex", () => {
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), governedBodyDigest: "not-hex" }).valid, false);
  assert.equal(
    tryParseImplementationExecutionEvidence({ ...valid(), governedBodyDigest: "B".repeat(64) }).valid,
    false,
  );
});

test("base branch/revision/freshness follow authorization's base-evidence semantics", () => {
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), base: { ...BASE, branch: "" } }).valid, false);
  assert.equal(
    tryParseImplementationExecutionEvidence({ ...valid(), base: { ...BASE, revision: undefined } }).valid,
    false,
  );
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), base: { ...BASE, branch: "-bad" } }).valid, false);
});

test("exactly one valid branch and one non-empty head revision are required", () => {
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), branch: "" }).valid, false);
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), branch: undefined }).valid, false);
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), headRevision: "" }).valid, false);
  assert.equal(tryParseImplementationExecutionEvidence({ ...valid(), headRevision: 42 }).valid, false);
});

test("targeted-test results permit only satisfied or failed", () => {
  const result = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [{ command: "pnpm test", result: "passed" }],
  });
  assert.equal(result.valid, false);
});

test("duplicate targeted-test commands invalidate the whole evidence, independent of order", () => {
  const first = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [
      { command: "pnpm test", result: "satisfied" },
      { command: "pnpm test", result: "failed" },
    ],
  });
  assert.equal(first.valid, false);
  const reordered = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [
      { command: "pnpm test", result: "failed" },
      { command: "pnpm test", result: "satisfied" },
    ],
  });
  assert.equal(reordered.valid, false);
});

test("targeted tests may be empty", () => {
  const result = tryParseImplementationExecutionEvidence({ ...valid(), targetedTests: [] });
  assert.equal(result.valid, true);
  assert.deepEqual(result.evidence?.targetedTests, []);
});

test("targeted-test command identity is preserved verbatim: no trim, NFKC, or newline normalization", () => {
  const paddedCommand = "  pnpm test  ";
  const padded = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [{ command: paddedCommand, result: "satisfied" }],
  });
  assert.equal(padded.valid, true);
  assert.equal(padded.evidence?.targetedTests[0]?.command, paddedCommand);

  const fullwidthCommand = "pnpm test --shard=１/2";
  const fullwidth = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [{ command: fullwidthCommand, result: "satisfied" }],
  });
  assert.equal(fullwidth.valid, true);
  assert.equal(fullwidth.evidence?.targetedTests[0]?.command, fullwidthCommand);
  assert.notEqual(fullwidth.evidence?.targetedTests[0]?.command, "pnpm test --shard=1/2");

  const distinct = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [
      { command: "pnpm test", result: "satisfied" },
      { command: " pnpm test", result: "failed" },
    ],
  });
  assert.equal(distinct.valid, true);
  assert.deepEqual(
    distinct.evidence?.targetedTests.map((entry) => entry.command),
    ["pnpm test", " pnpm test"],
  );
});

test("a bare CR or LF inside a targeted-test command is rejected, not silently collapsed to LF", () => {
  const crlf = tryParseImplementationExecutionEvidence({
    ...valid(),
    targetedTests: [{ command: "pnpm test\r\nrm -rf /", result: "satisfied" }],
  });
  assert.equal(crlf.valid, false);
  assert.equal(
    crlf.violations.some((violation) => violation.path === "$.targetedTests[0].command"),
    true,
  );
});

test("execution binding fields do not accept normalization-dependent structural identities", () => {
  assert.equal(
    tryParseImplementationExecutionEvidence({ ...valid(), governedBodyDigest: ` ${DIGEST}` }).valid,
    false,
  );
  assert.equal(
    tryParseImplementationExecutionEvidence({ ...valid(), branch: "feat/６７０-evidence" }).valid,
    false,
  );
  assert.equal(
    tryParseImplementationExecutionEvidence({ ...valid(), base: { ...BASE, branch: "ｍain" } }).valid,
    false,
  );
});

test("opaque execution binding identities preserve exact whitespace instead of trimming", () => {
  const revision = ` ${BASE.revision}`;
  const freshness = `${BASE.freshness} `;
  const headRevision = ` ${"c".repeat(40)} `;
  const result = tryParseImplementationExecutionEvidence({
    ...valid(),
    base: { ...BASE, revision, freshness },
    headRevision,
  });
  assert.equal(result.valid, true);
  assert.equal(result.evidence?.base.revision, revision);
  assert.equal(result.evidence?.base.freshness, freshness);
  assert.equal(result.evidence?.headRevision, headRevision);
});

test("the throwing entry point mirrors the non-throwing result", () => {
  const evidence = parseImplementationExecutionEvidence(valid());
  assert.equal(evidence.branch, "feat/642-evidence");
  assert.throws(
    () => parseImplementationExecutionEvidence({ ...valid(), version: 99 }),
    ImplementationExecutionEvidenceError,
  );
});
