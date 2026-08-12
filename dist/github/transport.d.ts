export interface GhCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly signal?: NodeJS.Signals;
}
export interface GhTransportOptions {
    readonly cwd?: string;
    readonly timeoutMs?: number;
}
/** Raised when a gh invocation is killed for exceeding its bounded timeout. Never resolves as a command result. */
export declare class GhTransportTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
/** The adapter's only credential boundary: execute the user's existing gh CLI. */
export interface GhTransport {
    run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult>;
}
export declare class ProcessGhTransport implements GhTransport {
    readonly executable: string;
    constructor(executable?: string);
    run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult>;
}
