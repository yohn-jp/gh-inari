import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestContractFixture } from "./contract/fixtures.js";
import {
  PR_SYNC_INPUT_CONTRACT,
  minimalPullRequestSyncInput,
  parsePullRequestSyncInput,
  projectPullRequestSyncInput,
  renderPullRequestSyncInputHelp,
} from "./pr-sync-input.js";
import { projectToJsonSchema } from "./contract/schema.js";
import { validateSemanticInput } from "./contract/validation.js";

test("PR sync projection derives its top-level schema and valid example from one contract", () => {
  const projection = projectPullRequestSyncInput(pullRequestContractFixture);
  const required = Object.entries(PR_SYNC_INPUT_CONTRACT.properties)
    .filter(([, property]) => property.required)
    .map(([name]) => name);
  assert.deepEqual(projection.schema.required, required);
  assert.deepEqual(Object.keys(projection.schema.properties), Object.keys(PR_SYNC_INPUT_CONTRACT.properties));
  assert.deepEqual(projection.schema.properties.fields, projectToJsonSchema(pullRequestContractFixture));
  assert.equal(projection.schema.properties.title?.pattern, "\\S");
  assert.equal(projection.schema.properties.head?.pattern, "\\S");
  assert.equal(projection.schema.properties.base?.pattern, "\\S");
  assert.deepEqual(projection.minimalExample, minimalPullRequestSyncInput(pullRequestContractFixture));
  assert.equal(validateSemanticInput(pullRequestContractFixture, projection.minimalExample.fields).valid, true);
  assert.doesNotThrow(() => parsePullRequestSyncInput(projection.minimalExample));
  assert.equal(projection.minimalExample.title.length > 0, true);
  assert.equal(projection.minimalExample.head.length > 0, true);
  assert.equal(projection.minimalExample.base.length > 0, true);
});

test("PR sync input parser enforces the canonical envelope and emits actionable diagnostics", () => {
  const valid = parsePullRequestSyncInput({
    fields: { linked_issue: "Closes #1" },
    title: "A pull request",
    head: "feature/example",
    base: "main",
    draft: false,
  });
  assert.deepEqual(valid.metadata, {
    title: "A pull request",
    head: "feature/example",
    base: "main",
    draft: false,
  });

  assert.throws(
    () => parsePullRequestSyncInput({ fields: {}, title: "A pull request", head: "feature/example" }),
    (error: unknown) => {
      assert.equal((error as { path?: string }).path, "$.base");
      const details = (error as { details?: { diagnostics?: { diagnostics?: readonly { path?: string }[] } } }).details;
      assert.equal(details?.diagnostics?.diagnostics?.[0]?.path, "$.base");
      return true;
    },
  );
  assert.throws(
    () =>
      parsePullRequestSyncInput({
        fields: {},
        title: "A pull request",
        head: "feature/example",
        base: "main",
        labels: [],
      }),
    (error: unknown) => (error as { path?: string }).path === "$.labels",
  );
});

test("PR sync help is projected from the canonical top-level property declaration", () => {
  const help = renderPullRequestSyncInputHelp();
  for (const [name, property] of Object.entries(PR_SYNC_INPUT_CONTRACT.properties)) {
    assert.match(help, new RegExp(`${name} \\(${property.type}\\)`));
  }
  assert.match(help, /`fields` must be the semantic object/);
});
