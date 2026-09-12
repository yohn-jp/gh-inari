import {
  commandExample,
  commandInvocation,
  helpInvocation,
  type CommandDomain,
  type CommandId,
} from "./command-contract.js";

/** Inari-owned operational playbooks mapping task intents to canonical CLI workflows. */

export const SKILL_MODEL_VERSION = "1.2.0";

/** Hard cap on any single rendered skill output (index or scenario, text or JSON). */
export const MAX_SKILL_OUTPUT_BYTES = 4096;

export interface SkillWorkflowStep {
  readonly summary: string;
  /** Stable reference into the versioned command contract. */
  readonly commandId: CommandId;
  /** Backward-compatible rendered command projection. */
  readonly command: string;
}

/**
 * A pointer to an existing Golden Path contract. The skill only tells a
 * caller which canonical output to consume; it does not reproduce the
 * contract's lifecycle or recovery decisions.
 */
export interface SkillContractReference {
  readonly contract: "golden-path-entry" | "change-handoff" | "golden-path-status" | "golden-path-recovery";
  readonly output: "action" | "handoff" | "nextAction" | "recovery";
  readonly instruction: string;
}

export interface SkillScenario {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
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
  return { summary, commandId, command: commandExample(commandId) };
}

function skillScenario(input: {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
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
    whenToUse: "Use when creating a new Issue that must satisfy repository governance from the start.",
    workflow: [
      ["Create directly with governed fields when the template and required fields are known.", "issue.create"],
      ["If required fields are unknown, inspect the target template before creating.", "issue.schema"],
      ["For explicit preview or debugging, validate input without creating.", "issue.validate"],
      ["For explicit artifact generation, render input without creating.", "issue.render"],
    ],
    invariants: [
      "Never call raw `gh issue create` for a governed template; it bypasses contract validation.",
      "Direct governed creation is the golden path when required fields are already known.",
      "Schema inspection is conditional, not a mandatory step when field requirements are known.",
      "Validate and render are explicit preview, debugging, or artifact-generation paths, not mandatory ceremony.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "issue.create",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "author-pr",
    title: "Author a governed Pull Request",
    whenToUse: "Use when opening a new Pull Request that must satisfy repository governance from the start.",
    workflow: [
      ["Create directly with governed fields when the template and required fields are known.", "pr.create"],
      ["If required fields are unknown, inspect the target template before creating.", "pr.schema"],
      ["For explicit preview or debugging, validate input without creating.", "pr.validate"],
      ["For explicit artifact generation, render input without creating.", "pr.render"],
    ],
    invariants: [
      "Never call raw `gh pr create` for a governed template; it bypasses contract validation.",
      "Direct governed creation is the golden path when required fields are already known.",
      "Schema inspection is conditional, not a mandatory step when field requirements are known.",
      "Validate and render are explicit preview, debugging, or artifact-generation paths, not mandatory ceremony.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "pr.create",
    helpDomain: "pr",
  }),
  skillScenario({
    id: "inspect-governance",
    title: "Inspect governance state of an existing artifact",
    whenToUse:
      "Use when you need to read the governance classification of an existing Issue or PR without changing it.",
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
    workflow: [
      ["Classify the artifact and confirm it needs repair.", "issue.check"],
      [
        "Preview, then apply canonicalization after review for a parseable, semantically valid artifact.",
        "issue.normalize",
      ],
      ["Preview, then apply an explicit semantic or metadata patch after review.", "issue.edit"],
      ["Preview, then apply a sync operation after review when desired-state convergence is required.", "issue.sync"],
    ],
    invariants: [
      "Check is read-only; choose normalize, edit, or sync from its classification.",
      "Normalize only when preservation of current semantics is proven; use edit or sync for explicit repair.",
      "Always preview a mutation before applying it.",
      "Applies equally to PRs via the corresponding `inari pr` commands.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "issue.normalize",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "manage-issue-relationships",
    title: "Reconcile an existing Issue's native parent/dependency relationships",
    whenToUse:
      "Use when an existing Issue's GitHub-native parent (sub-issue) or blocked-by relationships must be set, changed, or removed through Inari's semantic authority, instead of editing relationship prose by hand.",
    scope: "specialized-alternative",
    workflow: [
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
      "Always preview before executing; execute re-observes and rejects a plan the repository state has outgrown.",
      "A real relationship mutation requires complete bounded relationship-graph evidence; omitted or incomplete evidence fails closed.",
      "Desired relationship state is expressed only through `parent`/`dependsOn`; `children`/`blocks` remain derived, never caller-supplied input.",
      "Markdown `Parent Epic:`/task-list references are compatibility projections only, never semantic authority once this command is used.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "issue.relations.plan",
    helpDomain: "issue",
  }),
  skillScenario({
    id: "manage-change",
    title: "Manage a governed Change",
    whenToUse: "Use when implementation work must be issued, inspected, admitted to review, or intentionally stopped.",
    workflow: [
      ["Issue the semantic Change for the root Issue before implementation begins.", "change.issue"],
      ["Read the bounded Change projection without requesting a mutation.", "change.show"],
      ["Request the governed transition to review after implementation evidence is ready.", "change.ready"],
      ["Request governed termination when the active Change should be stopped.", "change.abort"],
    ],
    invariants: [
      "Use semantic Change commands; do not create refs or pull requests as a substitute for Change issuance.",
      "Change show is read-only and does not require privileged mutation authority.",
      "Transport details and issuer credentials are never CLI inputs.",
      "Existing artifact-level Issue/PR mutation commands remain migration-compatible paths during rollout.",
      HELP_DISCLAIMER,
    ],
    canonicalCommandId: "change.issue",
    helpDomain: "change",
  }),
  skillScenario({
    id: "golden-path",
    title: "Follow the Inari Golden Path",
    whenToUse: "Use when taking governed intent from entry through implementation and governed review admission.",
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

export interface SkillIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
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
    })),
  };
}

export function projectSkillIndexToText(): string {
  const lines: string[] = [`Inari skill scenarios (v${SKILL_MODEL_VERSION}):`, ""];
  for (const scenario of SKILL_SCENARIOS) {
    lines.push(`  ${scenario.id} - ${scenario.title}`);
    lines.push(`    ${scenario.whenToUse}`);
  }
  lines.push("");
  lines.push("Run `inari skill <scenario>` for the full playbook.");
  return lines.join("\n");
}

export function projectSkillScenarioToJson(scenario: SkillScenario): SkillScenarioProjection {
  return {
    version: SKILL_MODEL_VERSION,
    id: scenario.id,
    title: scenario.title,
    whenToUse: scenario.whenToUse,
    workflow: scenario.workflow,
    contractReferences: scenario.contractReferences,
    invariants: scenario.invariants,
    canonicalCommandId: scenario.canonicalCommandId,
    helpDomain: scenario.helpDomain,
    canonicalEntrypoint: scenario.canonicalEntrypoint,
    helpPointer: scenario.helpPointer,
  };
}

export function projectSkillScenarioToText(scenario: SkillScenario): string {
  const lines: string[] = [
    `${scenario.title} (${scenario.id})`,
    "",
    `When to use: ${scenario.whenToUse}`,
    "",
    "Workflow:",
  ];
  scenario.workflow.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.summary}`);
    lines.push(`     ${step.command}`);
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
