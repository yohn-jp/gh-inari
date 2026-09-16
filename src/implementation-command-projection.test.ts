import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COMMAND_CONTRACT_ID,
  COMMAND_CONTRACT_VERSION,
  IMPLEMENTATION_COMMAND_SURFACE_MARKERS,
  commandExample,
  commandInvocation,
  commandUsage,
  getCommand,
  getDomainCommands,
  projectImplementationCommandSurface,
  projectImplementationCommandSurfaceMarkdown,
} from "./command-contract.js";
import { findSkillScenario } from "./skill.js";

function implementationContractDocumentation(): string {
  return readFileSync(new URL("../docs/IMPLEMENTATION_CONTRACT.md", import.meta.url), "utf8");
}

function generatedImplementationSurface(document: string): string {
  const start = document.indexOf(IMPLEMENTATION_COMMAND_SURFACE_MARKERS.start);
  assert.notEqual(start, -1, "normative documentation must contain the generated surface start marker");
  const contentStart = start + IMPLEMENTATION_COMMAND_SURFACE_MARKERS.start.length;
  const end = document.indexOf(IMPLEMENTATION_COMMAND_SURFACE_MARKERS.end, contentStart);
  assert.notEqual(end, -1, "normative documentation must contain the generated surface end marker");
  return document.slice(start, end + IMPLEMENTATION_COMMAND_SURFACE_MARKERS.end.length);
}

test("Implementation command projection is a complete view of the command authority", () => {
  const projection = projectImplementationCommandSurface();
  const definitions = getDomainCommands("impl");

  assert.equal(projection.id, COMMAND_CONTRACT_ID);
  assert.equal(projection.version, COMMAND_CONTRACT_VERSION);
  assert.equal(projection.domain, "impl");
  assert.deepEqual(
    projection.commands.map((entry) => entry.id),
    definitions.map((entry) => entry.id),
  );

  for (const definition of definitions) {
    const entry = projection.commands.find((candidate) => candidate.id === definition.id);
    assert.ok(entry, definition.id);
    assert.equal(entry.domain, definition.domain, definition.id);
    assert.equal(entry.operation, definition.operation, definition.id);
    assert.deepEqual(entry.path, definition.path, definition.id);
    assert.equal(entry.invocation, commandInvocation(definition.id), definition.id);
    assert.equal(entry.usage, commandUsage(definition), definition.id);
    assert.equal(entry.summary, definition.summary, definition.id);
    assert.deepEqual(entry.optionIds, definition.optionIds, definition.id);
    assert.deepEqual(
      entry.options.map((option) => option.id),
      definition.optionIds,
      definition.id,
    );
    assert.equal(entry.options.length, definition.optionIds.length, definition.id);
  }

  const verify = projection.commands.find((entry) => entry.id === "impl.verify");
  assert.ok(verify);
  assert.match(verify.usage, /--from <path>/u);
  assert.match(verify.usage, /--pr <number>/u);
});

test("Skill Implementation workflow tracks every authoritative impl command", () => {
  const scenario = findSkillScenario("manage-implementation");
  assert.ok(scenario);

  const workflowCommands = scenario.workflow.filter((step) => getCommand(step.commandId).domain === "impl");
  assert.deepEqual(
    workflowCommands.map((step) => step.commandId),
    getDomainCommands("impl").map((command) => command.id),
  );

  for (const step of workflowCommands) {
    assert.equal(step.command, commandExample(step.commandId), step.commandId);
    assert.equal(getCommand(step.commandId).domain, "impl", step.commandId);
  }

  assert.equal(
    workflowCommands.some((step) => step.commandId === "impl.verify"),
    true,
  );
});

test("normative Implementation documentation is exactly the contract projection", () => {
  const document = implementationContractDocumentation();
  assert.equal(generatedImplementationSurface(document), projectImplementationCommandSurfaceMarkdown());
  assert.doesNotMatch(document, /command contract is version `1\.10\.0`/u);
  assert.doesNotMatch(document, /has exactly these operations/u);
  assert.doesNotMatch(document, /five current operations/u);
});
