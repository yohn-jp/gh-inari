/** Inari-owned operational playbooks mapping task intents to canonical CLI workflows. */
export const SKILL_MODEL_VERSION = "1.0.0";
/** Hard cap on any single rendered skill output (index or scenario, text or JSON). */
export const MAX_SKILL_OUTPUT_BYTES = 4096;
const HELP_DISCLAIMER = "This playbook does not restate exact flags; run the help pointer below for precise syntax.";
export const SKILL_SCENARIOS = [
    {
        id: "author-issue",
        title: "Author a governed Issue",
        whenToUse: "Use when creating a new Issue that must satisfy repository governance from the start.",
        workflow: [
            {
                summary: "Create directly with governed fields when the template and required fields are known.",
                command: "inari issue create",
            },
            {
                summary: "If required fields are unknown, inspect the target template before creating.",
                command: "inari issue schema",
            },
            {
                summary: "For explicit preview or debugging, validate input without creating.",
                command: "inari issue validate",
            },
            { summary: "For explicit artifact generation, render input without creating.", command: "inari issue render" },
        ],
        invariants: [
            "Never call raw `gh issue create` for a governed template; it bypasses contract validation.",
            "Direct governed creation is the golden path when required fields are already known.",
            "Schema inspection is conditional, not a mandatory step when field requirements are known.",
            "Validate and render are explicit preview, debugging, or artifact-generation paths, not mandatory ceremony.",
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
            {
                summary: "Create directly with governed fields when the template and required fields are known.",
                command: "inari pr create",
            },
            {
                summary: "If required fields are unknown, inspect the target template before creating.",
                command: "inari pr schema",
            },
            { summary: "For explicit preview or debugging, validate input without creating.", command: "inari pr validate" },
            { summary: "For explicit artifact generation, render input without creating.", command: "inari pr render" },
        ],
        invariants: [
            "Never call raw `gh pr create` for a governed template; it bypasses contract validation.",
            "Direct governed creation is the golden path when required fields are already known.",
            "Schema inspection is conditional, not a mandatory step when field requirements are known.",
            "Validate and render are explicit preview, debugging, or artifact-generation paths, not mandatory ceremony.",
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
            {
                summary: "Read canonical fields and metadata when the artifact is available canonically.",
                command: "inari issue get <number>",
            },
            {
                summary: "Read detailed diagnostics when the classification needs explanation.",
                command: "inari issue explain <number>",
            },
        ],
        invariants: [
            "Read-only: this scenario never mutates the artifact.",
            "Applies equally to PRs via the corresponding `inari pr` commands.",
            HELP_DISCLAIMER,
        ],
        canonicalEntrypoint: "inari issue check",
        helpPointer: "inari issue --help",
    },
    {
        id: "repair-invalid-artifact",
        title: "Repair or normalize a governed artifact",
        whenToUse: "Use when inspection identifies a non-canonical or semantically invalid Issue or PR that needs correction.",
        workflow: [
            { summary: "Classify the artifact and confirm it needs repair.", command: "inari issue check <number>" },
            {
                summary: "Preview, then apply canonicalization after review for a parseable, semantically valid artifact.",
                command: "inari issue normalize <number>",
            },
            {
                summary: "Preview, then apply an explicit semantic or metadata patch after review.",
                command: "inari issue edit <number>",
            },
            {
                summary: "Preview, then apply a sync operation after review when desired-state convergence is required.",
                command: "inari issue sync <number>",
            },
        ],
        invariants: [
            "Check is read-only; choose normalize, edit, or sync from its classification.",
            "Normalize only when preservation of current semantics is proven; use edit or sync for explicit repair.",
            "Always preview a mutation before applying it.",
            "Applies equally to PRs via the corresponding `inari pr` commands.",
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