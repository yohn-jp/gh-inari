/**
 * Transport-independent Core definition for issuer-controlled canonical
 * Change branch-creation enforcement (#223).
 *
 * This module owns the desired-state shape of the repository "Restrict
 * creations" Ruleset that scopes canonical branch birth to the Inari issuer
 * App Principal, the staged rollout/rollback transition rule, and validation
 * of an arbitrary GitHub Ruleset payload against those invariants. It does
 * not call the GitHub API and does not decide when live enforcement is
 * enabled; that remains a separately governed, non-delegable repository
 * administration action (see `docs/BRANCH_CREATION_RULESET_OPERATIONS.md`).
 */
import { CANONICAL_BRANCH_TYPES, DEFAULT_BRANCH_NAME } from "./branch-naming.js";
import { INARI_ISSUER_APP_KIND, INARI_ISSUER_APP_SLUG } from "./issuer-identity.js";

/** Canonical name of the governed Change branch-creation Ruleset. */
export const CHANGE_BRANCH_CREATION_RULESET_NAME = "Change branch creation" as const;

/**
 * Staged enforcement lifecycle. `disabled` defines the Ruleset without
 * blocking anything; `evaluate` observes without blocking; `active` blocks
 * arbitrary-caller creation. Order is normative for rollout.
 */
export const RULESET_ENFORCEMENT_STAGES = Object.freeze(["disabled", "evaluate", "active"] as const);
export type RulesetEnforcement = (typeof RULESET_ENFORCEMENT_STAGES)[number];

function isRulesetEnforcement(value: unknown): value is RulesetEnforcement {
  return typeof value === "string" && (RULESET_ENFORCEMENT_STAGES as readonly string[]).includes(value);
}

/** The exact App Principal identity fields this Ruleset needs to bind its bypass actor. */
export interface RulesetIssuerApp {
  readonly kind: typeof INARI_ISSUER_APP_KIND;
  readonly slug: typeof INARI_ISSUER_APP_SLUG;
  readonly appId: string;
}

const DECIMAL_ID = /^[1-9][0-9]*$/u;

function requireIssuerApp(issuerApp: RulesetIssuerApp): number {
  if (
    issuerApp === undefined ||
    issuerApp === null ||
    issuerApp.kind !== INARI_ISSUER_APP_KIND ||
    issuerApp.slug !== INARI_ISSUER_APP_SLUG ||
    typeof issuerApp.appId !== "string" ||
    !DECIMAL_ID.test(issuerApp.appId)
  ) {
    throw new TypeError("issuerApp must be the Inari issuer App Principal identity with a decimal appId.");
  }
  return Number(issuerApp.appId);
}

/** `refs/heads/<type>/**` for every canonical Change branch type, sorted deterministically. */
export function changeBranchRefNameIncludePatterns(): readonly string[] {
  return Object.freeze([...CANONICAL_BRANCH_TYPES].sort().map((type) => `refs/heads/${type}/**`));
}

/** The default branch is governed by the repository's existing Ruleset, not this one. */
export function changeBranchRefNameExcludePatterns(): readonly string[] {
  return Object.freeze([`refs/heads/${DEFAULT_BRANCH_NAME}`]);
}

export interface ChangeBranchCreationRulesetBypassActor {
  readonly actor_type: "Integration";
  readonly actor_id: number;
  readonly bypass_mode: "always";
}

export interface ChangeBranchCreationRulesetRule {
  readonly type: "creation";
}

export interface ChangeBranchCreationRuleset {
  readonly name: typeof CHANGE_BRANCH_CREATION_RULESET_NAME;
  readonly target: "branch";
  readonly enforcement: RulesetEnforcement;
  readonly conditions: {
    readonly ref_name: {
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    };
  };
  readonly rules: readonly [ChangeBranchCreationRulesetRule];
  readonly bypass_actors: readonly [ChangeBranchCreationRulesetBypassActor];
}

