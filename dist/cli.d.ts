import { type CliDependencies as CoreCliDependencies } from "./cli-core.js";
interface DiagnosticCommandResult {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: string;
}
export interface CliDependencies extends CoreCliDependencies {
    /** Test seam for probing the canonical `inari` executable independently from `gh inari`. */
    readonly runCanonicalDiagnosticCommand?: (args: readonly string[]) => DiagnosticCommandResult;
}
/**
 * Public CLI entrypoint. Diagnostics first prove that the canonical `inari`
 * executable itself is reachable and reports the expected contract; all other
 * behavior remains delegated to the governed CLI core.
 */
export declare function runCli(argv: string[], dependencies?: CliDependencies): Promise<number>;
export {};
