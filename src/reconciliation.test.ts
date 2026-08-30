import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  applySemanticPatch,
  assessExistingArtifact,
  currentArtifactInput,
  diffArtifact,
  prepareRemediationArtifact,
  prepareSyncInput,
  RemediationError,
  validateReconstructedInput,
  renderCanonicalBody,
  type ExistingArtifactRead,
} from "./reconciliation.js";
import { compileIssueFormYaml, type IssueFormTemplateIdentity } from "./contract/issue-form.js";
import { parsePullRequestTemplate } from "./pull-request-template.js";
import {
  parseExistingPullRequestArtifact,
  preparePullRequestArtifact,
  recoverExistingArtifactValues,
  renderPullRequestArtifact,
  validateExistingIssueArtifact,
  validateExistingPullRequestArtifact,
} from "./artifact.js";
import type { CanonicalContract } from "./contract/index.js";
import { compileSemanticTemplateSource, normalizeSemanticTemplate } from "./semantic-template.js";

const ISSUE_SOURCE = [
  "name: Feature",
  "description: Feature",
  "body:",
  "  - type: textarea",
  "    id: summary",
  "    attributes:",
  "      label: Summary",
  "    validations:",
  "      required: true",
  "",
].join("\n");

const ISSUE_WITH_OPTIONAL_CONTEXT_SOURCE = [
  "name: Feature",
  "description: Feature",
  "body:",
  "  - type: textarea",
  "    id: summary",
  "    attributes:",
  "      label: Summary",
  "    validations:",
  "      required: true",
  "  - type: textarea",
  "    id: context",
  "    attributes:",
  "      label: Context",
  "      value: Default context",
  "    validations:",
  "      required: false",
  "",
].join("\n");

const PR_SOURCE = ["## Summary", "", "Describe the change.", ""].join("\n");

function trusted(contract: CanonicalContract, path: string, source: string): CanonicalContract {
  return {
    ...contract,
    provenance: {
      authority: "repository-default-branch",
      repository: { host: "github.com", owner: "acme", name: "inari", nameWithOwner: "acme/inari" },
      ref: "main",
      treeSha: "tree-sha",
      template: {
        path,
        ref: "main",
        sha: "template-sha",
        digest: createHash("sha256").update(source).digest("hex"),
      },
    },
  };
}

test("Issue semantic remediation is deterministic and idempotent", () => {
  const identity: IssueFormTemplateIdentity = {
    id: "feature",
    name: "Feature",
    path: ".github/ISSUE_TEMPLATE/feature.yml",
    type: "issue-form",
    kind: "issue",
  };
  const contract = trusted(compileIssueFormYaml(ISSUE_SOURCE, identity), identity.path, ISSUE_SOURCE);
  const initial = prepareRemediationArtifact("issue", contract, {
    fields: { summary: "Initial summary" },
    metadata: { title: "feat: initial", labels: [], assignees: [] },
  });
  const read: ExistingArtifactRead = {
    remote: {
      number: 80,
      title: "feat: initial",
      body: initial.body,
      state: "open",
      url: "https://github.com/acme/inari/issues/80",
      labels: [],
      assignees: [],
    },
    contract,
    result: validateExistingIssueArtifact(contract, initial.body),
  };

  assert.equal(assessExistingArtifact("issue", read).status, "valid-current");
  assert.equal(diffArtifact("issue", read, initial).changed, false);
  const patchedInput = applySemanticPatch("issue", read, { fields: { summary: "Updated summary" }, metadata: {} });
  const patched = prepareRemediationArtifact("issue", contract, patchedInput);
  assert.equal(diffArtifact("issue", read, patched).changed, true);
  const convergedRead: ExistingArtifactRead = {
    ...read,
    remote: { ...read.remote, body: patched.body },
    result: validateExistingIssueArtifact(contract, patched.body),
  };
  assert.equal(diffArtifact("issue", convergedRead, patched).changed, false);
});

