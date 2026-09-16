import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSkillScenario,
  MAX_SKILL_OUTPUT_BYTES,
  SKILL_DEFAULT_SCENARIO_ID,
  projectSkillIndexToJson,
  projectSkillIndexToText,
  projectSkillScenarioToJson,
  projectSkillScenarioToText,
  SKILL_SCENARIOS,
} from "./skill.js";
import type { GoldenPathGovernanceDiscoveryResult } from "./golden-path-governance.js";
import { issueContractFixture, pullRequestContractFixture } from "./contract/fixtures.js";

const CROSS_PRODUCT_NAMES = ["wabachi", "nawabari", "mottainai"];

test("SKILL_SCENARIOS has a fixed, deterministic order", () => {
  const ids = SKILL_SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual(ids, [
    "author-issue",
    "author-pr",
    "inspect-governance",
    "repair-invalid-artifact",
    "manage-issue-relationships",
    "manage-implementation",
    "manage-change",
    "golden-path",
  ]);
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
    const index = text.indexOf(`  ${scenario.id} -`);
    assert.ok(index > lastIndex, `expected ${scenario.id} to appear in order in index text`);
    lastIndex = index;
  }
});

test("findSkillScenario resolves known ids and returns undefined for unknown ids", () => {
  assert.equal(findSkillScenario("author-issue")?.title, "Author a governed Issue");
  assert.equal(findSkillScenario("bogus-scenario"), undefined);
});

test("golden-path projects canonical entry, status, and recovery references", () => {
  const scenario = findSkillScenario("golden-path");
  assert.ok(scenario);

  assert.deepEqual(
    scenario.contractReferences.map((reference) => `${reference.contract}.${reference.output}`),
    [
      "golden-path-governance.nextAction",
      "golden-path-entry.action",
      "change-handoff.handoff",
      "golden-path-status.nextAction",
      "golden-path-recovery.recovery",
    ],
  );
  assert.deepEqual(
    scenario.workflow.map((step) => step.command),
    [
      "inari diagnose",
      "inari issue create",
      "inari change issue <number>",
      "inari change show <number>",
      "inari change ready <number>",
      "inari change show <number>",
      "inari change abort <number>",
    ],
  );

  const content = JSON.stringify(scenario);
  assert.match(content, /nextAction/);
  assert.match(content, /safeAction/);
  assert.match(content, /MANUAL_REVIEW/);
  assert.match(content, /Nawabari/);
  assert.match(content, /worktree/);
  assert.match(content, /raw GitHub mutations/);
  assert.doesNotMatch(content, /gh (?:issue|pr) create/);
});

test("authoring scenarios make direct governed creation the conditional golden path", () => {
  for (const domain of ["issue", "pr"] as const) {
    const scenario = findSkillScenario(domain === "issue" ? "author-issue" : "author-pr");
    assert.ok(scenario);

    assert.equal(scenario.workflow[0]?.command, `inari ${domain} create`);
    assert.match(scenario.workflow[0]?.summary ?? "", /explicit|leaf/i);

    const schemaStep = projectSkillScenarioToJson(scenario).workflow.find(
      (step) => step.commandId === `${domain}.schema`,
    );
    assert.ok(schemaStep);
    assert.match(schemaStep.summary, /If required fields are unknown/);
    assert.equal(schemaStep.command, undefined);
    assert.equal(schemaStep.prerequisite?.kind, "golden-path-governance");

    const validateStep = scenario.workflow.find((step) => step.command === `inari ${domain} validate`);
    const renderStep = scenario.workflow.find((step) => step.command === `inari ${domain} render`);
    assert.match(validateStep?.summary ?? "", /preview|debugging/);
    assert.match(renderStep?.summary ?? "", /artifact generation/);
    assert.match(scenario.invariants.join(" "), /leaf fast path/);
    assert.match(scenario.invariants.join(" "), /not a mandatory step/);
    assert.match(scenario.invariants.join(" "), /not mandatory ceremony/);
  }
});

