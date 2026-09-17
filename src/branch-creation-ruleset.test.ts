import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICAL_BRANCH_TYPES } from "./branch-naming.js";
import { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG } from "./issuer-identity.js";
import {
  buildChangeBranchCreationRuleset,
  changeBranchRefNameExcludePatterns,
  changeBranchRefNameIncludePatterns,
  isRulesetRollbackValid,
  isRulesetRolloutAdvanceValid,
  planRulesetRollback,
  planRulesetRolloutStage,
  RULESET_ENFORCEMENT_STAGES,
  validateChangeBranchCreationRuleset,
} from "./branch-creation-ruleset.js";

const issuerApp = Object.freeze({
  kind: INARI_ISSUER_APP_KIND,
  slug: INARI_ISSUER_APP_SLUG,
  appId: "466",
});

test("changeBranchRefNameIncludePatterns covers exactly the canonical branch types", () => {
  const patterns = changeBranchRefNameIncludePatterns();
  assert.equal(patterns.length, CANONICAL_BRANCH_TYPES.length);
  for (const type of CANONICAL_BRANCH_TYPES) assert.ok(patterns.includes(`refs/heads/${type}/**`));
});

test("changeBranchRefNameExcludePatterns excludes the default branch", () => {
  assert.deepEqual(changeBranchRefNameExcludePatterns(), ["refs/heads/main"]);
});

test("buildChangeBranchCreationRuleset scopes creation-only enforcement to the issuer", () => {
  const ruleset = buildChangeBranchCreationRuleset({ enforcement: "disabled", issuerApp });
  assert.equal(ruleset.target, "branch");
  assert.deepEqual(ruleset.rules, [{ type: "creation" }]);
  assert.equal(ruleset.bypass_actors.length, 1);
  assert.equal(ruleset.bypass_actors[0].actor_type, "Integration");
  assert.equal(ruleset.bypass_actors[0].actor_id, 466);
  assert.equal(ruleset.bypass_actors[0].bypass_mode, "always");
  assert.equal(ruleset.conditions.ref_name.exclude[0], "refs/heads/main");
});

test("buildChangeBranchCreationRuleset rejects an unsupported enforcement stage", () => {
  assert.throws(() => buildChangeBranchCreationRuleset({ enforcement: "enabled" as never, issuerApp }), TypeError);
});

test("buildChangeBranchCreationRuleset rejects a non-issuer app identity", () => {
  assert.throws(
    () => buildChangeBranchCreationRuleset({ enforcement: "disabled", issuerApp: { ...issuerApp, appId: "abc" } }),
    TypeError,
  );
  assert.throws(
    () =>
      buildChangeBranchCreationRuleset({
        enforcement: "disabled",
        issuerApp: { ...issuerApp, slug: "other" as never },
      }),
    TypeError,
  );
});

test("validateChangeBranchCreationRuleset accepts a freshly built payload at every stage", () => {
  for (const enforcement of RULESET_ENFORCEMENT_STAGES) {
    const ruleset = buildChangeBranchCreationRuleset({ enforcement, issuerApp });
    const result = validateChangeBranchCreationRuleset(ruleset, issuerApp.appId);
    assert.equal(result.valid, true, JSON.stringify(result.violations));
  }
});

test("validateChangeBranchCreationRuleset rejects a rule type beyond creation", () => {
  const ruleset = buildChangeBranchCreationRuleset({ enforcement: "active", issuerApp });
  const widened = { ...ruleset, rules: [{ type: "creation" }, { type: "pull_request" }] };
  const result = validateChangeBranchCreationRuleset(widened);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((message) => message.includes("creation")));
});

test("validateChangeBranchCreationRuleset rejects more than one bypass actor", () => {
  const ruleset = buildChangeBranchCreationRuleset({ enforcement: "active", issuerApp });
  const widened = {
    ...ruleset,
    bypass_actors: [...ruleset.bypass_actors, { actor_type: "OrganizationAdmin", bypass_mode: "always" }],
  };
  const result = validateChangeBranchCreationRuleset(widened);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((message) => message.includes("bypass_actors")));
});

test("validateChangeBranchCreationRuleset rejects a namespace broader than the canonical branch types", () => {
  const ruleset = buildChangeBranchCreationRuleset({ enforcement: "active", issuerApp });
  const widened = {
    ...ruleset,
    conditions: { ref_name: { include: ["refs/heads/**"], exclude: ruleset.conditions.ref_name.exclude } },
  };
  const result = validateChangeBranchCreationRuleset(widened);
  assert.equal(result.valid, false);
});

test("validateChangeBranchCreationRuleset rejects an unexpected issuer App ID", () => {
  const ruleset = buildChangeBranchCreationRuleset({ enforcement: "active", issuerApp });
  const result = validateChangeBranchCreationRuleset(ruleset, "999999");
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((message) => message.includes("999999")));
});

test("planRulesetRolloutStage advances one stage at a time and is idempotent at active", () => {
  assert.equal(planRulesetRolloutStage(undefined), "disabled");
  assert.equal(planRulesetRolloutStage("disabled"), "evaluate");
  assert.equal(planRulesetRolloutStage("evaluate"), "active");
  assert.equal(planRulesetRolloutStage("active"), "active");
});

test("planRulesetRollback always returns to disabled without deleting the definition", () => {
  assert.equal(planRulesetRollback("active"), "disabled");
  assert.equal(planRulesetRollback("evaluate"), "disabled");
  assert.equal(planRulesetRollback("disabled"), "disabled");
});

test("isRulesetRolloutAdvanceValid rejects skipped stages", () => {
  assert.equal(isRulesetRolloutAdvanceValid(undefined, "disabled"), true);
  assert.equal(isRulesetRolloutAdvanceValid(undefined, "active"), false);
  assert.equal(isRulesetRolloutAdvanceValid("disabled", "active"), false);
  assert.equal(isRulesetRolloutAdvanceValid("disabled", "evaluate"), true);
  assert.equal(isRulesetRolloutAdvanceValid("evaluate", "active"), true);
  assert.equal(isRulesetRolloutAdvanceValid("active", "active"), true);
});

test("isRulesetRollbackValid accepts any known stage collapsing to disabled", () => {
  assert.equal(isRulesetRollbackValid("active", "disabled"), true);
  assert.equal(isRulesetRollbackValid("evaluate", "disabled"), true);
  assert.equal(isRulesetRollbackValid(undefined, "disabled"), false);
  assert.equal(isRulesetRollbackValid("active", "evaluate"), false);
});
