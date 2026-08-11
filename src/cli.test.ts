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

test("invalid create input returns before adapter construction", async () => {
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
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["issue", "create", "--template", "feature", "--from", inputPath, "--json"], {
      repositoryRoot,
      createAdapter: () => {
        factoryCalls += 1;
        throw new Error("adapter must not be constructed for invalid input");
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 0);
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
    command("gh version 2.0"),
    command(),
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
    assert.equal(transport.calls.length, 3);
    assert.deepEqual(transport.calls[2]?.slice(0, 6), [
      "api",
      "repos/acme/inari/issues",
      "--hostname",
      "github.com",
      "--method",
      "POST",
    ]);
    assert.match(transport.calls[2]?.join(" ") ?? "", /### Problem/);
    assert.equal(JSON.parse(lines[0] ?? "{}").ok, true);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
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
    command("gh version 2.0"),
    command(),
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
    assert.equal(transport.calls.length, 3);
    assert.match(transport.calls[2]?.join(" ") ?? "", /## Summary/);
    assert.match(transport.calls[2]?.join(" ") ?? "", /## Linked issue/);
    assert.equal(JSON.parse(lines[0] ?? "{}").ok, true);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous template selection prevents adapter construction", async () => {
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
  try {
    const exitCode = await runCli(["issue", "create", "--from", inputPath, "--json"], {
      repositoryRoot,
      createAdapter: () => {
        factoryCalls += 1;
        throw new Error("adapter must not be constructed for ambiguous template selection");
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 0);
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "TEMPLATE_SELECTION_AMBIGUOUS");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid PR policy prevents adapter construction", async () => {
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
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "PR_POLICY_UNKNOWN_REFERENCE");
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported Issue Form semantics prevent adapter construction", async () => {
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
  try {
    const exitCode = await runCli(["issue", "create", "--template", "upload", "--from", inputPath, "--json"], {
      repositoryRoot: root,
      createAdapter: () => {
        factoryCalls += 1;
        throw new Error("adapter must not be constructed for unsupported Issue Form semantics");
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(factoryCalls, 0);
    assert.equal(JSON.parse(lines[0] ?? "{}").error.code, "ISSUE_FORM_UNSUPPORTED_TYPE");
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});
