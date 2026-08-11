import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectToJsonSchema, serializeCanonicalContract, validateCanonicalContract } from "./contract/index.js";
import {
  compilePullRequestTemplate,
  compilePullRequestTemplateSync,
  compilePullRequestTemplates,
  compilePullRequestTemplatesSync,
  parsePullRequestTemplate,
  PullRequestTemplateError,
  renderPullRequestTemplate,
} from "./pull-request-template.js";
import { discoverTemplates } from "./template-discovery.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/template-discovery", import.meta.url));
const COMPLETE_FIXTURE = `${FIXTURES}/complete`;

test("compiles headings, literal content, comments, and checklists into ordered canonical IR", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);
  const identity = discovery.pullRequestTemplates.find((template) => template.name === "default");
  assert.ok(identity);

  const contract = parsePullRequestTemplate(
    [
      "<!-- Repository guidance -->",
      "Keep this preamble while rendering.",
      "",
      "## Summary",
      "<!-- Explain the change for reviewers. -->",
      "Write a concise summary.",
      "",
      "### Checklist",
      "<!-- Remove unchecked items only when they do not apply. -->",
      "Please verify:",
      "",
      "- [ ] Tests",
      "- [x] Documentation",
      "",
      "## Linked issue",
      "<!-- This is a prompt, not a linked-Issue policy. -->",
      "",
    ].join("\n"),
    identity,
  );

  assert.deepEqual(
    contract.sections.map((section) => ({ id: section.id, kind: section.kind, order: section.render.order })),
    [
      { id: "preamble_content", kind: "documentation", order: 0 },
      { id: "summary", kind: "input", order: 1 },
      { id: "checklist", kind: "input", order: 2 },
      { id: "linked_issue", kind: "input", order: 3 },
    ],
  );
  assert.equal(contract.sections[1]?.render.headingLevel, 2);
  assert.equal(contract.sections[2]?.render.headingLevel, 3);
  assert.equal(contract.sections[0]?.content, "<!-- Repository guidance -->\nKeep this preamble while rendering.");
  assert.equal(
    contract.sections[1]?.fields[0]?.nativeMetadata.placeholder,
    "<!-- Explain the change for reviewers. -->\nWrite a concise summary.",
  );

  const checklist = contract.sections[2]?.fields[0];
  assert.equal(checklist?.type, "checklist");
  if (checklist?.type !== "checklist") throw new Error("Expected checklist field");
  assert.deepEqual(checklist.items, [
    { id: "tests", label: "Tests", required: false },
    { id: "documentation", label: "Documentation", required: false },
  ]);
  assert.deepEqual(checklist.defaultValue, ["documentation"]);
  assert.deepEqual(checklist.nativeMetadata.options, [{ value: "tests" }, { value: "documentation" }]);
  assert.equal("required" in (checklist.nativeMetadata.options?.[0] ?? {}), false);

  const inputFields = contract.sections
    .filter((section) => section.kind === "input")
    .flatMap((section) => section.fields);
  assert.ok(inputFields.every((field) => field.required === "unknown"));
  assert.ok(inputFields.every((field) => field.constraints === undefined));
  assert.deepEqual(contract.supplementalConstraints, { fields: [] });
  assert.equal(validateCanonicalContract(contract).valid, true);

  const schema = projectToJsonSchema(contract);
  assert.equal("required" in schema, false);
  assert.equal("pattern" in (schema.properties.summary ?? {}), false);
  assert.equal("minLength" in (schema.properties.summary ?? {}), false);
  assert.equal("linked_issue" in (schema.properties ?? {}), true);

  assert.equal(
    renderPullRequestTemplate(contract),
    [
      "<!-- Repository guidance -->",
      "Keep this preamble while rendering.",
      "",
      "## Summary",
      "",
      "<!-- Explain the change for reviewers. -->",
      "Write a concise summary.",
      "",
      "### Checklist",
      "",
      "<!-- Remove unchecked items only when they do not apply. -->",
      "Please verify:",
      "",
      "- [ ] Tests",
      "- [x] Documentation",
      "",
      "## Linked issue",
      "",
      "<!-- This is a prompt, not a linked-Issue policy. -->",
      "",
    ].join("\n"),
  );
});

test("compilation uses discovery identities and preserves stable multiple-template ordering", async () => {
  const asyncContracts = await compilePullRequestTemplates(COMPLETE_FIXTURE);
  const syncContracts = compilePullRequestTemplatesSync(COMPLETE_FIXTURE);
  assert.deepEqual(
    asyncContracts.map((contract) => contract.templateIdentity.path),
    [
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/PULL_REQUEST_TEMPLATE/maintenance.md",
      ".github/PULL_REQUEST_TEMPLATE/release.md",
    ],
  );
  assert.deepEqual(
    asyncContracts.map((contract) => contract.templateIdentity.id),
    syncContracts.map((contract) => contract.templateIdentity.id),
  );
  assert.deepEqual(
    asyncContracts.map((contract) => serializeCanonicalContract(contract)),
    syncContracts.map((contract) => serializeCanonicalContract(contract)),
  );
  assert.equal(
    (await compilePullRequestTemplate(COMPLETE_FIXTURE, "maintenance")).templateIdentity.path,
    ".github/PULL_REQUEST_TEMPLATE/maintenance.md",
  );
  assert.equal(compilePullRequestTemplateSync(COMPLETE_FIXTURE, "release").sections[0]?.id, "release_notes");
});