test("Implementation authoring uses the current impl command surface", () => {
  const scenario = findSkillScenario("manage-implementation");
  assert.ok(scenario);
  assert.deepEqual(
    scenario.workflow.map((step) => step.command),
    [
      "inari impl plan <number>",
      "inari issue create",
      "inari impl show <number>",
      "inari impl validate <number>",
      "inari impl authorize <number>",
      "inari impl inspect <number>",
    ],
  );
  assert.match(scenario.invariants.join(" "), /not authoritative/u);
  assert.match(scenario.invariants.join(" "), /without a GitHub mutation/u);
  assert.match(scenario.invariants.join(" "), /native parent\/sub-issue/u);
  assert.doesNotMatch(JSON.stringify(scenario), /impl (?:create|edit|start|complete|ready)/u);
});

function resolvedGovernance(
  domain: "issue" | "pr",
  contract: { readonly templateIdentity: { readonly path: string } },
): GoldenPathGovernanceDiscoveryResult {
  const provenance = {
    authority: "repository-default-branch" as const,
    repository: { host: "github.com", owner: "acme", name: "inari", nameWithOwner: "acme/inari" },
    ref: "main",
    treeSha: `${domain}-tree-sha`,
    template: {
      path: contract.templateIdentity.path,
      ref: "main",
      sha: `${domain}-template-sha`,
      digest: `${domain}-template-digest`,
    },
  };
  return {
    version: "1",
    status: "resolved",
    domain,
    source: "native-template",
    contract,
    provenance,
    generation: provenance,
    nextAction: { action: "direct-governed-create", kind: "direct-governed-create" },
  } as unknown as GoldenPathGovernanceDiscoveryResult;
}

function unresolvedGovernance(domain: "issue" | "pr"): GoldenPathGovernanceDiscoveryResult {
  return {
    version: "1",
    status: "ambiguous",
    domain,
    source: "native-template",
    reason: "SELECTOR_AMBIGUOUS",
    nextAction: { action: "provide-template-selector", kind: "provide-template-selector" },
    diagnostic: {
      code: "SELECTOR_AMBIGUOUS",
      message: "More than one template matches.",
      candidates: ["first", "second"],
      candidateCount: 2,
      candidatesTruncated: false,
    },
  };
}

for (const domain of ["issue", "pr"] as const) {
  test(`${domain} schema step binds the resolved single-template identity`, () => {
    const scenario = findSkillScenario(domain === "issue" ? "author-issue" : "author-pr");
    assert.ok(scenario);
    const contract = domain === "issue" ? issueContractFixture : pullRequestContractFixture;
    const projected = projectSkillScenarioToJson(scenario, { governance: resolvedGovernance(domain, contract) });
    const schemaStep = projected.workflow.find((step) => step.commandId === `${domain}.schema`);
    assert.ok(schemaStep);
    assert.equal(schemaStep.command, `inari ${domain} schema --template ${contract.templateIdentity.path}`);
    assert.deepEqual(schemaStep.bindings, { template: contract.templateIdentity.path });
    assert.equal(schemaStep.prerequisite, undefined);
  });

  test(`${domain} schema step binds the resolved multi-template identity instead of a default`, () => {
    const scenario = findSkillScenario(domain === "issue" ? "author-issue" : "author-pr");
    assert.ok(scenario);
    const baseContract = domain === "issue" ? issueContractFixture : pullRequestContractFixture;
    const contract = {
      ...baseContract,
      templateIdentity: {
        ...baseContract.templateIdentity,
        id: "release",
        name: "Release",
        path: domain === "issue" ? ".github/ISSUE_TEMPLATE/release.yml" : ".github/PULL_REQUEST_TEMPLATE/release.md",
      },
    };
    const projected = projectSkillScenarioToJson(scenario, { governance: resolvedGovernance(domain, contract) });
    const schemaStep = projected.workflow.find((step) => step.commandId === `${domain}.schema`);
    assert.ok(schemaStep);
    assert.equal(schemaStep.command, `inari ${domain} schema --template ${contract.templateIdentity.path}`);
    assert.doesNotMatch(schemaStep.command ?? "", /default/u);
  });

  test(`${domain} schema step projects a prerequisite when governance is unresolved`, () => {
    const scenario = findSkillScenario(domain === "issue" ? "author-issue" : "author-pr");
    assert.ok(scenario);
    const projected = projectSkillScenarioToJson(scenario, { governance: unresolvedGovernance(domain) });
    const schemaStep = projected.workflow.find((step) => step.commandId === `${domain}.schema`);
    assert.ok(schemaStep);
    assert.equal(schemaStep.command, undefined);
    assert.equal(schemaStep.bindings, undefined);
    assert.deepEqual(schemaStep.prerequisite, {
      kind: "golden-path-governance",
      action: "provide-template-selector",
      reason: "SELECTOR_AMBIGUOUS",
    });
    assert.doesNotMatch(
      projectSkillScenarioToText(scenario, { governance: unresolvedGovernance(domain) }),
      new RegExp(`inari ${domain} schema`, "u"),
    );
  });
}

