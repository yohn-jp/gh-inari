/**
 * The versioned authority for the command surface owned by Inari.
 *
 * This module intentionally describes CLI commands and option mechanics only.
 * Repository/template fields are selected from an artifact contract at runtime
 * and must not be copied into this static model.
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
    /** Canonical long spelling, without the leading dashes. */
    readonly key: string;
    readonly aliases: readonly string[];
    readonly valueType: OptionValueType;
    readonly arity: OptionArity;
    readonly repeatable: boolean;
    readonly allowEquals: boolean;
    readonly placeholder?: string;
    readonly description: string;
    /** Commands on which the option has Inari-owned semantics. */
    readonly scopes: readonly CommandId[];
}
export interface CommandDefinition {
    readonly id: CommandId;
    readonly domain: CommandDomain;
    readonly operation: string;
    /** Positional command identity, excluding option values. */
    readonly path: readonly string[];
    /** Positional suffix used by the short/full help projection. */
    readonly positionalSyntax?: string;
    /** Concrete placeholder form used in recovery and workflow examples. */
    readonly argumentExample?: string;
    readonly summary: string;
    readonly optionIds: readonly OptionId[];
    readonly passthrough: boolean;
}
export declare const COMMAND_OPTIONS: {
    help: {
        id: "help";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "optional";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    json: {
        id: "json";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    version: {
        id: "version";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    diagnose: {
        id: "diagnose";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    doctor: {
        id: "doctor";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    from: {
        id: "from";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    field: {
        id: "field";
        key: string;
        aliases: string[];
        valueType: "field";
        arity: "required";
        repeatable: true;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    template: {
        id: "template";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    policy: {
        id: "policy";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    repository: {
        id: "repository";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    title: {
        id: "title";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    head: {
        id: "head";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    base: {
        id: "base";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    to: {
        id: "to";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    requireCapability: {
        id: "requireCapability";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    minimumVersion: {
        id: "minimumVersion";
        key: string;
        aliases: string[];
        valueType: "string";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
    compact: {
        id: "compact";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    check: {
        id: "check";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    dryRun: {
        id: "dryRun";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    draft: {
        id: "draft";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    maintainerCanModify: {
        id: "maintainerCanModify";
        key: string;
        aliases: string[];
        valueType: "boolean";
        arity: "none";
        repeatable: false;
        allowEquals: true;
        description: string;
        scopes: readonly CommandId[];
    };
    rawBody: {
        id: "rawBody";
        key: string;
        aliases: string[];
        valueType: "raw-input";
        arity: "required";
        repeatable: false;
        allowEquals: true;
        placeholder: string;
        description: string;
        scopes: readonly CommandId[];
    };
};
export declare const INARI_COMMANDS: readonly CommandDefinition[];
export declare function getCommand(id: CommandId): CommandDefinition;
export declare function getCommandForPositionals(positionals: readonly string[]): CommandDefinition | undefined;
export declare function getDomainCommands(domain: Exclude<CommandDomain, "root" | "skill">): readonly CommandDefinition[];
export declare function getOption(id: OptionId): CommandOptionDefinition;
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
/**
 * Consume option values according to the canonical option table. Unknown
 * options are retained without guessing their arity, preserving passthrough
 * ownership for commands that Inari does not implement.
 */
export declare function tokenizeCommandArgv(argv: readonly string[]): TokenizedArgv;
export declare function commandSupportsOption(commandId: CommandId, optionId: OptionId): boolean;
export declare function optionSyntax(option: CommandOptionDefinition, repeatable?: boolean): string;
export declare function commandInvocation(id: CommandId): string;
export declare function commandExample(id: CommandId): string;
export declare function commandUsageInvocation(id: CommandId): string;
/** Minimal executable create guidance, projected from the create option definitions. */
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
/** Full machine-readable command discovery projection. */
export declare function projectCommandContract(): CommandContractProjection;
/** Machine projection for a command-depth help request. */
export declare function projectCommandHelp(positionals: readonly string[]): CommandContractProjection;
export declare function commandUsage(entry: CommandDefinition): string;
