/**
 * GitHub-native Issue relation mutation adapter (#419).
 *
 * This is a provider-facing projection of one already-admitted Core relation
 * effect.  It deliberately does not plan, infer, retry, compensate, or own
 * lifecycle state.  The caller supplies the bounded effect and the adapter
 * only resolves the GitHub database IDs required by the native REST API,
 * applies the matching endpoint, and fails closed on an unexpected response.
 */

import { ContractViolationError } from "./errors.js";
import type { GitHubApiFieldValue, GitHubApiResponse } from "./adapter.js";
import type { RepositoryContext } from "./types.js";
import {
  GitHubIssueRelationObservationAdapter,
  type IssueBlockedByObservation,
  type IssueParentObservation,
  type IssueRelationCapabilities,
  type IssueRelationApiReader,
} from "./issue-relation-observation-adapter.js";
import { issueReferenceKey, normalizeIssueReference, type IssueReference } from "../contract/issue-reference.js";
import type { SemanticIssueRelationEffect } from "../semantic-issue-relations.js";

/** Narrow mutation seam exposed by the GitHub adapter. */
export interface IssueRelationApiMutator extends IssueRelationApiReader {
  requestRepositoryApi(
    repositoryPath: string,
    method?: "GET" | "POST" | "PATCH" | "DELETE",
    fields?: Readonly<Record<string, GitHubApiFieldValue>>,
  ): Promise<GitHubApiResponse>;
}

export type IssueRelationMutationErrorCode =
  | "RELATION_MUTATION_INVALID"
  | "RELATION_MUTATION_UNSUPPORTED"
  | "RELATION_MUTATION_READ_FAILED"
  | "RELATION_MUTATION_RESPONSE_INVALID"
  | "RELATION_MUTATION_FAILED";

/** Bounded error that never exposes a provider response body. */
export class GitHubIssueRelationMutationError extends Error {
  readonly code: IssueRelationMutationErrorCode;
  readonly path?: string;
  readonly status?: number;

  constructor(
    code: IssueRelationMutationErrorCode,
    message: string,
    options: { readonly path?: string; readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GitHubIssueRelationMutationError";
    this.code = code;
    this.path = options.path;
    this.status = options.status;
  }
}

const ISSUE_ID_CACHE_LIMIT = 256;

/**
 * Executes native parent and blocked-by effects against one repository.
 * Observation remains available through the same adapter so callers can use a
 * single capability declaration and bounded transport seam for reread.
 */
export class GitHubIssueRelationMutationAdapter {
  private readonly mutator: IssueRelationApiMutator;
  private readonly context: RepositoryContext;
  private readonly capabilities: IssueRelationCapabilities;
  private readonly observation: GitHubIssueRelationObservationAdapter;
  private readonly issueDatabaseIds = new Map<string, string>();

  constructor(mutator: IssueRelationApiMutator, context: RepositoryContext, capabilities: IssueRelationCapabilities) {
    if (typeof mutator?.requestRepositoryApi !== "function")
      throw new ContractViolationError("A repository API mutation seam is required.", "mutator");
    assertRepositoryContext(context);
    if (typeof capabilities?.parent !== "boolean" || typeof capabilities?.blockedBy !== "boolean")
      throw new ContractViolationError("Issue relation capabilities must be boolean flags.", "capabilities");
    this.mutator = mutator;
    this.context = context;
    this.capabilities = { parent: capabilities.parent, blockedBy: capabilities.blockedBy };
    this.observation = new GitHubIssueRelationObservationAdapter(mutator, context, this.capabilities);
  }

  observeParent(issueNumber: number): Promise<IssueParentObservation> {
    return this.observation.observeParent(issueNumber);
  }

  observeBlockedBy(issueNumber: number): Promise<IssueBlockedByObservation> {
    return this.observation.observeBlockedBy(issueNumber);
  }