test("the Golden Path is the only default route and existing flows point to it", () => {
  assert.deepEqual(
    SKILL_SCENARIOS.filter((scenario) => scenario.scope === "default-route").map((scenario) => scenario.id),
    [SKILL_DEFAULT_SCENARIO_ID],
  );

  for (const id of ["author-issue", "author-pr", "manage-implementation", "manage-change"] as const) {
    const scenario = findSkillScenario(id);
    assert.ok(scenario);
    assert.equal(scenario.scope, "leaf-operation");
    assert.equal(scenario.delegatesTo, SKILL_DEFAULT_SCENARIO_ID);
    assert.match(projectSkillScenarioToText(scenario), /inari skill golden-path/);
  }

  for (const id of ["inspect-governance", "repair-invalid-artifact"] as const) {
    const scenario = findSkillScenario(id);
    assert.ok(scenario);
    assert.equal(scenario.scope, "specialized-alternative");
    assert.equal(scenario.delegatesTo, undefined);
  }
});

test("the normal route does not expose competing PR or manual ceremony steps", () => {
  const scenario = findSkillScenario(SKILL_DEFAULT_SCENARIO_ID);
  assert.ok(scenario);
  const commands = scenario.workflow.map((step) => step.command).join(" ");
  const summaries = scenario.workflow.map((step) => step.summary).join(" ");

  assert.doesNotMatch(commands, /inari pr create|--head|--base/);
  assert.doesNotMatch(summaries, /validate before render|render before create|mandatory (?:schema|validation|render)/i);
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
    assert.equal(json.scope, scenario.scope);
    assert.equal(json.delegatesTo, scenario.delegatesTo);
    assert.deepEqual(json.contractReferences, scenario.contractReferences);
    assert.deepEqual(json.invariants, scenario.invariants);
    assert.equal(json.canonicalEntrypoint, scenario.canonicalEntrypoint);
    assert.equal(json.helpPointer, scenario.helpPointer);

    assert.ok(text.includes(scenario.title));
    assert.ok(text.includes(scenario.whenToUse));
    for (const step of json.workflow) {
      assert.ok(text.includes(step.summary));
      if (step.command !== undefined) assert.ok(text.includes(step.command));
      if (step.bindings !== undefined) assert.ok(text.includes(JSON.stringify(step.bindings)));
      if (step.prerequisite !== undefined) assert.ok(text.includes(JSON.stringify(step.prerequisite)));
    }
    for (const reference of scenario.contractReferences) {
      assert.ok(text.includes(`${reference.contract}.${reference.output}`));
      assert.ok(text.includes(reference.instruction));
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
    const allowedNames = scenario.id === "golden-path" ? new Set(["nawabari"]) : new Set<string>();
    for (const name of CROSS_PRODUCT_NAMES.filter((candidate) => !allowedNames.has(candidate))) {
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
