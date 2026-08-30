import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GitHubAdapter, type GhCommandResult, type GhTransport, type GhTransportOptions } from "./github/index.js";
import { runCli } from "./cli.js";

class CliStubTransport implements GhTransport {
  private readonly callHistory: string[][] = [];
  readonly calls: readonly string[][];
  private readonly responses: GhCommandResult[];

  constructor(responses: GhCommandResult[]) {
    this.responses = [...responses];
    this.calls = this.callHistory;
  }

  async run(args: readonly string[], _options?: GhTransportOptions): Promise<GhCommandResult> {
    this.callHistory.push([...args]);
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return response;
  }
}

function command(stdout = "", exitCode = 0, stderr = ""): GhCommandResult {
  return { stdout, exitCode, stderr };
}

const REMOTE_ISSUE_TEMPLATE = [
  "name: Feature",
  "description: Remote feature",
  'title: "feat: "',
  "body:",
  "  - type: textarea",
  "    id: problem",
  "    attributes: { label: Problem }",
  "    validations: { required: true }",
  "  - type: textarea",
  "    id: proposal",
  "    attributes: { label: Proposal }",
  "    validations: { required: true }",
  "  - type: textarea",
  "    id: non_goals",
  "    attributes: { label: Non-goals }",
  "    validations: { required: false }",
  "  - type: textarea",
  "    id: acceptance",
  '    attributes: { label: Acceptance criteria, value: "- [ ] " }',
  "    validations: { required: true }",
  "",
].join("\n");

/** A remote Issue Form with a scalar, a repeated (multi-select) list, and a checklist field, for direct --field CLI coverage. */
const REMOTE_ISSUE_TEMPLATE_DIRECT_FIELDS = `name: Feature
description: Remote feature
title: "feat: "
body:
  - type: textarea
    id: problem
    attributes: { label: Problem }
    validations: { required: true }
  - type: dropdown
    id: category
    attributes:
      label: Category
      options:
        - bug
        - feature
    validations: { required: true }
  - type: dropdown
    id: areas
    attributes:
      label: Areas
      multiple: true
      options:
        - cli
        - docs
        - contracts
    validations: { required: false }
  - type: checkboxes
    id: acceptance
    attributes:
      label: Acceptance criteria
      options:
        - label: Tests
          required: true
        - label: Docs
          required: false
    validations: { required: true }
`;

const REMOTE_PR_TEMPLATE = [
  "## Summary",
  "",
  "<!-- Concisely describe the delivered result. -->",
  "",
  "## Linked issue",
  "",
  "Closes #",
  "",
  "## Scope",
  "",
  "### Included",
  "",
  "<!-- Implemented scope. -->",
  "",
  "### Excluded",
  "",
  "<!-- Explicitly excluded scope. -->",
  "",
  "## Validation",
  "",
  "- [ ] Typecheck",
  "- [ ] Tests",
  "- [ ] Build",
  "- [ ] Package check",
  "",
  "## Breaking changes",
  "",
  "No.",
  "",
].join("\n");

const REMOTE_PR_POLICY = [
  "version: 1",
  "template: default",
  "sections:",
  "  - section: summary",
  "    required: true",
  "    minLength: 10",
  "  - section: linked_issue",
  "    linkedIssue: true",
  "  - section: validation",
  "    required: true",
  "    checklist:",
  "      minCompleted: 1",
  "",
].join("\n");

/** Same PR body policy as REMOTE_PR_POLICY, plus a repository branch governance rule. */
const REMOTE_PR_POLICY_WITH_BRANCH = [
  "version: 1",
  "template: default",
  "sections:",
  "  - section: summary",
  "    required: true",
  "    minLength: 10",
  "  - section: linked_issue",
  "    linkedIssue: true",
  "  - section: validation",
  "    required: true",
  "    checklist:",
  "      minCompleted: 1",
  "branch:",
  '  pattern: "^feat/[0-9]+-[a-z0-9-]+$"',
  "",
].join("\n");

const REMOTE_BUG_TEMPLATE = [
  "name: Bug",
  "description: Remote bug",
  "body:",
  "  - type: textarea",
  "    id: summary",
  "    attributes: { label: Summary }",
  "    validations: { required: true }",
  "",
].join("\n");

const REMOTE_ISSUE_BODY = [
  "### Problem",
  "",
  "A reproducible problem",
  "",
  "### Proposal",
  "",
  "A deterministic proposal",
  "",
  "### Non-goals",
  "",
  "No unrelated scope",
  "",
  "### Acceptance criteria",
  "",
  "- [ ] The behavior is covered",
  "",
].join("\n");

const REMOTE_PR_BODY = [
  "## Summary",
  "",
  "A deterministic pull request summary",
  "",
  "## Linked issue",
  "",
  "Closes #21",
  "",
  "## Scope",
  "",
  "### Included",
  "",
  "Implemented scope.",
  "",
  "### Excluded",
  "",
  "Excluded scope.",
  "",
  "## Validation",
  "",
  "- [x] Tests",
  "- [ ] Build",
  "- [ ] Typecheck",
  "- [ ] Package check",
  "",
  "## Breaking changes",
  "",
  "No.",
  "",
].join("\n");

function blobResponse(sha: string, content: string): GhCommandResult {
  return command(JSON.stringify({ sha, encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") }));
}

const GOVERNANCE_TREE_SHA = "tree-sha-fixture";

function remoteGovernanceResponses(
  templatePath: string,
  templateSha: string,
  templateSource: string,
  policy?: { readonly sha: string; readonly source: string },
): GhCommandResult[] {
  const tree = [
    { path: templatePath, type: "blob", sha: templateSha },
    ...(policy === undefined ? [] : [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: policy.sha }]),
  ];
  return [
    command("gh version 2.0"),
    command(),
    command(JSON.stringify({ default_branch: "main" })),
    command(JSON.stringify({ sha: GOVERNANCE_TREE_SHA, truncated: false, tree })),
    blobResponse(templateSha, templateSource),
    ...(policy === undefined ? [] : [blobResponse(policy.sha, policy.source)]),
  ];
}

/** The freshness re-check a governed mutation performs immediately before create/update. */
function governanceFreshnessRecheckResponses(
  templatePath: string,
  templateSha: string,
  policy?: { readonly sha: string },
): GhCommandResult[] {
  const tree = [
    { path: templatePath, type: "blob", sha: templateSha },
    ...(policy === undefined ? [] : [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: policy.sha }]),
  ];
  return [
    command(JSON.stringify({ default_branch: "main" })),
    command(JSON.stringify({ sha: GOVERNANCE_TREE_SHA, truncated: false, tree })),
  ];
}

function remoteArtifactResponses(
  templates: readonly { readonly path: string; readonly sha: string; readonly source: string }[],
  artifact: Record<string, unknown>,
  policy?: { readonly sha: string; readonly source: string },
): GhCommandResult[] {
  return [
    command("gh version 2.0"),
    command(),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: GOVERNANCE_TREE_SHA,
        truncated: false,
        tree: [
          ...templates.map((template) => ({ path: template.path, type: "blob", sha: template.sha })),
          ...(policy === undefined ? [] : [{ path: ".github/inari/pr-policy.yml", type: "blob", sha: policy.sha }]),
        ],
      }),
    ),
    ...templates.map((template) => blobResponse(template.sha, template.source)),
    ...(policy === undefined ? [] : [blobResponse(policy.sha, policy.source)]),
    command(JSON.stringify(artifact)),
  ];
}

