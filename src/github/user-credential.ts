/**
 * Standalone user-context GitHub credential resolution (#662).
 *
 * Inari never reads a `gh` credential store (`gh auth token`, gh config
 * files, or the OS keychain entries gh manages). A standalone credential is
 * either injected explicitly by an embedder/test or resolved from a fixed,
 * deterministic set of environment variables -- the same variables GitHub's
 * own Actions runners and automation tooling already document, so existing
 * CI environments keep working unchanged. There is no persistent Inari
 * credential store: nothing here reads or writes a file, and the resolved
 * token is never cached beyond the caller-held result.
 */

const DEFAULT_HOSTNAME = "github.com";
const MAX_TOKEN_LENGTH = 4_096;
const MAX_HOSTNAME_LENGTH = 255;

export type GitHubUserCredentialSource =
  "explicit" | "GH_TOKEN" | "GITHUB_TOKEN" | "GH_ENTERPRISE_TOKEN" | "GITHUB_ENTERPRISE_TOKEN";

export type GitHubUserCredentialFailureReason = "hostname" | "missing" | "invalid";

export class GitHubUserCredentialError extends Error {
  readonly code = "GITHUB_USER_CREDENTIAL_UNRESOLVED" as const;
  readonly reason: GitHubUserCredentialFailureReason;

  constructor(reason: GitHubUserCredentialFailureReason, message: string) {
    super(message);
    this.name = "GitHubUserCredentialError";
    this.reason = reason;
  }
}

export interface GitHubUserCredential {
  readonly token: string;
  readonly source: GitHubUserCredentialSource;
}

export interface ResolveGitHubUserCredentialOptions {
  readonly hostname?: string;
  /** Explicit injection; takes precedence over every environment variable. */
  readonly token?: string;
  /** Defaults to `process.env`. Never mutated. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function isBoundedToken(value: string | undefined): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\u0000\u007F]/u.test(value)
  );
}

function normalizedHostname(hostname: string | undefined): string {
  const value = (hostname ?? DEFAULT_HOSTNAME).trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH || /[\s/]/u.test(value)) {
    throw new GitHubUserCredentialError("hostname", `GitHub hostname "${hostname ?? ""}" is invalid.`);
  }
  return value;
}

/**
 * Resolve a standalone GitHub credential with deterministic precedence:
 *
 * 1. an explicitly injected token (embedder/test wiring)
 * 2. for `github.com`: `GH_TOKEN`, then `GITHUB_TOKEN`
 * 3. for any other (Enterprise) host: `GH_ENTERPRISE_TOKEN`, then `GITHUB_ENTERPRISE_TOKEN`
 *
 * Fails closed with `GitHubUserCredentialError` when no bounded, well-formed
 * token is available. Never reads gh config or an OS credential store.
 */
export function resolveGitHubUserCredential(options: ResolveGitHubUserCredentialOptions = {}): GitHubUserCredential {
  const hostname = normalizedHostname(options.hostname);
  if (options.token !== undefined) {
    if (!isBoundedToken(options.token)) {
      throw new GitHubUserCredentialError("invalid", "The explicitly injected GitHub token is invalid.");
    }
    return { token: options.token, source: "explicit" };
  }

  const env = options.env ?? process.env;
  const candidates: readonly GitHubUserCredentialSource[] =
    hostname === DEFAULT_HOSTNAME
      ? (["GH_TOKEN", "GITHUB_TOKEN"] as const)
      : (["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const);

  for (const source of candidates) {
    const value = env[source];
    if (value === undefined) continue;
    if (!isBoundedToken(value)) {
      throw new GitHubUserCredentialError("invalid", `Environment variable ${source} holds an invalid GitHub token.`);
    }
    return { token: value, source };
  }

  throw new GitHubUserCredentialError(
    "missing",
    hostname === DEFAULT_HOSTNAME
      ? "No GitHub credential found. Set GH_TOKEN or GITHUB_TOKEN."
      : `No GitHub credential found for host "${hostname}". Set GH_ENTERPRISE_TOKEN or GITHUB_ENTERPRISE_TOKEN.`,
  );
}