test("Issue sync preserves omitted fields and metadata from the current artifact", () => {
  const identity: IssueFormTemplateIdentity = {
    id: "feature",
    name: "Feature",
    path: ".github/ISSUE_TEMPLATE/feature.yml",
    type: "issue-form",
    kind: "issue",
  };
  const contract = trusted(
    compileIssueFormYaml(ISSUE_WITH_OPTIONAL_CONTEXT_SOURCE, identity),
    identity.path,
    ISSUE_WITH_OPTIONAL_CONTEXT_SOURCE,
  );
  const currentInput = {
    fields: { summary: "Initial summary", context: "Existing context" },
    metadata: { title: "feat: initial", labels: ["bug"], assignees: ["alice"] },
  };
  const current = prepareRemediationArtifact("issue", contract, currentInput);
  const read: ExistingArtifactRead = {
    remote: {
      number: 85,
      title: "feat: initial",
      body: current.body,
      state: "open",
      url: "https://github.com/acme/inari/issues/85",
      labels: ["bug"],
      assignees: ["alice"],
    },
    contract,
    result: validateExistingIssueArtifact(contract, current.body),
  };

  const syncedInput = prepareSyncInput("issue", read, { fields: { summary: "Updated summary" }, metadata: {} });
  assert.deepEqual(syncedInput.fields, { summary: "Updated summary", context: "Existing context" });
  assert.deepEqual(syncedInput.metadata, currentInput.metadata);

  const synced = prepareRemediationArtifact("issue", contract, syncedInput);
  assert.deepEqual(validateExistingIssueArtifact(contract, synced.body).parse.values, syncedInput.fields);
  assert.match(synced.body, /Existing context/u);
  assert.doesNotMatch(synced.body, /Default context/u);
});

test("Issue edit and sync preserve omitted dependencies from the current artifact", () => {
  const identity: IssueFormTemplateIdentity = {
    id: "feature",
    name: "Feature",
    path: ".github/ISSUE_TEMPLATE/feature.yml",
    type: "issue-form",
    kind: "issue",
  };
  const contract = trusted(compileIssueFormYaml(ISSUE_SOURCE, identity), identity.path, ISSUE_SOURCE);
  const dependencies = {
    blockedBy: [
      { repositoryHost: "github.com", repositoryId: "100000157", repository: "yohn-jp/gh-inari", number: 149 },
    ],
    blocks: [{ repositoryHost: "github.com", repositoryId: "200000002", repository: "yohn-jp/portal", number: 3 }],
  };
  const current = prepareRemediationArtifact("issue", contract, {
    fields: { summary: "Initial summary" },
    metadata: { title: "feat: dependency preservation", labels: [], assignees: [] },
    dependencies,
  });
  const read: ExistingArtifactRead = {
    remote: {
      number: 157,
      title: "feat: dependency preservation",
      body: current.body,
      state: "open",
      url: "https://github.com/acme/inari/issues/157",
      labels: [],
      assignees: [],
    },
    contract,
    result: validateExistingIssueArtifact(contract, current.body),
  };

  assert.deepEqual(currentArtifactInput("issue", read).dependencies, dependencies);
  assert.deepEqual(
    applySemanticPatch("issue", read, { fields: { summary: "Edited summary" }, metadata: {} }).dependencies,
    dependencies,
  );
  assert.deepEqual(
    prepareSyncInput("issue", read, { fields: { summary: "Synced summary" }, metadata: {} }).dependencies,
    dependencies,
  );
});

