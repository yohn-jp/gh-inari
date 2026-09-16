import {
  commandExample,
  commandInvocation,
  getCommand,
  helpInvocation,
  projectImplementationCommandSurface,
  type CommandArgumentBindings,
  type CommandDomain,
  type CommandId,
} from "./command-contract.js";
import type { GoldenPathGovernanceDiscoveryResult } from "./golden-path-governance.js";

/** Inari-owned operational playbooks mapping task intents to canonical CLI workflows. */

export const SKILL_MODEL_VERSION = "1.5.0";
export const SKILL_DEFAULT_SCENARIO_ID = "golden-path" as const;

/** Hard cap on any single rendered skill output (index or scenario, text or JSON). */
export const MAX_SKILL_OUTPUT_BYTES = 4096;

export interface SkillWorkflowStep {
  readonly summary: string;
  /** Stable reference into the versioned command contract. */
  readonly commandId: CommandId;
  /** Backward-compatible rendered command projection when all required inputs are bound. */
  readonly command?: string;
  /** Authoritative command-option values used to render an executable command. */
  readonly bindings?: CommandArgumentBindings;
  /** Canonical prerequisite when this step cannot yet be rendered safely. */
  readonly prerequisite?: SkillWorkflowPrerequisite;
}

export interface SkillWorkflowPrerequisite {
  readonly kind: "golden-path-governance";
  readonly action: string;
  readonly reason?: string;
}

export interface SkillProjectionContext {
  /** Result returned by Golden Path governance; selection remains outside the skill projection. */
  readonly governance?: GoldenPathGovernanceDiscoveryResult;
}

export type SkillScenarioScope = "default-route" | "leaf-operation" | "specialized-alternative";

/**
 * A pointer to an existing Golden Path contract. The skill only tells a
 * caller which canonical output to consume; it does not reproduce the
 * contract's lifecycle or recovery decisions.
 */
export interface SkillContractReference {
  readonly contract:
    | "golden-path-entry"
    | "golden-path-governance"
    | "change-handoff"
    | "golden-path-status"
    | "golden-path-recovery"
    | "remediation-recovery";
  readonly output: "action" | "handoff" | "nextAction" | "recovery";
  readonly instruction: string;
}

export interface SkillScenario {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly scope: SkillScenarioScope;
  readonly delegatesTo?: typeof SKILL_DEFAULT_SCENARIO_ID;
  readonly workflow: readonly SkillWorkflowStep[];
  readonly contractReferences: readonly SkillContractReference[];
  readonly invariants: readonly string[];
  readonly canonicalCommandId: CommandId;
  readonly helpDomain: Exclude<CommandDomain, "root">;
  readonly canonicalEntrypoint: string;
  readonly helpPointer: string;
}

const HELP_DISCLAIMER = "This playbook does not restate exact flags; run the help pointer below for precise syntax.";

function workflowStep(summary: string, commandId: CommandId): SkillWorkflowStep {
  const command = getCommand(commandId);
  return { summary, commandId, command: commandExample(command.id) };
}

const IMPLEMENTATION_COMMAND_CONTRACT_INVARIANT = (() => {
  const projection = projectImplementationCommandSurface();
  return `The \`impl\` workflow is projected from command contract ${projection.id} (version ${projection.version}); follow its command metadata and do not invent an \`impl\` command.`;
})();

function skillScenario(input: {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly scope: SkillScenarioScope;
  readonly delegatesTo?: typeof SKILL_DEFAULT_SCENARIO_ID;
  readonly workflow: readonly (readonly [summary: string, commandId: CommandId])[];
  readonly contractReferences?: readonly SkillContractReference[];
  readonly invariants: readonly string[];
  readonly canonicalCommandId: CommandId;
  readonly helpDomain: Exclude<CommandDomain, "root">;
}): SkillScenario {
  return {
    id: input.id,
    title: input.title,
    whenToUse: input.whenToUse,
    scope: input.scope,
    ...(input.delegatesTo === undefined ? {} : { delegatesTo: input.delegatesTo }),
    workflow: input.workflow.map(([summary, commandId]) => workflowStep(summary, commandId)),
    contractReferences: input.contractReferences ?? [],
    invariants: input.invariants,
    canonicalCommandId: input.canonicalCommandId,
    helpDomain: input.helpDomain,
    canonicalEntrypoint: commandInvocation(input.canonicalCommandId),
    helpPointer: helpInvocation(input.helpDomain),
  };
}

