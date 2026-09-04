import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INVOCATION_CONTRACT,
  COMMAND_CONTRACT_ID,
  COMMAND_CONTRACT_VERSION,
  INARI_COMMANDS,
  commandUsage,
  getCommandForPositionals,
  getOption,
  projectCommandContract,
  tokenizeCommandArgv,
} from "./command-contract.js";

test("the command contract is versioned and projects every Inari-owned command", () => {
  const projection = projectCommandContract();
  assert.equal(projection.id, COMMAND_CONTRACT_ID);
  assert.equal(projection.version, COMMAND_CONTRACT_VERSION);
  assert.equal(projection.invocation.canonical, "inari");
  assert.equal(projection.invocation.compatibility, "gh inari");
  assert.deepEqual(
    projection.commands.map((entry) => entry.id),
    INARI_COMMANDS.map((entry) => entry.id),
  );
  for (const command of INARI_COMMANDS) {
    const projected = projection.commands.find((entry) => entry.id === command.id);
    assert.ok(projected);
    assert.equal(projected.invocation, `${AGENT_INVOCATION_CONTRACT.canonical} ${command.path.join(" ")}`.trim());
    assert.equal(projected.options.length, command.optionIds.length);
    assert.equal(commandUsage(command).startsWith(command.path.join(" ")), true);
  }
});

test("the shared tokenizer consumes every value-taking option before command identity", () => {
  const cases: readonly (readonly string[])[] = [
    ["--repository", "acme/inari", "issue", "create"],
    ["--repo=acme/inari", "issue", "create"],
    ["-R", "acme/inari", "pr", "create"],
    ["--template", "default", "pr", "create"],
    ["--template=default", "issue", "validate"],
    ["--policy", "policy.yml", "issue", "create"],
    ["--from", "input.json", "pr", "create"],
    ["--title", "A title", "issue", "create"],
    ["--head", "feature/example", "pr", "create"],
    ["--base", "main", "pr", "create"],
    ["--to", "semantic.json", "template", "import"],
    ["--require-capability", "canonical-invocation", "version"],
    ["--minimum-version=1.0.0", "diagnose"],
  ];
  for (const argv of cases) {
    const tokenized = tokenizeCommandArgv(argv);
    assert.equal(tokenized.positionals.at(-1), argv.at(-1), argv.join(" "));
    assert.ok(getCommandForPositionals(tokenized.positionals));
  }
  assert.equal(getOption("field").arity, "required");
  assert.equal(getOption("field").repeatable, true);
  assert.equal(getOption("repository").aliases.includes("-R"), true);
});

test("unknown upstream command trees stay outside the owned command contract", () => {
  assert.equal(getCommandForPositionals(["pr", "list"]), undefined);
  assert.equal(getCommandForPositionals(["repo", "view"]), undefined);
});
