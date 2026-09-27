import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactContract } from "./artifact-contract.js";
import { compileEffectiveArtifactContract } from "./effective-artifact-contract.js";
import {
  materializeSemanticArtifact,
  tryMaterializeSemanticArtifact,
  SemanticArtifactMaterializationError,
} from "./semantic-artifact.js";
import { JSON_SCHEMA_DIALECT, type ArtifactContractProvenance } from "./ir.js";

const provenance: ArtifactContractProvenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "yohn-jp",
    name: "gh-inari",
    nameWithOwner: "yohn-jp/gh-inari",
    repositoryId: "1234",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/canon/pull-request.json",
    ref: "main",
    sha: "blob-sha",
    digest: "digest",
  },
};

const issueReference = {
  repositoryHost: "GITHUB.COM",
  repositoryId: "1234",
  repository: "YOHN-JP/GH-INARI",
  number: 283,
};

const pullRequestContract = {
  version: "1",
  kind: "pull_request",
  id: "materialization",
  properties: {
    title: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}: {slug}" } },
    },
    head: {
      presence: "required",
      authority: { kind: "derived", derive: { op: "format", template: "{type}/{slug}" } },
    },
    base: { presence: "required", authority: { kind: "fixed", value: "main" } },
    type: {
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { values: ["feat", "fix"] },
    },
    draft: { presence: "required", authority: { kind: "fixed", value: false } },
    implements: { presence: "required", authority: { kind: "supplied" } },
    reviewers: { presence: "unused" },
  },
  fields: [
    {
      id: "summary",
      primitive: "text",
      presence: "required",
      authority: { kind: "supplied" },
      constraints: { minLength: 1 },
    },
    {
      id: "slug",
      primitive: "text",
      presence: "required",
      authority: { kind: "derived", derive: { op: "slug", from: "summary" } },
    },
    {
      id: "copiedSummary",
      primitive: "text",
      presence: "optional",
      authority: { kind: "derived", derive: { op: "copy", from: "summary" } },
    },
    {
      id: "optionalNote",
      primitive: "text",
      presence: "optional",
      authority: { kind: "supplied" },
    },
  ],
} satisfies Record<string, unknown>;

const issueRelationContract = {
  version: "1",
  kind: "pull_request",
  id: "relation-modes",
  properties: {
    implements: { presence: "optional", authority: { kind: "supplied" } },
    labels: { presence: "unused" },
  },
} satisfies Record<string, unknown>;

const schemaNativeMaterializationContract = {
  version: "2",
  kind: "issue",
  id: "schema-native-materialization",
  schema: {
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties: {
      payload: {
        type: "object",
        properties: {
          headline: { type: "string", minLength: 3 },
          checks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: { label: { type: "string", minLength: 2 } },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        required: ["headline", "checks"],
        additionalProperties: false,
      },
      title: { type: "string", minLength: 1 },
      derivedTitle: { type: "string", const: "Title: Artifact" },
      fixed: { type: "object", const: { mode: "main" } },
    },
    required: ["payload", "title", "derivedTitle", "fixed"],
    additionalProperties: false,
  },
  bindings: {
    "/payload": { authority: { kind: "supplied" } },
    "/title": { authority: { kind: "supplied" } },
    "/derivedTitle": { authority: { kind: "derived", derive: { op: "format", template: "Title: {title}" } } },
    "/fixed": { authority: { kind: "fixed", value: { mode: "main" } } },
  },
} satisfies Record<string, unknown>;

function effective(input: Record<string, unknown> = pullRequestContract) {
  return compileEffectiveArtifactContract(parseArtifactContract(input), { provenance });
}

function issue(number = 283) {
  return { ...issueReference, number };
}

function materialize(input: Record<string, unknown>) {
  return materializeSemanticArtifact(effective(), input);
}

function codes(input: unknown, contract = effective()): readonly string[] {
  return tryMaterializeSemanticArtifact(contract, input).violations.map((violation) => violation.code);
}

test("materializes required supplied, fixed, derived, and copied values", () => {
  const artifact = materialize({ type: "feat", summary: "Add deterministic materialization", implements: [issue()] });

  assert.equal(artifact.kind, "pull_request");
  assert.deepEqual(artifact.values, {
    base: "main",
    draft: false,
    head: "feat/add-deterministic-materialization",
    implements: [
      {
        number: 283,
        repository: "yohn-jp/gh-inari",
        repositoryHost: "github.com",
        repositoryId: "1234",
      },
    ],
    title: "feat: add-deterministic-materialization",
    type: "feat",
  });
  assert.deepEqual(artifact.fields, {
    copiedSummary: "Add deterministic materialization",
    slug: "add-deterministic-materialization",
    summary: "Add deterministic materialization",
  });
  assert.deepEqual(artifact.relations, { implements: artifact.values.implements });
  assert.equal(artifact.relations?.implements, artifact.values.implements);
  assert.equal(artifact.generation, artifact.provenance);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.values), true);
  assert.equal(Object.isFrozen(artifact.fields), true);
});