export interface BuildChangeBranchCreationRulesetOptions {
  readonly enforcement: RulesetEnforcement;
  readonly issuerApp: RulesetIssuerApp;
}

/**
 * Build the canonical desired-state Ruleset payload. The only rule is
 * `creation`, scoped to the governed Change branch namespace, with exactly
 * one bypass actor: the Inari issuer App. No other rule type is included, so
 * the issuer bypass cannot be read as granting review, approval, merge, or
 * administration authority.
 */
export function buildChangeBranchCreationRuleset(
  options: BuildChangeBranchCreationRulesetOptions,
): ChangeBranchCreationRuleset {
  if (!isRulesetEnforcement(options?.enforcement)) {
    throw new TypeError(`enforcement must be one of ${RULESET_ENFORCEMENT_STAGES.join(", ")}.`);
  }
  const actorId = requireIssuerApp(options.issuerApp);

  const rules: readonly [ChangeBranchCreationRulesetRule] = [Object.freeze({ type: "creation" })];
  const bypassActors: readonly [ChangeBranchCreationRulesetBypassActor] = [
    Object.freeze({ actor_type: "Integration", actor_id: actorId, bypass_mode: "always" }),
  ];

  return Object.freeze({
    name: CHANGE_BRANCH_CREATION_RULESET_NAME,
    target: "branch",
    enforcement: options.enforcement,
    conditions: Object.freeze({
      ref_name: Object.freeze({
        include: changeBranchRefNameIncludePatterns(),
        exclude: changeBranchRefNameExcludePatterns(),
      }),
    }),
    rules: Object.freeze(rules),
    bypass_actors: Object.freeze(bypassActors),
  });
}

export interface RulesetValidationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  const actualSorted = [...actual].filter((value) => typeof value === "string").sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.length === actual.length && JSON.stringify(actualSorted) === JSON.stringify(expectedSorted);
}

/**
 * Validate an arbitrary object against the exact invariants #223 requires:
 * scoped to the governed namespace, `creation` only (so ordinary pushes to
 * an already-issued branch are unaffected), exactly one bypass actor and it
 * is specifically the issuer App identified by `expectedIssuerAppId`, and a
 * supported staged enforcement value.
 *
 * `expectedIssuerAppId` is mandatory: without binding to a specific App ID,
 * a live Ruleset that bypasses some other Integration would validate as
 * `valid`, which defeats the #223 requirement that only the `inari-issuer`
 * Principal bypasses creation. Callers that only need a structural check
 * unrelated to any live payload still pass the issuer App ID they built the
 * candidate payload with.
 */
