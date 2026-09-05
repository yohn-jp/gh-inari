import { type CommandDomain, type CommandId } from "./command-contract.js";
/** Inari-owned operational playbooks mapping task intents to canonical CLI workflows. */
export declare const SKILL_MODEL_VERSION = "1.1.0";
/** Hard cap on any single rendered skill output (index or scenario, text or JSON). */
export declare const MAX_SKILL_OUTPUT_BYTES = 4096;
export interface SkillWorkflowStep {
    readonly summary: string;
    /** Stable reference into the versioned command contract. */
    readonly commandId: CommandId;
    /** Backward-compatible rendered command projection. */
    readonly command: string;
}
export interface SkillScenario {
    readonly id: string;
    readonly title: string;
    readonly whenToUse: string;
    readonly workflow: readonly SkillWorkflowStep[];
    readonly invariants: readonly string[];
    readonly canonicalCommandId: CommandId;
    readonly helpDomain: Exclude<CommandDomain, "root">;
    readonly canonicalEntrypoint: string;
    readonly helpPointer: string;
}
export declare const SKILL_SCENARIOS: readonly SkillScenario[];
export declare function findSkillScenario(id: string): SkillScenario | undefined;
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
    readonly invariants: readonly string[];
    readonly canonicalCommandId: CommandId;
    readonly helpDomain: Exclude<CommandDomain, "root">;
    readonly canonicalEntrypoint: string;
    readonly helpPointer: string;
}
export declare function projectSkillIndexToJson(): SkillIndexProjection;
export declare function projectSkillIndexToText(): string;
export declare function projectSkillScenarioToJson(scenario: SkillScenario): SkillScenarioProjection;
export declare function projectSkillScenarioToText(scenario: SkillScenario): string;
