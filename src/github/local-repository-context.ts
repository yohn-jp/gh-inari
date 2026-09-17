/**
 * Native repository-context resolution (#662).
 *
 * Replaces `gh repo view` for current-checkout inference. Repository
 * selection is either explicit (`--repository owner/name`,
 * `host/owner/name`, or a repository URL) or derived from local repository
 * evidence -- the configured Git remote -- never from a `gh` subprocess.
 * Absence or ambiguity fails deterministically instead of guessing.
 *
 * This module resolves identity fields only (`hostname`/`owner`/`name`); it
 * does not mint a `repositoryId`, which requires an authenticated provider
 * round trip and belongs to the credential/transport layer that consumes
 * this context (see `resolveGitHubRepository` in
 * `app-installation-credential-broker.ts`, which accepts any
 * `GitHubChangeEffectTransport`, including `GitHubNativeHttpTransport`).
 */

import { execFileSync } from "node:child_process";
import type { RepositoryContext } from "./types.js";

const DEFAULT_REMOTE_NAME = "origin";
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 1_048_576;

export type RepositoryContextFailureReason =
  "invalid-override" | "invalid-hostname" | "remote-missing" | "remote-unparseable";

export class RepositoryContextResolutionError extends Error {
  readonly code = "GITHUB_REPOSITORY_CONTEXT_UNRESOLVED" as const;
  readonly reason: RepositoryContextFailureReason;

  constructor(reason: RepositoryContextFailureReason, message: string) {
    super(message);
    this.name = "RepositoryContextResolutionError";
    this.reason = reason;
  }
}

function isValidHostname(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\s/]/u.test(value);
}

function isValidRepositorySegment(value: string): boolean {
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9_.-]+$/u.test(value);
}

function buildRepositoryContext(hostname: string, owner: string, name: string, url?: string): RepositoryContext {
  const normalizedHostname = hostname.trim().toLowerCase();
  if (!isValidHostname(normalizedHostname)) {
    throw new RepositoryContextResolutionError("invalid-hostname", `Hostname "${hostname}" is invalid.`);
  }
  if (!isValidRepositorySegment(owner) || !isValidRepositorySegment(name)) {
    throw new RepositoryContextResolutionError(
      "invalid-override",
      `Repository identity "${owner}/${name}" contains an invalid owner or name segment.`,
    );
  }
  const nameWithOwner = `${owner}/${name}`;
  return Object.freeze({
    hostname: normalizedHostname,
    host: normalizedHostname,
    owner,
    name,
    nameWithOwner,
    url: url ?? `https://${normalizedHostname}/${nameWithOwner}`,
  });
}

/**
 * Parse an explicit `--repository` locator: `owner/name`, `host/owner/name`,
 * or a full repository URL (`https://host/owner/name[.git]`,
 * `git@host:owner/name[.git]`, `ssh://git@host/owner/name[.git]`).
 */
export function parseRepositoryLocator(value: string, fallbackHostname: string): RepositoryContext {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RepositoryContextResolutionError("invalid-override", "Repository override must not be empty.");
  }

  const urlMatch = parseGitRemoteUrl(trimmed);
  if (urlMatch !== undefined) {
    return buildRepositoryContext(urlMatch.hostname, urlMatch.owner, urlMatch.name, trimmed);
  }

  const parts = trimmed.split("/");
  if (parts.length === 2) return buildRepositoryContext(fallbackHostname, parts[0] ?? "", parts[1] ?? "");
  if (parts.length === 3) return buildRepositoryContext(parts[0] ?? "", parts[1] ?? "", parts[2] ?? "");
  throw new RepositoryContextResolutionError(
    "invalid-override",
    `Repository override "${value}" must be owner/name, host/owner/name, or a GitHub repository URL.`,
  );
}

interface ParsedGitRemote {
  readonly hostname: string;
  readonly owner: string;
  readonly name: string;
}

/** Parses any host, not only github.com, so Enterprise remotes resolve the same way. */
function parseGitRemoteUrl(value: string): ParsedGitRemote | undefined {
  const httpsMatch = /^(?:https?):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(value);
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined && httpsMatch[3] !== undefined) {
    return { hostname: httpsMatch[1], owner: httpsMatch[2], name: httpsMatch[3] };
  }
  const scpMatch = /^[^@\s/]+@([^:/\s]+):([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(value);
  if (scpMatch?.[1] !== undefined && scpMatch[2] !== undefined && scpMatch[3] !== undefined) {
    return { hostname: scpMatch[1], owner: scpMatch[2], name: scpMatch[3] };
  }
  const sshMatch = /^ssh:\/\/[^@\s/]+@([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(value);
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined && sshMatch[3] !== undefined) {
    return { hostname: sshMatch[1], owner: sshMatch[2], name: sshMatch[3] };
  }
  return undefined;
}

export type GitCommandRunner = (args: readonly string[]) => string;

function defaultGitCommandRunner(cwd: string | undefined): GitCommandRunner {
  return (args: readonly string[]) => {
    try {
      return execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        timeout: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "git invocation failed.";
      throw new RepositoryContextResolutionError("remote-missing", `Unable to read the local Git remote: ${message}`);
    }
  };
}

export interface ResolveLocalRepositoryContextOptions {
  /** Explicit `owner/name`, `host/owner/name`, or repository URL override. */
  readonly repository?: string;
  /** Fallback hostname applied to an `owner/name` override or local-remote inference. */
  readonly hostname?: string;
  readonly cwd?: string;
  readonly remoteName?: string;
  /** Test/injection seam; defaults to invoking the local `git` binary. */
  readonly git?: GitCommandRunner;
}

const DEFAULT_HOSTNAME = "github.com";

/**
 * Resolve repository identity from an explicit override, or -- absent one --
 * from the configured local Git remote. Never shells out to `gh`. Absence or
 * an unparseable remote fails closed with `RepositoryContextResolutionError`
 * rather than guessing.
 */
export function resolveLocalRepositoryContext(options: ResolveLocalRepositoryContextOptions = {}): RepositoryContext {
  const fallbackHostname = options.hostname ?? DEFAULT_HOSTNAME;
  if (options.repository !== undefined) {
    return parseRepositoryLocator(options.repository, fallbackHostname);
  }

  const git = options.git ?? defaultGitCommandRunner(options.cwd);
  const remoteName = options.remoteName ?? DEFAULT_REMOTE_NAME;
  let rawRemoteUrl: string;
  try {
    rawRemoteUrl = git(["remote", "get-url", remoteName]);
  } catch (error: unknown) {
    if (error instanceof RepositoryContextResolutionError) throw error;
    const message = error instanceof Error ? error.message : "git invocation failed.";
    throw new RepositoryContextResolutionError("remote-missing", `Unable to read the local Git remote: ${message}`);
  }
  const remoteUrl = rawRemoteUrl.trim();
  if (remoteUrl.length === 0) {
    throw new RepositoryContextResolutionError(
      "remote-missing",
      `Local Git remote "${remoteName}" has no configured URL.`,
    );
  }
  const parsed = parseGitRemoteUrl(remoteUrl);
  if (parsed === undefined) {
    throw new RepositoryContextResolutionError(
      "remote-unparseable",
      `Local Git remote "${remoteName}" (${remoteUrl}) is not a recognizable GitHub repository URL.`,
    );
  }
  return buildRepositoryContext(parsed.hostname, parsed.owner, parsed.name, remoteUrl);
}