async function captureHelp(argv: readonly string[]): Promise<{ exitCode: number; output: string }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli([...argv]);
    return { exitCode, output: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

test("--help exits 0 and prints root usage naming the governed domains", async () => {
  const { exitCode, output } = await captureHelp(["--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: inari <command>/);
  assert.match(output, /issue/);
  assert.match(output, /\bpr\b/);
  assert.match(output, /template/);
  assert.match(output, /passed through to gh/);
});

test("no arguments prints root usage matching --help", async () => {
  const { exitCode, output } = await captureHelp([]);
  assert.equal(exitCode, 1);
  assert.match(output, /Usage: inari <command>/);
});

test("issue --help prints only issue operations, not pr's", async () => {
  const { exitCode, output } = await captureHelp(["issue", "--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: inari issue <command>/);
  assert.match(output, /issue create/);
  assert.doesNotMatch(output, /pr create/);
});

test("issue create --help prints that leaf's usage and an example, not the full command tree", async () => {
  const { exitCode, output } = await captureHelp(["issue", "create", "--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: inari issue create --template/);
  assert.match(output, /Example:/);
  assert.doesNotMatch(output, /pr create/);
  assert.doesNotMatch(output, /issue normalize/);
});

test("template import --help prints that leaf's usage", async () => {
  const { exitCode, output } = await captureHelp(["template", "import", "--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: inari template import --from/);
});

test("--help=full prints the complete command and option reference", async () => {
  const { exitCode, output } = await captureHelp(["--help=full"]);
  assert.equal(exitCode, 0);
  assert.match(output, /issue normalize <number>/);
  assert.match(output, /pr normalize <number>/);
  assert.match(output, /--require-capability/);
  assert.match(output, /skill \[scenario\]/);
});

test("pr sync help exposes the complete canonical --from envelope", async () => {
  const { exitCode, output } = await captureHelp(["pr", "sync", "--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /fields \(object\)/);
  assert.match(output, /title \(string\)/);
  assert.match(output, /head \(string\)/);
  assert.match(output, /base \(string\)/);
  assert.match(output, /draft \(boolean\)/);
  assert.match(output, /maintainerCanModify \(boolean\)/);
  assert.match(output, /`fields` must be the semantic object/);
});

test("pr schema projects the canonical sync input and a valid minimal example", async () => {
  const result = await captureJson(["pr", "schema", "default", "--json"]);
  assert.equal(result.exitCode, 0);
  const syncInput = result.output.syncInput as {
    schema: { required?: readonly string[]; properties: Record<string, unknown> };
    minimalExample: { fields: Record<string, unknown>; title: string; head: string; base: string };
  };
  assert.deepEqual(syncInput.schema.required, ["fields", "title", "head", "base"]);
  assert.deepEqual(Object.keys(syncInput.schema.properties), [
    "fields",
    "title",
    "head",
    "base",
    "draft",
    "maintainerCanModify",
  ]);
  assert.ok(Object.keys(syncInput.minimalExample.fields).length > 0);
  assert.ok(syncInput.minimalExample.title.length > 0);
  assert.ok(syncInput.minimalExample.head.length > 0);
  assert.ok(syncInput.minimalExample.base.length > 0);
});

async function captureOutput(argv: readonly string[]): Promise<{ exitCode: number; output: string }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli([...argv]);
    return { exitCode, output: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

test("skill lists a bounded, deterministic set of scenarios as text", async () => {
  const { exitCode, output } = await captureOutput(["skill"]);
  assert.equal(exitCode, 0);
  assert.match(output, /author-issue/);
  assert.match(output, /author-pr/);
  assert.match(output, /inspect-governance/);
  assert.match(output, /repair-invalid-artifact/);
});

test("skill --json lists the same scenarios as a versioned JSON projection", async () => {
  const { exitCode, output } = await captureOutput(["skill", "--json"]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.version, "1.0.0");
  assert.deepEqual(
    parsed.scenarios.map((entry: { id: string }) => entry.id),
    ["author-issue", "author-pr", "inspect-governance", "repair-invalid-artifact"],
  );
});

test("skill <scenario> prints a bounded playbook as text", async () => {
  const { exitCode, output } = await captureOutput(["skill", "author-issue"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Author a governed Issue/);
  assert.match(output, /inari issue create/);
  assert.match(output, /Invariants:/);
});

test("skill <scenario> --json prints the same playbook as a versioned JSON projection", async () => {
  const { exitCode, output } = await captureOutput(["skill", "author-issue", "--json"]);
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.version, "1.0.0");
  assert.equal(parsed.id, "author-issue");
  assert.ok(Array.isArray(parsed.workflow) && parsed.workflow.length > 0);
  assert.ok(Array.isArray(parsed.invariants) && parsed.invariants.length > 0);
});

test("skill with an unknown scenario returns a stable machine-readable error", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill", "bogus-scenario"]);
    assert.equal(exitCode, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}").error.code, "UNKNOWN_SKILL_SCENARIO");
  } finally {
    console.log = originalLog;
  }
});

test("skill --help prints a scenario index without full playbook content", async () => {
  const { exitCode, output } = await captureHelp(["skill", "--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: inari skill \[scenario\]/);
  assert.match(output, /author-issue/);
  assert.doesNotMatch(output, /Invariants:/);
});

test("skill <scenario> --help prints that scenario's summary, not the full playbook", async () => {
  const { exitCode, output } = await captureHelp(["skill", "author-issue", "--help"]);
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: inari skill author-issue/);
  assert.doesNotMatch(output, /Invariants:/);
});

test("skill never falls through to the real gh binary", async () => {
  const calls: (readonly string[])[] = [];
  const dependencies = {
    runGhFallback: (argv: readonly string[]) => {
      calls.push(argv);
      return 0;
    },
  };
  await runCli(["skill"], dependencies);
  await runCli(["skill", "author-issue"], dependencies);
  await runCli(["skill", "bogus-scenario"], dependencies);
  assert.deepEqual(calls, []);
});

test("no arguments exits 1", async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const exitCode = await runCli([]);
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
  }
});

test("unknown command exits 1", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const exitCode = await runCli(["bogus"]);
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("malformed options return a structured usage error", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "validate", "--from", "--json"]);
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}").error, {
      code: "INVALID_OPTION",
      message: "Option --from requires a value.",
    });
  } finally {
    console.log = originalLog;
  }
});

test("an unrecognized top-level domain falls back to the real gh binary with the original argv", async () => {
  const calls: (readonly string[])[] = [];
  const exitCode = await runCli(["repo", "view", "--json", "name"], {
    runGhFallback: (argv) => {
      calls.push(argv);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [["repo", "view", "--json", "name"]]);
});

test("an unrecognized issue/pr subcommand falls back to the real gh binary and propagates its exit code", async () => {
  const calls: (readonly string[])[] = [];
  const exitCode = await runCli(["pr", "list", "--state", "open"], {
    runGhFallback: (argv) => {
      calls.push(argv);
      return 7;
    },
  });
  assert.equal(exitCode, 7);
  assert.deepEqual(calls, [["pr", "list", "--state", "open"]]);
});

test("--help on an unowned domain falls back to real gh --help instead of printing Inari's own help", async () => {
  const calls: (readonly string[])[] = [];
  const exitCode = await runCli(["repo", "view", "--help"], {
    runGhFallback: (argv) => {
      calls.push(argv);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [["repo", "view", "--help"]]);
});

test("--help on an unowned issue/pr subcommand falls back to real gh --help", async () => {
  const calls: (readonly string[])[] = [];
  const exitCode = await runCli(["pr", "list", "--help"], {
    runGhFallback: (argv) => {
      calls.push(argv);
      return 0;
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [["pr", "list", "--help"]]);
});

test("invalid issue/pr numbers on get and explain are classified as INVALID_ARTIFACT_NUMBER, not UNKNOWN_COMMAND", async () => {
  const invalidNumbers = ["0", "-5", "1.5", "abc"];
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    for (const domain of ["issue", "pr"] as const) {
      for (const command of ["get", "explain"] as const) {
        for (const value of invalidNumbers) {
          lines.length = 0;
          const exitCode = await runCli([domain, command, value, "--repository", "acme/inari", "--json"]);
          assert.equal(exitCode, 2, `${domain} ${command} "${value}" should exit 2`);
          const error = JSON.parse(lines[0] ?? "{}").error as { code?: string };
          assert.equal(
            error.code,
            "INVALID_ARTIFACT_NUMBER",
            `${domain} ${command} "${value}" should be INVALID_ARTIFACT_NUMBER, got ${error.code}`,
          );
        }
        lines.length = 0;
        const exitCode = await runCli([domain, command, "--repository", "acme/inari", "--json"]);
        assert.equal(exitCode, 2, `${domain} ${command} with a missing number should exit 2`);
        const error = JSON.parse(lines[0] ?? "{}").error as { code?: string };
        assert.equal(error.code, "INVALID_ARTIFACT_NUMBER");
      }
    }
  } finally {
    console.log = originalLog;
  }
});

test("positive integer issue/pr numbers on get and explain still dispatch normally instead of being rejected", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 21,
        title: "feat: canonical retrieval",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/21",
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "octocat" }],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "get", "21", "--repository", "acme/inari", "--json"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.notEqual((output as { error?: { code?: string } }).error?.code, "INVALID_ARTIFACT_NUMBER");
  } finally {
    console.log = originalLog;
  }
});

test("--repo and -R behave as aliases for --repository on governed commands", async () => {
  const remoteResponse = () =>
    remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 21,
        title: "feat: canonical retrieval",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/21",
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "octocat" }],
      },
    );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const invocations: string[][] = [
      ["issue", "get", "21", "--repository", "acme/inari", "--json"],
      ["issue", "get", "21", "--repo", "acme/inari", "--json"],
      ["issue", "get", "21", "-R", "acme/inari", "--json"],
    ];
    const outputs: unknown[] = [];
    for (const argv of invocations) {
      lines.length = 0;
      const transport = new CliStubTransport(remoteResponse());
      const exitCode = await runCli(argv, { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) });
      assert.equal(exitCode, 0, `${argv.join(" ")} should exit 0`);
      outputs.push(JSON.parse(lines[0] ?? "{}"));
    }
    assert.deepEqual(outputs[1], outputs[0]);
    assert.deepEqual(outputs[2], outputs[0]);
  } finally {
    console.log = originalLog;
  }
});