test("Issue normalization preserves semantic option values while canonicalizing native labels", () => {
  const source = normalizeSemanticTemplate({
    version: 1,
    kind: "issue",
    id: "mapped-options",
    name: "Mapped options",
    description: "Issue Form option mapping fixture",
    sections: [
      {
        id: "priority",
        kind: "input",
        type: "enum",
        label: "Priority",
        required: true,
        options: [
          { id: "critical", value: "p-critical", label: "Critical" },
          { id: "normal", value: "p-normal", label: "Normal" },
        ],
      },
      {
        id: "areas",
        kind: "input",
        type: "array",
        label: "Areas",
        multiple: true,
        options: [
          { id: "frontend", value: "area-frontend", label: "Frontend" },
          { id: "backend", value: "area-backend", label: "Backend" },
        ],
      },
    ],
  });
  const path = ".github/ISSUE_TEMPLATE/mapped-options.yml";
  const contract = trusted(compileSemanticTemplateSource(source, path), path, JSON.stringify(source));
  const fields = { priority: "p-critical", areas: ["area-backend", "area-frontend"] };
  const canonical = prepareRemediationArtifact("issue", contract, {
    fields,
    metadata: { title: "feat: mapped options", labels: [], assignees: [] },
  });
  const driftedBody = canonical.body.replace("Backend, Frontend", "Backend,Frontend");
  const read: ExistingArtifactRead = {
    remote: {
      number: 84,
      title: "feat: mapped options",
      body: driftedBody,
      state: "open",
      url: "https://github.com/acme/inari/issues/84",
      labels: [],
      assignees: [],
    },
    contract,
    result: validateExistingIssueArtifact(contract, driftedBody),
  };

  assert.equal(read.result.valid, true);
  assert.deepEqual(read.result.parse.values, fields);
  const assessment = assessExistingArtifact("issue", read);
  assert.equal(assessment.status, "non-canonical");
  assert.equal(assessment.canonicalBody, canonical.body);
  const normalized = prepareRemediationArtifact("issue", contract, {
    fields: read.result.parse.values,
    metadata: { title: read.remote.title, labels: [], assignees: [] },
  });
  assert.equal(diffArtifact("issue", read, normalized).changed, true);
  assert.equal(validateExistingIssueArtifact(contract, normalized.body).valid, true);
});

test("pull-request semantic remediation preserves resource-specific metadata and is idempotent", () => {
  const path = ".github/PULL_REQUEST_TEMPLATE.md";
  const contract = trusted(
    parsePullRequestTemplate(PR_SOURCE, {
      id: "default",
      type: "pull-request-default",
      kind: "pull-request",
      name: "Default",
      path,
    }),
    path,
    PR_SOURCE,
  );
  const initial = prepareRemediationArtifact("pr", contract, {
    fields: { summary: "Initial summary" },
    metadata: { title: "feat: initial", head: "feature", base: "main", draft: false },
  });
  const read: ExistingArtifactRead = {
    remote: {
      number: 81,
      title: "feat: initial",
      body: initial.body,
      state: "open",
      url: "https://github.com/acme/inari/pull/81",
      draft: false,
      head: "feature",
      base: "main",
    },
    contract,
    result: validateExistingPullRequestArtifact(contract, initial.body),
  };

  assert.equal(assessExistingArtifact("pr", read).status, "valid-current");
  assert.equal(diffArtifact("pr", read, initial).changed, false);
  assert.throws(
    () => applySemanticPatch("pr", read, { fields: {}, metadata: { head: "other" } }),
    (error: unknown) => error instanceof Error && error.name === "RemediationError",
  );
  assert.throws(
    () => applySemanticPatch("pr", read, { fields: {}, metadata: { labels: ["release"] } }),
    (error: unknown) =>
      error instanceof RemediationError &&
      error.code === "SEMANTIC_PATCH_UNSUPPORTED" &&
      error.path === "$.metadata.labels",
  );
});

