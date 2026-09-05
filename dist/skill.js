import { commandExample, commandInvocation, helpInvocation, } from "./command-contract.js";
/** Inari-owned operational playbooks mapping task intents to canonical CLI workflows. */
export const SKILL_MODEL_VERSION = "1.1.0";
/** Hard cap on any single rendered skill output (index or scenario, text or JSON). */
export const MAX_SKILL_OUTPUT_BYTES = 4096;
const HELP_DISCLAIMER = "This playbook does not restate exact flags; run the help pointer below for precise syntax.";
function workflowStep(summary, commandId) {
    return { summary, commandId, command: commandExample(commandId) };
}
function skillScenario(input) {
    return {
        id: input.id,
        title: input.title,
        whenToUse: input.whenToUse,
        workflow: input.workflow.map(([summary, commandId]) => workflowStep(summary, commandId)),
        invariants: input.invariants,
        canonicalCommandId: input.canonicalCommandId,
        helpDomain: input.helpDomain,
        canonicalEntrypoint: commandInvocation(input.canonicalCommandId),
        helpPointer: helpInvocation(input.helpDomain),
    };
}
export const SKILL_SCENARIOS = [
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
        whenToUse: "Use when you need to read the governance classification of an existing Issue or PR without changing it.",
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
        whenToUse: "Use when inspection identifies a non-canonical or semantically invalid Issue or PR that needs correction.",
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
];
export function findSkillScenario(id) {
    return SKILL_SCENARIOS.find((scenario) => scenario.id === id);
}
export function projectSkillIndexToJson() {
    return {
        version: SKILL_MODEL_VERSION,
        scenarios: SKILL_SCENARIOS.map((scenario) => ({
            id: scenario.id,
            title: scenario.title,
            whenToUse: scenario.whenToUse,
        })),
    };
}
export function projectSkillIndexToText() {
    const lines = [`Inari skill scenarios (v${SKILL_MODEL_VERSION}):`, ""];
    for (const scenario of SKILL_SCENARIOS) {
        lines.push(`  ${scenario.id} - ${scenario.title}`);
        lines.push(`    ${scenario.whenToUse}`);
    }
    lines.push("");
    lines.push("Run `inari skill <scenario>` for the full playbook.");
    return lines.join("\n");
}
export function projectSkillScenarioToJson(scenario) {
    return {
        version: SKILL_MODEL_VERSION,
        id: scenario.id,
        title: scenario.title,
        whenToUse: scenario.whenToUse,
        workflow: scenario.workflow,
        invariants: scenario.invariants,
        canonicalCommandId: scenario.canonicalCommandId,
        helpDomain: scenario.helpDomain,
        canonicalEntrypoint: scenario.canonicalEntrypoint,
        helpPointer: scenario.helpPointer,
    };
}
export function projectSkillScenarioToText(scenario) {
    const lines = [
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
    lines.push("");
    lines.push("Invariants:");
    for (const invariant of scenario.invariants)
        lines.push(`  - ${invariant}`);
    lines.push("");
    lines.push(`Canonical entrypoint: ${scenario.canonicalEntrypoint}`);
    lines.push(`Exact syntax: ${scenario.helpPointer}`);
    return lines.join("\n");
}
//# sourceMappingURL=skill.js.map