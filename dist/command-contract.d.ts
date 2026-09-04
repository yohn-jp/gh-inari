/**
 * The versioned authority for the command surface owned by Inari.
 *
 * Command definitions own option applicability. Option definitions describe
 * option mechanics only; inverse option scopes are derived from commands so
 * the command surface has one authority.
 */
export declare const COMMAND_CONTRACT_VERSION: "1.0.0";
export declare const COMMAND_CONTRACT_ID: "urn:inari:command-contract:1.0.0";
export declare const AGENT_INVOCATION_CONTRACT: {
    readonly canonical: "inari";
    readonly compatibility: "gh inari";
    readonly direct: "gh-inari";
    readonly fallback: "npx --yes gh-inari";
    readonly extensionInstall: "gh extension install yohn-jp/gh-inari";
    readonly extensionUpdate: "gh extension upgrade inari";
};
export declare const RUNTIME_CAPABILITIES: readonly ["canonical-invocation", "machine-readable-version", "capability-diagnostics", "extension-bootstrap"];
export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];
export type CommandDomain = "root" | "issue" | "pr" | "template" | "skill";
export type OptionValueType = "boolean" | "string" | "field" | "raw-input";
export type OptionArity = "none" | "required" | "optional";
export type CommandId = "root.help" | "root.version" | "root.diagnose" | "root.doctor" | "issue.schema" | "issue.validate" | "issue.render" | "issue.create" | "issue.explain" | "issue.get" | "issue.check" | "issue.edit" | "issue.normalize" | "issue.sync" | "pr.schema" | "pr.validate" | "pr.render" | "pr.create" | "pr.explain" | "pr.get" | "pr.check" | "pr.edit" | "pr.normalize" | "pr.sync" | "template.list" | "template.sync" | "template.import" | "skill.index" | "skill.scenario";
export type OptionId = "help" | "json" | "version" | "diagnose" | "doctor" | "from" | "field" | "template" | "policy" | "repository" | "title" | "head" | "base" | "to" | "requireCapability" | "minimumVersion" | "compact" | "check" | "dryRun" | "draft" | "maintainerCanModify" | "rawBody";
export interface CommandOptionDefinition {
    readonly id: OptionId;
    readonly key: string;
    readonly aliases: readonly string[];
    readonly valueType: OptionValueType;
    readonly arity: OptionArity;
    readonly repeatable: boolean;
    readonly allowEquals: boolean;
    readonly placeholder?: string;
    readonly description: string;
}
export interface CommandDefinition {
    readonly id: CommandId;
    readonly domain: CommandDomain;
    readonly operation: string;
    readonly path: readonly string[];
    readonly positionalSyntax?: string;
    readonly argumentExample?: string;
    readonly summary: string;
    readonly optionIds: readonly OptionId[];
    readonly passthrough: boolean;
}
export declare const COMMAND_OPTIONS: {
    help: CommandOptionDefinition;
    json: CommandOptionDefinition;
    version: CommandOptionDefinition;
    diagnose: CommandOptionDefinition;
    doctor: CommandOptionDefinition;
    from: CommandOptionDefinition;
    field: CommandOptionDefinition;
    template: CommandOptionDefinition;
    policy: CommandOptionDefinition;
    repository: CommandOptionDefinition;
    title: CommandOptionDefinition;
    head: CommandOptionDefinition;
    base: CommandOptionDefinition;
    to: CommandOptionDefinition;
    requireCapability: CommandOptionDefinition;
    minimumVersion: CommandOptionDefinition;
    compact: CommandOptionDefinition;
    check: CommandOptionDefinition;
    dryRun: CommandOptionDefinition;
    draft: CommandOptionDefinition;
    maintainerCanModify: CommandOptionDefinition;
    rawBody: CommandOptionDefinition;
};
export declare const INARI_COMMANDS: readonly CommandDefinition[];
export declare function getCommand(id: CommandId): CommandDefinition;
export declare function getCommandForPositionals(positionals: readonly string[]): CommandDefinition | undefined;
export declare function getDomainCommands(domain: Exclude<CommandDomain, "root" | "skill">): readonly CommandDefinition[];
export declare function getOption(id: OptionId): CommandOptionDefinition;
/** Derived inverse of CommandDefinition.optionIds; never hand-maintained. */
export declare function getOptionScopes(id: OptionId): readonly CommandId[];
export declare function getOptionForToken(token: string): CommandOptionDefinition | undefined;
export interface TokenizedOption {
    readonly definition?: CommandOptionDefinition;
    readonly rawName: string;
    readonly rawToken: string;
    readonly value?: string;
    readonly hasEquals: boolean;
}
export interface TokenizedArgv {
    readonly positionals: readonly string[];
    readonly options: readonly TokenizedOption[];
}
export declare function tokenizeCommandArgv(argv: readonly string[]): TokenizedArgv;
export declare function commandSupportsOption(commandId: CommandId, optionId: OptionId): boolean;
export declare function optionSyntax(optionDefinition: CommandOptionDefinition, repeatable?: boolean): string;
export declare function commandInvocation(id: CommandId): string;
export declare function commandExample(id: CommandId): string;
export declare function commandUsageInvocation(id: CommandId): string;
export declare function commandRecoveryInvocation(id: "issue.create" | "pr.create"): string;
export declare function commandTemplateSchemaInvocation(domain: "issue" | "pr"): string;
export declare function helpInvocation(domain: "issue" | "pr" | "template" | "skill"): string;
export interface CommandDiscoveryOption {
    readonly id: OptionId;
    readonly key: string;
    readonly aliases: readonly string[];
    readonly type: OptionValueType;
    readonly arity: OptionArity;
    readonly repeatable: boolean;
    readonly syntax: string;
    readonly description: string;
}
export interface CommandDiscoveryEntry {
    readonly id: CommandId;
    readonly domain: CommandDomain;
    readonly operation: string;
    readonly path: readonly string[];
    readonly invocation: string;
    readonly example: string;
    readonly summary: string;
    readonly options: readonly CommandDiscoveryOption[];
}
export interface CommandContractProjection {
    readonly id: typeof COMMAND_CONTRACT_ID;
    readonly version: typeof COMMAND_CONTRACT_VERSION;
    readonly invocation: typeof AGENT_INVOCATION_CONTRACT;
    readonly capabilities: readonly RuntimeCapability[];
    readonly commands: readonly CommandDiscoveryEntry[];
}
export declare function projectCommandContract(): CommandContractProjection;
export declare function projectCommandHelp(positionals: readonly string[]): CommandContractProjection;
export declare function commandUsage(entry: CommandDefinition): string;
