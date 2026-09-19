import { spawnSync } from "node:child_process";
import type { GitHubUserCredentialFallbackProvider } from "./user-credential.js";

const GH_AUTH_TOKEN_TIMEOUT_MS = 3_000;
const GH_AUTH_TOKEN_MAX_OUTPUT_BYTES = 4_098;

export interface GhAuthTokenCommandOptions {
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly stdio: ["ignore", "pipe", "ignore"];
  readonly timeout: number;
}

export interface GhAuthTokenCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly failed?: boolean;
}

export type GhAuthTokenCommandRunner = (
  args: readonly string[],
  options: GhAuthTokenCommandOptions,
) => GhAuthTokenCommandResult;

function runGhAuthToken(args: readonly string[], options: GhAuthTokenCommandOptions): GhAuthTokenCommandResult {
  try {
    const result = spawnSync("gh", [...args], options);
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      ...(result.error === undefined ? {} : { failed: true }),
    };
  } catch {
    return { status: null, stdout: "", failed: true };
  }
}

/**
 * Compose the sole supported GitHub CLI credential-discovery operation.
 *
 * This provider is intentionally separate from credential resolution so SDK
 * and embedder callers do not spawn a process unless they explicitly supply
 * this provider. Failure details and stderr are discarded by design.
 */
export function createGhAuthTokenCredentialProvider(
  options: {
    readonly run?: GhAuthTokenCommandRunner;
  } = {},
): GitHubUserCredentialFallbackProvider {
  const run = options.run ?? runGhAuthToken;
  return (hostname) => {
    let result: GhAuthTokenCommandResult;
    try {
      result = run(["auth", "token", "--hostname", hostname], {
        encoding: "utf8",
        maxBuffer: GH_AUTH_TOKEN_MAX_OUTPUT_BYTES,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
      });
    } catch {
      return undefined;
    }
    if (result.failed === true || result.status !== 0) return undefined;
    if (Buffer.byteLength(result.stdout, "utf8") > GH_AUTH_TOKEN_MAX_OUTPUT_BYTES) return undefined;

    const token = result.stdout.trim();
    if (token.length === 0 || /\s/u.test(token)) return undefined;
    return token;
  };
}
