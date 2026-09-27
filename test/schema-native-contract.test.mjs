import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileEffectiveArtifactContract,
  materializeSemanticArtifact,
  parseArtifactContract,
  projectArtifactContractToIssueForm,
} from "../src/contract/index.ts";
import { parseExistingPullRequestArtifact, renderPullRequestArtifact } from "../src/artifact.ts";

const provenance = {
  authority: "repository-default-branch",
  repository: {
    host: "github.com",
    owner: "yohn-jp",
    name: "gh-inari",
    nameWithOwner: "yohn-jp/gh-inari",
    repositoryId: "1330755860",
  },
  ref: "main",
  treeSha: "tree-sha",
  source: {
    path: ".github/inari/pull-requests/structured-verification.json",
    ref: "main",
    sha: "blob-sha",
    digest: "source-digest",
  },
};

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    context: {
      type: "object",
      properties: {
        component: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
      },
      required: ["component", "rationale"],
      additionalProperties: false,
    },
    verification: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          scope: { type: "string", minLength: 1 },
          command: { type: "string", minLength: 1 },
          outcome: { type: "string", enum: ["passed", "failed", "blocked"] },
          summary: { type: "string", minLength: 1 },
        },
        required: ["scope", "command", "outcome", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "context", "verification"],
  additionalProperties: false,
};

const sourceContract = {
  version: "2",
  kind: "pull_request",
  id: "structured-verification",
  schema,
  bindings: {
    "/summary": { authority: { kind: "supplied" } },
    "/context": { authority: { kind: "supplied" } },
    "/verification": { authority: { kind: "supplied" }, presentation: { control: "checklist" } },
  },
};

const supplied = {
  summary: "Keep the verification record structured",
  context: {
    component: "schema-native artifact pipeline",
    rationale: "Preserve the verification facts as typed values.",
  },
  verification: [
    {
      scope: "nested contract materialization",
      command: "node --test --import tsx test/schema-native-contract.test.mjs",
      outcome: "passed",
      summary: "Nested verification data survives PR Markdown projection and observation.",
    },
  ],
};

test("schema-native contract materializes and round-trips structured PR verification", () => {
  const contract = parseArtifactContract(sourceContract);
  const effective = compileEffectiveArtifactContract(contract, { provenance });

  assert.deepEqual(effective.inputSchema.properties.context, schema.properties.context);
  assert.deepEqual(effective.inputSchema.properties.verification, schema.properties.verification);

  const artifact = materializeSemanticArtifact(effective, supplied);
  assert.deepEqual(artifact.values, supplied);

  const body = renderPullRequestArtifact(contract, artifact.values);
  const observed = parseExistingPullRequestArtifact(contract, body);
  assert.equal(observed.parsed, true);
  assert.deepEqual(observed.values, supplied);
});

test("schema-native Issue Form projection fails closed for structured values", () => {
  assert.throws(
    () => projectArtifactContractToIssueForm({ ...sourceContract, kind: "issue", id: "structured-issue" }),
    (error) =>
      error.violations?.some((violation) => violation.code === "NATIVE_TEMPLATE_PROJECTION_UNSUPPORTED_CAPABILITY") ===
      true,
  );
});
