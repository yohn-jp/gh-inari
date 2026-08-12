import assert from "node:assert/strict";
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
    command(JSON.stringify({ truncated: false, tree })),
    blobResponse(templateSha, templateSource),
    ...(policy === undefined ? [] : [blobResponse(policy.sha, policy.source)]),
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

test("--help exits 0 and prints usage", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--help"]);
    assert.equal(exitCode, 0);
    assert.match(lines.join("\n"), /Usage:/);
  } finally {
    console.log = originalLog;
  }
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
    assert.equal(transport.calls.length, 6);
    assert.deepEqual(transport.calls[5]?.slice(0, 6), [
      "api",
      "repos/acme/inari/issues",
      "--hostname",
      "github.com",
      "--method",
      "POST",
    ]);
    assert.match(transport.calls[5]?.join(" ") ?? "", /### Problem/);
    assert.equal(JSON.parse(lines[0] ?? "{}").ok, true);
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
    assert.equal(transport.calls.length, 7);
    assert.match(transport.calls[6]?.join(" ") ?? "", /## Summary/);
    assert.match(transport.calls[6]?.join(" ") ?? "", /## Linked issue/);
    assert.equal(JSON.parse(lines[0] ?? "{}").ok, true);
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