  /** Execute exactly one already-admitted Core relation effect. */
  async execute(effect: SemanticIssueRelationEffect, subject: IssueReference): Promise<void> {
    const normalizedSubject = this.assertReference(subject, "subject");
    switch (effect.kind) {
      case "SET_PARENT_RELATION":
        await this.setParent(normalizedSubject, effect.parent);
        return;
      case "CLEAR_PARENT_RELATION":
        if (effect.previousParent === undefined)
          throw new GitHubIssueRelationMutationError(
            "RELATION_MUTATION_INVALID",
            "A parent clear effect must carry the observed previous parent.",
            { path: "effect.previousParent" },
          );
        await this.clearParent(normalizedSubject, effect.previousParent);
        return;
      case "ADD_BLOCKED_BY_RELATION":
        await this.addBlockedBy(normalizedSubject, effect.reference);
        return;
      case "REMOVE_BLOCKED_BY_RELATION":
        await this.removeBlockedBy(normalizedSubject, effect.reference);
        return;
    }
  }

  /** Add or replace the native parent relation for a child Issue. */
  async setParent(child: IssueReference, parent: IssueReference): Promise<void> {
    const normalizedChild = this.assertReference(child, "child");
    const normalizedParent = this.assertReference(parent, "parent");
    this.assertParentCapability();
    this.assertSameRepository(normalizedChild, "child");
    this.assertSameRepository(normalizedParent, "parent");
    if (normalizedChild.number === normalizedParent.number)
      throw new GitHubIssueRelationMutationError("RELATION_MUTATION_INVALID", "An Issue cannot be its own parent.", {
        path: "parent",
      });

    const childId = await this.issueDatabaseId(normalizedChild);
    await this.request(
      `issues/${normalizedParent.number}/sub_issues`,
      "POST",
      { sub_issue_id: databaseIdField(childId) },
      [201],
    );
  }

  /** Remove one observed native parent relation, bounded by that parent identity. */
  async clearParent(child: IssueReference, previousParent: IssueReference): Promise<void> {
    const normalizedChild = this.assertReference(child, "child");
    const normalizedParent = this.assertReference(previousParent, "previousParent");
    this.assertParentCapability();
    this.assertSameRepository(normalizedChild, "child");
    this.assertSameRepository(normalizedParent, "previousParent");
    if (normalizedChild.number === normalizedParent.number)
      throw new GitHubIssueRelationMutationError("RELATION_MUTATION_INVALID", "An Issue cannot be its own parent.", {
        path: "previousParent",
      });

    const childId = await this.issueDatabaseId(normalizedChild);
    await this.request(
      `issues/${normalizedParent.number}/sub_issue`,
      "DELETE",
      { sub_issue_id: databaseIdField(childId) },
      [204],
    );
  }

  /** Add one native blocked-by dependency to an Issue. */
  async addBlockedBy(child: IssueReference, blocker: IssueReference): Promise<void> {
    const normalizedChild = this.assertReference(child, "child");
    const normalizedBlocker = this.assertReference(blocker, "blocker");
    this.assertBlockedByCapability();
    this.assertSameRepository(normalizedChild, "child");
    this.assertSameRepository(normalizedBlocker, "blocker");
    if (normalizedChild.number === normalizedBlocker.number)
      throw new GitHubIssueRelationMutationError("RELATION_MUTATION_INVALID", "An Issue cannot depend on itself.", {
        path: "blocker",
      });

    const blockerId = await this.issueDatabaseId(normalizedBlocker);
    await this.request(
      `issues/${normalizedChild.number}/dependencies/blocked_by`,
      "POST",
      { issue_id: databaseIdField(blockerId) },
      [201],
    );
  }

  /** Remove one native blocked-by dependency. */
  async removeBlockedBy(child: IssueReference, blocker: IssueReference): Promise<void> {
    const normalizedChild = this.assertReference(child, "child");
    const normalizedBlocker = this.assertReference(blocker, "blocker");
    this.assertBlockedByCapability();
    this.assertSameRepository(normalizedChild, "child");
    this.assertSameRepository(normalizedBlocker, "blocker");
    if (normalizedChild.number === normalizedBlocker.number)
      throw new GitHubIssueRelationMutationError("RELATION_MUTATION_INVALID", "An Issue cannot depend on itself.", {
        path: "blocker",
      });

    const blockerId = await this.issueDatabaseId(normalizedBlocker);
    await this.request(`issues/${normalizedChild.number}/dependencies/blocked_by/${blockerId}`, "DELETE", {}, [204]);
  }

  private assertReference(value: unknown, path: string): IssueReference {
    const result = normalizeIssueReference(value, path);
    if (!result.valid || result.reference === undefined)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_INVALID",
        "Issue relation references must carry a valid repository identity and number.",
        { path },
      );
    return result.reference;
  }