export function validateChangeBranchCreationRuleset(
  raw: unknown,
  expectedIssuerAppId: string,
): RulesetValidationResult {
  if (typeof expectedIssuerAppId !== "string" || !DECIMAL_ID.test(expectedIssuerAppId)) {
    throw new TypeError("expectedIssuerAppId must be a decimal App ID string.");
  }
  const violations: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, violations: ["Ruleset payload must be an object."] };
  }
  const ruleset = raw as Record<string, unknown>;

  if (ruleset.target !== "branch") violations.push('target must be "branch".');
  if (!isRulesetEnforcement(ruleset.enforcement)) {
    violations.push(`enforcement must be one of ${RULESET_ENFORCEMENT_STAGES.join(", ")}.`);
  }

  const rules = ruleset.rules;
  if (!Array.isArray(rules) || rules.length !== 1 || (rules[0] as { type?: unknown })?.type !== "creation") {
    violations.push(
      'rules must contain exactly one "creation" rule; a different or additional rule type would let the ' +
        "bypass actor exceed branch-creation authority.",
    );
  }

  const conditions = ruleset.conditions as { ref_name?: { include?: unknown; exclude?: unknown } } | undefined;
  const includePatterns = changeBranchRefNameIncludePatterns();
  const excludePatterns = changeBranchRefNameExcludePatterns();
  if (!sameStringSet(conditions?.ref_name?.include, includePatterns)) {
    violations.push(`conditions.ref_name.include must be exactly ${JSON.stringify(includePatterns)}.`);
  }
  if (!sameStringSet(conditions?.ref_name?.exclude, excludePatterns)) {
    violations.push(`conditions.ref_name.exclude must be exactly ${JSON.stringify(excludePatterns)}.`);
  }

  const bypassActors = ruleset.bypass_actors;
  if (!Array.isArray(bypassActors) || bypassActors.length !== 1) {
    violations.push("bypass_actors must contain exactly one entry so no arbitrary caller can bypass creation.");
  } else {
    const actor = bypassActors[0] as { actor_type?: unknown; actor_id?: unknown; bypass_mode?: unknown };
    if (actor.actor_type !== "Integration") violations.push('bypass_actors[0].actor_type must be "Integration".');
    if (actor.bypass_mode !== "always") violations.push('bypass_actors[0].bypass_mode must be "always".');
    if (typeof actor.actor_id !== "number" || !Number.isInteger(actor.actor_id) || actor.actor_id <= 0) {
      violations.push("bypass_actors[0].actor_id must be a positive integer App ID.");
    } else if (String(actor.actor_id) !== expectedIssuerAppId) {
      violations.push(`bypass_actors[0].actor_id must equal the issuer App ID ${expectedIssuerAppId}.`);
    }
  }

  return { valid: violations.length === 0, violations: Object.freeze(violations) };
}

function stageIndex(enforcement: RulesetEnforcement): number {
  return RULESET_ENFORCEMENT_STAGES.indexOf(enforcement);
}

/**
 * The next rollout stage from the current staged enforcement, or `undefined`
 * when the Ruleset does not exist yet. Rollout is strictly sequential
 * (`disabled -> evaluate -> active`); it never skips a stage and it is
 * idempotent once `active` is reached.
 */
export function planRulesetRolloutStage(current: RulesetEnforcement | undefined): RulesetEnforcement {
  if (current === undefined) return RULESET_ENFORCEMENT_STAGES[0];
  const index = stageIndex(current);
  if (index < 0) throw new TypeError(`current is not a supported enforcement stage: ${String(current)}.`);
  const next = RULESET_ENFORCEMENT_STAGES[Math.min(index + 1, RULESET_ENFORCEMENT_STAGES.length - 1)];
  return next as RulesetEnforcement;
}

/**
 * Rollback/recovery is a single immediate step back to `disabled` from any
 * current stage, preserving the Ruleset definition rather than deleting it,
 * so a repaired issuance path can resume staged rollout without redefining
 * the Ruleset from scratch.
 */
export function planRulesetRollback(current: RulesetEnforcement | undefined): RulesetEnforcement {
  if (current !== undefined && stageIndex(current) < 0) {
    throw new TypeError(`current is not a supported enforcement stage: ${String(current)}.`);
  }
  return RULESET_ENFORCEMENT_STAGES[0];
}

/** True only for an allowed one-step-forward rollout transition (including a no-op repeat at `active`). */
export function isRulesetRolloutAdvanceValid(from: RulesetEnforcement | undefined, to: RulesetEnforcement): boolean {
  if (!isRulesetEnforcement(to)) return false;
  if (from === undefined) return to === RULESET_ENFORCEMENT_STAGES[0];
  if (stageIndex(from) < 0) return false;
  if (from === RULESET_ENFORCEMENT_STAGES[RULESET_ENFORCEMENT_STAGES.length - 1]) return to === from;
  return stageIndex(to) === stageIndex(from) + 1;
}

/** True only for an allowed rollback transition: any known stage back to `disabled`. */
export function isRulesetRollbackValid(from: RulesetEnforcement | undefined, to: RulesetEnforcement): boolean {
  return to === RULESET_ENFORCEMENT_STAGES[0] && from !== undefined && stageIndex(from) >= 0;
}