export const SKILL_SCENARIOS: readonly SkillScenario[] = [
  skillScenario({
    id: "author-issue",
    title: "Author a governed Issue",
    whenToUse:
      "Use for an explicit governed Issue leaf operation; normal development starts with `inari skill golden-path`.",
    scope: "leaf-operation",
    delegatesTo: SKILL_DEFAULT_SCENARIO_ID,
    workflow: [
      [
        "Create a governed Issue as an explicit leaf operation when the Golden Path Issue stage requests it.",
        "issue.create",
      ],
      ["If required fields are unknown, inspect the target template before creating.", "issue.schema"],
      ["For explicit preview or debugging, validate input without creating.", "issue.validate"],
      ["For explicit artifact generation, render input without creating.", "issue.render"],
    ],
    invariants: [
      "Never call raw `gh issue create` for a governed template; it bypasses contract validation.",
      "Normal development follows `inari skill golden-path`; this leaf does not issue a Change or create a PR.",
      "An ordinary Issue records a problem, request, or decision; session scopes, base binding, verification, and authorization belong in a separate Implementation Issue.",
      "Direct governed creation is the conditional leaf fast path when required fields are already known.",
      "Schema inspection is conditional, not a mandatory step when field requirements are known.",
      "Validate and render are explicit preview, debugging, or artifact-generation paths, not mandatory ceremony.",
      "Use the Golden Path governance nextAction; do not reconstruct template discovery or selection here.",
      HELP_DISCLAIMER,
    ],
    contractReferences: [
      {
        contract: "golden-path-governance",
        output: "nextAction",
        instruction:
          "Consume the bounded governance result and follow its nextAction before choosing direct creation or discovery.",
      },
    ],
    canonicalCommandId: "issue.create",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "author-pr",
    title: "Author a governed Pull Request",
    whenToUse:
      "Use for an explicit standalone governed PR leaf operation; normal development starts with `inari skill golden-path`.",
    scope: "leaf-operation",
    delegatesTo: SKILL_DEFAULT_SCENARIO_ID,
    workflow: [
      [
        "Create a governed PR only for an explicit standalone leaf operation outside the Golden Path Change route.",
        "pr.create",
      ],
      ["If required fields are unknown, inspect the target template before creating.", "pr.schema"],
      ["For explicit preview or debugging, validate input without creating.", "pr.validate"],
      ["For explicit artifact generation, render input without creating.", "pr.render"],
    ],
    invariants: [
      "Never call raw `gh pr create` for a governed template; it bypasses contract validation.",
      "Normal development uses Golden Path Change issuance; this leaf does not replace the canonical Draft PR.",
      "A PR records delivered work and validation; it does not replace an Implementation contract or carry a second session authorization.",
      "Direct governed creation is the conditional leaf fast path when required fields are already known.",
      "Schema inspection is conditional, not a mandatory step when field requirements are known.",
      "Validate and render are explicit preview, debugging, or artifact-generation paths, not mandatory ceremony.",
      "Use the Golden Path governance nextAction; do not reconstruct template discovery or selection here.",
      HELP_DISCLAIMER,
    ],
    contractReferences: [
      {
        contract: "golden-path-governance",
        output: "nextAction",
        instruction:
          "Consume the bounded governance result and follow its nextAction before choosing direct creation or discovery.",
      },
    ],
    canonicalCommandId: "pr.create",
    helpDomain: "pr",
  }),
  skillScenario({
    id: "inspect-governance",
    title: "Inspect governance state of an existing artifact",
    whenToUse:
      "Use when you need to read the governance classification of an existing Issue or PR without changing it.",
    scope: "specialized-alternative",
    workflow: [
      ["Classify the artifact against its governed contract.", "issue.check"],
      ["Read canonical fields and metadata when the artifact is available canonically.", "issue.get"],
      ["Read detailed diagnostics when the classification needs explanation.", "issue.explain"],
    ],
    invariants: [
      "Read-only: this scenario never mutates the artifact.",
      "Applies equally to PRs via the corresponding `inari pr` commands.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "issue.check",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "repair-invalid-artifact",
    title: "Repair or normalize a governed artifact",
    whenToUse:
      "Use when inspection identifies a non-canonical or semantically invalid Issue or PR that needs correction.",
    scope: "specialized-alternative",
    workflow: [
      ["Classify the artifact and consume its versioned remediation recovery decision.", "issue.check"],
      ["Follow the returned operation and input mode, then preview and apply it after review.", "issue.normalize"],
      ["Use the corresponding edit or sync command only when the returned recovery decision names it.", "issue.edit"],
      ["For sync-required recovery, provide the complete desired document through the sync contract.", "issue.sync"],
    ],
    invariants: [
      "Check is read-only; consume its versioned recovery decision instead of deriving an operation from classification.",
      "Normalize only when preservation of current semantics is proven; use edit or sync for explicit repair.",
      "Always preview a mutation before applying it.",
      "Applies equally to PRs via the corresponding `inari pr` commands.",
      HELP_DISCLAIMER,
    ],
    contractReferences: [
      {
        contract: "remediation-recovery",
        output: "recovery",
        instruction:
          "Consume the bounded `check`/`explain` recovery projection; do not probe normalize, edit, or sync to discover the next operation.",
      },
    ],
    canonicalCommandId: "issue.normalize",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "manage-issue-relationships",
    title: "Inspect and reconcile an existing Issue's native parent/sub-issue relationships",
    whenToUse:
      "Use when an existing Issue's GitHub-native parent, direct children, or blocked-by relationships must be inspected or changed through Inari's semantic authority, instead of editing relationship prose by hand.",
    scope: "specialized-alternative",
    workflow: [
      [
        "Inspect provider-authoritative parent and direct-child evidence before choosing a mutation.",
        "issue.relations.inspectParent",
      ],
      [
        "Inspect the provider-authoritative direct sub-issues when the Issue is a parent.",
        "issue.relations.inspectChildren",
      ],
      ["Attach a child through the generic relationship authority.", "issue.relations.attach"],
      ["Detach a child only from its explicitly observed parent.", "issue.relations.detach"],
      ["Explicitly reparent a child from its old parent to a new parent.", "issue.relations.reparent"],
      [
        "Preview the deterministic relationship plan from live observation before mutating anything.",
        "issue.relations.plan",
      ],
      [
        "Apply the previewed plan through the governed executor once the preview looks correct.",
        "issue.relations.execute",
      ],
    ],
    invariants: [
      "Inspect provider state before mutation; every generic mutation rereads and verifies its provider postcondition.",
      "Explicit reparent requires the old and new parent; attach never silently replaces an existing parent.",
      "Always preview before executing the semantic parent/dependency plan; execute re-observes and rejects a plan the repository state has outgrown.",
      "A real relationship mutation requires complete bounded relationship-graph evidence; omitted or incomplete evidence fails closed.",
      "Desired relationship state is expressed only through `parent`/`dependsOn`; `children`/`blocks` remain derived, never caller-supplied input.",
      "Markdown `Parent:`/`Parent Epic:`/task-list references are compatibility projections only; native provider relationship evidence is the authority where supported.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "issue.relations.plan",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "manage-implementation",
    title: "Prepare and inspect an Implementation",
    whenToUse:
      "Use when an ordinary Issue has reached the point where one concrete implementation session must be planned, validated, or authorized.",
    scope: "leaf-operation",
    delegatesTo: SKILL_DEFAULT_SCENARIO_ID,
    workflow: [
      [
        "Draft a bounded Implementation recommendation from authoritative source Issue evidence without granting authority.",
        "impl.plan",
      ],
      [
        "Create a separate Implementation Issue through the governed Issue operation using the Implementation template.",
        "issue.create",
      ],
      ["Show the current Implementation body, contract projection, and authorization state.", "impl.show"],
      ["Validate the current Implementation body without mutation.", "impl.validate"],
      ["Authorize the current canonical Implementation body through the existing Core boundary.", "impl.authorize"],
      ["Inspect lifecycle and provider-authoritative parent/source relationships.", "impl.inspect"],
      [
        "Verify a pull request and its authoritative diff against the current authorized Implementation.",
        "impl.verify",
      ],
    ],
    invariants: [
      "The ordinary Issue remains the problem, request, or decision record; this scenario keeps one-session detail in the Implementation.",
      "`impl.plan` is a preview and its recommendations are not authoritative; it does not authorize or mutate an Issue.",
      "`impl.validate` is read-only. `impl.show` and `impl.inspect` project current evidence without mutation.",
      "`impl.authorize` requires the current canonical body and authoritative base evidence, then emits Core authorization evidence without a GitHub mutation.",
      "`impl.verify` requires current authorization and verifies the pull request and diff against that bounded Implementation.",
      "Use native parent/sub-issue provider evidence where supported; prose `Parent:` is compatibility guidance for older artifacts and never triggers bulk reparenting.",
      IMPLEMENTATION_COMMAND_CONTRACT_INVARIANT,
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "impl.plan",
    helpDomain: "impl",
  }),
  skillScenario({
    id: "manage-change",
    title: "Manage a governed Change",
    whenToUse:
      "Use for an explicit single Change operation; normal implementation lifecycle starts with `inari skill golden-path`.",
    scope: "leaf-operation",
    delegatesTo: SKILL_DEFAULT_SCENARIO_ID,
    workflow: [
      ["Issue a semantic Change when an explicit caller or Golden Path stage requests issuance.", "change.issue"],
      ["Read the bounded Change projection without requesting a mutation.", "change.show"],
      ["Request the governed ready transition after implementation evidence is ready.", "change.ready"],
      ["Request governed termination when an active Change should be stopped.", "change.abort"],
    ],
    invariants: [
      "Normal implementation follows `inari skill golden-path`; this scenario is a leaf command projection, not a lifecycle.",
      "Use semantic Change commands; do not create refs or pull requests as a substitute for Change issuance.",
      "Change show is read-only and does not require privileged mutation authority.",
      "Transport details and issuer credentials are never CLI inputs.",
      "Consume canonical status and recovery outputs; do not infer next actions, retry safety, or cleanup here.",
      "Existing artifact-level Issue/PR mutation commands remain migration-compatible paths during rollout.",
      HELP_DISCLAIMER,
    ],
    contractReferences: [
      {
        contract: "golden-path-status",
        output: "nextAction",
        instruction: "Consume canonical nextAction output for routing instead of deriving a Change sequence here.",
      },
      {
        contract: "golden-path-recovery",
        output: "recovery",
        instruction:
          "Consume canonical recovery output; never infer retry safety or cleanup from this leaf projection.",
      },
    ],
    canonicalCommandId: "change.issue",
    helpDomain: "change",
  }),
  skillScenario({
    id: "golden-path",
    title: "Follow the Inari Golden Path",
    whenToUse: "Use when taking governed intent from entry through implementation and governed review admission.",
    scope: "default-route",
    workflow: [
      ["Verify the canonical runtime is available before starting governed work.", "root.diagnose"],
      ["Resolve repository-native governance, then create the governed root Issue when it is absent.", "issue.create"],
      ["Issue the semantic Change and consume its canonical entry result before implementation.", "change.issue"],
      [
        "Hand implementation responsibility to the canonical worker boundary and wait for completion evidence.",
        "change.show",
      ],
      ["After implementation evidence is ready, request the governed transition to review.", "change.ready"],
      [
        "Reread the canonical status after each operation and follow its returned action until REVIEW, WAIT, or stop.",
        "change.show",
      ],
      [
        "If recovery returns ABORT, request governed termination; retry only when recovery says it is safe.",
        "change.abort",
      ],
    ],
    contractReferences: [
      {
        contract: "golden-path-governance",
        output: "nextAction",
        instruction:
          "Use the bounded governance result's nextAction; direct creation is valid only when that result permits it.",
      },
      {
        contract: "golden-path-entry",
        output: "action",
        instruction: "Use the entry result's action; never infer Change issuance or create a branch/PR manually.",
      },
      {
        contract: "change-handoff",
        output: "handoff",
        instruction:
          "Use the canonical implementation handoff; keep worker, worktree, and process internals out of this skill.",
      },
      {
        contract: "golden-path-status",
        output: "nextAction",
        instruction:
          "Treat nextAction as the only normal-path routing signal; do not create a second transition model.",
      },
      {
        contract: "golden-path-recovery",
        output: "recovery",
        instruction:
          "On recovery, obey safeAction, retryable, rereadRequired, and automaticCleanup exactly as returned.",
      },
    ],
    invariants: [
      "Use repository-native governance and semantic Change contracts; do not invent branch names, PR identity, or raw GitHub mutations.",
      "The normal route is governed intent -> Change issuance -> implementation handoff -> governed readiness -> REVIEW; exact routing comes from canonical nextAction output.",
      "Inari emits the implementation handoff; Nawabari owns the worktree, session, process, and local Git execution without exposing its internals here.",
      "Never infer retry safety or cleanup. Reread authoritative recovery evidence before any retry, abort, or recovery action.",
      "Stop on MANUAL_REVIEW, unavailable or ambiguous evidence, unsupported capability, or any terminal result that provides no safe action.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "change.issue",
    helpDomain: "change",
  }),
];

export function findSkillScenario(id: string): SkillScenario | undefined {
  return SKILL_SCENARIOS.find((scenario) => scenario.id === id);
}

function templateSchemaDomain(commandId: CommandId): "issue" | "pr" | undefined {
  const command = getCommand(commandId);
  return command.operation === "schema" && (command.domain === "issue" || command.domain === "pr")
    ? command.domain
    : undefined;
}

function governanceMatchesSchemaDomain(
  governance: GoldenPathGovernanceDiscoveryResult,
  domain: "issue" | "pr",
): boolean {
  return governance.domain === domain || (domain === "pr" && governance.domain === "pull_request");
}

function prerequisiteForSchema(governance: GoldenPathGovernanceDiscoveryResult | undefined): SkillWorkflowPrerequisite {
  return {
    kind: "golden-path-governance",
    action: governance?.nextAction.action ?? "resolve-governance",
    ...(governance === undefined || governance.status === "resolved" ? {} : { reason: governance.reason }),
  };
}

function projectWorkflowStep(step: SkillWorkflowStep, context: SkillProjectionContext): SkillWorkflowStep {
  const domain = templateSchemaDomain(step.commandId);
  if (domain === undefined) return step;

  const governance = context.governance;
  if (
    governance?.status === "resolved" &&
    governance.source === "native-template" &&
    governanceMatchesSchemaDomain(governance, domain) &&
    "templateIdentity" in governance.contract
  ) {
    const bindings = { template: governance.contract.templateIdentity.path } as const;
    return {
      summary: step.summary,
      commandId: step.commandId,
      bindings,
      command: commandExample(step.commandId, bindings),
    };
  }

  return {
    summary: step.summary,
    commandId: step.commandId,
    prerequisite: prerequisiteForSchema(governance),
  };
}

function projectWorkflow(scenario: SkillScenario, context: SkillProjectionContext): readonly SkillWorkflowStep[] {
  return scenario.workflow.map((step) => projectWorkflowStep(step, context));
}

export interface SkillIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly scope: SkillScenarioScope;
  readonly delegatesTo?: typeof SKILL_DEFAULT_SCENARIO_ID;
}

export interface SkillIndexProjection {
  readonly version: string;
  readonly scenarios: readonly SkillIndexEntry[];
}

export interface SkillScenarioProjection {
  readonly version: string;
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly scope: SkillScenarioScope;
  readonly delegatesTo?: typeof SKILL_DEFAULT_SCENARIO_ID;
  readonly workflow: readonly SkillWorkflowStep[];
  readonly contractReferences: readonly SkillContractReference[];
  readonly invariants: readonly string[];
  readonly canonicalCommandId: CommandId;
  readonly helpDomain: Exclude<CommandDomain, "root">;
  readonly canonicalEntrypoint: string;
  readonly helpPointer: string;
}

export function projectSkillIndexToJson(): SkillIndexProjection {
  return {
    version: SKILL_MODEL_VERSION,
    scenarios: SKILL_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      whenToUse: scenario.whenToUse,
      scope: scenario.scope,
      ...(scenario.delegatesTo === undefined ? {} : { delegatesTo: scenario.delegatesTo }),
    })),
  };
}