test("PR create, edit, normalize, and sync share one canonical renderer", () => {
  const path = ".github/PULL_REQUEST_TEMPLATE.md";
  const contract = trusted(
    parsePullRequestTemplate(PR_SOURCE, {
      id: "default",
      type: "pull-request-default",
      kind: "pull-request",
      name: "Default",
      path,
    }),
    path,
    PR_SOURCE,
  );
  const initialInput = {
    fields: { summary: "Initial **summary**\nwith a second line" },
    metadata: { title: "feat: initial", head: "feature", base: "main", draft: false },
  };
  const created = preparePullRequestArtifact(contract, initialInput).artifact;
  assert.equal(created.body, renderPullRequestArtifact(contract, initialInput.fields));

  const read: ExistingArtifactRead = {
    remote: {
      number: 84,
      title: initialInput.metadata.title,
      body: created.body,
      state: "open",
      url: "https://github.com/acme/inari/pull/84",
      draft: false,
      head: initialInput.metadata.head,
      base: initialInput.metadata.base,
    },
    contract,
    result: validateExistingPullRequestArtifact(contract, created.body),
  };
  assert.equal(assessExistingArtifact("pr", read).status, "valid-current");
  assert.equal(renderCanonicalBody("pr", contract, read.result.parse.values), created.body);

  const editedInput = applySemanticPatch("pr", read, {
    fields: { summary: "Edited summary\nwith a second line" },
    metadata: {},
  });
  const edited = prepareRemediationArtifact("pr", contract, editedInput);
  assert.equal(edited.body, renderPullRequestArtifact(contract, editedInput.fields));

  const editedRead: ExistingArtifactRead = {
    ...read,
    remote: { ...read.remote, body: edited.body },
    result: validateExistingPullRequestArtifact(contract, edited.body),
  };
  const normalized = prepareRemediationArtifact("pr", contract, currentArtifactInput("pr", editedRead));
  assert.equal(normalized.body, edited.body);
  assert.equal(diffArtifact("pr", editedRead, normalized).changed, false);

  const syncedInput = prepareSyncInput("pr", editedRead, {
    fields: { summary: "Synced summary\nwith a second line" },
    metadata: { title: "feat: synced", head: "feature", base: "main", draft: false },
  });
  const synced = prepareRemediationArtifact("pr", contract, syncedInput);
  assert.equal(synced.body, renderPullRequestArtifact(contract, syncedInput.fields));
  const syncedTitle = syncedInput.metadata.title;
  assert.equal(syncedTitle, "feat: synced");
  const syncedRead: ExistingArtifactRead = {
    ...editedRead,
    remote: {
      ...editedRead.remote,
      title: syncedTitle ?? "feat: synced",
      body: synced.body,
    },
    result: validateExistingPullRequestArtifact(contract, synced.body),
  };
  const repeated = prepareRemediationArtifact("pr", contract, currentArtifactInput("pr", syncedRead));
  assert.equal(repeated.body, synced.body);
  assert.equal(diffArtifact("pr", syncedRead, repeated).changed, false);
  assert.deepEqual(parseExistingPullRequestArtifact(contract, repeated.body).values, syncedInput.fields);
});

test("sync with an explicitly named contract replaces a current body that fails to parse under it", () => {
  const identity: IssueFormTemplateIdentity = {
    id: "feature",
    name: "Feature",
    path: ".github/ISSUE_TEMPLATE/feature.yml",
    type: "issue-form",
    kind: "issue",
  };
  const contract = trusted(compileIssueFormYaml(ISSUE_SOURCE, identity), identity.path, ISSUE_SOURCE);
  const wrongTemplateBody = "### Other\n\nAn artifact that was never created from this template\n";
  // Mirrors what readGovernedExistingArtifact returns when a caller names an
  // explicit --template: the contract is known, but the current body does not
  // parse under it (parse.parsed stays false).
  const read: ExistingArtifactRead = {
    remote: {
      number: 82,
      title: "feat: pre-existing",
      body: wrongTemplateBody,
      state: "open",
      url: "https://github.com/acme/inari/issues/82",
      labels: [],
      assignees: [],
    },
    contract,
    result: validateExistingIssueArtifact(contract, wrongTemplateBody),
  };
  assert.equal(read.result.parse.parsed, false);

  const desiredInput = prepareSyncInput("issue", read, {
    fields: { summary: "Replacement summary" },
    metadata: { title: "feat: replacement", labels: [], assignees: [] },
  });
  const desired = prepareRemediationArtifact("issue", contract, desiredInput);
  const diff = diffArtifact("issue", read, desired);
  assert.equal(diff.changed, true);
  assert.equal(
    diff.semantic.some((change) => change.path === "$.fields.summary" && change.before === undefined),
    true,
  );
});

