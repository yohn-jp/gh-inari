import { spawn } from "node:child_process";
/** Every ProcessGhTransport invocation is bounded, including calls without explicit options. */
export const DEFAULT_GH_OUTPUT_LIMITS_BYTES = Object.freeze({
    stdout: 1_048_576,
    stderr: 1_048_576,
});
/** Raised when a gh invocation is killed for exceeding its bounded timeout. Never resolves as a command result. */
export class GhTransportTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`gh transport exceeded its bounded timeout of ${timeoutMs}ms.`);
        this.name = "GhTransportTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}
/** Raised when a gh invocation is killed after exceeding a per-stream byte bound. */
export class GhTransportOutputLimitError extends Error {
    code = "GH_OUTPUT_LIMIT_EXCEEDED";
    stream;
    limitBytes;
    outputBytes;
    constructor(stream, limitBytes, outputBytes) {
        super(`gh transport exceeded its ${stream} output limit of ${limitBytes} bytes.`);
        this.name = "GhTransportOutputLimitError";
        this.stream = stream;
        this.limitBytes = limitBytes;
        this.outputBytes = outputBytes;
    }
}
/** Grace period after SIGTERM before escalating to SIGKILL for an unresponsive child process. */
const FORCE_KILL_GRACE_MS = 2000;
function validateByteLimit(value, optionName) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${optionName} must be a finite non-negative integer, got ${value}.`);
    }
    return value;
}
export class ProcessGhTransport {
    executable;
    constructor(executable = "gh") {
        this.executable = executable;
    }
    run(args, options = {}) {
        return new Promise((resolve, reject) => {
            const maxStdoutBytes = validateByteLimit(options.maxStdoutBytes ?? DEFAULT_GH_OUTPUT_LIMITS_BYTES.stdout, "maxStdoutBytes");
            const maxStderrBytes = validateByteLimit(options.maxStderrBytes ?? DEFAULT_GH_OUTPUT_LIMITS_BYTES.stderr, "maxStderrBytes");
            let child;
            try {
                child = spawn(this.executable, [...args], {
                    cwd: options.cwd,
                    stdio: ["ignore", "pipe", "pipe"],
                });
            }
            catch (error) {
                reject(error);
                return;
            }
            if (child.stdout === null || child.stderr === null) {
                reject(new Error("gh transport did not provide stdout and stderr pipes"));
                return;
            }
            const stdoutChunks = [];
            const stderrChunks = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let termination;
            let settled = false;
            let timer;
            let killTimer;
            const clearTimers = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
                if (killTimer !== undefined)
                    clearTimeout(killTimer);
            };
            const terminate = () => {
                child.kill("SIGTERM");
                killTimer = setTimeout(() => {
                    child.kill("SIGKILL");
                }, FORCE_KILL_GRACE_MS);
                killTimer.unref();
            };
            const capture = (stream, chunk) => {
                if (settled || termination !== undefined)
                    return;
                const outputBytes = stream === "stdout" ? stdoutBytes + chunk.byteLength : stderrBytes + chunk.byteLength;
                const limitBytes = stream === "stdout" ? maxStdoutBytes : maxStderrBytes;
                if (outputBytes > limitBytes) {
                    termination = {
                        kind: "output-limit",
                        error: new GhTransportOutputLimitError(stream, limitBytes, outputBytes),
                    };
                    terminate();
                    return;
                }
                if (stream === "stdout") {
                    stdoutBytes = outputBytes;
                    stdoutChunks.push(chunk);
                }
                else {
                    stderrBytes = outputBytes;
                    stderrChunks.push(chunk);
                }
            };
            child.stdout.on("data", (chunk) => {
                capture("stdout", chunk);
            });
            child.stderr.on("data", (chunk) => {
                capture("stderr", chunk);
            });
            child.once("error", (error) => {
                if (settled)
                    return;
                if (termination !== undefined)
                    return;
                settled = true;
                clearTimers();
                reject(error);
            });
            if (options.timeoutMs !== undefined) {
                const timeoutMs = options.timeoutMs;
                if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                    settled = true;
                    reject(new RangeError(`gh transport timeoutMs must be a finite number greater than zero, got ${timeoutMs}.`));
                    child.kill("SIGKILL");
                    return;
                }
                timer = setTimeout(() => {
                    if (termination !== undefined)
                        return;
                    termination = { kind: "timeout", timeoutMs };
                    terminate();
                }, timeoutMs);
                timer.unref();
            }
            child.once("close", (exitCode, signal) => {
                if (settled)
                    return;
                settled = true;
                clearTimers();
                if (termination?.kind === "output-limit") {
                    reject(termination.error);
                    return;
                }
                if (termination?.kind === "timeout") {
                    reject(new GhTransportTimeoutError(termination.timeoutMs));
                    return;
                }
                resolve({
                    exitCode: exitCode ?? 1,
                    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                    stderr: Buffer.concat(stderrChunks).toString("utf8"),
                    ...(signal === null ? {} : { signal }),
                });
            });
        });
    }
}
//# sourceMappingURL=transport.js.map