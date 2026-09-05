import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INVOCATION_CONTRACT,
  COMMAND_CONTRACT_ID,
  commandExample,
  commandInvocation,
  commandUsage,
  getCommand,
  getCommandForPositionals,
  projectCommandContract,
  projectCommandHelp,
} from "./command-contract.js";
import {
  CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
  type ChangeRemoteExecutor,
  type ChangeRemoteMutationRequest,
  type ChangeRemoteReadRequest,
} from "./change-executor.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "./change.js";
import { runCli } from "./cli.js";
import { findSkillScenario } from "./skill.js";

const identity = {
  repositoryHost: "github.com",
  repositoryId: "100000219",
  rootIssue: 42,
} as const;
const branch = "feat/42-semantic-change";

function projection(draft = true): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence({
    change: identity,
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "semantic-change" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: identity.rootIssue, state: "open" } },
      branches: { status: "available", value: [{ name: branch }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: 142,
            head: branch,
            base: "main",
            state: "open",
            draft,
            merged: false,
          },
        ],
      },
    },
  });
  assert.equal(result.valid, true);
  return result;
}

function executor(
  calls: Array<ChangeRemoteMutationRequest | ChangeRemoteReadRequest>,
  result = projection(),
): ChangeRemoteExecutor {
  return {
    async execute(request) {
      calls.push(request);
      return result;
    },
    async read(request) {
      calls.push(request);
      return result;
    },
  };
}

async function capture(
  argv: readonly string[],
  dependencies: Parameters<typeof runCli>[1] = {},
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> | undefined }> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli([...argv], dependencies);
    const last = lines.at(-1);
    return { exitCode, output: last === undefined ? undefined : (JSON.parse(last) as Record<string, unknown>) };
  } finally {
    console.log = originalLog;
  }
}

test("Change commands are additions to the existing canonical command authority", () => {
  const ids = ["change.issue", "change.show", "change.ready", "change.abort"] as const;
  const contract = projectCommandContract();
  assert.equal(contract.id, COMMAND_CONTRACT_ID);
  assert.equal(contract.invocation, AGENT_INVOCATION_CONTRACT);
  for (const id of ids) {
    const definition = getCommand(id);
    const projected = contract.commands.find((entry) => entry.id === id);
    assert.ok(projected);
    assert.equal(getCommandForPositionals(definition.path)?.id, id);
    assert.equal(projected.invocation, commandInvocation(id));
    assert.equal(projected.example, commandExample(id));
    assert.match(commandUsage(definition), /^change (issue|show|ready|abort) <number>/u);
  }
  assert.deepEqual(
    projectCommandHelp(["change"]).commands.map((entry) => entry.id),
    ids,
  );
});

test("change show reads a bounded projection without invoking mutation", async () => {
  const calls: Array<ChangeRemoteMutationRequest | ChangeRemoteReadRequest> = [];
  const result = await capture(["change", "show", "42", "--json"], {
    changeExecutor: executor(calls),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
    operation: "show",
    issue: 42,
  });
  assert.equal(result.output?.ok, true);
  assert.equal(result.output?.change, 42);
  assert.equal(result.output?.issue, 42);
  assert.equal(result.output?.state, "DRAFT");
  assert.equal(result.output?.branch, branch);
  assert.equal(result.output?.pullRequest, 142);
  assert.equal(result.output?.operation, "change.show");
});

test("authoritative Change commands use semantic executor requests only", async () => {
  const calls: Array<ChangeRemoteMutationRequest | ChangeRemoteReadRequest> = [];
  const factoryCalls: Record<string, unknown>[] = [];
  const result = await capture(["change", "ready", "42", "--repository", "acme/inari", "--json"], {
    createChangeExecutor: (options) => {
      factoryCalls.push({ ...options });
      return executor(calls, projection(false));
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(factoryCalls, [{ cwd: process.cwd(), repository: "acme/inari" }]);
  assert.deepEqual(calls, [
    {
      version: CHANGE_REMOTE_EXECUTOR_CONTRACT_VERSION,
      operation: "ready",
      issue: 42,
    },
  ]);
  assert.equal(result.output?.operation, "change.ready");
  assert.equal(result.output?.state, "REVIEW");
  assert.doesNotMatch(JSON.stringify(calls), /workflow|dispatch|token|credential|privateKey/iu);
});

test("abort is routed through the same executor boundary", async () => {
  const calls: Array<ChangeRemoteMutationRequest | ChangeRemoteReadRequest> = [];
  const result = await capture(["change", "abort", "42", "--json"], {
    changeExecutor: executor(calls),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls[0]?.operation, "abort");
  assert.equal(result.output?.operation, "change.abort");
});

test("unavailable Actions transport returns a bounded machine-readable remote error", async () => {
  const result = await capture(["change", "issue", "42", "--json"]);

  assert.equal(result.exitCode, 3);
  assert.equal((result.output?.error as { code?: string } | undefined)?.code, "CHANGE_REMOTE_DISPATCH_FAILED");
  assert.doesNotMatch(JSON.stringify(result.output), /token|privateKey|secret|workflow_path/iu);
});

test("invalid Change numbers fail before the executor is constructed", async () => {
  let constructed = false;
  const result = await capture(["change", "show", "0", "--json"], {
    createChangeExecutor: () => {
      constructed = true;
      return executor([]);
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(constructed, false);
  assert.equal((result.output?.error as { code?: string } | undefined)?.code, "INVALID_CHANGE_NUMBER");
});

test("Change parsing rejects options outside the canonical command definition", async () => {
  let constructed = false;
  const result = await capture(["change", "show", "42", "--title", "ignored", "--json"], {
    createChangeExecutor: () => {
      constructed = true;
      return executor([]);
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(constructed, false);
  assert.deepEqual(result.output?.error, {
    code: "INVALID_OPTION",
    message: "Option --title is not supported by change show.",
    path: "$argv",
    details: { command: "change show", option: "title" },
  });
});

test("Skill references resolve the four Change commands through the canonical model", () => {
  const scenario = findSkillScenario("manage-change");
  assert.ok(scenario);
  assert.deepEqual(
    scenario.workflow.map((step) => step.command),
    [
      "inari change issue <number>",
      "inari change show <number>",
      "inari change ready <number>",
      "inari change abort <number>",
    ],
  );
  assert.equal(scenario.helpPointer, "inari change --help");
});
