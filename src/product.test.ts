import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseExistingIssueArtifact,
  parseExistingPullRequestArtifact,
  renderIssueArtifact,
  renderPullRequestArtifact,
} from "./artifact.js";
import { compileIssueFormTemplate, validateSemanticInput } from "./contract/index.js";
import { compilePullRequestPolicyOverlay } from "./pr-policy.js";
import { compilePullRequestTemplate } from "./pull-request-template.js";
import { discoverTemplates } from "./template-discovery.js";

test("repository-native Issue and PR fixtures traverse the shared product core", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const discovery = await discoverTemplates(root);
  const issue = await compileIssueFormTemplate(discovery, "feature");
  const issueInput = {
    problem: "The current behavior is surprising",
    capability: "Make the current behavior explicit",
    contract: "Callers observe the documented, explicit behavior",
    acceptance: "- [ ] verify",
    non_goals: "No unrelated behavior changes",
    constraints: "None",
  };
  const issueValidation = validateSemanticInput(issue, issueInput);
  assert.equal(issueValidation.valid, true);
  const issueBody = renderIssueArtifact(issue, issueInput);
  const issueParsed = parseExistingIssueArtifact(issue, issueBody);
  assert.equal(issueParsed.parsed, true);
  assert.deepEqual(issueParsed.values, issueInput);

  const prNative = await compilePullRequestTemplate(root, "default");
  const policySource = await readFile(path.join(root, ".github", "inari", "pr-policy.yml"), "utf8");
  const pr = compilePullRequestPolicyOverlay(prNative, policySource);
  const prInput = {
    summary: "A deterministic end-to-end product proof",
    linked_issue: "Closes #22",
    changes: "The governed implementation and behavioral changes",
    validation: ["typecheck", "tests", "build"],
  };
  assert.equal(validateSemanticInput(pr, prInput).valid, true);
  const prBody = renderPullRequestArtifact(pr, prInput);
  const prParsed = parseExistingPullRequestArtifact(pr, prBody);
  assert.equal(prParsed.parsed, true);
  assert.deepEqual(prParsed.values, prInput);
});

test("release metadata points at the real Inari package and built entrypoint", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    name?: string;
    bin?: Record<string, string>;
    main?: string;
    repository?: { url?: string };
  };
  assert.equal(packageJson.name, "gh-inari");
  assert.deepEqual(packageJson.bin, { "gh-inari": "dist/index.js", inari: "dist/index.js" });
  assert.equal(packageJson.main, "dist/index.js");
  assert.equal(packageJson.repository?.url, "git+https://github.com/yohn-jp/gh-inari.git");
});