test("malformed JSON is a validation error without opaque cause details", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const inputPath = path.join(directory, "invalid.json");
  await writeFile(inputPath, "{");
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "validate", "--template", "feature", "--from", inputPath, "--json"]);
    assert.equal(exitCode, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}").error, {
      code: "INPUT_INVALID_JSON",
      message: "Input file must contain valid JSON.",
      path: "--from",
    });
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized --from file is rejected before JSON parsing, with the configured bound and observed size", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const inputPath = path.join(directory, "oversized.json");
  const oversizedPayload = JSON.stringify({ padding: "x".repeat(1_048_577) });
  await writeFile(inputPath, oversizedPayload);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "validate", "--template", "feature", "--from", inputPath, "--json"]);
    assert.equal(exitCode, 2);
    const error = JSON.parse(lines[0] ?? "{}").error as {
      code: string;
      message: string;
      path: string;
      details?: { limitBytes?: number; observedBytes?: number };
    };
    assert.equal(error.code, "INPUT_TOO_LARGE");
    assert.equal(error.path, "--from");
    assert.equal(error.details?.limitBytes, 1_048_576);
    assert.equal(error.details?.observedBytes, Buffer.byteLength(oversizedPayload, "utf8"));
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a --from file exactly at the byte bound is not rejected as too large (rejection is strictly greater-than)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const inputPath = path.join(directory, "boundary.json");
  const padded = JSON.stringify({ problem: "boundary case" });
  const padding = "x".repeat(1_048_576 - Buffer.byteLength(padded, "utf8"));
  const exactPayload = JSON.stringify({ problem: `boundary case${padding}` });
  assert.equal(Buffer.byteLength(exactPayload, "utf8"), 1_048_576);
  await writeFile(inputPath, exactPayload);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await runCli(["issue", "validate", "--template", "feature", "--from", inputPath, "--json"]);
    const parsed = JSON.parse(lines[0] ?? "{}") as { error?: { code: string } };
    assert.notEqual(parsed.error?.code, "INPUT_TOO_LARGE");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a small multibyte UTF-8 --from file is unaffected by the byte bound", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const inputPath = path.join(directory, "multibyte.json");
  await writeFile(inputPath, JSON.stringify({ problem: "こんにちは 😀" }));
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await runCli(["issue", "validate", "--template", "feature", "--from", inputPath, "--json"]);
    const parsed = JSON.parse(lines[0] ?? "{}") as { error?: { code: string } };
    assert.notEqual(parsed.error?.code, "INPUT_TOO_LARGE");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized stdin payload is rejected early instead of being buffered without limit", async () => {
  const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cliEntry, "issue", "validate", "--template", "feature", "--from", "-", "--json"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stdin.on("error", () => undefined);
  let closed = false;
  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });

  const oversizedChunk = Buffer.alloc(1_048_577, "x".charCodeAt(0));
  const writeUntilRejectedOrClosed = (async () => {
    for (let written = 0; written < 8 * oversizedChunk.byteLength; written += oversizedChunk.byteLength) {
      if (closed || child.stdin.destroyed) return;
      try {
        const canContinue = child.stdin.write(oversizedChunk);
        if (!canContinue) {
          await Promise.race([new Promise((resolve) => child.stdin.once("drain", resolve)), exitPromise]);
        }
      } catch {
        return;
      }
    }
    if (!closed && !child.stdin.destroyed) child.stdin.end();
  })();

  const exitCode = await exitPromise;
  await writeUntilRejectedOrClosed;

  assert.equal(exitCode, 2);
  const parsed = JSON.parse(stdout.trim() || "{}") as { error?: { code: string; details?: { limitBytes?: number } } };
  assert.equal(parsed.error?.code, "INPUT_TOO_LARGE");
  assert.equal(parsed.error?.details?.limitBytes, 1_048_576);
});

test("template list on a repository without semantic templates includes a discovery hint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["template", "list"], { repositoryRoot: directory });
    assert.equal(exitCode, 0);
    const output = JSON.parse(lines[0] ?? "{}") as { semanticTemplates: unknown[]; semanticTemplatesHint?: string };
    assert.deepEqual(output.semanticTemplates, []);
    assert.match(output.semanticTemplatesHint ?? "", /no semantic templates found/);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("template import warns on the CLI when --to writes outside discoverable semantic paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  await mkdir(path.join(directory, ".github/ISSUE_TEMPLATE"), { recursive: true });
  await writeFile(
    path.join(directory, ".github/ISSUE_TEMPLATE/bug.yml"),
    [
      "name: Bug",
      "description: Bug report",
      "body:",
      "  - type: textarea",
      "    id: repro",
      "    attributes:",
      "      label: Repro",
      "",
    ].join("\n"),
  );
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line: string) => logs.push(line);
  console.error = (line: string) => errors.push(line);
  try {
    const exitCode = await runCli(
      ["template", "import", "--from", ".github/ISSUE_TEMPLATE/bug.yml", "--to", ".github/inari/issue/bug.json"],
      { repositoryRoot: directory },
    );
    assert.equal(exitCode, 0);
    assert.equal(logs[0], ".github/inari/issue/bug.json");
    assert.match(errors[0] ?? "", /no semantic template will be discovered/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("version comes from real package metadata", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    assert.equal(await runCli(["--version"]), 0);
    assert.equal(lines[0], `${packageJson.name} ${packageJson.version}`);
  } finally {
    console.log = originalLog;
  }
});

test("machine-readable version reports the invocation contract and capabilities", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    assert.equal(
      await runCli(["--version", "--json"], {
        packageMetadata: { name: "gh-inari", version: "0.3.0", description: "" },
      }),
      0,
    );
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.ok, true);
    assert.equal(output.name, "gh-inari");
    assert.equal(output.version, "0.3.0");
    assert.equal(output.protocol, 1);
    assert.deepEqual(output.invocation, {
      canonical: "gh inari",
      direct: "gh-inari",
      fallback: "npx --yes gh-inari",
    });
    assert.deepEqual(output.capabilities, [
      "canonical-invocation",
      "machine-readable-version",
      "capability-diagnostics",
      "extension-bootstrap",
    ]);
  } finally {
    console.log = originalLog;
  }
});

test("diagnose reports a missing canonical extension with one install command", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["diagnose", "--json"], {
      packageMetadata: { name: "gh-inari", version: "0.3.0", description: "" },
      runDiagnosticCommand: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as {
      ok?: boolean;
      canonical?: { status?: string; recovery?: string };
    };
    assert.equal(output.ok, false);
    assert.equal(output.canonical?.status, "missing");
    assert.equal(output.canonical?.recovery, "gh extension install yohn-jp/gh-inari");
  } finally {
    console.log = originalLog;
  }
});

test("diagnose rejects a stale extension when its capability contract is incomplete", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--diagnose", "--json"], {
      packageMetadata: { name: "gh-inari", version: "0.3.0", description: "" },
      runDiagnosticCommand: (args) =>
        args[0] === "extension"
          ? { status: 0, stdout: "gh inari\tyohn-jp/gh-inari\told\n", stderr: "" }
          : {
              status: 0,
              stdout: JSON.stringify({
                ok: true,
                name: "gh-inari",
                version: "0.2.0",
                protocol: 1,
                capabilities: ["canonical-invocation"],
                invocation: { canonical: "gh inari", direct: "gh-inari", fallback: "npx --yes gh-inari" },
              }),
              stderr: "",
            },
    });
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as {
      ok?: boolean;
      canonical?: { status?: string; recovery?: string; missingCapabilities?: string[] };
    };
    assert.equal(output.ok, false);
    assert.equal(output.canonical?.status, "stale");
    assert.equal(output.canonical?.recovery, "gh extension upgrade inari");
    assert.deepEqual(output.canonical?.missingCapabilities, [
      "machine-readable-version",
      "capability-diagnostics",
      "extension-bootstrap",
    ]);
  } finally {
    console.log = originalLog;
  }
});

