import type { SemanticTemplateIdentity } from "./semantic-template.js";
import type { TemplateIdentity, TemplateSelector } from "./template-discovery.js";
export declare const TEMPLATE_RESOLUTION_CONFIG_PATH: ".github/inari/template-resolution.yml";
export declare const TEMPLATE_RESOLUTION_CONFIG_VERSION: 1;
export type TemplateResolutionDomain = "issue" | "pr";
export interface TemplateResolutionCandidate<T = unknown> {
    readonly id: string;
    readonly kind: TemplateResolutionDomain;
    readonly name: string;
    readonly paths: readonly string[];
    readonly type?: string;
    readonly nameAliases?: readonly string[];
    readonly value: T;
}
export interface TemplateChoice {
    readonly id: string;
    readonly kind: TemplateResolutionDomain;
    readonly name: string;
    readonly paths: readonly string[];
    readonly type?: string;
}
export interface TemplateSelectionPrompt {
    readonly kind: "multiple-candidates";
    readonly candidates: readonly TemplateChoice[];
}
export interface TemplateResolverDependencies {
    /** Test seam for interactive execution; production defaults to stdin/stdout TTY detection. */
    readonly isInteractive?: () => boolean;
    /** Test seam for selection; return a candidate id/path/name or a 1-based choice number. */
    readonly select?: (prompt: TemplateSelectionPrompt) => string | number | Promise<string | number>;
}
export interface ResolveTemplateRequest<T> {
    readonly candidates: readonly TemplateResolutionCandidate<T>[];
    readonly selector?: string | TemplateSelector;
    readonly configuredDefault?: string | TemplateSelector;
    readonly dependencies?: TemplateResolverDependencies;
}
export interface TemplateResolutionErrorDetails {
    readonly selector?: string | TemplateSelector;
    readonly configuredDefault?: string | TemplateSelector;
    readonly candidates: readonly string[];
    readonly candidateCount: number;
    readonly candidatesTruncated: boolean;
    readonly match?: "id" | "path" | "name" | "selector" | "none";
    readonly reason?: string;
    readonly recovery: readonly TemplateResolutionRecovery[];
}
export interface TemplateResolutionRecovery {
    readonly action: "provide-explicit-selector" | "use-interactive-selection";
    readonly option: "--template";
    readonly guidance: string;
}
export type TemplateResolutionErrorCode = "TEMPLATE_CONFIG_INVALID" | "TEMPLATE_CONFIG_UNAVAILABLE" | "TEMPLATE_RESOLUTION_NO_CANDIDATES" | "TEMPLATE_RESOLUTION_SELECTOR_NOT_FOUND" | "TEMPLATE_RESOLUTION_SELECTOR_AMBIGUOUS" | "TEMPLATE_RESOLUTION_DEFAULT_INVALID" | "TEMPLATE_RESOLUTION_DEFAULT_UNAVAILABLE" | "TEMPLATE_RESOLUTION_DEFAULT_AMBIGUOUS" | "TEMPLATE_RESOLUTION_AMBIGUOUS" | "TEMPLATE_RESOLUTION_INTERACTION_FAILED";
export declare class TemplateResolutionError extends Error {
    readonly code: TemplateResolutionErrorCode;
    readonly details: TemplateResolutionErrorDetails;
    constructor(code: TemplateResolutionErrorCode, message: string, details: TemplateResolutionErrorDetails);
    toJSON(): {
        code: TemplateResolutionErrorCode;
        message: string;
        details: TemplateResolutionErrorDetails;
    };
}
export interface TemplateResolutionConfig {
    readonly version: typeof TEMPLATE_RESOLUTION_CONFIG_VERSION;
    readonly defaults: Readonly<Partial<Record<TemplateResolutionDomain, string | TemplateSelector>>>;
}
export declare function nativeTemplateResolutionCandidate(identity: TemplateIdentity): TemplateResolutionCandidate<TemplateIdentity>;
export declare function semanticTemplateResolutionCandidate(identity: SemanticTemplateIdentity): TemplateResolutionCandidate<SemanticTemplateIdentity>;
/** Resolve the same precedence asynchronously for CLI and repository-backed callers. */
export declare function resolveTemplate<T>(request: ResolveTemplateRequest<T>): Promise<T>;
/** Synchronous counterpart for compatibility APIs that cannot provide interactive input. */
export declare function resolveTemplateSync<T>(request: ResolveTemplateRequest<T>): T;
export declare function readTemplateResolutionConfig(repositoryRoot: string): Promise<TemplateResolutionConfig | undefined>;
export declare function parseTemplateResolutionConfig(source: string, sourcePath?: string): TemplateResolutionConfig;
export declare function isTemplateSelectorValue(value: unknown): value is TemplateSelector;