test("accepts optional supplied input when present and omits it when absent", () => {
  const absent = materialize({ type: "fix", summary: "Repair input", implements: [issue()] });
  assert.equal(Object.hasOwn(absent.fields, "optionalNote"), false);

  const present = materialize({
    type: "fix",
    summary: "Repair input",
    optionalNote: "Additional context",
    implements: [issue()],
  });
  assert.equal(present.fields.optionalNote, "Additional context");
});

test("formats IssueReference members and materializes a derived branch identity", () => {
  const contract = effective({
    version: "1",
    kind: "branch",
    id: "derived-branch",
    properties: {
      type: {
        presence: "required",
        authority: { kind: "supplied" },
        constraints: { values: ["feat", "fix"] },
      },
      issue: { presence: "required", authority: { kind: "supplied" } },
      slug: { presence: "required", authority: { kind: "derived", derive: { op: "slug", from: "type" } } },
      name: {
        presence: "required",
        authority: { kind: "derived", derive: { op: "format", template: "{type}/{issue.number}-{slug}" } },
      },
      source: { presence: "required", authority: { kind: "fixed", value: "main" } },
    },
  });
  const artifact = materializeSemanticArtifact(contract, { type: "feat", issue: issue() });
  assert.equal(artifact.values.name, "feat/283-feat");
  assert.equal(artifact.values.source, "main");
  assert.deepEqual(contract.evaluationOrder, ["slug", "name"]);
});

test("rejects missing required supplied input and unknown caller input", () => {
  assert.ok(codes({ type: "feat", implements: [issue()] }).includes("INPUT_REQUIRED"));
  assert.deepEqual(codes({ type: "feat", summary: "x", implements: [issue()], unknown: "value" }), [
    "INPUT_UNKNOWN_FIELD",
  ]);
});

test("rejects every non-supplied authority, including equal overrides", () => {
  const input = {
    type: "feat",
    summary: "Add deterministic materialization",
    implements: [issue()],
    title: "feat: add-deterministic-materialization",
    head: "feat/add-deterministic-materialization",
    base: "main",
    draft: false,
    reviewers: [],
  };
  const result = tryMaterializeSemanticArtifact(effective(), input);
  assert.equal(result.valid, false);
  assert.equal(result.artifact, undefined);
  assert.deepEqual(
    result.violations.map((violation) => violation.path),
    ["$.base", "$.draft", "$.head", "$.reviewers", "$.title"],
  );
  assert.ok(result.violations.every((violation) => violation.code === "INPUT_AUTHORITY"));
});

test("does not synthesize platform values and materializes fixed values", () => {
  const contract = effective({
    version: "1",
    kind: "issue",
    id: "fixed-platform",
    properties: {
      labels: { presence: "optional", authority: { kind: "platform" } },
      assignees: { presence: "optional", authority: { kind: "fixed", value: ["sophia"] } },
    },
    fields: [
      {
        id: "platformNote",
        primitive: "text",
        presence: "optional",
        authority: { kind: "platform" },
      },
      {
        id: "fixedNote",
        primitive: "text",
        presence: "optional",
        authority: { kind: "fixed", value: "repository" },
      },
    ],
  });
  const artifact = materializeSemanticArtifact(contract, {});
  assert.deepEqual(artifact.values, { assignees: ["sophia"] });
  assert.deepEqual(artifact.fields, { fixedNote: "repository" });
  assert.deepEqual(codes({ labels: ["override"] }, contract), ["INPUT_AUTHORITY"]);
  assert.deepEqual(codes({ platformNote: "override" }, contract), ["INPUT_AUTHORITY"]);
});

test("materializes successfully when a required platform property or field is unresolved", () => {
  const contract = effective({
    version: "1",
    kind: "issue",
    id: "required-platform",
    properties: {
      labels: { presence: "required", authority: { kind: "platform" } },
      assignees: { presence: "optional", authority: { kind: "fixed", value: ["sophia"] } },
    },
    fields: [
      {
        id: "platformSummary",
        primitive: "text",
        presence: "required",
        authority: { kind: "platform" },
      },
      {
        id: "fixedNote",
        primitive: "text",
        presence: "optional",
        authority: { kind: "fixed", value: "repository" },
      },
    ],
  });

  const result = tryMaterializeSemanticArtifact(contract, {});
  assert.equal(result.valid, true);
  const artifact = result.artifact;
  assert.ok(artifact);
  assert.deepEqual(artifact.values, { assignees: ["sophia"] });
  assert.deepEqual(artifact.fields, { fixedNote: "repository" });
  assert.equal(Object.hasOwn(artifact.values, "labels"), false);
  assert.equal(Object.hasOwn(artifact.fields, "platformSummary"), false);

  // Caller override of a required platform value still fails closed.
  assert.deepEqual(codes({ labels: ["override"] }, contract), ["INPUT_AUTHORITY"]);
  assert.deepEqual(codes({ platformSummary: "override" }, contract), ["INPUT_AUTHORITY"]);
});

