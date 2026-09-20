import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  compareImplementationScopeConformance,
  isImplementationScopeConformanceCorpus,
  produceImplementationScopeConformance,
  validateImplementationScopeConformanceCorpus,
  type ImplementationScopeConformanceCorpus,
  type ImplementationScopeConformanceFixture,
} from "./implementation-scope-conformance.js";

const corpus = JSON.parse(
  readFileSync(new URL("../test/fixtures/implementation-scope-conformance-v1.json", import.meta.url), "utf8"),
) as ImplementationScopeConformanceCorpus;

function fixture(name: string): ImplementationScopeConformanceFixture {
  const found = corpus.fixtures.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing conformance fixture: ${name}`);
  return found;
}

test("v1 corpus is closed, versioned, and semantically produced by Inari", () => {
  const validation = validateImplementationScopeConformanceCorpus(corpus);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.diagnostics, []);
  assert.equal(isImplementationScopeConformanceCorpus(corpus), true);
  for (const candidate of corpus.fixtures)
    assert.deepEqual(produceImplementationScopeConformance(candidate), candidate.expected, candidate.name);
});

test("positive operation decisions remain independent and DENY has precedence", () => {
  const result = fixture("canonical-operation-separation").expected;
  const allowed = result.decisions.filter((decision) => decision.allowed);
  assert.deepEqual(
    allowed.map((decision) => `${decision.operation}:${decision.path}`),
    [
      "READONLY:AGENTS.md",
      "READONLY:docs/guides/index.md",
      "WRITE:src/lib/index.ts",
      "CREATE:src/implementation-scope-conformance.ts",
      "DELETE:test/fixtures/old.json",
    ],
  );
  const deniedWrite = result.decisions.find(
    (decision) => decision.operation === "WRITE" && decision.path === "src/github/client.ts",
  );
  assert.deepEqual(deniedWrite, {
    operation: "WRITE",
    path: "src/github/client.ts",
    matched: true,
    denied: true,
    allowed: false,
  });
  const denyProbe = result.decisions.find(
    (decision) => decision.operation === "DENY" && decision.path === "src/github/client.ts",
  );
  assert.equal(denyProbe?.matched, true);
  assert.equal(denyProbe?.allowed, false);
});

test("selector semantics and exact path identity fail closed across path forms", () => {
  const result = fixture("canonical-operation-separation").expected;
  for (const path of [
    "src/lib/deep/index.ts",
    "src\\lib\\index.ts",
    "./src/lib/index.ts",
    "src//lib/index.ts",
    "C:/src/lib/index.ts",
    null,
  ]) {
    const decision = result.decisions.find((candidate) => candidate.operation === "WRITE" && candidate.path === path);
    assert.equal(decision?.matched, false, String(path));
    assert.equal(decision?.allowed, false, String(path));
  }
  assert.equal(fixture("noncanonical-selector-rejected").expected.applicability.status, "unsupported");
});

test("repository, base, authorization, and artifact version applicability are semantic gates", () => {
  assert.equal(fixture("repository-mismatch").expected.applicability.status, "mismatch");
  assert.equal(fixture("base-branch-mismatch").expected.applicability.status, "mismatch");
  assert.equal(fixture("base-revision-stale").expected.applicability.status, "stale");
  assert.equal(fixture("base-freshness-stale").expected.applicability.status, "stale");
  assert.equal(fixture("authorization-stale").expected.applicability.status, "mismatch");
  assert.equal(fixture("unsupported-artifact-version").expected.applicability.status, "unsupported");
  for (const candidate of corpus.fixtures.filter((item) => item.name !== "canonical-operation-separation"))
    assert.equal(
      candidate.expected.decisions.every((decision) => decision.allowed === false),
      true,
      candidate.name,
    );
});

test("schema-valid but semantically widened results fail the conformance gate", () => {
  const candidate = fixture("canonical-operation-separation");
  const tampered = structuredClone(candidate.expected) as unknown as {
    decisions: Array<{ operation: string; path: unknown; matched: boolean; denied: boolean; allowed: boolean }>;
  };
  tampered.decisions[5] = { ...tampered.decisions[5], allowed: true };
  const comparison = compareImplementationScopeConformance(candidate, tampered);
  assert.equal(comparison.valid, false);
  assert.deepEqual(
    comparison.mismatches.map((diagnostic) => diagnostic.code),
    ["CONFORMANCE_SEMANTIC_MISMATCH"],
  );

  const alteredCorpus = structuredClone(corpus) as ImplementationScopeConformanceCorpus;
  const alteredExpected = alteredCorpus.fixtures[0]?.expected as unknown as
    | { decisions: Array<{ operation: string; path: unknown; matched: boolean; denied: boolean; allowed: boolean }> }
    | undefined;
  if (alteredExpected === undefined) throw new Error("Corpus must contain the canonical fixture.");
  alteredExpected.decisions[5] = { ...alteredExpected.decisions[5], allowed: true };
  const validation = validateImplementationScopeConformanceCorpus(alteredCorpus);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === "CONFORMANCE_EXPECTATION_MISMATCH"));
});