test("invalid create input is rejected after target governance is resolved and before mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "issue.json");
  await writeFile(
    inputPath,
    JSON.stringify({ fields: { problem: "", proposal: "proposal", acceptance: "acceptance" }, title: "feat: invalid" }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  let factoryCalls = 0;
  const transport = new CliStubTransport([
    ...remoteGovernanceResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha", REMOTE_ISSUE_TEMPLATE),
    command(),
  ]);
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "create", "--template", "feature", "--from", inputPath, "--repository", "acme/inari", "--json"],
      {
        repositoryRoot,
        createAdapter: (options) => {
          factoryCalls += 1;
          return new GitHubAdapter({ ...options, transport });
        },
      },
    );
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 1);
    assert.equal(
      transport.calls.some((args) => args.includes("POST")),
      false,
    );
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "SEMANTIC_VALIDATION_FAILED");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid Issue create reaches the adapter only after canonical rendering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "issue.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: { problem: "problem", proposal: "proposal", non_goals: "none", acceptance: "done" },
      title: "feat: create through Inari",
    }),
  );
  const transport = new CliStubTransport([
    ...remoteGovernanceResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha", REMOTE_ISSUE_TEMPLATE),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
    command(
      JSON.stringify({
        number: 22,
        title: "feat: create through Inari",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/issues/22",
        labels: [],
        assignees: [],
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "create", "--template", "feature", "--from", inputPath, "--repository", "acme/inari", "--json"],
      {
        repositoryRoot,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(transport.calls.length, 10);
    assert.deepEqual(transport.calls[7]?.slice(0, 6), [
      "api",
      "repos/acme/inari/issues",
      "--hostname",
      "github.com",
      "--method",
      "POST",
    ]);
    assert.match(transport.calls[7]?.join(" ") ?? "", /### Problem/);
    const output = JSON.parse(lines[0] ?? "{}") as { ok: boolean; governance?: { reconciled?: boolean } };
    assert.equal(output.ok, true);
    assert.equal(output.governance?.reconciled, true);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("structured validate and render use authoritative governance for --repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "issue.json");
  await writeFile(
    inputPath,
    JSON.stringify({ fields: { problem: "problem", proposal: "proposal", non_goals: "none", acceptance: "done" } }),
  );
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const validateTransport = new CliStubTransport(
      remoteGovernanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", REMOTE_ISSUE_TEMPLATE),
    );
    const validateExitCode = await runCli(
      ["issue", "validate", "--template", "remote", "--from", inputPath, "--repository", "acme/inari", "--json"],
      {
        repositoryRoot,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport: validateTransport }),
      },
    );
    assert.equal(validateExitCode, 0);
    assert.equal(JSON.parse(lines.at(-1) ?? "{}").valid, true);

    const renderTransport = new CliStubTransport(
      remoteGovernanceResponses(".github/ISSUE_TEMPLATE/remote.yml", "remote-sha", REMOTE_ISSUE_TEMPLATE),
    );
    const renderExitCode = await runCli(
      ["issue", "render", "--template", "remote", "--from", inputPath, "--repository", "acme/inari", "--json"],
      {
        repositoryRoot,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport: renderTransport }),
      },
    );
    assert.equal(renderExitCode, 0);
    assert.match(JSON.parse(lines.at(-1) ?? "{}").body, /### Problem/u);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("template list --repository reports authoritative remote templates", async () => {
  const transport = new CliStubTransport([
    command("gh version 2.0"),
    command(),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: GOVERNANCE_TREE_SHA,
        truncated: false,
        tree: [{ path: "docs/pull_request_template.txt", type: "blob", sha: "docs-sha" }],
      }),
    ),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["template", "list", "--repository", "acme/inari"], {
      repositoryRoot: "/tmp/stale-local-copy",
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(
      JSON.parse(lines[0] ?? "{}").templates.map((template: { path: string }) => template.path),
      ["docs/pull_request_template.txt"],
    );
  } finally {
    console.log = originalLog;
  }
});

test("valid PR create reaches the adapter with a canonical rendered body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "pr.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: { summary: "A deterministic summary", linked_issue: "Closes #22", validation: ["tests"] },
      title: "feat: create through Inari",
      head: "feature",
      base: "main",
    }),
  );
  const transport = new CliStubTransport([
    ...remoteGovernanceResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", REMOTE_PR_TEMPLATE, {
      sha: "pr-policy-sha",
      source: REMOTE_PR_POLICY,
    }),
    ...governanceFreshnessRecheckResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", {
      sha: "pr-policy-sha",
    }),
    command(
      JSON.stringify({
        number: 23,
        title: "feat: create through Inari",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/pulls/23",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", {
      sha: "pr-policy-sha",
    }),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["pr", "create", "--template", "default", "--from", inputPath, "--repository", "acme/inari", "--json"],
      {
        repositoryRoot,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(transport.calls.length, 11);
    assert.match(transport.calls[8]?.join(" ") ?? "", /## Summary/);
    assert.match(transport.calls[8]?.join(" ") ?? "", /## Linked issue/);
    const output = JSON.parse(lines[0] ?? "{}") as { ok: boolean; governance?: { reconciled?: boolean } };
    assert.equal(output.ok, true);
    assert.equal(output.governance?.reconciled, true);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("PR create preflights the actual resolved head branch, not the --from document's original value", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "pr.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: { summary: "A deterministic summary", linked_issue: "Closes #22", validation: ["tests"] },
      title: "feat: create through Inari",
      head: "not-governance-compliant",
      base: "main",
    }),
  );
  const transport = new CliStubTransport([
    ...remoteGovernanceResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", REMOTE_PR_TEMPLATE, {
      sha: "pr-policy-sha",
      source: REMOTE_PR_POLICY_WITH_BRANCH,
    }),
    ...governanceFreshnessRecheckResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", {
      sha: "pr-policy-sha",
    }),
    command(
      JSON.stringify({
        number: 24,
        title: "feat: create through Inari",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/pulls/24",
        draft: false,
        head: { ref: "feat/42-add-branch-preflight" },
        base: { ref: "main" },
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", {
      sha: "pr-policy-sha",
    }),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      [
        "pr",
        "create",
        "--template",
        "default",
        "--from",
        inputPath,
        "--head",
        "feat/42-add-branch-preflight",
        "--repository",
        "acme/inari",
        "--json",
      ],
      {
        repositoryRoot,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      },
    );
    assert.equal(exitCode, 0);
    const postCall = transport.calls.find((args) => args.includes("POST"));
    assert.ok(postCall?.includes("head=feat/42-add-branch-preflight"));
    assert.ok(!transport.calls.some((args) => args.some((token) => token.includes("not-governance-compliant"))));
    const output = JSON.parse(lines[0] ?? "{}") as { ok: boolean };
    assert.equal(output.ok, true);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("PR create fails closed before mutation when the actual resolved head branch violates repository branch governance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "pr.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: { summary: "A deterministic summary", linked_issue: "Closes #22", validation: ["tests"] },
      title: "feat: create through Inari",
      head: "feat/42-this-document-value-is-not-what-mutates",
      base: "main",
    }),
  );
  const transport = new CliStubTransport([
    ...remoteGovernanceResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", REMOTE_PR_TEMPLATE, {
      sha: "pr-policy-sha",
      source: REMOTE_PR_POLICY_WITH_BRANCH,
    }),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      [
        "pr",
        "create",
        "--template",
        "default",
        "--from",
        inputPath,
        "--head",
        "not-governance-compliant",
        "--repository",
        "acme/inari",
        "--json",
      ],
      {
        repositoryRoot,
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      },
    );
    assert.equal(exitCode, 3);
    assert.equal(transport.calls.length, 6);
    assert.equal(
      transport.calls.some((args) => args.includes("POST")),
      false,
    );
    const output = JSON.parse(lines[0] ?? "{}") as {
      error: { code: string; details?: { head?: string; pattern?: string } };
    };
    assert.equal(output.error.code, "GOVERNANCE_BRANCH_INVALID");
    assert.equal(output.error.details?.head, "not-governance-compliant");
    assert.equal(output.error.details?.pattern, "^feat/[0-9]+-[a-z0-9-]+$");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous remote template selection fails after target resolution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "issue.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: { problem: "problem", proposal: "proposal", acceptance: "done" },
      title: "feat: ambiguous",
    }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  let factoryCalls = 0;
  const transport = new CliStubTransport([
    command("gh version 2.0"),
    command(),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: GOVERNANCE_TREE_SHA,
        truncated: false,
        tree: [
          { path: ".github/ISSUE_TEMPLATE/bug.yml", type: "blob", sha: "bug-sha" },
          { path: ".github/ISSUE_TEMPLATE/feature.yml", type: "blob", sha: "feature-sha" },
        ],
      }),
    ),
  ]);
  try {
    const exitCode = await runCli(["issue", "create", "--from", inputPath, "--repository", "acme/inari", "--json"], {
      repositoryRoot,
      createAdapter: (options) => {
        factoryCalls += 1;
        return new GitHubAdapter({ ...options, transport });
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 1);
    assert.equal(transport.calls.length, 4);
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "TEMPLATE_SELECTION_AMBIGUOUS");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("arbitrary PR policy overrides are rejected before adapter construction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "pr.json");
  const policyPath = path.join(directory, "policy.yml");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: { summary: "A deterministic summary", linked_issue: "Closes #22", validation: ["tests"] },
      title: "feat: invalid policy",
      head: "feature",
      base: "main",
    }),
  );
  await writeFile(
    policyPath,
    "version: 1\ntemplate: default\nsections:\n  - section: stale_section\n    required: true\n",
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  let factoryCalls = 0;
  try {
    const exitCode = await runCli(
      ["pr", "create", "--template", "default", "--policy", policyPath, "--from", inputPath, "--json"],
      {
        repositoryRoot,
        createAdapter: () => {
          factoryCalls += 1;
          throw new Error("adapter must not be constructed for invalid policy");
        },
      },
    );
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 0);
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "GOVERNANCE_POLICY_OVERRIDE_FORBIDDEN");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported remote Issue Form semantics fail closed before mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-repository-"));
  const inputPath = path.join(root, "issue.json");
  const templateDirectory = path.join(root, ".github", "ISSUE_TEMPLATE");
  await mkdir(templateDirectory, { recursive: true });
  await writeFile(
    path.join(templateDirectory, "upload.yml"),
    "name: Upload\ndescription: Unsupported\nbody:\n  - type: upload\n    id: screenshots\n    attributes:\n      label: Screenshots\n",
  );
  await writeFile(inputPath, JSON.stringify({ fields: { screenshots: [] }, title: "feat: unsupported" }));
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  let factoryCalls = 0;
  const transport = new CliStubTransport(
    remoteGovernanceResponses(
      ".github/ISSUE_TEMPLATE/upload.yml",
      "upload-sha",
      "name: Upload\ndescription: Unsupported\nbody:\n  - type: upload\n    id: screenshots\n    attributes:\n      label: Screenshots\n",
    ),
  );
  try {
    const exitCode = await runCli(
      ["issue", "create", "--template", "upload", "--from", inputPath, "--repository", "acme/inari", "--json"],
      {
        repositoryRoot: root,
        createAdapter: (options) => {
          factoryCalls += 1;
          return new GitHubAdapter({ ...options, transport });
        },
      },
    );
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 1);
    assert.equal(
      transport.calls.some((args) => args.includes("POST")),
      false,
    );
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "ISSUE_FORM_UNSUPPORTED_TYPE");
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("issue get auto-selects the matching governed Issue Form and omits raw Markdown", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [
        { path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha", source: REMOTE_BUG_TEMPLATE },
        { path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE },
      ],
      {
        number: 21,
        title: "feat: canonical retrieval",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/21",
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "octocat" }],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "get", "21", "--repository", "acme/inari", "--json"], {
      repositoryRoot: "/tmp/stale-local-copy",
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.valid, true);
    assert.equal(output.projection, "canonical");
    assert.equal(output.classification, "valid");
    assert.equal(output.kind, "issue");
    assert.equal((output.template as Record<string, unknown>).path, ".github/ISSUE_TEMPLATE/feature.yml");
    assert.deepEqual(output.fields, {
      problem: "A reproducible problem",
      proposal: "A deterministic proposal",
      non_goals: "No unrelated scope",
      acceptance: "- [ ] The behavior is covered",
    });
    assert.deepEqual(output.metadata, {
      title: "feat: canonical retrieval",
      state: "open",
      labels: ["enhancement"],
      assignees: ["octocat"],
    });
    assert.equal("body" in output, false);
    assert.ok(transport.calls.some((args) => args.includes("repos/acme/inari/issues/21")));
  } finally {
    console.log = originalLog;
  }
});

test("issue get succeeds for a valid-template issue even when an unrelated sibling Issue Form is malformed", async () => {
  const MALFORMED_ISSUE_TEMPLATE = "name: [this is not valid\n  yaml: at all: :::\n";
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [
        { path: ".github/ISSUE_TEMPLATE/architecture.yml", sha: "architecture-sha", source: MALFORMED_ISSUE_TEMPLATE },
        { path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE },
      ],
      {
        number: 21,
        title: "feat: canonical retrieval",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/21",
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "octocat" }],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "get", "21", "--repository", "acme/inari", "--json"], {
      repositoryRoot: "/tmp/stale-local-copy",
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.valid, true);
    assert.equal(output.classification, "valid");
    assert.equal((output.template as Record<string, unknown>).path, ".github/ISSUE_TEMPLATE/feature.yml");
  } finally {
    console.log = originalLog;
  }
});

