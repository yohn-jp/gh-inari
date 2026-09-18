/**
 * Native readiness/identity check for standalone GitHub credentials (#662).
 *
 * Replaces `gh auth status` with GitHub HTTP identity evidence: a bounded
 * `GET user` request through the injected transport. This module owns no
 * credential material and no transport implementation; it only validates
 * the shape of the response.
 */

import type { GitHubChangeEffectTransport } from "./change-effect-adapter.js";

const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/u;

export type GitHubUserIdentityFailureReason = "request" | "status" | "response";

export class GitHubUserIdentityError extends Error {
  readonly code = "GITHUB_USER_IDENTITY_FAILED" as const;
  readonly reason: GitHubUserIdentityFailureReason;
  readonly status?: number;

  constructor(reason: GitHubUserIdentityFailureReason, message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubUserIdentityError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the authenticated login for a bounded credential-bound transport.
 * A non-200 response or a malformed identity body both fail closed; neither
 * is silently treated as "unauthenticated" versus "transport error" because
 * the caller, not this reader, owns that distinction.
 */
export async function resolveAuthenticatedGitHubUser(
  transport: Pick<GitHubChangeEffectTransport, "request">,
  hostname: string,
): Promise<string> {
  let response: { readonly status: number; readonly body?: unknown };
  try {
    response = await transport.request({ hostname, method: "GET", path: "user" });
  } catch (error) {
    throw new GitHubUserIdentityError(
      "request",
      "Unable to reach GitHub to resolve the authenticated identity.",
      undefined,
      error,
    );
  }
  if (response.status !== 200) {
    throw new GitHubUserIdentityError(
      "status",
      `GitHub returned status ${response.status} while resolving the authenticated identity.`,
      response.status,
    );
  }
  if (!isRecord(response.body) || typeof response.body.login !== "string" || !LOGIN_PATTERN.test(response.body.login)) {
    throw new GitHubUserIdentityError("response", "GitHub returned an invalid authenticated user identity.");
  }
  return response.body.login;
}
