import { GitHubAdapter } from "./github/index.js";
import type { TemplateResolverDependencies } from "./template-resolver.js";
interface PackageMetadata {
    readonly name: string;
    readonly version: string;
    readonly description: string;
}
interface DiagnosticCommandResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: string;
}
export interface CliDependencies {
    readonly repositoryRoot?: string;
    readonly createAdapter?: (options: ConstructorParameters<typeof GitHubAdapter>[0]) => GitHubAdapter;
    readonly packageMetadata?: PackageMetadata;
    readonly runDiagnosticCommand?: (args: readonly string[]) => DiagnosticCommandResult;
    readonly runGhFallback?: (argv: readonly string[]) => number;
    readonly templateResolver?: TemplateResolverDependencies;
}
/** The installed gh-inari executable entrypoint. */
export declare function runCli(argv: string[], dependencies?: CliDependencies): Promise<number>;
export {};