test("normalizes line endings and supports ordered/setext sections deterministically", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);
  const identity = discovery.pullRequestTemplates[0];
  assert.ok(identity);
  const source = "Summary\r\n=======\r\n\r\n### Tasks\r\n1. [ ] First\r\n2. [x] Second\r\n";
  const contract = parsePullRequestTemplate(source, identity);

  assert.deepEqual(
    contract.sections.map((section) => [section.id, section.render.headingLevel]),
    [
      ["summary", 1],
      ["tasks", 3],
    ],
  );
  const field = contract.sections[1]?.fields[0];
  assert.equal(field?.type, "checklist");
  if (field?.type !== "checklist") throw new Error("Expected checklist field");
  assert.deepEqual(field.defaultValue, ["second"]);
  assert.equal(
    serializeCanonicalContract(contract),
    serializeCanonicalContract(parsePullRequestTemplate(source, identity)),
  );
});

test("does not infer required, pattern, linked-Issue, length, or completion semantics", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);
  const identity = discovery.pullRequestTemplates[0];
  assert.ok(identity);
  const contract = parsePullRequestTemplate(
    "## Linked issue\nCloses #123\n\n## Acceptance\n- [ ] It is done\n",
    identity,
  );
  const linkedIssue = contract.sections[0]?.fields[0];
  const acceptance = contract.sections[1]?.fields[0];
  assert.equal(linkedIssue?.required, "unknown");
  assert.equal(acceptance?.required, "unknown");
  assert.equal(linkedIssue?.constraints, undefined);
  assert.equal(acceptance?.constraints, undefined);
  if (acceptance?.type !== "checklist") throw new Error("Expected checklist field");
  assert.equal(acceptance.items[0]?.required, false);
  assert.deepEqual(contract.supplementalConstraints, { fields: [] });
});

test("preserves literal content after a checklist as an ordered documentation section", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);
  const identity = discovery.pullRequestTemplates[0];
  assert.ok(identity);
  const contract = parsePullRequestTemplate("## Tasks\n- [ ] Tests\n\nKeep this literal note.\n", identity);
  assert.deepEqual(
    contract.sections.map((section) => section.kind),
    ["input", "documentation"],
  );
  assert.equal(contract.sections[1]?.content, "Keep this literal note.");
  assert.equal(renderPullRequestTemplate(contract), "## Tasks\n\n- [ ] Tests\n\nKeep this literal note.\n");
});

test("fails closed on nested, mixed, trailing, duplicate, and unheaded checklist structures", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);
  const identity = discovery.pullRequestTemplates[0];
  assert.ok(identity);

  const failures: readonly [string, string][] = [
    ["## Tasks\n- [ ] Parent\n  - [ ] Child\n", "PR_TEMPLATE_UNSUPPORTED_CONSTRUCT"],
    ["## Tasks\n- [ ] Task\n- Ordinary list item\n- [ ] Another task\n", "PR_TEMPLATE_AMBIGUOUS_STRUCTURE"],
    ["> - [ ] Blockquoted task\n", "PR_TEMPLATE_UNSUPPORTED_CONSTRUCT"],
    ["## Same\n\n## Same\n", "PR_TEMPLATE_AMBIGUOUS_STRUCTURE"],
    ["<!-- unclosed\n## Hidden\n", "PR_TEMPLATE_UNSUPPORTED_CONSTRUCT"],
    ["- [ ] No heading\n", "PR_TEMPLATE_UNSUPPORTED_CONSTRUCT"],
  ];
  for (const [source, code] of failures) {
    assert.throws(
      () => parsePullRequestTemplate(source, identity),
      (error: unknown) => error instanceof PullRequestTemplateError && error.code === code,
    );
  }
});

test("keeps headings and task markers inside fenced literals out of structure", async () => {
  const discovery = await discoverTemplates(COMPLETE_FIXTURE);
  const identity = discovery.pullRequestTemplates[0];
  assert.ok(identity);
  const source = "```markdown\n## Not a section\n- [ ] Not a task\n```\n";
  const contract = parsePullRequestTemplate(source, identity);
  assert.deepEqual(
    contract.sections.map((section) => section.kind),
    ["documentation"],
  );
  assert.equal(contract.sections[0]?.content, source.trimEnd());
  assert.equal(renderPullRequestTemplate(contract), `${source.trimEnd()}\n`);
});