  private assertSameRepository(reference: IssueReference, path: string): void {
    if (
      reference.repositoryHost.toLowerCase() !== this.context.hostname.toLowerCase() ||
      this.context.repositoryId === undefined ||
      reference.repositoryId !== this.context.repositoryId
    ) {
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_UNSUPPORTED",
        "Native Issue relations must stay within the resolved repository identity.",
        { path },
      );
    }
  }

  private assertParentCapability(): void {
    if (!this.capabilities.parent)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_UNSUPPORTED",
        "The target GitHub capability set does not support native parent relations.",
        { path: "capabilities.parent" },
      );
  }

  private assertBlockedByCapability(): void {
    if (!this.capabilities.blockedBy)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_UNSUPPORTED",
        "The target GitHub capability set does not support native blocked-by relations.",
        { path: "capabilities.blockedBy" },
      );
  }

  private async issueDatabaseId(reference: IssueReference): Promise<string> {
    const key = issueReferenceKey(reference);
    const cached = this.issueDatabaseIds.get(key);
    if (cached !== undefined) return cached;
    let response: GitHubApiResponse;
    try {
      response = await this.mutator.requestRepositoryApi(`issues/${reference.number}`, "GET");
    } catch (error) {
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_READ_FAILED",
        "The Issue database identity could not be resolved before applying a native relation.",
        { path: `issues/${reference.number}`, cause: error },
      );
    }
    if (response.status !== 200)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_READ_FAILED",
        "The Issue database identity could not be resolved before applying a native relation.",
        { path: `issues/${reference.number}`, status: response.status },
      );
    if (!isRecord(response.body))
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_RESPONSE_INVALID",
        "GitHub returned a malformed Issue identity response.",
        { path: `issues/${reference.number}` },
      );
    if (response.body.pull_request !== undefined)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_UNSUPPORTED",
        "The target numbered resource is a pull request, not an Issue.",
        { path: `issues/${reference.number}` },
      );
    if (response.body.number !== reference.number)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_RESPONSE_INVALID",
        "GitHub returned an Issue identity for a different number.",
        { path: `issues/${reference.number}.number` },
      );
    const id = decimalDatabaseId(response.body.id);
    if (id === undefined)
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_RESPONSE_INVALID",
        "GitHub returned an Issue without a valid database identity.",
        { path: `issues/${reference.number}.id` },
      );
    if (this.issueDatabaseIds.size >= ISSUE_ID_CACHE_LIMIT) {
      const oldest = this.issueDatabaseIds.keys().next().value;
      if (typeof oldest === "string") this.issueDatabaseIds.delete(oldest);
    }
    this.issueDatabaseIds.set(key, id);
    return id;
  }

  private async request(
    path: string,
    method: "POST" | "DELETE",
    fields: Readonly<Record<string, GitHubApiFieldValue>>,
    expectedStatuses: readonly number[],
  ): Promise<void> {
    let response: GitHubApiResponse;
    try {
      response = await this.mutator.requestRepositoryApi(path, method, fields);
    } catch (error) {
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_FAILED",
        "GitHub rejected a native Issue relation mutation.",
        { path, cause: error },
      );
    }
    if (!expectedStatuses.includes(response.status))
      throw new GitHubIssueRelationMutationError(
        "RELATION_MUTATION_RESPONSE_INVALID",
        "GitHub returned an unexpected response for a native Issue relation mutation.",
        { path, status: response.status },
      );
  }
}

function decimalDatabaseId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value)) return value;
  return undefined;
}

function databaseIdField(value: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1)
    throw new GitHubIssueRelationMutationError(
      "RELATION_MUTATION_UNSUPPORTED",
      "The Issue database identity cannot be represented safely by the bounded GitHub API field seam.",
      { path: "issue.id" },
    );
  return numeric;
}

function assertRepositoryContext(value: unknown): asserts value is RepositoryContext {
  const repositoryId = isRecord(value) ? value.repositoryId : undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as RepositoryContext).hostname !== "string" ||
    typeof (value as RepositoryContext).nameWithOwner !== "string" ||
    typeof repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(repositoryId)
  ) {
    throw new ContractViolationError("A resolved repository context with a database identity is required.", "context");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