export function projectSkillIndexToText(): string {
  const lines: string[] = [`Inari skill scenarios (v${SKILL_MODEL_VERSION}):`, ""];
  for (const scenario of SKILL_SCENARIOS) {
    const route =
      scenario.scope === "default-route"
        ? "default route"
        : scenario.delegatesTo === undefined
          ? "specialized alternative"
          : `leaf operation; delegates to \`inari skill ${scenario.delegatesTo}\``;
    lines.push(`  ${scenario.id} - ${scenario.title} [${route}]`);
    lines.push(`    ${scenario.whenToUse}`);
  }
  lines.push("");
  lines.push("Run `inari skill <scenario>` for the full playbook.");
  return lines.join("\n");
}

export function projectSkillScenarioToJson(
  scenario: SkillScenario,
  context: SkillProjectionContext = {},
): SkillScenarioProjection {
  return {
    version: SKILL_MODEL_VERSION,
    id: scenario.id,
    title: scenario.title,
    whenToUse: scenario.whenToUse,
    scope: scenario.scope,
    ...(scenario.delegatesTo === undefined ? {} : { delegatesTo: scenario.delegatesTo }),
    workflow: projectWorkflow(scenario, context),
    contractReferences: scenario.contractReferences,
    invariants: scenario.invariants,
    canonicalCommandId: scenario.canonicalCommandId,
    helpDomain: scenario.helpDomain,
    canonicalEntrypoint: scenario.canonicalEntrypoint,
    helpPointer: scenario.helpPointer,
  };
}

