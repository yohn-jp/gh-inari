/** Inari-owned operational playbooks mapping task intents to canonical CLI workflows. */
export const SKILL_MODEL_VERSION = "1.0.0";
/** Hard cap on any single rendered skill output (index or scenario, text or JSON). */
export const MAX_SKILL_OUTPUT_BYTES = 4096;
const HELP_DISCLAIMER = "This playbook does not restate exact flags; run the help pointer above for precise syntax.";
export const SKILL_SCENARIOS = [
    {
        id: "author-issue",
        title: "Author a governed Issue",
        whenToUse: "Use when creating a new Issue that must satisfy repository governance from the start.",
        workflow: [
            { summary: "Inspect the required fields for the target template.", command: "inari issue schema <template>" },
            { summary: "Validate a draft input document against the contract.", command: "inari issue validate <template>" },
            { summary: "Render the validated input into the final Issue body.", command: "inari issue render <template>" },
            { summary: "Create the governed Issue on the repository.", command: "inari issue create <template>" },
        ],
        invariants: [
            "Never call raw `gh issue create` for a governed template; it bypasses contract validation.",
            "Validate before render; render before create.",
            HELP_DISCLAIMER,
        ],
        canonicalEntrypoint: "inari issue create",
        helpPointer: "inari issue --help",
    },
    {
        id: "author-pr",
        title: "Author a governed Pull Request",
        whenToUse: "Use when opening a new Pull Request that must satisfy repository governance from the start.",
        workflow: [
            { summary: "Inspect the required fields for the target template.", command: "inari pr schema <template>" },
            { summary: "Validate a draft input document against the contract.", command: "inari pr validate <template>" },
            { summary: "Render the validated input into the final PR body.", command: "inari pr render <template>" },
            { summary: "Create the governed Pull Request on the repository.", command: "inari pr create <template>" },
        ],
        invariants: [
            "Never call raw `gh pr create` for a governed template; it bypasses contract validation.",
            "Validate before render; render before create.",
            HELP_DISCLAIMER,
        ],
        canonicalEntrypoint: "inari pr create",
        helpPointer: "inari pr --help",
    },
    {
        id: "inspect-governance",
        title: "Inspect governance state of an existing artifact",
        whenToUse: "Use when you need to read the governance classification of an existing Issue or PR without changing it.",
        workflow: [
            { summary: "Classify the artifact against its governed contract.", command: "inari issue check <number>" },
            { summary: "Read detailed field-level explanation or raw values.", command: "inari issue explain <number>" },
        ],
        invariants: [
            "Read-only: this scenario never mutates the artifact.",
            "Applies equally to PRs via `inari pr check`/`inari pr explain`.",
            HELP_DISCLAIMER,
        ],
        canonicalEntrypoint: "inari issue check",
        helpPointer: "inari issue --help",
    },
    {
        id: "repair-invalid-artifact",
        title: "Repair an invalid governed artifact",
        whenToUse: "Use when `inspect-governance` shows an existing Issue or PR is invalid or non-normalized and needs correction.",
        workflow: [
            { summary: "Classify the artifact and confirm it needs repair.", command: "inari issue check <number>" },
            {
                summary: "Preview the repair without mutating the artifact.",
                command: "inari issue normalize <number> --dry-run",
            },
            { summary: "Apply the repair once the dry run looks correct.", command: "inari issue normalize <number>" },
        ],
        invariants: [
            "Always run a dry run before applying any mutation.",
            "Never mutate the artifact directly from a `check` failure without a dry-run step first.",
            "Applies equally to PRs via `inari pr check`/`inari pr normalize`.",
            HELP_DISCLAIMER,
        ],
        canonicalEntrypoint: "inari issue normalize",
        helpPointer: "inari issue --help",
    },
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
    for (const invariant of scenario.invariants) {
        lines.push(`  - ${invariant}`);
    }
    lines.push("");
    lines.push(`Canonical entrypoint: ${scenario.canonicalEntrypoint}`);
    lines.push(`Exact syntax: ${scenario.helpPointer}`);
    return lines.join("\n");
}
//# sourceMappingURL=skill.js.map