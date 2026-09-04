import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INVOCATION_CONTRACT,
  COMMAND_CONTRACT_ID,
  COMMAND_CONTRACT_VERSION,
  INARI_COMMANDS,
  commandExample,
  commandInvocation,
  commandUsage,
  getCommandForPositionals,
  getOption,
  helpInvocation,
  optionSyntax,
  projectCommandHelp,
  projectCommandContract,
  tokenizeCommandArgv,
} from "./command-contract.js";
import { SKILL_SCENARIOS } from "./skill.js";

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

test("every owned command keeps routing, usage, discovery, and Skill references on one authority", () => {
  const projection = projectCommandContract();
  for (const command of INARI_COMMANDS) {
    const lookupPositionals = command.id === "skill.scenario" ? ["skill", "<scenario>"] : command.path;
    const parsed = tokenizeCommandArgv(lookupPositionals);
    assert.deepEqual(parsed.positionals, lookupPositionals, command.id);
    assert.equal(getCommandForPositionals(parsed.positionals)?.id, command.id, command.id);

    const projected = projection.commands.find((entry) => entry.id === command.id);
    assert.ok(projected, command.id);
    assert.equal(projected.invocation, commandInvocation(command.id), command.id);
    assert.equal(projected.example, commandExample(command.id), command.id);
    assert.deepEqual(
      projected.options.map((option) => option.id),
      command.optionIds,
      command.id,
    );

    const help = projectCommandHelp(command.path);
    if (command.id === "root.help")
      assert.deepEqual(
        help.commands.map((entry) => entry.id),
        projection.commands.map((entry) => entry.id),
      );
    else if (command.domain === "skill")
      assert.deepEqual(
        help.commands.map((entry) => entry.id),
        projection.commands.filter((entry) => entry.domain === "skill").map((entry) => entry.id),
      );
    else
      assert.deepEqual(
        help.commands.map((entry) => entry.id),
        [command.id],
        command.id,
      );
    for (const optionId of command.optionIds.filter((id) => id !== "help" && id !== "json")) {
      assert.match(
        commandUsage(command),
        new RegExp(optionSyntax(getOption(optionId)).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
        command.id,
      );
    }
  }

  for (const scenario of SKILL_SCENARIOS) {
    assert.equal(scenario.canonicalEntrypoint, commandInvocation(scenario.canonicalCommandId), scenario.id);
    assert.equal(scenario.helpPointer, helpInvocation(scenario.helpDomain), scenario.id);
    for (const step of scenario.workflow) {
      assert.equal(step.command, commandExample(step.commandId), `${scenario.id}:${step.commandId}`);
      assert.equal(getCommandForPositionals(step.command.split(" ").slice(1))?.id, step.commandId, step.commandId);
    }
  }
});