export function projectSkillScenarioToText(scenario: SkillScenario, context: SkillProjectionContext = {}): string {
  const lines: string[] = [
    `${scenario.title} (${scenario.id})`,
    "",
    `When to use: ${scenario.whenToUse}`,
    "",
    `Scope: ${
      scenario.scope === "default-route"
        ? `default route (run \`inari skill ${scenario.id}\`)`
        : scenario.delegatesTo === undefined
          ? "specialized alternative to the default route"
          : `leaf operation; normal development delegates to \`inari skill ${scenario.delegatesTo}\``
    }`,
    "",
    "Workflow:",
  ];
  projectWorkflow(scenario, context).forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.summary}`);
    if (step.command !== undefined) lines.push(`     ${step.command}`);
    if (step.bindings !== undefined) lines.push(`     Bound arguments: ${JSON.stringify(step.bindings)}`);
    if (step.prerequisite !== undefined) lines.push(`     Prerequisite: ${JSON.stringify(step.prerequisite)}`);
  });
  if (scenario.contractReferences.length > 0) {
    lines.push("");
    lines.push("Canonical contract references:");
    for (const reference of scenario.contractReferences) {
      lines.push(`  - ${reference.contract}.${reference.output}: ${reference.instruction}`);
    }
  }
  lines.push("");
  lines.push("Invariants:");
  for (const invariant of scenario.invariants) lines.push(`  - ${invariant}`);
  lines.push("");
  lines.push(`Canonical entrypoint: ${scenario.canonicalEntrypoint}`);
  lines.push(`Exact syntax: ${scenario.helpPointer}`);
  return lines.join("\n");
}
