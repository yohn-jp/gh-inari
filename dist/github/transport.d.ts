export interface GhCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly signal?: NodeJS.Signals;
}
export type GhOutputStream = "stdout" | "stderr";
export interface GhTransportOutputLimits {
    readonly stdout: number;
    readonly stderr: number;
}
export interface GhTransportOptions {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    /** Maximum UTF-8 byte count captured from stdout for this invocation. */
    readonly maxStdoutBytes?: number;
    /** Maximum UTF-8 byte count captured from stderr for this invocation. */
    readonly maxStderrBytes?: number;
}
/** Every ProcessGhTransport invocation is bounded, including calls without explicit options. */
export declare const DEFAULT_GH_OUTPUT_LIMITS_BYTES: Readonly<GhTransportOutputLimits>;
/** Raised when a gh invocation is killed for exceeding its bounded timeout. Never resolves as a command result. */
export declare class GhTransportTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
/** Raised when a gh invocation is killed after exceeding a per-stream byte bound. */
export declare class GhTransportOutputLimitError extends Error {
    readonly code = "GH_OUTPUT_LIMIT_EXCEEDED";
    readonly stream: GhOutputStream;
    readonly limitBytes: number;
    readonly outputBytes: number;
    constructor(stream: GhOutputStream, limitBytes: number, outputBytes: number);
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
