import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSkillScenario,
  MAX_SKILL_OUTPUT_BYTES,
  projectSkillIndexToJson,
  projectSkillIndexToText,
  projectSkillScenarioToJson,
  projectSkillScenarioToText,
  SKILL_SCENARIOS,
} from "./skill.js";

const CROSS_PRODUCT_NAMES = ["wabachi", "nawabari", "mottainai"];

test("SKILL_SCENARIOS has a fixed, deterministic order", () => {
  const ids = SKILL_SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual(ids, ["author-issue", "author-pr", "inspect-governance", "repair-invalid-artifact"]);
});

test("index projection preserves scenario order and identity", () => {
  const json = projectSkillIndexToJson();
  assert.deepEqual(
    json.scenarios.map((entry) => entry.id),
    SKILL_SCENARIOS.map((scenario) => scenario.id),
  );
  const text = projectSkillIndexToText();
  let lastIndex = -1;
  for (const scenario of SKILL_SCENARIOS) {
    const index = text.indexOf(scenario.id);
    assert.ok(index > lastIndex, `expected ${scenario.id} to appear in order in index text`);
    lastIndex = index;
  }
});

test("findSkillScenario resolves known ids and returns undefined for unknown ids", () => {
  assert.equal(findSkillScenario("author-issue")?.title, "Author a governed Issue");
  assert.equal(findSkillScenario("bogus-scenario"), undefined);
});

test("authoring scenarios make direct governed creation the conditional golden path", () => {
  for (const domain of ["issue", "pr"] as const) {
    const scenario = findSkillScenario(domain === "issue" ? "author-issue" : "author-pr");
    assert.ok(scenario);

    assert.equal(scenario.workflow[0]?.command, `inari ${domain} create`);
    assert.match(scenario.workflow[0]?.summary ?? "", /directly/);

    const schemaStep = scenario.workflow.find((step) => step.command === `inari ${domain} schema`);
    assert.ok(schemaStep);
    assert.match(schemaStep.summary, /If required fields are unknown/);

    const validateStep = scenario.workflow.find((step) => step.command === `inari ${domain} validate`);
    const renderStep = scenario.workflow.find((step) => step.command === `inari ${domain} render`);
    assert.match(validateStep?.summary ?? "", /preview|debugging/);
    assert.match(renderStep?.summary ?? "", /artifact generation/);
    assert.match(scenario.invariants.join(" "), /golden path/);
    assert.match(scenario.invariants.join(" "), /not a mandatory step/);
    assert.match(scenario.invariants.join(" "), /not mandatory ceremony/);
  }
});

test("inspect and repair scenarios use the 0.8 remediation paths", () => {
  const inspect = findSkillScenario("inspect-governance");
  assert.ok(inspect);
  assert.deepEqual(
    inspect.workflow.map((step) => step.command),
    ["inari issue check <number>", "inari issue get <number>", "inari issue explain <number>"],
  );

  const repair = findSkillScenario("repair-invalid-artifact");
  assert.ok(repair);
  assert.equal(repair.title, "Repair or normalize a governed artifact");
  const commands = repair.workflow.map((step) => step.command).join(" ");
  assert.match(commands, /inari issue normalize/);
  assert.match(commands, /inari issue edit/);
  assert.match(commands, /inari issue sync/);
  assert.match(repair.invariants.join(" "), /preservation of current semantics/);
  assert.match(repair.invariants.join(" "), /Always preview a mutation/);
});

for (const scenario of SKILL_SCENARIOS) {
  test(`${scenario.id}: text and JSON projections derive from the same fields`, () => {
    const text = projectSkillScenarioToText(scenario);
    const json = projectSkillScenarioToJson(scenario);

    assert.equal(json.id, scenario.id);
    assert.equal(json.title, scenario.title);
    assert.equal(json.whenToUse, scenario.whenToUse);
    assert.deepEqual(json.workflow, scenario.workflow);
    assert.deepEqual(json.invariants, scenario.invariants);
    assert.equal(json.canonicalEntrypoint, scenario.canonicalEntrypoint);
    assert.equal(json.helpPointer, scenario.helpPointer);

    assert.ok(text.includes(scenario.title));
    assert.ok(text.includes(scenario.whenToUse));
    for (const step of scenario.workflow) {
      assert.ok(text.includes(step.summary));
      assert.ok(text.includes(step.command));
    }
    for (const invariant of scenario.invariants) {
      assert.ok(text.includes(invariant));
    }
    assert.ok(text.includes(scenario.canonicalEntrypoint));
    assert.ok(text.includes(scenario.helpPointer));
  });

  test(`${scenario.id}: text and JSON projections stay within the output budget`, () => {
    const text = projectSkillScenarioToText(scenario);
    const json = JSON.stringify(projectSkillScenarioToJson(scenario));
    assert.ok(
      Buffer.byteLength(text, "utf8") <= MAX_SKILL_OUTPUT_BYTES,
      `${scenario.id} text projection exceeds ${MAX_SKILL_OUTPUT_BYTES} bytes`,
    );
    assert.ok(
      Buffer.byteLength(json, "utf8") <= MAX_SKILL_OUTPUT_BYTES,
      `${scenario.id} JSON projection exceeds ${MAX_SKILL_OUTPUT_BYTES} bytes`,
    );
  });

  test(`${scenario.id}: contains no cross-product content`, () => {
    const haystack = JSON.stringify(scenario).toLowerCase();
    for (const name of CROSS_PRODUCT_NAMES) {
      assert.ok(!haystack.includes(name), `${scenario.id} unexpectedly references "${name}"`);
    }
  });
}

test("index text and JSON projections stay within the output budget", () => {
  const text = projectSkillIndexToText();
  const json = JSON.stringify(projectSkillIndexToJson());
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_SKILL_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(json, "utf8") <= MAX_SKILL_OUTPUT_BYTES);
});
