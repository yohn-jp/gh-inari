/**
 * Pure/bounded local Git tree-delta projection for `change publish` (#467).
 *
 * This module only reads the local Git object store through plumbing
 * commands; it never mutates local Git and never contacts GitHub. Path
 * policy (#370), Session admission, and the actual branch-advance Git
 * mutation remain #466/App-side authorities -- this module only compiles
 * the bounded `upsert`/`delete` wire operations #466 accepts.
 */

import { execFileSync } from "node:child_process";

export type PublishProjectionErrorCode =
  | "PUBLISH_PROJECTION_INVALID_COMMIT"
  | "PUBLISH_PROJECTION_UNRELATED_HISTORY"
  | "PUBLISH_PROJECTION_UNSUPPORTED_MODE"
  | "PUBLISH_PROJECTION_GIT_FAILED"
  | "PUBLISH_PROJECTION_NO_CHANGES";

export class PublishProjectionError extends Error {
  readonly code: PublishProjectionErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: PublishProjectionErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "PublishProjectionError";
    this.code = code;
    this.details = details;
  }
}

export type PublishTreeChange =
  | {
      readonly operation: "upsert";
      readonly path: string;
      readonly mode: "100644" | "100755";
      readonly content: string;
    }
  | { readonly operation: "delete"; readonly path: string };

export interface PublishCommitAuthor {
  readonly name: string;
  readonly email?: string;
}

export interface PublishCommitMetadata {
  readonly message: string;
  readonly author?: PublishCommitAuthor;
}

export interface PublishTreeProjection {
  readonly commit: string;
  readonly expectedHead: string;
  readonly changes: readonly PublishTreeChange[];
  readonly commitMetadata: PublishCommitMetadata;
}

export interface ProjectPublishTreeDeltaOptions {
  readonly cwd: string;
  /** The local commit/tree to publish. */
  readonly commit: string;
  /** The current authoritative remote branch head, resolved through the App path. */
  readonly expectedHead: string;
  /** Test/injection seam; defaults to invoking the local `git` binary. */
  readonly git?: (args: readonly string[]) => string;
}

const SHA = /^[0-9a-f]{40}$/u;
const SUPPORTED_MODES = new Set(["100644", "100755"]);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

function defaultGit(cwd: string): (args: readonly string[]) => string {
  return (args: readonly string[]) => {
    try {
      return execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "git invocation failed.";
      throw new PublishProjectionError("PUBLISH_PROJECTION_GIT_FAILED", `git ${args[0] ?? ""} failed: ${message}`);
    }
  };
}

function defaultGitBuffer(cwd: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", [...args], { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "git invocation failed.";
    throw new PublishProjectionError("PUBLISH_PROJECTION_GIT_FAILED", `git ${args[0] ?? ""} failed: ${message}`);
  }
}

/** Resolve `rev` to an exact 40-hex commit sha; fails closed for anything else. */
export function resolvePublishCommit(
  cwd: string,
  rev: string,
  git: (args: readonly string[]) => string = defaultGit(cwd),
): string {
  let resolved: string;
  try {
    resolved = git(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  } catch {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_INVALID_COMMIT",
      `"${rev}" does not resolve to a local Git commit.`,
    );
  }
  if (!SHA.test(resolved)) {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_INVALID_COMMIT",
      `"${rev}" does not resolve to a local Git commit.`,
    );
  }
  return resolved;
}

function assertKnownAncestor(git: (args: readonly string[]) => string, expectedHead: string, commit: string): void {
  if (!SHA.test(expectedHead)) {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_UNRELATED_HISTORY",
      "The expected remote head is not a well-formed commit object id.",
    );
  }
  try {
    git(["cat-file", "-e", `${expectedHead}^{commit}`]);
  } catch {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_UNRELATED_HISTORY",
      "The expected remote head is not present in the local repository.",
    );
  }
  let output: string;
  try {
    output = git(["merge-base", "--is-ancestor", expectedHead, commit]);
  } catch {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_UNRELATED_HISTORY",
      "The expected remote head is not an ancestor of the requested local commit.",
    );
  }
  void output;
}

interface DiffEntry {
  readonly status: string;
  readonly path: string;
}

function parseNameStatus(output: string): readonly DiffEntry[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status ?? "", path: rest.join("\t") };
    });
}

function readMode(git: (args: readonly string[]) => string, commit: string, filePath: string): string {
  const line = git(["ls-tree", commit, "--", filePath]).trim();
  const mode = line.split(/\s+/u)[0];
  if (mode === undefined) {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_GIT_FAILED",
      `Could not resolve the Git tree entry for "${filePath}" at ${commit}.`,
    );
  }
  return mode;
}

function readBlobBase64(cwd: string, commit: string, filePath: string): string {
  const buffer = defaultGitBuffer(cwd, ["show", `${commit}:${filePath}`]);
  return buffer.toString("base64");
}

function readCommitMetadata(git: (args: readonly string[]) => string, commit: string): PublishCommitMetadata {
  const message = git(["show", "-s", "--format=%s", commit]).trim();
  if (message.length === 0) {
    throw new PublishProjectionError("PUBLISH_PROJECTION_GIT_FAILED", `Commit ${commit} has no subject line.`);
  }
  const authorLine = git(["show", "-s", "--format=%an%x09%ae", commit]).replace(/\n$/u, "");
  const [name, email] = authorLine.split("\t");
  if (name === undefined || name.length === 0) return { message };
  return { message, author: email === undefined || email.length === 0 ? { name } : { name, email } };
}

/**
 * Compute the complete bounded `upsert`/`delete` tree delta needed to
 * reproduce `commit`'s tree relative to `expectedHead`. Fails closed for
 * unrelated history, an unresolved commit, or an unsupported Git object mode
 * (a symlink or submodule entry is never guessed into a supported mode).
 */
export function projectPublishTreeDelta(options: ProjectPublishTreeDeltaOptions): PublishTreeProjection {
  const git = options.git ?? defaultGit(options.cwd);
  const commit = resolvePublishCommit(options.cwd, options.commit, git);
  assertKnownAncestor(git, options.expectedHead, commit);

  const diffOutput = git(["diff", "--no-renames", "--name-status", options.expectedHead, commit, "--"]);
  const entries = parseNameStatus(diffOutput);
  const changes: PublishTreeChange[] = [];
  for (const entry of entries) {
    if (entry.path.length === 0) continue;
    if (entry.status.startsWith("D")) {
      changes.push({ operation: "delete", path: entry.path });
      continue;
    }
    const mode = readMode(git, commit, entry.path);
    if (!SUPPORTED_MODES.has(mode)) {
      throw new PublishProjectionError(
        "PUBLISH_PROJECTION_UNSUPPORTED_MODE",
        `"${entry.path}" has unsupported Git object mode "${mode}".`,
        { path: entry.path, mode },
      );
    }
    changes.push({
      operation: "upsert",
      path: entry.path,
      mode: mode as "100644" | "100755",
      content: readBlobBase64(options.cwd, commit, entry.path),
    });
  }
  if (changes.length === 0) {
    throw new PublishProjectionError(
      "PUBLISH_PROJECTION_NO_CHANGES",
      `Commit ${commit} has no tree changes relative to the expected remote head ${options.expectedHead}.`,
    );
  }

  return {
    commit,
    expectedHead: options.expectedHead,
    changes,
    commitMetadata: readCommitMetadata(git, commit),
  };
}
