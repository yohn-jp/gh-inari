/**
 * The versioned authority for the command surface owned by Inari.
 *
 * Command definitions own option applicability. Option definitions describe
 * option mechanics only; inverse option scopes are derived from commands so
 * the command surface has one authority.
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
const option = (id, key, aliases, valueType, arity, description, placeholder, repeatable = false) => ({
    id,
    key,
    aliases,
    valueType,
    arity,
    repeatable,
    allowEquals: true,
    ...(placeholder === undefined ? {} : { placeholder }),
    description,
});
export const COMMAND_OPTIONS = {
    help: option("help", "help", ["--help"], "string", "optional", "Print progressive help; use --help=full for the complete reference or --help=json for discovery.", "full|json"),
    json: option("json", "json", ["--json"], "boolean", "none", "Emit structured JSON output."),
    version: option("version", "version", ["--version"], "boolean", "none", "Print version and runtime contract metadata."),
    diagnose: option("diagnose", "diagnose", ["--diagnose"], "boolean", "none", "Check canonical runtime readiness and optional extension compatibility."),
    doctor: option("doctor", "doctor", ["--doctor"], "boolean", "none", "Alias for --diagnose."),
    from: option("from", "from", ["--from"], "string", "required", "JSON input file, or - for stdin.", "path"),
    field: option("field", "field", ["--field"], "field", "required", "Direct semantic field input; scalar values occur once, generic array values repeat as --field name=<value>, and checklist values repeat as --field name=<option-id>. Exact field semantics come from the selected artifact contract.", "<name>=<value>", true),
    template: option("template", "template", ["--template"], "string", "required", "Repository-native template id, path, or unique name.", "template"),
    policy: option("policy", "policy", ["--policy"], "string", "required", "Local PR policy for local schema/input workflows.", "path"),
    repository: option("repository", "repository", ["--repository", "--repo", "-R"], "string", "required", "GitHub repository override; governed commands use its default-branch governance.", "repository"),
    title: option("title", "title", ["--title"], "string", "required", "Caller-supplied Issue/PR title for create or metadata patch for edit.", "title"),
    head: option("head", "head", ["--head"], "string", "required", "PR head branch for create.", "branch"),
    base: option("base", "base", ["--base"], "string", "required", "PR base branch for create or edit.", "branch"),
    to: option("to", "to", ["--to"], "string", "required", "Destination semantic template path for import.", "semantic-file"),
    requireCapability: option("requireCapability", "require-capability", ["--require-capability"], "string", "required", "Require a capability in version/diagnose checks.", "id"),
    minimumVersion: option("minimumVersion", "minimum-version", ["--minimum-version"], "string", "required", "Require a minimum semantic version in version/diagnose checks.", "v"),
    compact: option("compact", "compact", ["--compact"], "boolean", "none", "Emit only semantic fields and constraints for schema."),
    check: option("check", "check", ["--check"], "boolean", "none", "Check generated native projections without writing."),
    dryRun: option("dryRun", "dry-run", ["--dry-run"], "boolean", "none", "Show a bounded remediation diff without mutating GitHub."),
    draft: option("draft", "draft", ["--draft"], "boolean", "none", "Create the PR as a draft."),
    maintainerCanModify: option("maintainerCanModify", "maintainer-can-modify", ["--maintainer-can-modify"], "boolean", "none", "Allow maintainer edits on the PR."),
    rawBody: option("rawBody", "body", ["--body", "--body-file", "-b", "-F"], "raw-input", "required", "Upstream gh raw Markdown input; rejected for governed create operations.", "value"),
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
    command("issue.create", "issue", "create", ["issue", "create"], "Validate, render, and create a governed Issue.", ISSUE_CREATE_OPTIONS),
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
    command("pr.create", "pr", "create", ["pr", "create"], "Validate, render, and create a governed PR.", PR_CREATE_OPTIONS),
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
for (const optionDefinition of Object.values(COMMAND_OPTIONS_BY_ID)) {
    for (const alias of optionDefinition.aliases)
        optionsByAlias.set(alias, optionDefinition);
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
        return getCommand("skill.index");
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
/** Derived inverse of CommandDefinition.optionIds; never hand-maintained. */
export function getOptionScopes(id) {
    return INARI_COMMANDS.filter((entry) => entry.optionIds.includes(id)).map((entry) => entry.id);
}
export function getOptionForToken(token) {
    const equalIndex = token.indexOf("=");
    const name = equalIndex < 0 ? token : token.slice(0, equalIndex);
    return optionsByAlias.get(name);
}
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
export function optionSyntax(optionDefinition, repeatable = optionDefinition.repeatable) {
    const name = optionDefinition.aliases[0] ?? `--${optionDefinition.key}`;
    if (optionDefinition.arity === "none")
        return name;
    if (optionDefinition.arity === "optional")
        return `${name}[=${optionDefinition.placeholder ?? "value"}]`;
    const placeholder = optionDefinition.placeholder ?? "value";
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
export function commandRecoveryInvocation(id) {
    const optionIds = id === "issue.create" ? ["template", "title", "field"] : ["template", "title", "head", "base", "field"];
    const parts = optionIds.map((optionId) => {
        const optionDefinition = getOption(optionId);
        if (optionId === "title")
            return `${optionDefinition.aliases[0]} "<title>"`;
        return optionSyntax(optionDefinition, false);
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
function projectOption(optionDefinition) {
    return {
        id: optionDefinition.id,
        key: optionDefinition.key,
        aliases: optionDefinition.aliases,
        type: optionDefinition.valueType,
        arity: optionDefinition.arity,
        repeatable: optionDefinition.repeatable,
        syntax: optionSyntax(optionDefinition),
        description: optionDefinition.description,
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
export function projectCommandContract() {
    return {
        id: COMMAND_CONTRACT_ID,
        version: COMMAND_CONTRACT_VERSION,
        invocation: AGENT_INVOCATION_CONTRACT,
        capabilities: RUNTIME_CAPABILITIES,
        commands: INARI_COMMANDS.map(projectCommand),
    };
}
export function projectCommandHelp(positionals) {
    const full = projectCommandContract();
    if (positionals.length === 0)
        return full;
    const commandId = getCommandForPositionals(positionals)?.id;
    if (commandId !== undefined && positionals.length >= 2) {
        return { ...full, commands: full.commands.filter((entry) => entry.id === commandId) };
    }
    const domain = positionals[0];
    if (domain === "issue" || domain === "pr")
        return { ...full, commands: full.commands.filter((entry) => entry.domain === domain) };
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
        const optionDefinition = getOption(id);
        const required = ((entry.id === "issue.create" || entry.id === "pr.create") &&
            (id === "template" || id === "title" || (entry.id === "pr.create" && (id === "head" || id === "base")))) ||
            (entry.id === "template.import" && id === "from");
        const syntax = optionSyntax(optionDefinition);
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
        for (const optionId of entry.optionIds)
            getOption(optionId);
    }
}
assertCommandContract();
//# sourceMappingURL=command-contract.js.map