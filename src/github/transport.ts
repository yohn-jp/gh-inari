import { spawn } from "node:child_process";

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
export class GhTransportTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`gh transport exceeded its bounded timeout of ${timeoutMs}ms.`);
    this.name = "GhTransportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The adapter's only credential boundary: execute the user's existing gh CLI. */
export interface GhTransport {
  run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult>;
}

/** Grace period after SIGTERM before escalating to SIGKILL for an unresponsive child process. */
const FORCE_KILL_GRACE_MS = 2000;

export class ProcessGhTransport implements GhTransport {
  readonly executable: string;

  constructor(executable = "gh") {
    this.executable = executable;
  }

  run(args: readonly string[], options: GhTransportOptions = {}): Promise<GhCommandResult> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.executable, [...args], {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }

      if (child.stdout === null || child.stderr === null) {
        reject(new Error("gh transport did not provide stdout and stderr pipes"));
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
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
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            child.kill("SIGKILL");
          }, FORCE_KILL_GRACE_MS);
          killTimer.unref();
        }, timeoutMs);
        timer.unref();
      }

      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (timedOut) {
          reject(new GhTransportTimeoutError(options.timeoutMs as number));
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
          ...(signal === null ? {} : { signal }),
        });
      });
    });
  }
}
