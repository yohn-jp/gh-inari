import assert from "node:assert/strict";
import { test } from "node:test";
import { commandUsage, getCommand, getOption, projectCommandContract } from "./command-contract.js";

test("create help distinguishes generic arrays from checklist option ids", () => {
  const pullRequestCreate = getCommand("pr.create");
  const usage = commandUsage(pullRequestCreate);
  assert.match(usage, /--head <branch>/u);
  assert.match(usage, /--base <branch>/u);

  const field = getOption("field");
  assert.match(field.description, /array values repeat as --field name=<value>/u);
  assert.match(field.description, /checklist values repeat as --field name=<option-id>/u);

  const projected = projectCommandContract().commands.find((command) => command.id === "pr.create");
  assert.ok(projected);
  assert.equal(projected.options.find((option) => option.id === "field")?.description, field.description);
});
