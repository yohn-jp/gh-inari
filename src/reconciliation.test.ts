import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  applySemanticPatch,
  assessExistingArtifact,
  diffArtifact,
  prepareRemediationArtifact,
  type ExistingArtifactRead,
} from "./reconciliation.js";
import { compileIssueFormYaml, type IssueFormTemplateIdentity } from "./contract/issue-form.js";
import { parsePullRequestTemplate } from "./pull-request-template.js";
import { validateExistingIssueArtifact, validateExistingPullRequestArtifact } from "./artifact.js";
import type { CanonicalContract } from "./contract/index.js";

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
});