test("issue get fails closed with a bounded diagnostic when every candidate Issue Form fails to compile", async () => {
  const MALFORMED_ISSUE_TEMPLATE = "name: [this is not valid\n  yaml: at all: :::\n";
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/architecture.yml", sha: "architecture-sha", source: MALFORMED_ISSUE_TEMPLATE }],
      {
        number: 21,
        title: "feat: canonical retrieval",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/21",
        labels: [{ name: "enhancement" }],
        assignees: [{ login: "octocat" }],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "get", "21", "--repository", "acme/inari", "--json"], {
      repositoryRoot: "/tmp/stale-local-copy",
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.valid, false);
    const diagnostics = output.diagnostics as readonly { readonly code: string; readonly path: string }[];
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "EXISTING_TEMPLATE_COMPILE_FAILED" &&
          diagnostic.path === ".github/ISSUE_TEMPLATE/architecture.yml",
      ),
    );
  } finally {
    console.log = originalLog;
  }
});

test("pr get returns canonical fields and minimal pull request metadata", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 43,
        title: "feat: canonical retrieval",
        body: REMOTE_PR_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/pull/43",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["pr", "get", "43", "--repository", "acme/inari", "--json"], {
      repositoryRoot: "/tmp/stale-local-copy",
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.valid, true);
    assert.equal(output.projection, "canonical");
    assert.equal(output.classification, "valid");
    assert.equal(output.kind, "pull_request");
    const fields = output.fields as Record<string, unknown>;
    assert.equal(fields.summary, "A deterministic pull request summary");
    assert.equal(fields.linked_issue, "Closes #21");
    assert.deepEqual(fields.validation, ["tests"]);
    assert.deepEqual(output.metadata, {
      title: "feat: canonical retrieval",
      state: "open",
      draft: false,
      head: "feature",
      base: "main",
    });
    assert.equal("body" in output, false);
  } finally {
    console.log = originalLog;
  }
});

test("get returns deterministic diagnostics and never guesses fields for invalid artifacts", async () => {
  const cases = [
    {
      name: "wrong-template",
      domain: "issue" as const,
      number: "44",
      body: "### Other\n\nvalue\n",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      expectedClassification: "wrong-template",
      expectedDiagnostic: "EXISTING_WRONG_TEMPLATE",
    },
    {
      name: "unparseable",
      domain: "issue" as const,
      number: "45",
      body: "not a canonical artifact\n",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      expectedClassification: "unparseable",
      expectedDiagnostic: "EXISTING_UNPARSEABLE",
    },
    {
      name: "ambiguous",
      domain: "issue" as const,
      number: "46",
      body: REMOTE_ISSUE_BODY,
      templates: [
        { path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha", source: REMOTE_ISSUE_TEMPLATE },
        { path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE },
      ],
      expectedClassification: "ambiguous",
      expectedDiagnostic: "EXISTING_AMBIGUOUS_TEMPLATE",
    },
    {
      name: "semantic",
      domain: "pr" as const,
      number: "47",
      body: REMOTE_PR_BODY.replace("Closes #21", "No linked issue"),
      templates: [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      policy: { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
      expectedClassification: "semantic",
      expectedDiagnostic: "INPUT_PATTERN",
    },
  ];

  for (const testCase of cases) {
    const transport = new CliStubTransport(
      remoteArtifactResponses(
        testCase.templates,
        testCase.domain === "issue"
          ? {
              number: Number(testCase.number),
              title: "Existing artifact",
              body: testCase.body,
              state: "open",
              html_url: `https://github.com/acme/inari/issues/${testCase.number}`,
              labels: [],
              assignees: [],
            }
          : {
              number: Number(testCase.number),
              title: "Existing artifact",
              body: testCase.body,
              state: "open",
              html_url: `https://github.com/acme/inari/pull/${testCase.number}`,
              draft: false,
              head: { ref: "feature" },
              base: { ref: "main" },
            },
        testCase.policy,
      ),
    );
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const exitCode = await runCli([testCase.domain, "get", testCase.number, "--repository", "acme/inari", "--json"], {
        repositoryRoot: "/tmp/stale-local-copy",
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      });
      assert.equal(exitCode, 2, testCase.name);
      const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      assert.equal(output.valid, false, testCase.name);
      assert.equal(output.projection, "unavailable", testCase.name);
      assert.equal(output.classification, testCase.expectedClassification, testCase.name);
      assert.equal("fields" in output, false, testCase.name);
      const diagnostics = [
        ...((output.diagnostics as readonly { code: string }[] | undefined) ?? []),
        ...((output.violations as readonly { code: string }[] | undefined) ?? []),
      ];
      assert.ok(
        diagnostics.some((diagnostic: { code: string }) => diagnostic.code === testCase.expectedDiagnostic),
        testCase.name,
      );
    } finally {
      console.log = originalLog;
    }
  }
});

test("issue check is read-only and classifies a canonical artifact as current", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 80,
        title: "feat: remediation",
        body: `${REMOTE_ISSUE_BODY.replace("- [ ] The behavior", "\\- [ ] The behavior")}\n<!-- inari:template {"version":"1","kind":"issue","path":".github/ISSUE_TEMPLATE/feature.yml"} -->\n`,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "check", "80", "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.status, "valid-current");
    assert.equal(output.normalizable, false);
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
  }
});

test("issue edit dry-run emits a bounded diff and performs no mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(root, "patch.json");
  await writeFile(inputPath, JSON.stringify({ fields: { problem: "A changed problem" } }), "utf8");
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "edit", "80", "--from", inputPath, "--dry-run", "--repository", "acme/inari"],
      { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    assert.equal(exitCode, 0);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.dryRun, true);
    assert.equal(output.changed, true);
    assert.equal((output.diff as Record<string, unknown>).changed, true);
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("pull request normalize dry-run reports representation drift without mutation", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 81,
        title: "feat: remediation",
        body: REMOTE_PR_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/pull/81",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["pr", "normalize", "81", "--dry-run", "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.dryRun, true);
    assert.equal(output.changed, true);
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
  }
});

test("explicit PR template normalizes a wrong-order body and preserves recoverable values", async () => {
  const wrongTemplateBody = [
    "## Linked issue",
    "",
    "Closes #112",
    "",
    "## Summary",
    "",
    "A deterministic pull request summary",
    "",
    "## Scope",
    "",
    "### Included",
    "",
    "Implemented scope.",
    "",
    "### Excluded",
    "",
    "Excluded scope.",
    "",
    "## Validation",
    "",
    "- [x] Tests",
    "- [ ] Build",
    "- [ ] Typecheck",
    "- [ ] Package check",
    "",
    "## Breaking changes",
    "",
    "No.",
    "",
  ].join("\n");
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 112,
        title: "feat: remediation",
        body: wrongTemplateBody,
        state: "open",
        html_url: "https://github.com/acme/inari/pull/112",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["pr", "normalize", "112", "--template", "default", "--dry-run", "--repository", "acme/inari"],
      { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.dryRun, true);
    assert.equal(output.changed, true);
    assert.equal((output.diff as { rendered: { changed: boolean } }).rendered.changed, true);
    assert.equal(
      (output.diff as { semantic: readonly unknown[] }).semantic.some((change) =>
        JSON.stringify(change).includes("A deterministic pull request summary"),
      ),
      false,
    );
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
  }
});

test("explicit PR template lets edit repair a malformed body without inferred-template failure", async () => {
  const malformedBody = [
    "## Linked issue",
    "",
    "Closes #112",
    "",
    "## Summary",
    "",
    "A deterministic pull request summary",
    "",
    "## Validation",
    "",
    "- [x] Tests",
    "",
    "## Unexpected trailing section",
    "",
    "recoverable noise",
    "",
  ].join("\n");
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 114,
        title: "feat: remediation",
        body: malformedBody,
        state: "open",
        html_url: "https://github.com/acme/inari/pull/114",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      [
        "pr",
        "edit",
        "114",
        "--template",
        "default",
        "--field",
        "summary=An updated deterministic summary",
        "--dry-run",
        "--repository",
        "acme/inari",
      ],
      { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.dryRun, true);
    assert.equal(output.changed, true);
    assert.equal(
      (output.diff as { semantic: readonly { path: string }[] }).semantic.some(
        (change) => change.path === "$.fields.summary",
      ),
      true,
    );
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
  }
});

test("explicit PR normalization returns bounded requirements for unrecoverable required values", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 113,
        title: "feat: incomplete",
        body: "## Summary\n\nA deterministic pull request summary\n",
        state: "open",
        html_url: "https://github.com/acme/inari/pull/113",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["pr", "normalize", "113", "--template", "default", "--json", "--repository", "acme/inari"],
      { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as {
      error?: { code?: string; details?: { requirements?: { missingFields?: readonly { field: string }[] } } };
    };
    assert.equal(output.error?.code, "NORMALIZATION_UNSAFE");
    assert.deepEqual(
      output.error?.details?.requirements?.missingFields?.map((field) => field.field),
      ["linked_issue", "validation"],
    );
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
  }
});