test("rejects a missing required derived value when its optional dependency is unavailable", () => {
  const contract = parseArtifactContract({
    version: "1",
    kind: "branch",
    id: "missing-derived-source",
    properties: {
      slug: { presence: "optional", authority: { kind: "supplied" } },
      name: {
        presence: "required",
        authority: { kind: "derived", derive: { op: "format", template: "branch/{slug}" } },
      },
    },
  });
  const result = tryMaterializeSemanticArtifact(compileEffectiveArtifactContract(contract, { provenance }), {});
  assert.deepEqual(
    result.violations.map((violation) => violation.code),
    ["DERIVATION_UNRESOLVED"],
  );
});

test("supports optional, required, and unused PR implements relation declarations", () => {
  const optional = effective(issueRelationContract);
  assert.deepEqual(materializeSemanticArtifact(optional, {}).values, {});
  assert.deepEqual(materializeSemanticArtifact(optional, { implements: [issue(281)] }).relations, {
    implements: [
      {
        number: 281,
        repository: "yohn-jp/gh-inari",
        repositoryHost: "github.com",
        repositoryId: "1234",
      },
    ],
  });

  const requiredContract = compileEffectiveArtifactContract(
    parseArtifactContract({
      ...issueRelationContract,
      id: "required-relation",
      properties: { implements: { presence: "required", authority: { kind: "supplied" } } },
    }),
    { provenance },
  );
  assert.deepEqual(codes({}, requiredContract), ["INPUT_REQUIRED"]);

  const unusedContract = effective({
    ...issueRelationContract,
    id: "unused-relation",
    properties: { implements: { presence: "unused" } },
  });
  assert.deepEqual(codes({ implements: [issue()] }, unusedContract), ["INPUT_AUTHORITY"]);
});

test("uses the compiled evaluation order and produces deterministic output", () => {
  const first = materialize({ type: "feat", summary: "Stable output", implements: [issue()] });
  const second = materialize({ implements: [issue()], summary: "Stable output", type: "feat" });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(effective().evaluationOrder, ["copiedSummary", "slug", "head", "title"]);
});

test("fails closed for malformed or inconsistent Effective Contracts", () => {
  const malformed = structuredClone(effective()) as unknown as Record<string, unknown>;
  malformed.evaluationOrder = [...(malformed.evaluationOrder as string[])].reverse();
  assert.deepEqual(codes({ type: "feat", summary: "x", implements: [issue()] }, malformed as never), [
    "EFFECTIVE_CONTRACT_INVALID",
  ]);
});

test("does not mutate caller input or Effective Contract", () => {
  const contract = effective();
  const input = { type: "feat", summary: "Do not mutate", implements: [issue()] };
  const inputBefore = structuredClone(input);
  const contractBefore = JSON.stringify(contract);
  materializeSemanticArtifact(contract, input);
  assert.deepEqual(input, inputBefore);
  assert.equal(JSON.stringify(contract), contractBefore);
});

test("throws a structured error on failed materialization", () => {
  assert.throws(
    () => materialize({ type: "feat", summary: "missing relation" }),
    (error: unknown) => {
      assert.ok(error instanceof SemanticArtifactMaterializationError);
      assert.deepEqual(
        error.violations.map((violation) => violation.code),
        ["INPUT_REQUIRED"],
      );
      return true;
    },
  );
});

