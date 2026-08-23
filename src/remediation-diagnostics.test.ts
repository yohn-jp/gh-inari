import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateExistingPullRequestArtifact } from "./artifact.js";
import type { CanonicalContract } from "./contract/index.js";
import { createArtifactDiagnostic, createArtifactDiagnosticReport } from "./diagnostics.js";
import { parsePullRequestTemplate } from "./pull-request-template.js";
import {
  remediationDiagnosticReport,
  remediationFailureDetails,
  RemediationError,
  translateRemediationFailure,
  type ExistingArtifactRead,
} from "./reconciliation.js";

const SOURCE = [
  "## Summary",
  "",
  "Describe the change.",
  "",
  "## Linked issue",
  "",
  "Closes #",
  "",
].join("\n");

function contract(): CanonicalContract {
  const parsed = parsePullRequestTemplate(SOURCE, {
    id: "default",
    type: "pull-request-default",
    kind: "pull-request",
    name: "Default",
    path: ".github/PULL_REQUEST_TEMPLATE.md",
  });
  return {
    ...parsed,
    supplementalConstraints: {
      fields: [
        { fieldId: "summary", required: true },
        { fieldId: "linked_issue", required: true },
      ],
    },
    provenance: {
      authority: "repository-default-branch",
      repository: { host: "github.com", owner: "acme", name: "inari", nameWithOwner: "acme/inari" },
      ref: "main",
      treeSha: "tree-sha",
      template: {
        path: ".github/PULL_REQUEST_TEMPLATE.md",
        ref: "main",
        sha: "template-sha",
        digest: createHash("sha256").update(SOURCE).digest("hex"),
      },
    },
  };
}

function readWith(fieldsBody: string, templateSelection?: "explicit"): ExistingArtifactRead {
  const selected = contract();
  const result = validateExistingPullRequestArtifact(selected, fieldsBody);
  return {
    remote: {
      number: 119,
      title: "feat: diagnostics",
      body: fieldsBody,
      state: "open",
      url: "https://github.com/acme/inari/pull/119",
      draft: false,
      head: "feature",
      base: "main",
    },
    contract: selected,
    result,
    ...(templateSelection === undefined ? {} : { templateSelection }),
  };
}

test("normalize diagnostics distinguish missing semantics through the shared contract", () => {
  const read = readWith("## Summary\n\nA summary\n\n## Linked issue\n\n\n");
  const report = remediationDiagnosticReport("pr", "normalize", read);
  const missing = report.diagnostics.find((diagnostic) => diagnostic.code === "FIELD_MISSING");
  assert.equal(missing?.state, "missing");
  assert.equal(missing?.detailCode, "FIELD_REQUIRED");
  assert.equal(missing?.path, "$.fields.linked_issue");
  assert.equal(missing?.recovery?.[0]?.action, "provide");
});

test("explicit-template reconstruction requirements stay field-diagnostic", () => {
  const read = readWith("## Summary\n\nA summary\n", "explicit");
  const requirement = createArtifactDiagnostic({
    state: "missing",
    code: "FIELD_MISSING",
    detailCode: "FIELD_REQUIRED",
    reason: "required",
    path: "$.fields.linked_issue",
    message: "linked_issue is required.",
    recovery: [{ action: "provide", path: "$.fields.linked_issue" }],
  });
  const error = new RemediationError(
    "SEMANTIC_PATCH_INVALID",
    "The selected template requires semantic values that could not be recovered.",
    "$.fields",
    {
      requirements: {
        diagnostics: createArtifactDiagnosticReport([requirement], ["$.fields.summary"]),
      },
    },
  );

  const translated = translateRemediationFailure("pr", "edit", read, error);
  assert.ok(translated instanceof RemediationError);
  assert.equal(translated.diagnostics?.diagnostics[0]?.code, "FIELD_MISSING");
  assert.equal(translated.diagnostics?.diagnostics[0]?.path, "$.fields.linked_issue");
  assert.deepEqual(translated.diagnostics?.acceptedFields, ["$.fields.summary"]);
  assert.equal(translated.details?.template !== undefined, true);
  assert.equal(JSON.stringify(translated).includes(read.remote.body ?? ""), false);
});

test("unsupported PR head changes use the common bounded diagnostic vocabulary", () => {
  const read = readWith("## Summary\n\nA summary\n\n## Linked issue\n\nCloses #119\n");
  const error = new RemediationError(
    "PR_HEAD_CHANGE_UNSUPPORTED",
    "Pull request head branches cannot be changed through the GitHub pull-request model.",
    "$.head",
  );
  const report = remediationDiagnosticReport("pr", "edit", read, undefined, error);
  const diagnostic = report.diagnostics.find((entry) => entry.path === "$.metadata.head");
  assert.equal(diagnostic?.state, "unsupported");
  assert.equal(diagnostic?.code, "FIELD_UNSUPPORTED");
  assert.equal(diagnostic?.recovery?.[0]?.action, "replace");
  assert.equal(JSON.stringify(remediationFailureDetails(read)).includes(read.remote.body ?? ""), false);
});
