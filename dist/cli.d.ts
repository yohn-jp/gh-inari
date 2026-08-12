import { GitHubAdapter } from "./github/index.js";
interface PackageMetadata {
    readonly name: string;
    readonly version: string;
    readonly description: string;
}
export interface CliDependencies {
    readonly repositoryRoot?: string;
    readonly createAdapter?: (options: ConstructorParameters<typeof GitHubAdapter>[0]) => GitHubAdapter;
    readonly packageMetadata?: PackageMetadata;
}
/** The installed gh-inari executable entrypoint. */
export declare function runCli(argv: string[], dependencies?: CliDependencies): Promise<number>;
export {};