test("sync without a resolvable contract still refuses to replace an unparseable current body", () => {
  const read: ExistingArtifactRead = {
    remote: {
      number: 83,
      title: "Existing artifact",
      body: "### Other\n\nvalue\n",
      state: "open",
      url: "https://github.com/acme/inari/issues/83",
      labels: [],
      assignees: [],
    },
    result: {
      valid: false,
      classification: "wrong-template",
      parse: { parsed: false, values: {}, diagnostics: [] },
      violations: [],
    },
  };
  assert.throws(
    () => prepareSyncInput("issue", read, { fields: {}, metadata: {} }),
    (error: unknown) => error instanceof RemediationError && error.code === "SYNC_CURRENT_UNSUPPORTED",
  );
});

test("explicit PR template recovery preserves unambiguous values from a wrong-order body", () => {
  const path = ".github/PULL_REQUEST_TEMPLATE.md";
  const source = `## Summary

<!-- Describe the change. -->

## Linked issue

Closes #

## Validation

- [ ] Tests
- [ ] Build
`;
  const contract = trusted(
    parsePullRequestTemplate(source, {
      id: "default",
      type: "pull-request-default",
      kind: "pull-request",
      name: "Default",
      path,
    }),
    path,
    source,
  );
  const body = `## Validation

- [x] Tests
- [ ] Build

## Linked issue

Closes #112

## Summary

A recovered summary
`;
  const read: ExistingArtifactRead = {
    remote: {
      number: 112,
      title: "feat: recover",
      body,
      state: "open",
      url: "https://github.com/acme/inari/pull/112",
      draft: false,
      head: "feature",
      base: "main",
    },
    contract,
    result: validateExistingPullRequestArtifact(contract, body),
    templateSelection: "explicit",
  };

  assert.equal(read.result.classification, "wrong-template");
  assert.deepEqual(recoverExistingArtifactValues(contract, body).values, {
    summary: "A recovered summary",
    linked_issue: "Closes #112",
    validation: ["tests"],
  });
  const desired = prepareRemediationArtifact("pr", contract, currentArtifactInput("pr", read));
  assert.equal(validateExistingPullRequestArtifact(contract, desired.body).valid, true);
  assert.match(desired.body, /^## Summary/mu);
  assert.match(desired.body, /A recovered summary/u);
  assert.match(desired.body, /Closes #112/u);
});

test("explicit PR recovery reports missing required semantics as bounded requirements", () => {
  const path = ".github/PULL_REQUEST_TEMPLATE.md";
  const source = `## Summary

Describe the change.

## Linked issue

Closes #

## Validation

- [ ] Tests
`;
  const base = parsePullRequestTemplate(source, {
    id: "default",
    type: "pull-request-default",
    kind: "pull-request",
    name: "Default",
    path,
  });
  const contract = trusted(
    {
      ...base,
      supplementalConstraints: {
        fields: [
          { fieldId: "summary", required: true },
          { fieldId: "linked_issue", required: true },
          { fieldId: "validation", required: true, checklistMinCompleted: 1 },
        ],
      },
    },
    path,
    source,
  );
  const body = "## Summary\n\nA recovered summary\n";
  const read: ExistingArtifactRead = {
    remote: {
      number: 113,
      title: "feat: incomplete",
      body,
      state: "open",
      url: "https://github.com/acme/inari/pull/113",
      draft: false,
      head: "feature",
      base: "main",
    },
    contract,
    result: validateExistingPullRequestArtifact(contract, body),
    templateSelection: "explicit",
  };

  assert.throws(
    () => validateReconstructedInput(contract, currentArtifactInput("pr", read), "NORMALIZATION_UNSAFE"),
    (error: unknown) => {
      assert.ok(error instanceof RemediationError);
      assert.equal(error.code, "NORMALIZATION_UNSAFE");
      const requirements = error.details?.requirements as {
        missingFields?: readonly { field: string }[];
        diagnostics?: { diagnostics: readonly unknown[] };
      };
      assert.deepEqual(
        requirements.missingFields?.map((field) => field.field),
        ["linked_issue", "validation"],
      );
      assert.equal((requirements.diagnostics?.diagnostics.length ?? 0) <= 32, true);
      return true;
    },
  );
});
