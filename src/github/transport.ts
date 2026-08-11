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

/** The adapter's only credential boundary: execute the user's existing gh CLI. */
export interface GhTransport {
  run(args: readonly string[], options?: GhTransportOptions): Promise<GhCommandResult>;
}

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
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              child.kill("SIGTERM");
            }, options.timeoutMs);
      timer?.unref();
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (timer !== undefined) clearTimeout(timer);
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
