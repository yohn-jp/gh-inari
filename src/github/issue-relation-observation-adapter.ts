/**
 * GitHub-native Issue relation observation adapter (#288).
 *
 * Reads the native `parent` and `blocked_by` relationships for one Issue and
 * normalizes each related Issue into the existing {@link IssueReference}
 * identity primitive. This module owns no repository policy: it does not
 * infer `children`/`blocks`, tracker state, supersession, or completion
 * semantics, does not parse Markdown/body markers, and never mutates
 * relationships. Canon vocabulary, Effective Contract, materialization,
 * projection policy, and #161 lifecycle interpretation remain out of scope.
 *
 * Depending on the full `GitHubAdapter` surface here would recreate the
 * coupling #288 is meant to avoid, so this module consumes only the bounded
 * `requestRepositoryApi` read seam through a narrow interface.
 */

import { ContractViolationError } from "./errors.js";
import type { GitHubApiResponse } from "./adapter.js";
import type { RepositoryContext } from "./types.js";
import { normalizeIssueReference, type IssueReference } from "../contract/issue-reference.js";

/** Narrow read seam this module needs from `GitHubAdapter`. */
export interface IssueRelationApiReader {
  requestRepositoryApi(repositoryPath: string): Promise<GitHubApiResponse>;
}

/**
 * `empty` — GitHub confirmed zero relations (404, or a present-but-empty set).
 * `present` — every related Issue resolved to a stable identity.
 * `unavailable` — GitHub evidence exists (or the read itself failed) but a
 *   stable identity could not be established, e.g. the read seam cannot
 *   resolve a cross-repository relation's repository database ID, or the
 *   read failed outright.
 * `malformed` — GitHub returned a response that does not match the expected
 *   Issue relation shape.
 */
export type IssueRelationEvidenceKind = "empty" | "present" | "unavailable" | "malformed";

export type IssueRelationDiagnosticCode =
  | "RELATION_READ_FAILED"
  | "RELATION_RESPONSE_MALFORMED"
  | "RELATION_ENTRY_MALFORMED"
  | "RELATION_REPOSITORY_UNRESOLVED";

export interface IssueRelationDiagnostic {
  readonly code: IssueRelationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface IssueParentObservation {
  readonly kind: IssueRelationEvidenceKind;
  readonly reference: IssueReference | undefined;
  readonly diagnostics: readonly IssueRelationDiagnostic[];
}

export interface IssueBlockedByObservation {
  readonly kind: IssueRelationEvidenceKind;
  readonly references: readonly IssueReference[];
  readonly diagnostics: readonly IssueRelationDiagnostic[];
}

const BLOCKED_BY_PAGE_SIZE = 100;

/**
 * Observes GitHub-native Issue `parent` and `blocked_by` relationships for
 * one repository context and normalizes them into bounded, deterministic
 * evidence rather than raw GitHub payloads.
 */
export class GitHubIssueRelationObservationAdapter {
  private readonly reader: IssueRelationApiReader;
  private readonly context: RepositoryContext;

  constructor(reader: IssueRelationApiReader, context: RepositoryContext) {
    this.reader = reader;
    this.context = context;
  }

  /** Observe the native parent relationship for one Issue. */
  async observeParent(issueNumber: number): Promise<IssueParentObservation> {
    assertIssueNumber(issueNumber);
    let response: GitHubApiResponse;
    try {
      response = await this.reader.requestRepositoryApi(`issues/${issueNumber}/parent`);
    } catch (error) {
      return { kind: "unavailable", reference: undefined, diagnostics: [readFailedDiagnostic(error)] };
    }
    if (response.status === 404) return { kind: "empty", reference: undefined, diagnostics: [] };
    if (!isRecord(response.body)) {
      return {
        kind: "malformed",
        reference: undefined,
        diagnostics: [responseMalformedDiagnostic("GitHub returned a non-object parent response.")],
      };
    }

    const resolved = resolveRelatedIssue(response.body, this.context, "$");
    if (resolved.status === "resolved") {
      return { kind: "present", reference: resolved.reference, diagnostics: [] };
    }
    return {
      kind: resolved.status === "malformed" ? "malformed" : "unavailable",
      reference: undefined,
      diagnostics: [resolved.diagnostic],
    };
  }