test("materializes nested schema-native values and validates fixed and derived values against the source schema", () => {
  const contract = effective(schemaNativeMaterializationContract);
  const input = {
    payload: { headline: "Stable output", checks: [{ label: "CI" }] },
    title: "Artifact",
  };
  const artifact = materializeSemanticArtifact(contract, input);

  assert.deepEqual(artifact.values, {
    derivedTitle: "Title: Artifact",
    fixed: { mode: "main" },
    payload: { headline: "Stable output", checks: [{ label: "CI" }] },
    title: "Artifact",
  });
  assert.deepEqual(artifact.fields, {});

  const invalidDerived = effective({
    ...schemaNativeMaterializationContract,
    id: "schema-native-invalid-derived",
    bindings: {
      ...schemaNativeMaterializationContract.bindings,
      "/derivedTitle": { authority: { kind: "derived", derive: { op: "format", template: "Other: {title}" } } },
    },
  });
  const derivedFailure = tryMaterializeSemanticArtifact(invalidDerived, input);
  assert.deepEqual(
    derivedFailure.violations.map(({ code, path }) => ({ code, path })),
    [{ code: "OUTPUT_INVALID", path: "/derivedTitle" }],
  );

  const invalidFixed = effective({
    ...schemaNativeMaterializationContract,
    id: "schema-native-invalid-fixed",
    bindings: {
      ...schemaNativeMaterializationContract.bindings,
      "/fixed": { authority: { kind: "fixed", value: { mode: "wrong" } } },
    },
  });
  const fixedFailure = tryMaterializeSemanticArtifact(invalidFixed, input);
  assert.deepEqual(
    fixedFailure.violations.map(({ code, path }) => ({ code, path })),
    [{ code: "OUTPUT_INVALID", path: "/fixed" }],
  );

  const authorityFailure = tryMaterializeSemanticArtifact(contract, { ...input, fixed: "wrong shape" });
  assert.deepEqual(
    authorityFailure.violations.map(({ code }) => code),
    ["INPUT_AUTHORITY"],
  );
});

test("bounds schema-native nested-value diagnostics from the shared runtime", () => {
  const contract = effective(schemaNativeMaterializationContract);
  const checks = Array.from({ length: 24 }, () => ({ label: "x" }));
  const result = tryMaterializeSemanticArtifact(contract, {
    payload: { headline: "Stable output", checks },
    title: "Artifact",
  });

  assert.equal(result.valid, false);
  assert.equal(result.violations.length, 16);
  assert.ok(result.violations.every((violation) => violation.code === "INPUT_TYPE"));
  assert.ok(result.violations.every((violation) => violation.path.length <= 256));
  assert.ok(result.violations.every((violation) => !violation.message.includes('"x"')));

  const unknown = tryMaterializeSemanticArtifact(contract, { ["x".repeat(10_000)]: "untrusted key" });
  assert.equal(unknown.violations.length, 1);
  assert.equal(unknown.violations[0]?.code, "INPUT_UNKNOWN_FIELD");
  assert.ok((unknown.violations[0]?.path.length ?? 0) <= 256);
  assert.ok((unknown.violations[0]?.message.length ?? 0) <= 256);
});

test("schema-native materialization preserves unresolved platform-owned values", () => {
  const contract = effective({
    version: "2",
    kind: "issue",
    id: "schema-native-platform",
    schema: {
      $schema: JSON_SCHEMA_DIALECT,
      type: "object",
      properties: { labels: { type: "array", items: { type: "string" } } },
      required: ["labels"],
      additionalProperties: false,
    },
    bindings: { "/labels": { authority: { kind: "platform" } } },
  });

  assert.deepEqual(materializeSemanticArtifact(contract, {}).values, {});
  assert.deepEqual(
    tryMaterializeSemanticArtifact(contract, { labels: ["override"] }).violations.map(({ code }) => code),
    ["INPUT_AUTHORITY"],
  );
});

test("schema-native relation values retain IssueReference normalization and identity checks", () => {
  const referenceSchema = {
    type: "object",
    properties: {
      repositoryHost: { type: "string", minLength: 1, pattern: "^[^\\s/]+$" },
      repositoryId: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
      repository: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$" },
      number: { type: "integer", minimum: 1 },
    },
    required: ["repositoryHost", "repositoryId", "number"],
    additionalProperties: false,
  };
  const contract = effective({
    version: "2",
    kind: "pull_request",
    id: "schema-native-relation",
    schema: {
      $schema: JSON_SCHEMA_DIALECT,
      type: "object",
      properties: { implements: { type: "array", items: referenceSchema, uniqueItems: true } },
      additionalProperties: false,
    },
    bindings: { "/implements": { authority: { kind: "supplied" } } },
  });
  const rawReference = {
    repositoryHost: "GITHUB.COM",
    repositoryId: "1234",
    repository: "YOHN-JP/GH-INARI",
    number: 283,
  };
  const artifact = materializeSemanticArtifact(contract, { implements: [rawReference] });
  assert.deepEqual(artifact.relations?.implements, [
    { repositoryHost: "github.com", repositoryId: "1234", repository: "yohn-jp/gh-inari", number: 283 },
  ]);

  for (const duplicateValues of [
    [rawReference, rawReference],
    [rawReference, { ...rawReference, repositoryHost: "github.com", repository: "yohn-jp/gh-inari" }],
  ]) {
    const duplicate = tryMaterializeSemanticArtifact(contract, { implements: duplicateValues });
    assert.deepEqual(
      duplicate.violations.map(({ code }) => code),
      ["INPUT_DUPLICATE"],
    );
  }
});
