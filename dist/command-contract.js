/**
 * The versioned authority for the command surface owned by Inari.
 *
 * This module intentionally describes CLI commands and option mechanics only.
 * Repository/template fields are selected from an artifact contract at runtime
 * and must not be copied into this static model.
 */
export const COMMAND_CONTRACT_VERSION = "1.0.0";
export const COMMAND_CONTRACT_ID = `urn:inari:command-contract:${COMMAND_CONTRACT_VERSION}`;
export const AGENT_INVOCATION_CONTRACT = {
    canonical: "inari",
    compatibility: "gh inari",
    direct: "gh-inari",
    fallback: "npx --yes gh-inari",
    extensionInstall: "gh extension install yohn-jp/gh-inari",
    extensionUpdate: "gh extension upgrade inari",
};
export const RUNTIME_CAPABILITIES = [
    "canonical-invocation",
    "machine-readable-version",
    "capability-diagnostics",
    "extension-bootstrap",
];
const ROOT_OPTIONS = ["help", "json"];
const ARTIFACT_OPTIONS = ["help", "json", "template", "repository"];
const LOCAL_ARTIFACT_INPUT_OPTIONS = [...ARTIFACT_OPTIONS, "from", "field", "policy"];
const EXISTING_OPTIONS = ["help", "json", "template", "repository", "policy"];
const REMEDIATION_OPTIONS = ["help", "json", "template", "repository", "policy", "from", "field", "dryRun"];
const ISSUE_CREATE_OPTIONS = ["help", "json", "template", "title", "from", "field", "repository", "policy"];
const PR_CREATE_OPTIONS = [
    "help",
    "json",
    "template",
    "title",
    "head",
    "base",
    "from",
    "field",
    "repository",
    "policy",
    "draft",
    "maintainerCanModify",
];
export const COMMAND_OPTIONS = {
    help: {
        id: "help",
        key: "help",
        aliases: ["--help"],
        valueType: "string",
        arity: "optional",
        repeatable: false,
        allowEquals: true,
        placeholder: "full|json",
        description: "Print progressive help; use --help=full for the complete reference or --help=json for discovery.",
        scopes: [],
    },
    json: {
        id: "json",
        key: "json",
        aliases: ["--json"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Emit structured JSON output.",
        scopes: [],
    },
    version: {
        id: "version",
        key: "version",
        aliases: ["--version"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Print version and runtime contract metadata.",
        scopes: ["root.version"],
    },
    diagnose: {
        id: "diagnose",
        key: "diagnose",
        aliases: ["--diagnose"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Check canonical runtime readiness and optional extension compatibility.",
        scopes: ["root.diagnose"],
    },
    doctor: {
        id: "doctor",
        key: "doctor",
        aliases: ["--doctor"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Alias for --diagnose.",
        scopes: ["root.doctor"],
    },
    from: {
        id: "from",
        key: "from",
        aliases: ["--from"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "path",
        description: "JSON input file, or - for stdin.",
        scopes: [
            "issue.validate",
            "issue.render",
            "issue.create",
            "issue.edit",
            "issue.sync",
            "pr.validate",
            "pr.render",
            "pr.create",
            "pr.edit",
            "pr.sync",
            "template.import",
        ],
    },
    field: {
        id: "field",
        key: "field",
        aliases: ["--field"],
        valueType: "field",
        arity: "required",
        repeatable: true,
        allowEquals: true,
        placeholder: "<name>=<value>",
        description: "Direct semantic field input; template-defined scalar values occur once, array/checklist values repeat as --field name=<option-id>.",
        scopes: [
            "issue.validate",
            "issue.render",
            "issue.create",
            "issue.edit",
            "issue.sync",
            "pr.validate",
            "pr.render",
            "pr.create",
            "pr.edit",
            "pr.sync",
        ],
    },
    template: {
        id: "template",
        key: "template",
        aliases: ["--template"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "template",
        description: "Repository-native template id, path, or unique name.",
        scopes: [
            "issue.schema",
            "issue.validate",
            "issue.render",
            "issue.create",
            "issue.explain",
            "issue.get",
            "issue.check",
            "issue.edit",
            "issue.normalize",
            "issue.sync",
            "pr.schema",
            "pr.validate",
            "pr.render",
            "pr.create",
            "pr.explain",
            "pr.get",
            "pr.check",
            "pr.edit",
            "pr.normalize",
            "pr.sync",
        ],
    },
    policy: {
        id: "policy",
        key: "policy",
        aliases: ["--policy"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "path",
        description: "Local PR policy for local schema/input workflows.",
        scopes: [
            "issue.schema",
            "issue.validate",
            "issue.render",
            "issue.create",
            "issue.explain",
            "issue.get",
            "issue.check",
            "issue.edit",
            "issue.normalize",
            "issue.sync",
            "pr.schema",
            "pr.validate",
            "pr.render",
            "pr.create",
            "pr.explain",
            "pr.get",
            "pr.check",
            "pr.edit",
            "pr.normalize",
            "pr.sync",
        ],
    },
    repository: {
        id: "repository",
        key: "repository",
        aliases: ["--repository", "--repo", "-R"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "repository",
        description: "GitHub repository override; governed commands use its default-branch governance.",
        scopes: [
            "issue.schema",
            "issue.validate",
            "issue.render",
            "issue.create",
            "issue.explain",
            "issue.get",
            "issue.check",
            "issue.edit",
            "issue.normalize",
            "issue.sync",
            "pr.schema",
            "pr.validate",
            "pr.render",
            "pr.create",
            "pr.explain",
            "pr.get",
            "pr.check",
            "pr.edit",
            "pr.normalize",
            "pr.sync",
            "template.list",
        ],
    },
    title: {
        id: "title",
        key: "title",
        aliases: ["--title"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "title",
        description: "Caller-supplied Issue/PR title for create or metadata patch for edit.",
        scopes: ["issue.create", "issue.edit", "pr.create", "pr.edit"],
    },
    head: {
        id: "head",
        key: "head",
        aliases: ["--head"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "branch",
        description: "PR head branch for create.",
        scopes: ["pr.create", "pr.edit"],
    },
    base: {
        id: "base",
        key: "base",
        aliases: ["--base"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "branch",
        description: "PR base branch for create or edit.",
        scopes: ["pr.create", "pr.edit"],
    },
    to: {
        id: "to",
        key: "to",
        aliases: ["--to"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "semantic-file",
        description: "Destination semantic template path for import.",
        scopes: ["template.import"],
    },
    requireCapability: {
        id: "requireCapability",
        key: "require-capability",
        aliases: ["--require-capability"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "id",
        description: "Require a capability in version/diagnose checks.",
        scopes: ["root.version", "root.diagnose", "root.doctor"],
    },
    minimumVersion: {
        id: "minimumVersion",
        key: "minimum-version",
        aliases: ["--minimum-version"],
        valueType: "string",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "v",
        description: "Require a minimum semantic version in version/diagnose checks.",
        scopes: ["root.version", "root.diagnose", "root.doctor"],
    },
    compact: {
        id: "compact",
        key: "compact",
        aliases: ["--compact"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Emit only semantic fields and constraints for schema.",
        scopes: ["issue.schema", "pr.schema"],
    },
    check: {
        id: "check",
        key: "check",
        aliases: ["--check"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Check generated native projections without writing.",
        scopes: ["template.sync"],
    },
    dryRun: {
        id: "dryRun",
        key: "dry-run",
        aliases: ["--dry-run"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Show a bounded remediation diff without mutating GitHub.",
        scopes: [
            "issue.edit",
            "issue.normalize",
            "issue.sync",
            "pr.edit",
            "pr.normalize",
            "pr.sync",
        ],
    },
    draft: {
        id: "draft",
        key: "draft",
        aliases: ["--draft"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Create the PR as a draft.",
        scopes: ["pr.create"],
    },
    maintainerCanModify: {
        id: "maintainerCanModify",
        key: "maintainer-can-modify",
        aliases: ["--maintainer-can-modify"],
        valueType: "boolean",
        arity: "none",
        repeatable: false,
        allowEquals: true,
        description: "Allow maintainer edits on the PR.",
        scopes: ["pr.create", "pr.edit"],
    },
    rawBody: {
        id: "rawBody",
        key: "body",
        aliases: ["--body", "--body-file", "-b", "-F"],
        valueType: "raw-input",
        arity: "required",
        repeatable: false,
        allowEquals: true,
        placeholder: "value",
        description: "Upstream gh raw Markdown input; rejected for governed create operations.",
        scopes: ["issue.create", "pr.create"],
    },
};
const COMMAND_OPTIONS_BY_ID = COMMAND_OPTIONS;
const command = (id, domain, operation, path, summary, optionIds, positionalSyntax, argumentExample) => ({
    id,
    domain,
    operation,
    path,
    ...(positionalSyntax === undefined ? {} : { positionalSyntax }),
    ...(argumentExample === undefined ? {} : { argumentExample }),
    summary,
    optionIds,
    passthrough: false,
});
export const INARI_COMMANDS = [
    command("root.help", "root", "help", [], "Print progressive or full command help.", [...ROOT_OPTIONS]),
    command("root.version", "root", "version", ["version"], "Print version and runtime contract metadata.", [
        "help",
        "json",
        "requireCapability",
        "minimumVersion",
    ]),
    command("root.diagnose", "root", "diagnose", ["diagnose"], "Check canonical runtime readiness and extension compatibility.", ["help", "json", "requireCapability", "minimumVersion"]),
    command("root.doctor", "root", "doctor", ["doctor"], "Alias for diagnose.", [
        "help",
        "json",
        "requireCapability",
        "minimumVersion",
    ]),
    command("issue.schema", "issue", "schema", ["issue", "schema"], "Print the selected Issue template's semantic and metadata schema.", [...ARTIFACT_OPTIONS, "compact"], "[template]"),
    command("issue.validate", "issue", "validate", ["issue", "validate"], "Validate local or existing Issue input against its selected contract.", [...LOCAL_ARTIFACT_INPUT_OPTIONS], "[<number>]"),
    command("issue.render", "issue", "render", ["issue", "render"], "Render validated Issue input into canonical Markdown.", [...LOCAL_ARTIFACT_INPUT_OPTIONS]),
    command("issue.create", "issue", "create", ["issue", "create"], "Validate, render, and create a governed Issue. Checklist fields use repeated --field name=<option-id> values projected by the selected artifact contract.", ISSUE_CREATE_OPTIONS),
    command("issue.explain", "issue", "explain", ["issue", "explain"], "Explain the governance state of an existing Issue.", [...EXISTING_OPTIONS], "<number>"),
    command("issue.get", "issue", "get", ["issue", "get"], "Project an existing Issue as canonical semantic JSON.", [...EXISTING_OPTIONS], "<number>"),
    command("issue.check", "issue", "check", ["issue", "check"], "Check whether an existing Issue is canonical and normalizable.", [...EXISTING_OPTIONS], "<number>"),
    command("issue.edit", "issue", "edit", ["issue", "edit"], "Apply a semantic or metadata patch to an existing Issue; omitted fields and metadata are preserved.", [...REMEDIATION_OPTIONS, "title"], "<number>"),
    command("issue.normalize", "issue", "normalize", ["issue", "normalize"], "Repair an existing Issue's native projection.", ["help", "json", "repository", "template", "policy", "dryRun"], "<number>"),
    command("issue.sync", "issue", "sync", ["issue", "sync"], "Reconcile an existing Issue to a desired semantic state, preserving fields and metadata omitted from the input.", [...REMEDIATION_OPTIONS], "<number>"),
    command("pr.schema", "pr", "schema", ["pr", "schema"], "Print the selected PR template's semantic and metadata schema.", [...ARTIFACT_OPTIONS, "compact"], "[template]"),
    command("pr.validate", "pr", "validate", ["pr", "validate"], "Validate local or existing PR input against its selected contract.", [...LOCAL_ARTIFACT_INPUT_OPTIONS], "[<number>]"),
    command("pr.render", "pr", "render", ["pr", "render"], "Render validated PR input into canonical Markdown.", [
        ...LOCAL_ARTIFACT_INPUT_OPTIONS,
    ]),
    command("pr.create", "pr", "create", ["pr", "create"], "Validate, render, and create a governed PR. Checklist fields use repeated --field name=<option-id> values; array fields use repeated --field name=<value> values, all projected by the selected artifact contract.", PR_CREATE_OPTIONS),
    command("pr.explain", "pr", "explain", ["pr", "explain"], "Explain the governance state of an existing PR.", [...EXISTING_OPTIONS], "<number>"),
    command("pr.get", "pr", "get", ["pr", "get"], "Project an existing PR as canonical semantic JSON.", [...EXISTING_OPTIONS], "<number>"),
    command("pr.check", "pr", "check", ["pr", "check"], "Check whether an existing PR is canonical and normalizable.", [...EXISTING_OPTIONS], "<number>"),
    command("pr.edit", "pr", "edit", ["pr", "edit"], "Apply a semantic or metadata patch to an existing PR; omitted fields and metadata are preserved. --draft is unsupported for edit and is rejected.", [...REMEDIATION_OPTIONS, "title", "base", "head", "maintainerCanModify"], "<number>"),
    command("pr.normalize", "pr", "normalize", ["pr", "normalize"], "Repair an existing PR's native projection.", ["help", "json", "repository", "template", "policy", "dryRun"], "<number>"),
    command("pr.sync", "pr", "sync", ["pr", "sync"], "Reconcile an existing PR to a desired semantic state.", [...REMEDIATION_OPTIONS], "<number>"),
    command("template.list", "template", "list", ["template", "list"], "List discovered native and semantic templates.", [
        "help",
        "json",
        "repository",
    ]),
    command("template.sync", "template", "sync", ["template", "sync"], "Regenerate native templates from semantic contracts.", ["help", "json", "check"]),
    command("template.import", "template", "import", ["template", "import"], "Import a native template into a semantic contract.", ["help", "json", "from", "to"]),
    command("skill.index", "skill", "index", ["skill"], "List bounded operational playbooks.", ["help", "json"]),
    command("skill.scenario", "skill", "scenario", ["skill"], "Print one bounded operational playbook.", ["help", "json"], "[scenario]"),
];
const commandsById = new Map(INARI_COMMANDS.map((entry) => [entry.id, entry]));
const optionsByAlias = new Map();
for (const option of Object.values(COMMAND_OPTIONS_BY_ID)) {
    for (const alias of option.aliases)
        optionsByAlias.set(alias, option);
}
export function getCommand(id) {
    const result = commandsById.get(id);
    if (result === undefined)
        throw new Error(`Unknown Inari command contract id: ${id}`);
    return result;
}
export function getCommandForPositionals(positionals) {
    if (positionals[0] === "skill" && positionals.length > 1)
        return getCommand("skill.scenario");
    const exact = INARI_COMMANDS.find((entry) => entry.path.length > 0 && entry.path.every((part, index) => positionals[index] === part));
    if (exact !== undefined)
        return exact;
    if (positionals[0] === "skill")
        return getCommand("skill.scenario");
    if (positionals.length === 0)
        return getCommand("root.help");
    return undefined;
}
export function getDomainCommands(domain) {
    return INARI_COMMANDS.filter((entry) => entry.domain === domain);
}
export function getOption(id) {
    return COMMAND_OPTIONS_BY_ID[id];
}
export function getOptionForToken(token) {
    const equalIndex = token.indexOf("=");
    const name = equalIndex < 0 ? token : token.slice(0, equalIndex);
    return optionsByAlias.get(name);
}
/**
 * Consume option values according to the canonical option table. Unknown
 * options are retained without guessing their arity, preserving passthrough
 * ownership for commands that Inari does not implement.
 */
export function tokenizeCommandArgv(argv) {
    const positionals = [];
    const options = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === undefined)
            continue;
        if (token === "--") {
            positionals.push(...argv.slice(index + 1));
            break;
        }
        if (!token.startsWith("-") || token === "-") {
            positionals.push(token);
            continue;
        }
        const definition = getOptionForToken(token);
        const equalIndex = token.indexOf("=");
        const hasEquals = equalIndex >= 0;
        const rawName = hasEquals ? token.slice(0, equalIndex) : token;
        if (definition === undefined && !token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        if (definition === undefined) {
            options.push({
                rawName,
                rawToken: token,
                hasEquals,
                ...(hasEquals ? { value: token.slice(equalIndex + 1) } : {}),
            });
            continue;
        }
        if (hasEquals) {
            options.push({ definition, rawName, rawToken: token, value: token.slice(equalIndex + 1), hasEquals });
            continue;
        }
        const next = argv[index + 1];
        if (definition.arity === "required" && next !== undefined && !next.startsWith("--")) {
            index += 1;
            options.push({ definition, rawName, rawToken: token, value: next, hasEquals });
            continue;
        }
        options.push({ definition, rawName, rawToken: token, hasEquals });
    }
    return { positionals, options };
}
export function commandSupportsOption(commandId, optionId) {
    return getCommand(commandId).optionIds.includes(optionId);
}
export function optionSyntax(option, repeatable = option.repeatable) {
    const name = option.aliases[0] ?? `--${option.key}`;
    if (option.arity === "none")
        return name;
    if (option.arity === "optional")
        return `${name}[=${option.placeholder ?? "value"}]`;
    const placeholder = option.placeholder ?? "value";
    return `${name} ${placeholder.startsWith("<") || placeholder.includes("<") ? placeholder : `<${placeholder}>`}${repeatable ? " ..." : ""}`;
}
export function commandInvocation(id) {
    const definition = getCommand(id);
    return [AGENT_INVOCATION_CONTRACT.canonical, ...definition.path].join(" ");
}
export function commandExample(id) {
    const definition = getCommand(id);
    const argument = definition.argumentExample ?? definition.positionalSyntax;
    const suffix = argument === undefined || argument.startsWith("[") ? "" : ` ${argument}`;
    return `${commandInvocation(id)}${suffix}`;
}
export function commandUsageInvocation(id) {
    return `${AGENT_INVOCATION_CONTRACT.canonical} ${commandUsage(getCommand(id))}`;
}
/** Minimal executable create guidance, projected from the create option definitions. */
export function commandRecoveryInvocation(id) {
    const optionIds = id === "issue.create" ? ["template", "title", "field"] : ["template", "title", "head", "base", "field"];
    const parts = optionIds.map((optionId) => {
        const option = getOption(optionId);
        if (optionId === "title")
            return `${option.aliases[0]} "<title>"`;
        return optionSyntax(option, false);
    });
    return `${commandInvocation(id)} ${parts.join(" ")}`;
}
export function commandTemplateSchemaInvocation(domain) {
    const id = domain === "issue" ? "issue.schema" : "pr.schema";
    return `${commandInvocation(id)} <template>`;
}
export function helpInvocation(domain) {
    return `${AGENT_INVOCATION_CONTRACT.canonical} ${domain} --help`;
}
function projectOption(option) {
    return {
        id: option.id,
        key: option.key,
        aliases: option.aliases,
        type: option.valueType,
        arity: option.arity,
        repeatable: option.repeatable,
        syntax: optionSyntax(option),
        description: option.description,
    };
}
function projectCommand(entry) {
    return {
        id: entry.id,
        domain: entry.domain,
        operation: entry.operation,
        path: entry.path,
        invocation: commandInvocation(entry.id),
        example: commandExample(entry.id),
        summary: entry.summary,
        options: entry.optionIds.map((id) => projectOption(getOption(id))),
    };
}
/** Full machine-readable command discovery projection. */
export function projectCommandContract() {
    return {
        id: COMMAND_CONTRACT_ID,
        version: COMMAND_CONTRACT_VERSION,
        invocation: AGENT_INVOCATION_CONTRACT,
        capabilities: RUNTIME_CAPABILITIES,
        commands: INARI_COMMANDS.map(projectCommand),
    };
}
/** Machine projection for a command-depth help request. */
export function projectCommandHelp(positionals) {
    const full = projectCommandContract();
    if (positionals.length === 0)
        return full;
    const commandId = getCommandForPositionals(positionals)?.id;
    if (commandId !== undefined && positionals.length >= 2) {
        return { ...full, commands: full.commands.filter((entry) => entry.id === commandId) };
    }
    const domain = positionals[0];
    if (domain === "issue" || domain === "pr") {
        return { ...full, commands: full.commands.filter((entry) => entry.domain === domain) };
    }
    if (domain === "template")
        return { ...full, commands: full.commands.filter((entry) => entry.domain === "template") };
    if (domain === "skill")
        return { ...full, commands: full.commands.filter((entry) => entry.domain === "skill") };
    return commandId === undefined
        ? { ...full, commands: [] }
        : { ...full, commands: full.commands.filter((entry) => entry.id === commandId) };
}
export function commandUsage(entry) {
    const positionals = entry.positionalSyntax === undefined ? "" : ` ${entry.positionalSyntax}`;
    const options = entry.optionIds
        .filter((id) => id !== "help" && id !== "json")
        .map((id) => {
        const option = getOption(id);
        const required = ((entry.id === "issue.create" || entry.id === "pr.create") &&
            (id === "template" || id === "title" || (entry.id === "pr.create" && (id === "head" || id === "base")))) ||
            (entry.id === "template.import" && id === "from");
        const syntax = optionSyntax(option);
        return required ? syntax : `[${syntax}]`;
    })
        .join(" ");
    return `${entry.path.join(" ")}${positionals}${options === "" ? "" : ` ${options}`}`;
}
function assertCommandContract() {
    const ids = new Set();
    for (const entry of INARI_COMMANDS) {
        if (ids.has(entry.id))
            throw new Error(`Duplicate command contract id: ${entry.id}`);
        ids.add(entry.id);
        for (const optionId of entry.optionIds) {
            const option = getOption(optionId);
            if (option.scopes.length > 0 && !option.scopes.includes(entry.id) && optionId !== "help" && optionId !== "json") {
                throw new Error(`Command ${entry.id} advertises option ${optionId} outside its option scope.`);
            }
        }
    }
}
assertCommandContract();
//# sourceMappingURL=command-contract.js.map