  /** Observe the native `blocked_by` dependency set for one Issue. */
  async observeBlockedBy(issueNumber: number): Promise<IssueBlockedByObservation> {
    assertIssueNumber(issueNumber);
    let response: GitHubApiResponse;
    try {
      response = await this.reader.requestRepositoryApi(
        `issues/${issueNumber}/dependencies/blocked_by?per_page=${BLOCKED_BY_PAGE_SIZE}`,
      );
    } catch (error) {
      return { kind: "unavailable", references: [], diagnostics: [readFailedDiagnostic(error)] };
    }
    if (response.status === 404) return { kind: "empty", references: [], diagnostics: [] };
    if (!Array.isArray(response.body)) {
      return {
        kind: "malformed",
        references: [],
        diagnostics: [responseMalformedDiagnostic("GitHub returned a non-array blocked_by response.")],
      };
    }
    if (response.body.length === 0) return { kind: "empty", references: [], diagnostics: [] };

    const references: IssueReference[] = [];
    const diagnostics: IssueRelationDiagnostic[] = [];
    let malformedCount = 0;
    let unresolvedCount = 0;
    response.body.forEach((entry, index) => {
      const resolved = resolveRelatedIssue(entry, this.context, `$[${index}]`);
      if (resolved.status === "resolved") {
        references.push(resolved.reference);
        return;
      }
      diagnostics.push(resolved.diagnostic);
      if (resolved.status === "malformed") malformedCount += 1;
      else unresolvedCount += 1;
    });

    if (malformedCount > 0) return { kind: "malformed", references: [], diagnostics };
    if (unresolvedCount > 0) return { kind: "unavailable", references: [], diagnostics };
    return { kind: "present", references, diagnostics: [] };
  }
}

type RelatedIssueResolution =
  | { readonly status: "resolved"; readonly reference: IssueReference }
  | { readonly status: "malformed"; readonly diagnostic: IssueRelationDiagnostic }
  | { readonly status: "unresolved"; readonly diagnostic: IssueRelationDiagnostic };

function resolveRelatedIssue(entry: unknown, context: RepositoryContext, path: string): RelatedIssueResolution {
  if (!isRecord(entry)) {
    return {
      status: "malformed",
      diagnostic: {
        code: "RELATION_ENTRY_MALFORMED",
        path,
        message: "GitHub returned a non-object Issue reference.",
      },
    };
  }
  const number = entry.number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    return {
      status: "malformed",
      diagnostic: {
        code: "RELATION_ENTRY_MALFORMED",
        path: `${path}.number`,
        message: "GitHub returned an Issue reference with an invalid number.",
      },
    };
  }

  // A cross-repository relation cannot be resolved through this bounded read
  // seam: requestRepositoryApi only reaches endpoints under the current
  // repository, so a related Issue's stable database ID is available only
  // when its repository_url matches the current repository context.
  const relatedRepository = parseRepositoryUrl(entry.repository_url);
  const sameRepository =
    relatedRepository !== undefined &&
    relatedRepository.host === context.hostname.toLowerCase() &&
    relatedRepository.nameWithOwner.toLowerCase() === context.nameWithOwner.toLowerCase();
  if (!sameRepository || context.repositoryId === undefined) {
    return {
      status: "unresolved",
      diagnostic: {
        code: "RELATION_REPOSITORY_UNRESOLVED",
        path,
        message:
          "GitHub returned an Issue reference whose repository identity could not be resolved through the current bounded read seam.",
      },
    };
  }

  const normalized = normalizeIssueReference(
    {
      repositoryHost: context.hostname,
      repositoryId: context.repositoryId,
      repository: context.nameWithOwner,
      number,
    },
    path,
  );
  if (!normalized.valid || normalized.reference === undefined) {
    return {
      status: "malformed",
      diagnostic: {
        code: "RELATION_ENTRY_MALFORMED",
        path,
        message: "GitHub returned an Issue reference that failed identity normalization.",
      },
    };
  }
  return { status: "resolved", reference: normalized.reference };
}

function parseRepositoryUrl(value: unknown): { readonly host: string; readonly nameWithOwner: string } | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = /^\/(?:api\/v3\/)?repos\/([^/]+)\/([^/]+)\/?$/u.exec(url.pathname);
  if (match === null) return undefined;
  const host = url.hostname.toLowerCase() === "api.github.com" ? "github.com" : url.hostname.toLowerCase();
  return { host, nameWithOwner: `${match[1]}/${match[2]}` };
}

function responseMalformedDiagnostic(message: string): IssueRelationDiagnostic {
  return { code: "RELATION_RESPONSE_MALFORMED", path: "$", message };
}

function readFailedDiagnostic(error: unknown): IssueRelationDiagnostic {
  return {
    code: "RELATION_READ_FAILED",
    path: "$",
    message: error instanceof Error ? error.message : "GitHub Issue relation read failed.",
  };
}

function assertIssueNumber(value: number): asserts value is number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContractViolationError("Issue number must be a positive integer.", "issueNumber");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