test("check classifies ambiguous, unsupported, and semantically-invalid existing artifacts without mutating", async () => {
  const cases = [
    {
      name: "unsupported (unparseable)",
      domain: "issue" as const,
      number: "45",
      body: "not a canonical artifact\n",
      templates: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      expectedStatus: "unsupported",
    },
    {
      name: "ambiguous",
      domain: "issue" as const,
      number: "46",
      body: REMOTE_ISSUE_BODY,
      templates: [
        { path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha", source: REMOTE_ISSUE_TEMPLATE },
        { path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE },
      ],
      expectedStatus: "ambiguous",
    },
    {
      name: "semantically-invalid",
      domain: "pr" as const,
      number: "47",
      body: REMOTE_PR_BODY.replace("Closes #21", "No linked issue"),
      templates: [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      policy: { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
      expectedStatus: "semantically-invalid",
    },
  ];

  for (const testCase of cases) {
    const transport = new CliStubTransport(
      remoteArtifactResponses(
        testCase.templates,
        testCase.domain === "issue"
          ? {
              number: Number(testCase.number),
              title: "Existing artifact",
              body: testCase.body,
              state: "open",
              html_url: `https://github.com/acme/inari/issues/${testCase.number}`,
              labels: [],
              assignees: [],
            }
          : {
              number: Number(testCase.number),
              title: "Existing artifact",
              body: testCase.body,
              state: "open",
              html_url: `https://github.com/acme/inari/pull/${testCase.number}`,
              draft: false,
              head: { ref: "feature" },
              base: { ref: "main" },
            },
        testCase.policy,
      ),
    );
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const exitCode = await runCli([testCase.domain, "check", testCase.number, "--repository", "acme/inari"], {
        createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
      });
      assert.equal(exitCode, 2, testCase.name);
      const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      assert.equal(output.status, testCase.expectedStatus, testCase.name);
      assert.equal(output.valid, false, testCase.name);
      assert.equal(
        transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
        false,
        testCase.name,
      );
    } finally {
      console.log = originalLog;
    }
  }
});

test("issue check on a multi-template wrong-template match emits diagnostics once and a compact attempted-templates summary", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [
        { path: ".github/ISSUE_TEMPLATE/bug.yml", sha: "bug-sha", source: REMOTE_BUG_TEMPLATE },
        { path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE },
      ],
      {
        number: 74,
        title: "Existing artifact",
        body: "### Other\n\nvalue\n",
        state: "open",
        html_url: "https://github.com/acme/inari/issues/74",
        labels: [],
        assignees: [],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "check", "74", "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.classification, "wrong-template");
    assert.equal(output.valid, false);
    const diagnostics = output.diagnostics as readonly { code: string }[];
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "EXISTING_WRONG_TEMPLATE");
    assert.equal("violations" in output, false);
    assert.deepEqual(output.attemptedTemplates, [
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/feature.yml",
    ]);
  } finally {
    console.log = originalLog;
  }
});

test("a valid template identity marker resolves deterministically even when structural matching alone would be ambiguous", async () => {
  const alphaTemplate = [
    "name: Alpha",
    "description: Alpha template",
    "body:",
    "  - type: textarea",
    "    id: summary",
    "    attributes: { label: Summary }",
    "    validations: { required: true }",
    "",
  ].join("\n");
  const betaTemplate = [
    "name: Beta",
    "description: Beta template",
    "body:",
    "  - type: textarea",
    "    id: summary",
    "    attributes: { label: Summary }",
    "    validations: { required: true }",
    "",
  ].join("\n");
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [
        { path: ".github/ISSUE_TEMPLATE/alpha.yml", sha: "alpha-sha", source: alphaTemplate },
        { path: ".github/ISSUE_TEMPLATE/beta.yml", sha: "beta-sha", source: betaTemplate },
      ],
      {
        number: 91,
        title: "Marker-tagged issue",
        body: '### Summary\n\nHello\n\n<!-- inari:template {"version":"1","kind":"issue","path":".github/ISSUE_TEMPLATE/beta.yml"} -->\n',
        state: "open",
        html_url: "https://github.com/acme/inari/issues/91",
        labels: [],
        assignees: [],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "check", "91", "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.classification, "valid");
    assert.equal((output.template as { path?: string } | undefined)?.path, ".github/ISSUE_TEMPLATE/beta.yml");
  } finally {
    console.log = originalLog;
  }
});

test("a template identity marker naming an unknown template fails closed instead of falling back to structural matching", async () => {
  const alphaTemplate = [
    "name: Alpha",
    "description: Alpha template",
    "body:",
    "  - type: textarea",
    "    id: summary",
    "    attributes: { label: Summary }",
    "    validations: { required: true }",
    "",
  ].join("\n");
  const transport = new CliStubTransport(
    remoteArtifactResponses([{ path: ".github/ISSUE_TEMPLATE/alpha.yml", sha: "alpha-sha", source: alphaTemplate }], {
      number: 92,
      title: "Marker-tagged issue",
      body: '### Summary\n\nHello\n\n<!-- inari:template {"version":"1","kind":"issue","path":".github/ISSUE_TEMPLATE/gone.yml"} -->\n',
      state: "open",
      html_url: "https://github.com/acme/inari/issues/92",
      labels: [],
      assignees: [],
    }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "check", "92", "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.classification, "wrong-template");
    assert.equal(output.valid, false);
    assert.equal("template" in output, false);
    const diagnostics = output.diagnostics as readonly { code: string }[];
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "EXISTING_TEMPLATE_MARKER_INVALID");
  } finally {
    console.log = originalLog;
  }
});

test("an oversized template identity marker fails closed instead of being ignored as absent", async () => {
  const alphaTemplate = [
    "name: Alpha",
    "description: Alpha template",
    "body:",
    "  - type: textarea",
    "    id: summary",
    "    attributes: { label: Summary }",
    "    validations: { required: true }",
    "",
  ].join("\n");
  const oversizedPath = `.github/ISSUE_TEMPLATE/${"a".repeat(600)}.yml`;
  const transport = new CliStubTransport(
    remoteArtifactResponses([{ path: ".github/ISSUE_TEMPLATE/alpha.yml", sha: "alpha-sha", source: alphaTemplate }], {
      number: 93,
      title: "Marker-tagged issue",
      // The body otherwise parses cleanly under alpha.yml; only the marker is
      // corrupted. A naive implementation could silently ignore the oversized
      // marker line as "absent" and fall back to a structural match that
      // happens to succeed, hiding the corrupted marker instead of failing
      // closed on it.
      body: `### Summary\n\nHello\n\n<!-- inari:template {"version":"1","kind":"issue","path":"${oversizedPath}"} -->\n`,
      state: "open",
      html_url: "https://github.com/acme/inari/issues/93",
      labels: [],
      assignees: [],
    }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "check", "93", "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 2);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.classification, "wrong-template");
    assert.equal(output.valid, false);
    assert.equal("template" in output, false);
    const diagnostics = output.diagnostics as readonly { code: string }[];
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, "EXISTING_TEMPLATE_MARKER_INVALID");
  } finally {
    console.log = originalLog;
  }
});

