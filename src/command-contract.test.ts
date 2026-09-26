import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_INVOCATION_CONTRACT,
  RUNTIME_CAPABILITIES,
  COMMAND_CONTRACT_ID,
  COMMAND_CONTRACT_VERSION,
  INARI_COMMANDS,
  commandExample,
  commandInvocation,
  commandTemplateSchemaInvocation,
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
  assert.equal("compatibility" in projection.invocation, false);
  assert.equal("extensionInstall" in projection.invocation, false);
  assert.equal("extensionUpdate" in projection.invocation, false);
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

test("retired extension distribution is absent from the public runtime contract", () => {
  assert.equal("compatibility" in AGENT_INVOCATION_CONTRACT, false);
  assert.equal("extensionInstall" in AGENT_INVOCATION_CONTRACT, false);
  assert.equal("extensionUpdate" in AGENT_INVOCATION_CONTRACT, false);
  assert.equal((RUNTIME_CAPABILITIES as readonly string[]).includes("extension-bootstrap"), false);
});

test("local Runtime supervision is one closed command over the canonical command contract", () => {
  const command = getCommandForPositionals(["runtime", "supervise"]);
  assert.ok(command);
  assert.equal(command.id, "runtime.supervise");
  assert.deepEqual(command.optionIds, ["help", "json"]);
  assert.deepEqual(
    projectCommandHelp(["runtime"]).commands.map((entry) => entry.id),
    ["runtime.connect", "runtime.supervise", "runtime.console"],
  );
});

test("the local Runtime console is one closed command projecting the canonical setup/runtime state", () => {
  const command = getCommandForPositionals(["runtime", "console"]);
  assert.ok(command);
  assert.equal(command.id, "runtime.console");
  assert.deepEqual(command.optionIds, ["help", "json"]);
});

test("setup Application commands are closed metadata beside the repository-onboarding setup root", () => {
  assert.equal(getCommandForPositionals(["setup"])?.id, "root.setup");
  assert.equal(getCommandForPositionals(["setup", "status"])?.id, "setup.status");
  assert.equal(getCommandForPositionals(["setup", "next"])?.id, "setup.next");
  assert.equal(getCommandForPositionals(["setup", "console"])?.id, "setup.console");
  assert.equal(getCommandForPositionals(["setup", "start"]), undefined);
  assert.equal(getCommandForPositionals(["setup", "status", "extra"]), undefined);
  assert.deepEqual(
    projectCommandHelp(["setup"]).commands.map((entry) => entry.id),
    ["root.setup"],
  );
  assert.deepEqual(
    INARI_COMMANDS.filter((entry) => entry.domain === "setup").map((entry) => entry.id),
    ["setup.status", "setup.next", "setup.console"],
  );
  assert.deepEqual(
    projectCommandHelp(["setup", "next"]).commands.map((entry) => entry.id),
    ["setup.next"],
  );
  const next = INARI_COMMANDS.find((entry) => entry.id === "setup.next");
  assert.deepEqual(next?.optionIds, ["help", "json", "repository", "repositoryId", "yes", "input", "enrollmentFile"]);
  assert.equal(getOption("input").repeatable, true);
  assert.equal(getOption("enrollmentFile").repeatable, true);
  assert.equal(
    commandUsage(next!),
    "setup next [--repository <repository>] [--repository-id <id>] [--yes] [--input <id=value> ...] [--enrollment-file <id=path> ...]",
  );
  assert.equal(helpInvocation("setup"), "inari setup --help");
  assert.deepEqual(
    tokenizeCommandArgv(["setup", "next", "--input", "app-id=1", "--enrollment-file", "issuer-key=k.pem"]).positionals,
    ["setup", "next"],
  );
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

test("command projections bind authoritative option values without changing generic examples", () => {
  const template = ".github/ISSUE_TEMPLATE/release.yml";
  assert.equal(commandExample("issue.schema", { template }), `inari issue schema --template ${template}`);
  assert.equal(commandTemplateSchemaInvocation("issue", template), `inari issue schema --template ${template}`);
  assert.equal(commandExample("issue.schema"), "inari issue schema");
});

test("unknown upstream command trees stay outside the owned command contract", () => {
  assert.equal(getCommandForPositionals(["pr", "legacy"]), undefined);
  assert.equal(getCommandForPositionals(["repo", "view"]), undefined);
});

test("command matching rejects surplus positionals while preserving declared slots", () => {
  assert.equal(getCommandForPositionals(["version", "extra"]), undefined);
  assert.equal(getCommandForPositionals(["template", "list", "extra"]), undefined);
  assert.equal(getCommandForPositionals(["skill", "author-issue", "extra"]), undefined);
  assert.equal(getCommandForPositionals(["issue", "get", "1", "extra"]), undefined);

  assert.equal(getCommandForPositionals(["issue", "schema", "feature"])?.id, "issue.schema");
  assert.equal(getCommandForPositionals(["skill", "author-issue"])?.id, "skill.scenario");
  assert.equal(getCommandForPositionals(["issue", "get", "1"])?.id, "issue.get");
});

test("pr sync exposes only its complete --from input mode", () => {
  const command = getCommandForPositionals(["pr", "sync"]);
  assert.ok(command);
  assert.deepEqual(command.optionIds, ["help", "json", "template", "repository", "policy", "from", "dryRun"]);
});

test("pr routing exposes the read-only canonical routing input", () => {
  const command = getCommandForPositionals(["pr", "routing"]);
  assert.ok(command);
  assert.equal(command.id, "pr.routing");
  assert.deepEqual(command.optionIds, ["help", "json", "from"]);
  assert.match(commandUsage(command), /--from <path>/);
});

test("pr publish exposes the explicit idempotent publication request", () => {
  const command = getCommandForPositionals(["pr", "publish"]);
  assert.ok(command);
  assert.equal(command.id, "pr.publish");
  assert.deepEqual(command.optionIds, ["help", "json", "repository", "from"]);
  assert.match(commandUsage(command), /--from <path>/);
});

test("release preparation exposes explicit intent and target-version inputs", () => {
  const command = getCommandForPositionals(["release", "prepare"]);
  assert.ok(command);
  assert.equal(command.id, "release.prepare");
  assert.deepEqual(command.optionIds, ["help", "json", "repository", "reviewIntent", "targetVersion"]);
  assert.match(commandUsage(command), /--target-version <version>/);
});

test("impl verify exposes --execution-evidence alongside its authorization and pull-request inputs", () => {
  const command = getCommandForPositionals(["impl", "verify"]);
  assert.ok(command);
  assert.deepEqual(command.optionIds, [
    "help",
    "json",
    "repository",
    "from",
    "capability",
    "pullRequest",
    "executionEvidence",
  ]);
  const option = getOption("executionEvidence");
  assert.deepEqual(option.aliases, ["--execution-evidence"]);
  assert.equal(option.arity, "required");
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
      // The frontier `--from` form is the separate low-level input mode, not
      // an option on repository-backed Issue composition.
      if (command.id === "impl.frontier" && optionId === "from") continue;
      const expectedSyntax =
        command.id === "authority.register" && optionId === "from"
          ? "--from <authority.json>"
          : command.id === "authority.rotate" && optionId === "from"
            ? "--from <rotation.json>"
            : optionSyntax(getOption(optionId));
      assert.match(
        commandUsage(command),
        new RegExp(expectedSyntax.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
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