test("issue edit performs the mutation, reaches the adapter, and reports reconciled governance", async () => {
  const transport = new CliStubTransport([
    ...remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      },
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
  ]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "patch.json");
  await writeFile(inputPath, JSON.stringify({ fields: { problem: "A changed problem" } }), "utf8");
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "edit", "80", "--from", inputPath, "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.mutation, "applied");
    assert.equal((output.governance as { reconciled?: boolean }).reconciled, true);
    assert.ok(transport.calls.some((args) => args.includes("PATCH")));
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("pr edit rejects a head-branch change before mutation, since PRs cannot change head through this model", async () => {
  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 81,
        title: "feat: remediation",
        body: REMOTE_PR_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/pull/81",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "patch.json");
  await writeFile(inputPath, JSON.stringify({ fields: {}, head: "other-branch" }), "utf8");
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["pr", "edit", "81", "--from", inputPath, "--repository", "acme/inari", "--json"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 2, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as { error?: { code?: string } };
    assert.equal(output.error?.code, "PR_HEAD_CHANGE_UNSUPPORTED");
    assert.equal(
      transport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("issue sync mutates once to converge, then a repeated sync against the converged artifact is an idempotent no-op", async () => {
  const desiredFields = {
    problem: "A reproducible problem",
    proposal: "A deterministic proposal",
    non_goals: "No unrelated scope",
    acceptance: "- [ ] The behavior is covered",
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "desired.json");
  await writeFile(
    inputPath,
    JSON.stringify({ fields: { ...desiredFields, problem: "A converged problem" }, title: "feat: remediation" }),
    "utf8",
  );
  const convergedBody = `${REMOTE_ISSUE_BODY.replace("A reproducible problem", "A converged problem").replace(
    "- [ ] The behavior is covered",
    "\\- [ ] The behavior is covered",
  )}\n<!-- inari:template {"version":"1","kind":"issue","path":".github/ISSUE_TEMPLATE/feature.yml"} -->\n`;

  const firstTransport = new CliStubTransport([
    ...remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      },
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: convergedBody,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const firstExitCode = await runCli(["issue", "sync", "80", "--from", inputPath, "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport: firstTransport }),
    });
    assert.equal(firstExitCode, 0, lines[0]);
    const firstOutput = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(firstOutput.mutation, "applied");
    assert.ok(firstTransport.calls.some((args) => args.includes("PATCH")));

    lines.length = 0;
    const secondTransport = new CliStubTransport(
      remoteArtifactResponses(
        [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
        {
          number: 80,
          title: "feat: remediation",
          body: convergedBody,
          state: "open",
          html_url: "https://github.com/acme/inari/issues/80",
          labels: [],
          assignees: [],
        },
      ),
    );
    const secondExitCode = await runCli(["issue", "sync", "80", "--from", inputPath, "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport: secondTransport }),
    });
    assert.equal(secondExitCode, 0, lines[0]);
    const secondOutput = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(secondOutput.noOp, true);
    assert.equal(
      secondTransport.calls.some((args) => args.includes("PATCH") || args.includes("POST")),
      false,
    );
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("pr sync reaches the adapter with a converged canonical body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "desired.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: {
        summary: "A converged pull request summary",
        linked_issue: "Closes #21",
        included: "Implemented scope.",
        excluded: "Excluded scope.",
        validation: ["tests"],
        breaking_changes: "Yes, this changes behavior.",
      },
      title: "feat: remediation",
      head: "feature",
      base: "main",
    }),
    "utf8",
  );
  const transport = new CliStubTransport([
    ...remoteArtifactResponses(
      [{ path: ".github/PULL_REQUEST_TEMPLATE.md", sha: "pr-template-sha", source: REMOTE_PR_TEMPLATE }],
      {
        number: 81,
        title: "feat: remediation",
        body: REMOTE_PR_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/pull/81",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      { sha: "pr-policy-sha", source: REMOTE_PR_POLICY },
    ),
    ...governanceFreshnessRecheckResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", {
      sha: "pr-policy-sha",
    }),
    command(
      JSON.stringify({
        number: 81,
        title: "feat: remediation",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/pull/81",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", {
      sha: "pr-policy-sha",
    }),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["pr", "sync", "81", "--from", inputPath, "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.mutation, "applied");
    assert.ok(transport.calls.some((args) => args.includes("PATCH")));
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("issue sync with an explicit --template replaces a current body that does not parse under any repository-native template", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "desired.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: {
        problem: "A reproducible problem",
        proposal: "A deterministic proposal",
        non_goals: "No unrelated scope",
        acceptance: "- [ ] The behavior is covered",
      },
      title: "feat: remediation",
    }),
    "utf8",
  );
  const wrongTemplateBody = "### Summary\n\nFree-form body never created from a repository template\n";

  const transport = new CliStubTransport([
    ...remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 97,
        title: "feat: pre-existing",
        body: wrongTemplateBody,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/97",
        labels: [],
        assignees: [],
      },
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
    command(
      JSON.stringify({
        number: 97,
        title: "feat: pre-existing",
        body: wrongTemplateBody,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/97",
        labels: [],
        assignees: [],
      }),
    ),
    command(
      JSON.stringify({
        number: 97,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/97",
        labels: [],
        assignees: [],
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "sync", "97", "--template", "feature", "--from", inputPath, "--repository", "acme/inari"],
      { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.mutation, "applied");
    assert.ok(transport.calls.some((args) => args.includes("PATCH")));
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("issue sync without an explicit --template still refuses to replace a current body that does not parse under any repository-native template", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "desired.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      fields: {
        problem: "A reproducible problem",
        proposal: "A deterministic proposal",
        non_goals: "No unrelated scope",
        acceptance: "- [ ] The behavior is covered",
      },
      title: "feat: remediation",
    }),
    "utf8",
  );

  const transport = new CliStubTransport(
    remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 97,
        title: "feat: pre-existing",
        body: "### Summary\n\nFree-form body never created from a repository template\n",
        state: "open",
        html_url: "https://github.com/acme/inari/issues/97",
        labels: [],
        assignees: [],
      },
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "sync", "97", "--from", inputPath, "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 2, lines[0]);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("edit surfaces governance-generation reconciliation instead of hiding a crossed-generation success", async () => {
  const transport = new CliStubTransport([
    ...remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      },
    ),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: GOVERNANCE_TREE_SHA,
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", type: "blob", sha: "feature-sha" }],
      }),
    ),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    command(JSON.stringify({ default_branch: "main" })),
    command(
      JSON.stringify({
        sha: "tree-sha-after-mutation",
        truncated: false,
        tree: [{ path: ".github/ISSUE_TEMPLATE/feature.yml", type: "blob", sha: "feature-sha-changed" }],
      }),
    ),
  ]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-remediation-"));
  const inputPath = path.join(directory, "patch.json");
  await writeFile(inputPath, JSON.stringify({ fields: { problem: "A changed problem" } }), "utf8");
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "edit", "80", "--from", inputPath, "--repository", "acme/inari"], {
      createAdapter: (options) => new GitHubAdapter({ ...options, transport }),
    });
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.mutation, "applied");
    const governance = output.governance as { reconciled?: boolean; currentGeneration?: string };
    assert.equal(governance.reconciled, false);
    assert.equal(governance.currentGeneration, "tree-sha-after-mutation");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

async function captureJson(argv: readonly string[]): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli([...argv]);
    return { exitCode, output: JSON.parse(lines[0] ?? "{}") as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}

async function runIssueValidateDirectFields(
  argv: readonly string[],
  repositoryRoot: string,
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const transport = new CliStubTransport(
    remoteGovernanceResponses(
      ".github/ISSUE_TEMPLATE/direct-fields.yml",
      "direct-fields-sha",
      REMOTE_ISSUE_TEMPLATE_DIRECT_FIELDS,
    ),
  );
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "validate", "--template", "direct-fields", "--repository", "acme/inari", "--json", ...argv],
      { repositoryRoot, createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    return { exitCode, output: JSON.parse(lines[0] ?? "{}") as Record<string, unknown> };
  } finally {
    console.log = originalLog;
  }
}

test("issue validate accepts a direct scalar --field and matches equivalent --from JSON input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-direct-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "issue.json");
  await writeFile(inputPath, JSON.stringify({ fields: { problem: "A reproducible problem" } }));
  try {
    const fromResult = await runIssueValidateDirectFields(["--from", inputPath], repositoryRoot);
    const fieldResult = await runIssueValidateDirectFields(
      ["--field", "problem=A reproducible problem"],
      repositoryRoot,
    );
    assert.equal(fieldResult.exitCode, fromResult.exitCode);
    assert.deepEqual(fieldResult.output, fromResult.output);
    assert.deepEqual((fieldResult.output.values as Record<string, unknown>).problem, "A reproducible problem");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("issue validate accepts repeated --field values for a list field, preserving argv order", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = await runIssueValidateDirectFields(
    [
      "--field",
      "areas=docs",
      "--field",
      "category=bug",
      "--field",
      "areas=cli",
      "--field",
      "problem=A reproducible problem",
    ],
    repositoryRoot,
  );
  const values = result.output.values as Record<string, unknown>;
  assert.deepEqual(values.areas, ["docs", "cli"]);
});

test("issue validate accepts repeated --field values for a checklist field, selecting items by id in argv order", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = await runIssueValidateDirectFields(
    ["--field", "acceptance=Docs", "--field", "acceptance=Tests"],
    repositoryRoot,
  );
  const values = result.output.values as Record<string, unknown>;
  assert.deepEqual(values.acceptance, ["Docs", "Tests"]);
});

test("direct --field input and equivalent --from JSON produce identical canonical output across scalar, list, and checklist fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-direct-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "issue.json");
  const completeFields = {
    problem: "A reproducible problem",
    category: "bug",
    areas: ["cli", "docs"],
    acceptance: ["Tests"],
  };
  await writeFile(inputPath, JSON.stringify({ fields: completeFields }));
  try {
    const fromResult = await runIssueValidateDirectFields(["--from", inputPath], repositoryRoot);
    const fieldResult = await runIssueValidateDirectFields(
      [
        "--field",
        "problem=A reproducible problem",
        "--field",
        "category=bug",
        "--field",
        "areas=cli",
        "--field",
        "areas=docs",
        "--field",
        "acceptance=Tests",
      ],
      repositoryRoot,
    );
    assert.equal(fromResult.output.valid, true);
    assert.equal(fieldResult.output.valid, true);
    assert.deepEqual(fieldResult.output, fromResult.output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pr validate accepts direct --field input equivalent to --from JSON for a governed pull request template", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-direct-"));
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const inputPath = path.join(directory, "pr.json");
  await writeFile(
    inputPath,
    JSON.stringify({ fields: { summary: "A deterministic pull request summary", linked_issue: "Closes #21" } }),
  );
  try {
    const fromTransport = new CliStubTransport(
      remoteGovernanceResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", REMOTE_PR_TEMPLATE, {
        sha: "pr-policy-sha",
        source: REMOTE_PR_POLICY,
      }),
    );
    const fieldTransport = new CliStubTransport(
      remoteGovernanceResponses(".github/PULL_REQUEST_TEMPLATE.md", "pr-template-sha", REMOTE_PR_TEMPLATE, {
        sha: "pr-policy-sha",
        source: REMOTE_PR_POLICY,
      }),
    );
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    let fromOutput: Record<string, unknown>;
    let fieldOutput: Record<string, unknown>;
    try {
      lines.length = 0;
      await runCli(
        ["pr", "validate", "--template", "default", "--from", inputPath, "--repository", "acme/inari", "--json"],
        {
          repositoryRoot,
          createAdapter: (options) => new GitHubAdapter({ ...options, transport: fromTransport }),
        },
      );
      fromOutput = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

      lines.length = 0;
      await runCli(
        [
          "pr",
          "validate",
          "--template",
          "default",
          "--field",
          "summary=A deterministic pull request summary",
          "--field",
          "linked_issue=Closes #21",
          "--repository",
          "acme/inari",
          "--json",
        ],
        { repositoryRoot, createAdapter: (options) => new GitHubAdapter({ ...options, transport: fieldTransport }) },
      );
      fieldOutput = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(fieldOutput, fromOutput);
    assert.deepEqual((fieldOutput.values as Record<string, unknown>).summary, "A deterministic pull request summary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unknown --field name is rejected with a compact, contract-derived diagnostic", async () => {
  const result = await captureJson(["issue", "validate", "--template", "feature", "--field", "problm=x", "--json"]);
  assert.equal(result.exitCode, 2);
  const error = result.output.error as {
    code: string;
    path?: string;
    details?: { field?: string; allowedFields?: string[]; allowedFieldCount?: number; suggestions?: string[] };
  };
  assert.equal(error.code, "FIELD_UNKNOWN");
  assert.equal(error.path, "--field");
  assert.equal(error.details?.field, "problm");
  assert.ok(error.details?.allowedFields?.includes("problem"));
  assert.ok((error.details?.allowedFieldCount ?? 0) > 0);
  assert.ok(error.details?.suggestions?.includes("problem"));
});

test("a scalar field supplied twice via --field is rejected as a duplicate", async () => {
  const result = await captureJson([
    "issue",
    "validate",
    "--template",
    "feature",
    "--field",
    "problem=first",
    "--field",
    "problem=second",
    "--json",
  ]);
  assert.equal(result.exitCode, 2);
  const error = result.output.error as { code: string; details?: { field?: string; occurrences?: number } };
  assert.equal(error.code, "FIELD_DUPLICATE");
  assert.equal(error.details?.field, "problem");
  assert.equal(error.details?.occurrences, 2);
});

test("the same field named by both --from and --field conflicts, regardless of which flag appears first in argv", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gh-inari-cli-direct-"));
  const inputPath = path.join(directory, "issue.json");
  await writeFile(inputPath, JSON.stringify({ fields: { problem: "from json" } }));
  try {
    const fieldFirst = await captureJson([
      "issue",
      "validate",
      "--template",
      "feature",
      "--field",
      "problem=from field",
      "--from",
      inputPath,
      "--json",
    ]);
    const fromFirst = await captureJson([
      "issue",
      "validate",
      "--template",
      "feature",
      "--from",
      inputPath,
      "--field",
      "problem=from field",
      "--json",
    ]);
    assert.equal(fieldFirst.exitCode, 2);
    assert.equal(fromFirst.exitCode, 2);
    assert.deepEqual(fieldFirst.output, fromFirst.output);
    const error = fieldFirst.output.error as { code: string; details?: { fields?: string[] } };
    assert.equal(error.code, "FIELD_CONFLICT");
    assert.deepEqual(error.details?.fields, ["problem"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("issue edit accepts a direct --field patch without --from, changing only the supplied field", async () => {
  const transport = new CliStubTransport([
    ...remoteArtifactResponses(
      [{ path: ".github/ISSUE_TEMPLATE/feature.yml", sha: "feature-sha", source: REMOTE_ISSUE_TEMPLATE }],
      {
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      },
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: REMOTE_ISSUE_BODY,
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    command(
      JSON.stringify({
        number: 80,
        title: "feat: remediation",
        body: "Rendered body",
        state: "open",
        html_url: "https://github.com/acme/inari/issues/80",
        labels: [],
        assignees: [],
      }),
    ),
    ...governanceFreshnessRecheckResponses(".github/ISSUE_TEMPLATE/feature.yml", "feature-sha"),
  ]);
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(
      ["issue", "edit", "80", "--field", "problem=A changed problem", "--repository", "acme/inari"],
      { createAdapter: (options) => new GitHubAdapter({ ...options, transport }) },
    );
    assert.equal(exitCode, 0, lines[0]);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(output.mutation, "applied");
    assert.equal((output.governance as { reconciled?: boolean }).reconciled, true);
    assert.ok(transport.calls.some((args) => args.includes("PATCH")));
  } finally {
    console.log = originalLog;
  }
});

test("--field names accepted at runtime match exactly the fields projected by `schema`, with no parallel field table", async () => {
  const schemaResult = await captureJson(["issue", "schema", "feature", "--json"]);
  assert.equal(schemaResult.exitCode, 0);
  const schema = schemaResult.output.schema as { properties: Record<string, unknown> };
  const fieldNames = Object.keys(schema.properties).sort();
  assert.ok(fieldNames.includes("problem"));

  const args = fieldNames.flatMap((name) => ["--field", `${name}=A placeholder value`]);
  const validateResult = await captureJson(["issue", "validate", "--template", "feature", ...args, "--json"]);
  assert.notEqual((validateResult.output.error as { code?: string } | undefined)?.code, "FIELD_UNKNOWN");
  assert.equal(validateResult.exitCode, 0);
  assert.equal(validateResult.output.valid, true);
  assert.deepEqual(Object.keys(validateResult.output.values as Record<string, unknown>).sort(), fieldNames);
});

test("--field on a command that does not resolve an artifact input document fails explicitly instead of being silently ignored", async () => {
  const cases: readonly (readonly string[])[] = [
    ["issue", "schema", "feature", "--field", "problem=x"],
    ["issue", "explain", "1", "--field", "problem=x"],
    ["issue", "get", "1", "--field", "problem=x"],
    ["issue", "check", "1", "--field", "problem=x"],
    ["issue", "normalize", "1", "--field", "problem=x"],
    ["template", "list", "--field", "problem=x"],
  ];
  for (const argv of cases) {
    const result = await captureJson([...argv, "--json"]);
    assert.equal(result.exitCode, 1, argv.join(" "));
    const error = result.output.error as { code?: string; path?: string } | undefined;
    assert.equal(error?.code, "FIELD_UNSUPPORTED_COMMAND", argv.join(" "));
    assert.equal(error?.path, "--field", argv.join(" "));
  }
});

test("`issue validate <number> --field ...` does not silently fall back to the existing-artifact path and ignore the field", async () => {
  // No network responses are stubbed: if --field were ignored and this fell through to
  // runExistingValidation, the unstubbed adapter call would surface as an unrelated GitHub
  // adapter failure instead of the local schema/validation result this test asserts on.
  const result = await captureJson([
    "issue",
    "validate",
    "--template",
    "feature",
    "1",
    "--field",
    "problem=A reproducible problem",
    "--json",
  ]);
  assert.notEqual((result.output.error as { code?: string } | undefined)?.code, "FIELD_UNSUPPORTED_COMMAND");
  const values = result.output.values as Record<string, unknown> | undefined;
  assert.equal(values?.problem, "A reproducible problem");
});

test("schema's directFields projection matches accepted --field names, types, and repeatability at runtime", async () => {
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const schemaTransport = new CliStubTransport(
    remoteGovernanceResponses(
      ".github/ISSUE_TEMPLATE/direct-fields.yml",
      "direct-fields-sha",
      REMOTE_ISSUE_TEMPLATE_DIRECT_FIELDS,
    ),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  let directFields: readonly {
    name: string;
    type: string;
    required: boolean;
    repeatable: boolean;
    cliSyntax: string;
  }[];
  try {
    const exitCode = await runCli(["issue", "schema", "direct-fields", "--repository", "acme/inari", "--json"], {
      repositoryRoot,
      createAdapter: (options) => new GitHubAdapter({ ...options, transport: schemaTransport }),
    });
    assert.equal(exitCode, 0);
    directFields = (JSON.parse(lines[0] ?? "{}") as { directFields: typeof directFields }).directFields;
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(
    directFields.map((entry) => entry.name),
    ["acceptance", "areas", "category", "problem"],
  );
  const byName = new Map(directFields.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.get("problem"), {
    name: "problem",
    type: "string",
    required: true,
    repeatable: false,
    cliSyntax: "--field problem=<value>",
  });
  assert.deepEqual(byName.get("areas"), {
    name: "areas",
    type: "array",
    required: false,
    repeatable: true,
    cliSyntax: "--field areas=<value> (repeatable)",
  });

  // The projection is not just documentation: build the exact --field args it describes
  // (repeating only the repeatable fields, with values valid for that field) and confirm the
  // runtime accepts every one of them and reaches a fully valid canonical result.
  const sampleValues: Readonly<Record<string, readonly string[]>> = {
    problem: ["A reproducible problem"],
    category: ["bug"],
    areas: ["cli", "docs"],
    acceptance: ["Tests"],
  };
  const args = directFields.flatMap((entry) => {
    const values = sampleValues[entry.name] ?? [];
    return (entry.repeatable ? values : values.slice(0, 1)).flatMap((value) => ["--field", `${entry.name}=${value}`]);
  });
  const validateTransport = new CliStubTransport(
    remoteGovernanceResponses(
      ".github/ISSUE_TEMPLATE/direct-fields.yml",
      "direct-fields-sha",
      REMOTE_ISSUE_TEMPLATE_DIRECT_FIELDS,
    ),
  );
  const validateLines: string[] = [];
  console.log = (line: string) => validateLines.push(line);
  try {
    await runCli(
      ["issue", "validate", "--template", "direct-fields", "--repository", "acme/inari", "--json", ...args],
      { repositoryRoot, createAdapter: (options) => new GitHubAdapter({ ...options, transport: validateTransport }) },
    );
  } finally {
    console.log = originalLog;
  }
  const validateOutput = JSON.parse(validateLines[0] ?? "{}") as {
    error?: { code?: string };
    valid?: boolean;
    values?: Record<string, unknown>;
  };
  assert.equal(validateOutput.error?.code, undefined);
  assert.equal(validateOutput.valid, true);
  assert.deepEqual(validateOutput.values?.areas, ["cli", "docs"]);
  assert.equal(validateOutput.values?.problem, "A reproducible problem");
});

test("validate's missingFields progressive diagnostics project each unresolved field's type and requiredness from the contract", async () => {
  const result = await captureJson([
    "issue",
    "validate",
    "--template",
    "feature",
    "--field",
    "problem=A reproducible problem",
    "--json",
  ]);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.valid, false);
  const missingFields = result.output.missingFields as readonly {
    field: string;
    constraints?: { type?: string; required?: boolean };
  }[];
  const capability = missingFields.find((entry) => entry.field === "capability");
  assert.equal(capability?.constraints?.type, "string");
  assert.equal(capability?.constraints?.required, true);
  const constraints = missingFields.find((entry) => entry.field === "constraints");
  assert.equal(constraints, undefined, "an optional field must not be reported as a missing/required field");
});

test("validate excludes a default-backed field from missingFields when other required fields are absent", async () => {
  const result = await captureJson(["issue", "validate", "--template", "bug", "--field", "summary=X", "--json"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.output.valid, false);
  assert.deepEqual(
    (result.output.violations as readonly { path: string }[]).map((violation) => violation.path),
    ["$.reproduction", "$.expected_behavior", "$.actual_behavior"],
  );
  const missingFields = result.output.missingFields as readonly { field: string }[];
  assert.deepEqual(
    missingFields.map((field) => field.field),
    ["actual_behavior", "expected_behavior", "reproduction"],
  );
  assert.equal(
    missingFields.some((field) => field.field === "acceptance"),
    false,
  );
});
